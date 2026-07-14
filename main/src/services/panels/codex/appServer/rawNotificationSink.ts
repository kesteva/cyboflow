import type Database from 'better-sqlite3';
import type { Logger } from '../../../../utils/logger';
import type { AppServerNotification } from './client';

export const CODEX_RAW_NOTIFICATION_EVENT_TYPE = 'codex_app_server_notification';

export class CodexRawNotificationSink {
  constructor(
    private readonly db: Database.Database,
    private readonly logger?: Logger,
  ) {}

  persist(runId: string, notification: AppServerNotification): void {
    try {
      this.db.prepare(
        `INSERT INTO raw_events (run_id, event_type, payload_json, created_at)
         VALUES (?, ?, ?, ?)`,
      ).run(
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
