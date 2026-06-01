-- Migration 013: Add substrate column to workflow_runs (IDEA-013 / TASK-806).
--
-- This is the dual-substrate selection seam. Every workflow run is stamped at
-- launch with the CLI substrate it executes under:
--   'sdk'         — the in-process Claude Agent SDK substrate (default).
--   'interactive' — the interactive PTY substrate (lands in TASK-808/S3).
--
-- The value is resolved once (see substrateResolver.ts) and is IMMUTABLE for
-- the lifetime of a run — there is intentionally no UPDATE path. Every legacy
-- row reads back 'sdk' via the NOT NULL DEFAULT, so existing runs are
-- byte-identical in behavior (zero-behavior-change invariant).
--
-- The CHECK domain is kept literally ('sdk','interactive') to match the
-- CliSubstrate union in shared/types/substrate.ts. If a future substrate is
-- ever added, this CHECK domain and the CliSubstrate union MUST be widened
-- together — they are a single contract split across SQL + TypeScript.
--
-- NOTE: No `IF NOT EXISTS` — SQLite ALTER TABLE does not support it. Re-running
-- this migration raises 'duplicate column name: substrate', which is exactly
-- the idempotency signal runFileBasedMigrations() in database.ts uses to skip
-- already-applied files (same mechanism migration 011 relies on).
--
-- NOTE: No explicit BEGIN/COMMIT here — runFileBasedMigrations() in database.ts
-- wraps every file in a this.transaction(...) call.

ALTER TABLE workflow_runs
  ADD COLUMN substrate TEXT NOT NULL DEFAULT 'sdk'
    CHECK (substrate IN ('sdk','interactive'));
