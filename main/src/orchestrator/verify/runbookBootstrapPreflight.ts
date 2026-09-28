/**
 * The lane runbook-bootstrap PREFLIGHT — the decision made at enqueue time,
 * before any request row exists (docs/proposals/lane-runbook-bootstrap.md §12
 * step 1, §13 phase 2).
 *
 * WHAT IT ANSWERS. "This lane is about to enqueue a verification the §3.2
 * degrade gate is going to skip. Should this run derive and prove a runbook
 * first, or is skipping the honest outcome?" That is deliberately ALL it
 * answers: it is a pure decision over (toggle, task shape, runbook situation),
 * with the acting — claim the stamp, spawn the drafting agent, commit, register,
 * prove, re-enqueue — layered on top in phase 3.
 *
 * WHY IT LIVES BEFORE THE ENQUEUE rather than inside the gate. The gate runs
 * after the row is written and the lease taken; by then the lane has a request
 * that is going to be skipped and a `skipped` terminal is the only thing left to
 * write. The bootstrap has to happen while there is still a decision to make —
 * and, critically, before the enqueue key is burned: `findLiveRequestByEnqueueKey`
 * counts a `skipped` terminal as a live dedup hit, so a bootstrap that ran
 * afterwards could not re-fire the lane's own request under the same key.
 *
 * WHY IT IS NOT INSIDE `enqueueTaskVerification`. Two reasons. The decision has
 * to be unit-testable without a scheduler, a database, or a filesystem — it is
 * the piece whose correctness matters most and whose inputs are the easiest to
 * fake. And the enqueue seam has a hard NEVER-THROWS contract; keeping the
 * decision here, injected, means that contract is enforced at one small
 * boundary rather than spread through a longer function.
 *
 * PHASE 2 STATUS: this module is COMPLETE and WIRED, and the caller does not yet
 * act on what it returns. The point of landing it dark is that a user who turns
 * the toggle on can read the backend log and see exactly what the bootstrap
 * would have done on their project — including, on projects where it declines,
 * WHY — before any version of it is allowed to write to their branch.
 */
import type { VerificationModality, VerificationTaskV1 } from '../../../../shared/types/visualVerification';
import type { LoggerLike } from '../types';
import type { VerifyRunbookStatusDetail } from './runbookStore';
import type { ExploreRunbookRecord } from './verificationAgentRunner';
import { isExploreEligible } from './agentEngine';
import {
  bootstrapRemedyText,
  bootstrapSupportsModality,
  decideRunbookBootstrap,
  taskDerivesEnvironment,
  type BootstrapDecision,
} from './bootstrapEligibility';

/**
 * The runbook-optional half of the preflight's inputs
 * (runbook-optional-verification.md §A7): what the caller must know for the
 * preflight to tell a request that will EXPLORE from one that will skip.
 */
export interface RunbookBootstrapExploreDeps {
  /**
   * The runbook-optional KILL SWITCH (`requireProvenRunbookEngaged`), read by
   * the caller from the LIVE config — the same read the engine's gate 3 makes,
   * so the preflight and the gate cannot disagree about whether a request
   * explores. `true` ⇒ nothing explores and every decision is today's.
   */
  requireProvenRunbook: boolean;
  /**
   * The best registered record for (project, modality), any status or origin —
   * the SAME read the engine's `exploreRecordFor` makes, fed to the SAME
   * `isExploreEligible`. Only its levers matter here (cdp-app explores only with
   * a bindable `dataDirEnv`). A throw reads as "no record".
   */
  record: (projectId: number, modality: VerificationModality) => Pick<ExploreRunbookRecord, 'runbook'> | null;
}

/**
 * The §A7 drift finding, as the preflight hands it to its sink: a NON-BLOCKING
 * review-queue item, never a lane verdict. `dedupeKey` is stable per (run,
 * modality) so a durable sink (`createIfNoPending` on `source`) can dedupe
 * across a restart as well; the preflight also dedupes in memory.
 */
export interface ExploreStaleProofFinding {
  projectId: number;
  runId: string;
  laneTaskRef: string;
  modality: VerificationModality;
  title: string;
  body: string;
  dedupeKey: string;
}

/**
 * What the preflight needs from the world. Injected rather than imported for the
 * reason in the module doc — and because `status` is the SAME thunk the degrade
 * gate consults, so the preflight cannot form a second opinion about a project's
 * runbook by reading it a different way.
 */
