---
id: TASK-680
idea: SPRINT-025-compounder
status: ready
created: 2026-05-20T00:00:00Z
files_owned:
  - frontend/src/hooks/useAddTerminalPanel.ts
  - frontend/src/hooks/__tests__/useAddTerminalPanel.test.tsx
  - frontend/src/components/SessionView.tsx
  - frontend/src/components/ProjectView.tsx
files_readonly:
  - frontend/src/services/panelApi.ts
  - frontend/src/stores/panelStore.ts
  - frontend/src/stores/sessionHistoryStore.ts
  - shared/types/panels.ts
acceptance_criteria:
  - criterion: "A new hook `useAddTerminalPanel` exists at `frontend/src/hooks/useAddTerminalPanel.ts`. The hook accepts `{ session, options? }` where `session` has `{ id: string; worktreePath: string }` and `options` is `{ onAfterActivate?: (sessionId: string, panelId: string) => void; logTag?: string }`. It returns a `handleAddTerminal: () => Promise<void>` callback memoized with useCallback. The hook depends on `usePanelStore` for `addPanel` and `setActivePanel`."
    verification: "Run `test -f frontend/src/hooks/useAddTerminalPanel.ts` (exit 0). Run `grep -n 'export function useAddTerminalPanel\\|export const useAddTerminalPanel' frontend/src/hooks/useAddTerminalPanel.ts` and confirm exactly 1 hit."
  - criterion: "`frontend/src/components/SessionView.tsx` consumes the hook: the inline `handleAddTerminal` useCallback at lines 250-268 is replaced with a single `const handleAddTerminal = useAddTerminalPanel({ session: activeSession, options: { onAfterActivate: addToHistory, logTag: 'SessionView' } });`. The `addToHistory` side-effect is preserved via the hook's option."
    verification: "Run `grep -n 'panelApi.createPanel' frontend/src/components/SessionView.tsx` and confirm 0 hits (the createPanel call lives in the hook now). Run `grep -n 'useAddTerminalPanel' frontend/src/components/SessionView.tsx` and confirm 1 hit."
  - criterion: "`frontend/src/components/ProjectView.tsx` consumes the hook: the inline `handleAddTerminal` useCallback at lines 176-193 is replaced with a single `const handleAddTerminal = useAddTerminalPanel({ session: mainRepoSession, options: { logTag: 'ProjectView' } });`. ProjectView does NOT pass `onAfterActivate` (it has no addToHistory side-effect today)."
    verification: "Run `grep -n 'panelApi.createPanel' frontend/src/components/ProjectView.tsx` and confirm only the createPanel calls outside the deleted handleAddTerminal block remain (there are 2 unrelated calls at lines 57 and 68 that are NOT to be touched). Run `grep -n 'useAddTerminalPanel' frontend/src/components/ProjectView.tsx` and confirm 1 hit."
  - criterion: "Both files continue to wire the hook's returned callback into `useAddTerminalShortcut(handleAddTerminal)` and the `<PanelTabBar onAddTerminal={handleAddTerminal} />` prop — call sites are unchanged in shape."
    verification: "Run `grep -n 'useAddTerminalShortcut(handleAddTerminal)' frontend/src/components/SessionView.tsx frontend/src/components/ProjectView.tsx` and confirm 2 hits (1 per file). Run `grep -n 'onAddTerminal={handleAddTerminal}' frontend/src/components/SessionView.tsx frontend/src/components/ProjectView.tsx` and confirm 2 hits."
  - criterion: "Tests pass — both the new hook test and the existing component tests."
    verification: "Run `pnpm --filter @cyboflow/frontend test`; exit code 0."
  - criterion: "Typecheck passes."
    verification: "Run `pnpm typecheck`; exit code 0."
depends_on: []
estimated_complexity: low
epic: standalone-terminal-panels
test_strategy:
  needed: true
  justification: "A new hook needs unit/integration coverage: the happy path (creates panel, adds to store, sets active, fires onAfterActivate), the no-session guard (returns early with a console.warn, never calls panelApi), and the no-worktreePath fallback (passes undefined/empty to initialState.cwd). Existing SessionView and ProjectView tests (if any) cover the integration path."
  targets:
    - behavior: "Happy path: useAddTerminalPanel returns a callback that calls panelApi.createPanel with the correct shape, calls addPanel, calls setActivePanel, calls panelApi.setActivePanel, and invokes onAfterActivate when provided."
      test_file: "frontend/src/hooks/__tests__/useAddTerminalPanel.test.tsx"
      type: unit
    - behavior: "Guard: when session is null/undefined, the callback logs a warning with the logTag and does NOT call panelApi.createPanel."
      test_file: "frontend/src/hooks/__tests__/useAddTerminalPanel.test.tsx"
      type: unit
    - behavior: "onAfterActivate is optional — when omitted (ProjectView pattern), the callback completes without invoking it."
      test_file: "frontend/src/hooks/__tests__/useAddTerminalPanel.test.tsx"
      type: unit
