---
id: TASK-621
sprint: SPRINT-034
epic: cyboflow-mcp-server
status: done
summary: "Extract executeMcpQuery helper with runtime type-guard; collapse three CallTool branches to single returns. Fixes FIND-1 silent empty-error bug."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-621 — Done Report

## What changed
- `main/src/orchestrator/mcpServer/cyboflowMcpServer.ts` — added `executeMcpQuery(type, params): Promise<CallToolResult>` helper (lines 181–209) with structural guard rejecting non-objects, null, missing `ok`, and non-boolean `ok` (emits `invalid_orchestrator_response`); empty/missing `error` on `ok:false` now emits `orchestrator_error` instead of silent `'{}'`. All three `CallTool` branches collapse to single `return executeMcpQuery(...)` calls (net −54/+36).

## Verifier
- Verdict: APPROVED.
- Ground truth: 655/655 tests pass; pnpm typecheck clean; pnpm lint 0 errors.
- Visual: not_applicable across mobile/web/macos (stdio subprocess).

## Code review
- Verdict: CLEAN — 0 critical / 0 important / 0 minor findings.

## Test-writer
- NO_TESTS_NEEDED — `test_strategy.needed: false` per plan (stdio subprocess, TASK-453 precedent). New guard fully covered by typecheck + CallToolResult contract.

## Commits
- `37b4049 refactor(TASK-621): extract executeMcpQuery helper, deduplicate MCP tool branches`
