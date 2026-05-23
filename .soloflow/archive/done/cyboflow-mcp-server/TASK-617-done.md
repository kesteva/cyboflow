---
id: TASK-617
sprint: SPRINT-034
epic: cyboflow-mcp-server
status: done
summary: "Reject 'orchestrator' sentinel in mcp-submit-checkpoint to prevent FK violation; tightened test fixture to foreign_keys=ON with explicit FK clauses."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-617 — Done Report

## What changed
- `main/src/orchestrator/mcpServer/mcpQueryHandler.ts` — added sentinel guard as the first executable statement of `handleSubmitCheckpoint`; returns `ok:false, error:'checkpoint_requires_real_run'` for `msg.runId === 'orchestrator'`.
- `main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts` — replaced `GATE_SCHEMA` import with inline `MINIMAL_SCHEMA` carrying explicit `FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE` on `approvals` and `raw_events`; flipped `db.pragma('foreign_keys = OFF')` → `'ON'`; added rejection test asserting wire shape, newline framing, and zero `raw_events` rows.
- `docs/cyboflow_system_design.md` — §7.5 rewritten to describe handler-level rejection with the explicit error code.

## Verifier
- Verdict: APPROVED
- Ground truth: 642/642 tests pass; pnpm typecheck clean; pnpm lint 0 errors.
- Visual: not_applicable across mobile/web/macos (backend MCP handler change).

## Code review
- Verdict: CLEAN
- 1 minor finding queued: FIND-SPRINT-034-1 (stale header docstring referencing removed `GATE_SCHEMA` import).

## Test-writer
- NO_TESTS_NEEDED — executor already added the rejection test inside the plan-declared test target.

## Commit
- `7513d5c fix(TASK-617): reject 'orchestrator' sentinel in mcp-submit-checkpoint to prevent FK violation`
