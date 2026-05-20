---
id: TASK-626
sprint: SPRINT-023
epic: cyboflow-mcp-server
status: done
summary: "Consolidate dual MCP health polling loops; share McpHealthUiStatus type via shared/"
executor_loops: 0
code_review_rounds: 1
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-626 Done

Canonicalized `McpHealthUiStatus` + `toUiStatus` in `shared/types/mcpHealth.ts`. `mcpHealthStore` now owns the sole polling loop and imports the canonical mapping from shared. `useMcpHealth` is a thin `@deprecated` adapter over the store (no setInterval). Sidebar's bottom MCP indicator is gone — StatusBar's McpHealthIndicator is the single MCP health surface. Dead `getMcpHealth` export removed from `cyboflowApi.ts`. Three test files updated/added covering store polling, hook adapter, and Sidebar absence. Code-reviewer requested removal of misapplied `@cyboflow-hidden` marker on the deprecated hook (one retry round).

## Commits
- 9a6f788 feat(TASK-626): add McpHealthUiStatus type and toUiStatus to shared/types/mcpHealth
- 5a52198 refactor(TASK-626): mcpHealthStore imports McpHealthUiStatus and toUiStatus from shared
- 886e1b1 refactor(TASK-626): useMcpHealth delegates to mcpHealthStore (removes polling loop)
- 7729922 feat(TASK-626): remove Sidebar MCP health indicator (StatusBar is single MCP surface)
- bab34d1 test(TASK-626): add mcpHealthStore unit tests (initial state, IPC mapping, unsubscribe)
- 61dffc8 test(TASK-626): replace useMcpHealth polling tests with store-adapter mapping tests
- 9a4263c test(TASK-626): replace Sidebar MCP dot tests with absence assertions
- 0920657 refactor(TASK-626): remove getMcpHealth from cyboflowApi (dead code after polling removal)
- b7f5eff fix(TASK-626): remove @cyboflow-hidden from deprecated useMcpHealth JSDoc

## Verification
- Tests: 216/216 frontend pass
- Typecheck: clean
- Verifier verdict: APPROVED
- Code-reviewer verdict: IMPROVEMENTS_NEEDED → resolved (b7f5eff); cap reached at review_retry_max=1
