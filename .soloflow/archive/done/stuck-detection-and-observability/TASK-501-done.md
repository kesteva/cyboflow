---
id: TASK-501
sprint: SPRINT-013
epic: stuck-detection-and-observability
status: done
summary: "Add StuckDetector service (60s scan, 4-variant classify, guarded transition + runs:stuck event), migration 007, shared StuckReason types; wire into Orchestrator lifecycle."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-501 — Periodic stuck-state detector

Delivered the orchestrator-side `StuckDetector` service plus its support layer:

- `main/src/database/migrations/007_add_stuck_reason.sql` — adds `stuck_detected_at INTEGER` (column `stuck_reason` was already provisioned by migration 006) and `idx_workflow_runs_status_stuck_at`.
- `shared/types/stuckDetection.ts` — exports `StuckReason` discriminated union (`self_deadlock | cross_run_deadlock | orphan_pty | stale_socket`) and `StuckDetectedEvent` shape, consumed by both `main/` and `frontend/`.
- `main/src/orchestrator/stuckDetector.ts` — `StuckDetector` class with `start()/stop()`, 60s `setInterval` scan against `approvals` older than 5 min, ordered classification, guarded transition (`UPDATE … WHERE id = ? AND status = 'awaiting_review'`), and `runs:stuck` event emission. Zero Electron imports preserves orchestrator boundary discipline.
- `main/src/orchestrator/types.ts` — extended `OrchestratorDeps` with optional `claudeManager?` / `permissionServer?` (one-time WARN fallback when absent, per plan §7 caveat).
- `main/src/orchestrator/Orchestrator.ts` — wires `StuckDetector` into the orchestrator lifecycle (constructs + `start()` in `Orchestrator.start()`, `detector.stop()` in `Orchestrator.stop()`).
- `main/src/orchestrator/__tests__/stuckDetector.test.ts` — 14 unit tests covering all 7 plan AC test targets plus migration idempotency.

Verifier APPROVED on first pass; code-reviewer: CLEAN with minor stylistic nits filed as FIND-SPRINT-013-4/5/6. Test-writer: NO_TESTS_NEEDED (coverage already exhaustive).
