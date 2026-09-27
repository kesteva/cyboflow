/**
 * mobileTeardownHold — keep a `mobile` row's simulator resources held until
 * the verification runner's OWN cleanup has settled, even after the scheduler
 * stopped waiting for its verdict (docs/proposals/runbook-optional-verification.md
 * §B3/§B4.8, adversarial-review X-1).
 *
 * THE HAZARD. The agent engine races `agentRunner.run()` against the per-row
 * deadline/cancel signal (`raceWithAbort`), and when the abort wins the runner
 * is DETACHED: it is still inside its `finally` — EndSession, bridge kill,
 * socket close, `simctl shutdown/delete`, the request-dir removal. Releasing
 * the `verify:mobile:<i>` slot (and the `verify:xcode` lease that rides it) at
 * that moment lets a second row open a DeviceInteraction session beside the
 * first. Worse, a §A5 learned-pin timeout REQUEUES the same row: the new
 * attempt shares the request id — and so `<dataDir>/verify-mobile/<requestId>`
 * — and the old runner's late dispose would delete the new attempt's
 * `owner.json` and DerivedData.
 *
 * THE RULE. When a mobile row's runner has not settled by the time the engine's
 * `finally` runs, the mobile lease is handed to a {@link MobileTeardownHolds}
 * entry instead of being released. The entry releases it (and nudges the drain)
 * when the runner settles, or — so a runner that never settles cannot hold a
 * simulator slot forever — after a generous hard bound, with a warning. While
 * an entry exists the engine refuses to lease that request id again, so a
 * same-id requeue waits for the old attempt's cleanup.
 *
 * Non-mobile rows never use this: their leases release exactly as before.
 * No electron, no services: standalone-extractable like the rest of
 * orchestrator/verify.
 */
import type { LoggerLike } from '../types';

/**
 * The hard bound on a hold (X-1). Generous on purpose: the runner's own teardown
 * is bounded per step (~10 s each for EndSession, the bridge and the socket, plus
 * `simctl shutdown` + `delete`), so a healthy runner settles well inside it; the
 * bound exists only for a runner wedged somewhere no step timer reaches.
 */
export const MOBILE_TEARDOWN_HOLD_BOUND_MS = 5 * 60_000;

/** A promise plus a synchronous "has it settled yet" read. */
export interface TrackedSettle {
  readonly promise: Promise<unknown>;
  isSettled(): boolean;
}

/** Observe `promise`'s settlement without consuming its value or its rejection. */
export function trackSettle(promise: Promise<unknown>): TrackedSettle {
  let settled = false;
  const observed = promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return { promise: observed, isSettled: () => settled };
}

/**
 * The set of request ids whose detached runner is still tearing down, each
 * holding its mobile lease until that teardown settles (or the bound fires).
 */
export class MobileTeardownHolds {
  private readonly held = new Set<string>();
  private readonly boundMs: number;
  private readonly logger?: LoggerLike;

  constructor(opts: { boundMs?: number; logger?: LoggerLike } = {}) {
    this.boundMs = opts.boundMs ?? MOBILE_TEARDOWN_HOLD_BOUND_MS;
    this.logger = opts.logger;
  }

  /** Whether `requestId`'s previous attempt is still tearing down (its id must not be leased again yet). */
  isHeld(requestId: string): boolean {
    return this.held.has(requestId);
  }

  /**
   * Hold until `runner` settles or the bound fires, whichever is first, then
   * call `onRelease` exactly once (it releases the lease and nudges the drain).
   */
  hold(requestId: string, runner: TrackedSettle, onRelease: () => void): void {
    this.held.add(requestId);
    let done = false;
    const finish = (boundHit: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      this.held.delete(requestId);
      if (boundHit) {
        this.logger?.warn('[VerificationScheduler] mobile runner teardown did not settle within the bound; releasing its simulator lease', {
          requestId,
          boundMs: this.boundMs,
        });
      } else {
        this.logger?.debug('[VerificationScheduler] detached mobile runner settled; releasing its simulator lease', {
          requestId,
        });
      }
      try {
        onRelease();
      } catch (err) {
        this.logger?.warn('[VerificationScheduler] releasing a held mobile lease threw', {
          requestId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };
    const timer = setTimeout(() => finish(true), this.boundMs);
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      (timer as { unref: () => void }).unref();
    }
    void runner.promise.then(() => finish(false));
  }
}
