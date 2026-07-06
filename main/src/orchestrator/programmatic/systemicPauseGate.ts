/**
 * Systemic-pause checkpoint for the programmatic execution model.
 *
 * WHY THIS EXISTS (the 2026-07-06 planner incident): a step whose agent turn dies
 * on an ENVIRONMENT-level condition — a usage/session/rate limit, a provider
 * overload (429/529), a billing/quota block, or an auth failure — must NOT be
 * treated like a step-specific defect. Retrying the step, optional-skipping it,
 * looping back, or escalating it to a human all BURN the run's budgets on a
 * failure that no step-local action can fix. In the planner incident a five-hour
 * usage-limit at a mid-run step consumed the retry budget and then failed the
 * whole run, discarding hours of upstream work that only needed to WAIT for the
 * limit window to roll over. This gate is the park-and-retry that should have
 * happened: the run pauses, surfaces a review-queue item, and resumes — either
 * when the human resolves the item or when an auto-resume timer fires at the
 * advertised reset time — WITHOUT consuming any step budget.
 *
 * The controller routes here (via `ControllerHost.awaitSystemicPause`) ONLY when
 * a step attempt fails with `StepRunResult.systemic === true` (classified by
 * `systemicError.isSystemicStepError`), BEFORE the failure touches the retry
 * budget / optional-skip / loopback / triage. The three-way verdict:
 *   - 'retry'    — the condition cleared (human resolved the pause item, or the
 *                  auto-resume timer fired); re-run the SAME step, budget intact.
 *   - 'giveup'   — the human dismissed the pause; the failure then follows the
 *                  NORMAL step-failure path (byte-identical to a no-seam world).
 *   - 'canceled' — the run was canceled while parked; end the walk 'canceled'.
 *
 * ITEM CONTRACT: the production `SystemicPauseItemOps` adapter creates a review
 * item that is kind 'decision', BLOCKING, status 'pending' — so it participates
 * in the same aggregate-unblock park/resume machinery as a human gate. Resolving
 * it ⇒ 'retry'; dismissing it ⇒ 'giveup'. The item is keyed by a per-step source
 * (`systemicPauseSourceForStep`) so a crash-resume / a repeated systemic failure
 * on the SAME step re-attaches to the already-pending item instead of minting a
 * duplicate.
 *
 * AUTO-RESUME TIMER: when the error text carries a parseable reset time
 * (`parseLimitResetDelayMs`), the gate arms a one-shot timer at
 * `delay + AUTO_RESUME_BUFFER_MS` (fire slightly AFTER the advertised reset so
 * the window has definitely rolled over). On fire it resolves the pause item as
 * the orchestrator actor (which emits the same 'resolved' event a human resolve
 * would) and settles 'retry' belt-and-braces in case the event never arrives. A
 * concurrent human action that already settled the item makes the resolve a
 * no-op (the ReviewItemRouter rejects a non-pending item with invalid_status —
 * expected and swallowed).
 *
 * Mirrors the structure of `blockingItemsGate.ts` / `humanGate.ts`: injected
 * opener/ops + an EventEmitter + `channelFor`, subscribe-BEFORE-act, a single
 * settled flag, one `cleanup()` that removes the channel listener + the abort
 * listener + cancels the timer, and a targetId latch (copied from
 * ReviewQueueHumanGate) so events are ignored until the item id is known.
 *
 * Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3',
 * or any concrete service in main/src/services/* — only shared types, the pure
 * classifier, and narrow injected interfaces.
 */
import type { EventEmitter } from 'events';
import type { WorkflowStep } from '../../../../shared/types/workflows';
import type { LoggerLike } from '../types';
import type { SystemicPauseVerdict } from './types';
import { parseLimitResetDelayMs } from './systemicError';

/** Provenance prefix stamped on a systemic-pause decision review_item. */
export const SYSTEMIC_PAUSE_SOURCE = 'gate:systemic-pause';

/**
 * Stable per-step source string so the find-or-create probe and the pause row
 * share the SAME provenance. e.g. 'gate:systemic-pause:build-epics'.
 */
