---
id: TASK-731
idea: FIND-SPRINT-032-3
status: ready
created: "2026-05-22T00:00:00Z"
files_owned:
  - frontend/src/hooks/usePanelSurface.ts
  - frontend/src/hooks/__tests__/usePanelSurface.test.tsx
  - frontend/src/components/cyboflow/CyboflowRoot.tsx
  - frontend/src/components/ProjectView.tsx
files_readonly:
  - frontend/src/hooks/useAddTerminalPanel.ts
  - frontend/src/hooks/useEnsureClaudePanel.ts
  - frontend/src/hooks/__tests__/useAddTerminalPanel.test.tsx
  - frontend/src/hooks/__tests__/useEnsureClaudePanel.test.tsx
  - frontend/src/stores/panelStore.ts
  - frontend/src/services/panelApi.ts
  - frontend/src/utils/api.ts
  - frontend/src/stores/sessionStore.ts
  - frontend/src/types/session.ts
  - frontend/src/types/electron.d.ts
  - shared/types/panels.ts
  - frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx
  - .soloflow/active/findings/SPRINT-032-findings.md
  - .soloflow/active/plans/cyboflow-shell-architecture/TASK-690-plan.md
  - .soloflow/active/plans/cyboflow-shell-architecture/TASK-691-plan.md
