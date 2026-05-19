---
id: TASK-657
idea: IDEA-019
status: ready
created: 2026-05-19T00:00:00Z
files_owned:
  - main/src/ipc/panels.ts
  - main/src/ipc/__tests__/panelsInitialize.test.ts
files_readonly:
  - main/src/services/terminalPanelManager.ts
  - main/src/services/panelManager.ts
  - shared/types/panels.ts
  - frontend/src/services/panelApi.ts
  - frontend/src/components/panels/TerminalPanel.tsx
  - main/src/preload.ts
  - main/src/ipc/__tests__/sessionJsonMessages.test.ts
  - main/src/ipc/__tests__/cyboflow.test.ts
  - main/vitest.config.ts
acceptance_criteria:
  - criterion: "`panels:initialize` for a terminal panel prefers `panel.state.customState.cwd` over `options?.cwd` over `process.cwd()`, in that priority order."
    verification: "Open `main/src/ipc/panels.ts` lines 110-131 and confirm the `if (panel.type === 'terminal')` branch resolves cwd as: customState.cwd (when present and non-empty string) → options.cwd → process.cwd(). Verified by the new unit test `panelsInitialize.test.ts` which exercises all three branches."
  - criterion: "When `options.cwd` is supplied to `panels:initialize` and `panel.state.customState.cwd` is unset, the resolved cwd is persisted into `panel.state.customState.cwd` via `panelManager.updatePanel` BEFORE `terminalPanelManager.initializeTerminal` is invoked."
    verification: "Unit test asserts `panelManager.updatePanel` is called with a `state.customState.cwd === '<options.cwd>'` payload and that the call happens before the `initializeTerminal` spy is invoked (mock call order check)."
  - criterion: "When `panel.state.customState.cwd` is already a non-empty string, `panels:initialize` does NOT overwrite it even if `options.cwd` is supplied with a different value."
    verification: "Unit test seeds the mock panel with `customState.cwd = '/already/set'`, calls the handler with `options.cwd = '/different'`, and asserts `initializeTerminal` is called with `/already/set` and `panelManager.updatePanel` is NOT called with a cwd change."
  - criterion: "The TypeScript narrowing for reading `customState.cwd` uses a type guard, not `as any`. `pnpm typecheck` exits 0."
    verification: "Run `cd main && pnpm typecheck` from repo root; expect exit code 0. Grep guard: `grep -n 'as any' main/src/ipc/panels.ts` returns no new occurrences relative to baseline."
  - criterion: "`pnpm lint` reports no new errors for `main/src/ipc/panels.ts`."
    verification: "Run `pnpm lint` from repo root; expect exit code 0."
  - criterion: "All existing tests under `main/src/ipc/__tests__/` continue to pass."
    verification: "Run `cd main && pnpm run test` (or `pnpm vitest run`) from repo root; expect exit code 0 and the new `panelsInitialize.test.ts` is included in the run."
depends_on: []
estimated_complexity: low
epic: standalone-terminal-panels
test_strategy:
  needed: true
  justification: "This task changes priority logic for a runtime fallback that has no visible UI surface. The behavior is only verifiable via direct unit tests of the IPC handler. The existing sibling tests in main/src/ipc/__tests__/ establish the handler-capture + vi.mock pattern — adding panelsInitialize.test.ts follows that pattern exactly."
  targets:
    - behavior: "panels:initialize resolves cwd as customState.cwd → options.cwd → process.cwd() with the priority documented in AC1"
      test_file: "main/src/ipc/__tests__/panelsInitialize.test.ts"
      type: unit
    - behavior: "panels:initialize persists resolved cwd into customState.cwd via panelManager.updatePanel before invoking terminalPanelManager.initializeTerminal when customState.cwd is initially unset"
      test_file: "main/src/ipc/__tests__/panelsInitialize.test.ts"
      type: unit
    - behavior: "panels:initialize does NOT overwrite an existing customState.cwd"
      test_file: "main/src/ipc/__tests__/panelsInitialize.test.ts"
      type: unit
    - behavior: "panels:initialize for non-terminal panels (e.g. claude) does NOT call terminalPanelManager.initializeTerminal regardless of options.cwd"
      test_file: "main/src/ipc/__tests__/panelsInitialize.test.ts"
      type: unit
---

# Fix `panels:initialize` cwd routing and persist cwd in panel customState

## Objective

