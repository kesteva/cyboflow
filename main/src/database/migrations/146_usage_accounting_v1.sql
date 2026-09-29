-- Migration 146: complete usage accounting (docs/proposals/codex-workflow-efficiency.md §5, 1d).
--
-- (145 is left free: an unmerged branch already claims it.)
--
-- run_usage.accounting_version — which fold produced the row. 0 = the legacy fold
--   (every row written before this change); the current value is
--   ACCOUNTING_VERSION in main/src/orchestrator/usageFold.ts. Rows at an older
--   version keep the legacy fold, so an un-backfilled run is never re-counted
--   under the new rules.
-- run_usage.coverage — how complete that run's accounting is. The writer stores the
--   most severe limitation, in this order from least to most severe:
--     complete | codex-run-level | codex-model-inferred |
--     claude-segments-inferred | codex-root-only | legacy
--   The DEFAULT labels every existing row 'legacy' explicitly.
--
-- codex_invocation_turns — the Codex turn(s) an invocation ran, written when
--   `turn/start` returns. It maps stored notifications (run, thread, turn) back to
--   the invocation that owned them. Invocations written before this change have no
--   row. A side table rather than an agent_invocations column: migrations 103 and
--   123 rebuild agent_invocations with an explicit column list, so a column added
--   after them would be dropped by any re-apply of either.
--
-- usage_backfill_runs / usage_backfill_marker — the one-shot boot backfill's
--   per-run progress and its completion marker (runUsageBackfill.ts). The marker is
--   written only after every run succeeded, so a failed boot resumes from the
--   progress table.
--
-- ALTER-only for run_usage (schema.sql does not carry it); the new tables use
-- IF NOT EXISTS. Re-running an ALTER raises 'duplicate column name',
-- which the runner tolerates per statement.

ALTER TABLE run_usage ADD COLUMN accounting_version INTEGER NOT NULL DEFAULT 0;

ALTER TABLE run_usage ADD COLUMN coverage TEXT NOT NULL DEFAULT 'legacy' CHECK (coverage IN (
  'complete',
  'codex-run-level',
  'codex-model-inferred',
  'claude-segments-inferred',
  'codex-root-only',
  'legacy'
));

CREATE TABLE IF NOT EXISTS codex_invocation_turns (
  agent_invocation_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  codex_turn_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (agent_invocation_id, codex_turn_id)
);

CREATE INDEX IF NOT EXISTS idx_codex_invocation_turns_run_thread
  ON codex_invocation_turns (run_id, thread_id, codex_turn_id);

CREATE TABLE IF NOT EXISTS usage_backfill_runs (
  run_id TEXT NOT NULL,
  accounting_version INTEGER NOT NULL,
  completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (run_id, accounting_version)
);

CREATE TABLE IF NOT EXISTS usage_backfill_marker (
  accounting_version INTEGER PRIMARY KEY,
  completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
