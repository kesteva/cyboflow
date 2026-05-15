/**
 * cyboflow.events sub-router — review-queue-ui epic (TASK-401).
 *
 * Subscription procedures for the approval event stream:
 *   - onApprovalCreated : subscription → ApprovalCreatedEvent
 *   - onApprovalDecided : subscription → ApprovalDecidedEvent
 *
 * Both subscriptions are backed by a main-process EventEmitter exported as
 * `approvalEvents`.  Until the ApprovalRouter service starts emitting on this
 * emitter, subscriptions yield no events — they wait on the AbortSignal and
 * return cleanly when the client disconnects.
 *
 * Standalone-typecheck invariant: no imports from 'electron',
 * 'better-sqlite3', or main/src/services/*.
 */
import { EventEmitter } from 'node:events';
import { router, protectedProcedure } from '../index';
import type { ApprovalCreatedEvent, ApprovalDecidedEvent } from '../../../../shared/types/approvals';

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wraps an EventEmitter event as an async iterable that respects an AbortSignal.
 *
 * When `signal` fires, the iterator returns without yielding any further
 * events, allowing the tRPC subscription to tear down cleanly and preventing
 * listener leaks.
 */
function eventToAsyncIterable<T>(
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
   * Subscribe to approval-created notifications (all runs).
   *
   * No throttle: approval events are infrequent (human-gated) and MUST NOT be
   * coalesced — every approval request must surface to the reviewer.
   *
   * The store calls `init()` (full resync via listPending) on each reconnect,
   * so delta events here are a convenience optimisation, not a correctness
   * requirement.
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
   * Emitted when an approval gate is approved, rejected, or expires.  The
   * store removes the item from the queue on receipt.
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
});