acceptance_criteria:
  - criterion: "A new hook file exists at `frontend/src/hooks/usePanelSurface.ts` exporting a single hook `usePanelSurface(projectId, { autoCreatePermanentPanels })` that returns `{ mainRepoSession, sessionPanels, currentActivePanel, handlePanelSelect, handlePanelClose }`."
    verification: "test -e frontend/src/hooks/usePanelSurface.ts AND grep -nE 'export function usePanelSurface' frontend/src/hooks/usePanelSurface.ts returns 1 match AND grep -nE 'autoCreatePermanentPanels' frontend/src/hooks/usePanelSurface.ts returns ≥1 match"
  - criterion: "`CyboflowRoot.tsx` consumes the hook with `autoCreatePermanentPanels: false` and no longer contains its own panel-surface scaffolding (no inline `loadPanelsForSession`, no inline `onPanelCreated` subscription, no inline `handlePanelSelect`/`handlePanelClose` definitions)."
    verification: "grep -nE 'usePanelSurface\\s*\\(' frontend/src/components/cyboflow/CyboflowRoot.tsx returns ≥1 match AND grep -nE 'autoCreatePermanentPanels:\\s*false' frontend/src/components/cyboflow/CyboflowRoot.tsx returns 1 match AND grep -nE 'panelApi\\.loadPanelsForSession' frontend/src/components/cyboflow/CyboflowRoot.tsx returns 0 matches AND grep -nE 'onPanelCreated' frontend/src/components/cyboflow/CyboflowRoot.tsx returns 0 matches"
  - criterion: "`ProjectView.tsx` consumes the hook with `autoCreatePermanentPanels: true` and no longer contains its own panel-surface scaffolding (no inline `loadPanelsForSession`, no inline `onPanelCreated` subscription, no inline `handlePanelSelect`/`handlePanelClose` definitions). The dashboard/setup-tasks auto-creation logic and the permanent-panel close-guard MUST be preserved — they now live inside `usePanelSurface` behind the `autoCreatePermanentPanels: true` branch."
    verification: "grep -nE 'usePanelSurface\\s*\\(' frontend/src/components/ProjectView.tsx returns ≥1 match AND grep -nE 'autoCreatePermanentPanels:\\s*true' frontend/src/components/ProjectView.tsx returns 1 match AND grep -nE 'panelApi\\.loadPanelsForSession' frontend/src/components/ProjectView.tsx returns 0 matches AND grep -nE 'onPanelCreated' frontend/src/components/ProjectView.tsx returns 0 matches"
  - criterion: "The dashboard / setup-tasks auto-creation behavior moves intact into the hook. When `autoCreatePermanentPanels: true`, the hook calls `panelApi.createPanel` with `type: 'dashboard'` and `type: 'setup-tasks'` (each with `metadata.permanent: true`) when the corresponding panel is missing."
    verification: "grep -nE \"type:\\s*['\\\"]dashboard['\\\"]\" frontend/src/hooks/usePanelSurface.ts returns 1 match AND grep -nE \"type:\\s*['\\\"]setup-tasks['\\\"]\" frontend/src/hooks/usePanelSurface.ts returns 1 match AND grep -nE 'permanent:\\s*true' frontend/src/hooks/usePanelSurface.ts returns ≥2 matches"
  - criterion: "The permanence guard moves intact into the hook. When `autoCreatePermanentPanels: true`, `handlePanelClose` short-circuits without deletion when the panel's `type` is `'dashboard'` or `'setup-tasks'`."
    verification: "grep -nE \"panel\\.type === ['\\\"]dashboard['\\\"]\" frontend/src/hooks/usePanelSurface.ts returns ≥1 match AND grep -nE \"panel\\.type === ['\\\"]setup-tasks['\\\"]\" frontend/src/hooks/usePanelSurface.ts returns ≥1 match"
  - criterion: "ProjectView's dashboard-fallback in `handlePanelClose` (its line 144 today) — when no adjacent panel exists, fall back to the dashboard — is preserved in the hook under the `autoCreatePermanentPanels: true` branch."
    verification: "grep -nE \"find\\(.*type === ['\\\"]dashboard['\\\"]\\)\" frontend/src/hooks/usePanelSurface.ts returns ≥1 match"
  - criterion: "A new test file `frontend/src/hooks/__tests__/usePanelSurface.test.tsx` exercises both flag values and at minimum covers: (a) `autoCreatePermanentPanels: false` does NOT call `panelApi.createPanel` for dashboard/setup-tasks; (b) `autoCreatePermanentPanels: true` creates both permanent panels when absent; (c) `autoCreatePermanentPanels: true` short-circuits `handlePanelClose` for a `dashboard` panel; (d) `autoCreatePermanentPanels: false` allows `handlePanelClose` to delete any panel; (e) panel-created subscription adds panels for matching `sessionId` and ignores other sessions."
    verification: "test -e frontend/src/hooks/__tests__/usePanelSurface.test.tsx AND grep -cE \"\\bit\\(\" frontend/src/hooks/__tests__/usePanelSurface.test.tsx returns ≥5"
  - criterion: Existing `CyboflowRoot.test.tsx` continues to pass without modification (or with mock-shape adjustments only — no assertion changes).
    verification: pnpm --filter frontend test -- frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx exits 0
  - criterion: "`pnpm typecheck` exits 0."
    verification: pnpm typecheck exits 0
  - criterion: "`pnpm lint` exits 0."
    verification: pnpm lint exits 0
  - criterion: "Manual visual check: launching `pnpm dev`, opening a project (ProjectView path while TASK-690/691 are still in-flight) shows dashboard and setup-tasks panels auto-created and unclosable; opening the active-run shell (CyboflowRoot path) shows panels load from disk without auto-creation and every panel is closable."
    verification: "Run pnpm dev; visit a project that has no panels yet — observe Dashboard + Setup tabs appear automatically and the close 'x' is hidden/disabled. Switch to the run-centric shell — observe panels load on-demand only and every tab's close 'x' works. Both surfaces tested in one session."
