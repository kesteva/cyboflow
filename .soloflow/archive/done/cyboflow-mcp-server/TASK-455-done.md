---
id: TASK-455
sprint: SPRINT-012
epic: cyboflow-mcp-server
status: done
summary: "Added OrchestratorHealth + cyboflow.health.mcpServer tRPC procedure + IPC fallback, Sidebar MCP status dot with tooltip, and useMcpHealth polling hook."
executor_loops: 0
code_review_rounds: 1
visual_mobile: not_applicable
visual_web: skipped_unable
---

# TASK-455 Done Report

Final task in the cyboflow-mcp-server epic — makes the MCP subprocess's runtime status user-visible so silent failure is no longer possible.

**Main-process surfaces:**

- `main/src/orchestrator/health.ts` — `OrchestratorHealth` class wrapping the lifecycle. `getMcpServerStatus()` returns `{ status, lastError?, restartAttempts }` (typed via `shared/types/mcpHealth.ts`). `setMcpError(msg)` lets the bootstrap stash the most recent error string.
- `main/src/orchestrator/mcpServer/mcpServerLifecycle.ts` — added `getRestartAttempts()` public getter (plan-authorized one-line read-only extension).
- `main/src/orchestrator/trpc/routers/health.ts` — `healthRouter` with `mcpServer` query procedure + `setHealthProvider()` singleton injector. Merged into the cyboflow sub-router at `main/src/orchestrator/trpc/router.ts` alongside `runs/approvals/workflows/events`, so `cyboflow.health.mcpServer` resolves via the canonical tRPC tree.
- `main/src/ipc/cyboflow.ts` — interim `cyboflow:mcp-health` IPC handler with `setCyboflowHealth()` injector. Returns `HEALTH_STARTING` (yellow) until the orchestrator wires the OrchestratorHealth singleton at app boot.

**Cross-package contract:**

- `shared/types/mcpHealth.ts` — canonical `McpServerHealth` interface imported by all 5 consumers (orchestrator, IPC handler, cyboflowApi, useMcpHealth, hook test). Backwards-compat re-exports remain in `health.ts` and `useMcpHealth.ts` to avoid breaking pre-existing imports.

**Frontend surfaces:**

- `frontend/src/utils/cyboflowApi.ts` — added `getMcpHealth()` typed wrapper that does `electron.invoke('cyboflow:mcp-health')` and returns `Promise<McpServerHealth>`. Conforms to the documented cyboflowApi pattern (the temporary IPC surface that'll swap to tRPC in one edit when the migration lands).
- `frontend/src/hooks/useMcpHealth.ts` — polling hook (5s `setInterval`) that calls `getMcpHealth()`. Initial state is `'starting'`, error path keeps state at `'starting'` so first paint never shows red.
- `frontend/src/components/Sidebar.tsx` — added a `2.5×2.5 rounded-full` dot in the bottom-fixed footer with `bg-status-success | bg-status-warning | bg-status-error` keyed off the status. Native `title=` attribute carries the status string plus `lastError` when present.

**Tests** (23 total new):

- `frontend/src/hooks/__tests__/useMcpHealth.test.tsx` (5): initial-state, first-tick update, 5s repoll + state change, error-swallow, unmount cleanup.
- `frontend/src/components/__tests__/Sidebar.mcpHealth.test.tsx` (7): dot color per status × 4, tooltip with/without lastError, MCP label.
- `main/src/orchestrator/__tests__/health.test.ts` (7): status delegation, restartAttempts delegation, lastError before/after `setMcpError()`, overwrite semantics. (Added by test-writer.)
- `main/src/ipc/__tests__/cyboflow.test.ts` (4 new cases appended): channel registration, `HEALTH_STARTING` fallback when singleton null, delegation after `setCyboflowHealth()`, `lastError` surfacing on `failed`. (Added by test-writer.)

All tests pass: 111 frontend + 257 main.

**Code review round 1 surfaced 3 convention violations + 3 minors:**
- Duplicate `main/src/orchestrator/router.ts` (canonical tRPC root is `main/src/orchestrator/trpc/router.ts`). Resolved by deleting the duplicate and adding `healthRouter` at `main/src/orchestrator/trpc/routers/health.ts` properly merged into the existing tree.
- Cross-package `McpServerHealth` / `McpHealth` duplication. Resolved by canonicalizing in `shared/types/mcpHealth.ts`.
- Hook bypassed the `cyboflowApi.ts` typed wrapper. Resolved by adding `getMcpHealth()` to cyboflowApi and updating the hook + tests.
- Minor: bare `catch{}`, removed unused eslint-disable, removed orphan `getMcpHealth?` from `electron.d.ts`, added 'stopped'-default warning comment in `health.ts`.

Findings logged during this task (FIND-SPRINT-012-7 through 10) were all plan-authorized scope deviations or pre-existing concerns and were resolved by the verifier in-pass.

Commits: `4ea7156 feat(TASK-455): MCP server health check and sidebar status indicator`, `12c0eb1 refactor(TASK-455): align with shared types and typed IPC wrapper conventions`, `b6248ea test(TASK-455): unit tests for OrchestratorHealth and IPC mcp-health handler`.

Verifier: APPROVED on round 1, APPROVED_WITH_DEFERRED on round 2 (AC6 manual sidebar smoke + visual_web Electron renderer can't bootstrap standalone). Code reviewer CLEAN on round 2. Test-writer: TESTS_WRITTEN (added 11 main-process tests).

**Deferred to TASK-455 follow-up / next epic:**
- AC6 manual smoke (yellow→green within 5s; red+tooltip on failure) requires `pnpm dev` Electron launch + OrchestratorHealth singleton wire-up in `main/src/index.ts` (which lands in the orchestrator-and-trpc-router epic).
- visual_web verification across this sprint blocked by the standalone-renderer limitation (existing queue entry in human-review-queue.md).
