/**
 * cyboflow.events sub-router — server-sent subscription procedures.
 *
 * Uses the tRPC v11 native async-generator subscription pattern.
 * Subscription bodies use placeholder iterators that respect the
 * `AbortSignal` but yield no events. Later epics (stream-parser-to-main)
 * replace `makePlaceholderAsyncIterator` with the real EventEmitter-backed
 * iterator.
 *
 * Standalone-typecheck invariant: no imports from 'electron',
 * 'better-sqlite3', or main/src/services/*.
 */
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { throttleAsyncIterator } from '../throttle';

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

/** Placeholder for the ApprovalCreated event (defined in approval-router epic). */
export interface ApprovalCreated {
  approvalId: string;
  runId: string;
  toolName: string;
}

// ---------------------------------------------------------------------------
// Placeholder iterator
// ---------------------------------------------------------------------------

/**
 * An async iterator that yields nothing but respects the abort signal.
 *
 * When `signal.aborted` fires, the iterator returns cleanly so the
 * subscription can tear down without leaking. Future epics replace this
 * with an EventEmitter-backed iterator that actually produces events.
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

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const eventsRouter = router({
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
   */
  onApprovalCreated: protectedProcedure
    .subscription(async function* ({ signal }) {
      const abortSignal = signal ?? new AbortController().signal;
      const source = makePlaceholderAsyncIterator<ApprovalCreated>(abortSignal);
      for await (const ev of source) {
        yield ev;
      }
    }),
});
