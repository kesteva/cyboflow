---
id: TASK-620
idea: null
status: ready
created: "2026-05-16T00:00:00Z"
files_owned:
  - shared/types/mcpHealth.ts
  - main/src/ipc/cyboflow.ts
  - main/src/orchestrator/trpc/routers/health.ts
  - main/src/ipc/__tests__/cyboflow.test.ts
  - main/src/orchestrator/trpc/routers/__tests__/health.test.ts
files_readonly:
  - main/src/orchestrator/health.ts
  - main/src/orchestrator/trpc/router.ts
  - main/src/orchestrator/trpc/context.ts
  - main/src/orchestrator/__tests__/health.test.ts
  - main/src/index.ts
acceptance_criteria:
  - criterion: HEALTH_STARTING is exported from shared/types/mcpHealth.ts as a McpServerHealth-typed constant.
    verification: "grep -nE '^export const HEALTH_STARTING' shared/types/mcpHealth.ts returns exactly 1 match"
  - criterion: main/src/ipc/cyboflow.ts no longer declares a local HEALTH_STARTING and imports the shared one.
    verification: "grep -nE '^const HEALTH_STARTING' main/src/ipc/cyboflow.ts returns 0 matches; grep -nE 'import .*HEALTH_STARTING.* from .*shared/types/mcpHealth' main/src/ipc/cyboflow.ts returns ≥1 match"
  - criterion: "main/src/orchestrator/trpc/routers/health.ts no longer inlines the literal '{ status: 'starting' as const, restartAttempts: 0 }'."
    verification: "grep -nE \"status: 'starting' as const, restartAttempts: 0\" main/src/orchestrator/trpc/routers/health.ts returns 0 matches"
  - criterion: main/src/orchestrator/trpc/routers/health.ts imports and returns HEALTH_STARTING from the shared module.
    verification: "grep -n 'HEALTH_STARTING' main/src/orchestrator/trpc/routers/health.ts returns ≥2 matches"
  - criterion: setCyboflowHealth in main/src/ipc/cyboflow.ts also invokes setHealthProvider with the same instance.
    verification: "grep -n 'setHealthProvider' main/src/ipc/cyboflow.ts returns ≥2 matches (import + call)"
  - criterion: Existing cyboflow.test.ts continues to pass with one new IPC-vs-tRPC parity test.
    verification: pnpm --filter main exec vitest run src/ipc/__tests__/cyboflow.test.ts exits 0
  - criterion: New test file main/src/orchestrator/trpc/routers/__tests__/health.test.ts exists with 2+ cases (HEALTH_STARTING fallback + setHealthProvider delegation).
    verification: test -f main/src/orchestrator/trpc/routers/__tests__/health.test.ts; pnpm --filter main exec vitest run src/orchestrator/trpc/routers/__tests__/health.test.ts exits 0
  - criterion: Full main suite and typecheck remain green.
    verification: pnpm --filter main test exits 0; pnpm --filter main typecheck exits 0
depends_on: []
estimated_complexity: low
epic: cyboflow-mcp-server
test_strategy:
  needed: true
  justification: "Unification changes setCyboflowHealth's observable surface (now propagates to tRPC). Cross-surface parity contract requires a new test in cyboflow.test.ts; tRPC procedure gets its own isolated test file."
  targets:
    - behavior: "After setCyboflowHealth(h), the IPC handler and the tRPC procedure return the same snapshot"
      test_file: main/src/ipc/__tests__/cyboflow.test.ts
      type: unit
    - behavior: tRPC health.mcpServer returns HEALTH_STARTING when no provider has been injected
      test_file: main/src/orchestrator/trpc/routers/__tests__/health.test.ts
      type: unit
    - behavior: tRPC health.mcpServer returns the snapshot from the OrchestratorHealth instance after setHealthProvider
      test_file: main/src/orchestrator/trpc/routers/__tests__/health.test.ts
      type: unit
---
# TASK-620: Unify OrchestratorHealth singleton injection + extract shared HEALTH_STARTING constant

## Objective

`OrchestratorHealth` is wired through two independent setters — `setCyboflowHealth` (IPC) and `setHealthProvider` (tRPC) — each with its own inline `{ status: 'starting', restartAttempts: 0 }` fallback. The bootstrap caller must call both or surfaces diverge. Unify: (a) extract `HEALTH_STARTING` to `shared/types/mcpHealth.ts`, (b) make `setCyboflowHealth` forward to `setHealthProvider` so one call wires both surfaces. Resolves FIND-11.

## Implementation Steps

1. **Add to `shared/types/mcpHealth.ts`**:
   ```ts
   export const HEALTH_STARTING: McpServerHealth = {
     status: 'starting',
     restartAttempts: 0,
   };
   ```

2. **Refactor `trpc/routers/health.ts`**:
   - Import `HEALTH_STARTING` from `shared/types/mcpHealth` (verify the depth — 5 `..` from `trpc/routers/`).
   - Replace the inline fallback literal with `return HEALTH_STARTING;`.

3. **Refactor `ipc/cyboflow.ts`**:
   - Delete the local `const HEALTH_STARTING = { ... }` declaration.
   - Change the existing type-only import to bring in the value: `import { type McpServerHealth, HEALTH_STARTING } from '../../../shared/types/mcpHealth';`.
   - Add `import { setHealthProvider } from '../orchestrator/trpc/routers/health';`.
   - Change `setCyboflowHealth` body to: `_orchestratorHealth = health; setHealthProvider(health);`.
   - Update the JSDoc to document the dual-surface forwarding.

4. **Add parity test in `__tests__/cyboflow.test.ts`** — inside the existing `cyboflow:mcp-health` describe block, add a test that calls `setCyboflowHealth(mockHealth)` once, then invokes BOTH the IPC handler AND `appRouter.createCaller(createContext()).cyboflow.health.mcpServer()`, asserting equal output. Use dynamic imports (the surrounding block already uses `vi.resetModules()`).

5. **Create `trpc/routers/__tests__/health.test.ts`** (NEW FILE) with two tests: (a) fallback to `HEALTH_STARTING` before injection, (b) delegation to `OrchestratorHealth.getMcpServerStatus()` after `setHealthProvider`. Use the same `vi.resetModules()` + dynamic-import pattern.

6. **Verify** — typecheck, lint, full suite green.

## Hardest Decision

Option (a) "one setter forwards to both" vs (b) "push into AppServices". Chose (a) — stays inside the cyboflow-mcp-server epic; option (b) collides with TASK-608's in-flight `AppServices` refactor. Trade-off: preserves the module-level-singleton pattern that FIND-14 flagged (separate concern, future work).

## Lowest Confidence Area

Relative-path depths for the new imports. The new test file is at depth `main/src/orchestrator/trpc/routers/__tests__/` — `../../../../../../shared/types/mcpHealth` (six `..`). Verify with `vitest` and adjust if module-not-found. Reference: `main/src/orchestrator/health.ts:11` uses `../../../shared/types/mcpHealth`.
