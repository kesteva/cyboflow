-- Migration 072: one-time cleanup of raw_events noise classes.
--
-- Two write-path defects let low-value rows dominate the table (~290 MB of a
-- 542 MB production payload, measured 2026-07-20):
--   1. Codex app-server notifications were persisted TWICE per event: raw as
--      'codex_app_server_notification' (CodexRawNotificationSink) AND wrapped
--      as 'agent_unknown' by the generic RawEventsSink attached in
--      codexSdkManager.
--   2. Streaming delta events were persisted forever even though their durable
--      finals land alongside them: Claude 'stream_event' token deltas (finals =
--      the 'assistant' rows), and the Codex delta notification methods
--      item/commandExecution/outputDelta + item/agentMessage/delta (finals
--      re-persisted in item/completed).
--
-- The write paths are fixed in the same change-set (RawEventsSink
-- skipEventTypes option + CodexRawNotificationSink method filter); this
-- migration removes the rows already written. The only reader of these types
-- is the Data Stream tab's 1:1 historical replay (accepted degradation: old
-- runs replay finals without deltas). Chat transcripts, context-usage scans,
-- usage rollups, and every Insights query filter on other event types and are
-- untouched.
--
-- Freed pages go to SQLite's internal freelist; the file itself is shrunk by
-- the conditional VACUUM in database.ts (maybeVacuumAfterBulkDelete) — VACUUM
-- cannot run inside this migration's transaction.

DELETE FROM raw_events WHERE event_type IN ('agent_unknown', 'stream_event');

DELETE FROM raw_events
WHERE event_type = 'codex_app_server_notification'
  AND json_extract(payload_json, '$.method') IN
    ('item/commandExecution/outputDelta', 'item/agentMessage/delta');
