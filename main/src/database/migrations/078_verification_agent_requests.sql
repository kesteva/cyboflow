-- Migration 078: verification-agent dual-format request plumbing (redesign §5.2/§5.6/§5.13).
--
-- docs/proposals/verification-agent-redesign.md replaces the capture-backend +
-- VLM-judge core with a centrally-deployed verification AGENT that composes and
-- drives a `VerificationTaskV1` (shared/types/visualVerification.ts) instead of a
-- bare intent/url. This migration opens the persistence channel for that agent
-- engine on the EXISTING verification_requests queue (migration 055) — five
-- ADDITIVE NULLABLE columns, each independently a no-op for a pre-upgrade reader:
--
--   task_json      — the composed VerificationTaskV1 (JSON), when the request was
--                     enqueued via the dual-write contract (§5.2). NULL for a
--                     legacy/degenerate request (bare intent, no task) — the
--                     EXISTING deliverable_json column keeps being written for
--                     EVERY request (dual-write), so every legacy reader (the
--                     recovery sweep, the Verify-Queue projection, runRecovery)
--                     keeps working unchanged whether or not task_json is set.
--   report_json    — the agent's structured VerificationReportV1 (JSON) once the
--                     terminal verdict is delivered (§5.4/§5.9). NULL until then
--                     (and always NULL on the legacy capture/judge path).
--   delivery_state — the delivery-outbox marker (§5.6): 'pending' written
--                     atomically with the terminal status + report_json, flipped
--                     to 'delivered' only after all three verdict-delivery
--                     consumers (artifact/lane/finding) commit. NULL for a
--                     pre-078 row and for the legacy path (no outbox consumer).
--   snapshot_sha   — the git sha the verification agent's snapshot worktree was
--                     built at (§5.5), captured at enqueue time. NULL when no
--                     snapshot was used (legacy path, or the dirty-worktree
--                     fallback which verifies the live shared worktree instead).
--   enqueue_key    — the idempotency key (§5.3), caller-opaque (the programmatic
--                     controller's convention is `${runId}:${taskRef}:${attempt}`).
--                     When set, VerificationScheduler.enqueue() looks for an
--                     existing NON-canceled row sharing the same key and returns
--                     ITS requestId instead of inserting a new row — a controller
--                     re-walking the chain after a crash or loopback never
--                     double-enqueues. NULL for a legacy/keyless enqueue (no dedup).
--
-- Old-binary rollback (§5.8): a pre-upgrade binary has no 'agent' backend
-- registered and never reads these columns — it keeps draining legacy rows via
-- deliverable_json exactly as before. These five columns are pure metadata to
-- that binary, never referenced by its queries.
--
-- NOTE: No `IF NOT EXISTS` on the ALTERs — SQLite ALTER TABLE does not support it,
-- and one ADD COLUMN per statement is required. Re-running raises 'duplicate
-- column name: ...', the idempotency signal runFileBasedMigrations() in
-- database.ts uses to skip an already-applied file (same mechanism as 055/056).
--
-- NOTE: No explicit BEGIN/COMMIT — runFileBasedMigrations() wraps every file in a
-- this.transaction(...) call.

ALTER TABLE verification_requests ADD COLUMN task_json TEXT;
ALTER TABLE verification_requests ADD COLUMN report_json TEXT;
ALTER TABLE verification_requests ADD COLUMN delivery_state TEXT;
ALTER TABLE verification_requests ADD COLUMN snapshot_sha TEXT;
ALTER TABLE verification_requests ADD COLUMN enqueue_key TEXT;
