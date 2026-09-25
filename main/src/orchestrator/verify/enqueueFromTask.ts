/**
 * enqueueTaskVerification — the main-process seam that turns a task-verify-composed
 * `VerificationTaskV1` into a queued verification request for ONE sprint lane,
 * WITHOUT the MCP hop (verification-agent redesign §5.3/§5.4). The programmatic
 * `WorkflowController` calls this (via an injected `ControllerHost` capability) from
 * the agentless visual-verify inner step; orchestrated mode keeps using the MCP
 * `cyboflow_request_verification` handler instead.
 *
 * This mirrors `mcpQueryHandler.handleRequestVerification` (the dual-format enqueue)
 * for a request that ALWAYS carries a task, minus the socket plumbing:
 *   - read the run's IMMUTABLE verify stamps (verify_enabled / verify_type /
 *     verify_chain) + project id defensively; disabled/missing ⇒ a fail-open SKIP;
 *   - resolve the chain = FALLBACK_CHAINS[type] ∩ the stamped chain (an empty
 *     intersection still enqueues — the scheduler treats an empty chain as a SKIP,
 *     never a fabricated fail — exactly like the MCP handler);
 *   - capture the snapshot sha at enqueue time (§5.5); a capture failure falls back
 *     to a null sha and STILL enqueues (the provisioner's dirty-worktree bucket);
 *   - FORCE the lane identity: the controller's `laneTaskRef` is authoritative for
 *     gate attribution, so it overrides `task.taskRef` AND drives the derived legacy
 *     input, so `task_json` and `deliverable_json` carry the SAME ref regardless of
 *     what the composing agent wrote;
 *   - dedupe on `${runId}:${laneTaskRef}:${attempt}` so a crash re-walk never
 *     double-enqueues while a genuinely fresh attempt (bumped by the merge-gate
 *     loopback) re-fires (§5.3).
 *
 * Electron-free: it takes a narrow `DatabaseLike` + reads the VerificationScheduler
 * singleton (initialized in main/src/index.ts). It is injected into the controller
 * host so the controller itself stays DB/electron-free and unit-testable with a fake.
 */
import { VerificationScheduler } from './verificationScheduler';
import type { ProvenRunbookRevision } from './verificationScheduler';
import { captureSnapshotSha } from './snapshotProvisioner';
import { findForbiddenTaskCommands } from './dependencyCommandGuard';
import { taskDerivesEnvironment } from './bootstrapEligibility';
import { probeProjectSurface, withInferredApp } from './projectSurfaceProbe';
import {
  deriveLegacyInputFromTask,
  FALLBACK_CHAINS,
  isVerificationType,
  resolveTaskModality,
} from '../../../../shared/types/visualVerification';
import type {
  VerificationModality,
  VerificationTaskV1,
  VerificationType,
  VisualBackendId,
} from '../../../../shared/types/visualVerification';
import type { VerifyRunbookModalityEntry } from '../../../../shared/types/verifyRunbook';
import type { DatabaseLike, LoggerLike } from '../types';
import type { TaskEnqueueResult } from '../programmatic/types';

export type { TaskEnqueueResult };

// ---------------------------------------------------------------------------
// The SHARED enqueue-time preparation (§5.2 seams 1+3, §5.3, §7.2 ENQUEUE half)
//
// There are exactly TWO ways a verification request is born — the MCP handler
// (`cyboflow_request_verification`, orchestrated mode) and this module's
// `enqueueTaskVerification` (the programmatic controller's agentless
// visual-verify step) — and both must apply the identical rules to the composed
// task before a row exists:
//
//   1. REJECT a task whose build/serve mutates dependencies (§7.2);
//   2. INJECT the project's PROVEN runbook revision, replacing the composed
//      build/serve/attestation and stamping the content-addressed PIN (§5.2
//      seam 3).
//
// Duplicating that across the two entry points is how the two paths quietly
// diverge — one gets a guard widened, the other does not — so it lives here,
// once, and both call {@link prepareVerificationEnqueue}.
// ---------------------------------------------------------------------------

/**
 * The migration-096 request-row pin: the portable half's content hash plus the
 * machine-local record's CAS version, both stamped at enqueue so the runner can
 * execute exactly that revision or reject (§5.2 seam 3).
 */
export interface RunbookPin {
  hash: string;
  localVersion: number;
}

/** The structured error code an enqueue rejection carries when §7.2's guard fires. */
export const FORBIDDEN_DEP_COMMAND_ERROR = 'forbidden_dependency_command';

/**
 * Outcome of {@link prepareVerificationEnqueue}. `ok:false` means NOTHING is
 * enqueued and the caller surfaces `error` to the composer verbatim; `ok:true`
 * carries the task to persist (possibly runbook-merged) and the pin to stamp.
 *
 * `modality` is the modality this preparation actually settled on (F5). It is
 * reported rather than merely used because the caller resolved its own copy
 * BEFORE the bootstrap and needs to know if the preparation had to fall back
 * (see the stamp-consistency invariant in this section's header); it is also the
 * value the persisted task re-derives to, so a caller can assert on it.
 */
export type PreparedVerificationEnqueue =
  | { ok: true; task?: VerificationTaskV1; pin?: RunbookPin; modality: VerificationModality }
  | { ok: false; error: string };

/**
 * Build the §7.2 rejection message. Names EVERY offending command verbatim plus
 * the rule and its reason — a composer that gets back "invalid task" cannot fix
 * it; one that gets back "you wrote `pnpm install`, here is why that is not
 * allowed here, dependencies are prepared for you" recomposes correctly on the
 * first retry.
 */
function forbiddenCommandError(offenders: string[], source: 'task' | 'runbook'): string {
  const list = offenders.map((cmd) => `  - ${cmd}`).join('\n');
  const origin =
    source === 'runbook'
      ? "this project's committed verification runbook"
      : 'the composed verification task';
  return (
    `${FORBIDDEN_DEP_COMMAND_ERROR}: ${origin} contains dependency-mutating command(s):\n${list}\n` +
    'A verification snapshot SHARES its node_modules with the live worktree (symlinked), so an ' +
    'install/rebuild/browser-install inside it writes THROUGH into the tree every sibling lane is ' +
    'building against — flipping native-module ABIs under them, invisibly to the mutation check. ' +
    'Dependencies are prepared for you before the task runs: compose build/serve steps that only ' +
    "build and serve (e.g. `pnpm run build`, `pnpm dev --port \\${PORT}`), never ones that install."
  );
}