depends_on: []
estimated_complexity: medium
epic: standalone-terminal-panels
test_strategy:
  needed: true
  justification: "This is the FIND-SPRINT-032-3 fix — drift-prevention IS the feature. A new hook with two distinct flag-gated behaviors needs unit coverage of each branch; without it the next change to close semantics or auto-creation logic will silently break one call site. Sibling tests exist for the related shared hooks (useAddTerminalPanel, useEnsureClaudePanel) using the same renderHook+jsdom pattern, so the testing affordance is established and zero-cost to adopt. Additionally, `CyboflowRoot.test.tsx` is the sole sibling component test for either consumer and MUST be kept green — the extraction changes the implementation surface the test mocks (panelApi shape, electronAPI.events.onPanelCreated)."
  targets:
    - behavior: "autoCreatePermanentPanels=false: hook loads panels via panelApi.loadPanelsForSession but does NOT call panelApi.createPanel; sessionPanels reflects what came back."
      test_file: frontend/src/hooks/__tests__/usePanelSurface.test.tsx
      type: unit
    - behavior: "autoCreatePermanentPanels=true: when dashboard or setup-tasks panel is missing from loadPanelsForSession output, the hook calls panelApi.createPanel for each missing permanent type with metadata.permanent=true, then reloads."
      test_file: frontend/src/hooks/__tests__/usePanelSurface.test.tsx
      type: unit
    - behavior: "autoCreatePermanentPanels=true: handlePanelClose called on a panel with type='dashboard' or type='setup-tasks' is a no-op — no removePanel, no panelApi.deletePanel, no panelApi.setActivePanel."
      test_file: frontend/src/hooks/__tests__/usePanelSurface.test.tsx
      type: unit
    - behavior: "autoCreatePermanentPanels=false: handlePanelClose called on any panel removes it from the store and calls panelApi.deletePanel; no type-based guard fires."
      test_file: frontend/src/hooks/__tests__/usePanelSurface.test.tsx
      type: unit
    - behavior: "onPanelCreated subscription: when a panel:created event fires whose sessionId matches the resolved main-repo sessionId, the hook calls panelStore.addPanel; events for other sessions are ignored."
      test_file: frontend/src/hooks/__tests__/usePanelSurface.test.tsx
      type: unit
    - behavior: Existing CyboflowRoot empty-state / active-run / modal-toggle / auto-close-on-run-start assertions remain green — the extraction is implementation-internal and observable behavior is unchanged.
      test_file: frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx
      type: component
---
# Extract usePanelSurface hook from CyboflowRoot and ProjectView

## Objective

Eliminate the ~90-line panel-surface duplication between `frontend/src/components/cyboflow/CyboflowRoot.tsx:38-114` and `frontend/src/components/ProjectView.tsx:31-160 + 256-277` flagged by FIND-SPRINT-032-3. TASK-693 correctly extracted the add-panel callbacks (`useAddTerminalPanel`, `useEnsureClaudePanel`) but left the surrounding session-resolution + load-panels + on-created + select/close scaffolding copy-adapted. The implementations already diverge on close semantics (ProjectView guards dashboard/setup-tasks; CyboflowRoot doesn't) and that divergence is invisible — every future panel-lifecycle change has to be made twice. Pull both into a single hook `usePanelSurface(projectId, { autoCreatePermanentPanels })` so the divergence becomes one explicit flag instead of two near-identical files. Lock both call sites onto the hook now, during the TASK-690/691 transition window, to halt the drift before ProjectView is deleted (and the hook becomes a CyboflowRoot-only utility that's still worth its weight as a single owner of the panel-surface contract).

## Implementation Steps

