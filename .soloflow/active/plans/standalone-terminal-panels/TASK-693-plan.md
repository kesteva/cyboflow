---
id: TASK-693
idea: IDEA-020
status: approved
created: "2026-05-22T00:00:00Z"
files_owned:
  - frontend/src/components/cyboflow/CyboflowRoot.tsx
  - frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx
  - frontend/src/components/panels/PanelTabBar.tsx
  - frontend/src/types/panelComponents.ts
  - frontend/src/hooks/useAddClaudeShortcut.ts
  - frontend/src/hooks/__tests__/useAddClaudeShortcut.test.ts
  - frontend/src/hooks/useEnsureClaudePanel.ts
  - frontend/src/hooks/__tests__/useEnsureClaudePanel.test.tsx
  - frontend/src/components/ProjectView.tsx
  - tests/standalone-terminal-panels.spec.ts
files_readonly:
  - frontend/src/components/SessionView.tsx
  - frontend/src/components/cyboflow/RunView.tsx
  - frontend/src/components/cyboflow/WorkflowPicker.tsx
  - frontend/src/hooks/useAddTerminalPanel.ts
  - frontend/src/hooks/__tests__/useAddTerminalPanel.test.tsx
  - frontend/src/hooks/useAddTerminalShortcut.ts
  - frontend/src/hooks/__tests__/useAddTerminalShortcut.test.ts
  - frontend/src/stores/cyboflowStore.ts
  - frontend/src/stores/panelStore.ts
  - frontend/src/stores/sessionStore.ts
  - frontend/src/contexts/SessionContext.tsx
  - frontend/src/services/panelApi.ts
  - frontend/src/utils/api.ts
  - frontend/src/types/electron.d.ts
  - frontend/src/App.tsx
  - .soloflow/active/plans/cyboflow-shell-architecture/TASK-690-plan.md
  - .soloflow/active/plans/cyboflow-shell-architecture/TASK-691-plan.md
