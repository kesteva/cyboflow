/**
 * Phase-0 gate vocabulary (docs/proposals/verification-setup-flow.md §3.2/§3.3):
 * the unsupported-modality map and every human-facing SKIP reason the scheduler
 * writes when it declines to deploy (no runbook, runbook elsewhere/drifted/
 * unreadable, unproven-blocked), plus the decline→reason mappings in both
 * directions. Extracted verbatim from verificationScheduler.ts (issue #19 step
 * 5); that file re-exports everything here, so existing importers are unchanged.
 */
import type { VerificationModality } from '../../../../shared/types/visualVerification';
import type { BootstrapDeclineReason } from './bootstrapEligibility';
import { MOBILE_TOOLCHAIN_UNPROBED_DETAIL } from './mobileGates';

// ---------------------------------------------------------------------------
// Phase-0 gate vocabulary (docs/proposals/verification-setup-flow.md §3.2/§3.3)
// ---------------------------------------------------------------------------

/**
 * Modalities the AGENT engine has no executable path for, with the reason a
 * human sees on the skip (§3.3). Until phase 1 ships the roster these land here
 * with an explicit statement instead of today's deploy-and-fail-organically: the
 * agent path never consults `verify_type` (dispatch keys solely on the run's
 * chain stamp) and `VerificationAgentRequest` carries no type field, so a
 * `native-desktop` / `mobile-flow` request is otherwise deployed as if it were a
 * web check and burns the full deadline before failing incomprehensibly.
 *
 * A modality ABSENT from this map is supported. Typed as a partial record so
 * adding a member to the shared union makes this a compile-visible decision.
 *
 * `native-screen` and `mobile` are both CONDITIONALLY unsupported: each entry is
 * the answer for a deployment with NO probe wired (the phase-0 posture — an
 * unprobed host cannot be assumed capable), and the matching probe
 * ({@link VerificationSchedulerDeps.nativeCaptureProbe} /
 * {@link VerificationSchedulerDeps.mobileToolchainProbe}) overrides it when it
 * answers true.
 */
export const UNSUPPORTED_MODALITY_REASONS: Partial<Record<VerificationModality, string>> = {
  'native-screen': 'native-screen capture/drive not yet wired on the agent path (proposal §4)',
  mobile: MOBILE_TOOLCHAIN_UNPROBED_DETAIL,
};

/**
 * The detail a `native-screen` skip carries when a capability probe WAS wired
 * and answered FALSE — i.e. this host was asked and said no. The skip is
 * structurally identical to the probe-less one above (same
 * `unsupported modality '<m>': <detail>` shape, same `markUnsupported` ledger
 * write, same `env` failure class, same evidence row); only the DETAIL differs,
 * and it differs on purpose: "not yet wired" is a statement about cyboflow that
 * a user can do nothing about, whereas the grant pair is the one native-screen
 * failure a human can actually fix (grant Screen Recording + Accessibility, or
 * install the binary). The probe (`peekabooBackend.healthCheck`) collapses
 * binary-absent and grant-declined into a single boolean by design — it never
 * throws and never distinguishes — so this names both halves rather than
 * guessing which one bit.
 */
export const NATIVE_CAPTURE_UNAVAILABLE_DETAIL =
  'this host cannot capture the screen — the peekaboo binary is missing, or one of the two required macOS TCC grants (Screen Recording + Accessibility) is not held';

/**
 * The §3.2 degrade-path skip reason. Exported because verdictDelivery matches on
 * it to attach the setup CTA to the non-blocking finding — this is the ONE skip
 * reason a human can act on directly, and phase 2 will turn that CTA into a real
 * launch affordance for the verification-setup flow.
 */
export const VERIFY_NO_RUNBOOK_REASON =
  'no proven verification runbook for this project (run verification setup)';

/**
 * The pre-lease skip for a COMPOSED task with no surface at all — no build, no
 * serve, no pre-live target, no mobile `app` block (see `taskHasRunnableSurface`).
 * A composer defect, not an environment one: re-composing the task fixes it,
 * running verification setup does not — so the text deliberately avoids the
 * "verification runbook" substring the run-level decline collapse keys on.
 * `declared` is the task's own `modality` when it disagrees with the stamped
 * one (the shiny-eagle shape: an iOS app composed as `native-screen`, stamped
 * `web`), which is the most useful single clue for whoever reads the finding.
 */
export function nothingToRunReason(stamped: string, declared: string | undefined): string {
  const mismatch =
    declared !== undefined && declared !== stamped
      ? ` (the task declared modality '${declared}', but this request resolved to '${stamped}')`
      : '';
  return (
    'the composed verification task names nothing to stand up or look at — no build, no serve, ' +
    `no target and no app block${mismatch}; re-compose it for the project's actual surface ` +
    "(an iOS app is modality 'mobile' with an app block)"
  );
}

