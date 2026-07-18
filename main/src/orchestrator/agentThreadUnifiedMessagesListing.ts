/**
 * agentThreadUnifiedMessagesListing — SELECT helper that reconstructs the
 * global-agent chat thread's history as fully-correlated `UnifiedMessage[]`
 * (tool_use folded together with its matching tool_result), exactly like the
 * run + quick-session paths.
 *
 * Exports `selectAgentThreadUnifiedMessages(db, threadId, logger?)` so the tRPC
 * `cyboflow.agentThread.listMessages` procedure has a testable, framework-free
 * implementation.
 *
 * This is a near-literal copy of `runUnifiedMessagesListing.ts` — the ONLY
 * difference is the SELECT source: `agent_thread_events` keyed by `thread_id`
 * (the run-less agent thread has no `workflow_runs` row, so its transcript lives
 * in a dedicated thread-keyed table — S0.2 §2.2) instead of `raw_events` keyed by
 * `run_id`. Every projection collaborator below the SQL is table-agnostic and is
 * reused UNCHANGED: `TypedEventNarrowing` / `MessageProjection` /
 * `agentStreamEventToClaudeStreamEvent` / `isAgentStreamEvent`. `MessageProjection`
 * is id-agnostic (its constructor key is used only for correlation + a warn-log
 * string), so the `threadId` is passed directly as its correlation key.
 *
 * Import note: `MessageProjection`/`TypedEventNarrowing` come from the
 * `../services/streamParser` barrel — the SAME import `runUnifiedMessagesListing.ts`
 * uses. The barrel only re-exports classes whose own imports are limited to
 * `shared/types` + its local `./types`, so it does NOT pull in 'electron',
 * 'better-sqlite3', or a concrete service.
 *
 * Logger note (per project CLAUDE.md): the optional `logger` is THREADED into
 * both `TypedEventNarrowing` and `MessageProjection` — omitting it would silently
 * turn their observability into a no-op. `LoggerLike` has no `verbose` method, so
 * the call site adapts `verbose` to the logger's `debug` channel, matching the
 * adaptation in `runUnifiedMessagesListing.ts` / `runEventBridge.ts`.
 *
 * Ordering: created_at ASC, id ASC (tiebreaker) — same as the run path.
 */
import {
  agentStreamEventToClaudeStreamEvent,
  MessageProjection,
  TypedEventNarrowing,
} from '../services/streamParser';
import type { UnifiedMessage } from '../../../shared/types/unifiedMessage';
import { isAgentStreamEvent } from '../../../shared/types/agentStream';
import type { DatabaseLike, LoggerLike } from './types';

// ---------------------------------------------------------------------------
// Internal DB row shape
// ---------------------------------------------------------------------------

interface DbThreadEventRow {
  id: number;
  threadId: string;
  payloadJson: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return the reconstructed chat history for `threadId` as correlated
 * `UnifiedMessage[]`, oldest-first.
 *
 * Reads ALL `agent_thread_events` rows for the thread (every event_type — the
 * projection pipeline itself decides what renders) and folds them through
 * `TypedEventNarrowing` + `MessageProjection`. Events that project to `null`
 * (e.g. user/tool_result rows, stream_event deltas, unknown variants) are
 * absorbed into projection state and filtered out of the result, while their
 * correlation data (tool_result → tool_use) is retained so the matching
 * assistant tool_call message carries its result.
 *
 * The persisted `created_at` timestamp overwrites MessageProjection's
 * `new Date()` default so UI ordering reflects actual turn time.
 *
 * @param db       - Narrow DatabaseLike interface (real or test mock).
 * @param threadId - The agent_threads.id to scope the query AND the projection key.
 * @param logger   - Optional structured logger; threaded into the projection
 *                   pipeline so warnings/verbose diagnostics are not silently
 *                   dropped.
 * @returns UnifiedMessage[] sorted by created_at ASC, id ASC.
 */
export function selectAgentThreadUnifiedMessages(
  db: DatabaseLike,
  threadId: string,
  logger?: LoggerLike,
): UnifiedMessage[] {
  const rows = db
    .prepare(
      `SELECT
         ate.id           AS id,
         ate.payload_json AS payloadJson,
         ate.thread_id    AS threadId,
         ate.created_at   AS createdAt
       FROM agent_thread_events ate
       WHERE ate.thread_id = ?
       ORDER BY ate.created_at ASC, ate.id ASC`,
    )
    .all(threadId) as DbThreadEventRow[];

  // Thread the logger into BOTH pipeline stages. LoggerLike has no `verbose`
  // method (TypedEventNarrowing expects one), so adapt verbose -> debug; the
  // logger's own `warn` satisfies MessageProjection's Pick<ILogger, 'warn'>.
  const narrowingLogger = logger ? { verbose: (m: string) => logger.debug(m) } : undefined;
  const projectionLogger = logger ? { warn: (m: string) => logger.warn(m) } : undefined;

  const narrower = new TypedEventNarrowing(narrowingLogger);
  const projection = new MessageProjection(threadId, projectionLogger);

  const result: UnifiedMessage[] = [];

  for (const row of rows) {
    let raw: unknown;
    try {
      raw = JSON.parse(row.payloadJson);
    } catch {
      // Unparseable persisted payload — skip (defensive; the sink writes valid JSON).
      continue;
    }

    const event = isAgentStreamEvent(raw)
      ? agentStreamEventToClaudeStreamEvent(raw)
      : narrower.narrow(raw);
    const projected = projection.project(event);
    if (projected !== null) {
      // Overwrite the MessageProjection-generated timestamp with the persisted one.
      result.push({ ...projected, timestamp: new Date(row.createdAt).toISOString() });
    }
  }

  return result;
}
