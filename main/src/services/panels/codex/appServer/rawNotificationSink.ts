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
    this.insertStmt = this.db.prepare(
      `INSERT INTO raw_events (run_id, event_type, payload_json, created_at)
       VALUES (?, ?, ?, ?)`,
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
      );
    } catch (error) {
      this.logger?.warn(
        `[CodexRawNotificationSink] failed to persist ${notification.method} for run ${runId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
