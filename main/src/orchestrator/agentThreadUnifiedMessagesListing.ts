/**
 * agentThreadUnifiedMessagesListing — SELECT helper that reconstructs the
 * global-agent chat thread's history as fully-correlated `UnifiedMessage[]`
 * (tool_use folded together with its matching tool_result), exactly like the
 * run + quick-session paths.
 *
 * Exports `selectAgentThreadUnifiedMessages(db, threadId, logger?)` (the full
 * history) and `selectAgentThreadMessagesPage(db, threadId, window, logger?)`
 * (a newest-`limit` or from-`fromIndex` window + the total) so the tRPC
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
 * `../../../shared/streamParser` barrel — the SAME import `runUnifiedMessagesListing.ts`
 * uses. The barrel only re-exports classes whose own imports are limited to
 * `shared/types` + its local `./types`, so it does NOT pull in 'electron',
 * 'better-sqlite3', or a concrete service.
 *
 * Logger note (per project CODE-PATTERNS.md): the optional `logger` is THREADED into
 * both `TypedEventNarrowing` and `MessageProjection` — omitting it would silently
 * turn their observability into a no-op. `LoggerLike` has no `verbose` method, so
 * the call site adapts `verbose` to the logger's `debug` channel, matching the
 * adaptation in `runUnifiedMessagesListing.ts` / `runEventBridge.ts`.
 *
 * Ordering: insertion order (id ASC). Rows are append-only and `created_at` is
 * the column DEFAULT (CURRENT_TIMESTAMP) at insert, so id order IS the
 * created_at order the run path sorts by.
 *
 * INCREMENTAL PROJECTION CACHE. The global thread is long-lived and only ever
 * appended to (agentThreadDbStore is the sole writer; nothing deletes rows short
 * of an agent_threads cascade). Re-reading and re-projecting the WHOLE thread on
 * every call blocked the main thread for 1s+ on a ~50k-event thread — and the
 * rail calls this on every mount (e.g. leaving a session for home after a
 * dismiss) and on every live-tail tick. So the projection state (narrower +
 * MessageProjection + the projected messages) is kept per (db, threadId) and each
 * call folds in only rows with id > the last one consumed. This is sound because
 * MessageProjection already updates earlier messages IN PLACE (tool_result →
 * tool_call status/result, coalesced assistant segments) — exactly what a full
 * re-projection would produce. A shrunk thread (max id below what was
 * consumed) drops the cached state and rebuilds from scratch.
 */
import {
  agentStreamEventToClaudeStreamEvent,
  MessageProjection,
  TypedEventNarrowing,
} from '../../../shared/streamParser';
import type { UnifiedMessage } from '../../../shared/types/unifiedMessage';
import { isAgentStreamEvent } from '../../../shared/types/agentStream';
import type { DatabaseLike, LoggerLike } from './types';

// ---------------------------------------------------------------------------
// Internal DB row shape
// ---------------------------------------------------------------------------

interface DbThreadEventRow {
  id: number;
  payloadJson: string;
  createdAt: string;
}

interface ThreadProjectionState {
  narrower: TypedEventNarrowing;
  projection: MessageProjection;
  messages: UnifiedMessage[];
  /** Highest agent_thread_events.id folded in so far (0 = none). */
  lastRowId: number;
}

/**
 * Per-DatabaseLike, per-thread projection state. Keyed on the adapter object so
 * independent databases (tests, a swapped handle) never share state; the
 * production tRPC context passes one stable adapter for the app's lifetime.
 * The loggers threaded into a state are the ones passed when it was built.
 */
const projectionCache = new WeakMap<DatabaseLike, Map<string, ThreadProjectionState>>();

function newState(threadId: string, logger?: LoggerLike): ThreadProjectionState {
  // Thread the logger into BOTH pipeline stages. LoggerLike has no `verbose`
  // method (TypedEventNarrowing expects one), so adapt verbose -> debug; the
  // logger's own `warn` satisfies MessageProjection's Pick<ILogger, 'warn'>.
  const narrowingLogger = logger ? { verbose: (m: string) => logger.debug(m) } : undefined;
  const projectionLogger = logger ? { warn: (m: string) => logger.warn(m) } : undefined;
  return {
    narrower: new TypedEventNarrowing(narrowingLogger),
    projection: new MessageProjection(threadId, projectionLogger),
    messages: [],
    lastRowId: 0,
  };
}

