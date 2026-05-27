/**
 * cyboflow.events sub-router — server-sent subscription procedures.
 *
 * Uses the tRPC v11 native async-generator subscription pattern.
 *
 * Standalone-typecheck invariant: no imports from 'electron',
 * 'better-sqlite3', or main/src/services/*.
 */
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { router, protectedProcedure, publicProcedure } from '../trpc';
import { throttleAsyncIterator } from '../throttle';
import type { ApprovalCreatedEvent, ApprovalDecidedEvent } from '../../../../../shared/types/approvals';
import type { StuckDetectedEvent } from '../../../../../shared/types/stuckDetection';

// ---------------------------------------------------------------------------
// Placeholder event types — swapped out in stream-parser-to-main epic.
// Exported so the inferred AppRouter type can reference them without the
// TS4023 "cannot be named" error.
// ---------------------------------------------------------------------------

/** Placeholder for the rich StreamEvent type (defined in stream-parser epic). */
export interface StreamEvent {
  runId: string;
  type: string;
  payload: unknown;
}

// ---------------------------------------------------------------------------
// Approval events EventEmitter
// ---------------------------------------------------------------------------

/**
 * Main-process EventEmitter for approval lifecycle events.
 *
 * Exported so the future ApprovalRouter service can call:
 *   approvalEvents.emit('created', event satisfies ApprovalCreatedEvent);
 *   approvalEvents.emit('decided', event satisfies ApprovalDecidedEvent);
 *
 * The emitter is module-level (singleton) so both the router and the service
 * share the same instance without circular imports.
 */
export const approvalEvents = new EventEmitter();

/**
 * Main-process EventEmitter for stuck-run lifecycle events.
 * The emit-source bridge (StuckDetector → stuckEvents) belongs in
 * stuck-detection-and-observability's instantiation step in main/src/index.ts.
 * Until that wiring lands, the subscription procedure exists and is
 * type-safe but yields no events — sufficient to eliminate the
 * "No subscription-procedure on path" runtime error.
 */
export const stuckEvents = new EventEmitter();

/**
 * Main-process EventEmitter for question lifecycle events.
 *
 * QuestionRouter (questionRouter.ts) emits on this emitter via the bridge
 * wired in main/src/index.ts:
 *   questionEvents.emit('created', event satisfies QuestionCreatedEvent);
 *   questionEvents.emit('answered', event satisfies QuestionAnsweredEvent);
 *
 * The emitter is module-level (singleton) so both the questionsRouter and
 * main/src/index.ts share the same instance without circular imports.
 */
export const questionEvents = new EventEmitter();

/**
 * Main-process EventEmitter for workflow step-transition events.
 *
 * stepTransitionBridge.ts emits on this emitter via:
 *   stepTransitionEvents.emit('transition', event satisfies WorkflowStepTransitionEvent);
 *
 * The emitter is module-level (singleton) so both the executor lifecycle hooks
 * and any future TASK-766 tRPC subscription can share the same instance without
 * circular imports.
 */
export const stepTransitionEvents = new EventEmitter();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Placeholder async iterator that yields nothing but respects the abort signal.
 *
 * When `signal.aborted` fires, the iterator returns cleanly so the
 * subscription can tear down without leaking. Used for stream events where
 * the real EventEmitter source is wired in the stream-parser-to-main epic.
 */
function makePlaceholderAsyncIterator<T>(signal: AbortSignal): AsyncIterable<T> {
  return {
    // eslint-disable-next-line require-yield -- placeholder: yields nothing, only awaits abort signal
    async *[Symbol.asyncIterator]() {
      if (signal.aborted) return;
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
    },
  };
}

/**
 * Wraps an EventEmitter event as an async iterable that respects an AbortSignal.
 *
 * When `signal` fires, the iterator returns without yielding any further
 * events, allowing the tRPC subscription to tear down cleanly and preventing
 * listener leaks.
 *
 * Exported so questions.ts (and any future single-feature router) can import
 * this helper without duplicating the implementation.
 */