/**
 * The §3.2 skip reason for §4's PRE-MERGE case: a runbook IS proven for this
 * project, this branch just does not carry the portable file yet.
 *
 * A separate string because the remedy is the opposite of the one above.
 * `VERIFY_NO_RUNBOOK_REASON` tells a human to run verification setup; doing that
 * HERE would derive a fresh runbook and UPSERT it over the proven singleton
 * record every other branch depends on (runbookStore's `registerDraft`),
 * breaking verification for the projects that configured it properly. The right
 * action is to merge the branch that already carries it.
 *
 * MOSTLY UNREACHABLE SINCE F10. The store's `statusDetail` no longer answers
 * `'proven-file-absent-here'` for a genuinely absent file — the record, not the
 * file, is what a proof executes, so the portable-hash conjunct is skipped and
 * the branch is judged on its project inputs. Kept because the mapping is still
 * total over {@link VerifyRunbookStatusDetail} and an injected/stubbed resolver
 * may still produce that reason.
 */
export const VERIFY_RUNBOOK_ELSEWHERE_REASON =
  'a proven verification runbook exists for this project but is not in this branch';

/**
 * The §3.2 skip reason for a runbook that WAS proven and has since drifted —
 * its own content, the project inputs it builds through, or the host. Since F4
 * (docs/proposals/visual-verification-brittleness-fixes.md) the read that
 * produces this LEAVES THE RECORD INTACT and merely refuses: the drift is
 * recomputed on every gate/badge read, so it can go away on its own (the inputs
 * come back) or be cleared by a re-prove that re-stamps the provenance. What it
 * needs is re-proving, never re-deriving.
 */
export const VERIFY_RUNBOOK_DRIFTED_REASON =
  "this project's proven verification runbook no longer matches its inputs";
// ONE STRING FOR BOTH DRIFTS, deliberately (F4 fix round). The store tells
// provenance drift (`'drifted'`) from content drift (`'content-drifted'`)
// because their REMEDIES differ — the first is re-proven automatically, the
// second must be re-registered — but to a REQUEST they are the same fact, and
// forking the skip text here would fork `runbookDeclineForSkipReason` below,
// which reverse-maps the persisted string. `bootstrapEligibility` holds the
// distinction; the gate stays coarse.

/**
 * The §3.2 skip reason when the runbook record could not be READ at all (a
 * pre-096 DB, a SQL error, an input hash that would not compute). Distinct from
 * "none exists" on purpose: the store fails soft to `'absent'`, and reporting
 * that as "never set up" would send a human to re-run a setup flow that already
 * succeeded.
 */
export const VERIFY_RUNBOOK_UNREADABLE_REASON =
  'the verification runbook record for this project could not be read';

/**
 * The skip reason for a runbook decline — the forward direction of
 * {@link runbookDeclineForSkipReason}.
 *
 * `null` (the status is bootstrappable: nothing derived, a draft, or a file this
 * host never proved) and `'already-proven'` both fall through to the ORIGINAL
 * reason string, so every pre-existing consumer and every existing test keeps
 * matching exactly what it matched before. Only the three genuinely different
 * situations get their own text. `'already-proven'` is unreachable from the gate
 * (a proven status returns before this) and is mapped rather than thrown on so a
 * future caller cannot turn a classification into a crash.
 */
export function skipReasonForRunbookDecline(decline: BootstrapDeclineReason | null): string {
  switch (decline) {
    case 'proof-belongs-elsewhere':
      return VERIFY_RUNBOOK_ELSEWHERE_REASON;
    case 'stale-proof':
      return VERIFY_RUNBOOK_DRIFTED_REASON;
    case 'unobservable':
      return VERIFY_RUNBOOK_UNREADABLE_REASON;
    default:
      return VERIFY_NO_RUNBOOK_REASON;
  }
}

/**
 * Reverse-map a persisted `error_message` back to the situation that produced
 * it, so a consumer holding only the string (verdictDelivery, building the
 * human-facing finding) can attach the RIGHT remedy. `null` for anything that is
 * not a runbook-shaped skip.
 */
export function runbookDeclineForSkipReason(
  errorMessage: string | null,
): BootstrapDeclineReason | null {
  switch (errorMessage) {
    case VERIFY_RUNBOOK_ELSEWHERE_REASON:
      return 'proof-belongs-elsewhere';
    case VERIFY_RUNBOOK_DRIFTED_REASON:
      return 'stale-proof';
    case VERIFY_RUNBOOK_UNREADABLE_REASON:
      return 'unobservable';
    default:
      return null;
  }
}

/**
 * The prefix stamped on a terminal the §3.1 GATE-INTEGRITY guard blocked — a
 * DEPLOYED session whose skip nothing corroborated (see
 * {@link VerificationScheduler.isUnprovenAdvancingSkip}). Exported so tests and
 * any future health-panel grouping can key on the exact string rather than
 * re-deriving it; the original runner message is appended after it, because the
 * conversion changes the STATUS and must never destroy the evidence.
 */
export const VERIFY_UNPROVEN_SKIP_BLOCKED = 'unverified result blocked (§3.1 gate integrity)';
