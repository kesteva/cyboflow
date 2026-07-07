/**
 * Human-gate resolution for the programmatic model (Stage 2). In the orchestrated
 * model an agent calls AskUserQuestion at a human gate; in the programmatic model
 * the HOST must pause and await a human decision. This module provides:
 *
 *   - `HumanGateResolver` — the narrow interface the ControllerHost depends on
 *     (so the host is testable with a fake), returning the three-way verdict.
 *   - `parseGateVerdict` — pure mapping of a free-text review-item `resolution`
 *     string to 'approve' | 'reject' | 'revise'.
 *   - `ReviewQueueHumanGate` — the production resolver: it opens a BLOCKING
 *     decision review item via the injected gate opener (in production
 *     `HumanStepManager.openHumanGate`, which also parks the run in
 *     awaiting_review), then awaits that item's resolution on the injected review
 *     emitter (`reviewItemChangeEvents`) and maps the resolution to a verdict.
 *
 * The opener + emitter are injected (not imported concretely) so the resolver is
 * unit-testable end-to-end; only the composition-root wiring of the real
 * HumanStepManager + reviewItemChangeEvents is left un-fakeable.
 */
import type { EventEmitter } from 'events';
import type { WorkflowStep } from '../../../../shared/types/workflows';
import type { LoggerLike } from '../types';
import type { HumanGateDecision } from './types';

export interface HumanGateRequest {
  runId: string;
  projectId: number;
  step: WorkflowStep;
  /**
   * Fires when the run is canceled while parked at this gate. When it aborts, the
   * resolver settles the awaiting Promise to 'abort' and removes its
   * reviewItemChangeEvents listener — so a canceled run can never hang here and
   * the listener can never leak. Already-aborted on entry short-circuits to
   * 'abort' without opening a gate.
   */
  signal?: AbortSignal;
}

/** What the ControllerHost depends on to resolve a human gate. */
export interface HumanGateResolver {
  resolve(req: HumanGateRequest): Promise<HumanGateDecision>;
}

/**
 * Opens a blocking human-decision gate for a run+step and returns the minted
 * review-item id (or null when the gate could not be opened — e.g. the run was
 * not 'running'). Satisfied in production by HumanStepManager.openHumanGate.
 */
export interface HumanGateOpener {
  openHumanGate(runId: string, stepId: string, stepName: string): Promise<string | null>;
  /**
   * Find an ALREADY-pending gate review-item id for (runId, stepId), or null
   * (crash-safe resume). When `openHumanGate` returns null because the gate is
   * already open — the common case after a restart re-drives a run parked at a
   * gate — the resolver attaches to this existing item and awaits its resolution
   * instead of rejecting. Optional so pre-existing openers/fakes keep compiling.
   */
  findPendingGate?(runId: string, stepId: string): Promise<string | null>;
  /**
   * Aggregate-unblock resume primitive: flip the run awaiting_review -> running
   * once no blocking item remains (in production HumanStepManager.maybeResumeRun,
   * the SAME method the blocking-items / systemic-pause gates use). The resolver
   * OWNS this resume before waking the walk on a resolved/dismissed gate so the
   * run row is back in 'running' before the controller proceeds — see onChange.
   * Optional so pre-existing openers/fakes keep compiling; when absent the walk
   * wakes directly (the router's trailing resume is then the only flip).
   *
   * Aggregate-unblock nuance: when ANOTHER blocking item is still pending,
   * maybeResumeRun refuses (returns false) and the walk still wakes — the
   * BlockingReviewItemsGate then re-parks at the next step boundary. That is
   * existing designed behavior, not a bug.
   */
  maybeResumeRun?(runId: string): Promise<boolean>;
}

/**
 * Map a free-text review-item `resolution` to the three-way gate verdict.
 *
 * Convention (mirrors questionRouter's isApproveAnswer string-sniffing): an
 * explicit 'reject', 'revise', or 'retry' anywhere in the resolution selects a
 * verdict; anything else — including an empty note — is an APPROVE, because
 * resolving the blocking gate item IS the human's act of approval unless they
 * said otherwise. 'retry' is an ALIAS for 'revise': a human answering a gate /
 * escalation with "retry" means re-run this step, never approve-and-skip it — so
 * it must route through the revise (loop-back / re-run) path, not approve.
 * Precedence: 'reject' first (a rejection wins over any revise/retry phrasing in
 * the same note), then 'revise', then 'retry' → 'revise', else approve.
 */
export function parseGateVerdict(resolution: string | null | undefined): HumanGateDecision {
  const r = (resolution ?? '').trim().toLowerCase();
  if (r.includes('reject')) return 'reject';
  if (r.includes('revise')) return 'revise';
  if (r.includes('retry')) return 'revise';
  return 'approve';
}

/** Minimal shape of a review-item change event consumed here (no `any`). */
interface ReviewItemChangeLike {
  reviewItemId: string;
  action: 'created' | 'resolved' | 'dismissed';
  item?: { resolution?: string | null };
}

