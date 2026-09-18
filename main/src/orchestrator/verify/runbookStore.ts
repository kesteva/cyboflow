/**
 * VerifyRunbookStore — the MACHINE-LOCAL half of the verification runbook
 * contract (docs/proposals/verification-setup-flow.md §5.2 seam 1 + §5.3),
 * persisted on migration 096's `verify_runbook_local` table.
 *
 * WHAT THIS REPLACES. The phase-0 degrade gate already asks "does this
 * (project, modality) have a PROVEN runbook?" — and until now the answer was a
 * hard-coded `'absent'` for every project, because the concept did not exist
 * (`verificationScheduler.ts`: `deps.runbookStatus ?? (() => 'absent')`). This
 * store is the real answer. It owns the four verbs of §5's "derive → prove →
 * persist → reuse → re-derive on drift" that touch persistence:
 * {@link VerifyRunbookStore.registerDraft} (persist a derived revision),
 * {@link VerifyRunbookStore.markProven} (the engine's proof flip),
 * {@link VerifyRunbookStore.status} (reuse + drift detection — and its
 * situation-preserving sibling {@link VerifyRunbookStore.statusDetail}), and
 * {@link VerifyRunbookStore.getByHash} (the runner's pin resolution).
 *
 * THE ONE INVARIANT WORTH RE-READING: `'proven'` is not a flag someone sets, it
 * is a CONJUNCTION re-checked on every read. `status()` answers `'proven'` only
 * when ALL of the following hold — record present and marked proven, AND the
 * portable file at the probe path parses and hashes to the record's
 * `portable_hash` WHEN THIS TREE CARRIES ONE AT ALL (see THE FILE IS AN EXPORT
 * below), AND a freshly computed project input-hash equals the stored one, AND
 * the host fingerprint equals the stored one. §5.3: "Any component changing
 * demotes." §1 is the reason: the failed `.cyboflow/verify.json` era proved that
 * a config which is merely WRITTEN is worth nothing, and a config that was once
 * proven but whose inputs have since moved is the same thing wearing a green
 * badge.
 *
 * DRIFT IS COMPUTED ON EVERY READ AND NEVER PERSISTED (F4 / Codex #2 —
 * docs/proposals/visual-verification-brittleness-fixes.md). An input-hash /
 * host-fingerprint mismatch makes THIS read answer `'unproven-draft'` with
 * reason `'drifted'`, and a portable file that is PRESENT but is not the
 * record's content answers `'content-drifted'` (the two are separated because
 * only the first can be cleared by re-proving — see
 * {@link VerifyRunbookStatusReason}); neither writes ANYTHING. The persisted
 * `status` column therefore moves on exactly two verbs — `registerDraft` (down)
 * and `markProven` (up) — and a proof survives the transient conditions that
 * used to destroy it outright: a dependency bump, an app release, a stable↔dev
 * switch, a one-character `notes` edit, or simply being read from a tree whose
 * file has not merged yet. Recovery used to mean a full re-derive; now it means
 * the inputs coming back, or a re-prove that re-stamps them.
 *
 * The gate and the badge stay honest without that destruction because BOTH go
 * through this conjunction on every read (`verificationRequests.ts:475`, `:953`
 * re-validate a stored `'proven'` rather than trusting the column). THE ACCEPTED
 * CONSEQUENCE (Codex #2): `getByHash` returns the persisted status WITHOUT
 * recomputing drift, and the runner's execution-time pin check
 * (`verificationAgentRunner.ts:967`) rejects a non-`'proven'` record — so with
 * non-writing drift that execution-time signal now fires only for a
 * RE-REGISTERED (superseded) record, never for a drifted one. The ENQUEUE GATE
 * is the freshness check. The residual window (gate says proven → something
 * drifts → the pinned run still executes) is the same one that has always
 * existed between the gate's read and a later one: the request is
 * content-addressed to `portable_json` and its snapshot sha is already fixed.
 *
 * THE FILE IS AN EXPORT; THE RECORD IS WHAT EXECUTES (F10). Nothing reads
 * `.cyboflow/verify-runbook.json` inside the detached snapshot — the runner
 * fetches `portable_json` by content hash (`getByHash`). So a probe path that
 * GENUINELY LACKS the file — the ordinary pre-merge state on every branch that
 * has not landed the runbook yet — SKIPS the portable-hash conjunct and is
 * judged on the other two; the input hash still refuses a branch whose scripts
 * or lockfile moved, which is the part that actually changes what "build and
 * serve this" means. A file that is PRESENT but unparseable, or that hashes to
 * something else, is real content drift and still refuses. This is why
 * `readPortableFile` must answer `null` ONLY for a genuinely absent file and
 * THROW on every other IO failure (Codex #8): collapsing an unreadable tree into
 * `null` would launder it into the record-authoritative path, whereas a throw
 * lands in this class's fail-soft catch as `'absent'`/`'indeterminate'`.
 *
 * IO IS INJECTED, NOT IMPORTED (see {@link VerifyRunbookStoreDeps}). Reading the
 * portable file, hashing project inputs, and fingerprinting the host are all
 * environment-specific and all needed by `status()`, but importing `node:fs`
 * here would break the standalone-typecheck invariant this module shares with
 * capabilityStore.ts (narrow DatabaseLike/LoggerLike only — no electron, no
 * better-sqlite3, no fs, no services/*), and would make every store test need a
 * real filesystem to exercise a DB state machine.
 *
 * FAIL-SOFT BY DESIGN, exactly as capabilityStore.ts: every method catches its
 * own SQL/IO errors (a pre-096 DB missing the table, a locked file, a malformed
 * row, an injected dep that throws) and degrades to the SAFE answer rather than
 * throwing. For `status()` the safe answer is `'absent'` — the degrade gate then
 * skips with a setup CTA, which is a bad day, not a broken one. There is no
 * failure mode of this store that may produce a spurious `'proven'`.
 */
import type { DatabaseLike, LoggerLike } from '../types';
import type { VerificationModality } from '../../../../shared/types/visualVerification';
import {
  parseVerifyRunbookV1,
  type VerifyRunbookV1,
  type VerifyRunbookModality,
  type VerifyRunbookModalityEntry,
} from '../../../../shared/types/verifyRunbook';
import { runbookPortableHash } from './runbookHash';

