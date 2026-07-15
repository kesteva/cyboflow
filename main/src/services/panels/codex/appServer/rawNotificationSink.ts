import type Database from 'better-sqlite3';
import type { Logger } from '../../../../utils/logger';
import type { AppServerNotification } from './client';

export const CODEX_RAW_NOTIFICATION_EVENT_TYPE = 'codex_app_server_notification';

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
