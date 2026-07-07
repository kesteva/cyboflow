-- Migration 056: per-project visual-verify judge-call budget + cost telemetry.
--
-- (Runs after 055_visual_verification. Depends only on projects (006) +
--  verification_requests (055). See docs/visual-verification-design.md §"L5".)
--
-- The L5 low-confidence tier adds a PER-PROJECT cap on paid VLM (vision) calls on
-- top of today's per-RUN cap (the cappedVlmJudge decorator). It does two things:
--
-- (1) projects.visual_verify_budget_calls — an INTEGER, NULLABLE. When NULL (the
--     default for every existing + new project) the project has UNLIMITED judge
--     calls — byte-identical to before this layer. When a human sets it, the
--     scheduler routes a VLM call to the SAME non-blocking 'needs human visual
--     review' finding path (low_confidence) once the project's cumulative
--     judge_calls_used reaches it — never a FAIL, never a fabricated pass.
--
-- (2) verification_requests.judge_calls_used — an INTEGER NOT NULL DEFAULT 0. It
--     is the per-request VLM-call counter the scheduler increments when it makes a
--     real vision call (an SSIM-match or a budget-skip makes none, so it stays 0).
--     SUM(judge_calls_used) per project is the budget-aggregation read AND the
--     cost-telemetry signal (how many paid calls a project has spent). The counter
--     UPDATE is the scheduler's OWN request row (consistent with markTerminal —
--     not a router-owned table), so it stays within the no-direct-write rules.
--
-- NOTE: No `IF NOT EXISTS` on the ALTERs — SQLite ALTER TABLE does not support it,
-- and one ADD COLUMN per statement is required. Re-running raises 'duplicate column
-- name: ...', which is exactly the idempotency signal runFileBasedMigrations() in
-- database.ts uses to skip already-applied files (same mechanism 013/032/036 use).
--
-- NOTE: No explicit BEGIN/COMMIT — runFileBasedMigrations() wraps every file in a
-- this.transaction(...) call.

-- (1) Per-project judge-call budget cap (NULL = unlimited, the default).
ALTER TABLE projects ADD COLUMN visual_verify_budget_calls INTEGER;

-- (2) Per-request VLM-call counter (budget aggregation + cost telemetry).
ALTER TABLE verification_requests ADD COLUMN judge_calls_used INTEGER NOT NULL DEFAULT 0;
