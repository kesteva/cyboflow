/**
 * The ONE decision behind "should this project's runbook be bootstrapped for
 * this request?" — and the ONE definition of "this task derives an environment"
 * that both the §3.2 degrade gate and the bootstrap preflight must agree on
 * (docs/proposals/lane-runbook-bootstrap.md §4, §12 step 1, §13 phase 2).
 *
 * WHY THIS IS A MODULE AND NOT TWO INLINE `if`s. There are two seams that ask
 * overlapping questions about the same request, at different moments:
 *
 *   - the PREFLIGHT, in `enqueueTaskVerification`, BEFORE a row exists: "is this
 *     a request that would be skipped for want of a runbook, on a project where
 *     deriving one is safe?";
 *   - the GATE, in `evaluateAgentGates`, AFTER the row is leased: "should this
 *     request run, and if not, what do I tell the human?".
 *
 * If they compute `derivesEnvironment` differently by even one clause, the
 * feature silently misfires in both directions: a preflight that is stricter
 * than the gate bootstraps nothing while the gate keeps skipping, and a
 * preflight that is looser spends an agent and a deployment on requests the gate
 * would have let through anyway. The same is true of the runbook-status reading:
 * two seams that disagree about which situations are safe to write over is
 * precisely how `registerDraft`'s singleton row gets clobbered (§4).
 *
 * NOTHING HERE TOUCHES IO OR STATE. Every export is a pure function of values
 * the callers already hold, which is what lets the gate call it while holding a
 * lease and the preflight call it before anything exists.
 */
import type { VerificationModality, VerificationTaskV1 } from '../../../../shared/types/visualVerification';
import type { VerifyRunbookStatusDetail, VerifyRunbookStatusReason } from './runbookStore';

/**
 * Does this task need an ENVIRONMENT derived for it — something built, or
 * something served — as opposed to a degenerate task that merely points a driver
 * at an already-live URL?
 *
 * This is the §3.2 predicate verbatim, extracted so the gate and the preflight
 * cannot drift. The asymmetry between the two clauses is deliberate and load
 * bearing: `build` must be a NON-EMPTY array (a composed `build: []` derives
 * nothing and must not gate), while `serve` counts by mere PRESENCE (there is no
 * empty serve — the object itself is the command).
 */
export function taskDerivesEnvironment(task: Pick<VerificationTaskV1, 'build' | 'serve'>): boolean {
  return (Array.isArray(task.build) && task.build.length > 0) || task.serve !== undefined;
}

/**
 * Why a bootstrap declined. Each maps to a DIFFERENT remedy, which is the whole
 * reason this is not a boolean — a human told "run verification setup" when the
 * real fix is "merge the branch carrying the runbook" will do the wrong thing
 * and conclude the feature is broken.
 */