acceptance_criteria:
  - criterion: "A new shared hook `frontend/src/hooks/useEnsureClaudePanel.ts` exists and exports a function named `useEnsureClaudePanel`."
    verification: "test -f frontend/src/hooks/useEnsureClaudePanel.ts && grep -q 'export function useEnsureClaudePanel' frontend/src/hooks/useEnsureClaudePanel.ts"
  - criterion: "`useEnsureClaudePanel` activates an existing Claude panel for the given session if one is present, otherwise creates a new one via `panelApi.createPanel({ type: 'claude' })` and marks it active."
    verification: "grep -nE \"type:\\s*['\\\"]claude['\\\"]\" frontend/src/hooks/useEnsureClaudePanel.ts returns at least one match, AND `cd frontend && pnpm exec vitest run src/hooks/__tests__/useEnsureClaudePanel.test.tsx` exits 0."
  - criterion: "ProjectView no longer defines its own inline `ensureClaudePanel` useCallback — it calls the shared `useEnsureClaudePanel` hook instead."
    verification: "grep -nE 'const ensureClaudePanel = useCallback' frontend/src/components/ProjectView.tsx returns 0 matches AND grep -n 'useEnsureClaudePanel' frontend/src/components/ProjectView.tsx returns at least one match."
  - criterion: "A new file `frontend/src/hooks/useAddClaudeShortcut.ts` exists and exports a function named `useAddClaudeShortcut`."
    verification: "test -f frontend/src/hooks/useAddClaudeShortcut.ts && grep -q 'export function useAddClaudeShortcut' frontend/src/hooks/useAddClaudeShortcut.ts"
  - criterion: "`useAddClaudeShortcut` matches event.key === 'C' OR event.code === 'KeyC' with shiftKey AND (metaKey OR ctrlKey) and applies the same focus guards as `useAddTerminalShortcut` (HTMLInputElement, HTMLTextAreaElement, isContentEditable)."
    verification: "grep -Eq \"event\\.key !== 'C'.*event\\.code !== 'KeyC'\" frontend/src/hooks/useAddClaudeShortcut.ts && grep -q 'shiftKey' frontend/src/hooks/useAddClaudeShortcut.ts && grep -qE '(metaKey \\|\\| event\\.ctrlKey|event\\.metaKey \\|\\| event\\.ctrlKey)' frontend/src/hooks/useAddClaudeShortcut.ts && grep -q 'isContentEditable' frontend/src/hooks/useAddClaudeShortcut.ts"
  - criterion: "`PanelTabBarProps` in `frontend/src/types/panelComponents.ts` declares an optional `onAddClaude` callback returning void | Promise<void>."
    verification: "grep -nE 'onAddClaude\\?:\\s*\\(\\)\\s*=>\\s*void\\s*\\|\\s*Promise<void>' frontend/src/types/panelComponents.ts returns at least one match."
  - criterion: "PanelTabBar renders a button with aria-label 'Add Claude panel' inside the trailing-edge action row, wired through a local `handleAddClaude` memoized on [onAddClaude]."
    verification: "grep -q 'aria-label=\"Add Claude panel\"' frontend/src/components/panels/PanelTabBar.tsx && grep -q 'handleAddClaude' frontend/src/components/panels/PanelTabBar.tsx"
  - criterion: "CyboflowRoot resolves the project's main-repo session via `API.sessions.getOrCreateMainRepoSession(projectId)` and renders a `<PanelTabBar />` with both `onAddTerminal` (wired through `useAddTerminalPanel`) and `onAddClaude` (wired through `useEnsureClaudePanel`) props supplied."
    verification: "grep -q 'getOrCreateMainRepoSession' frontend/src/components/cyboflow/CyboflowRoot.tsx && grep -q 'useAddTerminalPanel' frontend/src/components/cyboflow/CyboflowRoot.tsx && grep -q 'useEnsureClaudePanel' frontend/src/components/cyboflow/CyboflowRoot.tsx && grep -q '<PanelTabBar' frontend/src/components/cyboflow/CyboflowRoot.tsx && grep -q 'onAddTerminal=' frontend/src/components/cyboflow/CyboflowRoot.tsx && grep -q 'onAddClaude=' frontend/src/components/cyboflow/CyboflowRoot.tsx"
  - criterion: "CyboflowRoot registers both keyboard shortcuts — `useAddTerminalShortcut` and `useAddClaudeShortcut`."
    verification: "grep -q 'useAddTerminalShortcut' frontend/src/components/cyboflow/CyboflowRoot.tsx && grep -q 'useAddClaudeShortcut' frontend/src/components/cyboflow/CyboflowRoot.tsx"
  - criterion: "CyboflowRoot still renders RunView when activeRunId is set and the empty-state CTA when activeRunId is null (no run-watching regression from Option B layout)."
    verification: "grep -q 'activeRunId !== null' frontend/src/components/cyboflow/CyboflowRoot.tsx && grep -q '<RunView' frontend/src/components/cyboflow/CyboflowRoot.tsx && grep -q 'Choose a workflow to start' frontend/src/components/cyboflow/CyboflowRoot.tsx"
  - criterion: "ProjectView's existing `+ Terminal` wiring continues to call `useAddTerminalPanel` and `useAddTerminalShortcut` (regression guard for the legacy escape hatch until TASK-690/TASK-691 ship)."
    verification: "grep -n 'useAddTerminalPanel' frontend/src/components/ProjectView.tsx returns at least one match AND grep -n 'useAddTerminalShortcut(handleAddTerminal)' frontend/src/components/ProjectView.tsx returns at least one match."
  - criterion: "Unit tests for both new hooks exist and pass: `useAddClaudeShortcut.test.ts` and `useEnsureClaudePanel.test.tsx`."
    verification: "cd frontend && pnpm exec vitest run src/hooks/__tests__/useAddClaudeShortcut.test.ts src/hooks/__tests__/useEnsureClaudePanel.test.tsx"
  - criterion: "Existing sibling test `useAddTerminalShortcut.test.ts`, `useAddTerminalPanel.test.tsx`, and `CyboflowRoot.test.tsx` continue to pass (regression guard)."
    verification: "cd frontend && pnpm exec vitest run src/hooks/__tests__/useAddTerminalShortcut.test.ts src/hooks/__tests__/useAddTerminalPanel.test.tsx src/components/cyboflow/__tests__/CyboflowRoot.test.tsx"
  - criterion: "Playwright spec `tests/standalone-terminal-panels.spec.ts` includes a new `test.describe('CyboflowRoot — Add Terminal + Add Claude', ...)` block whose case bodies reference both 'Add terminal panel' and 'Add Claude panel' aria-labels."
    verification: "grep -nE \"test\\.describe\\(['\\\"]CyboflowRoot\" tests/standalone-terminal-panels.spec.ts returns at least one match AND grep -q 'Add Claude panel' tests/standalone-terminal-panels.spec.ts AND grep -q 'Add terminal panel' tests/standalone-terminal-panels.spec.ts"
  - criterion: "`pnpm typecheck` exits 0."
    verification: "pnpm typecheck"
  - criterion: "`pnpm lint` exits 0."
    verification: "pnpm lint"
