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
import { parseGateResolution } from '../../../../shared/types/reviews';
import type { HumanGateDecision } from './types';

/**
 * The gate review item as the resolver reads it back AFTER arming — title, body
 * and current lifecycle. The body matters because it is composed INSIDE the
 * gate-open transaction (humanStepManager), so nothing outside can know what the
 * human is being asked until the item exists.
 */
export interface HumanGateItemSnapshot {
  title: string;
  body: string;
  status: 'pending' | 'resolved' | 'dismissed';
  /** The raw resolution note; null while pending, and on a note-less resolve. */
  resolution: string | null;
}

/** What {@link HumanGateRequest.onOpened} is handed when a gate goes live. */
export interface HumanGateOpenedSnapshot {
  reviewItemId: string;
  title: string;
  body: string;
  /** True when this gate was ALREADY open and the resolver re-attached to it. */
  resumed: boolean;
}

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
  /**
   * Fired ONCE, AFTER the resolver has armed itself on the gate item (i.e. after
   * `targetId` is set), with the item as it exists at that moment.
   *
   * FIRE-AND-FORGET, by contract: it is scheduled on a microtask, never awaited,
   * and a throw or a rejection is logged and swallowed. The gate promise must be
   * settleable by the human at any instant — including while this hook is still
   * running — so nothing here may delay, block or reject it. The hook exists for
   * work that needs the gate's real body (which only exists once the item does),
   * such as consulting the run supervisor for a recommendation to annotate onto
   * the item. Absent => nothing fires (today's behaviour).
   */
  onOpened?: (snapshot: HumanGateOpenedSnapshot) => void | Promise<void>;
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
  /**
   * Side-effects that must LAND before the walk wakes on a resolved gate.
   *
   * `ReviewItemRouter.emitChange` fires synchronously inside the resolve, and
   * this resolver settles the controller's gate promise straight off that emit —
   * so by the time `resolveReviewItem` returns to its own caller, the controller
   * has already advanced and the next step is spawning. Anything that has to be
   * TRUE for that next step (a design bound to the ideas it will read, a
   * thoroughness level stamped on the project) therefore cannot live after the
   * resolve: it races the resumed step and wins only because spawning an SDK turn
   * happens to be slow. `settleResumed` is the one place that already owns
   * "do this before waking the walk" — the same ordering `maybeResumeRun` needs —
   * so the side-effects hang here.
   *
   * AWAITED before the verdict resolves, and fail-soft: a rejection is logged and
   * the gate still resolves. A side-effect that throws must never strand a run at
   * a gate the human already answered. Optional, so pre-existing openers/fakes
   * keep compiling; absent ⇒ no side-effects (today's behavior).
   */
  onGateResolved?(args: {
    runId: string;
    stepId: string;
    /** The raw resolution note; null on a dismissal or a note-less resolve. */
    resolution: string | null;
    /** True when the human DISMISSED the gate (a rejection) rather than resolving it. */
    dismissed: boolean;
  }): Promise<void>;
  /**
   * Read the gate review item back by id, or null.
   *
   * SYNCHRONOUS and FAIL-SOFT (null on a missing row, a missing table, or any
   * thrown read): the resolver calls it on the hot path right after arming, and
   * a read that cannot answer must degrade to today's behaviour — await the
   * change event — never abort a run parked at a gate. Optional so pre-existing
   * openers and fakes keep compiling; absent => the resolver skips both the
   * already-settled check and the onOpened snapshot's title/body.
   */
  readGateItem?(reviewItemId: string): HumanGateItemSnapshot | null;
}

/**
 * Map a review-item `resolution` to the three-way gate verdict.
 *
 * PREFIX FIRST. A resolution written by `composeGateResolution` carries the
 * verdict as an anchored prefix (`revise: only AR-2 matters`), and that verdict
 * is authoritative — the note after the colon is the human's own words and is
 * never sniffed. This is the bug the grammar fixes: "revise: the architecture
 * rejects empty input" used to read as a REJECT (the word 'rejects' appears in
 * the note) and END the run instead of looping the design steps back.
 *
 * LEGACY FALLBACK, unchanged, for every row written before the grammar (and for
 * free text a human typed by hand): an explicit 'reject', 'revise', or 'retry'
 * anywhere in the resolution selects a verdict; anything else — including an
 * empty note — is an APPROVE, because resolving the blocking gate item IS the
 * human's act of approval unless they said otherwise. 'retry' is an ALIAS for
 * 'revise': a human answering a gate / escalation with "retry" means re-run this
 * step, never approve-and-skip it — so it must route through the revise
 * (loop-back / re-run) path, not approve. Precedence: 'reject' first (a
 * rejection wins over any revise/retry phrasing in the same note), then
 * 'revise', then 'retry' → 'revise', else approve.
 */
