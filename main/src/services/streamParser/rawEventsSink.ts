/**
 * RawEventsSink — Persistence bridge between EventRouter and the raw_events table.
 *
 * Subscribes to a runId's event stream and inserts every typed ClaudeStreamEvent
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
 *
 * Note: 006_cyboflow_schema.sql does NOT include an event_subtype column. Subtype
 * information (e.g. system/init, result/success) is available inside payload_json
 * and can be queried via SQLite's JSON functions if needed.
 */

import type Database from 'better-sqlite3';
import type { EventRouter } from './eventRouter';
import type { ClaudeStreamEvent } from '../../../../shared/types/claudeStream';
import type { ILogger } from './types';

/**
 * Derives the event_type string for storage.
 *
 * The UnknownStreamEvent uses `kind: '__unknown__'` instead of a `type` field
 * (by design — it cannot collide with any real wire type). We normalize both
 * `__unknown__` and any future `unknown` variant to the string 'unknown' in the
 * table so queries can filter on a stable value.
 */
function deriveEventType(event: ClaudeStreamEvent): string {
  if ('kind' in event && event.kind === '__unknown__') {
    return 'unknown';
  }
  // All real wire variants have a `type` field.
  return (event as { type: string }).type;
}

export class RawEventsSink {
  private readonly db: Database.Database;
  private readonly logger: Pick<ILogger, 'warn'> | undefined;
  private readonly insertStmt: Database.Statement;

  /**
   * Map from runId → teardown function returned by EventRouter.onRun().
   * Used by dispose() to remove individual or all listeners.
   */
  private readonly teardowns = new Map<string, () => void>();

  constructor(db: Database.Database, logger?: Pick<ILogger, 'warn'>) {
    this.db = db;
    this.logger = logger;

    // Prepare once at construction time (better-sqlite3 best practice).
    // 006_cyboflow_schema.sql has no event_subtype column; subtype data lives in payload_json.
    this.insertStmt = this.db.prepare(
      'INSERT INTO raw_events (run_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)',
    );
  }

  /**
   * Subscribe this sink to all events for a given runId on the router.
   *
   * Each event dispatched for `runId` will be persisted as one row in raw_events.
   * Calling attachToRouter for the same runId twice replaces the previous listener
   * (disposes the old one first to avoid duplicate inserts).
   */
  attachToRouter(router: EventRouter, runId: string): void {
    // If already attached for this runId, detach first to avoid duplicate rows.
    const existing = this.teardowns.get(runId);
    if (existing !== undefined) {
      existing();
    }

    const handler = (event: ClaudeStreamEvent): void => {
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
  private handleEvent(runId: string, event: ClaudeStreamEvent): void {
    try {
      const eventType = deriveEventType(event);
      const payloadJson = JSON.stringify(event);
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