// ---------------------------------------------------------------------------
// §7.2 mobile command-isolation guard — registration-chokepoint half.
// ---------------------------------------------------------------------------
//
// `dependencyCommandGuard.ts` covers the cross-modality "no dependency
// mutation" rule for every composed task, runbook-sourced or agent-composed
// alike. The mobile tier has a SECOND, mobile-specific isolation rule that
// module cannot express: a `build[]` step must resolve its DerivedData
// directory and its simulator target through the request-scoped LEVERS
// (`$VERIFY_DERIVED_DATA` / `$VERIFY_SIM_UDID`, or the runbook's own declared
// lever names), never a fixed path or a hardcoded device — because those two
// values are what make one request's simulator run isolated from every
// other's, the mobile equivalent of the web tier's per-request port lease.
// A hardcoded UDID or an absolute DerivedData path silently defeats that
// isolation the exact way an install spelled through indirection defeats
// `dependencyCommandGuard`'s pattern, so this lives at the SAME registration
// chokepoint (`registerDraft`) rather than in `runbookDraftValidation.ts`,
// which the shape/cross-field parser already owns and which has exactly one
// caller — command-level content is not its job.

const XCODEBUILD_INVOCATION_PATTERN = /\bxcodebuild\b/i;
const CODE_SIGNING_DISABLED_PATTERN = /\bCODE_SIGNING_ALLOWED=NO\b/;
const LITERAL_UDID_PATTERN = /\b[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\b/;
const SIMCTL_LIFECYCLE_PATTERN = /\bxcrun\s+simctl\s+(?:install|launch|boot|create|delete|shutdown)\b/i;

/** Fallback lever env-var names when the runbook does not declare its own — see `levers.derivedDataEnv`/`simUdidEnv`. */
const DEFAULT_DERIVED_DATA_ENV = 'VERIFY_DERIVED_DATA';
const DEFAULT_SIM_UDID_ENV = 'VERIFY_SIM_UDID';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether `text` references one of `varNames` in any of the three accepted
 * spellings — `$VAR`, `${VAR}`, or `"$VAR"`. The quoted form needs no special
 * case: `"$VAR"` already CONTAINS the substring `$VAR`, so the same pattern
 * matches all three without knowing which one was used.
 */
function referencesEnvVar(text: string, varNames: readonly string[]): boolean {
  return varNames.some((name) => new RegExp(`\\$\\{?${escapeRegExp(name)}\\}?(?![A-Za-z0-9_])`).test(text));
}

/** The token immediately following `flag`, unwrapping a `"..."`/`'...'` quote when present. */
function extractFlagValue(command: string, flag: string): string | null {
  const match = command.match(new RegExp(`${escapeRegExp(flag)}\\s+(?:"([^"]*)"|'([^']*)'|(\\S+))`));
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
}

/** Whether `command` carries `-destination` with an `id=` referencing one of `varNames`. */
function hasLeveredDestination(command: string, varNames: readonly string[]): boolean {
  if (!/-destination\b/.test(command)) return false;
  return varNames.some((name) => new RegExp(`id=\\$\\{?${escapeRegExp(name)}\\}?(?![A-Za-z0-9_])`).test(command));
}

/**
 * §7.2 mobile isolation check over one `mobile` modality entry's `build[]`.
 * Returns the first offending step's detail (naming the step index and the
 * missing/forbidden token) or `null` when every step is clean.
 *
 * Two tiers of rule, per step:
 *   - EVERY step (xcodebuild or not) is refused for a literal simulator/device
 *     UDID, and for any `xcrun simctl install|launch|boot|create|delete|
 *     shutdown` — device lifecycle and app install/launch are HARNESS-OWNED
 *     (the driver's own `mobile-install` / `mobile-launch` commands), never a
 *     build step's job.
 *   - An `xcodebuild` step ADDITIONALLY must lever its DerivedData directory
 *     (`-derivedDataPath`, relative, referencing the lever) and its simulator
 *     target (`-destination id=<lever>`), and must disable code signing
 *     (`CODE_SIGNING_ALLOWED=NO`) so a snapshot never touches the developer's
 *     real signing identity. A non-xcodebuild pre-step (e.g. `swift build`
 *     resolving a package ahead of the real build) is not held to these
 *     three — it has no DerivedData/destination/signing concept of its own.
 */
function checkMobileBuildIsolation(
  entry: VerifyRunbookModalityEntry,
  levers: VerifyRunbookV1['levers'],
): string | null {
  const derivedDataVars = [levers?.derivedDataEnv, DEFAULT_DERIVED_DATA_ENV].filter(
    (v): v is string => typeof v === 'string' && v.length > 0,
  );
  const simUdidVars = [levers?.simUdidEnv, DEFAULT_SIM_UDID_ENV].filter(
    (v): v is string => typeof v === 'string' && v.length > 0,
  );

  const steps = entry.build ?? [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const label = `modalities["mobile"].build[${i}]`;

    const udidMatch = step.match(LITERAL_UDID_PATTERN);
    if (udidMatch) {
      return `${label}: contains a literal simulator/device UDID ("${udidMatch[0]}") — the UDID must come from the request-scoped simUdidEnv lever, never be hardcoded: ${step}`;
    }
    const simctlMatch = step.match(SIMCTL_LIFECYCLE_PATTERN);
    if (simctlMatch) {
      return `${label}: runs "${simctlMatch[0]}" — simulator install/launch (the harness's own mobile-install/mobile-launch) and device lifecycle are harness-owned, not a build step's job: ${step}`;
    }

    if (!XCODEBUILD_INVOCATION_PATTERN.test(step)) continue;

    const derivedDataValue = extractFlagValue(step, '-derivedDataPath');
    if (derivedDataValue === null) {
      return `${label}: missing "-derivedDataPath" referencing the DerivedData lever ($${DEFAULT_DERIVED_DATA_ENV} or the runbook's levers.derivedDataEnv): ${step}`;
    }
    if (derivedDataValue.startsWith('/') || derivedDataValue.startsWith('~')) {
      return `${label}: -derivedDataPath is an absolute path ("${derivedDataValue}") — it must reference the request-scoped DerivedData lever, not a fixed location: ${step}`;
    }
    if (!referencesEnvVar(derivedDataValue, derivedDataVars)) {
      return `${label}: -derivedDataPath does not reference the DerivedData lever ($${DEFAULT_DERIVED_DATA_ENV} or the runbook's levers.derivedDataEnv): ${step}`;
    }

    if (!hasLeveredDestination(step, simUdidVars)) {
      return `${label}: missing "-destination" with "id=$${DEFAULT_SIM_UDID_ENV}" (or the runbook's levers.simUdidEnv) — the simulator target must be the request-scoped lever, never a fixed device: ${step}`;
    }

    if (!CODE_SIGNING_DISABLED_PATTERN.test(step)) {
      return `${label}: missing "CODE_SIGNING_ALLOWED=NO" — an xcodebuild build step must disable code signing so a snapshot never touches the developer's signing identity: ${step}`;
    }
  }
  return null;
}

/**
 * The persisted state of one (project, modality) runbook record — the same
 * three-valued answer the scheduler's `RunbookStatus` dependency expects
 * (§3.2). `'absent'` covers both "no record at all" and every fail-soft
 * degradation; `'unproven-draft'` is deliberately NOT a pass.
 */
export type VerifyRunbookStatus = 'proven' | 'unproven-draft' | 'absent';

/**
 * WHY the same answer is not always the same situation.
 *
 * `status()` is deliberately three-valued because that is all its one consumer
 * — the §3.2 degrade gate — can act on: proven, or not. But `'unproven-draft'`
 * is a collapse of genuinely different facts, and a caller that intends to
 * *write* rather than merely gate has to tell them apart. The motivating case
 * (lane-runbook-bootstrap.md §4): `registerDraft` UPSERTs a SINGLETON
 * `(project_id, modality)` row, so a caller that reacts to `'unproven-draft'`
 * by deriving a fresh runbook would, on a branch that merely predates the
 * runbook merge, overwrite the proven record every OTHER branch depends on —
 * breaking verification precisely for the projects that set it up properly.
 *
 * The discriminant, by situation:
 *
 *  - `'proven'` — the full conjunction holds. The only reason paired with a
 *    `'proven'` status.
 *  - `'no-record'` — nothing persisted and no usable portable file. Nothing was
 *    ever derived for this (project, modality); there is no proof to endanger.
 *  - `'file-only'` — no record, but THIS tree carries a portable file that
 *    parses and declares the modality (a teammate's committed runbook, freshly
 *    cloned). Distinct from `'no-record'` because the right response is to
 *    ADOPT and prove what is already there, not to author a competing one.
 *  - `'draft'` — a record exists and is marked `'unproven-draft'`. There is no
 *    proof to endanger, so re-deriving over it is safe.
 *  - `'proven-file-absent-here'` — a record is PROVEN and this tree simply
 *    lacks the portable file. RETAINED IN THIS UNION BUT NO LONGER PRODUCED BY
 *    `statusDetail` (F10): the file is an export and the record is what
 *    executes, so an absent file now skips only the portable-hash conjunct and
 *    the read can still answer `'proven'`. It stays in the type because other
 *    modules still map it — `bootstrapEligibility` → `'proof-belongs-elsewhere'`
 *    (never bootstrap), the scheduler → `VERIFY_RUNBOOK_ELSEWHERE_REASON` — and
 *    an injected/stubbed status resolver may still emit it. If it is ever
 *    produced again, the rule it carries is unchanged: **never write over this
 *    one**; the resolution is to merge the branch carrying the file.
 *  - `'drifted'` — a proven record's PROVENANCE no longer holds: the project
 *    input hash or the host fingerprint moved away from what the proof was
 *    taken against. COMPUTED, NOT PERSISTED (F4): the DB row still reads
 *    `'proven'`, this read answers `'unproven-draft'`, and the next read
 *    re-derives the same answer from the same evidence. A caller that WRITES
 *    must treat it as "re-prove this record", not "re-derive over it" — the
 *    runbook itself may be perfectly good and merely proven against inputs
 *    that have since moved. This is the ONE drift a re-prove can clear, which
 *    is why it is spelled apart from the next one.
 *  - `'content-drifted'` — the tree DOES carry a portable file and it is not
 *    the record's content: it no longer parses, or it hashes to something other
 *    than `portable_hash`. Also computed and never persisted, and it gates
 *    exactly like `'drifted'` — but its REMEDY is the opposite one, which is
 *    why the two are not one reason (F4 fix round). A re-prove cannot clear
 *    this: promotion deliberately never re-stamps `portable_hash` (Codex #1),
 *    so a proof pinned to the record would pass and the very next read would
 *    compute the same mismatch — a passing proof that can never be confirmed,
 *    once per run, forever. What this needs is RE-REGISTRATION of the tree's
 *    revision (`registerDraft`, i.e. the Verify Setup flow) and then a proof of
 *    that. See {@link decideRunbookBootstrap}, which declines it for exactly
 *    this reason.
 *  - `'indeterminate'` — the store could not observe enough to answer (a
 *    pre-096 DB, a SQL error, an input hash that would not compute). Fails soft
 *    to `'absent'` like everything else here, but is NOT evidence that nothing
 *    exists, and a writing caller must treat it as "do not touch".
 *
 * Note this is a superset of the four discriminants the proposal named: two
 * situations `status()` already distinguishes internally (`'file-only'`, and
 * the two fail-soft `'absent'` paths) collapse to the wrong answer if folded
 * into the others, and the whole point of this type is not to collapse things.
 */
export type VerifyRunbookStatusReason =
  | 'proven'
  | 'no-record'
  | 'file-only'
  | 'draft'
  | 'proven-file-absent-here'
  | 'drifted'
  | 'content-drifted'
  | 'indeterminate';

/** The three-valued gate answer plus the situation that produced it. */
export interface VerifyRunbookStatusDetail {
  status: VerifyRunbookStatus;
  reason: VerifyRunbookStatusReason;
  /**
   * On a `'draft'` answer only: does THIS tree also carry a parseable portable
   * file declaring the modality? A draft record with a committed file beside
   * it is §4's adopt case as much as `'file-only'` is — the record merely got
   * registered first — and the bootstrap should hand the agent that file
   * rather than ask for a rival. Absent on every other reason.
   */
  fileDeclaresModality?: boolean;
}

/**
 * Environment-specific IO the store needs but must not import (see the class
 * doc's IO IS INJECTED note). All three are expected to be TOTAL — they report
 * failure by returning `null` / rejecting, and the store treats a rejection as
 * a fail-soft `'absent'`, never as a reason to demote a record.
 */
export interface VerifyRunbookStoreDeps {
  /**
   * Read `<dirPath>/.cyboflow/verify-runbook.json` (the portable half). Returns
   * the raw file text, or `null` when the file is GENUINELY ABSENT.
   *
   * THE NULL IS LOAD-BEARING AND NARROW (F10 / Codex #8). `null` means "this
   * tree does not carry the file", which the store treats as
   * record-authoritative: the portable-hash conjunct is skipped and the proof is
   * judged on the input hash + host fingerprint alone. Every OTHER failure —
   * permissions, an IO error, a path component that is not a directory in a way
   * the implementation cannot read as absence — must REJECT, so it degrades to
   * the fail-soft `'absent'`/`'indeterminate'` answer instead of laundering an
   * unreadable tree into a proof. Unparseable/mismatched CONTENT is neither: it
   * is real drift, and the store refuses it.
   */
  readPortableFile: (dirPath: string) => Promise<string | null>;
  /**
   * The §5.3 project INPUT hash for the tree at `dirPath` — dev/build scripts,
   * lockfile, electron/node versions. `null` means "could not compute", which
   * fails soft to `'absent'` WITHOUT demoting: an inability to observe the
   * inputs is not evidence that they changed.
   */
  computeInputHash: (dirPath: string) => Promise<string | null>;
  /**
   * The §5.3 host fingerprint — chromium binary, TCC grant state, node major,
   * app binary path — serialized to a comparable string. Shares the shape
   * `VerifyCapabilityStore.bumpHostGeneration(fingerprintJson)` records for
   * diagnostics; here it is compared for EQUALITY, so its serialization must be
   * stable across calls on an unchanged host.
   */
  hostFingerprint: () => Promise<string>;
  logger?: LoggerLike;
}

/** Raw `verify_runbook_local` row shape, as read back from SQLite. */
interface RunbookLocalRow {
  portable_hash: string;
  portable_json: string;
  version: number;
  status: string;
  bindings_json: string | null;
  proof_json: string | null;
  input_hash: string | null;
  host_fingerprint_json: string | null;
}

/** The subset of a row `getByHash` hands the runner for §5.2 pin execution. */
export interface PinnedRunbookRecord {
  runbook: VerifyRunbookV1;
  version: number;
  status: 'proven' | 'unproven-draft';
}

/** Narrowing helper — the CHECK constraint guarantees this, a hand-edited DB does not. */
function isPersistedStatus(value: string): value is 'proven' | 'unproven-draft' {
  return value === 'proven' || value === 'unproven-draft';
}

export class VerifyRunbookStore {
  constructor(
    private readonly db: DatabaseLike,
    private readonly deps: VerifyRunbookStoreDeps,
  ) {}

  /**
   * The §3.2/§5.3 status provider — the function the scheduler's
   * `runbookStatus` dependency is meant to become.
   *
   * `probePath` is the tree whose portable half is checked: the REQUESTING
   * RUN's worktree when it has one, else the project root — worktree-first,
   * mirroring `verifyConfigLoader`'s resolution ladder for the same reason (a
   * run's verification must be described by the tree that run is actually
   * changing, not by the project's main checkout). The caller resolves that
   * ladder; this method just probes what it is handed.
   *
   * Answers, in order:
   *   - no record AND no file            → `'absent'` (nothing was ever derived).
   *   - no record BUT a file that parses
   *     and declares this modality       → `'unproven-draft'` (derived in the
   *     repo, never proven ON THIS HOST — e.g. a teammate's committed runbook
   *     freshly cloned). Behaves exactly like `'absent'` at the gate; the
   *     distinction only sharpens the CTA.
   *   - record marked `'unproven-draft'` → `'unproven-draft'`, unconditionally
   *     (already the lowest non-absent state — nothing to re-check, and a drift
   *     check could only ever refuse, never promote).
   *   - record marked `'proven'`:
   *       * file GENUINELY ABSENT here   → the portable-hash conjunct is
   *         SKIPPED and the other two decide (F10: the record, not the file, is
   *         what a proof executes — see the class doc). The pre-merge tree can
   *         therefore still read `'proven'`.
   *       * file unparseable, or hashes
   *         to something else            → `'unproven-draft'`/`'content-drifted'`
   *         (a DIFFERENT remedy from the two below: re-register, do not
   *         re-prove — see {@link VerifyRunbookStatusReason}).
   *       * fresh input-hash differs     → `'unproven-draft'`/`'drifted'`.
   *       * host fingerprint differs     → `'unproven-draft'`/`'drifted'`.
   *       * the applicable conjuncts
   *         all agree                    → `'proven'`.
   *
   * NONE OF THOSE ANSWERS WRITES (F4). The persisted `status` column is not
   * corrected here; it moves only under `registerDraft`/`markProven`, and every
   * gate/badge read recomputes this conjunction — see the class doc.
   *
   * A stored `input_hash` / `host_fingerprint_json` of NULL against a freshly
   * computed non-null value counts as a DIFFERENCE and refuses. That is the
   * conservative reading of "any component changing demotes": a proven record
   * whose provenance was never captured cannot be shown to still hold, and the
   * cost of being wrong here is one re-proof, versus shipping against a runbook
   * proven on inputs nobody recorded.
   *
   * A READ THAT CANNOT OBSERVE ITS INPUTS IS NOT A DRIFT. A `computeInputHash`
   * of `null`, a `readPortableFile` that REJECTS (permissions, IO — see that
   * dep's contract), or any SQL error lands on the fail-soft
   * `'absent'`/`'indeterminate'` answer: refused, but never mistaken for
   * evidence that something changed, and — like every other answer here — never
   * written.
   */
  async status(
    projectId: number,
    probePath: string,
    modality: VerificationModality,
  ): Promise<VerifyRunbookStatus> {
    return (await this.statusDetail(projectId, probePath, modality)).status;
  }

  /**
   * {@link VerifyRunbookStore.status}, plus WHICH of the situations behind the
   * answer produced it — see {@link VerifyRunbookStatusReason} for the full
   * enumeration and why the collapse is unsafe for a caller that writes.
   *
   * This is the real implementation; `status()` is a projection of it, so the
   * gate's answer and a writing caller's answer can never be computed by two
   * code paths that drift. BOTH ARE PURE READS (F4): a drift check that fails
   * answers `'drifted'` and writes nothing, so asking for the detail — or asking
   * at all — can no longer cost a project its proof.
   */
  async statusDetail(
    projectId: number,
    probePath: string,
    modality: VerificationModality,
  ): Promise<VerifyRunbookStatusDetail> {
    try {
      const row = this.readRow(projectId, modality);

      const rawFile = await this.deps.readPortableFile(probePath);
      const parsedFile = rawFile === null ? null : this.parsePortable(rawFile, probePath);

      if (!row) {
        // Nothing persisted. A parseable file that declares this modality is a
        // derived-but-never-proven runbook; anything else is genuinely absent.
        if (parsedFile && this.declaresModality(parsedFile, modality)) {
          return { status: 'unproven-draft', reason: 'file-only' };
        }
        return { status: 'absent', reason: 'no-record' };
      }

      if (row.status !== 'proven') {
        return {
          status: 'unproven-draft',
          reason: 'draft',
          fileDeclaresModality: parsedFile !== null && this.declaresModality(parsedFile, modality),
        };
      }

      // F10 — RECORD-AUTHORITATIVE WHEN THE FILE IS GENUINELY ABSENT HERE.
      // The proof executes the DB record's `portable_json` (the runner resolves
      // it by content hash), so a tree that simply does not carry the export
      // cannot change WHAT would run: the portable-hash conjunct has nothing to
      // compare and is skipped. The other two conjuncts below still run, and the
      // input hash is the one that matters for a branch — it refuses a tree
      // whose scripts or lockfile moved away from what the proof was taken
      // against. `readPortableFile` guarantees `null` means ABSENT and never
      // UNREADABLE (Codex #8), so nothing unreadable reaches this path.
      if (rawFile !== null) {
        if (!parsedFile) {
          return this.drifted(projectId, modality, 'content-drifted', 'portable file no longer parses');
        }
        const freshHash = runbookPortableHash(parsedFile);
        if (freshHash !== row.portable_hash) {
          return this.drifted(projectId, modality, 'content-drifted', 'portable runbook hash drift');
        }
      }

      const freshInputHash = await this.deps.computeInputHash(probePath);
      if (freshInputHash === null) {
        // Could not observe the inputs — not evidence that they changed.
        this.deps.logger?.warn('[VerifyRunbookStore] input hash unavailable (fail-soft)', {
          projectId,
          modality,
          probePath,
        });
        return { status: 'absent', reason: 'indeterminate' };
      }
      if (freshInputHash !== row.input_hash) {
        return this.drifted(projectId, modality, 'drifted', 'project input hash drift');
      }

      const freshFingerprint = await this.deps.hostFingerprint();
      if (freshFingerprint !== row.host_fingerprint_json) {
        return this.drifted(projectId, modality, 'drifted', 'host fingerprint drift');
      }

      return { status: 'proven', reason: 'proven' };
    } catch (err) {
      // The single fail-soft answer for everything this method could not
      // observe: a pre-096 DB, a SQL error, and — since F10/Codex #8 — a
      // `readPortableFile` that REJECTED. That last one is the load-bearing
      // arm: an unreadable file must land HERE, not on the record-authoritative
      // path an absent file takes, so 'absent'/'indeterminate' is both non-'proven'
      // and non-writing. The gate skips; nothing is destroyed.
      this.deps.logger?.warn('[VerifyRunbookStore] status failed (fail-soft)', {
        projectId,
        modality,
        probePath,
        error: err instanceof Error ? err.message : String(err),
      });
      return { status: 'absent', reason: 'indeterminate' };
    }
  }

  /**
   * Persist a DERIVED revision (§5's "derive → … → persist"): read the portable
   * half from `worktreePath`, validate it, hash it, and UPSERT the (project,
   * modality) record as `'unproven-draft'` at `version + 1`, stamping the
   * caller's `bindingsJson` plus a fresh input-hash and host fingerprint as the
   * baseline the drift checks will later compare against.
   *
   * ALWAYS `'unproven-draft'`, even when re-registering over a proven record:
   * new portable content is by definition unproven content. The version bump is
   * what makes a mid-flight pin (§5.2 seam 3) fail its CAS check rather than
   * silently execute against a revision that was swapped underneath it — and
   * the CAS predicate on the UPDATE means two concurrent registrations cannot
   * both believe they won.
   *
   * Errors are RETURNED, not thrown — the setup flow surfaces them to the human
   * inline (a missing/malformed runbook is a normal wizard state, not a crash).
   */
  async registerDraft(
    projectId: number,
    worktreePath: string,
    modality: VerificationModality,
    bindingsJson?: string,
  ): Promise<{ hash: string; version: number } | { error: string; kind?: 'unisolated-command' }> {
    try {
      const raw = await this.deps.readPortableFile(worktreePath);
      if (raw === null) {
        return { error: `no portable runbook found under ${worktreePath}` };
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(raw);
      } catch (err) {
        return { error: `portable runbook is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
      }
      const parsed = parseVerifyRunbookV1(decoded);
      if (!parsed.ok) return { error: `portable runbook is invalid — ${parsed.error}` };

      // Registering a modality the runbook never declared would persist a
      // record no execution path could ever satisfy.
      if (!this.declaresModality(parsed.runbook, modality)) {
        return { error: `portable runbook declares no "${modality}" modality` };
      }

      // §7.2 mobile isolation, enforced HERE regardless of which modality was
      // asked for: `parsed.runbook` — the WHOLE portable file, every declared
      // modality — is what gets persisted as `portable_json` under every
      // (project, modality) row this file registers, so a mobile entry riding
      // along on a `web` registration must be checked exactly as if it were
      // registered directly, or it would reach the runner unvetted.
      const mobileEntry = parsed.runbook.modalities.mobile;
      if (mobileEntry) {
        const violation = checkMobileBuildIsolation(mobileEntry, parsed.runbook.levers);
        if (violation) return { error: violation, kind: 'unisolated-command' };
      }

      const hash = runbookPortableHash(parsed.runbook);
      const portableJson = JSON.stringify(parsed.runbook);
      const inputHash = await this.deps.computeInputHash(worktreePath);
      const fingerprint = await this.deps.hostFingerprint();
      const now = new Date().toISOString();

      const txn = this.db.transaction(() => {
        const current = this.readRow(projectId, modality);
        const currentVersion = current?.version ?? 0;
        const nextVersion = currentVersion + 1;

        const result = this.db
          .prepare(
            `INSERT INTO verify_runbook_local
               (project_id, modality, portable_hash, portable_json, version, status,
                bindings_json, proof_json, input_hash, host_fingerprint_json, updated_at)
             VALUES (?, ?, ?, ?, ?, 'unproven-draft', ?, NULL, ?, ?, ?)
             ON CONFLICT(project_id, modality) DO UPDATE SET
               portable_hash = excluded.portable_hash,
               portable_json = excluded.portable_json,
               version = excluded.version,
               status = 'unproven-draft',
               bindings_json = excluded.bindings_json,
               proof_json = NULL,
               input_hash = excluded.input_hash,
               host_fingerprint_json = excluded.host_fingerprint_json,
               updated_at = excluded.updated_at
             WHERE verify_runbook_local.version = ?`,
          )
          .run(
            projectId,
            modality,
            hash,
            portableJson,
            nextVersion,
            bindingsJson ?? null,
            inputHash,
            fingerprint,
            now,
            currentVersion,
          );
        return result.changes > 0 ? nextVersion : null;
      });
      const version = (txn as () => number | null)();
      if (version === null) {
        return { error: 'cas-conflict' };
      }
      return { hash, version };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.logger?.warn('[VerifyRunbookStore] registerDraft failed (fail-soft)', {
        projectId,
        modality,
        worktreePath,
        error: message,
      });
      return { error: message };
    }
  }

  /**
   * The ENGINE-DRIVEN proof flip (§5.3) — the only transition into `'proven'`,
   * and deliberately not something the setup agent can perform by asserting it.
   * The caller reaches here having actually stood the deliverable up and
   * captured it through the real verification path, in the VERIFIER's
   * environment class (detached snapshot + prepared deps — "a proof obtained in
   * environment X asserted about environment Y is not a proof"), and passes the
   * assembled provenance as `proofJson`.
   *
   * Double CAS: the UPDATE matches on BOTH `portable_hash` and `version`, so a
   * proof can only land on the exact record revision the proof run executed. A
   * concurrent `registerDraft` between the run and this call bumps the version
   * and the flip is rejected — the proof attests to content that is no longer
   * what the record holds.
   *
   * `fresh` RE-STAMPS THE PROVENANCE THE DRIFT CHECK COMPARES AGAINST (F4 /
   * Codex #1). The stored `input_hash` / `host_fingerprint_json` were written by
   * `registerDraft`, over whatever tree and host happened to be current when the
   * DRAFT was written — which for the setup flow is a flow worktree, and for a
   * record that has been sitting a while is a host that has since taken an
   * Electron or playwright bump. The proof, by contrast, was just obtained HERE,
   * so the caller passes what it observed at promotion time and the record
   * starts describing the thing that was actually proven. Omit it and the flip
   * is status-only, exactly as before.
   *
   * NEVER `portable_hash` (Codex #1, explicitly rejected in §3 of the fix set):
   * that column is the CONTENT ADDRESS of `portable_json` and the target of every
   * pin, the snapshot the proof executed in is already disposed by the time this
   * runs, and re-stamping it would silently re-point live pins at content they
   * never attested to. Both CAS predicates stay, for the same reason.
   *
   * AND NEVER A NULL `input_hash` OVER A STORED ONE (F4 fix round). The re-stamp
   * is FIELD-BY-FIELD because `fresh.inputHash` carries a third state that
   * `hostFingerprint` does not: `null` means "could not observe this tree" (the
   * probe path was cleaned up, a manifest was momentarily unreadable), not "the
   * inputs are empty". Writing it would be self-destroying — `statusDetail`
   * counts a stored NULL against a freshly computed value as a DIFFERENCE, so
   * the promotion this method exists to record would drift on the very next
   * read. An unobservable input hash therefore leaves the stored one alone,
   * exactly as the caller's own fallback does for a probe that THREW, while a
   * fingerprint that was observed is still re-stamped. The consequence is the
   * pre-F4 one for that column — a possibly stale baseline, which costs at worst
   * a re-prove — instead of a guaranteed drift.
   *
   * Synchronous (no injected IO on this path — the caller does its own probing
   * and hands the values in), and the one method whose failure is REPORTED
   * rather than swallowed: silently declining to record a proof would strand the
   * wizard in a loop that can never exit.
   */
  markProven(
    projectId: number,
    modality: VerificationModality,
    hash: string,
    expectedVersion: number,
    proofJson: string,
    fresh?: { inputHash: string | null; hostFingerprint: string },
  ): { ok: true } | { ok: false; error: 'cas-conflict' | 'hash-mismatch' | 'not-found' | string } {
    try {
      const now = new Date().toISOString();
      // Assembled rather than branched two ways because the re-stamp is
      // field-by-field (see the `fresh` notes above): status + proof always,
      // the host fingerprint whenever one was observed, the input hash only
      // when it was actually computable. The WHERE clause — both CAS
      // predicates — is identical in every shape.
      const sets: string[] = ["status = 'proven'", 'proof_json = ?'];
      const params: unknown[] = [proofJson];
      if (fresh) {
        if (fresh.inputHash !== null) {
          sets.push('input_hash = ?');
          params.push(fresh.inputHash);
        } else {
          this.deps.logger?.debug(
            '[VerifyRunbookStore] promotion could not observe the project inputs; keeping the stored input_hash',
            { projectId, modality, hash },
          );
        }
        sets.push('host_fingerprint_json = ?');
        params.push(fresh.hostFingerprint);
      }
      sets.push('updated_at = ?');
      params.push(now);
      const result = this.db
        .prepare(
          `UPDATE verify_runbook_local
               SET ${sets.join(', ')}
               WHERE project_id = ? AND modality = ? AND portable_hash = ? AND version = ?`,
        )
        .run(...params, projectId, modality, hash, expectedVersion);
      if (result.changes > 0) return { ok: true };

      // Nothing matched — say WHICH predicate failed, so the caller can decide
      // between re-registering (content moved) and re-proving (version moved).
      const row = this.readRow(projectId, modality);
      if (!row) return { ok: false, error: 'not-found' };
      if (row.portable_hash !== hash) return { ok: false, error: 'hash-mismatch' };
      return { ok: false, error: 'cas-conflict' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.logger?.warn('[VerifyRunbookStore] markProven failed (fail-soft)', {
        projectId,
        modality,
        hash,
        error: message,
      });
      return { ok: false, error: message };
    }
  }

  /**
   * The two drift-check inputs, observed RIGHT NOW over `probePath` — what a
   * caller hands to {@link VerifyRunbookStore.markProven} as `fresh` (F4).
   *
   * It exists here rather than at the call site so the promotion re-stamps the
   * values through the SAME injected deps the drift check will later compare
   * against. A second implementation of either probe would produce a proof that
   * either never expires or expires immediately — the identical trap the
   * bootstrap's §10 suppression avoids by keying on these same two probes.
   *
   * NOT fail-soft: `computeInputHash` already reports "could not observe" as
   * `null`, which is passed through verbatim and which
   * {@link VerifyRunbookStore.markProven} then declines to WRITE over a stored
   * value (F4 fix round — a stored NULL reads as a difference against any
   * computed value, so stamping one would make the promotion drift on its own
   * next read). A `hostFingerprint` that REJECTS has no such third state and no
   * safe stand-in, so the rejection propagates and the caller decides: the
   * scheduler's promotion path catches it and falls back to a status-only flip
   * rather than losing the proof.
   */
  async freshProvenance(probePath: string): Promise<{ inputHash: string | null; hostFingerprint: string }> {
    const inputHash = await this.deps.computeInputHash(probePath);
    const hostFingerprint = await this.deps.hostFingerprint();
    return { inputHash, hostFingerprint };
  }

  /**
   * Stamp migration 105's `origin` on a record — WHO derived it.
   *
   * WHY THIS IS NOT COSMETIC. Two things can produce a proven runbook: the
   * Verify Setup flow, where a human sees the proposal and every repo change it
   * wants before anything is touched, and the lane bootstrap
   * (docs/proposals/lane-runbook-bootstrap.md), where an agent derives one
   * mid-sprint and the engine proves it with nobody watching. Both are proven by
   * the same engine-enforced run and they did NOT earn the same amount of trust.
   * Collapsing them would erase the only durable record of which happened, and a
   * human deciding whether to keep a machine-authored runbook has no other way to
   * find out.
   *
   * Deliberately NOT a parameter of {@link VerifyRunbookStore.registerDraft}:
   * that method's UPSERT is the CAS'd content write and adding a column to it
   * would mean a pre-105 DB losing the REGISTRATION rather than just the
   * provenance. Here, a pre-105 DB fails soft and loses only the badge.
   *
   * Never throws — a provenance stamp that failed must not undo a registration
   * that succeeded.
   */
  setOrigin(projectId: number, modality: VerificationModality, origin: string): void {
    try {
      this.db
        .prepare('UPDATE verify_runbook_local SET origin = ? WHERE project_id = ? AND modality = ?')
        .run(origin, projectId, modality);
    } catch (err) {
      this.deps.logger?.debug('[VerifyRunbookStore] origin stamp failed (fail-soft)', {
        projectId,
        modality,
        origin,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Content-addressed fetch for the runner's §5.2 seam-3 pin validation: given
   * the `runbook_hash` + `runbook_local_version` stamped on the request row at
   * enqueue, resolve the EXACT revision to execute.
   *
   * This is why `portable_json` is stored verbatim rather than just its hash —
   * the snapshot the runner executes in may predate the runbook file entirely,
   * so the content has to come from here. A miss (`null`) is not a lookup
   * failure to retry; it is the mismatch condition itself, and the runner's
   * response is a structured "runbook/sha mismatch" rejection (env-class,
   * non-attempt-charging), never an improvisation against live state.
   *
   * Returns the record's CURRENT `version`/`status`; the runner compares them
   * against its pin rather than this method pre-judging (a record that drifted
   * to `'unproven-draft'` between enqueue and execution is exactly the case the
   * pin exists to catch, and the runner needs to see it to report it).
   */
  getByHash(
    projectId: number,
    modality: VerificationModality,
    hash: string,
  ): PinnedRunbookRecord | null {
    try {
      const row = this.db
        .prepare(
          `SELECT portable_hash, portable_json, version, status, bindings_json, proof_json,
                  input_hash, host_fingerprint_json
           FROM verify_runbook_local
           WHERE project_id = ? AND modality = ? AND portable_hash = ?`,
        )
        .get(projectId, modality, hash) as RunbookLocalRow | undefined;
      if (!row) return null;
      if (!isPersistedStatus(row.status)) return null;

      const parsed = this.parsePortable(row.portable_json, `db:${projectId}/${modality}`);
      if (!parsed) return null;
      return { runbook: parsed, version: row.version, status: row.status };
    } catch (err) {
      this.deps.logger?.warn('[VerifyRunbookStore] getByHash failed (fail-soft)', {
        projectId,
        modality,
        hash,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * The (project, modality) record as it stands RIGHT NOW, hash included — the
   * enqueue-side companion to {@link VerifyRunbookStore.getByHash}.
   *
   * §5.2 seam 3 is content-addressed in BOTH directions and the two directions
   * need different lookups. At EXECUTION the runner already holds a hash and
   * asks "resolve exactly this revision" (`getByHash`). At ENQUEUE nobody holds
   * a hash yet: the seam has just been told by {@link VerifyRunbookStore.status}
   * that this (project, modality) is `'proven'`, and it needs the revision that
   * verdict was about — its content to merge into the composed task, and its
   * hash + version to STAMP on the request row as the pin. Re-deriving the hash
   * by re-reading and re-hashing the probe path's file would be a second,
   * separately-racing answer; reading it off the record is the same answer
   * `status()` just validated the file against.
   *
   * Returns `null` for no record, an unrecognized `status`, or unparseable
   * stored content — the same fail-soft posture as `getByHash`, and with the
   * same consequence at the call site: no pin, no injection, and the §3.2
   * degrade gate handles it honestly rather than a half-applied runbook
   * executing.
   */
  getCurrent(
    projectId: number,
    modality: VerificationModality,
  ): (PinnedRunbookRecord & { hash: string }) | null {
    try {
      const row = this.readRow(projectId, modality);
      if (!row) return null;
      if (!isPersistedStatus(row.status)) return null;
      const parsed = this.parsePortable(row.portable_json, `db:${projectId}/${modality}`);
      if (!parsed) return null;
      return { runbook: parsed, version: row.version, status: row.status, hash: row.portable_hash };
    } catch (err) {
      this.deps.logger?.warn('[VerifyRunbookStore] getCurrent failed (fail-soft)', {
        projectId,
        modality,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Read the (project, modality) record, or `undefined` when absent. NOT
   * fail-soft on its own — callers wrap it, so a genuine SQL error (a pre-096
   * DB) surfaces to the caller's single catch and its single degraded answer,
   * rather than being confused with "no such record".
   */
  private readRow(projectId: number, modality: VerificationModality): RunbookLocalRow | undefined {
    return this.db
      .prepare(
        `SELECT portable_hash, portable_json, version, status, bindings_json, proof_json,
                input_hash, host_fingerprint_json
         FROM verify_runbook_local
         WHERE project_id = ? AND modality = ?`,
      )
      .get(projectId, modality) as RunbookLocalRow | undefined;
  }

  /** Parse + validate portable-half text; `null` (with a warn) on malformed content. */
  private parsePortable(raw: string, source: string): VerifyRunbookV1 | null {
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch (err) {
      this.deps.logger?.warn('[VerifyRunbookStore] portable runbook is not valid JSON', {
        source,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    const parsed = parseVerifyRunbookV1(decoded);
    if (!parsed.ok) {
      this.deps.logger?.warn('[VerifyRunbookStore] portable runbook failed validation', {
        source,
        error: parsed.error,
      });
      return null;
    }
    return parsed.runbook;
  }

  /**
   * Whether the parsed portable half declares an entry for this modality. The
   * cast is safe by construction: `parseVerifyRunbookV1` only ever populates
   * keys from {@link VERIFY_RUNBOOK_MODALITIES}, which today equals the full
   * {@link VerificationModality} union (`'mobile'` included, no longer
   * deferred) — the cast exists so a FUTURE `VerificationModality` member
   * added ahead of this file's declarable set would simply miss here rather
   * than throw.
   */
  private declaresModality(runbook: VerifyRunbookV1, modality: VerificationModality): boolean {
    return runbook.modalities[modality as VerifyRunbookModality] !== undefined;
  }

  /**
   * COMPUTE-AND-RETURN drift (F4 —
   * docs/proposals/visual-verification-brittleness-fixes.md). One conjunct of
   * the proof no longer holds for this read, so this read answers
   * `'unproven-draft'`/`'drifted'` — and writes NOTHING.
   *
   * THIS USED TO BE A WRITE-THROUGH DEMOTION (`UPDATE … status =
   * 'unproven-draft', proof_json = NULL`), and that write was the single
   * highest-blast-radius defect in the whole feature (RC2): the drift conjuncts
   * fold in lockfile bytes, `process.versions.modules` and `app.getPath('exe')`,
   * so an ordinary dependency bump, an app release, or a stable↔dev switch
   * destroyed a hard-won proof — and merely OPENING the Project Overview
   * (`verificationRequests.ts` → `effectiveRunbookStatus`) was enough to trigger
   * it. Recovery cost a full re-derive of a human-authored runbook.
   *
   * Nothing is lost by not writing: the gate and the badge both recompute this
   * conjunction on every read, so the honest answer reaches every reader anyway
   * (class doc, DRIFT IS COMPUTED ON EVERY READ). What IS deliberately kept is
   * `input_hash`/`host_fingerprint_json` — the record of what the proof was
   * taken against, which is what makes a drift diagnosable and what a re-prove
   * re-stamps (see {@link VerifyRunbookStore.markProven}'s `fresh`).
   *
   * Kept at `warn` with the same fields it always logged, so the existing log
   * grep for a vanishing proof still finds the moment it stopped holding.
   *
   * `answer` says WHICH drift, and it is not cosmetic (F4 fix round): a
   * `'drifted'` provenance mismatch is cleared by re-proving the record, while a
   * `'content-drifted'` tree carries a runbook the record does not hold and can
   * ONLY be cleared by re-registering it — promotion never re-stamps
   * `portable_hash`, so re-proving a content drift would pass and then read as
   * drifted again on the very next check. `bootstrapEligibility` routes the two
   * to different answers on the strength of this discriminant; the GATE still
   * treats them identically, and both still refuse.
   */
  private drifted(
    projectId: number,
    modality: VerificationModality,
    answer: 'drifted' | 'content-drifted',
    reason: string,
  ): VerifyRunbookStatusDetail {
    this.deps.logger?.warn('[VerifyRunbookStore] proven runbook reads as drifted (record left intact)', {
      projectId,
      modality,
      answer,
      reason,
    });
    return { status: 'unproven-draft', reason: answer };
  }
}
