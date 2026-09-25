/**
 * verificationPosture — the RUN-LEVEL "can anything here be verified at all?"
 * question, answered ONCE per run instead of rediscovered once per lane.
 *
 * WHY THIS EXISTS. Until now the only answer to "no modality can serve this
 * project" was per-lane: each lane composed a verification task, each lane's
 * enqueue (or its gate) declined, and each lane filed its own
 * `Visual verification did not run for TASK-0NN` finding. A sixteen-lane sprint
 * on a project whose stamped type is the deferred mobile one produced sixteen
 * identical cards saying the same structural fact, and the reasons that WERE
 * per-lane got buried under them.
 *
 * The posture is resolved EAGERLY, at fan-out start, before a single lane is
 * dispatched. The lazy alternative — flip a latch when the first lane's enqueue
 * declines — reaches almost nobody under a rolling dispatch pool: that lane has
 * already run `implement` and `task-verify`, and the pool keeps a cap-sized set
 * of lanes permanently past the point where the latch could have helped them.
 *
 * THREE POSTURES, and the split between the first two is load-bearing:
 *   - `disabled`    — `verify_enabled = 0`. The user switched the visual
 *                     verifier OFF. Byte-identical to today: no finding is
 *                     filed, nothing about the lanes changes. Folding this into
 *                     `unavailable` would file exactly the finding the enqueue
 *                     seam was changed to stop filing.
 *   - `unavailable` — verification is ON, but no modality can serve this run.
 *                     One finding for the whole run; the per-lane findings are
 *                     suppressed; no lane enqueues.
 *   - `available`   — unchanged behaviour in every respect.
 *
 * FAIL-OPEN. Every read here is defensive and every unreadable answer resolves
 * `available`, which is precisely "behave as the controller did before this
 * module existed". A posture resolver that guessed `unavailable` would silence
 * real per-lane findings on a healthy project.
 *
 * Standalone-friendly by construction: this module imports NOTHING at runtime
 * beyond the pure decline classifier and the pure kill-switch predicate. The run stamp and the runbook status both
 * arrive as injected thunks, so the runbook query is the SAME closure the
 * scheduler's §3.2 degrade gate consults (index.ts builds it once for both) and
 * is never duplicated here.
 */
import { requireProvenRunbookEngaged } from '../../../../shared/types/visualVerification';
import type { VerificationModality, VerificationType } from '../../../../shared/types/visualVerification';
import type { VerificationPosture } from '../programmatic/types';
import type { VerifyRunbookStatusDetail } from './runbookStore';
import { declineForRunbookStatus } from './bootstrapEligibility';

export type { VerificationPosture };

/**
 * The run facts the posture is decided from — the immutable stamp migration 055
 * writes at `WorkflowRegistry.createRun`, plus the tree the runbook probe should
 * look at.
 *
 * `worktreePath` is the RUN's worktree when it has one (the tree whose commands
 * would actually execute, and the tree the §3.2 gate probes), `null` otherwise —
 * the status thunk then falls back to the project root, which is the same ladder
 * the gate uses.
 */
export interface VerificationRunStamp {
  projectId: number;
  verifyEnabled: boolean;
  /** The stamped `verify_type`, or null when the run was never stamped. */
  verifyType: VerificationType | null;
  worktreePath: string | null;
}

/** Injected reads. Both MUST be fail-soft — a throw is caught and read as `available`. */
export interface VerificationPostureDeps {
  /** The run's immutable verification stamp, or null when the row is unreadable. */
  readRunStamp(runId: string): VerificationRunStamp | null;
  /**
   * The SAME runbook-status resolver the scheduler's `runbookStatus` dependency
   * and the health panel's badge share (index.ts assigns one closure to both) —
   * injected rather than re-implemented so a third reading of
   * `verify_runbook_local.status` cannot disagree with the other two.
   *
   * Resolves `null` when the resolver is not up yet (the composition root's
   * holder is late-bound). `null` means UNKNOWN, not 'absent': a probe that never
   * ran is not evidence that a project has no runbook, and reading it as one
   * would declare a healthy native-desktop project unverifiable on a race.
   */
  runbookStatus(
    projectId: number,
    modality: VerificationModality,
    probePath?: string,
  ): Promise<VerifyRunbookStatusDetail | null>;
  /**
   * The LIVE visual-verify config, read once per posture — the same read the
   * agent engine's gate 3 makes (`liveConfig()`, never a boot snapshot, F12), so
   * the run-level answer and the per-request mode cannot disagree about the
   * runbook-optional kill switch (runbook-optional-verification.md §A6).
   *
   * Absent, or throwing, ⇒ only the env override is consulted
   * (`CYBOFLOW_VERIFY_REQUIRE_RUNBOOK=1`); the config default is OFF, i.e.
   * explore on — the same answer the engine reaches with its default config.
   */
  liveConfig?(): { requireProvenRunbook?: boolean };
}

