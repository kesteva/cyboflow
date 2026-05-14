---
id: TASK-255
idea: IDEA-006
idea_id: IDEA-006
status: in-flight
created: "2026-05-11T00:00:00Z"
files_owned:
  - main/src/orchestrator/trpc/ipcAdapter.ts
  - main/src/index.ts
  - main/src/preload.ts
  - frontend/src/utils/trpcClient.ts
  - main/src/orchestrator/trpc/__tests__/ipcAdapter.test.ts
  - frontend/tsconfig.json
  - frontend/package.json
  - main/src/database/database.ts
files_readonly:
  - .soloflow/active/ideas/IDEA-006.md
  - .soloflow/active/research/ROADMAP-001-research-architecture.md
  - .soloflow/active/research/ROADMAP-001-research-ecosystem.md
  - main/src/orchestrator/trpc/router.ts
  - main/src/orchestrator/trpc/context.ts
  - main/src/orchestrator/Orchestrator.ts
  - shared/types/trpc.ts
acceptance_criteria:
  - criterion: "main/src/orchestrator/trpc/ipcAdapter.ts exports attachOrchestratorTrpc(opts: { window: BrowserWindow; router: AppRouter; createContext: () => Context }): void — the only file in main/src/orchestrator/trpc/ allowed to import from 'electron'"
    verification: "grep -n 'attachOrchestratorTrpc' main/src/orchestrator/trpc/ipcAdapter.ts shows the export; grep -rnE \"from ['\\\"]electron['\\\"]\" main/src/orchestrator/trpc/ | grep -v ipcAdapter.ts returns 0 matches (only ipcAdapter.ts may import electron)"
  - criterion: "ipcAdapter.ts calls createIPCHandler (or the equivalent v0.1.2 export from trpc-electron) wiring the appRouter, createContext, and BrowserWindow"
    verification: "grep -nE 'createIPCHandler|from .trpc-electron' main/src/orchestrator/trpc/ipcAdapter.ts shows the trpc-electron usage"
  - criterion: "main/src/preload.ts adds the trpc-electron exposeElectronTRPC() call (or v0.1.2 equivalent) without removing any existing contextBridge exposure — Crystal's existing ipcMain.handle surface is preserved"
    verification: "grep -n 'exposeElectronTRPC\\|trpc-electron' main/src/preload.ts shows the added call; diff <(git show HEAD:main/src/preload.ts | grep -c contextBridge) <(grep -c contextBridge main/src/preload.ts) shows the contextBridge call count did not decrease"
  - criterion: "main/src/index.ts constructs the Orchestrator with its dependencies after the BrowserWindow is created, calls orchestrator.start(), and calls attachOrchestratorTrpc({ window: mainWindow, router: appRouter, createContext }); also registers app.on('before-quit', () => orchestrator.stop())"
    verification: "grep -nE 'new Orchestrator|orchestrator.start|attachOrchestratorTrpc|orchestrator.stop' main/src/index.ts shows all four call sites"
  - criterion: "frontend/src/utils/trpcClient.ts exports a typed tRPC client built with ipcLink (from trpc-electron) and superjson transformer, using the AppRouter type from shared/types/trpc"
    verification: "grep -nE 'createTRPCProxyClient|ipcLink|superjson|AppRouter' frontend/src/utils/trpcClient.ts shows all four"
  - criterion: "On app launch (production build via pnpm build:main + electron .), the renderer can call trpcClient.cyboflow.runs.list.query() and receive a NOT_IMPLEMENTED tRPC error (not a transport error or undefined) — proves the end-to-end IPC link is wired"
    verification: "Manual smoke-test step documented in the plan: launch dev (pnpm electron-dev), open DevTools console, paste `await window.__trpcSmokeTest()` (a temporary global exposed via preload that calls trpcClient.cyboflow.runs.list.query() and returns the error message), assert the returned string contains 'NOT_IMPLEMENTED'. The smoke-test global is removed before the task closes — see Implementation Step 7."
  - criterion: "Standalone-typecheck invariant for non-adapter files still holds: every file under main/src/orchestrator/trpc/ except ipcAdapter.ts is electron-free"
    verification: "grep -rnE \"from ['\\\"]electron['\\\"]\" main/src/orchestrator/trpc/ | grep -v 'ipcAdapter.ts:' returns 0 matches"
  - criterion: Unit test in ipcAdapter.test.ts asserts attachOrchestratorTrpc calls createIPCHandler with the expected shape using a mock for createIPCHandler
    verification: "Run pnpm --filter main test -- ipcAdapter and confirm test 'attaches router and createContext via createIPCHandler' passes"
  - criterion: "Crystal's existing ipcMain.handle handlers continue to work — no inherited Crystal surface is broken by the additive tRPC wiring"
    verification: "Run the existing pnpm --filter main test suite; previously-passing tests remain passing. Manual smoke: a Crystal session can still be created via the existing UI"