export interface RunbookBootstrapPreflightDeps {
  /**
   * The resolved feature switch: the project toggle AND the kill switch, already
   * combined. Combined by the caller on purpose — this module has no business
   * reading `process.env`, and a test should be able to say "on" or "off"
   * without staging an environment.
   */
  enabled: boolean;
  /** The runbook situation for a (project, modality) in a specific tree. */
  status: (
    projectId: number,
    modality: VerificationModality,
    probePath?: string,
  ) => Promise<VerifyRunbookStatusDetail>;
  /**
   * §A7 — absent ⇒ the preflight never considers explore and decides exactly as
   * it did before the runbook-optional contract (the kill-switch behaviour).
   */
  explore?: RunbookBootstrapExploreDeps;
  /**
   * §A7 drift finding sink. Called at most once per (run, modality) per process,
   * when a request will explore BECAUSE its record reads `drifted` /
   * `content-drifted` (and no reprove is about to fix it). Absent ⇒ no finding,
   * and no extra status read. Must not block; a throw is swallowed.
   */
  reportStaleProofFinding?: (finding: ExploreStaleProofFinding) => void | Promise<void>;
  logger?: LoggerLike;
}

/**
 * (run, modality) pairs this process already filed the §A7 drift finding for.
 * In memory on purpose — it is a noise guard (one card per run, not per lane;
 * the MCP plane asks the preflight twice per deferred request), and the sink's
 * `dedupeKey` is the durable half. Bounded so a long-lived process cannot grow
 * it without limit: clearing costs, at worst, one repeated card.
 */
const filedStaleProofFindings = new Set<string>();
const FILED_STALE_PROOF_CAP = 2048;

/**
 * Will this request run in EXPLORE mode? The engine's gate-3 answer for an
 * UNPINNED row (the preflight only matters for a request with no proven record
 * to pin): the kill switch off, and {@link isExploreEligible} over the same
 * record the engine would read — `null` for native-screen, which is
 * pinned-only, exactly as the engine passes it.
 */
function requestWillExplore(
  explore: RunbookBootstrapExploreDeps | undefined,
  projectId: number,
  modality: VerificationModality,
): boolean {
  if (explore === undefined || explore.requireProvenRunbook) return false;
  let record: Pick<ExploreRunbookRecord, 'runbook'> | null = null;
  if (modality !== 'native-screen') {
    try {
      record = explore.record(projectId, modality);
    } catch {
      record = null;
    }
  }
  return isExploreEligible(modality, record);
}

/**
 * Decide whether this about-to-be-enqueued verification should trigger a runbook
 * bootstrap.
 *
 * NEVER THROWS. A status resolver that blows up yields `'unobservable'` — the
 * same answer as a record that could not be read, and for the same reason: the
 * one thing a bootstrap must never do is write on a guess. The caller's fallback
 * is today's behavior, so a failure here costs nothing beyond the feature not
 * firing.
 *
 * `probePath` is the run's worktree — the tree the request would actually
 * execute in, and the one the gate now probes too. Passing the project root
 * instead would be the §3 disagreement all over again, one seam later: the
 * preflight would see a runbook the gate cannot use, decline to bootstrap, and
 * the lane would skip anyway.
 */