/** Fold one persisted row into the state (mutates it). */
function foldRow(state: ThreadProjectionState, row: DbThreadEventRow): void {
  state.lastRowId = row.id;
  let raw: unknown;
  try {
    raw = JSON.parse(row.payloadJson);
  } catch {
    // Unparseable persisted payload — skip (defensive; the sink writes valid JSON).
    return;
  }
  const event = isAgentStreamEvent(raw) ? agentStreamEventToClaudeStreamEvent(raw) : state.narrower.narrow(raw);
  const projected = state.projection.project(event);
  if (projected !== null) {
    // Overwrite the MessageProjection-generated timestamp with the persisted one.
    // The shallow copy keeps `segments`/`metadata` shared with the projection's
    // own record, so later in-place updates (see MessageProjection's CONTRACT)
    // still land on this cached message.
    state.messages.push({ ...projected, timestamp: new Date(row.createdAt).toISOString() });
  }
}

/**
 * Bring the cached projection for `threadId` up to date and return it.
 * Reads only rows newer than the last one folded in.
 */
function refreshThreadProjection(db: DatabaseLike, threadId: string, logger?: LoggerLike): ThreadProjectionState {
  let perDb = projectionCache.get(db);
  if (!perDb) {
    perDb = new Map();
    projectionCache.set(db, perDb);
  }

  // MAX(id) is a single seek on idx_agent_thread_events_thread — cheap enough
  // to run on every call (a COUNT(*) here walked the whole ~50k-entry index
  // range, ~70ms whenever those pages were out of the page cache).
  const maxRow = db
    .prepare('SELECT MAX(id) AS maxId FROM agent_thread_events WHERE thread_id = ?')
    .get(threadId) as { maxId: number | null } | undefined;
  const maxId = maxRow?.maxId ?? 0;

  let state = perDb.get(threadId);
  if (state && maxId < state.lastRowId) {
    // The thread shrank underneath us (its rows were removed — the
    // agent_threads cascade — or the handle was swapped) — rebuild. Rows are
    // AUTOINCREMENT and append-only, so nothing can land BELOW the watermark.
    state = undefined;
  }
  if (!state) {
    state = newState(threadId, logger);
    perDb.set(threadId, state);
  }
  if (maxId === state.lastRowId) return state;

  const rows = db
    .prepare(
      `SELECT
         ate.id           AS id,
         ate.payload_json AS payloadJson,
         ate.created_at   AS createdAt
       FROM agent_thread_events ate
       WHERE ate.thread_id = ? AND ate.id > ?
       ORDER BY ate.id ASC`,
    )
    .all(threadId, state.lastRowId) as DbThreadEventRow[];
  for (const row of rows) foldRow(state, row);
  return state;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return the reconstructed chat history for `threadId` as correlated
 * `UnifiedMessage[]`, oldest-first.
 *
 * Folds ALL `agent_thread_events` rows for the thread (every event_type — the
 * projection pipeline itself decides what renders) through
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
 * @returns UnifiedMessage[] in insertion order (a fresh array; the message
 *          objects are shared with the cache — treat them as read-only).
 */
export function selectAgentThreadUnifiedMessages(
  db: DatabaseLike,
  threadId: string,
  logger?: LoggerLike,
): UnifiedMessage[] {
  return refreshThreadProjection(db, threadId, logger).messages.slice();
}

/** One window of the agent thread plus where it starts in the full history. */
export interface AgentThreadMessagesPage {
  messages: UnifiedMessage[];
  /** Index of `messages[0]` in the thread's full projected history. */
  startIndex: number;
  /** Total projected messages in the thread. */
  totalCount: number;
}

/** Which slice of the history to return; omitted = the whole history. */
export interface AgentThreadMessagesWindow {
  /** The newest `limit` messages. */
  limit?: number;
  /**
   * Every message from this absolute index onward — wins over `limit`. The
   * rail anchors its window with it so a live refetch GROWS the window rather
   * than sliding it (projected messages only ever append, so indices are stable).
   */
  fromIndex?: number;
}

/**
 * A window of the projected history for `threadId` (oldest-first) plus the
 * thread's total message count, so the rail can render a bounded transcript
 * and offer "load earlier".
 */
export function selectAgentThreadMessagesPage(
  db: DatabaseLike,
  threadId: string,
  window: AgentThreadMessagesWindow = {},
  logger?: LoggerLike,
): AgentThreadMessagesPage {
  const all = refreshThreadProjection(db, threadId, logger).messages;
  let startIndex = 0;
  if (window.fromIndex !== undefined) {
    startIndex = Math.min(Math.max(0, window.fromIndex), all.length);
  } else if (window.limit !== undefined) {
    startIndex = Math.max(0, all.length - window.limit);
  }
  return { messages: all.slice(startIndex), startIndex, totalCount: all.length };
}