export function systemicPauseSourceForStep(stepId: string): string {
  return `${SYSTEMIC_PAUSE_SOURCE}:${stepId}`;
}

/**
 * Fire the auto-resume timer slightly AFTER the advertised reset so the limit
 * window has definitely rolled over (clock skew + the provider's own rounding).
 */
export const AUTO_RESUME_BUFFER_MS = 60_000;

export interface SystemicPauseRequest {
  runId: string;
  projectId: number;
  step: WorkflowStep;
  /** The failing step's error text — used for the item body + reset parsing. */
  error: string | undefined;
  /**
   * Fires when the run is canceled while parked at this checkpoint. On abort the
   * resolver dismisses the pause item (fail-soft) and settles to 'canceled',
   * removing its listeners + timer — so a canceled run can never hang here and
   * nothing can leak. Already-aborted on entry short-circuits to 'canceled'
   * without opening anything.
   */
  signal?: AbortSignal;
}

/** What the ControllerHost depends on to gate a step on a systemic failure. */
export interface SystemicPauseResolver {
  /**
   * Park the run on a systemic failure and settle once the condition clears
   * ('retry'), the human gives up ('giveup'), or the run is canceled while
   * parked ('canceled').
   */
  awaitClear(req: SystemicPauseRequest): Promise<SystemicPauseVerdict>;
}

/**
 * Narrow review-item operations the gate needs (satisfied in production by a
 * HumanStepManager/ReviewItemRouter-backed adapter; fakeable in tests). The
 * production `create` adapter GUARANTEES the item is kind 'decision', blocking,
 * status 'pending'. `resolve` / `dismiss` act as the ORCHESTRATOR actor (the
 * auto-resume / cancel paths), routed through the ReviewItemRouter chokepoint so
 * the same 'resolved' / 'dismissed' deltas a human action would emit are emitted.
 */
export interface SystemicPauseItemOps {
  /** An ALREADY-pending pause item id for (runId, source), or null (crash-resume). */
  findPending(runId: string, source: string): Promise<string | null>;
  /** Mint the blocking 'decision' pause item; returns its reviewItemId. */
  create(args: {
    runId: string;
    projectId: number;
    title: string;
    body: string;
    source: string;
  }): Promise<string>;
  /** Orchestrator-actor resolve (auto-resume timer path). */
  resolve(args: { projectId: number; reviewItemId: string; resolution: string }): Promise<void>;
  /** Orchestrator-actor dismiss (cancel path). */
  dismiss(args: { projectId: number; reviewItemId: string; resolution: string }): Promise<void>;
}

/**
 * The run-lifecycle park/resume primitives (satisfied in production by
 * HumanStepManager.parkForBlockingReview / maybeResumeRun — the SAME pair the
 * blocking-items gate uses, so a systemic pause participates in aggregate-unblock).
 */
export interface SystemicPauseParker {
  /** Park running -> awaiting_review because a blocking pause item exists. */
  parkForBlockingReview(runId: string): Promise<boolean>;
  /** Resume awaiting_review -> running once no blocking item remains. */
  maybeResumeRun(runId: string): Promise<boolean>;
}

/** Minimal shape of a review-item change event consumed here (no `any`). */
interface ReviewItemChangeLike {
  reviewItemId: string;
  action: 'created' | 'resolved' | 'dismissed';
}