export async function runbookBootstrapPreflight(
  args: {
    projectId: number;
    runId: string;
    laneTaskRef: string;
    modality: VerificationModality;
    task: Pick<VerificationTaskV1, 'build' | 'serve'>;
    probePath?: string;
  },
  deps: RunbookBootstrapPreflightDeps,
): Promise<BootstrapDecision> {
  const derivesEnvironment = taskDerivesEnvironment(args.task);
  const explores = requestWillExplore(deps.explore, args.projectId, args.modality);
  // The §A7 drift finding needs the record's status for EVERY exploring request
  // — a mobile lane and a disabled toggle included, since both still explore —
  // so with a sink wired the read below widens to that case too.
  const wantsDriftStatus = explores && deps.reportStaleProofFinding !== undefined;

  // Ask about the runbook ONLY when the answer could matter. A disabled feature,
  // a modality the lane never authors for (`mobile` — the verify-setup flow owns
  // those), or a degenerate target-only task decides this on its own, and the
  // status read is a file read plus a project input hash — real work to reach a
  // conclusion already in hand. The modality test is the SAME predicate
  // `decideRunbookBootstrap` declines by, not a second copy of the policy.
  let status: VerifyRunbookStatusDetail = { status: 'absent', reason: 'indeterminate' };
  let consulted = false;
  if ((deps.enabled && bootstrapSupportsModality(args.modality) && derivesEnvironment) || wantsDriftStatus) {
    consulted = true;
    try {
      status = await deps.status(args.projectId, args.modality, args.probePath);
    } catch (err) {
      deps.logger?.warn('[runbookBootstrapPreflight] runbook status failed (declining)', {
        runId: args.runId,
        projectId: args.projectId,
        modality: args.modality,
        error: err instanceof Error ? err.message : String(err),
      });
      // Leave the seeded 'indeterminate' — decideRunbookBootstrap maps it to
      // 'unobservable', which declines.
    }
  }

  const decision = decideRunbookBootstrap({
    enabled: deps.enabled,
    modality: args.modality,
    derivesEnvironment,
    status,
    explores,
  });

  if (wantsDriftStatus && consulted) await maybeFileStaleProofFinding(args, deps, status, decision);

  // Logged at DEBUG for the two non-events (feature off, nothing to derive) and
  // INFO for everything else: a project where the bootstrap would fire, or
  // declines for a reason a human may need to know, is worth finding in a log
  // without turning verbose logging on for every degenerate task in every run.
  // `explore-mode` is quiet too: it is the NORMAL answer for every lane on a
  // project with no runbook once explore is on, not a situation to go find.
  const quiet =
    !decision.proceed &&
    (decision.reason === 'disabled' || decision.reason === 'no-environment' || decision.reason === 'explore-mode');
  // The three proceed shapes read very differently to whoever is looking at this
  // log to decide whether the feature did the right thing — deriving a rival
  // runbook and re-proving an existing one are opposite actions (F4 / Codex #2),
  // and a line that called both "would bootstrap" would hide exactly the
  // distinction stage 2 exists to make.
  const line = decision.proceed
    ? `[runbookBootstrapPreflight] would bootstrap (${
        decision.mode === 'reprove'
          ? 're-prove the existing runbook'
          : decision.proveOnly === true
            ? 'prove the registered draft only — the request explores'
            : decision.adopt
            ? 'adopt committed runbook'
            : 'derive a new runbook'
      })`
    : `[runbookBootstrapPreflight] declined: ${decision.reason}`;
  const detail = {
    runId: args.runId,
    projectId: args.projectId,
    laneTaskRef: args.laneTaskRef,
    modality: args.modality,
    probePath: args.probePath ?? null,
    // `null` rather than the seeded `'indeterminate'` when the read was skipped:
    // 'indeterminate' is a real answer meaning "the store could not tell", and
    // logging it for a decision that never asked would send whoever reads this
    // line hunting a store fault that does not exist.
    runbookReason: consulted ? status.reason : null,
    explores,
  };
  if (quiet) deps.logger?.debug(line, detail);
  else deps.logger?.info(line, detail);

  return decision;
}

/**
 * §A7 drift finding: a request that will EXPLORE because its proven record
 * reads `drifted` / `content-drifted` files `bootstrapRemedyText('stale-proof')`
 * as a non-blocking finding, once per (run, modality).
 *
 * NOT for a `'drifted'` record the bootstrap is about to REPROVE: if the
 * reprove passes, the request pins rather than explores and the finding would
 * be false; if it fails, the reprove's own artifact already says so. A
 * `'content-drifted'` record never reproves (a proof cannot re-stamp the
 * content hash), so it always files.
 *
 * NEVER THROWS — a sink failure is logged and dropped; the finding is advisory.
 */
async function maybeFileStaleProofFinding(
  args: { projectId: number; runId: string; laneTaskRef: string; modality: VerificationModality },
  deps: RunbookBootstrapPreflightDeps,
  status: VerifyRunbookStatusDetail,
  decision: BootstrapDecision,
): Promise<void> {
  const sink = deps.reportStaleProofFinding;
  if (sink === undefined) return;
  if (status.reason !== 'drifted' && status.reason !== 'content-drifted') return;
  if (decision.proceed && decision.mode === 'reprove') return;
  const remedy = bootstrapRemedyText('stale-proof');
  if (remedy === null) return;
  const dedupeKey = `visual-verify:explore-stale-proof:${args.runId}:${args.modality}`;
  if (filedStaleProofFindings.has(dedupeKey)) return;
  if (filedStaleProofFindings.size >= FILED_STALE_PROOF_CAP) filedStaleProofFindings.clear();
  filedStaleProofFindings.add(dedupeKey);
  try {
    await sink({
      projectId: args.projectId,
      runId: args.runId,
      laneTaskRef: args.laneTaskRef,
      modality: args.modality,
      title: `Verification runbook (${args.modality}) needs re-proving — lanes explore meanwhile`,
      body:
        `Verification for this run's \`${args.modality}\` lanes is running in EXPLORE mode (no pinned ` +
        'recipe) because the proven runbook no longer matches this tree ' +
        `(\`${status.reason}\`). Explore verdicts stand on their own, but they are slower and cap ` +
        'more often at low confidence than a pinned run.\n\n' +
        remedy,
      dedupeKey,
    });
  } catch (err) {
    deps.logger?.warn('[runbookBootstrapPreflight] stale-proof finding could not be filed (advisory)', {
      runId: args.runId,
      modality: args.modality,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