---

# Extract useAddTerminalPanel hook and consolidate ProjectView + SessionView handleAddTerminal duplication

## Objective

The near-verbatim `handleAddTerminal` callbacks in `frontend/src/components/ProjectView.tsx:176-193` and `frontend/src/components/SessionView.tsx:250-268` differ only by (a) which session record they read from and (b) SessionView's additional `addToHistory` side-effect. Extract them into a shared `useAddTerminalPanel` hook so future changes to the panel creation shape (e.g. a `panelApi.createPanel` signature change) happen in one place, and so the next sibling component that needs a terminal-add affordance (e.g. a future split-pane view) can reuse the contract.

## Implementation Steps

1. **Probe the current call sites to confirm the diff between them.** Both bodies have been read end-to-end (`ProjectView.tsx:176-193`, `SessionView.tsx:250-268`):
   - Both call `panelApi.createPanel({ sessionId, type: 'terminal', title: 'Terminal', initialState: { cwd: <session>.worktreePath } })`.
   - Both call `addPanel(newPanel)` and `setActivePanelInStore(<sessionId>, newPanel.id)` from `usePanelStore()`.
   - Both call `await panelApi.setActivePanel(<sessionId>, newPanel.id)`.
   - SessionView additionally calls `addToHistory(activeSession.id, newPanel.id)` from `useSessionHistoryStore()`.
   - ProjectView logs `console.warn('[ProjectView] Cannot add terminal: missing session', { ... })` on the guard path; SessionView logs `console.warn('[SessionView] Cannot add terminal: no active session')` on its guard path.

2. **Create `frontend/src/hooks/useAddTerminalPanel.ts`** with the following shape:
   ```ts
   import { useCallback } from 'react';
   import { panelApi } from '../services/panelApi';
   import { usePanelStore } from '../stores/panelStore';

   /**
    * Minimal session shape the hook needs. Pass `null`/`undefined` to disable
    * the callback (it will warn and no-op when invoked).
    */
   export interface UseAddTerminalPanelSession {
     id: string;
     worktreePath?: string;
   }

   export interface UseAddTerminalPanelOptions {
     /** Optional side-effect run after the panel is activated. Used by SessionView to track navigation history. */
     onAfterActivate?: (sessionId: string, panelId: string) => void;
     /** Log tag for the no-session guard's console.warn. Defaults to 'useAddTerminalPanel'. */
     logTag?: string;
   }

   /**
    * Returns a memoized callback that creates a new terminal panel for the given session,
    * registers it in the panel store, marks it active, and fires the optional onAfterActivate
    * side-effect. The callback is a no-op (with a console.warn) when session is null/undefined.
    *
    * Shared by ProjectView and SessionView so future changes to panelApi.createPanel's
    * input shape (or to the post-create activation sequence) propagate to both call sites.
    */
   export function useAddTerminalPanel(
     session: UseAddTerminalPanelSession | null | undefined,
     options: UseAddTerminalPanelOptions = {}
   ): () => Promise<void> {
     const { addPanel, setActivePanel: setActivePanelInStore } = usePanelStore();
     const { onAfterActivate, logTag = 'useAddTerminalPanel' } = options;

     return useCallback(async () => {
       if (!session) {
         console.warn(`[${logTag}] Cannot add terminal: missing session`);
         return;
       }
       const newPanel = await panelApi.createPanel({
         sessionId: session.id,
         type: 'terminal',
         title: 'Terminal',
         initialState: { cwd: session.worktreePath },
       });
       addPanel(newPanel);
       setActivePanelInStore(session.id, newPanel.id);
       await panelApi.setActivePanel(session.id, newPanel.id);
       if (onAfterActivate) {
         onAfterActivate(session.id, newPanel.id);
       }
     }, [session, addPanel, setActivePanelInStore, onAfterActivate, logTag]);
   }
   ```

3. **Migrate `frontend/src/components/SessionView.tsx`** (lines 250-268). Delete the existing `handleAddTerminal` useCallback block. Replace with:
   ```ts
   const handleAddTerminal = useAddTerminalPanel(activeSession, {
     onAfterActivate: addToHistory,
     logTag: 'SessionView',
   });
   ```
   Add the import to the top of the file:
   ```ts
   import { useAddTerminalPanel } from '../hooks/useAddTerminalPanel';
   ```
   Leave `useAddTerminalShortcut(handleAddTerminal)` (line 270) and `onAddTerminal={handleAddTerminal}` (line 460) untouched.

   If `addPanel` and `setActivePanelInStore` were previously destructured from `usePanelStore()` solely for `handleAddTerminal`, check the rest of the file (`grep -n 'addPanel\|setActivePanelInStore' SessionView.tsx`) — they ARE used elsewhere per the grep output (line 61, 84, 88, 106, 209, 220), so leave the destructure intact. Do NOT remove them from the destructure block.

