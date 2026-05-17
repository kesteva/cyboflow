---
id: TASK-504
sprint: SPRINT-013
epic: stuck-detection-and-observability
status: done
summary: "Add getStuckInspection tRPC query (read-only, principal-scoped) + StuckInspectorModal (read-only, h3 sections, expand-on-click) + Why-stuck button on PendingApprovalCard gated on runStatus === 'stuck'."
executor_loops: 1
code_review_rounds: 1
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-504 — Why-stuck inspector modal

Delivered:

- `main/src/orchestrator/trpc/routers/runs.ts` — added `getStuckInspection` procedure with principal scoping (`ctx.userId !== 'local'` → FORBIDDEN); stub returns NOT_IMPLEMENTED until DB wiring lands.
- `main/src/trpc/routers/runs.ts` — `getStuckInspectionHandler(db, runId)` with the actual SQL: workflow_runs + first pending approval + latest 10 raw_events ordered by id DESC.
- `shared/types/stuckInspection.ts` — exports `StuckInspectionResult`, `RawEvent`, `PendingApproval`, and re-exports `WorkflowRunStatus` (added in round 2 to break the previous router-router import cycle).
- `frontend/src/components/ReviewQueue/StuckInspectorModal.tsx` — read-only modal with three `<h3>` sections (Detected reason / Pending approval / Recent events), expand-on-click on event rows.
- `frontend/src/components/ReviewQueue/PendingApprovalCard.tsx` — added `runStatus: WorkflowRunStatus` prop; renders Why-stuck button only when `runStatus === 'stuck'`.
- `main/src/orchestrator/__tests__/inspectorQueries.test.ts` — 6 integration tests (10-row DESC limit, principal guard, null-approval fallback).
- `frontend/src/components/ReviewQueue/__tests__/StuckInspectorModal.test.tsx` — 22 component tests (loading state, section order, read-only invariant, expand toggle, reason-map fallbacks).
- `frontend/src/components/ReviewQueue/__tests__/PendingApprovalCard.test.tsx` — 18 component tests for button visibility and modal-open behavior.

Loop history:
- Round 1: verifier APPROVED. Code-reviewer: IMPROVEMENTS_NEEDED — 3 important items (extract shared types, tighten `runStatus`, demote section headings to `<h3>`). Counted as `code_review_rounds = 1`.
- Round 2: executor applied the 3 improvements. Re-verifier flagged a typecheck regression (`export type … from …` re-exports do not bring symbols into local scope; modal had unused imports). Counted as `executor_loops = 1`.
- Round 3: executor added explicit `import type` and pared modal imports. Verifier APPROVED. Test-writer: TESTS_WRITTEN (10 new modal tests for reason-map fallbacks and expand-toggle behavior).