depends_on: []
estimated_complexity: medium
epic: standalone-terminal-panels
test_strategy:
  needed: true
  justification: "Three sibling-test directories are touched by this task: (a) `frontend/src/hooks/__tests__/` already hosts `useAddTerminalShortcut.test.ts` (200 lines) and `useAddTerminalPanel.test.tsx` (208 lines) — both are the structural model for the two new hook tests; (b) `frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx` (128 lines) directly tests CyboflowRoot's render contract and MUST stay green through the layout change; (c) `tests/standalone-terminal-panels.spec.ts` already covers the `+ Terminal` button at the Playwright level and is extended in-place. Per rule 5b sibling-test scan, `needed: false` is invalid here."
  targets:
    - behavior: "useEnsureClaudePanel — when sessionId is provided and no Claude panel exists for the session, calls panelApi.createPanel with { sessionId, type: 'claude' } exactly once, then addPanel + setActivePanelInStore."
      test_file: frontend/src/hooks/__tests__/useEnsureClaudePanel.test.tsx
      type: unit
    - behavior: "useEnsureClaudePanel — when an existing Claude panel is present in the panel store for that session, does NOT call panelApi.createPanel; instead activates the existing panel via setActivePanelInStore + panelApi.setActivePanel."
      test_file: frontend/src/hooks/__tests__/useEnsureClaudePanel.test.tsx
      type: unit
    - behavior: "useEnsureClaudePanel — when sessionId is null/undefined, logs a console.warn (with the configured logTag) and does NOT call panelApi.createPanel (mirrors useAddTerminalPanel no-session guard)."
      test_file: frontend/src/hooks/__tests__/useEnsureClaudePanel.test.tsx
      type: unit
    - behavior: "useAddClaudeShortcut — Mac (metaKey) path invokes callback exactly once on Cmd+Shift+C."
      test_file: frontend/src/hooks/__tests__/useAddClaudeShortcut.test.ts
      type: unit
    - behavior: "useAddClaudeShortcut — Win/Linux (ctrlKey) path invokes callback exactly once on Ctrl+Shift+C."
      test_file: frontend/src/hooks/__tests__/useAddClaudeShortcut.test.ts
      type: unit
    - behavior: "useAddClaudeShortcut — modifier-and-key guards: plain C, Cmd+Shift+T, Cmd+C-without-shift do NOT fire."
      test_file: frontend/src/hooks/__tests__/useAddClaudeShortcut.test.ts
      type: unit
    - behavior: "useAddClaudeShortcut — focus guards: input, textarea, contentEditable suppress the shortcut."
      test_file: frontend/src/hooks/__tests__/useAddClaudeShortcut.test.ts
      type: unit
    - behavior: "useAddClaudeShortcut — opts.enabled gating + unmount cleanup."
      test_file: frontend/src/hooks/__tests__/useAddClaudeShortcut.test.ts
      type: unit
    - behavior: "CyboflowRoot — existing four cases stay green: empty-state CTA when activeRunId is null, RunView when activeRunId is set, modal open/close, modal auto-close on run start. The mock surface is extended to silence `API.sessions.getOrCreateMainRepoSession` and `panelApi.loadPanelsForSession` so the new main-repo-session resolution path does not break existing assertions."
      test_file: frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx
      type: component
    - behavior: "Playwright — CyboflowRoot: Add Terminal button is visible with aria-label='Add terminal panel'; clicking it increases the tab count; new tab becomes aria-selected=true."
      test_file: tests/standalone-terminal-panels.spec.ts
      type: integration
    - behavior: "Playwright — CyboflowRoot: Add Claude button is visible with aria-label='Add Claude panel'; clicking it creates exactly one new Claude tab and activates it; clicking it again with a Claude panel already present does NOT create a duplicate (asserts find-or-activate semantics)."
      test_file: tests/standalone-terminal-panels.spec.ts
      type: integration
---

# Add PanelTabBar surface to CyboflowRoot — wire Terminal + Claude affordances against the new shell

## Objective

Mount a `PanelTabBar` with `+ Terminal` and `+ Claude` buttons (plus the matching Cmd/Ctrl+Shift+Backquote and Cmd/Ctrl+Shift+C keyboard shortcuts) inside `CyboflowRoot`, which is the active project surface in `App.tsx` when `useLegacyCrystalView === false`. After TASK-690 (retires the toggle) and TASK-691 (deletes `SessionView` + descendants) land, these affordances become the **only** in-app paths to create either panel type. To keep the existing `ProjectView` escape hatch behaviorally identical until those tasks ship, extract the inline `ensureClaudePanel` from `ProjectView` into a shared `useEnsureClaudePanel` hook (mirroring the already-extracted `useAddTerminalPanel`) and migrate `ProjectView` to call it. No deletion, no @cyboflow-hidden annotations — TASK-690/691 own the sweep.

## Layout Decision (Hardest Decision summary; full rationale below)

**Option B — PanelTabBar as a secondary surface below the run/empty-state content area.** CyboflowRoot's final structure becomes:

```
<div className="flex h-full flex-col">
  <header />                                      (unchanged: Choose workflow button)
  <div className="flex-1 overflow-auto p-4">    (unchanged: RunView or empty-state)
    {activeRunId !== null ? <RunView /> : <empty-state />}
  </div>
  {mainRepoSessionId && (                         (NEW: panel surface)
    <SessionProvider session={mainRepoSession} projectName={projectName ?? ''}>
      <PanelTabBar
        panels={sessionPanels}
        activePanel={currentActivePanel}
        onPanelSelect={...}
        onPanelClose={...}
        context="project"
        onAddTerminal={handleAddTerminal}
        onAddClaude={ensureClaudePanel}
      />
      {currentActivePanel && (
        <div className="flex-shrink-0 max-h-[50vh] min-h-[200px] border-t border-border-primary relative">
          <PanelContainer panel={currentActivePanel} isActive isMainRepo={!!mainRepoSession?.isMainRepo} />
        </div>
      )}
    </SessionProvider>
  )}
  <Modal>…WorkflowPicker…</Modal>                  (unchanged)
</div>
```

The tab bar is the panel-creation surface. The activated panel renders in a bounded region below the bar so terminal output / Claude transcripts are visible — this is required for the AC "clicking + Terminal creates a panel" to be observable as a render, not just a store mutation. RunView's behavior is **untouched**; it continues to render in the main content area exactly as before.

## Implementation Steps

1. **Pre-flight grep (completeness gate).** Run these and capture output for the report:
   ```
   grep -rn "ensureClaudePanel" frontend/src/
   grep -rn "useAddClaudeShortcut" frontend/src/
   grep -rn "useEnsureClaudePanel" frontend/src/
   ```
   Expected at task start: `ensureClaudePanel` matches only `frontend/src/components/ProjectView.tsx` (5 lines); the other two return zero matches. If anything else matches, stop and reconcile — a parallel task may have started this work.