/**
 * WHY a posture came back `unavailable`, as a stable machine token rather than
 * as prose (mobile-verification-tier M6).
 *
 * The reasons are written for a human and get reworded; the code does not. Every
 * consumer that has to DECIDE something — chiefly
 * {@link isNoModalityDeclineReason}, which collapses a run's per-lane findings —
 * keys on this, so a copy edit can no longer quietly turn a run-level fact back
 * into sixteen identical cards. The reasons still CONTAIN the legacy substrings
 * as belt and braces for the callers that only ever see a string.
 */
export type VerificationDeclineCode =
  | 'unsupported-modality'
  | 'no-verification-runbook'
  | 'modality-deferred';

/**
 * The posture, widened with the decline code. Assignable to the shared
 * {@link VerificationPosture} (the code is an ADDITIONAL member), so every
 * existing consumer — workflowController's map, the controller host — keeps
 * compiling and keeps reading `reason` exactly as before.
 */
export type VerificationPostureResult =
  | { kind: 'disabled' }
  | { kind: 'available' }
  | { kind: 'unavailable'; reason: string; declineCode: VerificationDeclineCode };

/**
 * Human-readable phrasing for a runbook state that cannot serve a request.
 *
 * Deliberately NOT the scheduler's `skipReasonForRunbookDecline` strings: those
 * are a REQUEST's persisted `error_message`, reverse-mapped by verdictDelivery,
 * and borrowing them here would make a run-level declaration
 * indistinguishable from a per-request skip to that reverse map. The
 * CLASSIFICATION is shared (`declineForRunbookStatus`, the same function the
 * bootstrap preflight and the gate both decline by); only the sentence differs.
 */
function nativeRunbookReason(status: VerifyRunbookStatusDetail): string {
  switch (declineForRunbookStatus(status)) {
    case 'proof-belongs-elsewhere':
      return 'this run is stamped `native-desktop`, and the project\'s native-screen runbook is proven elsewhere but its portable file is absent from this tree — merge the branch that carries it';
    case 'stale-proof':
      return 'this run is stamped `native-desktop`, and the project\'s native-screen runbook has drifted — it needs to be re-proven before any lane can be verified';
    case 'unobservable':
      return 'this run is stamped `native-desktop`, and the project\'s native-screen runbook could not be read';
    default:
      return 'this run is stamped `native-desktop`, and the project has no proven native-screen runbook — run verification setup';
  }
}

/**
 * The mobile mirror of {@link nativeRunbookReason}.
 *
 * EVERY sentence here contains the literal "verification runbook", because the
 * legacy string arm of {@link isNoModalityDeclineReason} matches on exactly that
 * substring and a mobile decline must keep collapsing per-lane findings for a
 * caller that never sees the code.
 */
function mobileRunbookReason(status: VerifyRunbookStatusDetail): string {
  switch (declineForRunbookStatus(status)) {
    case 'proof-belongs-elsewhere':
      return 'this run is stamped `mobile-flow`, and the project\'s mobile verification runbook is proven elsewhere but its portable file is absent from this tree — merge the branch that carries it';
    case 'stale-proof':
      return 'this run is stamped `mobile-flow`, and the project\'s mobile verification runbook has drifted — it needs to be re-proven before any lane can be verified';
    case 'unobservable':
      return 'this run is stamped `mobile-flow`, and the project\'s mobile verification runbook could not be read';
    default:
      return 'this run is stamped `mobile-flow`, and the project has no proven mobile verification runbook — run verification setup';
  }
}

/**
 * Does an enqueue-seam decline reason say "no modality can serve this run" (as
 * opposed to a per-lane accident)?
 *
 * This is a TEXT match, for the same reason `VERIFY_DISABLED_ENQUEUE_REASON` is
 * duplicated as a literal in workflowController.ts: the strings are produced in
 * verify/verificationScheduler.ts and verify/enqueueFromTask.ts, and importing
 * them here would drag those modules' DB-shaped import graphs into the posture
 * path. If one is ever reworded, the cost is that a mid-flight flip stops
 * collapsing per-lane findings — one extra card per lane, never a wedged run.
 */