1. **Create `frontend/src/hooks/usePanelSurface.ts`** (new file). Header JSDoc explaining the FIND-SPRINT-032-3 origin and the `autoCreatePermanentPanels` flag's role. Public type:
   ```ts
   import { useEffect, useState, useCallback, useMemo } from 'react';
   import type { Session } from '../types/session';
   import type { ToolPanel } from '../../../shared/types/panels';
   import { usePanelStore } from '../stores/panelStore';
   import { panelApi } from '../services/panelApi';
   import { API } from '../utils/api';

   export interface UsePanelSurfaceOptions {
     /**
      * When true (ProjectView contract): the hook auto-creates `dashboard` and
      * `setup-tasks` permanent panels on first load if missing, and
      * `handlePanelClose` short-circuits for those types. When false
      * (CyboflowRoot contract): no auto-creation, every panel is closable.
      */
     autoCreatePermanentPanels: boolean;
   }

   export interface UsePanelSurfaceResult {
     mainRepoSession: Session | null;
     sessionPanels: ToolPanel[];
     currentActivePanel: ToolPanel | undefined;
     handlePanelSelect: (panel: ToolPanel) => Promise<void>;
     handlePanelClose: (panel: ToolPanel) => Promise<void>;
   }

   export function usePanelSurface(
     projectId: number | null,
     options: UsePanelSurfaceOptions,
   ): UsePanelSurfaceResult { /* ... */ }
   ```
   Implementation MUST port the following slices verbatim (only the flag-gated branches differ):

   - **Main-repo session resolution** (port from `CyboflowRoot.tsx:39-65`). Two pieces of `useState`: `mainRepoSessionId: string | null`, `mainRepoSession: Session | null`. One `useEffect` keyed on `projectId` that, when `projectId !== null`, calls `API.sessions.getOrCreateMainRepoSession(projectId)`; on success sets both ids; uses the cancelled flag pattern.
     - Do NOT port `ProjectView`'s `isLoadingSession` boolean — it's a UI loading-spinner concern, not a panel-surface concern; ProjectView keeps managing its own loading spinner independently.
     - Do NOT port `ProjectView`'s `useSessionStore.subscribe(...)` block at lines 239-253 — that's a sessionStore wiring concern outside the panel surface. ProjectView keeps that block; the hook owns only the session resolution + panel wiring.

   - **Load panels effect** (port from `ProjectView.tsx:46-105` for `autoCreatePermanentPanels: true` AND from `CyboflowRoot.tsx:67-73` for `autoCreatePermanentPanels: false`). Keyed on `mainRepoSessionId` and the two store setters. When `autoCreatePermanentPanels: false`: just `panelApi.loadPanelsForSession(id).then(setPanels)`. When `autoCreatePermanentPanels: true`: load, check for dashboard + setup-tasks, create whichever is missing via `panelApi.createPanel({ sessionId, type, title, metadata: { permanent: true } })`, reload, then call `panelApi.getActivePanel(sessionId)` and, if no active panel, prioritize `setup-tasks` over `dashboard` for initial activation; if there IS an active panel, just call `setActivePanelInStore(id, activePanel.id)`. This whole block lives behind a single `if (options.autoCreatePermanentPanels)` branch inside the effect.

   - **onPanelCreated subscription** (port from `CyboflowRoot.tsx:75-83` — identical in `ProjectView.tsx:256-277` modulo console.log). `useEffect` keyed on `[mainRepoSessionId, addPanel]`. Calls `window.electronAPI?.events?.onPanelCreated?.(handler)`; handler filters on `panel.sessionId === mainRepoSessionId` then calls `addPanel(panel)`. Cleanup unsubscribes.

   - **Memos** (identical in both files). `sessionPanels = panels[mainRepoSessionId ?? ''] ?? []`. `currentActivePanel = sessionPanels.find(p => p.id === activePanels[mainRepoSessionId ?? ''])`.

   - **handlePanelSelect** (identical in both files). `useCallback` keyed on `[mainRepoSessionId, setActivePanelInStore]`. Guards on `!mainRepoSessionId`, calls `setActivePanelInStore` then `await panelApi.setActivePanel(id, panel.id)`.

   - **handlePanelClose** (flag-gated). Guards on `!mainRepoSessionId`. When `autoCreatePermanentPanels: true`: short-circuit when `panel.type === 'dashboard' || panel.type === 'setup-tasks'` (the permanence guard); find next adjacent panel; if no adjacent or it's the same panel, fall back to `sessionPanels.find(p => p.type === 'dashboard') || sessionPanels[0]` (the dashboard-fallback); proceed with `removePanel` + `setActivePanelInStore` + `panelApi.setActivePanel` + `panelApi.deletePanel`. When `autoCreatePermanentPanels: false`: no guard, no dashboard-fallback; just find adjacent next panel; proceed with the same remove + activate + delete sequence. Keyed on `[mainRepoSessionId, sessionPanels, removePanel, setActivePanelInStore, options.autoCreatePermanentPanels]`.

   Return the result object.