export type BootstrapDeclineReason =
  /** The toggle is off, or the kill switch is set. Nothing to explain. */
  | 'disabled'
  /** A degenerate task: it derives no environment, so the gate lets it through. */
  | 'no-environment'
  /** Already proven for the probed tree. The ordinary path applies. */
  | 'already-proven'
  /**
   * A record is PROVEN and this tree simply lacks the portable file — §4's
   * pre-merge case. Deriving here would UPSERT over the singleton record every
   * other branch depends on, so the answer is never "bootstrap", it is "merge".
   */
  | 'proof-belongs-elsewhere'
  /**
   * A proven record just drifted (inputs, host, or content moved). Its runbook
   * is presumably still correct and human-authored; what it needs is to be
   * re-PROVEN, not re-DERIVED, and re-deriving would throw away a working one.
   *
   * ONE of the two drifts is no longer a bootstrap decline (F4 / Codex #2, then
   * narrowed in the F4 fix round). This stays what
   * {@link declineForRunbookStatus} answers for BOTH — the GATE needs it,
   * because a drifted record is exactly as unusable to a request as a missing
   * one whichever conjunct failed, and the skip it writes has to name the real
   * situation. What {@link decideRunbookBootstrap} does with it now depends on
   * WHICH drift the store computed:
   *
   *  - `'drifted'` (PROVENANCE — the project inputs or the host moved) becomes
   *    `{ proceed: true, mode: 'reprove' }`. With drift non-writing (F4 stage 1,
   *    `runbookStore.drifted`) the record answers `'drifted'` on EVERY read
   *    forever, so declining would strand the project — it could never verify
   *    again — and the pre-F4 write-through demotion that used to un-strand it
   *    did so by making the next read say `'draft'` and re-DERIVING over a
   *    human-authored runbook, which lane-runbook-bootstrap.md §4 says is the
   *    wrong answer. Re-proving re-stamps exactly the two columns that moved.
   *  - `'content-drifted'` (this tree's portable file is not the record's
   *    content) stays a DECLINE. A re-prove cannot clear it: promotion never
   *    re-stamps `portable_hash` (Codex #1), so the proof would pass, the next
   *    read would compute the same mismatch, `confirmProven` would answer false,
   *    and the run would report "still not proven" about a runbook that just
   *    proved — once per run, forever, each time spending a deployment and a
   *    verification-budget charge. Deriving is equally wrong (it is a human's
   *    runbook). The remedy is re-REGISTRATION of this tree's revision, which
   *    only the Verify Setup flow does, which is what the text below says.
   */
  | 'stale-proof'
  /**
   * The MODALITY is one the lane bootstrap does not author, whatever the
   * project's runbook state says.
   *
   * Today that is `mobile`, and the reason is not that a portable runbook cannot
   * express it — since the mobile widening it can, `app` block and all. It is
   * that the DERIVATION machinery is npm-shaped end to end: the drafting agent
   * surveys `package.json` scripts, the rung-1 operations add npm scripts, and
   * the validators reason about build/serve command shapes. None of that can
   * discover an Xcode scheme, a bundle id, or a simulator destination, so a lane
   * that "derived" a mobile runbook would either refuse late (after spending an
   * agent deployment) or register a plausible-looking record no execution path
   * could satisfy. Mobile runbooks are AUTHORED and PROVEN by the verify-setup
   * flow, where a human reviews the result before it becomes the project's
   * singleton record.
   *
   * Distinct from the runner's `'undeclarable-modality'`, which is the narrower
   * "this string is not a runbook modality at all" case: that one says the
   * contract has no room for the value, this one says the contract has room and
   * the lane still declines to fill it.
   */
  | 'auto-derive-unsupported'
  /** The store could not observe enough to answer. Never write on a guess. */
  | 'unobservable';

/**
 * `proceed: true` means the bootstrap may act on this request. `mode` says WHAT
 * it may do, and the two are not variations of one operation — they touch
 * different things and can fail for different reasons:
 *
 *  - `'derive'` — author (or adopt) a runbook, commit it, register it, prove it.
 *    `adopt` distinguishes the two ways that happens: `false` = author one from
 *    scratch, `true` = this tree already CARRIES a parseable runbook (a
 *    teammate committed it; this host merely never proved it), so the honest
 *    action is to prove what is there rather than overwrite it with a
 *    machine-authored rival.
 *  - `'reprove'` — a proven record DRIFTED (F4 / Codex #2). The runbook is
 *    already written, already committed, already registered; the only thing
 *    that expired is the proof. So this mode writes NOTHING — no draft, no
 *    file, no commit, no registration — it re-runs the attestation proof
 *    against the record as it stands. There is no `adopt` question to answer
 *    here, which is why the field is absent rather than `false`: a reprove that
 *    read an `adopt` flag would be reading a decision that was never made.
 */
export type BootstrapDecision =
  | { proceed: true; mode: 'derive'; adopt: boolean }
  | { proceed: true; mode: 'reprove' }
  | { proceed: false; reason: BootstrapDeclineReason };

/**
 * The situations in which deriving a runbook is safe.
 *
 * Stated as an explicit allow-list rather than "not proven", because the unsafe
 * cases are the ones that ANSWER `'unproven-draft'` too (§4): the collapse is
 * exactly what makes a naive `status() !== 'proven'` test wrong. A reason added
 * to {@link VerifyRunbookStatusReason} later therefore defaults to NOT
 * bootstrapping, which is the correct direction to fail.
 */