depends_on:
  - TASK-254
estimated_complexity: medium
epic: orchestrator-and-trpc-router
test_strategy:
  needed: true
  justification: The IPC wiring is the only mainline path where the tRPC contract reaches the renderer in production. A unit test confirms the adapter shape; the manual smoke test in DevTools is the end-to-end gate. Together they prove the typed-IPC surface is live without faking the Electron context.
  targets:
    - behavior: "attachOrchestratorTrpc forwards router, createContext, and window to trpc-electron's createIPCHandler"
      test_file: main/src/orchestrator/trpc/__tests__/ipcAdapter.test.ts
      type: unit
    - behavior: "End-to-end: renderer invokes trpcClient.cyboflow.runs.list.query() and receives NOT_IMPLEMENTED"
      test_file: (manual DevTools smoke documented in plan body)
      type: integration
---
# tRPC IPC Link Wiring — Bridge Router to Renderer

## Objective

Bridge the tRPC router built in TASK-254 to the renderer via `trpc-electron`'s IPC link. This is the only file in `main/src/orchestrator/trpc/` permitted to import from `'electron'` — the adapter pattern isolates the Electron coupling so the rest of the orchestrator subtree remains standalone-testable. The wiring also instantiates the Orchestrator in `main/src/index.ts`, starts it after the BrowserWindow is ready, and registers `before-quit` to drain. Crystal's existing `ipcMain.handle` surface is left intact — tRPC is purely additive for `cyboflow.*` procedures.

## Implementation Steps

