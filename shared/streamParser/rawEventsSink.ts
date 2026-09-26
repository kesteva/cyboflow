/**
 * RawEventsSink — Persistence bridge between EventRouter and the raw_events table.
 *
 * Subscribes to a runId's event stream and inserts every typed provider event
 * into the raw_events append-only audit log. Designed as a fail-soft component:
 * an INSERT error is logged at WARN level and the pipeline continues — a transient
 * DB hiccup must NOT kill the orchestrator.
 *
 * Schema reference: main/src/database/migrations/006_cyboflow_schema.sql
 *
 * Columns written:
 *   run_id       — the runId passed to attachToRouter
 *   event_type   — top-level discriminant ('system' | 'assistant' | 'user' |
 *                  'result' | 'stream_event' | 'unknown'). Note: the catch-all
 *                  UnknownStreamEvent uses kind='__unknown__'; we normalize that
 *                  to event_type='unknown' in the table.
 *   payload_json — JSON.stringify of the full typed event object
 *   created_at   — ISO-8601 timestamp at the moment of insert (TEXT column)
 *   dedup_key    — stable identity for replaceable synthetic events; NULL for
 *                  the append-only provider event stream
 *
 * Note: 006_cyboflow_schema.sql does NOT include an event_subtype column. Subtype
 * information (e.g. system/init, result/success) is available inside payload_json
 * and can be queried via SQLite's JSON functions if needed.
 *
 * Note: the constructor's `options.skipEventTypes` suppresses PERSISTENCE only —
 * routing/subscription via EventRouter is unaffected, so live UI streaming (which
 * is fed in-memory, not from raw_events) never notices. This exists to stop
 * writing rows with exactly one reader (the debug "Data Stream" tab) that bloat
 * the append-only table: delta-class events (e.g. 'stream_event') already have a
 * durable final stored alongside them, and Codex's 'agent_unknown' wrap is
 * already persisted raw by CodexRawNotificationSink, so persisting it again here
 * is a pure double-write.
 */

import type { EventRouter } from './eventRouter';
import type { ILogger } from './types';
import type { ClaudeStreamEvent } from '../types/claudeStream';

import { derivePersistedEventType } from './derivers';
import type { PersistableStreamEvent } from './derivers';

/**
 * Perf-counter hook, injected by the Electron main process at boot
 * (main/src/index.ts) so this module stays free of main/src/services
 * imports. A no-op when nothing is wired — perf tracing is opt-in
 * (CYBOFLOW_PERF_TRACE=1) and shared/ must not depend on the tracer.
 */
let perfBump: (name: string, n?: number) => void = () => {};
export function setStreamParserPerfBump(fn: (name: string, n?: number) => void): void {
  perfBump = fn;
}

/**
 * Top-level payload key carrying the producing SDK process's identity (see
 * RawEventsSink.setProcessInstanceId). Persistence-only bookkeeping: readers that
 * replay stored payloads to the UI strip it.
 */
export const PROCESS_INSTANCE_ID_FIELD = 'cyboflow_process_instance_id';

/** The prepared-statement surface the sink uses — run() only, no reads. */
interface RawEventsSinkStatement {
  run(...params: unknown[]): unknown;
}

/**
 * The NARROW database surface RawEventsSink actually needs: `prepare()` → `run()`.
 * Structurally satisfied by both a real better-sqlite3 `Database.Database` and the
 * orchestrator's `DatabaseLike`, so callers holding either construct the sink
 * without casts (DynamicWorkflowTracker only has DatabaseLike). Widening what the
 * sink calls on `db` MUST widen this type — never reach for the full
 * better-sqlite3 handle here, or the DatabaseLike call site breaks at runtime
 * while compiling clean.
 */
export interface RawEventsSinkDb {
  prepare(sql: string): RawEventsSinkStatement;
}

export class RawEventsSink<TEvent extends PersistableStreamEvent = ClaudeStreamEvent> {
  private readonly db: RawEventsSinkDb;
  private readonly logger: Pick<ILogger, 'warn'> | undefined;
  private readonly insertStmt: RawEventsSinkStatement;
  private upsertSubagentUsageStmt: RawEventsSinkStatement | undefined;
  private readonly skipEventTypes: ReadonlySet<string>;
  /** See {@link setProcessInstanceId}; null = stamp nothing. */
  private processInstanceId: string | null = null;

  /**
   * Map from runId → teardown function returned by EventRouter.onRun().
   * Used by dispose() to remove individual or all listeners.
   */
  private readonly teardowns = new Map<string, () => void>();