// ---------------------------------------------------------------------------
// MODALITY RESOLUTION — once, early, declaration first (F5 / RC3, Codex #3 —
// docs/proposals/visual-verification-brittleness-fixes.md)
//
// `resolveTaskModality` answers from the composed task's SHAPE alone: anything
// without `serve.attach === 'cdp'` is `web`. On a project whose proven runbook
// declares only `cdp-app` (cyboflow itself), a composer that merely omitted
// `attach` therefore asked for a modality nothing was ever proven against — the
// injection below found no record, the §3.2 degrade gate skipped the lane, and
// nothing anywhere told the composer which modalities that project actually has.
// That is RC3: the modality selector was the LLM's guess about a fact the
// harness already knows.
//
// Two corrections. (1) The composer's EXPLICIT `task.modality` — a field
// `VerificationTaskV1` has carried all along (visualVerification.ts) and the
// task-verify prompt already asks for — is honoured instead of being ignored in
// favour of the shape. (2) When nothing is declared at all, the project's PROVEN
// RECORDS are asked, in {@link RECORD_PROBE_ORDER}: a project with a proven
// cdp-app entry is an app, and a composer that wants its web surface says so.
//
// And the answer is computed ONCE per enqueue, BEFORE the bootstrap preflight
// (Codex #3): the bootstrap used to run on the composer-derived modality, so an
// undeclared task on a cdp-app project would derive and prove a brand-new `web`
// runbook — spending real budget and rewriting the shared
// `.cyboflow/verify-runbook.json` — before the injection seam ever looked at the
// proven record that already existed.
//
// BOTH ENQUEUE PATHS GET IT. The programmatic seam resolves it up front (it must
// — it is the one that runs the bootstrap) and hands the value down; the MCP
// handler passes nothing and {@link prepareVerificationEnqueue} resolves it
// itself. That matters because `execution_model` defaults to `orchestrated`, so
// the MCP path is the DEFAULT plane: leaving it on the old shape-only derivation
// would have made the task-verify prompt's promise about `modality` and the
// proven runbook false for most runs (fix round, reviewer finding on the
// prompt).
//
// THE INVARIANT THAT MAKES ALL OF THIS SAFE (fix round, blocker). The request
// row's modality is stamped by `scheduler.enqueue`, which RE-DERIVES it from
// (type, PERSISTED task) via `resolveTaskModality` — shape-only, `task.modality`
// ignored. A resolution the persisted task cannot re-derive to would therefore
// hand the §3.2 degrade gate a modality this request was never resolved for, and
// on a project where THAT other modality happens to be proven the gate would
// wave through an UNPINNED request carrying the composer's own guessed
// build/serve. So resolution only ever answers with a modality that is either
//
//   (a) the task's own SHAPE — which the stamp re-derives by definition; or
//   (b) one this project has a PROVEN record for — which the injection then
//       merges, replacing `serve` with the record's own, so the persisted task
//       re-derives to it. The merge's existing consistency guard is what makes
//       that a CHECKED claim rather than an assumption, and the preparation
//       falls back to (a) whenever the injection did not actually happen.
//
// A declaration that is neither — `"modality": "cdp-app"` written next to a
// plain `serve`, on a project with no cdp-app record — falls back to the shape,
// which is exactly the pre-F5 answer for that task (merge + pin against the
// shape's own proven record, if it has one). This is the ONE place the
// implementation departs from the spec's "declared-but-not-proven ⇒ the gate
// skips with the reason naming the declared modality": making the gate say that
// requires stamping the declared value, and the stamp is single-sited inside
// `scheduler.enqueue`.
//
// DECLARED-AND-CONSISTENT IS UNCHANGED, and it is the case the prompt asks for:
// `"modality": "cdp-app"` alongside `serve.attach === 'cdp'` (or `"web"` with no
// attach) with no proven record still means no merge and no pin, and the degrade
// gate skips with its existing reason naming that modality.
//
// A DEGENERATE TASK NEVER CONSULTS THE RECORDS. A pre-live task (a bare
// `target`, no build and no serve) derives no environment: it is exempt from the
// degrade gate entirely, and it is the one request shape that has actually
// passed in production. Resolving it against a runbook record would merge a full
// build + serve + attestation into it and turn it into a different request, so
// it keeps its shape's answer — the same carve-out the bootstrap preflight and
// the degrade gate already make for it.
// ---------------------------------------------------------------------------

/**
 * The order the proven records are probed in when the composer declared nothing
 * (F5). BOTH proven + nothing declared ⇒ `cdp-app` wins, by the rule above.
 *
 * `mobile` is LAST, and that position is load-bearing rather than tidy. A React
 * Native / Expo project legitimately holds BOTH a proven `web` record and a
 * proven `mobile` one, and a task that declared nothing is by construction one
 * the composer wrote in the WEB shape — no `app` block, because an app-shaped
 * task declares its own modality through {@link declaredWebModality}'s app rung
 * and never reaches this list. Probing `mobile` ahead of `web` would therefore
 * take a plain web-shaped lane, merge a simulator stand-up into it, and turn a
 * browser check into an `xcodebuild` on the strength of a record that merely
 * exists. An undeclared lane can only be moved onto `mobile` when this project
 * has NO web-axis record at all, which is the one reading under which "this
 * project's proven surface is the simulator" is actually true.
 */
const RECORD_PROBE_ORDER: readonly VerificationModality[] = ['cdp-app', 'web', 'mobile'];

/**
 * The DECLARED modality for a request, or `null` when nothing declares one.
 * Pure and total — the caller decides what a `null` means.
 *
 * Precedence (F5 steps 1–3):
 *   1. the run's verify TYPE, for the two modalities a task shape cannot
 *      express — `native-desktop` → `native-screen`, `mobile-flow` → `mobile`
 *      (identical to {@link resolveTaskModality}, which owns that mapping);
 *   2. the composer's own `task.modality`, when the task's own SHAPE can express
 *      it — the two WEB-AXIS members unconditionally, and `mobile` only when the
 *      task actually carries the `app` block that expresses it. A declaration
 *      the shape cannot express is deliberately NOT honoured: the request row's
 *      modality is re-derived from (type, task) at the INSERT, so honouring a
 *      word with no shape behind it would stamp a row whose modality contradicts
 *      the one this resolution was made for. `native-screen` is never
 *      expressible on a web-shaped run at all (the run's stamped type owns that
 *      axis, and step 1 already answered it), and a declared `mobile` with NO
 *      `app` block is the same situation — it falls through to `null` and the
 *      lane is resolved as if it had declared nothing, exactly as a declared
 *      `native-screen` always has been. Nothing new declines here.
 *   3. `app.platform === 'ios-simulator'` → `'mobile'` — the mobile tier's shape
 *      discriminant, read BEFORE the attach rung for the same reason
 *      {@link resolveTaskModality} reads it first: an app-shaped task IS a
 *      simulator run whatever web-shaped `VerificationType` it was composed
 *      under, and it carries no `serve` for the attach rung to read.
 *   4. `serve.attach === 'cdp'` → `cdp-app` — the legacy shape discriminant,
 *      still authoritative when the composer wrote the shape but not the word.
 *
 * Rungs 3 and 4 are shape readings, so a declaration that AGREES with the shape
 * and one that was merely implied by it both come out here as the same answer —
 * which is what keeps the stamp-consistency invariant true for the mobile tier
 * without a single new branch downstream.
 */
export function declaredWebModality(
  type: VerificationType,
  task: Pick<VerificationTaskV1, 'serve' | 'modality' | 'app'> | null,
): VerificationModality | null {
  if (type === 'native-desktop') return 'native-screen';
  if (type === 'mobile-flow') return 'mobile';
  if (task?.modality === 'mobile' && task.app !== undefined) return 'mobile';
  if (task?.modality === 'web' || task?.modality === 'cdp-app') return task.modality;
  if (task?.app?.platform === 'ios-simulator') return 'mobile';
  if (task?.serve?.attach === 'cdp') return 'cdp-app';
  return null;
}

/**
 * The task shape {@link resolveEnqueueModality} reads: the shape discriminants,
 * the build/serve that decide whether records are consulted, and the `target`
 * the §A2 surface rung needs to see absent.
 */
export type EnqueueResolvableTask = Pick<VerificationTaskV1, 'build' | 'serve' | 'modality' | 'app' | 'target'>;

