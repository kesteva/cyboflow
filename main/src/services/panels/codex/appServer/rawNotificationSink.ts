import type Database from 'better-sqlite3';
import type { Logger } from '../../../../utils/logger';
import { perfBump } from '../../../perfTracer';
import type { AppServerNotification } from './client';

export const CODEX_RAW_NOTIFICATION_EVENT_TYPE = 'codex_app_server_notification';

// Delta chunks exist only to paint the live UI as the turn streams; the
// finished output/message is persisted again in full on 'item/completed'.
// These two methods alone were measured at ~161 MB of the production
// raw_events table, so we never persist them here.
const NON_PERSISTED_DELTA_METHODS: ReadonlySet<string> = new Set([
  'item/commandExecution/outputDelta',
  'item/agentMessage/delta',
]);

/**
 * Methods whose payload is a CUMULATIVE SNAPSHOT rather than an increment: each
 * notification restates the whole current value, so every row but the last is
 * dead weight the moment its successor arrives. Appending them was measured at
 * ~80 MB / 37k rows of the production raw_events table, ~98% of it superseded:
 *   - turn/diff/updated        68 MB over 3,739 rows for 138 turns — the FULL
 *                              working-tree diff re-sent per update (one turn
 *                              logged 113 snapshots growing 70 KB -> 95 KB).
 *   - thread/tokenUsage/updated 7 MB over 16,795 rows — `last` is one model
 *                              request's usage and `total` is cumulative per
 *                              thread per app-server process, re-sent ~25x per
 *                              turn. Keeping only the newest row per turn loses
 *                              the per-request history, so usage accounting never
 *                              reads it: the exact per-request source is the
 *                              append-only rawResponse/completed, which is NOT
 *                              in this map.
 *   - account/rateLimits/updated 5 MB over 16,800 rows carrying just 276
 *                              distinct payloads — an account-wide gauge
 *                              re-persisted on every event tick.
 *
 * Each maps to a dedup_key slug. Keyed by run + turn (+ method), the INSERT
 * below becomes last-write-wins via the partial unique index on dedup_key
 * (migration 071), so the table keeps exactly one current row per turn instead
 * of the whole superseded history. Migration 112 collapses the rows already
 * written and stamps the same keys on the survivors, so a live run upserts onto
 * its historical row rather than starting a second one beside it.
 *
 * This is deliberately NOT the delta-method treatment above: those are dropped
 * because a durable final lands elsewhere, whereas these have no other home —
 * the final snapshot IS the data, and it is preserved.
 */
const SNAPSHOT_DEDUP_SLUGS: ReadonlyMap<string, string> = new Map([
  ['turn/diff/updated', 'turn-diff'],
  ['thread/tokenUsage/updated', 'token-usage'],
  ['account/rateLimits/updated', 'rate-limits'],
]);

/**
 * Reads `params.turnId` when present. account/rateLimits/updated carries no
 * turn scope at all (its params are just `{ rateLimits }`), so it collapses to
 * one row per RUN — correct for an account-wide gauge, and the reason this
 * returns undefined rather than throwing.
 */
function readTurnId(params: AppServerNotification['params']): string | undefined {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    return undefined;
  }
  const turnId = (params as Record<string, unknown>).turnId;
  return typeof turnId === 'string' ? turnId : undefined;
}

/**
 * Builds the dedup identity for a snapshot method, or undefined for every other
 * method (which stays append-only). The 'run' literal is the no-turn-scope
 * sentinel; it cannot collide with a real turn id, which is a UUID.
 */
function buildSnapshotDedupKey(
  runId: string,
  notification: AppServerNotification,
): string | undefined {
  const slug = SNAPSHOT_DEDUP_SLUGS.get(notification.method);
  if (slug === undefined) {
    return undefined;
  }
  return `codex:${slug}:${runId}:${readTurnId(notification.params) ?? 'run'}`;
}

export class CodexRawNotificationSink {
  private readonly insertStmt: Database.Statement;

  constructor(
    private readonly db: Database.Database,
    private readonly logger?: Logger,
  ) {
    // Prepare once at construction (better-sqlite3 best practice, matching
    // RawEventsSink). `persist` runs synchronously on the main thread for every
    // app-server notification of an active turn — re-preparing per call added
    // avoidable main-thread work on a hot path.
    //
    // One statement serves both shapes: append-only rows pass dedup_key = NULL,
    // which the partial index ignores, so the ON CONFLICT clause can never fire
    // for them. Snapshot rows pass a key and take the DO UPDATE branch.
    this.insertStmt = this.db.prepare(
      `INSERT INTO raw_events (run_id, event_type, payload_json, created_at, dedup_key)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(dedup_key) WHERE dedup_key IS NOT NULL DO UPDATE SET
         payload_json = excluded.payload_json,
         created_at = excluded.created_at`,
    );
  }

  persist(runId: string, notification: AppServerNotification): void {
    if (NON_PERSISTED_DELTA_METHODS.has(notification.method)) {
      return;
    }
    perfBump('raw.codex');
    try {
      this.insertStmt.run(
        runId,
        CODEX_RAW_NOTIFICATION_EVENT_TYPE,
        JSON.stringify(notification),
        new Date().toISOString(),
        buildSnapshotDedupKey(runId, notification) ?? null,
      );
    } catch (error) {
      this.logger?.warn(
        `[CodexRawNotificationSink] failed to persist ${notification.method} for run ${runId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
