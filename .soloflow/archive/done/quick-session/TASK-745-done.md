---
id: TASK-745
sprint: SPRINT-037
epic: quick-session
status: done
summary: "NULL-hardened mcpQueryHandler, runExecutor, database, and cyboflowStore for quick-session support; 11 regression tests pin the contract."
executor_loops: 1
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-745 — Audit and NULL-harden run-aware query surfaces

## What changed

- `main/src/orchestrator/mcpServer/mcpQueryHandler.ts` — header-comment update documenting the quick-session invariant (handler already returns `not_found` for missing workflow_runs rows; no logic change).
- `main/src/orchestrator/runExecutor.ts` — docstring update documenting the workflow-only contract; preserved existing `workflow_runs row not found for runId=` throw as the intended loud-failure mode.
- `main/src/database/database.ts` — added `getQuickSessions(projectId?: number): Session[]` helper (selects `run_id IS NULL`); added NULL-tolerance audit comment block stating no existing `SELECT *` query needs changes.
- `frontend/src/stores/cyboflowStore.ts` — added `activeQuickSessionId: string | null` field with `setActiveQuickSession(sessionId)` and `clearActiveQuickSession()` actions. `setActiveQuickSession` tears down active stream subscription and clears `activeRunId`; `setActiveRun` clears `activeQuickSessionId`; `clearActiveQuickSession` clears only the quick-session field.

## Tests added

11 new regression tests across 4 sibling test files:
- `mcpQueryHandler.test.ts` — 2 tests (not_found path + FK-violation caught as ok:false).
- `runExecutor.test.ts` — 1 test pinning the loud-fail on a quick-session id.
- `cyboflowSchema.test.ts` — 2 tests covering project-scoped and cross-project variants of `getQuickSessions`; `getAllSessions` continues to return both null- and non-null-run shapes.
- `cyboflowStore.test.ts` — 6 tests covering the full mutual-exclusion invariant, no-subscription path on quick-session, prior-subscription teardown, and `clearActiveQuickSession` non-interference.

## Verifier cycle

One NEEDS_CHANGES round: the AC3 verification grep `grep -n 'quick session' main/src/orchestrator/runExecutor.ts` was case-sensitive and required the literal `quick session` substring. The initial docstring used `Quick-session` / `Quick sessions` (capital, hyphenated). Fixed in commit `95c6fc1` by lowercasing and de-hyphenating three references; substantive contract unchanged.

## Code review

CLEAN — no findings. Reviewer noted two non-actionable category-level observations (the `(archived = 0 OR archived IS NULL)` predicate is duplicated across multiple sibling `get*Sessions` methods, and `clearActiveRun` does not also clear `activeQuickSessionId` — but the mutual-exclusion invariant makes the latter a non-issue, and the former is broader than this task's scope).

## Verification

- L1 grep checks: all 7 ACs pass after the docstring fix.
- L2 unit suite: main 656/656 (71 files), frontend 328/328 (24 files), schema parity 4/4, build tests 4/4.
- L3 visual: not applicable (backend/store audit, no UI surface changed).