/**
 * What {@link resolveEnqueueModality} settled on (§A2): the modality AND the
 * task that carries it. The task is the caller's own, untouched, except on a
 * surface-probe hit, where it gains `modality: 'mobile'` and an inferred `app`
 * block — which is what makes the row's shape-derived stamp agree with the
 * answer. Every downstream consumer (the bootstrap decision, the MCP deferral,
 * {@link prepareVerificationEnqueue}) must therefore use THIS task, never the
 * one it passed in.
 */
export interface EnqueueModalityResolution<T> {
  modality: VerificationModality;
  task: T;
}

/**
 * §A2 — may the project-surface probe fire for this request at all? Every
 * condition but the last (no cdp-app or web record, which needs the store) is
 * read off the request here:
 *   - no USABLE declaration: nothing declared, a declared `mobile` with no
 *     `app`, or a declared `native-screen` on a web-typed run — exactly the
 *     cases {@link declaredWebModality} answers `null` for;
 *   - no `app` and no `serve` of any form;
 *   - no `target.url` / `target.htmlPath`.
 * A task naming ANY surface of its own was composed for that surface, and the
 * probe must never talk it out of it.
 */
export function surfaceProbeMayFire(type: VerificationType, task: EnqueueResolvableTask): boolean {
  if (declaredWebModality(type, task) !== null) return false;
  if (task.app !== undefined || task.serve !== undefined) return false;
  const url = task.target?.url?.trim() ?? '';
  const htmlPath = task.target?.htmlPath?.trim() ?? '';
  return url.length === 0 && htmlPath.length === 0;
}

/**
 * Resolve the modality this enqueue runs under.
 *
 *   1. A declaration that MATCHES the task's own shape wins outright, with no
 *      record read at all — the common case, and the one the prompt asks for.
 *   2. A DEGENERATE task (no build, no serve) keeps its shape: it derives no
 *      environment, so there is nothing for a runbook record to describe.
 *   3. Otherwise the PROVEN records decide, and they are the only thing that can
 *      move the answer off the shape: a declaration the shape does not express
 *      is adopted only when a proven record backs it (one probe, for exactly
 *      that modality); a task that declared nothing at all probes
 *      {@link RECORD_PROBE_ORDER}, `cdp-app` first.
 *   4. §A2 — the PROJECT SURFACE probe (`projectSurfaceProbe.ts`), after the
 *      proven- and present-record probes and before the shape fallback: when
 *      {@link surfaceProbeMayFire} holds and NO cdp-app or web record exists
 *      for the project (whatever its status), an iOS application found in the
 *      project's own Xcode files answers `mobile` with a synthesized, tagged
 *      `app` block. It is the one rung that changes the TASK as well as the
 *      modality, and it also applies to a surfaceless degenerate task (step 2
 *      would otherwise hand the shiny-eagle rows `web`) and to a lane whose only
 *      record is an unproven `mobile` one (the present rung would otherwise
 *      answer `mobile` for a task with no `app`, which re-derives to `web`). A
 *      miss, an inconclusive project or any probe error changes nothing.
 *   5. Failing all of that, the task's SHAPE — `web` for anything without
 *      `serve.attach`, i.e. today's default.
 *
 * Every answer is therefore either the shape, a proven modality, or `mobile`
 * with the `app` block that makes the shape say so — the stamp-consistency
 * invariant this section's header spells out.
 *
 * FAIL-SOFT BY CONSTRUCTION. No scheduler wired, or any throw out of the probe,
 * skips the record consultation entirely and falls through to the shape (the
 * surface rung needs the record-presence answer, so it is skipped too). This
 * runs before a request row exists, on the lane's critical path, and the enqueue
 * seam's contract is NEVER THROWS; a resolution hiccup must cost the lane its
 * record-derived modality, never the lane itself.
 *
 * Logs at info WHICH precedence step decided, because that is the one fact that
 * makes a "no proven runbook for modality X" skip legible after the fact.
 */