4. **Migrate `frontend/src/components/ProjectView.tsx`** (lines 176-193). Delete the existing `handleAddTerminal` useCallback block. Replace with:
   ```ts
   const handleAddTerminal = useAddTerminalPanel(mainRepoSession, {
     logTag: 'ProjectView',
   });
   ```
   Add the import:
   ```ts
   import { useAddTerminalPanel } from '../hooks/useAddTerminalPanel';
   ```
   Leave `useAddTerminalShortcut(handleAddTerminal)` (line 195) and `onAddTerminal={handleAddTerminal}` (line 368) untouched.

   Same check as step 3: `addPanel` and `setActivePanelInStore` are used elsewhere in ProjectView (lines 37, 38, 93, 98, 102+) — leave the destructure intact.

5. **Write the new hook's unit tests** at `frontend/src/hooks/__tests__/useAddTerminalPanel.test.tsx`. Use `@testing-library/react`'s `renderHook` (or the project's existing testing convention — check `useAddTerminalShortcut.test.ts` for the established pattern). Mock `panelApi` and `usePanelStore`. Cover:
   - **Happy path with onAfterActivate** (SessionView shape): pass a session `{ id: 's1', worktreePath: '/path' }` and `onAfterActivate: spy`. Invoke the callback. Assert: `panelApi.createPanel` was called with the correct shape; `addPanel` was called; `setActivePanelInStore` was called with `'s1'` and the new panel id; `panelApi.setActivePanel` was called; `onAfterActivate` was called with `('s1', newPanel.id)`.
   - **Happy path without onAfterActivate** (ProjectView shape): same as above minus the onAfterActivate spy. Assert the callback resolves without error.
   - **No session**: pass `null`. Spy on `console.warn`. Invoke. Assert `panelApi.createPanel` was NOT called; `console.warn` was called with a message containing the logTag.
   - **No session — logTag respected**: pass `null` with `logTag: 'CustomTag'`. Assert the warn message contains `'[CustomTag]'`.

6. **Run frontend tests:**
   ```bash
   pnpm --filter @cyboflow/frontend test
   ```
   Expected: the new hook test passes, existing SessionView/ProjectView tests (if any) continue to pass.

7. **Run typecheck:**
   ```bash
   pnpm typecheck
   ```
   Expected: exit 0.

## Acceptance Criteria

See frontmatter. New hook exists with the documented signature; both views consume it; the addToHistory side-effect is preserved via the options arg; tests cover happy path, missing-session guard, and optional callback.

## Test Strategy

A new test file `frontend/src/hooks/__tests__/useAddTerminalPanel.test.tsx` covers the 4 scenarios above with mocked `panelApi` and `usePanelStore`. No new tests for SessionView/ProjectView are added — those components' existing tests (if any) provide integration coverage; if no tests exist for either, the typecheck + frontend test suite passing is the regression signal.

## Hardest Decision

**Whether to pass the full session object or destructure `id`/`worktreePath` at the call site.** Passing the full object is simpler and avoids a recompute on every render (memoization keys on the object reference). Destructuring would let the hook accept `(sessionId, worktreePath, options)` but would force both call sites to re-destructure, and any future field the hook needs (e.g. `projectId`) would require a signature change. Chosen approach: pass the session object with a minimal `UseAddTerminalPanelSession` interface that documents the only two fields the hook reads. Future extensions add fields to the interface, not the signature.

A secondary tradeoff: the hook accepts `session: ... | null | undefined` and warns at invocation time rather than throwing at hook-creation time. This matches the original components' guard-at-callback pattern and avoids forcing a conditional hook usage (which would violate the Rules of Hooks).

## Rejected Alternatives

- **Accept a `createPanelRequest` builder function instead of a session object.** Rejected — over-abstracted for two call sites with identical shapes. The hook owns the "Terminal" title and the panel type; that's correct because the hook's job is "add a terminal panel," not "add an arbitrary panel."
- **Move the `useAddTerminalShortcut(handleAddTerminal)` call inside the hook.** Rejected — the shortcut binding should remain at the component level so a future caller (e.g. a context-menu invocation that doesn't want a global shortcut) can use the hook without the side-effect.
- **Make `onAfterActivate` a required arg with a no-op default.** Rejected — required args are noisy at the call site (ProjectView would need `onAfterActivate: () => {}`). Optional with a typed undefined is cleaner.

## Lowest Confidence Area

Whether the hook's `useCallback` dependency on `session` (the object) causes excessive re-creation. If the parent component re-creates the `activeSession` / `mainRepoSession` object on every render (e.g. via a `useMemo`-less selector), the callback identity will churn, defeating memoization for downstream consumers like `useAddTerminalShortcut` and `PanelTabBar`. Mitigation: inspect the parents' session sources — `useSessionStore((state) => state.sessions.find(...))` returns a stable reference if the session row hasn't changed (zustand's default selector behavior). If churn is observed in practice (e.g. `useEffect` re-fires excessively), narrow the dependency to `session?.id` and `session?.worktreePath` and pass `session?.worktreePath` directly into the body. Not done by default because it's a minor optimization that adds noise.
