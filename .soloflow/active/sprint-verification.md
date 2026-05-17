---
sprint: SPRINT-012
visual_mobile: skipped_user_preference
visual_web: skipped_unable
visual_macos: skipped_user_preference
visual_mobile_note: "verification.visual_mobile=false"
visual_web_note: "Renderer requires full Electron (preload-injected electronTRPC); standalone Chromium cannot bootstrap. pnpm build:main is broken by a typecheck regression in main/src/orchestrator/__tests__/health.test.ts (TASK-455), so the Electron dev path the Playwright webServer relies on cannot produce up-to-date main/dist artifacts. Falls under the documented CLAUDE.md invariant: 'Vite renderer at http://localhost:4521 cannot bootstrap standalone'."
visual_macos_note: "verification.visual_macos=false"
regressions_count: 1
flows_tested: 0
flows_deferred: 0
---

# Sprint Verification — SPRINT-012

## Visual Verification

- **visual_mobile:** `skipped_user_preference` — `verification.visual_mobile=false`.
- **visual_web:** `skipped_unable` — Cyboflow renderer is preload-coupled to the Electron main process (preload-injected `electronTRPC`). The Playwright `webServer` config uses `pnpm electron-dev`, which expects pre-built `main/dist/` artifacts; however, `pnpm build:main` now fails because TASK-455 added test code that fails `tsc --noEmit`. The sprint's only user-facing surface (sidebar MCP health dot) is exhaustively covered by the unit tests `frontend/src/components/__tests__/Sidebar.mcpHealth.test.tsx` (7 tests, all green) and `frontend/src/hooks/__tests__/useMcpHealth.test.tsx` (5 tests, all green) — so visual regression risk is contained, but live verification is impossible without first repairing the build.
- **visual_macos:** `skipped_user_preference` — `verification.visual_macos=false`.
- **Flows tested:** 0
- **Flows deferred:** 0

The MCP health-dot rendering is verified at the component-test layer:
- Green when status='running', yellow on 'starting', red on 'failed'/'stopped'.
- Tooltip merges `status` and `lastError` when present.
- Polls every 5s via `getMcpHealth()` → `cyboflow:mcp-health` IPC.

## Integration Tests

(Run inline; the integration-tester sub-agent is not separately spawnable in this environment.)

- **Status:** REGRESSIONS_FOUND
- **Total tests:** 369 unit/integration + 1 e2e gate = 370 runnable
- **Passed:** 257 main vitest + 111 frontend vitest + 1 day-3 gate Playwright = 369
- **Failed:** 0 unit/integration. Build pipeline (`tsc`) fails.

### Regression (caused by this sprint)

- **Test command:** `pnpm typecheck` and `pnpm build:main`
- **Failure:**
  ```
  main typecheck: src/orchestrator/__tests__/health.test.ts(47,42): error TS2344:
    Type 'Function' does not satisfy the constraint '(...args: any) => any'.
    Type 'Function' provides no match for the signature '(...args: any): any'.
  ```
  Same TS2344 fires at lines 47, 59, 68, 77, 87, 96, 107.
- **Caused by:** TASK-455 — `main/src/orchestrator/__tests__/health.test.ts:47-107`. The construct `Parameters<typeof OrchestratorHealth.prototype.constructor>[0]` is invalid because `prototype.constructor` is typed by TypeScript's lib as plain `Function`, which does not satisfy `Parameters<T>`'s `(...args: any) => any` constraint. The same test file did not exist before this sprint, so the error is sprint-introduced.
- **Why vitest does not catch it:** vitest uses esbuild's transpile-only path that ignores `tsc` type errors; the project's CI relies on `pnpm typecheck` and `pnpm build:main` (the latter runs `rimraf dist && tsc && copy:assets`) to surface these.
- **Suggested fix:** Replace `Parameters<typeof OrchestratorHealth.prototype.constructor>[0]` with the explicit type `ConstructorParameters<typeof OrchestratorHealth>[0]` (or equivalently the imported `McpServerLifecycle` type, since that is what the constructor accepts).