  constructor(
    db: RawEventsSinkDb,
    logger?: Pick<ILogger, 'warn'>,
    options?: { skipEventTypes?: readonly string[] },
  ) {
    this.db = db;
    this.logger = logger;
    this.skipEventTypes = new Set(options?.skipEventTypes ?? []);

    // Prepare once at construction time (better-sqlite3 best practice).
    // 006_cyboflow_schema.sql has no event_subtype column; subtype data lives in payload_json.
    this.insertStmt = this.db.prepare(
      'INSERT INTO raw_events (run_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)',
    );
  }

  /**
   * Persist a cumulative subagent-usage snapshot.
   *
   * The partial unique index on dedup_key requires its predicate to be repeated
   * in the conflict target. Reusing a key replaces the earlier snapshot instead
   * of summing it or leaving stale partial usage behind.
   *
   * Fail-soft: catches all errors, logs at WARN, and returns — never re-throws.
   */
  persistSubagentUsage(runId: string, event: unknown, dedupKey: string): void {
    try {
      this.upsertSubagentUsageStmt ??= this.db.prepare(`
        INSERT INTO raw_events (run_id, event_type, payload_json, created_at, dedup_key)
        VALUES (?, 'subagent_usage', ?, ?, ?)
        ON CONFLICT(dedup_key) WHERE dedup_key IS NOT NULL DO UPDATE SET
          payload_json = excluded.payload_json,
          created_at = excluded.created_at
      `);
      const payloadJson = JSON.stringify(event);
      const createdAt = new Date().toISOString();
      this.upsertSubagentUsageStmt.run(runId, payloadJson, createdAt, dedupKey);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger?.warn(
        `[rawEventsSink] subagent usage upsert failed for runId=${runId}: ${message}`,
      );
    }
  }

  /**
   * Stamp every event persisted from now on with a top-level
   * `cyboflow_process_instance_id` — the identity of the SDK process that
   * produced it (minted by ClaudeCodeManager per `query()`), so the usage fold
   * can segment the process-cumulative `modelUsage` counters exactly. Persistence
   * only: the routed event objects are never touched. null stops stamping.
   */
  setProcessInstanceId(processInstanceId: string | null): void {
    this.processInstanceId = processInstanceId;
  }

  /**
   * Subscribe this sink to all events for a given runId on the router.
   *
   * Each event dispatched for `runId` will be persisted as one row in raw_events.
   * Calling attachToRouter for the same runId twice replaces the previous listener
   * (disposes the old one first to avoid duplicate inserts).
   */
  attachToRouter(router: EventRouter<TEvent>, runId: string): void {
    // If already attached for this runId, detach first to avoid duplicate rows.
    const existing = this.teardowns.get(runId);
    if (existing !== undefined) {
      existing();
    }

    const handler = (event: TEvent): void => {
      this.handleEvent(runId, event);
    };

    const teardown = router.onRun(runId, handler);
    this.teardowns.set(runId, teardown);
  }

  /**
   * Detach the EventRouter listener(s) and stop persisting events.
   *
   * @param runId — If provided, only detach the listener for that run.
   *                If omitted, detach all listeners.
   *
   * Idempotent: safe to call multiple times; subsequent calls are no-ops.
   */
  dispose(runId?: string): void {
    if (runId !== undefined) {
      const teardown = this.teardowns.get(runId);
      if (teardown !== undefined) {
        teardown();
        this.teardowns.delete(runId);
      }
      return;
    }

    // No runId — dispose all.
    for (const teardown of this.teardowns.values()) {
      teardown();
    }
    this.teardowns.clear();
  }

  /**
   * Insert a single event row into raw_events.
   *
   * Fail-soft: catches all errors, logs at WARN, and returns — never re-throws.
   */
  private handleEvent(runId: string, event: TEvent): void {
    try {
      const eventType = derivePersistedEventType(event);
      if (this.skipEventTypes.has(eventType)) {
        return;
      }
      perfBump('raw.claude');
      const payloadJson = JSON.stringify(
        this.processInstanceId === null
          ? event
          : { ...event, [PROCESS_INSTANCE_ID_FIELD]: this.processInstanceId },
      );
      const createdAt = new Date().toISOString();
      this.insertStmt.run(runId, eventType, payloadJson, createdAt);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger?.warn(
        `[rawEventsSink] insert failed for runId=${runId}: ${message}`,
      );
    }
  }
}