export function isNoModalityDeclineReason(
  decline: string | { reason: string; declineCode?: VerificationDeclineCode },
): boolean {
  // A decline that carries a CODE is answered by the code alone (M6): the code is
  // the stable token, and falling through to the substrings for a coded decline
  // would reinstate exactly the brittleness the code exists to remove.
  if (typeof decline !== 'string') {
    if (decline.declineCode !== undefined) return true;
    return isNoModalityDeclineReason(decline.reason);
  }
  const text = decline.toLowerCase();
  return (
    text.includes('unsupported modality') ||
    text.includes('verification runbook') ||
    text.includes('modality is deferred')
  );
}

/**
 * The runbook-optional kill switch as the posture sees it — the live config when
 * wired, the env override always. A config read that throws is read as "switch
 * off" (the env still binds): the posture fails OPEN, and `available` is what an
 * exploring mobile run resolves to anyway.
 */
function killSwitchEngaged(deps: VerificationPostureDeps): boolean {
  let config: { requireProvenRunbook?: boolean } = {};
  try {
    config = deps.liveConfig?.() ?? {};
  } catch {
    config = {};
  }
  return requireProvenRunbookEngaged(config);
}

/**
 * Resolve the run's verification posture. Never rejects.
 *
 * Ladder, in order:
 *   1. the stamp is unreadable            → `available` (fail-open: behave as before)
 *   2. `verify_enabled = 0`               → `disabled`  (today's behaviour verbatim)
 *   3. stamped type `mobile-flow` AND
 *      the kill switch is ENGAGED AND
 *      no PROVEN mobile runbook           → `unavailable` (switch off: mobile
 *                                           explores, so → `available` — §A6)
 *   4. stamped type `native-desktop` AND
 *      no PROVEN native-screen runbook    → `unavailable` (classified by the
 *                                           SAME decline function the gate uses)
 *   5. otherwise                          → `available`
 *
 * Rung 3 used to be an unconditional short-circuit — the mobile modality was
 * deferred, so no runbook could have made it work. The iOS-Simulator tier ended
 * that, and the rung is now the structural twin of rung 4 in every respect:
 * same probe, same classifier, same fail-open. Under the runbook-optional
 * contract (runbook-optional-verification.md §A6) it only binds with the kill
 * switch engaged: otherwise a mobile lane with no pin EXPLORES on a fresh leased
 * simulator, and declaring the run unverifiable for want of a runbook would
 * suppress exactly the lanes that can now run. Rung 4 stays, switch or no
 * switch: native-screen is pinned-only.
 *
 * No `web` / `cdp-app` runbook probe here on purpose. Those modalities are
 * resolved per REQUEST (the composed task's `serve.attach` picks between them)
 * and their runbook can be BOOTSTRAPPED mid-run by the first lane that needs it,
 * so a run-level "no runbook yet" verdict for them would declare unverifiable a
 * project that is one bootstrap away from verifying fine. Only the two
 * modalities that can never be bootstrapped into existence are decided here.
 */
export async function resolveVerificationPosture(
  deps: VerificationPostureDeps,
  runId: string,
): Promise<VerificationPostureResult> {
  let stamp: VerificationRunStamp | null = null;
  try {
    stamp = deps.readRunStamp(runId);
  } catch {
    return { kind: 'available' };
  }
  if (stamp === null) return { kind: 'available' };
  if (!stamp.verifyEnabled) return { kind: 'disabled' };
  const probe =
    stamp.verifyType === 'mobile-flow'
      ? ({ modality: 'mobile', reasonFor: mobileRunbookReason } as const)
      : stamp.verifyType === 'native-desktop'
        ? ({ modality: 'native-screen', reasonFor: nativeRunbookReason } as const)
        : null;
  // §A6 — with explore on (the kill switch NOT engaged), a mobile request with
  // no proven runbook explores rather than skips (gate 3, `isExploreEligible`:
  // mobile always), so runbook absence no longer makes a mobile-flow run
  // unverifiable and the probe is not even read. native-desktop is untouched:
  // native-screen is pinned-only, so its runbook still decides. Read only for a
  // mobile-flow run — every other stamp's answer does not depend on it.
  if (probe?.modality === 'mobile' && !killSwitchEngaged(deps)) return { kind: 'available' };
  if (probe !== null) {
    let status: VerifyRunbookStatusDetail | null;
    try {
      status = await deps.runbookStatus(
        stamp.projectId,
        probe.modality,
        stamp.worktreePath ?? undefined,
      );
    } catch {
      // An unreadable probe is not evidence of an unverifiable project.
      return { kind: 'available' };
    }
    // Same reasoning for an unwired resolver as for a throwing one.
    if (status === null) return { kind: 'available' };
    if (status.status === 'proven') return { kind: 'available' };
    return {
      kind: 'unavailable',
      reason: probe.reasonFor(status),
      declineCode: 'no-verification-runbook',
    };
  }
  return { kind: 'available' };
}