### Other findings (informational, not blockers)

1. **End-to-end MCP pipeline is intentionally un-wired.** None of the new pieces (`McpServerLifecycle`, `OrchestratorHealth`, `McpQueryHandler`, `setHealthProvider`, `setCyboflowHealth`, `setOrchSocketPath`) are called from `main/src/index.ts` or any boot site. The `CYBOFLOW_ORCH_SOCKET` Unix socket the subprocess connects to is not created by any `net.createServer()` call in the codebase. This matches the epic-6 "wired in epic 6" comments in `main/src/ipc/cyboflow.ts:103-106` and `main/src/orchestrator/health.ts:25-31`; the sidebar dot is safe because both injection points return the `'starting'` fallback when the singleton is null. Documented in the existing findings (FIND-SPRINT-012-5, FIND-SPRINT-012-6) — not a sprint blocker, but worth noting that no end-to-end MCP query/checkpoint flow can currently complete from outside the orchestrator.

2. **Cross-task type consistency: OK.** The single canonical `McpServerHealth` type at `shared/types/mcpHealth.ts` is consumed identically by `main/src/orchestrator/health.ts`, `main/src/ipc/cyboflow.ts`, `main/src/orchestrator/trpc/routers/health.ts`, `frontend/src/hooks/useMcpHealth.ts`, and `frontend/src/utils/cyboflowApi.ts`. The `McpServerStatus` string union is locally redeclared in `mcpServerLifecycle.ts` but matches the shared union — small duplication, not a defect.

3. **tRPC and IPC paths return the same shape.** Both `cyboflow.health.mcpServer` (tRPC) and `cyboflow:mcp-health` (IPC) return the same `McpServerHealth` envelope and the same safe `'starting'` fallback when the singleton is missing. The hook uses the IPC path; when tRPC ipcLink lands, swapping in `getMcpHealth` is a one-line change.

4. **Day-3 gate test still green** (`tests/cyboflow-day3-gate.spec.ts`), confirming the existing orchestrator approval flow is untouched. The MCP-query path is purely additive.

5. **Existing playwright smoke/health-check failures** (`tests/smoke.spec.ts`, `tests/health-check.spec.ts`) are PRE-EXISTING — they reproduce the documented "renderer needs full Electron" invariant in CLAUDE.md and SPRINT-011's f8a9cb0 commit. Not sprint-introduced.

### Pre-existing failures

- **Test:** `tests/smoke.spec.ts` (4 tests), `tests/health-check.spec.ts` (1 test) — all fail to find `[data-testid="sidebar"]` / `[data-testid="settings-button"]` because the standalone Chromium webServer cannot bootstrap the renderer (no preload bridge). **Notes:** documented in `CLAUDE.md` and SPRINT-011 docs — these have been failing-by-design since before the sprint base SHA.

## Regressions requiring attention

1. **Build pipeline broken.** `pnpm typecheck` and `pnpm build:main` both fail with TS2344 in `main/src/orchestrator/__tests__/health.test.ts:47,59,68,77,87,96,107`. Replace `Parameters<typeof OrchestratorHealth.prototype.constructor>[0]` with `ConstructorParameters<typeof OrchestratorHealth>[0]` (or `McpServerLifecycle` directly). Single-task fix, owner: TASK-455. **This blocks CI and any subsequent task that depends on `main/dist/`.**

## Post-verification fix

Typecheck blocker resolved in commit `ee63a9d fix(SPRINT-012): correct constructor parameter type in health.test.ts` — replaced `Parameters<typeof OrchestratorHealth.prototype.constructor>[0]` with `ConstructorParameters<typeof OrchestratorHealth>[0]`. `pnpm build:main` now exits 0; the remaining typecheck errors (`nodeFinder.ts:42`, `shellDetector.ts:105`) are pre-existing and unrelated.
