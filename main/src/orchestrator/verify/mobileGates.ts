/**
 * mobileGates — the `mobile` modality's PRE-LEASE gate arm and its bounded
 * simulator-slot pool (docs/proposals/mobile-verification-tier.md §8, §10, T3).
 *
 * WHY IT IS ITS OWN FILE. verificationScheduler.ts sits at a frozen line cap in
 * `__tests__/fileSizeRatchet.test.ts` and the rule there is EXTRACT, never bump
 * the cap (GitHub issue #19). Everything the mobile tier adds to the gate/lease
 * path that does not need the scheduler instance lives here; the scheduler keeps
 * only the call sites.
 *
 * Standalone-typecheck invariant, same as the scheduler's: no 'electron', no
 * 'better-sqlite3', no 'fs', no concrete service from main/src/services/*. The
 * lease pool and the logger both arrive as narrow structural parameters, so this
 * module has no runtime import back into verificationScheduler.ts (which imports
 * IT) and the pair cannot form an import cycle.
 */
import type { LoggerLike } from '../types';

/**
 * The gate-1 detail for a host on which NO mobile toolchain probe is wired —
 * the phase-0 posture, carried as `UNSUPPORTED_MODALITY_REASONS.mobile` so an
 * unprobed deployment stays a clean skip rather than leasing a simulator on a
 * host nobody asked.
 *
 * It replaced `'deferred — pending Xcode MCP'`, which said the modality itself
 * was unbuilt. It is now built (§2); what an unprobed host lacks is the PROBE,
 * and the sentence says exactly that. Migration 139 clears the legacy marks that
 * carry the old literal — see §10.1 for why that migration filters on the reason
 * and not on `(modality, status)` alone.
 */
export const MOBILE_TOOLCHAIN_UNPROBED_DETAIL =
  'the mobile modality needs the iOS Simulator toolchain probe, which is not wired on this host';

/**
 * The detail a `mobile` skip carries when a toolchain probe WAS wired and
 * answered FALSE — i.e. this host was asked and said no. Structurally identical
 * to the unprobed skip above (same `unsupported modality '<m>': <detail>` shape,
 * same `markUnsupported` ledger write, same `env` failure class); only the
 * DETAIL differs, and it differs on purpose: "no probe wired" is a statement
 * about cyboflow that a user can do nothing about, whereas every fact named here
 * is one a human can go and fix.
 *
 * It names the THREE separable facts rather than one fused verdict, because the
 * probe collapses them into a single boolean by design and the remedies are
 * genuinely different: installing the command-line tools, downloading a runtime,
 * and having a device type that runtime actually supports are three trips.
 */
export const MOBILE_TOOLCHAIN_UNAVAILABLE_DETAIL =
  'this host cannot run an iOS Simulator verification — the Xcode command-line tools are missing, or no iOS runtime is available, or that runtime supports no compatible iPhone device type';

/** The lowest / highest number of concurrently-leased simulators (§8). */
const MOBILE_SLOT_MIN = 1;
const MOBILE_SLOT_MAX = 4;

/**
 * Clamp a configured `mobileSimSlots` into [1,4].
 *
 * The floor is the same defence `agentSlotCount` needs: a persisted 0 (or a
 * negative, or a NaN) would make {@link mobileSlotNames} empty, and an empty
 * candidate list makes `tryAcquireOneOf` return null FOREVER — every mobile
 * request would sit 'queued' until the age ceiling swept it, a silent
 * whole-feature outage from one bad config value. The ceiling is host RAM: each
 * slot is a booted iOS Simulator, and a host running more than a handful starves
 * the user's own work.
 */
export function mobileSlotCount(configured: number): number {
  const floored = Math.floor(configured);
  if (!Number.isFinite(floored)) return MOBILE_SLOT_MIN;
  return Math.max(MOBILE_SLOT_MIN, Math.min(MOBILE_SLOT_MAX, floored));
}

/** Build the lease name for mobile simulator slot `index`. */
export function verifyMobileSlot(index: number): string {
  return `verify:mobile:${index}`;
}

/**
 * The bounded mobile-slot pool's candidate lease names, probed in index order —
 * the same N-distinct-count-1-leases emulation the agent-slot and port pools
 * use, so two mobile rows in ONE drain pass take slot 0 and slot 1 and run
 * concurrently while the (N+1)th finds every slot held and stays 'queued'.
 *
 * This is deliberately NOT the count-1 {@link VERIFY_SCREEN_LEASE} shape: there
 * is one physical display but there are as many simulators as the host will
 * boot, so mobile is bounded, not exclusive.
 */
export function mobileSlotNames(configured: number): string[] {
  return Array.from({ length: mobileSlotCount(configured) }, (_, i) => verifyMobileSlot(i));
}

/**
 * Gate 1's mobile arm: the unsupported-modality DETAIL for a `mobile` request,
 * or `null` when this host can run one.
 *
 * Three answers, and the middle one is the whole point of the tier:
 *   - no probe wired   ⇒ {@link MOBILE_TOOLCHAIN_UNPROBED_DETAIL} (unprobed is
 *                        not capable — the phase-0 posture, unchanged)
 *   - probe true       ⇒ `null` (proceed)
 *   - probe false      ⇒ {@link MOBILE_TOOLCHAIN_UNAVAILABLE_DETAIL}
 *   - probe THROWS     ⇒ the same, plus a warn — FAIL CLOSED.
 *
 * Fail-closed on a throw is the `nativeCaptureProbe` rule, for the same reason
 * and a heavier one: the probe's contract is never-throws, so a throw is a
 * broken probe, and a broken probe must not open onto a 2 GB simulator create +
 * boot that will then fail ten minutes later with an unhelpful message. Note
 * that the PREFLIGHT mobile check keeps the opposite rule (fail-open) on
 * purpose — see §10: an unanswerable pre-deploy probe must never be the reason a
 * lane advances on an unrun verification.
 */
export async function mobileToolchainDetail(
  probe: (() => Promise<boolean>) | undefined,
  logger?: LoggerLike,
): Promise<string | null> {
  if (!probe) return MOBILE_TOOLCHAIN_UNPROBED_DETAIL;
  try {
    return (await probe()) ? null : MOBILE_TOOLCHAIN_UNAVAILABLE_DETAIL;
  } catch (err) {
    logger?.warn('[VerificationScheduler] mobile toolchain probe threw; treating host as incapable', {
      error: err instanceof Error ? err.message : String(err),
    });
    return MOBILE_TOOLCHAIN_UNAVAILABLE_DETAIL;
  }
}