function isReviewItemChangeLike(v: unknown): v is ReviewItemChangeLike {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return typeof e.reviewItemId === 'string' && typeof e.action === 'string';
}

export class ReviewQueueHumanGate implements HumanGateResolver {
  constructor(
    private readonly opener: HumanGateOpener,
    private readonly events: EventEmitter,
    private readonly channelFor: (projectId: number) => string,
    private readonly logger?: LoggerLike,
  ) {}

  resolve(req: HumanGateRequest): Promise<HumanGateDecision> {
    const { runId, projectId, step, signal } = req;
    const channel = this.channelFor(projectId);

    // Already canceled before we open anything — settle immediately, open nothing.
    if (signal?.aborted) return Promise.resolve('abort');

    return new Promise<HumanGateDecision>((resolve, reject) => {
      // Subscribe BEFORE opening the gate so a fast resolution cannot slip
      // through the gap. The target id is set synchronously once openHumanGate
      // resolves; events for other items (or before the id is known) are ignored.
      let targetId: string | null = null;
      let settled = false;
      const cleanup = (): void => {
        this.events.off(channel, onChange);
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      };
      // Resume the parked run BEFORE waking the walk, then settle the verdict.
      // The run parked awaiting_review at this gate; the router's trailing
      // maybeResumeRun (fired after ReviewItemRouter emits 'resolved') races the
      // walk. If the walk wakes first and this is the run's LAST step, the
      // end-of-walk drained-rest tries a strict 'running'->'awaiting_review' flip
      // against a row STILL in 'awaiting_review' (rejected as an "expected race"),
      // and the router's trailing maybeResumeRun then flips it to 'running' with
      // no live walk — a zombie run stuck 'running' forever. Owning the resume
      // here (mirrors blockingItemsGate.finishProceed / systemicPauseGate
      // .settleResumed) guarantees the row is back in 'running' BEFORE the
      // controller proceeds, so the drained-rest never fires against a stale
      // 'awaiting_review' row and the router's trailing resume is a no-op.
      // Aggregate-unblock nuance: if another blocking item is still pending,
      // maybeResumeRun returns false and the walk still wakes — the
      // BlockingReviewItemsGate re-parks at the next step boundary (designed).
      const settleResumed = (verdict: HumanGateDecision): void => {
        settled = true;
        cleanup();
        // .catch swallows a resume failure so the walk can never hang on it;
        // .finally guarantees the walk wakes exactly once the flip has landed.
        if (this.opener.maybeResumeRun) {
          void this.opener
            .maybeResumeRun(runId)
            .catch(() => undefined)
            .finally(() => resolve(verdict));
        } else {
          resolve(verdict);
        }
      };
      const onChange = (payload: unknown): void => {
        if (settled || targetId === null || !isReviewItemChangeLike(payload)) return;
        if (payload.reviewItemId !== targetId) return;
        if (payload.action === 'resolved') {
          settleResumed(parseGateVerdict(payload.item?.resolution));
        } else if (payload.action === 'dismissed') {
          // A dismissed gate is treated as a rejection (the human declined it).
          settleResumed('reject');
        }
      };
      // Cancel path: a canceled run aborts the awaiting Promise (settling to
      // 'abort') and removes BOTH listeners, so the gate can never hang or leak.
      const onAbort = signal
        ? (): void => {
            if (settled) return;
            settled = true;
            cleanup();
            this.logger?.info('[ReviewQueueHumanGate] gate aborted (run canceled)', { runId, stepId: step.id });
            resolve('abort');
          }
        : undefined;

      this.events.on(channel, onChange);
      if (signal && onAbort) signal.addEventListener('abort', onAbort);

      this.opener
        .openHumanGate(runId, step.id, step.name)
        .then(async (id) => {
          if (settled) return; // aborted while opening
          let effectiveId = id;
          // Crash-safe resume: openHumanGate returns null when a gate for this step
          // is ALREADY pending (idempotency). On a re-driven run that's the gate we
          // want — attach to it and await rather than reject.
          if (!effectiveId && this.opener.findPendingGate) {
            effectiveId = await this.opener.findPendingGate(runId, step.id);
            if (settled) return;
            if (effectiveId) {
              this.logger?.info('[ReviewQueueHumanGate] re-attached to an already-open gate (resume)', {
                runId,
                stepId: step.id,
                reviewItemId: effectiveId,
              });
            }
          }
          if (!effectiveId) {
            settled = true;
            cleanup();
            reject(new Error(`ReviewQueueHumanGate: could not open human gate for run ${runId} step '${step.id}'`));
            return;
          }
          targetId = effectiveId;
          this.logger?.info('[ReviewQueueHumanGate] human gate open; awaiting resolution', {
            runId,
            stepId: step.id,
            reviewItemId: effectiveId,
          });
        })
        .catch((err) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    });
  }
}