export function parseGateVerdict(resolution: string | null | undefined): HumanGateDecision {
  const parsed = parseGateResolution(resolution);
  if (parsed !== null) return parsed.verdict;
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
      const settleResumed = (
        verdict: HumanGateDecision,
        resolution: string | null = null,
        dismissed = false,
      ): void => {
        settled = true;
        cleanup();
        // Gate side-effects run BEFORE the resume and before the verdict resolves:
        // the resumed step must see the world the human's decision created (a
        // bound design, a stamped level), and this is the last instant at which
        // that is still guaranteed rather than a race against SDK spawn latency.
        // Fail-soft — a throwing side-effect logs and the gate still resolves,
        // because stranding a run at a gate the human already answered is worse
        // than a missing side-effect.
        const sideEffects = this.opener.onGateResolved
          ? this.opener.onGateResolved({ runId, stepId: step.id, resolution, dismissed }).catch((err: unknown) => {
              this.logger?.warn('[ReviewQueueHumanGate] gate side-effects failed (fail-soft)', {
                runId,
                stepId: step.id,
                error: err instanceof Error ? err.message : String(err),
              });
            })
          : Promise.resolve();
        // .catch swallows a resume failure so the walk can never hang on it;
        // .finally guarantees the walk wakes exactly once the flip has landed.
        void sideEffects.then(() => {
          if (this.opener.maybeResumeRun) {
            return this.opener
              .maybeResumeRun(runId)
              .catch(() => undefined)
              .finally(() => resolve(verdict));
          }
          resolve(verdict);
          return undefined;
        });
      };
      const onChange = (payload: unknown): void => {
        if (settled || targetId === null || !isReviewItemChangeLike(payload)) return;
        if (payload.reviewItemId !== targetId) return;
        if (payload.action === 'resolved') {
          const resolution = payload.item?.resolution ?? null;
          settleResumed(parseGateVerdict(resolution), resolution);
        } else if (payload.action === 'dismissed') {
          // A dismissed gate is treated as a rejection (the human declined it).
          settleResumed('reject', null, true);
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

          // LOST-EVENT WINDOW. The listener is armed before openHumanGate, but
          // `targetId` — the filter every event is matched against — is only set
          // HERE. A human who resolves the item in the gap (trivially reachable on
          // a resume: findPendingGate is an awaited round-trip on an item that has
          // been sitting in the queue) fires the ONLY 'resolved' event for this
          // gate while targetId is still null, and onChange drops it. The run then
          // waits forever on a gate nobody will answer again. Re-reading the item
          // right after arming closes the window: whatever the event said is still
          // true in the row.
          // The read is wrapped because this `.then` body's trailing `.catch`
          // REJECTS the gate: a throwing reader (a missing table, a corrupt row)
          // would turn a degraded read-back into an aborted run parked at a gate
          // nobody can answer. Swallowed, it degrades to exactly the pre-read
          // behaviour — await the change event.
          let item: HumanGateItemSnapshot | null = null;
          try {
            item = this.opener.readGateItem?.(effectiveId) ?? null;
          } catch (err) {
            this.logger?.warn('[ReviewQueueHumanGate] gate item read-back failed (fail-soft)', {
              runId,
              stepId: step.id,
              reviewItemId: effectiveId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          if (item?.status === 'resolved') {
            this.logger?.info('[ReviewQueueHumanGate] gate was already resolved when armed', {
              runId,
              stepId: step.id,
              reviewItemId: effectiveId,
            });
            settleResumed(parseGateVerdict(item.resolution), item.resolution);
            return;
          }
          if (item?.status === 'dismissed') {
            this.logger?.info('[ReviewQueueHumanGate] gate was already dismissed when armed', {
              runId,
              stepId: step.id,
              reviewItemId: effectiveId,
            });
            settleResumed('reject', null, true);
            return;
          }

          // Gate-open hook. Scheduled on a microtask and NEVER awaited: the human
          // may settle this gate while the hook is still running, and that is
          // fine — a hook that writes to the item finds it non-pending and its
          // write is refused, which is the designed outcome, not a race to win.
          if (req.onOpened) {
            const snapshot: HumanGateOpenedSnapshot = {
              reviewItemId: effectiveId,
              title: item?.title ?? step.name,
              body: item?.body ?? '',
              resumed: id === null,
            };
            void Promise.resolve()
              .then(() => req.onOpened?.(snapshot))
              .catch((err: unknown) => {
                this.logger?.warn('[ReviewQueueHumanGate] onOpened hook failed (fail-soft)', {
                  runId,
                  stepId: step.id,
                  reviewItemId: effectiveId,
                  error: err instanceof Error ? err.message : String(err),
                });
              });
          }
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
