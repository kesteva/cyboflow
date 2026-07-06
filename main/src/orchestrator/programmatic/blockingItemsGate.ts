/**
 * Blocking-review-items checkpoint for the programmatic execution model.
 *
 * In the orchestrated model an agent decides when to pause; in the programmatic
 * model the HOST walks the DAG and must stop the walk when the agent records a
 * PENDING BLOCKING review_item (e.g. a blocking finding) during a step — otherwise
 * the pipeline marches on past a defect the human must clear. This module provides:
 *
 *   - `BlockingItemsResolver` — the narrow interface `ProgrammaticRunHost` depends
 *     on (fakeable in tests). Called at each step boundary; returns 'proceed' once
 *     no blocking item remains, or 'canceled' if the run was canceled while parked.
 *   - `ReviewQueueBlockingItemsGate` — the production resolver: when the run has a
 *     pending blocking item it PARKS the run awaiting_review (via the injected
 *     opener — in production HumanStepManager.parkForBlockingReview), awaits the
 *     item(s) clearing on the injected review emitter (`reviewItemChangeEvents`),
 *     then RESUMES the run (maybeResumeRun) and returns 'proceed'.
 *
 * This is the aggregate-unblock invariant applied as a gate: unlike
 * ReviewQueueHumanGate (keyed on ONE gate decision item), this awaits the run's
 * whole pending-blocking count reaching zero, so a run parks for ANY blocking
 * item — including a blocking finding the agent recorded, which has no dedicated
 * gate mechanism. The opener + emitter are injected so the resolver is unit-testable
 * end-to-end.
 *
 * Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3', or
 * any concrete service in main/src/services/*.
 */
import type { EventEmitter } from 'events';
import type { LoggerLike } from '../types';

export interface BlockingItemsGateRequest {
  runId: string;
  projectId: number;
  /**
   * Fires when the run is canceled while parked at this checkpoint. On abort the
   * resolver settles to 'canceled' and removes its listener so a canceled run can
   * never hang here and the listener can never leak.
   */
  signal?: AbortSignal;
}

/** What the ControllerHost depends on to gate a step boundary on blocking items. */
export interface BlockingItemsResolver {
  /**
   * Resolve once the run has no pending blocking review_item. Returns immediately
   * with 'proceed' on the fast path (nothing blocking); otherwise parks the run
   * and awaits the item(s) clearing. 'canceled' when the run was canceled while
   * parked.
   */
  awaitClear(req: BlockingItemsGateRequest): Promise<'proceed' | 'canceled'>;
}

/**
 * The run-lifecycle primitives the gate needs. Satisfied in production by
 * HumanStepManager (hasPendingBlockingItems / parkForBlockingReview / maybeResumeRun).
 */
export interface BlockingItemsOpener {
  /** True when the run has >=1 pending blocking review_item. */
  hasPendingBlockingItems(runId: string): boolean;
  /** Park running -> awaiting_review (guarded) because a blocking item exists. */
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

export class ReviewQueueBlockingItemsGate implements BlockingItemsResolver {
  constructor(
    private readonly opener: BlockingItemsOpener,
    private readonly events: EventEmitter,
    private readonly channelFor: (projectId: number) => string,
    private readonly logger?: LoggerLike,
  ) {}

  awaitClear(req: BlockingItemsGateRequest): Promise<'proceed' | 'canceled'> {
    const { runId, projectId, signal } = req;

    // Already canceled — settle immediately, park nothing.
    if (signal?.aborted) return Promise.resolve<'canceled'>('canceled');
    // Fast path: nothing blocking → proceed without parking.
    if (!this.opener.hasPendingBlockingItems(runId)) return Promise.resolve<'proceed'>('proceed');

    return new Promise<'proceed' | 'canceled'>((resolve) => {
      let settled = false;
      const channel = this.channelFor(projectId);
      const cleanup = (): void => {
        this.events.off(channel, onChange);
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      };
      // Resume the parked run and settle 'proceed' (once, guarded by `settled`).
      const finishProceed = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        this.logger?.info('[BlockingItemsGate] blocking items cleared; resuming run', { runId });
        void this.opener.maybeResumeRun(runId).finally(() => resolve('proceed'));
      };
      const onChange = (payload: unknown): void => {
        if (settled || !isReviewItemChangeLike(payload)) return;
        // Only a triage transition can clear a blocking item.
        if (payload.action !== 'resolved' && payload.action !== 'dismissed') return;
        if (this.opener.hasPendingBlockingItems(runId)) return; // still blocked
        finishProceed();
      };
      const onAbort = signal
        ? (): void => {
            if (settled) return;
            settled = true;
            cleanup();
            this.logger?.info('[BlockingItemsGate] checkpoint aborted (run canceled)', { runId });
            resolve('canceled');
          }
        : undefined;

      // Subscribe BEFORE parking so a fast clear during the park cannot slip through.
      this.events.on(channel, onChange);
      if (signal && onAbort) signal.addEventListener('abort', onAbort);

      this.opener
        .parkForBlockingReview(runId)
        .then(() => {
          if (settled) return;
          // Re-check: the item(s) may have cleared between the fast-path check and
          // the park committing, in which case no more events will arrive.
          if (!this.opener.hasPendingBlockingItems(runId)) finishProceed();
          else {
            this.logger?.info('[BlockingItemsGate] run parked awaiting blocking review', { runId });
          }
        })
        .catch((err) => {
          // A park failure must not strand the walk — keep awaiting the clear event;
          // if items already cleared, re-check settles it.
          this.logger?.warn('[BlockingItemsGate] park failed (continuing to await clear)', {
            runId,
            error: err instanceof Error ? err.message : String(err),
          });
          if (!settled && !this.opener.hasPendingBlockingItems(runId)) finishProceed();
        });
    });
  }
}