1. **Create `main/src/orchestrator/trpc/ipcAdapter.ts`.** This is the single file allowed to import from `'electron'`. Imports: `BrowserWindow` from `'electron'`, `createIPCHandler` from `'trpc-electron/main'` (the v0.1.2 export — verify exact path in `node_modules/trpc-electron/dist/` if uncertain), `AppRouter` from `../trpc/router`, `Context, createContext` from `../trpc/context`. Export `attachOrchestratorTrpc({ window, router, createContext }: { window: BrowserWindow; router: AppRouter; createContext: () => Context }): void` that calls `createIPCHandler({ router, windows: [window], createContext })`.
2. **Update `main/src/preload.ts`.** Add the import and call required by trpc-electron v0.1.2: typically `import { exposeElectronTRPC } from 'trpc-electron/main'` (or the documented preload helper — confirm against the DeepWiki page at https://deepwiki.com/mat-sz/trpc-electron). Add the call after the existing `contextBridge.exposeInMainWorld(...)` calls so Crystal's surface remains intact. Do not remove any existing `contextBridge` call.
3. **Update `main/src/index.ts`.** After the BrowserWindow is created and the existing services are constructed (look for the registerIpcHandlers call around line 34) but before the window loads its URL, add:
   ```ts
   import { Orchestrator } from './orchestrator/Orchestrator';
   import { RunQueueRegistry } from './orchestrator/RunQueueRegistry';
   import { EventEmitter } from 'node:events';
   import { appRouter } from './orchestrator/trpc/router';
   import { createContext } from './orchestrator/trpc/context';
   import { attachOrchestratorTrpc } from './orchestrator/trpc/ipcAdapter';
   // ...
   const runQueues = new RunQueueRegistry();
   const orchestrator = new Orchestrator({ db: databaseService as unknown as DatabaseLike, logger, eventBus: new EventEmitter(), runQueues });
   await orchestrator.start();
   attachOrchestratorTrpc({ window: mainWindow!, router: appRouter, createContext });
   app.on('before-quit', async (e) => { e.preventDefault(); await orchestrator.stop(); app.exit(0); });
   ```
   (Adapt the `databaseService` cast — TASK-253's `DatabaseLike` shape may need a tiny adapter object; if so, define it inline rather than expanding the orchestrator's surface.)
4. **Create `frontend/src/utils/trpcClient.ts`.** Use `createTRPCProxyClient<AppRouter>` from `@trpc/client`, the `ipcLink` from `trpc-electron/renderer`, and the `superjson` transformer to match server-side. Import `AppRouter` from `shared/types/trpc` (NOT from `main/...`). Export a singleton `trpc` client.
5. **Create `main/src/orchestrator/trpc/__tests__/ipcAdapter.test.ts`.** Vitest. Mock `'trpc-electron/main'` so `createIPCHandler` is a `vi.fn()`. Call `attachOrchestratorTrpc({ window: fakeBrowserWindow, router: appRouter, createContext })` and assert `createIPCHandler` was called once with `{ router: appRouter, windows: [fakeBrowserWindow], createContext }`. `fakeBrowserWindow` is just `{}` cast as `BrowserWindow` — the test only verifies wiring, not real Electron behavior.
6. **Run the standalone-typecheck invariant gate.** `grep -rnE "from ['\"]electron['\"]" main/src/orchestrator/trpc/` should return matches ONLY in `ipcAdapter.ts`. Run `grep -rnE "from ['\"]electron['\"]" main/src/orchestrator/trpc/ | grep -v 'ipcAdapter.ts:'` and confirm 0 matches.
7. **Add a temporary DevTools smoke-test global, run it, then remove it.** During the task's working pass:
   - In preload, temporarily expose `window.__trpcSmokeTest = async () => { const c = await import('../../frontend/src/utils/trpcClient'); try { await c.trpc.cyboflow.runs.list.query({}); return 'UNEXPECTED_SUCCESS'; } catch (e) { return String(e); } };` (or the renderer-side equivalent — adjust import path).
   - Run `pnpm electron-dev`. Open DevTools console. Run `await window.__trpcSmokeTest()`. Confirm the returned string contains `NOT_IMPLEMENTED`.
   - Delete the `window.__trpcSmokeTest` line from preload before committing. The smoke test is a development gate, not a shipping artifact.
8. **Run the existing Crystal tests** (`pnpm --filter main test`) and confirm the previously-passing suite remains green.
9. **Run `pnpm typecheck`** across the workspace and confirm exit 0.

## Acceptance Criteria

All nine AC entries hold. The ipcAdapter shape grep, the no-electron-imports-except-adapter grep, the preload diff check (`contextBridge` count did not decrease), the index.ts wiring grep, the trpcClient shape grep, the unit test, the manual DevTools smoke, the no-regression on existing tests, and the typecheck compose the gate.

## Test Strategy

Unit test at `main/src/orchestrator/trpc/__tests__/ipcAdapter.test.ts` (vitest, mocks `'trpc-electron/main'`). The end-to-end gate is the manual DevTools smoke (Implementation Step 7) which is the cheapest way to confirm the full IPC bridge works without standing up a Playwright fixture for one assertion. The smoke-test global is removed before the task closes — only the unit test ships.

## Hardest Decision

**Whether to expose a temporary `window.__trpcSmokeTest` global or to write a Playwright test that drives the renderer.** Playwright would be more durable but the existing repo only has top-level Playwright tests under `tests/`, none yet target the renderer's trpcClient. Standing up a fixture for one assertion costs ~2 hours and is brittle in CI without the full Electron build. The DevTools smoke is documented in the plan, executed during the task, then removed; the unit test on `attachOrchestratorTrpc`'s wiring + the renderer's `trpcClient.ts` shape grep covers the durable assertions. Acceptable trade-off for the epic.

## Rejected Alternatives

- **Wire tRPC into the existing IPC layer (`main/src/ipc/index.ts`).** Would conflate Crystal's inherited handlers with the new typed surface. Rejected per the constraint "Crystal's `ipcMain.handle` IPC stays for inherited surface; tRPC for `cyboflow.*` only".
- **Skip the Orchestrator wiring in `main/src/index.ts` and defer to a later task.** Rejected because TASK-254's tRPC router has no real owner without an Orchestrator constructed in main; the wiring is the moment the contract becomes alive in production.
- **Pass the entire Orchestrator into the tRPC context.** Tempting (each procedure could call `ctx.orchestrator.runQueues.getOrCreate(...)`). Rejected for v1 to keep the context narrow — auth-principal only. Downstream epics will add named dependencies to context as needed.

## Lowest Confidence Area

The exact export shape of `trpc-electron@0.1.2` — the package's docs are thin and the search did not surface the exact named exports for v0.1.2. Implementation Step 1 says "verify exact path in node_modules/trpc-electron/dist/ if uncertain" — this is the runtime falsification. If the named exports differ from `createIPCHandler` / `exposeElectronTRPC`, swap to the actual names; the adapter pattern means the fix is localized to `ipcAdapter.ts` and `preload.ts`. If the package's API has changed enough that the v0.1.2 shape is unworkable (highly unlikely — the package has 32 releases and small surface), **ESCALATE TO HUMAN** and consider the rolled-our-own `ipcMain.handle`-typed-wrapper rejected alternative from TASK-251.