function isReviewItemChangeLike(v: unknown): v is ReviewItemChangeLike {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return typeof e.reviewItemId === 'string' && typeof e.action === 'string';
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Short noun phrase for the pause item's title, bucketed off the error text so a
 * limit-like failure reads "usage limit" and everything else gets neutral,
 * non-limit phrasing. Buckets: /limit|rate|quota|credit/ → usage limit,
 * /overload/ → provider overload, /auth/ → authentication issue, else systemic
 * failure.
 */
function describeSystemicReason(error: string | undefined): string {
  const e = (error ?? '').toLowerCase();
  if (/limit|rate|quota|credit/.test(e)) return 'usage limit';
  if (/overload/.test(e)) return 'provider overload';
  if (/auth/.test(e)) return 'authentication issue';
  return 'systemic failure';
}

/** Build the pause item's markdown body (error block + optional auto-resume line). */
function buildPauseBody(
  step: WorkflowStep,
  error: string | undefined,
  reason: string,
  nowMs: number,
  delayMs: number | null,
): string {
  const lines = [
    `Step **${step.name}** (\`${step.id}\`) paused after a ${reason}.`,
    '',
    'The failing step reported:',
    '',
    '```',
    error ?? 'No error text was reported.',
    '```',
    '',
  ];
  if (delayMs !== null) {
    const resetAt = new Date(nowMs + delayMs);
    lines.push(`Auto-resumes at ~${resetAt.toLocaleString()}.`, '');
  }
  lines.push(
    '**Resolve** to retry the step now. **Dismiss** to stop waiting — the step then fails normally (its own retry/skip/escalate budgets apply).',
  );
  return lines.join('\n');
}

export interface ReviewQueueSystemicPauseGateDeps {
  items: SystemicPauseItemOps;
  parker: SystemicPauseParker;
  events: EventEmitter;
  channelFor: (projectId: number) => string;
  /**
   * Arm a one-shot timer; returns a cancel thunk. Injected for tests (no real
   * timers); defaults to a setTimeout wrapper returning a clearTimeout thunk.
   */
  setTimer?: (cb: () => void, ms: number) => () => void;
  /** Wall clock; injected for tests. Defaults to Date.now. */
  now?: () => number;
  logger?: LoggerLike;
}

export class ReviewQueueSystemicPauseGate implements SystemicPauseResolver {
  private readonly items: SystemicPauseItemOps;
  private readonly parker: SystemicPauseParker;
  private readonly events: EventEmitter;
  private readonly channelFor: (projectId: number) => string;
  private readonly setTimer: (cb: () => void, ms: number) => () => void;
  private readonly now: () => number;
  private readonly logger?: LoggerLike;

  constructor(deps: ReviewQueueSystemicPauseGateDeps) {
    this.items = deps.items;
    this.parker = deps.parker;
    this.events = deps.events;
    this.channelFor = deps.channelFor;
    this.setTimer =
      deps.setTimer ??
      ((cb, ms): (() => void) => {
        const t = setTimeout(cb, ms);
        return () => clearTimeout(t);
      });
    this.now = deps.now ?? ((): number => Date.now());
    this.logger = deps.logger;
  }

  awaitClear(req: SystemicPauseRequest): Promise<SystemicPauseVerdict> {
    const { runId, projectId, step, error, signal } = req;

    // (1) Already canceled on entry — settle immediately, open nothing.
    if (signal?.aborted) return Promise.resolve<SystemicPauseVerdict>('canceled');

    const channel = this.channelFor(projectId);
    const source = systemicPauseSourceForStep(step.id);

    return new Promise<SystemicPauseVerdict>((resolve) => {
      // targetId latch (copied from ReviewQueueHumanGate): ignore events until the
      // pause item's id is known, then match only that item.
      let targetId: string | null = null;
      let settled = false;
      let cancelTimer: (() => void) | null = null;

      const cleanup = (): void => {
        this.events.off(channel, onChange);
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        if (cancelTimer) {
          cancelTimer();
          cancelTimer = null;
        }
      };

      // Resume the parked run, then settle (retry / giveup). Mirrors
      // blockingItemsGate.finishProceed — a run parked awaiting_review must be
      // released to 'running' before the controller re-runs or fails the step.
      const settleResumed = (verdict: 'retry' | 'giveup'): void => {
        if (settled) return;
        settled = true;
        cleanup();
        this.logger?.info('[SystemicPauseGate] pause cleared; resuming run', { runId, verdict });
        void this.parker.maybeResumeRun(runId).finally(() => resolve(verdict));
      };

      const onChange = (payload: unknown): void => {
        if (settled || targetId === null || !isReviewItemChangeLike(payload)) return;
        if (payload.reviewItemId !== targetId) return;
        if (payload.action === 'resolved') settleResumed('retry');
        else if (payload.action === 'dismissed') settleResumed('giveup');
      };

      // Cancel path: dismiss the pause item (fail-soft) and settle 'canceled'
      // DIRECTLY — the cancel path owns the terminal transition, so we do NOT
      // resume the run. settled is set synchronously so no concurrent event/timer
      // can also settle mid-dismiss.
      const onAbort = signal
        ? (): void => {
            if (settled) return;
            settled = true;
            cleanup();
            this.logger?.info('[SystemicPauseGate] pause aborted (run canceled)', {
              runId,
              stepId: step.id,
            });
            const done = (): void => resolve('canceled');
            if (targetId) {
              void this.items
                .dismiss({ projectId, reviewItemId: targetId, resolution: 'canceled' })
                .catch((err) =>
                  this.logger?.warn('[SystemicPauseGate] cancel-dismiss failed (fail-soft)', {
                    runId,
                    error: errMessage(err),
                  }),
                )
                .finally(done);
            } else {
              done();
            }
          }
        : undefined;

      // (2) Subscribe BEFORE find/create so a fast resolution cannot slip through.
      this.events.on(channel, onChange);
      if (signal && onAbort) signal.addEventListener('abort', onAbort);

      // (3)-(5) find-or-create the pause item, park the run, arm the auto-resume timer.
      const openAndPark = async (): Promise<void> => {
        // (3) Reattach to an already-pending pause item (crash-resume / a repeated
        // systemic failure on the SAME step) instead of minting a duplicate.
        let id = await this.items.findPending(runId, source);
        if (settled) return;
        if (id) {
          this.logger?.info('[SystemicPauseGate] re-attached to an already-open pause item', {
            runId,
            stepId: step.id,
            reviewItemId: id,
          });
        } else {
          const nowMs = this.now();
          const delayMs = parseLimitResetDelayMs(error, nowMs);
          const reason = describeSystemicReason(error);
          id = await this.items.create({
            runId,
            projectId,
            title: `Run paused — ${reason} at step '${step.name}'`,
            body: buildPauseBody(step, error, reason, nowMs, delayMs),
            source,
          });
          if (settled) return;
        }
        targetId = id;

        // (5) Auto-resume timer: when the error advertises a reset time, resolve the
        // pause item as the orchestrator actor at delay + buffer. The resolve emits
        // the 'resolved' event (→ onChange settles 'retry'); settleResumed('retry')
        // in the finally is belt-and-braces if the event never arrives. A concurrent
        // human action already settled it ⇒ resolve is a no-op (invalid_status).
        const timerNowMs = this.now();
        const timerDelayMs = parseLimitResetDelayMs(error, timerNowMs);
        if (timerDelayMs !== null) {
          const itemId = id;
          cancelTimer = this.setTimer(() => {
            if (settled) return;
            void this.items
              .resolve({ projectId, reviewItemId: itemId, resolution: 'auto-retry: usage limit reset' })
              .catch((err) =>
                this.logger?.warn('[SystemicPauseGate] auto-resume resolve failed (already settled?)', {
                  runId,
                  error: errMessage(err),
                }),
              )
              .finally(() => settleResumed('retry'));
          }, timerDelayMs + AUTO_RESUME_BUFFER_MS);
        }

        // (4) Park the run — fail-soft (mirror blockingItemsGate): a park failure is
        // logged and we KEEP awaiting the clear event; do NOT settle.
        try {
          await this.parker.parkForBlockingReview(runId);
        } catch (err) {
          this.logger?.warn('[SystemicPauseGate] park failed (continuing to await clear)', {
            runId,
            error: errMessage(err),
          });
        }
      };

      void openAndPark().catch((err) => {
        // A broken items adapter (find/create threw) must never strand the run —
        // give up so the failure follows the normal path.
        if (settled) return;
        this.logger?.warn('[SystemicPauseGate] could not open pause item; giving up', {
          runId,
          stepId: step.id,
          error: errMessage(err),
        });
        settleResumed('giveup');
      });
    });
  }
}
