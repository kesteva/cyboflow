-- Migration 036: visual-verification run-stamp columns + verification_requests.
--
-- (Runs after 035_artifacts. Depends only on workflow_runs (011); the
--  intervening migrations do not alter it. See docs/visual-verification-design.md.)
--
-- This is the persistence layer for the layered visual-verification MVP. It does
-- two things:
--
-- (1) Stamps three IMMUTABLE columns onto workflow_runs, resolved ONCE at run
--     launch via the override ladder (visualVerificationResolver.ts) — siblings to
--     `substrate` (migration 013) and `execution_model` (migration 032):
--       verify_enabled — 0/1; whether this run participates in visual verification.
--       verify_type    — the resolved VerificationType (a member of the union in
--                        shared/types/visualVerification.ts), or NULL when disabled.
--       verify_chain   — JSON array of VisualBackendId (the live fall-forward chain
--                        = FALLBACK_CHAINS[type] ∩ healthy backends), or NULL when
--                        disabled.
--     Like substrate / execution_model these are resolve-once, NO-update-path
--     columns: a run's verification config is fixed for its lifetime (the
--     scheduler reads run.verify_* and never rewrites them). Every legacy row reads
--     back verify_enabled=0 / verify_type=NULL / verify_chain=NULL via the
--     defaults, so existing runs are byte-identical in behavior (zero-behavior-change).
--
-- (2) Creates the verification_requests work queue — one row per verification a
--     lane agent asks for. The scheduler leases (status='leased'), captures +
--     judges (status='running'), then writes a terminal verdict. status mirrors
--     the REQUEST_STATUS union in shared/types/visualVerification.ts — a single
--     contract split across SQL CHECK + TypeScript; if a status is ever added BOTH
--     must be widened together (exactly the CliSubstrate / migration 013 pairing).
--     The (status, enqueued_at) index serves the FIFO drain SELECT; the (run_id)
--     index serves per-run cancel / fan-in / cleanup.
--
-- NOTE: No `IF NOT EXISTS` on the ALTERs — SQLite ALTER TABLE does not support it,
-- and one ADD COLUMN per statement is required. Re-running raises 'duplicate column
-- name: ...', which is exactly the idempotency signal runFileBasedMigrations() in
-- database.ts uses to skip already-applied files (same mechanism migration 013/032
-- rely on).
--
-- NOTE: No explicit BEGIN/COMMIT — runFileBasedMigrations() wraps every file in a
-- this.transaction(...) call.

-- (1) Immutable run-stamp columns (one ADD COLUMN per statement).
ALTER TABLE workflow_runs ADD COLUMN verify_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workflow_runs ADD COLUMN verify_type TEXT;
ALTER TABLE workflow_runs ADD COLUMN verify_chain TEXT;

-- (2) The verification work queue. One row per requested visual check.
--   status           — REQUEST_STATUS lifecycle (CHECK domain mirrors TypeScript).
--   verify_type      — the resolved VerificationType for this request.
--   deliverable_json — the serialized VerificationRequestInput (intent, url/htmlPath,
--                      viewports, baselineKey, typeOverride).
--   chain_json       — JSON array of VisualBackendId the scheduler walks (resolved
--                      live chain); NULL until resolved.
--   current_backend  — the VisualBackendId currently attempting (NULL when queued).
--   attempt          — fall-forward attempt counter across the chain.
--   verdict_json     — the serialized VerdictV1 once judged.
--   error_message    — last runtime error (drives fall-forward / skip / timeout).
--   enqueued_at / leased_at / ended_at — lifecycle timestamps.
CREATE TABLE IF NOT EXISTS verification_requests (
  id               TEXT PRIMARY KEY,
  run_id           TEXT NOT NULL,
  project_id       INTEGER NOT NULL,
  status           TEXT NOT NULL DEFAULT 'queued'
                     CHECK (status IN (
                       'queued', 'leased', 'running', 'passed', 'failed',
                       'low_confidence', 'skipped', 'timeout'
                     )),
  verify_type      TEXT NOT NULL,
  deliverable_json TEXT NOT NULL,
  chain_json       TEXT,
  current_backend  TEXT,
  attempt          INTEGER NOT NULL DEFAULT 0,
  verdict_json     TEXT,
  error_message    TEXT,
  enqueued_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  leased_at        DATETIME,
  ended_at         DATETIME,
  FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_verification_requests_status
  ON verification_requests(status, enqueued_at);
CREATE INDEX IF NOT EXISTS idx_verification_requests_run
  ON verification_requests(run_id);