Repair the terminal-panel cwd resolution path so a worktree- or project-rooted cwd is reliably honored at PTY spawn time. Today, `main/src/ipc/panels.ts:126` resolves cwd as `options?.cwd || process.cwd()`. In Electron's main process, `process.cwd()` is the app bundle directory (useless for shell work), and there is no guarantee that the caller — including future callers introduced by TASK-658 — has a `SessionContext` providing `workingDirectory`. The fix is two-fold: (1) prefer the cwd persisted in `panel.state.customState.cwd` over the runtime `options?.cwd`, so once a panel has a cwd it survives panel restoration / re-initialization paths; and (2) persist the resolved cwd into `customState.cwd` at initialize-time when it is not yet set, so the header breadcrumb (TASK-659) and any subsequent re-init read a single source of truth. This task is a backend-only change inside `panels:initialize`; it does NOT touch the frontend `panels:create` call site (that path is exercised by TASK-658) and does NOT touch any UI component.

## Implementation Steps

1. **Add a typed cwd-resolver helper inside `registerPanelHandlers`** in `main/src/ipc/panels.ts`. Place it as a local function (or inline expression) immediately above the `if (panel.type === 'terminal')` block at line 125. Signature: `resolveTerminalCwd(panel: ToolPanel, optionsCwd?: string): string`. Logic, in priority order:
   - If `panel.state.customState` is an object with a `cwd` property of type `string` and length > 0, return that.
   - Else if `optionsCwd` is a non-empty string, return that.
   - Else return `process.cwd()` (preserves today's last-resort fallback).
   Use a narrow type guard `(state: ToolPanelState['customState']): state is { cwd: string }` — do NOT use `as any`. The pattern at `terminalPanelManager.ts:249` (`'cwd' in panel.state.customState`) is the canonical narrowing already used in the codebase; mirror it.

2. **Rewrite the terminal branch of `panels:initialize`** (`main/src/ipc/panels.ts` lines 125-128). Replace:
   ```ts
   if (panel.type === 'terminal') {
     const cwd = options?.cwd || process.cwd();
     await terminalPanelManager.initializeTerminal(panel, cwd);
   }
   ```
   with:
   ```ts
   if (panel.type === 'terminal') {
     const resolvedCwd = resolveTerminalCwd(panel, options?.cwd);

     // Persist resolvedCwd into customState.cwd BEFORE spawning the PTY so the
     // panel record has a stable source of truth (used by the breadcrumb header
     // in TASK-659 and by any re-initialization path).
     const existingCustomState = panel.state.customState ?? {};
     const hasExistingCwd =
       typeof existingCustomState === 'object' &&
       existingCustomState !== null &&
       'cwd' in existingCustomState &&
       typeof (existingCustomState as { cwd?: unknown }).cwd === 'string' &&
       ((existingCustomState as { cwd: string }).cwd.length > 0);

     if (!hasExistingCwd) {
       const nextCustomState = {
         ...(typeof existingCustomState === 'object' && existingCustomState !== null
           ? existingCustomState
           : {}),
         cwd: resolvedCwd,
       };
       await panelManager.updatePanel(panel.id, {
         state: { ...panel.state, customState: nextCustomState },
       });
     }

     await terminalPanelManager.initializeTerminal(panel, resolvedCwd);
   }
   ```
   Important constraints:
   - The `updatePanel` call MUST happen before `initializeTerminal`, because `terminalPanelManager.initializeTerminal` itself rewrites `customState` (terminalPanelManager.ts lines 82-91) with the cwd-it-was-passed. Persisting first ensures the post-init `customState` shape is `{cwd, isInitialized, shellType, dimensions}` regardless of which branch produced the cwd, and ensures the next `panels:initialize` for the same panel honors the persisted cwd.
   - Do NOT remove or modify the existing `hasBeenViewed` handling at lines 119-122 — it must continue to run before the type-specific branch.

3. **Add a unit test file** at `main/src/ipc/__tests__/panelsInitialize.test.ts` (new file, create it). Follow the pattern in `main/src/ipc/__tests__/cyboflow.test.ts` (handler capture via `ipcMain.handle` mock) and `sessionJsonMessages.test.ts` (vi.mock of `panelManager`). Required test cases — one per AC, four total:

   - **Case A: customState.cwd takes priority.** Seed mock `panelManager.getPanel` to return a terminal panel with `state.customState = { cwd: '/already/set' }`. Invoke the `panels:initialize` handler with `options = { cwd: '/from-options' }`. Assert: `terminalPanelManager.initializeTerminal` is called with `(panel, '/already/set')`; `panelManager.updatePanel` is NOT called with a `state.customState.cwd` change (it may still be called for `hasBeenViewed`, so assert specifically that no `updatePanel` call has `state.customState.cwd === '/from-options'`).
   - **Case B: options.cwd persisted when customState.cwd is unset.** Seed `panelManager.getPanel` to return a terminal panel with `state.customState = {}` (no cwd). Invoke with `options = { cwd: '/from-options' }`. Assert: `panelManager.updatePanel` is called with a `state.customState.cwd === '/from-options'` payload, AND that call's invocation order index is LESS than `terminalPanelManager.initializeTerminal`'s invocation order index. Use `vi.fn().mock.invocationCallOrder` to compare.
   - **Case C: process.cwd() fallback.** Seed `panelManager.getPanel` to return a terminal panel with `state.customState = {}`. Invoke with `options = undefined`. Assert: `terminalPanelManager.initializeTerminal` is called with `(panel, process.cwd())` and `panelManager.updatePanel` receives `state.customState.cwd === process.cwd()`.
   - **Case D: non-terminal panel is not affected.** Seed `panelManager.getPanel` to return a `type: 'claude'` panel. Invoke with `options = { cwd: '/foo' }`. Assert: `terminalPanelManager.initializeTerminal` is NOT called. (Tests that the new code does not regress the existing claude/diff/editor passthrough.)

   Use the same `vi.mock('electron', ...)` and `vi.mock('../../services/panelManager', ...)` stubs as `sessionJsonMessages.test.ts`. Add a `vi.mock('../../services/terminalPanelManager', ...)` returning `{ terminalPanelManager: { initializeTerminal: vi.fn() } }`. Use a handler-capture helper identical to `makeHandlerCapture()` in `cyboflow.test.ts` lines 60-69.

4. **Run the gates and confirm green:**
   - `cd main && pnpm typecheck` exits 0.
   - `pnpm lint` exits 0.
   - `cd main && pnpm run test` (or root `pnpm test:unit` if that path is wired — check `main/package.json` `"test"` script) exits 0 and the four new cases pass.

5. **Commit.** One commit, message: `fix(TASK-657): persist and prefer customState.cwd in panels:initialize`. Stage only `main/src/ipc/panels.ts` and `main/src/ipc/__tests__/panelsInitialize.test.ts`.

## Acceptance Criteria

Each criterion in the frontmatter maps to one verification command or test case. Re-stated for clarity:

1. **Priority order is customState.cwd → options.cwd → process.cwd().** Verified by Case A (customState wins), Case B (options used when customState absent), Case C (process.cwd fallback).
2. **Resolved cwd is persisted into customState.cwd before PTY spawn.** Verified by Case B's invocation-order assertion.
3. **Existing customState.cwd is never overwritten.** Verified by Case A's `updatePanel` call-shape assertion.
4. **Type-safe (no `any`).** Verified by `pnpm typecheck` exit 0 and a grep over the modified file showing no new `as any` introductions.
5. **Lint clean.** Verified by `pnpm lint` exit 0.
6. **No regression of existing IPC tests.** Verified by `pnpm run test` exit 0; the new test file is auto-picked up by the include glob `src/**/*.{test,spec}.ts` in `main/vitest.config.ts:21`.

## Test Strategy

Create one new file: `main/src/ipc/__tests__/panelsInitialize.test.ts`. Four `it()` blocks (Cases A–D above) inside a single `describe('registerPanelHandlers — panels:initialize cwd routing', ...)`.

Setup pattern (copy-adapt from `sessionJsonMessages.test.ts` lines 14-32):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/mock/path'),
    getName: vi.fn(() => 'Cyboflow'),
    getVersion: vi.fn(() => '0.1.0'),
  },
}));