export async function resolveEnqueueModality<T extends EnqueueResolvableTask | null>(args: {
  type: VerificationType;
  task: T;
  projectId: number;
  runId: string;
  /** The requesting run's worktree, when it has one (the store's probe path). */
  probePath?: string;
  /**
   * §A2 — the tree the project-surface probe reads. Defaults to `probePath`;
   * separate because the MCP path leaves `probePath` to the scheduler's own
   * ladder yet still knows the run's worktree. Absent both ⇒ no surface rung.
   */
  surfaceRoot?: string;
  logger?: LoggerLike;
}): Promise<EnqueueModalityResolution<T>> {
  const { logger, task } = args;
  // The modality the request row would be stamped with if NOTHING is merged into
  // the task: `scheduler.enqueue` re-derives the stamp from exactly this call.
  const shape = resolveTaskModality(args.type, task);
  const declared = declaredWebModality(args.type, task);
  const keep = (modality: VerificationModality): EnqueueModalityResolution<T> => ({ modality, task });

  if (declared !== null && declared === shape) {
    logger?.info('[resolveEnqueueModality] modality declared by the request', {
      projectId: args.projectId,
      runId: args.runId,
      modality: declared,
      source: task?.modality === declared ? 'task.modality' : 'type-or-serve-shape',
    });
    return keep(declared);
  }

  const surfaceRoot = args.surfaceRoot ?? args.probePath;
  const mayProbeSurface = task !== null && surfaceRoot !== undefined && surfaceProbeMayFire(args.type, task);
  /**
   * The §A2 rung itself. The caller has ALREADY established that no cdp-app or
   * web record exists; this only reads the project's files.
   */
  const probeSurface = async (): Promise<EnqueueModalityResolution<T> | null> => {
    if (task === null || surfaceRoot === undefined) return null;
    const found = await probeProjectSurface(surfaceRoot);
    logger?.info('[resolveEnqueueModality] project surface probe', {
      projectId: args.projectId,
      runId: args.runId,
      result: found.kind,
      detail: found.detail,
    });
    if (found.kind !== 'ios-app') return null;
    return { modality: 'mobile', task: withInferredApp(task as NonNullable<T>, found.app) };
  };

  if (task === null || !taskDerivesEnvironment(task)) {
    if (mayProbeSurface) {
      // A surfaceless task: the records are still not consulted for a MERGE, but
      // the rung's own precondition — no web-axis record — must be read.
      try {
        const scheduler = VerificationScheduler.tryGetInstance();
        if (scheduler !== null && !(await webAxisRecordPresent(scheduler, args))) {
          const inferred = await probeSurface();
          if (inferred !== null) return inferred;
        }
      } catch (err) {
        logger?.debug('[resolveEnqueueModality] surface probe unavailable; keeping the shape', {
          projectId: args.projectId,
          runId: args.runId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    logger?.info('[resolveEnqueueModality] degenerate task keeps its shape; records not consulted', {
      projectId: args.projectId,
      runId: args.runId,
      modality: shape,
      declared,
      source: 'no-environment',
    });
    return keep(shape);
  }

  // Either the composer declared a modality its own task shape does not express
  // — adopted ONLY if a proven record backs it, so the merge can make the stamp
  // agree — or it declared nothing at all, in which case the records choose.
  const candidates: readonly VerificationModality[] = declared !== null ? [declared] : RECORD_PROBE_ORDER;
  try {
    const scheduler = VerificationScheduler.tryGetInstance();
    if (scheduler !== null) {
      for (const candidate of candidates) {
        const revision = await scheduler.resolveProvenRunbook({
          projectId: args.projectId,
          runId: args.runId,
          modality: candidate,
          ...(args.probePath !== undefined ? { probePath: args.probePath } : {}),
        });
        if (revision !== null) {
          logger?.info('[resolveEnqueueModality] modality resolved from the proven runbook record', {
            projectId: args.projectId,
            runId: args.runId,
            modality: candidate,
            declared,
            source: 'proven-record',
            runbookHash: revision.hash,
          });
          return keep(candidate);
        }
      }
      // F4 ∘ F5 (Codex review of the fix round): with drift non-writing, a
      // project's cdp-app record can be `drifted` (or a registered draft) for a
      // long stretch. An UNDECLARED lane must still point at the modality that
      // HAS a record, so the bootstrap takes the re-prove (drifted) or derive
      // (draft) path for it instead of deriving a rival `web` runbook beside
      // it. Nothing merges here (the record is not proven), so the stamp-
      // consistency fallback in prepareVerificationEnqueue still applies; the
      // bootstrap is the only consumer that sees this answer un-narrowed.
      if (declared === null) {
        for (const candidate of RECORD_PROBE_ORDER) {
          const present = await scheduler.runbookRecordPresent({
            projectId: args.projectId,
            runId: args.runId,
            modality: candidate,
            ...(args.probePath !== undefined ? { probePath: args.probePath } : {}),
          });
          if (present) {
            // §A2 — an unproven `mobile` record is the only present one (the
            // order put cdp-app and web first): the rung may still supply the
            // `app` this lane has none of, under the same modality.
            const inferred = candidate === 'mobile' && mayProbeSurface ? await probeSurface() : null;
            logger?.info('[resolveEnqueueModality] modality resolved from an unproven runbook record (bootstrap will re-prove or derive it)', {
              projectId: args.projectId,
              runId: args.runId,
              modality: candidate,
              source: 'present-record',
              appInferred: inferred !== null,
            });
            return inferred ?? keep(candidate);
          }
        }
        // §A2 — no record of ANY modality, so certainly no web-axis one.
        if (mayProbeSurface) {
          const inferred = await probeSurface();
          if (inferred !== null) return inferred;
        }
      }
    }
  } catch (err) {
    // Skips the rest of the probe on purpose: a store that threw once will throw
    // again on the next candidate, and the shape below is the honest answer.
    logger?.debug('[resolveEnqueueModality] proven-record probe unavailable; falling back to the task shape', {
      projectId: args.projectId,
      runId: args.runId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  logger?.info('[resolveEnqueueModality] no proven record backs the request; falling back to the task shape', {
    projectId: args.projectId,
    runId: args.runId,
    modality: shape,
    declared,
    source: 'shape-fallback',
  });
  return keep(shape);
}

/** §A2's record precondition: does a cdp-app or web record exist for the project, whatever its status? */
async function webAxisRecordPresent(
  scheduler: VerificationScheduler,
  args: { projectId: number; runId: string; probePath?: string },
): Promise<boolean> {
  for (const modality of ['cdp-app', 'web'] as const) {
    const present = await scheduler.runbookRecordPresent({
      projectId: args.projectId,
      runId: args.runId,
      modality,
      ...(args.probePath !== undefined ? { probePath: args.probePath } : {}),
    });
    if (present) return true;
  }
  return false;
}

/**
 * MERGE a proven runbook's modality entry into a composed task (§5.2 seam 3).
 *
 * THE SPLIT OF AUTHORITY. The runbook owns HOW THIS PROJECT IS STOOD UP —
 * `build`, `serve`, and the `attestation` channel that proves the surface is
 * really this deliverable. The composed task owns WHAT IS BEING CHECKED THIS
 * TIME — `summary`, `behaviors`, `viewports`, and the lane `taskRef`. Merging
 * along exactly that seam is the point of the whole phase: §1's diagnosis is
 * that the agent engine "guesses per-run with no memory and guesses wrong every
 * time" (0-for-5 in production — wrong serve form, colliding singletons, wrong
 * ABI), and the composer's guess at build/serve is precisely the part that has
 * never once been right. Its judgment about which behaviors to check is the part
 * it is actually good at, and that survives untouched.
 *
 * REPLACE, NOT MERGE-FIELDS. An absent `build` in the runbook entry REMOVES the
 * task's own build steps rather than leaving them: "this project needs no build
 * step" is a positive statement the proof validated, and keeping a guessed one
 * alongside it would re-introduce exactly the guess that was proven wrong.
 *
 * `app` AND `serve` ARE ONE SLOT, NOT TWO. The stand-up half of the entry is
 * whichever of the two it declares — the runbook parser enforces that a `mobile`
 * entry carries `app` and no `serve`, and that no other entry carries `app` at
 * all — so the merge writes the entry's `app` when it has one and the entry's
 * `serve` otherwise, and in each case the OTHER field is dropped from the task
 * entirely. Carrying both through would compose a task that describes two
 * mutually exclusive stand-ups (a leased port AND a simulator), and would break
 * the one thing that makes a record-resolved lane safe: the injection's
 * consistency guard re-derives the modality from the MERGED task, and
 * {@link resolveTaskModality} reads `app` before `serve.attach` — so a surviving
 * `app` on a web entry would re-derive the merged task to `mobile` and the guard
 * would drop a perfectly good web injection. Replacing the whole slot is what
 * makes a mobile record-resolved lane re-derive to `mobile` and a web one to
 * `web`, from the record's own declaration rather than from the composer's.
 *
 * `target` is preserved: it is the composer's pre-live pointer and is orthogonal
 * to standing the project up. The entry's `viewports`/`notes` are NOT merged —
 * capture framing belongs to the request, and the notes are for humans reading
 * the committed file.
 *
 * `resolvedModality` (F5) is STAMPED onto the merged task when the composer
 * declared none. Without it a record-resolved lane (nothing declared, the
 * modality derived from the project's proven record) would persist a task whose
 * only modality signal is `serve.attach`, and the runner's cross-check
 * (`resolveRequestModality`: `req.modality ?? task.modality` versus the task
 * shape) would be judging the harness's decision against a task that never
 * recorded it. It never OVERRIDES a declaration — a declared value is the whole
 * point of step 2 of the precedence.
 */
export function mergeRunbookIntoTask(
  task: VerificationTaskV1,
  entry: VerifyRunbookModalityEntry,
  resolvedModality?: VerificationModality,
): VerificationTaskV1 {
  const modality = task.modality ?? resolvedModality;
  return {
    version: 1,
    summary: task.summary,
    behaviors: task.behaviors,
    attestation: entry.attestation,
    ...(task.taskRef !== undefined ? { taskRef: task.taskRef } : {}),
    ...(task.target !== undefined ? { target: task.target } : {}),
    ...(modality !== undefined ? { modality } : {}),
    ...(task.viewports !== undefined ? { viewports: task.viewports } : {}),
    ...(task.timeoutMs !== undefined ? { timeoutMs: task.timeoutMs } : {}),
    ...(entry.build !== undefined ? { build: entry.build } : {}),
    // The stand-up slot, replaced whole: a mobile entry contributes `app` and no
    // `serve`, every other entry contributes `serve` and no `app`.
    ...(entry.app !== undefined
      ? { app: entry.app }
      : entry.serve !== undefined
        ? { serve: entry.serve }
        : {}),
  };
}

/**
 * Apply the two enqueue-time rules to a composed task, in order. Called by BOTH
 * enqueue entry points; see this section's header for why it is shared.
 *
 * ORDER MATTERS. The §7.2 guard runs FIRST, on what the composer actually wrote:
 * a task carrying `pnpm install` is rejected with that command named, before any
 * runbook merge could quietly replace it and hide the composer's mistake (the
 * composer would keep making it). It then runs AGAIN on the merged result,
 * because §7.2's rule is explicitly "every composed task's build/serve steps —
 * runbook-sourced and agent-composed alike": a runbook that smuggles an install
 * through the merge is exactly as dangerous, and is arguably worse because it is
 * PROVEN and would repeat on every request.
 *
 * A SETUP-PROOF REQUEST PINS ITS OWN DRAFT. `pin` supplied by the caller is
 * stamped verbatim and no lookup happens: the phase-2 setup flow is trying to
 * PROVE a revision, which by definition is not proven yet, so requiring a proven
 * record here would be a bootstrap deadlock (the same reason §3.6 exempts it
 * from the degrade gate). Its task was composed from that draft, so re-merging
 * would be a no-op at best.
 *
 * EVERY UNHAPPY PATH IS "UNPINNED", NOT "FAILED". No store wired, no proven
 * record, a record that declares no entry for this modality, a resolution error
 * — all resolve to `{ ok: true, task }` with no pin. The §3.2 degrade gate then
 * gives the honest answer downstream (skip + a setup CTA for a build/serve task;
 * nothing at all for a degenerate pre-live one). The ONLY hard rejection here is
 * the dependency guard, because that one is a hazard rather than a gap.
 */
export async function prepareVerificationEnqueue(args: {
  projectId: number;
  runId: string;
  type: VerificationType;
  /** The composed task, when the request carries one (the legacy intent-only path passes undefined). */
  task?: VerificationTaskV1;
  /** A caller-supplied pin — a setup-proof request pinning the draft it is proving. */
  pin?: RunbookPin;
  /** The tree whose portable runbook half is probed; absent ⇒ the scheduler resolves it from the run/project. */
  probePath?: string;
  /**
   * F5 — the modality the caller ALREADY resolved (see
   * {@link resolveEnqueueModality}). Present from `enqueueTaskVerification`,
   * which must resolve it before the bootstrap preflight and cannot resolve it
   * twice without risking two different answers. ABSENT from the MCP handler and
   * the test harnesses, which is why this function resolves it ITSELF when it is
   * missing rather than falling back to the shape-only derivation: the MCP path
   * is the DEFAULT (`orchestrated`) plane, and the task-verify prompt's promise
   * about `modality` and the proven runbook has to hold there too.
   */
  modality?: VerificationModality;
  /**
   * §A2 — the tree the project-surface rung reads when this function resolves
   * the modality itself (see {@link resolveEnqueueModality}); defaults to
   * `probePath`. Ignored when `modality` is supplied: that caller resolved (and
   * passes) the task the rung already produced.
   */
  surfaceRoot?: string;
  logger?: LoggerLike;
}): Promise<PreparedVerificationEnqueue> {
  const { logger } = args;
  const composedTask = args.task;
  if (composedTask === undefined) return { ok: true, modality: resolveTaskModality(args.type, null) };

  // (1) §7.2 — the composer's own commands.
  const composed = findForbiddenTaskCommands(composedTask);
  if (composed.length > 0) {
    return { ok: false, error: forbiddenCommandError(composed, 'task') };
  }

  // (2) A caller-supplied pin is authoritative (setup proof) — stamp it verbatim.
  // Nothing is merged, so the row stamps the SHAPE and that is what this reports.
  if (args.pin !== undefined) {
    return { ok: true, task: composedTask, pin: args.pin, modality: resolveTaskModality(args.type, composedTask) };
  }

  // (3) §5.2 seam 3 — the proven-runbook injection.
  const scheduler = VerificationScheduler.tryGetInstance();
  if (scheduler === null) {
    return { ok: true, task: composedTask, modality: resolveTaskModality(args.type, composedTask) };
  }
  // §A2 — resolution may hand back a DIFFERENT task (an inferred `app` block);
  // everything below reasons about that one, and it is what gets persisted.
  const resolution =
    args.modality !== undefined
      ? { modality: args.modality, task: composedTask }
      : await resolveEnqueueModality({
          type: args.type,
          task: composedTask,
          projectId: args.projectId,
          runId: args.runId,
          ...(args.probePath !== undefined ? { probePath: args.probePath } : {}),
          ...(args.surfaceRoot !== undefined ? { surfaceRoot: args.surfaceRoot } : {}),
          ...(logger ? { logger } : {}),
        });
  const resolved = resolution.modality;
  const task = resolution.task;

  // The modality the row would be stamped with if nothing is merged in — the
  // fallback the whole stamp-consistency invariant is written around.
  const shape = resolveTaskModality(args.type, task);

  /**
   * Resolve + merge ONE candidate modality, or answer null.
   *
   * The stamped modality is re-derived from the PERSISTED task
   * (`scheduler.enqueue` → `resolveTaskModality`), so a merge that changes the
   * `serve.attach` discriminant would stamp a modality DIFFERENT from the one
   * this runbook was resolved for — the capability ledger, the screen lease and
   * the runner's preflight would then all key on a modality nothing was proven
   * against. That can only happen if a record filed under modality M declares an
   * entry inconsistent with M (a malformed runbook), so the response is to drop
   * the injection and let the degrade gate speak, never to silently execute the
   * inconsistency.
   *
   * F5 KEEPS THAT GUARD EXACTLY AS IT WAS, and it is what makes a
   * record-resolved modality safe: `mergeRunbookIntoTask` REPLACES `serve`, so a
   * task that declared nothing and resolved to `cdp-app` from the record comes
   * out of the merge carrying the entry's own `attach: 'cdp'` and re-derives to
   * `cdp-app`. A `cdp-app` record whose entry forgot the attach form still trips
   * the guard and skips the injection, as it always did.
   */
  const tryInject = async (
    candidate: VerificationModality,
  ): Promise<{ revision: ProvenRunbookRevision; merged: VerificationTaskV1 } | null> => {
    const revision = await scheduler.resolveProvenRunbook({
      projectId: args.projectId,
      runId: args.runId,
      modality: candidate,
      ...(args.probePath !== undefined ? { probePath: args.probePath } : {}),
    });
    if (revision === null) return null;
    const merged = mergeRunbookIntoTask(task, revision.entry, candidate);
    if (resolveTaskModality(args.type, merged) !== candidate) {
      logger?.warn('[prepareVerificationEnqueue] runbook entry contradicts its own modality; skipping injection', {
        projectId: args.projectId,
        runId: args.runId,
        modality: candidate,
        merged: resolveTaskModality(args.type, merged),
        runbookHash: revision.hash,
      });
      return null;
    }
    return { revision, merged };
  };

  let modality = resolved;
  let injected = await tryInject(modality);

  // STAMP CONSISTENCY (fix round, blocker — see this section's header). An
  // injection is the ONLY thing that can make the persisted task re-derive to a
  // modality its composed shape does not express. When it did not happen — no
  // record, or a record whose entry contradicts its own modality — keeping the
  // off-shape answer would leave the row stamped with the shape while the
  // capability ledger, the §3.2 degrade gate and the runner all reason about
  // something else, and on a project where the SHAPE's modality is proven the
  // gate would wave the request through unpinned, running the composer's own
  // guessed build/serve. So fall back to the shape and give it the same chance
  // to inject: that is precisely the pre-F5 behavior for this task.
  if (injected === null && modality !== shape) {
    logger?.info('[prepareVerificationEnqueue] no proven record confirmed the resolved modality; using the task shape', {
      projectId: args.projectId,
      runId: args.runId,
      resolved: modality,
      shape,
    });
    modality = shape;
    injected = await tryInject(shape);
  }
  if (injected === null) return { ok: true, task, modality };

  // (4) §7.2 again, now over the runbook-sourced commands.
  const fromRunbook = findForbiddenTaskCommands(injected.merged);
  if (fromRunbook.length > 0) {
    return { ok: false, error: forbiddenCommandError(fromRunbook, 'runbook') };
  }

  logger?.debug('[prepareVerificationEnqueue] injected a proven runbook revision', {
    projectId: args.projectId,
    runId: args.runId,
    modality,
    runbookHash: injected.revision.hash,
    runbookLocalVersion: injected.revision.version,
  });
  return {
    ok: true,
    task: injected.merged,
    pin: { hash: injected.revision.hash, localVersion: injected.revision.version },
    modality,
  };
}

/** Parse the stamped `verify_chain` JSON into a `VisualBackendId[]` (mirrors mcpQueryHandler). Fail-soft → []. */
function parseStampedChain(v: unknown): VisualBackendId[] {
  if (typeof v !== 'string' || v.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(v);
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is VisualBackendId => typeof x === 'string');
    }
    return [];
  } catch {
    return [];
  }
}

export interface EnqueueTaskVerificationOptions {
  db: DatabaseLike;
  runId: string;
  task: VerificationTaskV1;
  /** The lane's authoritative ref/id — overrides `task.taskRef` for gate attribution. */
  laneTaskRef: string;
  /** 1-based lane attempt; part of the idempotency key so a fresh attempt re-fires. */
  attempt: number;
  /** The run worktree the snapshot sha is captured from (§5.5). */
  worktreePath: string;
  /**
   * §3.6 (docs/proposals/verification-setup-flow.md) — mark this as a phase-2
   * SETUP/PROOF request rather than ordinary lane traffic: exempt from the
   * project's lifetime verification budget, never counted against it, and exempt
   * from the §3.2 "no proven runbook" degrade gate (proving the runbook is how a
   * project stops being unproven). Defaults to false; no caller in phase 0 sets
   * it — the channel exists so the phase-2 setup flow can enqueue its proof run
   * through this SAME seam instead of a parallel one.
   */
  setupProof?: boolean;
  /**
   * Migration 107 — mark this as the LANE-DRIVEN bootstrap proof
   * (docs/proposals/lane-runbook-bootstrap.md §5): exempt from the §3.2 degrade
   * gate (it exists to prove the runbook whose absence the gate is complaining
   * about) but COUNTED against the project budget and drained at ordinary
   * priority, unlike `setupProof`. Never settable over the MCP wire — this
   * in-process option is its only writer.
   *
   * Must be paired with {@link bootstrapRound}, which makes the enqueue key
   * unique; see the key derivation below for why that is load-bearing rather
   * than cosmetic.
   */
  bootstrapProof?: boolean;
  /**
   * 1-based bootstrap draft round, part of the enqueue key. Ignored unless
   * {@link bootstrapProof} is set.
   */
  bootstrapRound?: number;
  /**
   * §5.2 seam 3 — a caller-supplied PIN, stamped verbatim onto the request row.
   * The phase-2 setup flow's proof run is the caller: it is trying to PROVE a
   * specific derived revision, so it pins that revision's own hash + CAS version
   * rather than waiting for a proven record that by definition does not exist
   * yet (the same bootstrap reasoning that exempts a `setupProof` request from
   * the §3.2 degrade gate). Absent ⇒ the pin, if any, is resolved from the
   * project's PROVEN runbook by {@link prepareVerificationEnqueue}.
   *
   * Both must be supplied together to have an effect — half a pin is not a pin,
   * and the runner's validation would have nothing to CAS against.
   */
  runbookHash?: string;
  runbookLocalVersion?: number;
  logger?: LoggerLike;
}

/**
 * Enqueue a composed visual-verification task for one lane. Returns
 * `{ outcome: 'enqueued', requestId }` on success, or `{ outcome: 'skipped', reason }`
 * when verification is disabled/missing for the run or the scheduler is unavailable
 * (both fail-open — the caller advances the lane without parking). NEVER throws.
 *
 * ONE outcome is deliberately NOT fail-open: a task whose build/serve mutates
 * dependencies (§7.2) resolves `{ outcome: 'skipped', reason: <the structured
 * guard message> }`. Skipping is still lane-advancing (this seam has no channel
 * to fail a lane and must not grow one), but the reason names the offending
 * command so the loopback that follows recomposes correctly instead of the
 * enqueue quietly writing a row that would poison every sibling lane's
 * node_modules.
 */
/**
 * The lane `enqueue_key` — `${runId}:${laneTaskRef}:${attempt}` — composed in
 * ONE place so the programmatic lane enqueue, the MCP-fired
 * `cyboflow_request_verification` (via {@link laneEnqueueKeyFor}), and the
 * swimlane's staleness parser (`sprintLaneStore.parseLaneAttemptFromEnqueueKey`,
 * which reads the LAST `:`-segment as the lane attempt) can never disagree
 * about the shape.
 */
export function laneEnqueueKey(runId: string, laneTaskRef: string, attempt: number): string {
  return `${runId}:${laneTaskRef}:${attempt}`;
}

/**
 * The lane `enqueue_key` for a request an AGENT fires through
 * `cyboflow_request_verification` with a `taskRef`, or `undefined` when the
 * ref names no lane of the run's batch (a quick chat, a verify-setup proof, a
 * ref the agent invented) — those enqueue unkeyed, exactly as before.
 *
 * WHY THE MCP PATH IS KEYED AT ALL. The swimlane's "Visual check" reads a
 * lane's LATEST verification row and marks it stale when the attempt encoded
 * in its key is below the lane's current `attempts`; an unkeyed row has no
 * attempt to compare, so an orchestrated sprint (where every request is
 * MCP-fired) could never tell a verdict from the previous implement round
 * apart from this one's. The attempt is the lane's current `attempts` counter
 * at fire time — the merge gate bumps it on every FAIL loopback, so a re-fire
 * after a failed verdict gets a fresh key, while a re-fire WITHIN the same
 * attempt dedups onto the existing request (the scheduler's idempotent-enqueue
 * contract, the same one the programmatic lane relies on).
 *
 * `lanes` matches by display ref first, then by task id — the two spellings
 * `defaultTaskRefForRun` can hand out.
 */
export function laneEnqueueKeyFor(
  runId: string,
  taskRef: string,
  lanes: readonly { taskId: string; ref: string | null; attempts: number }[],
): string | undefined {
  const lane = lanes.find((l) => l.ref === taskRef) ?? lanes.find((l) => l.taskId === taskRef);
  if (!lane) return undefined;
  return laneEnqueueKey(runId, taskRef, lane.attempts);
}

export async function enqueueTaskVerification(
  opts: EnqueueTaskVerificationOptions,
): Promise<TaskEnqueueResult> {
  const { db, runId, laneTaskRef, attempt, worktreePath, logger } = opts;

  // (1) Immutable verify stamps + project id (resolveReviewItemRunContext's minimal
  // query, reduced to the columns this seam needs). Read defensively — a pre-078 /
  // pre-055 DB lacking the columns degrades to a disabled posture (skipped).
  let enabled = false;
  let stampedType: VerificationType | null = null;
  let stampedChain: VisualBackendId[] = [];
  let projectId = Number.NaN;
  try {
    const row = db
      .prepare(
        `SELECT project_id AS projectId, verify_enabled AS verifyEnabled,
                verify_type AS verifyType, verify_chain AS verifyChain
           FROM workflow_runs WHERE id = ?`,
      )
      .get(runId) as
      | { projectId?: unknown; verifyEnabled?: unknown; verifyType?: unknown; verifyChain?: unknown }
      | undefined;
    // Distinct from the off switch below (F8): a missing run row is an anomaly
    // the controller should surface, not a deliberate 'verification-disabled'.
    if (!row) return { outcome: 'skipped', reason: 'no-run-row' };
    enabled = row.verifyEnabled === 1 || row.verifyEnabled === true;
    stampedType = isVerificationType(row.verifyType) ? row.verifyType : null;
    stampedChain = parseStampedChain(row.verifyChain);
    projectId = typeof row.projectId === 'number' ? row.projectId : Number(row.projectId);
  } catch (err) {
    logger?.warn('[enqueueTaskVerification] verify-stamp read failed (fail-open skip)', {
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
    // Likewise distinct (F8): an unreadable stamp is a fault, not an off switch.
    return { outcome: 'skipped', reason: 'run-stamp-unreadable' };
  }

  if (!enabled || stampedType === null || !Number.isFinite(projectId)) {
    return { outcome: 'skipped', reason: 'verification-disabled' };
  }

  const type: VerificationType = stampedType;
  // Effective chain = FALLBACK_CHAINS[type] ∩ the stamped (host-available) chain,
  // in FALLBACK_CHAINS order. An empty intersection still enqueues (scheduler SKIP).
  const chain = FALLBACK_CHAINS[type].filter((backend) => stampedChain.includes(backend));

  // (3) FORCE lane identity: laneTaskRef is authoritative for gate attribution, so
  // it overrides task.taskRef AND drives the derived legacy input — both persisted
  // columns then carry the SAME ref regardless of what the composing agent wrote.
  const composedTask: VerificationTaskV1 = { ...opts.task, taskRef: laneTaskRef };

  // (3-modality) F5 / RC3 — THE LANE'S MODALITY, RESOLVED ONCE, HERE.
  //
  // Everything downstream that keys on a modality — the bootstrap preflight
  // below, the proven-runbook injection in `prepareVerificationEnqueue`, and
  // (through the merged task's shape) the stamp `scheduler.enqueue` writes on the
  // row — now reads THIS value, so they cannot disagree. Before F5 each derived
  // its own from the composed task's shape, which meant an undeclared task on a
  // project with only a proven `cdp-app` entry bootstrapped a fresh `web` runbook
  // (real budget, and a rewrite of the shared `.cyboflow/verify-runbook.json`)
  // before the injection seam ever consulted the record that already existed —
  // Codex #3 against F5's first revision, which resolved this AFTER the
  // bootstrap.
  //
  // THE BOOTSTRAP CAN ONLY EVER RUN ON THE SHAPE OR ON A PROVEN MODALITY (fix
  // round, reviewer finding on the bootstrap). Resolution adopts an off-shape
  // declaration only when a PROVEN record backs it, so the two possibilities
  // below are: the shape — exactly which modality the bootstrap ran on before F5
  // — or a modality whose record is already proven, which the preflight declines
  // as `already-proven`. A composer's one-word `"modality": "cdp-app"` can
  // therefore never talk this project into deriving a rival runbook over the
  // `.cyboflow/verify-runbook.json` its real, proven modality depends on.
  //
  // A PROOF REQUEST DOES NOT PROBE THE RECORDS. The verify-setup proof and the
  // lane bootstrap's own proof are both excluded from the bootstrap below, and a
  // pinned one short-circuits the injection too (`prepareVerificationEnqueue`
  // returns on the caller pin before any lookup) — so an F5 probe would buy
  // nothing on the one path where it costs the most: every extra `status()` read
  // is a read that can DEMOTE a rival modality's record while a proof is in
  // flight (RC2). They keep the pure SHAPE derivation they had before F5 — which
  // is also what the MCP handler's setup-proof pre-check uses to find the record
  // the pin is validated against, so the two stay aligned — and an unpinned proof
  // still resolves its own record for THAT modality inside the preparation,
  // exactly as it did.
  //
  // Total by construction (see {@link resolveEnqueueModality}); wrapped anyway,
  // like every other collaborator call in this never-throws seam.
  const carriesCallerPin = opts.runbookHash !== undefined && opts.runbookLocalVersion !== undefined;
  const isProofRequest = carriesCallerPin || opts.setupProof === true || opts.bootstrapProof === true;
  //
  // §A2 — resolution returns the TASK too: a project-surface hit adds an
  // inferred `app` block, and the bootstrap, the preparation and the row must
  // all see that task, not the composed one.
  let modality: VerificationModality;
  let resolvedTask: VerificationTaskV1 = composedTask;
  try {
    if (isProofRequest) {
      modality = resolveTaskModality(type, composedTask);
    } else {
      const resolution = await resolveEnqueueModality({
        type,
        task: composedTask,
        projectId,
        runId,
        probePath: worktreePath,
        ...(logger ? { logger } : {}),
      });
      modality = resolution.modality;
      resolvedTask = resolution.task;
    }
  } catch (err) {
    logger?.warn('[enqueueTaskVerification] modality resolution threw; falling back to the task shape', {
      runId,
      laneTaskRef,
      error: err instanceof Error ? err.message : String(err),
    });
    modality = resolveTaskModality(type, composedTask);
    resolvedTask = composedTask;
  }

  // (3a) The RUNBOOK BOOTSTRAP (lane-runbook-bootstrap.md §12 steps 1–8).
  //
  // Runs HERE — before the shared preparation, before any row — because that is
  // the last moment a decision still exists. Once the request is written and the
  // §3.2 gate skips it, the only thing left to write is a `skipped` terminal, and
  // that terminal BURNS the enqueue key: findLiveRequestByEnqueueKey counts it as
  // a live dedup hit, so a bootstrap running afterwards could not re-fire this
  // lane's own request at all.
  //
  // The bootstrap either PROVES a runbook (after which the shared preparation
  // below resolves it, merges it, and pins it — so the lane verifies exactly as
  // it would on a project a human had configured) or it does not, in which case
  // this function carries on unchanged and the gate skips the request with a
  // reason naming the situation. It has no channel to fail a lane, by design.
  //
  // THE PROOF ITSELF MUST NOT RE-ENTER HERE. The bootstrap fires its own
  // attestation-only request through this same seam with `bootstrapProof: true`;
  // consulting the bootstrap for that request would recurse into a second
  // bootstrap while the first is mid-flight, and the stamp would report the
  // recursion as its own owner re-entering. A proof request is by definition the
  // thing a bootstrap already decided to do.
  //
  // Wrapped like every other collaborator call in this function: the seam's
  // contract is NEVER THROWS, and an unavailable scheduler here must degrade to
  // today's enqueue rather than crash a lane.
  if (opts.bootstrapProof !== true && opts.setupProof !== true) {
    try {
      const outcome = await VerificationScheduler.getInstance().maybeBootstrapRunbook({
        projectId,
        runId,
        laneTaskRef,
        modality,
        task: resolvedTask,
        probePath: worktreePath,
      });
      if (outcome.kind !== 'not-attempted') {
        logger?.info('[enqueueTaskVerification] runbook bootstrap finished', {
          runId,
          laneTaskRef,
          outcome: outcome.kind,
          ...(outcome.kind === 'proven'
            ? { runbookHash: outcome.runbookHash, runbookLocalVersion: outcome.runbookVersion }
            : { detail: outcome.kind === 'declined' ? outcome.detail : outcome.detail }),
        });
      }
    } catch (err) {
      logger?.debug('[enqueueTaskVerification] runbook bootstrap unavailable', {
        runId,
        laneTaskRef,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // (3a1) Snapshot sha (§5.5) — captured AFTER the bootstrap, deliberately.
  //
  // The bootstrap writes up to TWO commits onto this branch: the rung-1 config
  // edit (§8.1 gives it its own commit) and the runbook itself. Capturing the
  // sha before them pinned the verification to a tree in which the runbook's own
  // ENABLING EDIT does not exist — so the request would execute a runbook
  // describing a project that only starts at the commit after the snapshot.
  //
  // Live-observed 2026-08-20: a lane whose bootstrap derived `port-from-env` on
  // `app.config.mjs` then verified against the pre-edit sha, where the port was
  // still a literal. The harness exported the declared `portEnv`, the config read
  // it nowhere, the server bound its hardcoded default, and the serve-identity
  // probe found no listener on the leased port — a `failed`/`ambiguous` terminal
  // for a deliverable that was fine. Every first lane verification on a project
  // needing a rung-1 edit would have failed this way.
  //
  // Nothing between here and the old position consumed the sha, and the bootstrap
  // does not read it, so this is a pure reordering. A capture failure still falls
  // back to null and STILL enqueues (the provisioner's dirty-worktree bucket).
  let snapshotSha: string | null = null;
  try {
    snapshotSha = await captureSnapshotSha(worktreePath);
  } catch (err) {
    logger?.warn('[enqueueTaskVerification] snapshot sha capture failed; enqueuing without a snapshot', {
      runId,
      worktreePath,
      error: err instanceof Error ? err.message : String(err),
    });
    snapshotSha = null;
  }

  // (3b) The SHARED enqueue-time rules (§7.2 guard + §5.2 seam-3 injection). Runs
  // BEFORE deriving the legacy input so `deliverable_json` is derived from the
  // task that is actually persisted, not from the pre-merge one.
  // Wrapped despite `prepareVerificationEnqueue` being total today: this seam's
  // contract is NEVER THROWS (a throw here crashes a lane), and that must not
  // depend on a collaborator two modules away staying total forever. An
  // unexpected throw degrades to "unpinned, unvalidated" and still enqueues,
  // which is the pre-phase-2 behavior.
  let prepared: PreparedVerificationEnqueue;
  try {
    prepared = await prepareVerificationEnqueue({
      projectId,
      runId,
      type,
      task: resolvedTask,
      ...(opts.runbookHash !== undefined && opts.runbookLocalVersion !== undefined
        ? { pin: { hash: opts.runbookHash, localVersion: opts.runbookLocalVersion } }
        : {}),
      // F5 — the SAME value the bootstrap ran on, never a second derivation.
      modality,
      probePath: worktreePath,
      ...(logger ? { logger } : {}),
    });
  } catch (err) {
    logger?.warn('[enqueueTaskVerification] enqueue preparation threw; enqueuing unpinned', {
      runId,
      laneTaskRef,
      error: err instanceof Error ? err.message : String(err),
    });
    // Unpinned and unmerged ⇒ the row stamps the resolved task's own shape (the
    // composed one plus any §A2 inferred `app`), so that — not the resolved
    // value — is the honest modality to report back.
    prepared = { ok: true, task: resolvedTask, modality: resolveTaskModality(type, resolvedTask) };
  }
  if (!prepared.ok) {
    logger?.warn('[enqueueTaskVerification] composed task rejected at enqueue; skipping visual verification', {
      runId,
      laneTaskRef,
      error: prepared.error,
    });
    return { outcome: 'skipped', reason: prepared.error };
  }
  // The preparation settles the modality (it is the half that knows whether the
  // injection actually happened); a disagreement with the value the bootstrap ran
  // on means a record moved underneath this enqueue between the two reads. Not an
  // error — the preparation's answer is the one the row will stamp — but the one
  // fact that makes such a lane legible afterwards.
  if (prepared.modality !== modality) {
    logger?.info('[enqueueTaskVerification] the preparation settled on a different modality than the bootstrap ran on', {
      runId,
      laneTaskRef,
      bootstrapModality: modality,
      preparedModality: prepared.modality,
    });
    modality = prepared.modality;
  }
  const task: VerificationTaskV1 = prepared.task ?? resolvedTask;
  const input = deriveLegacyInputFromTask(task, laneTaskRef);
  // THE KEY MUST CARRY A GENERATION FOR A BOOTSTRAP PROOF (mig 105).
  //
  // `findLiveRequestByEnqueueKey` treats ANY non-canceled row sharing the key as
  // a live dedup hit — terminals included, and explicitly including 'skipped'.
  // A lane that just got skipped for want of a runbook therefore already OWNS
  // `${runId}:${laneTaskRef}:${attempt}`, so firing the proof under that same key
  // would hand back the skipped row's id and deploy NOTHING, while every caller
  // read it as an enqueued request. Silent, total, and indistinguishable from
  // success from the outside.
  //
  // The `:bootstrap:<round>` segment is what makes each proof its own request,
  // and re-firing round N after a crash still dedups correctly — which is the
  // property that lets the bootstrap's recovery be "resume at the first
  // incomplete step" rather than a bespoke state machine.
  const enqueueKey =
    opts.bootstrapProof === true
      ? `${laneEnqueueKey(runId, laneTaskRef, attempt)}:bootstrap:${opts.bootstrapRound ?? 1}`
      : laneEnqueueKey(runId, laneTaskRef, attempt);

  // (4) Enqueue on the singleton. Guard getInstance (+ the enqueue itself) so an
  // uninitialized scheduler or a transient enqueue error is a fail-open SKIP, never
  // a thrown lane crash.
  try {
    // The modality stamp is NOT set here: this seam delegates to
    // scheduler.enqueue, which resolves + stamps it from (type, task) at the
    // single INSERT — one derivation site, so a lane enqueue and an MCP enqueue
    // can never disagree about a request's modality.
    //
    // F5 does not change that, and the preparation is what keeps it true (fix
    // round, blocker): the resolved modality reaches the stamp through the task
    // the merge produced — its `serve` is the record's, so the shape re-derives
    // to the same answer — and when no merge happened the preparation has
    // already fallen back to the composed task's own shape, which is what the
    // stamp derives anyway. `prepared.modality` is therefore always what the row
    // gets, and the §3.2 degrade gate reads the same modality this enqueue was
    // resolved for.
    const requestId = VerificationScheduler.getInstance().enqueue({
      runId,
      projectId,
      type,
      input,
      chain,
      task,
      snapshotSha,
      enqueueKey,
      ...(opts.setupProof === true ? { setupProof: true } : {}),
      ...(opts.bootstrapProof === true ? { bootstrapProof: true } : {}),
      ...(prepared.pin
        ? { runbookHash: prepared.pin.hash, runbookLocalVersion: prepared.pin.localVersion }
        : {}),
    });
    logger?.debug('[enqueueTaskVerification] enqueued lane verification', {
      runId,
      requestId,
      laneTaskRef,
      attempt,
      enqueueKey,
      hasSnapshot: snapshotSha !== null,
      runbookHash: prepared.pin?.hash ?? null,
      bootstrapProof: opts.bootstrapProof === true,
    });
    return { outcome: 'enqueued', requestId };
  } catch (err) {
    logger?.warn('[enqueueTaskVerification] scheduler unavailable; skipping visual verification', {
      runId,
      laneTaskRef,
      error: err instanceof Error ? err.message : String(err),
    });
    return { outcome: 'skipped', reason: 'scheduler-unavailable' };
  }
}
