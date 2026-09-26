/**
 * driveEngineSelection — which engine DRIVES a `mobile` verification's
 * simulator (docs/proposals/runbook-optional-verification.md §B3).
 *
 * THE RULE, in one place:
 *  - `'none'`    → observe-only, whatever the host has;
 *  - `'maestro'` → Maestro when it resolved WITH a device-pin flag, else none;
 *  - `'xcode'` / `'auto'` → the Xcode 27 DeviceInteraction rung when the §B2
 *    probe says `available` or `inconclusive` (an unreadable grant is not a
 *    confident "not approved" — StartSession is the authoritative check), else
 *    Maestro-with-pin, else none.
 *
 * DEGRADE, NEVER SKIP. An xcode failure at ANY of its three points — the
 * probe, `DeviceInteractionStartSession`, or a `deviceUUID` that is not the
 * leased udid — falls down the ladder and is RECORDED (`degradeReason`), never
 * turned into a skipped request. A pinned `'xcode'` degrades the same way as
 * `'auto'`: the knob says what to prefer, not what to refuse to run without.
 *
 * TWO PHASES, because the xcode decision has to precede simulator acquisition
 * (an xcode run needs an iOS 27+ runtime, `minRuntimeMajor`) while the final
 * rung depends on what StartSession and the Maestro probe answer after it:
 * {@link intendXcode} runs before `acquire`, {@link finalizeDriveEngine} after.
 *
 * PURE: no I/O. The probe's answer is passed in, already summarised to the two
 * fields this rule reads — the probe itself lives in `services/visualVerify/`,
 * which this standalone-typechecked tree may not import, so the shared
 * vocabulary lives HERE and the probe imports it.
 */
import type { MobileDriveEngine } from '../../../../../shared/types/visualVerification';

/** The rung that actually drove (or would drive) the simulator. */
export type MobileDriveRung = 'xcode' | 'maestro' | 'none';

/** The §B2 probe's overall answer. */
export type XcodeDeviceInteractionOutcome =
  | 'available'
  | 'approval-required'
  | 'expiring'
  | 'inconclusive'
  | 'unavailable';

/** The approval answer behind the §B2 probe's `approval` check. */
export type XcodeApprovalState =
  | 'approved'
  /** Approved now, but the grant ends before a request could finish. */
  | 'expiring'
  | 'expired'
  /** A grant names our path but a different sha256 — the binary changed since approval. */
  | 'binary-changed'
  | 'missing'
  /** Could not tell: an unrecognised trust shape, an unreadable binary, or no status at all. */
  | 'unknown';

/** The two probe fields the selection reads. */
export interface XcodeProbeSummary {
  outcome: XcodeDeviceInteractionOutcome;
  approval: XcodeApprovalState;
  /** The probe's one-sentence reason; carried into the degrade detail. */
  detail: string;
}

/** Why the xcode rung was not the one that drove (§B3). */
export type XcodeDegradeReason =
  | 'xcode-approval-missing'
  | 'xcode-approval-expired'
  | 'xcode-unavailable'
  | 'xcode-session-failed';

/**
 * The degrade reason when the probe steers the runner off xcode, or `null`
 * when it does not (available / inconclusive: both still attempt xcode, and
 * StartSession decides).
 */
export function degradeReasonForProbe(
  result: Pick<XcodeProbeSummary, 'outcome' | 'approval'>,
): Exclude<XcodeDegradeReason, 'xcode-session-failed'> | null {
  switch (result.outcome) {
    case 'unavailable':
      return 'xcode-unavailable';
    case 'expiring':
      return 'xcode-approval-expired';
    case 'approval-required':
      return result.approval === 'expired' ? 'xcode-approval-expired' : 'xcode-approval-missing';
    case 'available':
    case 'inconclusive':
      return null;
  }
}

/** Phase 1's answer: attempt the xcode rung, or why not. */
export type XcodeIntent =
  | { attempt: true }
  | { attempt: false; degradeReason: XcodeDegradeReason | null; detail: string | null };

/**
 * Phase 1 (before `acquire`): should this request ATTEMPT the xcode rung?
 *
 * `probe` is `null` when this host never wired one (off darwin, or a runner
 * built without the Stage 3 collaborators): under `auto`/`xcode` that is
 * `xcode-unavailable`, recorded like any other degrade. A request that never
 * asked for xcode (`maestro`/`none`) carries no degrade reason at all — nothing
 * it wanted was withheld.
 */
export function intendXcode(requested: MobileDriveEngine, probe: XcodeProbeSummary | null): XcodeIntent {
  if (requested === 'none' || requested === 'maestro') {
    return { attempt: false, degradeReason: null, detail: null };
  }
  if (probe === null) {
    return {
      attempt: false,
      degradeReason: 'xcode-unavailable',
      detail: 'no Xcode DeviceInteraction probe is wired on this host',
    };
  }
  const reason = degradeReasonForProbe(probe);
  if (reason === null) return { attempt: true };
  return { attempt: false, degradeReason: reason, detail: probe.detail };
}

/** The final, recorded drive-engine decision (§B3 provenance). */
export interface DriveEngineDecision {
  requested: MobileDriveEngine;
  used: MobileDriveRung;
  /** Set when an xcode rung that was asked for (explicitly or via `auto`) did not drive. */
  degradeReason: XcodeDegradeReason | null;
  /** Human detail for the degrade, when there is one. */
  degradeDetail: string | null;
}

/**
 * Phase 2 (after acquire, StartSession and the Maestro probe): the rung that
 * is EXPORTED as `VERIFY_MOBILE_DRIVE`, and therefore the one the drive
 * coercion keys on. `xcode` is the outcome of phase 1 plus the session attempt:
 * `{ ok: true }` when a session is live, else the reason it is not.
 */
export function finalizeDriveEngine(args: {
  requested: MobileDriveEngine;
  xcode: { ok: true } | { ok: false; degradeReason: XcodeDegradeReason | null; detail: string | null };
  maestroAvailable: boolean;
}): DriveEngineDecision {
  const { requested, xcode, maestroAvailable } = args;
  if (requested === 'none') {
    return { requested, used: 'none', degradeReason: null, degradeDetail: null };
  }
  if (xcode.ok) {
    return { requested, used: 'xcode', degradeReason: null, degradeDetail: null };
  }
  return {
    requested,
    used: maestroAvailable ? 'maestro' : 'none',
    degradeReason: xcode.degradeReason,
    degradeDetail: xcode.detail,
  };
}