const mockPanelManager = {
  getPanel: vi.fn(),
  updatePanel: vi.fn().mockResolvedValue(undefined),
};
const mockTerminalPanelManager = {
  initializeTerminal: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../../services/panelManager', () => ({ panelManager: mockPanelManager }));
vi.mock('../../services/terminalPanelManager', () => ({
  terminalPanelManager: mockTerminalPanelManager,
}));
vi.mock('../../services/database', () => ({
  databaseService: { getActivePanel: vi.fn() },
}));
```

Use a `makeHandlerCapture()` helper (copy from `cyboflow.test.ts` lines 60-69) to capture the `panels:initialize` handler. Import `registerPanelHandlers` from `../panels`. In `beforeEach`, reset all mocks and re-register handlers.

For invocation-order assertions in Case B, use:
```ts
const updateCallOrder = mockPanelManager.updatePanel.mock.invocationCallOrder
  .find(/* the call with customState.cwd set */);
const initCallOrder = mockTerminalPanelManager.initializeTerminal.mock.invocationCallOrder[0];
expect(updateCallOrder).toBeLessThan(initCallOrder);
```

Mocks for `AppServices` (the second arg to `registerPanelHandlers`) can be `{ analyticsManager: undefined } as unknown as AppServices` — `panels:initialize` does not touch `services`.

## Hardest Decision

**Should `panels:initialize` persist the resolved cwd back to `customState.cwd`, or only read from there and rely on the eventual `terminalPanelManager.initializeTerminal` to write it (which it already does at lines 82-91)?**

Chosen: **persist in `panels:initialize` BEFORE calling `initializeTerminal`.** Rationale:

1. `terminalPanelManager.initializeTerminal` is short-circuited at line 31 (`if (this.terminals.has(panel.id)) return`) when the terminal already exists in memory. In that path no `customState` update occurs at all — the IPC layer is the only place guaranteed to run on every `panels:initialize` call.
2. TASK-659 (cwd breadcrumb header) needs `panel.state.customState.cwd` to be authoritative immediately after `panels:initialize` resolves, not after the first PTY data event. Persisting at the IPC layer makes the breadcrumb a pure read of `panel.state` with no race.
3. The cost is one extra `databaseService.updatePanel` write per terminal panel creation — negligible. The benefit is a single source of truth that all future read sites (header, restoration, save-state) can trust without inspecting `terminalPanelManager`'s internal map.

The alternative — letting `terminalPanelManager` be the sole writer of `customState.cwd` — was rejected because of the short-circuit at line 31 and because it spreads cwd-source-of-truth across two modules.

## Rejected Alternatives

- **Make `options.cwd` mandatory and remove the `process.cwd()` fallback entirely.** Rejected: would break any panel restoration path that calls `panels:initialize` without `options` (the current `TerminalPanel.tsx:69` already passes one, but defensive code in `panels:initialize` should not assume that). Would also force a larger frontend change in TASK-658. Would reconsider if a future task enforces a stricter IPC contract via a Zod schema on `options`.
- **Resolve cwd in `terminalPanelManager.initializeTerminal` instead of in `panels:initialize`.** Rejected: that would require `terminalPanelManager` to know about the `options` IPC parameter, conflating IPC-level routing with PTY-management. The current architecture cleanly separates IPC dispatch (panels.ts) from PTY lifecycle (terminalPanelManager.ts); preserve that. Would reconsider if a non-IPC code path (e.g. session restoration on app startup) needed the same resolution logic — at which point extracting `resolveTerminalCwd` to a shared util would be the move.
- **Store cwd on the session row instead of `customState.cwd`.** Rejected: session.worktreePath/projectPath already serve as the "source" the frontend reads from when constructing `initialState.cwd` in TASK-658. Duplicating cwd on the session row would create drift. `customState.cwd` is the per-panel snapshot — different terminal panels on the same session could theoretically have different cwds (user could `cd` after spawn), so it correctly lives on the panel.

## Lowest Confidence Area

**The interaction between this task and TASK-658's `panelApi.createPanel({ initialState: { cwd } })` call site.** Specifically: when TASK-658 lands and passes `initialState.cwd`, the `panels:create` handler stores that into `panel.state.customState` via `panelManager.createPanel` (`main/src/services/panelManager.ts:63`, the `customState: request.initialState || {}` line). At that point, `panel.state.customState` becomes the entire `initialState` object — NOT `{ cwd: <value> }` nested inside `customState`. If the frontend passes `{ cwd: '/worktree' }` as `initialState`, then `customState.cwd === '/worktree'` and this task's logic works correctly. But if TASK-658 mistakenly passes `{ customState: { cwd: '/worktree' } }` (nested), then `customState.cwd` would be undefined and this task's logic would fall through to `options.cwd`. The fall-through is safe — no crash, just goes to the next priority — but it would defeat the persistence goal.

Mitigation: TASK-658's plan must explicitly call out that `initialState` is passed flat (`{ cwd: '<path>' }`), matching the `TerminalPanelState` shape in `shared/types/panels.ts:19-38`. This is consistent with how `request.initialState` is destructured in `panelManager.createPanel:63`, where `customState: request.initialState || {}` means whatever is passed becomes the entire `customState`. The current task's Case A test covers the correct shape; if TASK-658 deviates, integration testing during TASK-659's manual verification will catch it.