const BOOTSTRAPPABLE: ReadonlySet<VerifyRunbookStatusReason> = new Set([
  'no-record',
  'file-only',
  'draft',
]);

/**
 * The modalities the LANE bootstrap is allowed to author a runbook for.
 *
 * An explicit allow-list, in the same spirit as {@link BOOTSTRAPPABLE} and for
 * the same reason: a modality added to `VerificationModality` later defaults to
 * NOT being auto-derived, which is the correct direction to fail. The derivation
 * machinery is npm-shaped (see `'auto-derive-unsupported'`), so a new modality
 * is presumed outside it until someone teaches the drafting agent otherwise.
 *
 * Exported so the PREFLIGHT can skip a runbook-status read whose answer cannot
 * change the outcome, without re-stating the policy as a second `if` — the exact
 * drift this module exists to prevent.
 */
const AUTO_DERIVABLE_MODALITIES: ReadonlySet<VerificationModality> = new Set<VerificationModality>([
  'web',
  'cdp-app',
  'native-screen',
]);

/** True when the lane bootstrap may author a runbook for this modality at all. */
export function bootstrapSupportsModality(modality: VerificationModality): boolean {
  return AUTO_DERIVABLE_MODALITIES.has(modality);
}

/**
 * The runbook-state half of the decision, on its own: why deriving is refused
 * for this status, or `null` when it is allowed.
 *
 * Split out from {@link decideRunbookBootstrap} because the GATE needs exactly
 * this and nothing else. The gate has no opinion on the bootstrap toggle and
 * has already established that the task derives an environment; what it wants is
 * the SITUATION, so the reason it writes onto the skipped row names the same
 * fact the preflight would have declined for. Two seams, one classification.
 */
export function declineForRunbookStatus(
  status: VerifyRunbookStatusDetail,
): BootstrapDeclineReason | null {
  const { reason } = status;
  if (reason === 'proven') return 'already-proven';
  if (reason === 'proven-file-absent-here') return 'proof-belongs-elsewhere';
  // BOTH drifts collapse here on purpose: to a REQUEST they are the same fact
  // (a proven record that cannot serve it) and the gate's skip string must not
  // fork. They are told apart one level up, by `decideRunbookBootstrap`, which
  // is the only caller that WRITES — see the `'stale-proof'` doc.
  if (reason === 'drifted' || reason === 'content-drifted') return 'stale-proof';
  if (!BOOTSTRAPPABLE.has(reason)) return 'unobservable';
  return null;
}

/**
 * Should the bootstrap fire for this request?
 *
 * Order matters for the QUALITY of the answer, not its correctness: `disabled`
 * and `no-environment` are checked first so a project with the feature off, or a
 * request that never needed a runbook at all, is never described in terms of its
 * runbook state — logging "no proven runbook" for a degenerate target-only task
 * would be true and completely misleading.
 *
 * ONE SITUATION PROCEEDS WITHOUT WRITING (F4 / Codex #2). A `'stale-proof'`
 * whose underlying reason is `'drifted'` — the project inputs or the host moved
 * out from under a proof — answers `{ proceed: true, mode: 'reprove' }`. It is
 * the only `declineForRunbookStatus` answer that is not a refusal here, and the
 * asymmetry is the whole point of stage 2: the gate still needs the decline
 * reason (a drifted record cannot serve a request), while the bootstrap's honest
 * response is to re-run the proof over the record that already exists. Deriving
 * there would UPSERT a machine-authored rival over a human's runbook whose only
 * defect is a stale proof, and declining there would strand the project forever
 * now that drift is computed rather than persisted.
 *
 * AND THE OTHER DRIFT STILL DECLINES (F4 fix round). `'content-drifted'` — this
 * tree carries a portable file that is not the record's content — reaches the
 * same `'stale-proof'` decline reason and must NOT reach the reprove: nothing a
 * proof can do changes `portable_hash` (promotion deliberately never re-stamps
 * it, Codex #1), so a reprove would pass, fail its own `confirmProven` check,
 * report "still not proven", and repeat on the next run — a self-renewing spend
 * of a deployment and a budget charge that can never converge. Discriminating on
 * `status.reason` rather than on the decline is deliberate: the decline is the
 * GATE's vocabulary and must stay coarse; the mode is a WRITE decision and needs
 * the finer fact.
 *
 * Every OTHER decline is unchanged, and a reason added to
 * {@link VerifyRunbookStatusReason} later still defaults to not bootstrapping —
 * in BOTH senses, since the reprove arm is keyed on an exact reason rather than
 * on "not one of the others".
 */