2. **Create `frontend/src/hooks/__tests__/usePanelSurface.test.tsx`** (new file). Follow the established sibling-hook pattern (see `useAddTerminalPanel.test.tsx` lines 1-80). `vi.hoisted()` for mock functions: `mockGetOrCreateMainRepoSession`, `mockLoadPanelsForSession`, `mockCreatePanel`, `mockGetActivePanel`, `mockSetActivePanel`, `mockDeletePanel`, plus zustand store mocks for `setPanels`/`addPanel`/`removePanel`/`setActivePanelInStore`. Mock `../../utils/api`, `../../services/panelApi`, `../../stores/panelStore`. Mock `window.electronAPI.events.onPanelCreated` returning a recordable unsubscribe spy. Cover the five `test_strategy.targets` behaviors above, plus a sanity test that `projectId === null` does NOT call `API.sessions.getOrCreateMainRepoSession`.

3. **Edit `frontend/src/components/cyboflow/CyboflowRoot.tsx`** — refactor onto the hook.
   - Delete lines 39-40 (the two useState declarations for `mainRepoSessionId`/`mainRepoSession`).
   - Delete lines 42 — split the `usePanelStore` destructure so only the bits the file STILL needs remain. After extraction the only consumer in this file is the panel surface block (which now gets `sessionPanels` and `currentActivePanel` from the hook), so the destructure can be removed entirely. Confirm with a `grep -n 'usePanelStore' CyboflowRoot.tsx` afterwards → 0 matches; if any remain (e.g. for `addPanel` consumed elsewhere), keep those only.
   - Delete the three `useEffect` blocks at lines 45-65 (session resolution), 68-73 (load panels), 76-83 (panel-created subscription).
   - Delete the two `useMemo` blocks at lines 85-93.
   - Delete `handlePanelSelect` at lines 95-99 and `handlePanelClose` at lines 101-114.
   - Add the hook call near the top of the function body (after the existing `useState` for `isPickerOpen`):
     ```ts
     const { mainRepoSession, sessionPanels, currentActivePanel, handlePanelSelect, handlePanelClose } =
       usePanelSurface(projectId, { autoCreatePermanentPanels: false });
     ```
   - Adjust the JSX panel-surface block (currently keyed on `mainRepoSessionId`) to key on `mainRepoSession` (or `mainRepoSession?.id`) — `mainRepoSessionId` no longer exists in this file's scope. The render predicate at line 154 (`{mainRepoSessionId && (`) becomes `{mainRepoSession && (`. Inside the block, `mainRepoSession` is used directly.
   - The `useAddTerminalPanel`/`useEnsureClaudePanel`/shortcut hooks at lines 116-120 stay unchanged — they already take `mainRepoSession` as their first arg.
   - Add `import { usePanelSurface } from '../../hooks/usePanelSurface';` to the import block.