export function eventToAsyncIterable<T>(
  emitter: EventEmitter,
  eventName: string,
  signal: AbortSignal,
): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      if (signal.aborted) return;
      const queue: T[] = [];
      let resolve: (() => void) | null = null;

      const onEvent = (payload: T) => {
        queue.push(payload);
        resolve?.();
        resolve = null;
      };

      const onAbort = () => {
        resolve?.();
        resolve = null;
      };

      emitter.on(eventName, onEvent);
      signal.addEventListener('abort', onAbort, { once: true });

      try {
        while (!signal.aborted) {
          if (queue.length > 0) {
            yield queue.shift() as T;
          } else {
            await new Promise<void>((res) => {
              resolve = res;
            });
          }
        }
      } finally {
        emitter.off(eventName, onEvent);
        signal.removeEventListener('abort', onAbort);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const eventsRouter = router({
  /**
   * Update the macOS dock badge to reflect the current pending-approval count.
   *
   * Called from the renderer's reviewQueueStore after every queue mutation
   * (addApproval, removeApproval, replaceAll) so the badge stays in sync
   * with the visible queue without requiring a main-process queue mirror.
   *
   * Uses publicProcedure: the dock badge is a local UI affordance; no session
   * auth is required for a renderer→main local IPC call.
   */
  setBadgeCount: publicProcedure
    .input(z.object({ count: z.number().int().min(0).max(9999) }))
    .mutation(({ input, ctx }) => {
      ctx.setDockBadge(input.count);
      return { ok: true };
    }),

  /**
   * Subscribe to stream events for a specific run.
   *
   * Events are throttled to 60Hz before crossing the IPC boundary to prevent
   * queue saturation during high-throughput Bash output or large file reads.
   * The raw EventEmitter source (consumed by the raw_events DB writer) remains
   * unthrottled — only the per-subscription IPC copy is rate-limited.
   */
  onStreamEvent: protectedProcedure
    .input(z.object({ runId: z.string() }))
    .subscription(async function* ({ signal }) {
      // signal may be undefined if the client doesn't support abort (tRPC v11
      // SSE transport always provides it, but the type allows undefined).
      const abortSignal = signal ?? new AbortController().signal;
      const source = makePlaceholderAsyncIterator<StreamEvent>(abortSignal);
      for await (const ev of throttleAsyncIterator(source, 60)) {
        yield ev;
      }
    }),

  /**
   * Subscribe to approval-created notifications (all runs).
   *
   * No throttle: approval events are infrequent (human-gated) and must not
   * be coalesced — each approval request must surface to the reviewer.
   *
   * Backed by the module-level `approvalEvents` EventEmitter. The future
   * ApprovalRouter service emits on this emitter when a gate is opened.
   * Until then, the subscription yields no events but tears down cleanly.
   */
  onApprovalCreated: protectedProcedure
    .subscription(async function* ({ signal }): AsyncGenerator<ApprovalCreatedEvent> {
      const abortSignal = signal ?? new AbortController().signal;
      const source = eventToAsyncIterable<ApprovalCreatedEvent>(
        approvalEvents,
        'created',
        abortSignal,
      );
      for await (const ev of source) {
        yield ev;
      }
    }),

  /**
   * Subscribe to approval-decided notifications (all runs).
   *
   * Emitted when an approval gate is approved, rejected, or expires.
   * The store removes the item from the queue on receipt.
   */
  onApprovalDecided: protectedProcedure
    .subscription(async function* ({ signal }): AsyncGenerator<ApprovalDecidedEvent> {
      const abortSignal = signal ?? new AbortController().signal;
      const source = eventToAsyncIterable<ApprovalDecidedEvent>(
        approvalEvents,
        'decided',
        abortSignal,
      );
      for await (const ev of source) {
        yield ev;
      }
    }),

  /**
   * Subscribe to stuck-run detection notifications (all runs).
   *
   * Emitted when StuckDetector transitions a workflow_run to status='stuck'.
   * The emit-source bridge (StuckDetector → stuckEvents) is wired in
   * main/src/index.ts by the stuck-detection-and-observability epic.
   * Until that wiring lands, the subscription yields no events but tears
   * down cleanly — eliminating the "No subscription-procedure on path
   * cyboflow.events.onStuckDetected" runtime error from reviewQueueSlice.
   */
  onStuckDetected: protectedProcedure
    .subscription(async function* ({ signal }): AsyncGenerator<StuckDetectedEvent> {
      const abortSignal = signal ?? new AbortController().signal;
      const source = eventToAsyncIterable<StuckDetectedEvent>(
        stuckEvents,
        'detected',
        abortSignal,
      );
      for await (const ev of source) {
        yield ev;
      }
    }),
});