export function decideRunbookBootstrap(args: {
  /** The resolved toggle AND kill switch, already combined by the caller. */
  enabled: boolean;
  /**
   * The modality this request would verify in. Checked BEFORE the task shape and
   * before the runbook state, because the answer for an unsupported modality is
   * the same whatever those say — see `'auto-derive-unsupported'`.
   */
  modality: VerificationModality;
  derivesEnvironment: boolean;
  status: VerifyRunbookStatusDetail;
}): BootstrapDecision {
  if (!args.enabled) return { proceed: false, reason: 'disabled' };
  // Ahead of `no-environment` on purpose. A mobile lane's task carries `app`
  // rather than `serve`, so whether `taskDerivesEnvironment` happens to be true
  // for it is an accident of the task's `build` array — and "this task derives
  // nothing" would be the wrong sentence to hand someone asking why their mobile
  // verification never ran. The modality policy is the real answer either way.
  if (!bootstrapSupportsModality(args.modality)) {
    return { proceed: false, reason: 'auto-derive-unsupported' };
  }
  if (!args.derivesEnvironment) return { proceed: false, reason: 'no-environment' };

  const decline = declineForRunbookStatus(args.status);
  if (decline === 'stale-proof' && args.status.reason === 'drifted') {
    return { proceed: true, mode: 'reprove' };
  }
  if (decline !== null) return { proceed: false, reason: decline };
  return { proceed: true, mode: 'derive', adopt: args.status.reason === 'file-only' };
}

/**
 * The human-facing remedy for a runbook-shaped skip.
 *
 * Lives here rather than in verdictDelivery because the sentence and the
 * decision are the same fact: whatever `decideRunbookBootstrap` declined for is
 * what the human has to fix, and separating them is how the finding ends up
 * confidently recommending the wrong action. Returns `null` for the reasons a
 * human cannot act on — a disabled toggle and a degenerate task are not
 * problems, and `already-proven` never reaches a skip at all.
 */
export function bootstrapRemedyText(reason: BootstrapDeclineReason): string | null {
  switch (reason) {
    case 'proof-belongs-elsewhere':
      return (
        'This project HAS a proven verification runbook — this branch just does not carry ' +
        '`.cyboflow/verify-runbook.json` yet. Merge (or rebase onto) the branch that added it and ' +
        'verification will run here without any further setup. Do NOT re-run verification setup: ' +
        'the record is shared across branches, and re-deriving would overwrite the proven one.'
      );
    case 'stale-proof':
      return (
        "This project's verification runbook was proven, but something it depended on has since " +
        'moved — its own content, the package scripts/lockfile it builds through, or this host. ' +
        'The runbook itself is probably still right; it needs to be re-proven — and if the runbook ' +
        'FILE is what changed, re-registered against this revision first. Re-run verification setup ' +
        'to register and prove the current revision.'
      );
    case 'auto-derive-unsupported':
      return (
        'This modality is not one a lane can draft a verification runbook for on its own — the ' +
        'auto-derivation surveys npm scripts, which cannot discover an Xcode scheme, a bundle id, ' +
        'or a simulator destination. Run verification setup, which authors and proves the runbook ' +
        'for this modality with a human reviewing the result.'
      );
    case 'unobservable':
      return (
        'The verification runbook record could not be read for this project, so verification ' +
        'declined to guess rather than run against an unknown environment. Check the app log for a ' +
        'VerifyRunbookStore warning.'
      );
    case 'disabled':
    case 'no-environment':
    case 'already-proven':
      return null;
  }
}