4. **Edit `frontend/src/components/ProjectView.tsx`** — refactor onto the hook (more delicate, because the file also runs `useSessionStore.subscribe` and `useSessionStore.setActiveSession` that must NOT move into the shared hook).
   - Replace the two `useState` declarations at lines 31-32 with the hook call:
     ```ts
     const { mainRepoSession, sessionPanels, currentActivePanel, handlePanelSelect, handlePanelClose } =
       usePanelSurface(projectId, { autoCreatePermanentPanels: true });
     const mainRepoSessionId = mainRepoSession?.id ?? null;
     ```
     Keep `mainRepoSessionId` as a derived local so the rest of the file's many references continue to compile.
   - Keep `const [isLoadingSession, setIsLoadingSession] = useState(false);` (still used by the loading-spinner branch at line 351).
   - Delete the `useState`/`useEffect` block that calls `API.sessions.getOrCreateMainRepoSession` (lines 207-236). The hook now owns that call. The `useSessionStore.getState().setActiveSession(mainRepoData.id)` side-effect at line 226 must be preserved as a separate `useEffect` that fires when `mainRepoSession?.id` changes:
     ```ts
     useEffect(() => {
       if (mainRepoSession?.id) {
         useSessionStore.getState().setActiveSession(mainRepoSession.id);
       }
     }, [mainRepoSession?.id]);
     ```
   - Set `isLoadingSession` correctly: replace its lifecycle. The hook does not surface a loading boolean; derive `isLoadingSession = projectId !== null && mainRepoSession === null` (true while the hook's getOrCreateMainRepoSession promise is in-flight). Implement via `useMemo`.
   - Delete the `useEffect` at lines 46-105 (load + auto-create + initial-active resolution) — hook owns it.
   - Delete the two `useMemo` blocks at lines 108-116 — hook owns them.
   - Delete `handlePanelSelect` (lines 119-126) and `handlePanelClose` (lines 128-160) — hook owns them.
   - Delete the panel-store destructure at lines 36-43 (the file no longer references `addPanel` / `removePanel` / `setActivePanelInStore` / `setPanels` / `panels` / `activePanels` directly). If `handleGitPull`/`handleGitPush` (lines 172-192) reference any of these, audit before deleting.
   - Delete the `useEffect` at lines 256-277 (`onPanelCreated` subscription) — hook owns it.
   - Keep the `useSessionStore.subscribe(...)` block at lines 239-253. This block syncs `mainRepoSession` state when other code mutates the sessionStore; the hook owns its OWN `mainRepoSession` state which is set only at `getOrCreateMainRepoSession` time, not on subsequent session updates. Replace this subscribe block's setter — instead of `setMainRepoSession`, this concern needs a different bridge. Two acceptable resolutions:
     - (a) Add a `forceRefreshSession?: () => Promise<void>` to the hook's return type so external code can re-fetch when the sessionStore signals a change. Lower cost; preserves single-owner state.
     - (b) Treat the sessionStore-subscription block as out-of-scope-for-extraction noise that ProjectView keeps locally, mutating a separate local `mainRepoSession` shadow. Adds drift.
     **Choose (a).** Surface `forceRefreshSession` from the hook; have ProjectView call it from inside the subscribe block. If the executor finds that no consumer needs this in practice (sessionStore mutations during a ProjectView session are unlikely), it MAY drop the subscribe block entirely — but only after grepping for callers of `useSessionStore.setState` that touch a `sessions` array entry matching the main-repo session id. Document the decision in the PR body.
   - Confirm the debug `useEffect` at lines 197-204 still compiles — it references `mainRepoSessionId`, `mainRepoSession`, `currentActivePanel` which all still exist as derived values.
   - Add `import { usePanelSurface } from '../hooks/usePanelSurface';` to the import block.

5. **Update `CyboflowRoot.test.tsx` mock surface (if required).** The existing mocks at lines 38-55 mock `../../../utils/api` (`API.sessions.getOrCreateMainRepoSession`) and `../../../services/panelApi`. The hook consumes both of these via the same import paths. Re-run the test file as-is; if it fails, the most likely cause is that the existing `data: null` mock now flows through the hook's `if (response.success && response.data)` guard, leaving `mainRepoSession === null` — which is exactly the assumption the test was already written under (`mainRepoSessionId` stays null, so the panel surface block does not render). No code-change is anticipated; if jsdom warnings appear about `window.electronAPI.events.onPanelCreated` being undefined, add a stub mock for it. Do NOT change any assertion.

6. **Verify the four sweep gates.**
   - `grep -nE 'panelApi\.loadPanelsForSession|onPanelCreated|sessionPanels\.find\(p => p\.id === activePanels' frontend/src/components/cyboflow/CyboflowRoot.tsx frontend/src/components/ProjectView.tsx` → 0 matches in either file.
   - `pnpm typecheck` exits 0.
   - `pnpm lint` exits 0.
   - `pnpm --filter frontend test -- frontend/src/hooks/__tests__/usePanelSurface.test.tsx frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx` exits 0.

7. **Manual visual verification** per the manual-AC. Open `pnpm dev`, visit a project (ProjectView path — TASK-690/691 in flight will keep this surface alive during this sprint), confirm Dashboard + Setup tabs auto-create with their close buttons hidden/disabled. Switch into a workflow run (CyboflowRoot path), confirm no auto-create and every tab is closable. Read `cyboflow-frontend-debug.log` if anything looks wrong — do not ship without the visual pass.

## Acceptance Criteria

1. **Hook exists with correct signature.** `frontend/src/hooks/usePanelSurface.ts` exports `usePanelSurface(projectId, options)` with the documented options + result shape.

2. **CyboflowRoot wired.** `CyboflowRoot.tsx` calls `usePanelSurface(projectId, { autoCreatePermanentPanels: false })` and no longer contains the inline panel-surface scaffolding.

3. **ProjectView wired.** `ProjectView.tsx` calls `usePanelSurface(projectId, { autoCreatePermanentPanels: true })` and no longer contains the inline panel-surface scaffolding. Dashboard/setup-tasks auto-creation + permanence guard + dashboard-fallback all live inside the hook now.

4. **Behavioral parity preserved.** The hook's `autoCreatePermanentPanels: true` branch reproduces ProjectView's prior behavior verbatim (dashboard + setup-tasks auto-create, close-guard on those types, dashboard-fallback when no adjacent panel exists). The `autoCreatePermanentPanels: false` branch reproduces CyboflowRoot's prior behavior verbatim (no auto-create, every panel closable).

5. **Test coverage in place.** `usePanelSurface.test.tsx` contains ≥5 `it()` blocks covering both flag values across load, auto-create gate, close-guard, on-created subscription scoping, and the projectId-null no-op case.

6. **Existing CyboflowRoot test stays green.** No assertion-level changes to `CyboflowRoot.test.tsx`; the file may need only mock-surface additions if jsdom flags a missing API.

7. **Type/lint/test/visual gates green.** `pnpm typecheck`, `pnpm lint`, the two test files, and the manual visual pass all clear.

## Test Strategy

Five new `it()` blocks in `frontend/src/hooks/__tests__/usePanelSurface.test.tsx` per the frontmatter `test_strategy.targets`:

- (a) `autoCreatePermanentPanels: false` — load only, no create calls.
- (b) `autoCreatePermanentPanels: true` — missing dashboard & setup-tasks triggers create + reload.
- (c) `autoCreatePermanentPanels: true` — `handlePanelClose` on dashboard is a no-op.
- (d) `autoCreatePermanentPanels: false` — `handlePanelClose` on dashboard deletes normally.
- (e) `onPanelCreated` event with matching sessionId → addPanel called; non-matching → ignored.

Plus the existing `CyboflowRoot.test.tsx` runs as a regression gate. Setup mirrors the established `useAddTerminalPanel.test.tsx` pattern — `vi.hoisted()` mocks for `panelApi`, `usePanelStore`, `API.sessions`, plus a recordable `window.electronAPI.events.onPanelCreated` spy.

## Hardest Decision

**Extract now vs. defer until TASK-690/691 ship and just delete ProjectView's copy.** The compounder note in the prompt frames this explicitly.

- **(a) Extract now (chosen).** Both call sites adopt the hook during the TASK-690/691 transition window. Drift is halted before the window closes. The cost: medium-sized PR that touches three files and adds a new test file. Risk: TASK-690/691 may land before this does, in which case ProjectView disappears and step 4 becomes wasted effort.

- **(b) Defer.** Wait for TASK-690 + TASK-691 to retire ProjectView, then delete its copy and leave CyboflowRoot's inline. Saves ~half the PR effort. Risk: the close-semantics divergence flagged by FIND-SPRINT-032-3 is still live during the transition window; any feature work touching panel close in either file during that window will re-introduce a third inconsistent shape, undermining the in-progress retirement.

Chose (a) because (1) FIND-SPRINT-032-3 was filed precisely because the divergence has already started causing review-time mental load, and (2) even in the post-TASK-691 world, having `usePanelSurface` as a single owner of the panel-surface contract is worth its weight — the `autoCreatePermanentPanels: false` branch becomes the *only* branch, the `true` branch can be deleted in a tiny follow-up, but the seam stays. The forward-compatible direction is to make the seam exist; the backward-compatible direction is to do nothing.

Would change my mind if the planner can confirm TASK-690 + TASK-691 will both land before this task can be executed (e.g. both are in the next sprint's `in-flight` queue, this one isn't). If both ship first, this becomes a smaller "extract the (now sole) CyboflowRoot scaffolding into usePanelSurface" task — still worth doing, but the `autoCreatePermanentPanels` flag would be born already-deletable.

## Rejected Alternatives

- **Single-flag-bag `options` object with more knobs (e.g. `initialActivePanelStrategy`, `closeFallbackStrategy`).** Over-engineering. The two consumers differ on one axis — auto-create-permanent-panels — and it's load-bearing. Hide everything else behind that single flag.

- **Two separate hooks `usePanelSurfaceRunCentric` and `usePanelSurfaceProjectCentric`.** Symmetrical with the find's framing but reintroduces duplication immediately (the load/select/subscribe scaffolding is identical). The flag is the right shape.

- **Move `useSessionStore.setActiveSession` into the hook.** Tempting because ProjectView's session-resolution `useEffect` currently calls it at line 226. Rejected because `CyboflowRoot` deliberately does NOT set the active session — the run-centric shell tracks its active state through `cyboflowStore.activeRunId`. Setting `sessionStore.activeSessionId` from the hook would silently couple the two stores in CyboflowRoot, breaking the empty-state-CTA flow in the existing `CyboflowRoot.test.tsx`. Leave that call in ProjectView as a separate effect (step 4) — it's project-shell concern, not panel-surface concern.

- **Use the hook to also own `useAddTerminalPanel` / `useEnsureClaudePanel` plumbing as the find's `suggested_action` proposed.** Rejected. Those hooks are already extracted and consumed independently by both files plus by shortcut hooks (`useAddTerminalShortcut`, `useAddClaudeShortcut`). Folding them under `usePanelSurface` would make the hook's surface too wide and would force changes to the shortcut wiring with no clear win. Leave them as siblings.

## Lowest Confidence Area

**Step 4's resolution of ProjectView's `useSessionStore.subscribe` block (lines 239-253).** That block syncs ProjectView's local `mainRepoSession` state when other code mutates the sessionStore (e.g. a sessionStore update for the main-repo session row). After extraction, the hook owns `mainRepoSession`, but the hook does NOT subscribe to sessionStore — it only reads from `API.sessions.getOrCreateMainRepoSession` once at projectId change. If any production code path mutates `sessionStore.sessions` with an updated row for the main-repo session AND ProjectView is the consumer that needs to reflect the change in its panel surface (e.g. for `mainRepoSession.isMainRepo` in `PanelContainer` props), proposal (a) above (`forceRefreshSession`) is the load-bearing escape hatch. The executor SHOULD grep for `useSessionStore.setState` and `useSessionStore.getState().sessions` callers before deciding whether to keep the subscribe block; if no production caller mutates the main-repo session row mid-session, the block is dead and the hook's one-shot fetch is sufficient. Document the determination in the PR body.

A secondary uncertainty: the existing `CyboflowRoot.test.tsx` mocks `panelApi.loadPanelsForSession` and `API.sessions.getOrCreateMainRepoSession` at module level. The hook consumes both via the same paths, so the mocks should resolve correctly without changes. If vitest's hoisting causes the hook's internal imports to bind before the mocks register (it shouldn't — `vi.mock` is hoisted), the test will fail in a confusing way. If that happens, add the mocks inside `vi.hoisted` factories rather than relying on bare `vi.mock` paths.