2. **Create the shared `useEnsureClaudePanel` hook** at `frontend/src/hooks/useEnsureClaudePanel.ts`. Mirror the shape of `useAddTerminalPanel.ts`:
   - Signature: `useEnsureClaudePanel(session: { id: string } | null | undefined, options?: { logTag?: string }) => () => Promise<void>`.
   - Inside the returned callback:
     1. If `!session`, `console.warn` with `[logTag ?? 'useEnsureClaudePanel']` and return.
     2. Read `panels` from `usePanelStore.getState()` (or via `usePanelStore((s) => s.panels)` at hook scope — pick whichever matches the `useAddTerminalPanel` precedent; the store import is identical).
     3. Find `existing = (panels[session.id] ?? []).find(p => p.type === 'claude')`.
     4. If `existing`: `setActivePanelInStore(session.id, existing.id); await panelApi.setActivePanel(session.id, existing.id); return;`.
     5. Otherwise: `const newPanel = await panelApi.createPanel({ sessionId: session.id, type: 'claude' }); addPanel(newPanel); setActivePanelInStore(session.id, newPanel.id);`. (Do NOT also call `panelApi.setActivePanel` in the create branch — match `ProjectView.ensureClaudePanel`'s current behavior, which relies on the `panel:created` event for backend activation. This keeps the migration a behavior-equivalent refactor.)
   - Memoize with `useCallback`. Dep array: `[session?.id, addPanel, setActivePanelInStore, logTag]`. Read `panels` inside the callback via `usePanelStore.getState()` to avoid re-creating the callback on every panel-store mutation; this matches the find-then-create pattern used in other "ensure" hooks across the codebase.

3. **Create the test file** at `frontend/src/hooks/__tests__/useEnsureClaudePanel.test.tsx`. Mirror `useAddTerminalPanel.test.tsx` mock setup verbatim (`vi.hoisted`, mocks for `../../stores/panelStore` and `../../services/panelApi`). Add three describe blocks:
   - "happy path — no existing Claude panel": asserts `createPanel` called with `{ sessionId: 's1', type: 'claude' }`, `addPanel` called once with the returned panel, `setActivePanelInStore` called with `('s1', 'panel-1')`.
   - "happy path — existing Claude panel": pre-populate the mocked store to return `{ panels: { s1: [{ id: 'existing-1', type: 'claude', sessionId: 's1', title: 'Claude', state: { isActive: false } }] } }`; assert `createPanel` was NOT called, `setActivePanelInStore` called with `('s1', 'existing-1')`, `panelApi.setActivePanel` called with `('s1', 'existing-1')`.
   - "no-session guard": pass `null` and `undefined`; assert `console.warn` includes the `[useEnsureClaudePanel]` (default) or `[CustomTag]` (custom) tag and that `createPanel` was NOT called.

   Use `renderHook` + `act` exactly as the sibling test does.

4. **Create the keyboard hook** at `frontend/src/hooks/useAddClaudeShortcut.ts`. Mirror `useAddTerminalShortcut.ts` exactly with these substitutions:
   - Function name `useAddClaudeShortcut`, param `onAddClaude`.
   - Key match: `if (event.key !== 'C' && event.code !== 'KeyC') return;` (uppercase 'C' because shifted ASCII letters arrive as uppercase in `event.key`; mirrors `App.tsx`'s existing Cmd+Shift+T binding convention).
   - JSDoc: describe Cmd/Ctrl+Shift+C, note no conflict with existing in-app bindings (Cmd+Shift+T, Cmd+Shift+D/R, Cmd+Shift+N, Cmd+Shift+Backquote). Mention that Ctrl+Shift+C is browser devtools "inspect element" in Chrome but Electron renderer does not intercept it in production.
   - Preserve the focus-guard contract verbatim (HTMLInputElement, HTMLTextAreaElement, isContentEditable; ref-pinned callback; `enabled` opt).

5. **Create the keyboard hook test** at `frontend/src/hooks/__tests__/useAddClaudeShortcut.test.ts`. Copy `useAddTerminalShortcut.test.ts` and substitute `key: 'C'` / `code: 'KeyC'` in the press helpers. Keep all six describe blocks (Mac, Linux, modifier-and-key guards, focus guard, opts.enabled, cleanup on unmount). Add one regression case asserting `Cmd+Shift+Backquote` does NOT fire the Claude shortcut (the symmetric negative of the existing test asserting Cmd+Shift+T does not fire the terminal shortcut).

6. **Extend `PanelTabBarProps`** in `frontend/src/types/panelComponents.ts`:
   ```ts
   onAddClaude?: () => void | Promise<void>;
   ```
   Place it directly after `onAddTerminal?` to keep related props grouped.

7. **Wire the `+ Claude` button into `PanelTabBar.tsx`**:
   - Destructure `onAddClaude` from props (line 11–18 area).
   - Add `handleAddClaude` callback memoized on `[onAddClaude]`, mirroring `handleAddTerminal` at line 88:
     ```ts
     const handleAddClaude = useCallback(() => {
       if (!onAddClaude) return;
       const result = onAddClaude();
       if (result instanceof Promise) {
         result.catch((err: unknown) => {
           console.error('[PanelTabBar] Failed to add claude panel:', err);
         });
       }
     }, [onAddClaude]);
     ```
   - Extend the trailing-action gating predicate at line 256 to include `onAddClaude` in the OR chain: `(onAddTerminal || onAddClaude || (context === 'worktree' && gitBranchActions && gitBranchActions.length > 0))`.
   - Inside the action row, add the `{onAddClaude && (<button …>)}` block **after** the existing `{onAddTerminal && (<button …>)}` block (so order is Terminal, Claude, Git Branch). Reuse the exact `className` from the `+ Terminal` button. Render `<Plus className="w-4 h-4" />` followed by `<MessageSquare className="w-4 h-4" />` (both icons already imported at line 2). `aria-label` and `title` BOTH `"Add Claude panel"`. Include `<span className="sr-only">Add Claude panel</span>`.

8. **Migrate `ProjectView.tsx` to the shared `useEnsureClaudePanel` hook**:
   - Add imports at the top: `import { useEnsureClaudePanel } from '../hooks/useEnsureClaudePanel';` and `import { useAddClaudeShortcut } from '../hooks/useAddClaudeShortcut';`.
   - Delete the inline `const ensureClaudePanel = useCallback(...)` block at lines 160–175.
   - Replace it with: `const ensureClaudePanel = useEnsureClaudePanel(mainRepoSession, { logTag: 'ProjectView' });`. (The hook accepts the minimal session shape `{ id: string }`, so the existing `mainRepoSession: Session | null` is structurally compatible.)
   - After the existing `useAddTerminalShortcut(handleAddTerminal);` at line 181, add: `useAddClaudeShortcut(ensureClaudePanel);`.
   - In the `<PanelTabBar context="project" … />` JSX block (lines 348–355), add prop `onAddClaude={ensureClaudePanel}` next to the existing `onAddTerminal={handleAddTerminal}`.
   - **Do NOT modify any other ProjectView behavior.** `handleGitPull` / `handleGitPush` keep their external find-then-call pattern; the new `useEnsureClaudePanel` internalizes the same find-or-create behavior so the double-check is benign (already noted in the prior plan's lowest-confidence area).

9. **Wire the affordances into `CyboflowRoot.tsx`**. The starting file (read at refinement time) is 72 lines. The post-edit file will be ~150 lines. Steps in source order:
   - Add imports at the top:
     ```ts
     import { useEffect, useState, useCallback, useMemo } from 'react';
     import { API } from '../../utils/api';
     import { useSessionStore } from '../../stores/sessionStore';
     import { usePanelStore } from '../../stores/panelStore';
     import { panelApi } from '../../services/panelApi';
     import type { Session } from '../../types/session';
     import type { ToolPanel } from '../../../../shared/types/panels';
     import { SessionProvider } from '../../contexts/SessionContext';
     import { PanelTabBar } from '../panels/PanelTabBar';
     import { PanelContainer } from '../panels/PanelContainer';
     import { useAddTerminalPanel } from '../../hooks/useAddTerminalPanel';
     import { useAddTerminalShortcut } from '../../hooks/useAddTerminalShortcut';
     import { useEnsureClaudePanel } from '../../hooks/useEnsureClaudePanel';
     import { useAddClaudeShortcut } from '../../hooks/useAddClaudeShortcut';
     ```
   - Inside the component, after the existing `activeRunId` and `isPickerOpen` state, add the mainRepoSession-resolution block, **adapted from `ProjectView.tsx` lines 219–289** (NOT copied verbatim — strip the Dashboard / Setup-Tasks auto-creation, which is a ProjectView-only contract per its current comments). The minimal block:
     ```ts
     const [mainRepoSessionId, setMainRepoSessionId] = useState<string | null>(null);
     const [mainRepoSession, setMainRepoSession] = useState<Session | null>(null);

     const { panels, activePanels, setPanels, setActivePanel: setActivePanelInStore, addPanel, removePanel } = usePanelStore();

     // Resolve main-repo session for the active project.
     useEffect(() => {
       if (projectId === null) {
         setMainRepoSessionId(null);
         setMainRepoSession(null);
         return;
       }
       let cancelled = false;
       (async () => {
         try {
           const response = await API.sessions.getOrCreateMainRepoSession(projectId);
           if (cancelled) return;
           if (response.success && response.data) {
             setMainRepoSessionId(response.data.id);
             setMainRepoSession(response.data);
           }
         } catch (err) {
           console.error('[CyboflowRoot] Failed to resolve main-repo session:', err);
         }
       })();
       return () => { cancelled = true; };
     }, [projectId]);

     // Load panels for the resolved session (read-only — do NOT auto-create dashboard/setup-tasks).
     useEffect(() => {
       if (!mainRepoSessionId) return;
       panelApi.loadPanelsForSession(mainRepoSessionId)
         .then((loaded) => setPanels(mainRepoSessionId, loaded))
         .catch((err) => console.error('[CyboflowRoot] Failed to load panels:', err));
     }, [mainRepoSessionId, setPanels]);

     // Subscribe to panel:created events scoped to this session.
     useEffect(() => {
       if (!mainRepoSessionId) return;
       const handler = (panel: ToolPanel) => {
         if (panel.sessionId === mainRepoSessionId) addPanel(panel);
       };
       const unsubscribe = window.electronAPI?.events?.onPanelCreated?.(handler);
       return () => { unsubscribe?.(); };
     }, [mainRepoSessionId, addPanel]);

     const sessionPanels = useMemo(
       () => panels[mainRepoSessionId ?? ''] ?? [],
       [panels, mainRepoSessionId],
     );
     const currentActivePanel = useMemo(
       () => sessionPanels.find(p => p.id === activePanels[mainRepoSessionId ?? '']),
       [sessionPanels, activePanels, mainRepoSessionId],
     );

     const handlePanelSelect = useCallback(async (panel: ToolPanel) => {
       if (!mainRepoSessionId) return;
       setActivePanelInStore(mainRepoSessionId, panel.id);
       await panelApi.setActivePanel(mainRepoSessionId, panel.id);
     }, [mainRepoSessionId, setActivePanelInStore]);

     const handlePanelClose = useCallback(async (panel: ToolPanel) => {
       if (!mainRepoSessionId) return;
       // CyboflowRoot does not auto-create permanent dashboard/setup-tasks panels, so
       // there is no permanence guard here — every panel created via these affordances
       // is user-initiated and user-closable.
       const idx = sessionPanels.findIndex(p => p.id === panel.id);
       const next = sessionPanels[idx + 1] ?? sessionPanels[idx - 1];
       removePanel(mainRepoSessionId, panel.id);
       if (next && next.id !== panel.id) {
         setActivePanelInStore(mainRepoSessionId, next.id);
         await panelApi.setActivePanel(mainRepoSessionId, next.id);
       }
       await panelApi.deletePanel(panel.id);
     }, [mainRepoSessionId, sessionPanels, removePanel, setActivePanelInStore]);

     const handleAddTerminal = useAddTerminalPanel(mainRepoSession, { logTag: 'CyboflowRoot' });
     const ensureClaudePanel = useEnsureClaudePanel(mainRepoSession, { logTag: 'CyboflowRoot' });

     useAddTerminalShortcut(handleAddTerminal);
     useAddClaudeShortcut(ensureClaudePanel);
     ```
   - In the JSX, **leave the existing header and the existing `<div className="flex-1 overflow-auto p-4">…</div>` content block untouched** (Option B keeps RunView in its current spot). After that content block but before the Modal, insert:
     ```tsx
     {mainRepoSessionId && (
       <SessionProvider session={mainRepoSession} projectName="">
         <PanelTabBar
           panels={sessionPanels}
           activePanel={currentActivePanel}
           onPanelSelect={handlePanelSelect}
           onPanelClose={handlePanelClose}
           context="project"
           onAddTerminal={handleAddTerminal}
           onAddClaude={ensureClaudePanel}
         />
         {currentActivePanel && (
           <div
             className="flex-shrink-0 border-t border-border-primary relative"
             style={{ minHeight: 200, maxHeight: '50vh', height: '40vh' }}
           >
             <PanelContainer
               panel={currentActivePanel}
               isActive
               isMainRepo={!!mainRepoSession?.isMainRepo}
             />
           </div>
         )}
       </SessionProvider>
     )}
     ```
   - **Do NOT change** the existing header button, the empty-state CTA, the RunView render, or the Modal block.

10. **Extend `frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx`** so the existing 4 cases stay green under the new session-resolution surface. Add to the existing `vi.mock` block:
    ```ts
    vi.mock('../../../utils/api', () => ({
      API: {
        sessions: {
          getOrCreateMainRepoSession: vi.fn().mockResolvedValue({ success: true, data: null }),
        },
      },
    }));
    vi.mock('../../../services/panelApi', () => ({
      panelApi: {
        loadPanelsForSession: vi.fn().mockResolvedValue([]),
        setActivePanel: vi.fn().mockResolvedValue(undefined),
        createPanel: vi.fn(),
        deletePanel: vi.fn().mockResolvedValue(undefined),
      },
    }));
    ```
    With `data: null`, `mainRepoSessionId` stays `null`, the new `{mainRepoSessionId && …}` block does NOT render, and the four existing assertions about empty-state CTA / RunView / modal toggling pass unchanged. The new behavior is exercised by Playwright in step 11.

11. **Extend `tests/standalone-terminal-panels.spec.ts`** with a new `test.describe('CyboflowRoot — Add Terminal + Add Claude', ...)` block. Reuse `dismissOnboarding` and `navigateToFirstProject` helpers. Three test cases:
    1. "Add Terminal button on CyboflowRoot panel tab bar creates a new terminal tab": skip if no project; otherwise wait for `[aria-label="Panel Tabs"]`, click `getByRole('button', { name: 'Add terminal panel' })`, assert tab count grows. Screenshot to `test-results/add-terminal-cyboflow-root.png`.
    2. "Add Claude button on CyboflowRoot panel tab bar creates a new Claude tab": same shape, target `'Add Claude panel'`. Screenshot to `test-results/add-claude-cyboflow-root.png`.
    3. "Add Claude button is idempotent — second click does NOT create a duplicate": after the first click, count tabs; click again; assert tab count is unchanged AND the active tab still has aria-selected=true. Screenshot to `test-results/add-claude-idempotent.png`.

    The test environment will hit the `useLegacyCrystalView !== true` branch by default (the toggle defaults to false in `App.tsx`), so the Playwright path lands on CyboflowRoot, not ProjectView's PanelTabBar.

12. **Run all gates and capture results:**
    ```
    cd frontend && pnpm exec vitest run \
      src/hooks/__tests__/useEnsureClaudePanel.test.tsx \
      src/hooks/__tests__/useAddClaudeShortcut.test.ts \
      src/hooks/__tests__/useAddTerminalShortcut.test.ts \
      src/hooks/__tests__/useAddTerminalPanel.test.tsx \
      src/components/cyboflow/__tests__/CyboflowRoot.test.tsx
    cd .. && pnpm typecheck && pnpm lint
    ```
    All must exit 0.

13. **Visual verification.** `pnpm build:main && pnpm dev`. Select a project. Verify:
    - The thin header with "Choose workflow" still renders.
    - The empty-state "Choose a workflow to start" CTA still renders when no run is active.
    - A new `PanelTabBar` is visible at the bottom of the CyboflowRoot region with `+ Terminal` and `+ Claude` buttons in the trailing-action row.
    - Clicking `+ Terminal` creates a terminal tab and a `PanelContainer` opens beneath the bar.
    - Clicking `+ Claude` creates a Claude tab; clicking it again with a Claude tab already present does NOT create a duplicate (the existing Claude tab becomes active).
    - Cmd+Shift+Backquote and Cmd+Shift+C work from the CyboflowRoot view.
    - Toggle to legacy view via the existing "Legacy view" button — ProjectView's `+ Terminal` still works, Cmd+Shift+Backquote still works there; ProjectView's new `+ Claude` button (now wired via the shared hook) also works (regression confirmation).
    - Check `cyboflow-frontend-debug.log` for any `[CyboflowRoot]` errors.

## Acceptance Criteria

See frontmatter.

## Test Strategy

See `test_strategy.targets` in frontmatter. Three new test files (one extension of an existing component test, two brand-new hook tests) plus three new Playwright cases extending an existing spec. Mocks for `useEnsureClaudePanel` mirror `useAddTerminalPanel`'s `vi.hoisted` pattern exactly. Mocks for the extended `CyboflowRoot.test.tsx` use `data: null` to keep `mainRepoSessionId` null and preserve the existing four assertions verbatim.

## Hardest Decision

**Which of the three layout options to adopt for placing PanelTabBar inside CyboflowRoot.** The brief explicitly defers this decision to refinement and signals a lean toward Option B if uncertain.

- **Chosen — Option B (PanelTabBar as a secondary surface below the existing run/empty-state region).** Rationale:
  1. **Surgical and reversible.** Zero changes to RunView or to the run-watching UX. The run experience that TASK-688 + cyboflow-shell-architecture is converging on is preserved bit-exactly; if Option A or C turns out to be the right long-term model, the migration becomes a layout swap, not a rewrite of run rendering.
  2. **Aligned with the brief's stated preference.** The brief says "Lean toward Option B if you're uncertain — it keeps the run-watching UX intact while delivering the panel affordances." There is no signal in the IDEA, the in-flight TASK-690/691 plans, or the standalone-terminal-panels epic body that contradicts that lean.
  3. **Matches existing precedent in ProjectView.** ProjectView already structures itself as "header / project-scoped panel tab bar / panel content area", which is the same shape Option B introduces in CyboflowRoot. The user's mental model is preserved across the legacy escape hatch and the new shell during the TASK-690/691 transition window.
  4. **The cost — a second region on the same screen — is bounded.** A `max-h-[50vh]` cap on the panel-content area keeps the run/empty-state area from being squeezed when no panel is active (the panel-content region renders conditionally on `currentActivePanel`), so the worst case is a thin tab bar at the bottom of the screen when no panel exists.

## Rejected Alternatives

- **Option A — PanelTabBar replaces RunView as the main content, with RunView as a virtual panel.** Rejected: requires teaching RunView to behave as a panel, defining how runs map to panel records, and rewriting the activeRunId → panel-id routing. The blast radius spans `cyboflowStore.ts`, `RunView.tsx`, `panelManager.ts`, and the panel-render dispatch. None of that work is in any current plan or IDEA, so adopting Option A here would smuggle large architectural change into a panel-affordance task. Reconsider when the cyboflow-shell-architecture epic explicitly proposes a "runs-as-panels" model.

- **Option C — PanelTabBar is the only main content; RunView moves inside as the default `'run'` panel.** Rejected for the same blast-radius reason as Option A, with the added downside of requiring explicit panel registration up front and changing the meaning of `activeRunId` (now a panel id, not a run id). Reconsider only after an explicit IDEA proposes this restructure.

- **Always-create-new Claude semantics inside `useEnsureClaudePanel`.** Rejected: the hook name ("ensure") and the current `ProjectView.ensureClaudePanel` contract both imply find-or-create. Diverging here would silently change ProjectView's behavior during the migration (step 8) and fail the regression AC. The single-Claude-panel-per-session invariant is also what the test fixture in step 3 assumes.

- **Skip extracting `useEnsureClaudePanel` and duplicate the inline logic in CyboflowRoot.** Rejected: TASK-691 will delete ProjectView soon, but until it ships, two copies of the same find-or-create logic risk drift (especially around the `panel:created` event and the panel-store dedup window). The extraction is a 30-line shared hook plus a small ProjectView delta; the cost is bounded and the cleanup is durable.

- **Add `setActivePanel(session.id, newPanel.id)` to the create branch of `useEnsureClaudePanel` (mirroring `useAddTerminalPanel`).** Rejected for the extraction step to keep ProjectView's behavior bit-exactly preserved; the existing `ensureClaudePanel` does NOT call `panelApi.setActivePanel` after create. If a follow-up task wants to unify the two hooks' post-create activation contract, it should do so as a deliberate behavior change with its own test coverage.

## Lowest Confidence Area

**The two-active-source-of-truth window during step 8 (ProjectView migration).** ProjectView already subscribes to the `panel:created` event and forwards new panels into the store. `useEnsureClaudePanel`'s create branch also calls `addPanel(newPanel)` synchronously. There's a benign race where the same panel briefly appears twice in the dispatch queue; the store's existing `addPanel` dedup comment (`ProjectView.tsx:283-289`) says it's handled, but the dedup is by id and is not unit-tested in this PR. Mitigation: the `useEnsureClaudePanel` test in step 3 asserts `addPanel` is called exactly once per invocation, which guards the call-site contract; any actual duplicate would surface in the Playwright "idempotent" test in step 11. Fallback if a duplicate-tab regression appears in visual verification: drop the synchronous `addPanel` in the create branch and rely solely on the `panel:created` event, matching the pattern used elsewhere — but only after writing a regression test that captures the failure mode.

A secondary low-confidence area is the **`SessionProvider` requirement** that wrapping `PanelTabBar` imposes. `SessionProvider` returns a "No session selected" placeholder when `session` is `null` (see `frontend/src/contexts/SessionContext.tsx:42`). The new code guards on `mainRepoSessionId` before rendering the provider, but if `getOrCreateMainRepoSession` succeeds with a session id while `mainRepoSession` is still loading, the provider could briefly render its placeholder over the tab bar. The implementation sets both pieces of state in the same `setMainRepoSessionId`/`setMainRepoSession` pair, which React batches; visual verification in step 13 confirms no flicker.
