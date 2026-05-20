---
id: TASK-658
idea: IDEA-019
status: in-flight
created: "2026-05-19T00:00:00Z"
files_owned:
  - frontend/src/types/panelComponents.ts
  - frontend/src/components/panels/PanelTabBar.tsx
  - frontend/src/components/ProjectView.tsx
  - frontend/src/components/SessionView.tsx
  - tests/standalone-terminal-panels.spec.ts
files_readonly:
  - frontend/src/services/panelApi.ts
  - frontend/src/contexts/SessionContext.tsx
  - frontend/src/stores/panelStore.ts
  - shared/types/panels.ts
  - frontend/src/types/session.ts
  - frontend/src/types/project.ts
  - main/src/ipc/panels.ts
  - frontend/src/hooks/useAddTerminalShortcut.ts
acceptance_criteria:
  - criterion: "PanelTabBarProps has an optional onAddTerminal callback typed as () => void or () => Promise<void>"
    verification: "grep -n 'onAddTerminal' frontend/src/types/panelComponents.ts shows the prop declared as optional with a no-arg function type returning void or Promise<void>"
  - criterion: "PanelTabBar renders a visible 'Add Terminal' trigger button at the trailing edge of the tab row when onAddTerminal is provided"
    verification: "grep -n 'onAddTerminal' frontend/src/components/panels/PanelTabBar.tsx shows the prop destructured and rendered as a <button> with aria-label='Add terminal panel'; in a running pnpm dev session the button is visible to the right of the tabs in both ProjectView (project context) and SessionView (worktree context)"
  - criterion: The Add Terminal button uses the lucide-react Plus icon (or Terminal+Plus combo) and has visible focus styles consistent with other PanelTabBar buttons
    verification: "grep -n \"from 'lucide-react'\" frontend/src/components/panels/PanelTabBar.tsx shows Plus imported; the button element includes focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-subtle classes (matching existing rename/close buttons)"
  - criterion: "Clicking the button in ProjectView creates a terminal panel on the main-repo project session with initialState.cwd set to the project's path and activates the new panel"
    verification: "grep -n 'panelApi.createPanel' frontend/src/components/ProjectView.tsx shows an onAddTerminal handler that calls createPanel with type: 'terminal', sessionId: mainRepoSessionId, and initialState: { cwd: <project path> }; in a pnpm dev session, opening a project, clicking Add Terminal opens a new Terminal tab and the resulting PTY is rooted at the project path (verified via 'pwd' typed into the PTY)"
  - criterion: "Clicking the button in SessionView creates a terminal panel on the active session with initialState.cwd set to the session's worktreePath and activates the new panel"
    verification: "grep -n 'panelApi.createPanel' frontend/src/components/SessionView.tsx shows an onAddTerminal handler that calls createPanel with type: 'terminal', sessionId: activeSession.id, and initialState: { cwd: activeSession.worktreePath }; in a pnpm dev session, opening a workflow-run session and clicking Add Terminal opens a new Terminal tab rooted at the worktree path (verified via 'pwd' in the PTY)"
  - criterion: Both call sites pass onAddTerminal to PanelTabBar
    verification: "grep -n 'onAddTerminal' frontend/src/components/ProjectView.tsx frontend/src/components/SessionView.tsx shows the prop wired through to <PanelTabBar onAddTerminal={...} /> in both files"
  - criterion: The new terminal panel becomes the active panel after creation (via setActivePanelInStore + panelApi.setActivePanel) and renders via existing PanelContainer routing
    verification: "In a pnpm dev session, after clicking Add Terminal the new tab is highlighted as active and the xterm.js viewport renders; cyboflow-frontend-debug.log shows no errors from panelApi.createPanel or panels:initialize"
  - criterion: Both ProjectView and SessionView call useAddTerminalShortcut(handleAddTerminal) so the global keyboard shortcut (defined in TASK-659) fires the same callback as the button
    verification: "grep -n 'useAddTerminalShortcut' frontend/src/components/ProjectView.tsx frontend/src/components/SessionView.tsx returns at least one match in each file, and the hook is invoked with the same handleAddTerminal that the PanelTabBar button uses"
  - criterion: "TypeScript strict checks pass and no use of the 'any' type is introduced"
    verification: "pnpm typecheck exits 0 and pnpm lint exits 0; grep -n ': any\\b\\| as any\\b' on the four owned source files returns 0 matches"
depends_on:
  - TASK-657
  - TASK-659
estimated_complexity: medium
epic: standalone-terminal-panels
test_strategy:
  needed: true
  justification: "No sibling unit/component tests exist for PanelTabBar.tsx, ProjectView.tsx, or SessionView.tsx (verified via Glob on the panels directory and component test directories). A focused Playwright E2E spec is the right level of coverage because the behavior spans UI interaction + IPC + PTY initialization, and visual verification is required per the task brief."
  targets:
    - behavior: "Clicking the 'Add Terminal' button in PanelTabBar from the project (main-repo) context creates a new terminal panel rooted at the project path and the new tab becomes active"
      test_file: tests/standalone-terminal-panels.spec.ts
      type: integration
    - behavior: "Clicking the 'Add Terminal' button in PanelTabBar from a workflow-run session context creates a new terminal panel rooted at the session's worktreePath and the new tab becomes active"
      test_file: tests/standalone-terminal-panels.spec.ts
      type: integration
    - behavior: "The Add Terminal button is keyboard-focusable (Tab to it, Enter activates) and exposes aria-label='Add terminal panel'"
      test_file: tests/standalone-terminal-panels.spec.ts
      type: integration
---
# Add 'Add Terminal' button to PanelTabBar and wire createPanel in ProjectView and SessionView

## Objective

Add the primary UI entry point for IDEA-019's standalone terminal panels: an "Add Terminal" button on `PanelTabBar` that creates a new `type: 'terminal'` panel via `panelApi.createPanel`, with the working directory routed from the calling context (project path for `ProjectView`, `worktreePath` for `SessionView`). The button is the visible, discoverable affordance. The keyboard shortcut wiring uses the `useAddTerminalShortcut` hook produced by TASK-659 (the hook itself and the cwd-header live in T3; T2 imports the hook in `ProjectView`/`SessionView` so the same callback backs both the button and the shortcut). This task assumes TASK-657 has corrected `panels:initialize` to read `initialState.cwd` from `panel.state.customState.cwd`, so the cwd we pass here flows through to the PTY.

## Implementation Steps

1. **Extend `PanelTabBarProps` in `frontend/src/types/panelComponents.ts`.** Add an optional `onAddTerminal?: () => void | Promise<void>` property. Do not change the existing `panels` / `activePanel` / `onPanelSelect` / `onPanelClose` / `context` props.

2. **Update `frontend/src/components/panels/PanelTabBar.tsx`.**
   - Add `Plus` to the existing `lucide-react` import (line 2): `import { X, Terminal, MessageSquare, GitBranch, FileText, FileCode, MoreVertical, BarChart3, Edit2, Plus } from 'lucide-react';`.
   - Destructure `onAddTerminal` from props (alongside `panels`, `activePanel`, `onPanelSelect`, `onPanelClose`, `context`).
   - Add a memoized handler `handleAddTerminal` that, when `onAddTerminal` is defined, calls it; wrap in `useCallback` with `[onAddTerminal]` as the dep. The handler should swallow the returned promise (no `await` needed in the click handler) but log any rejection via `console.error('[PanelTabBar] Failed to add terminal:', err)`.
   - Inside the existing flex container (around lines 157–264), after the `panels.map(...)` block and before the `gitBranchActions` block (which currently uses `ml-auto`), render the button **only when `onAddTerminal` is defined**. The button must compete with the `gitBranchActions` for the trailing edge; the simplest layout is to wrap both inside a single trailing container with `ml-auto` and `gap-2`, with the Add Terminal button rendered first and `gitBranchActions` second. Concretely:
     ```tsx
     {(onAddTerminal || (context === 'worktree' && gitBranchActions && gitBranchActions.length > 0)) && (
       <div className="ml-auto flex items-center gap-2 pr-2 h-8">
         {onAddTerminal && (
           <button
             type="button"
             onClick={handleAddTerminal}
             aria-label="Add terminal panel"
             title="Add terminal panel"
             className="inline-flex items-center gap-1 h-7 px-2 rounded text-sm text-text-secondary hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-subtle"
           >
             <Plus className="w-4 h-4" />
             <Terminal className="w-4 h-4" />
             <span className="sr-only">Add terminal panel</span>
           </button>
         )}
         {context === 'worktree' && gitBranchActions && gitBranchActions.length > 0 && (
           <Dropdown ... />  /* existing dropdown unchanged */
         )}
       </div>
     )}
     ```
     Keep the existing `Dropdown` JSX verbatim — the only change is moving it inside the shared trailing container and gating the whole container on either-or instead of just `gitBranchActions`.
   - Do NOT add any keyboard shortcut here. The global shortcut is wired in `ProjectView`/`SessionView` via the `useAddTerminalShortcut` hook from TASK-659.

3. **Wire `onAddTerminal` in `frontend/src/components/ProjectView.tsx`.**
   - Add a `useCallback` named `handleAddTerminal` next to `ensureClaudePanel` (around line 158). Guard on `mainRepoSessionId` and on `mainRepoSession` (the latter holds the worktreePath, which for a main-repo session is the project root). It should:
     - Read the project path from `mainRepoSession?.worktreePath` (set by `getOrCreateMainRepoSession` to the project root). If unavailable, bail out (early return) and log.
     - Call:
       ```ts
       const newPanel = await panelApi.createPanel({
         sessionId: mainRepoSessionId,
         type: 'terminal',
         title: 'Terminal',
         initialState: { cwd: mainRepoSession.worktreePath },
       });
       addPanel(newPanel);
       setActivePanelInStore(mainRepoSessionId, newPanel.id);
       await panelApi.setActivePanel(mainRepoSessionId, newPanel.id);
       ```
     - Deps: `[mainRepoSessionId, mainRepoSession, addPanel, setActivePanelInStore]`.
   - Import the shortcut hook: `import { useAddTerminalShortcut } from '../hooks/useAddTerminalShortcut';`. After defining `handleAddTerminal`, call `useAddTerminalShortcut(handleAddTerminal);`.
   - In the `<PanelTabBar ... />` JSX (around line 340–346), pass `onAddTerminal={handleAddTerminal}`.

4. **Wire `onAddTerminal` in `frontend/src/components/SessionView.tsx`.**
   - Add a `useCallback` named `handleAddTerminal` near `handlePanelClose` (around line 226). Guard on `activeSession`. It should:
     ```ts
     const newPanel = await panelApi.createPanel({
       sessionId: activeSession.id,
       type: 'terminal',
       title: 'Terminal',
       initialState: { cwd: activeSession.worktreePath },
     });
     addPanel(newPanel);
     setActivePanelInStore(activeSession.id, newPanel.id);
     await panelApi.setActivePanel(activeSession.id, newPanel.id);
     addToHistory(activeSession.id, newPanel.id);
     ```
     Deps: `[activeSession, addPanel, setActivePanelInStore, addToHistory]`.
   - Import the shortcut hook: `import { useAddTerminalShortcut } from '../hooks/useAddTerminalShortcut';`. After defining `handleAddTerminal`, call `useAddTerminalShortcut(handleAddTerminal);`.
   - In the `<PanelTabBar ... />` JSX in `SessionView.tsx` (around lines 432–437; check for any second instance and update both), pass `onAddTerminal={handleAddTerminal}`.

5. **TypeScript / lint compliance.** Use strict typing throughout — no `any`. The `initialState` field on `CreatePanelRequest` already accepts `TerminalPanelState`, and `cwd?: string` is on `TerminalPanelState` (shared/types/panels.ts:25), so `initialState: { cwd: ... }` typechecks without casts.

6. **Author the Playwright spec `tests/standalone-terminal-panels.spec.ts`** covering:
   - Open the app, dismiss any onboarding, navigate to a project, click the Add Terminal button, assert that a new tab with the Terminal icon appears and is active.
   - Repeat for a workflow-run session (create or pick an existing run-session) and assert the new tab is active.
   - Assert the button is reachable via `page.getByRole('button', { name: 'Add terminal panel' })` and that pressing Enter while focused activates it.
   - Use `page.screenshot()` at the end of each case into `test-results/` to give visual evidence.
   - If the test environment cannot fully bootstrap a worktree session (the worktree fixture in this repo is non-trivial), fall back to skipping the run-session case with `test.skip()` and a one-line justification; the project-context case is mandatory.

7. **Visual verification with the full Electron app.** Run `pnpm build:main && pnpm dev`, then in the app: (a) open any project, confirm the Add Terminal button is visible in the panel tab bar, click it, type `pwd` in the resulting terminal and confirm the path matches the project root; (b) open a workflow-run session, repeat, confirm `pwd` matches the worktree path. Read `cyboflow-frontend-debug.log` to confirm no errors. Capture a screenshot of each context for the PR (`test-results/add-terminal-project.png`, `test-results/add-terminal-worktree.png`).

8. **Completeness gate before reporting COMPLETED.** Run all of:
   - `pnpm typecheck` — must exit 0.
   - `pnpm lint` — must exit 0.
   - `pnpm test -- tests/standalone-terminal-panels.spec.ts` (or full `pnpm test`) — new spec must pass.
   - `grep -n 'onAddTerminal' frontend/src/types/panelComponents.ts frontend/src/components/panels/PanelTabBar.tsx frontend/src/components/ProjectView.tsx frontend/src/components/SessionView.tsx` — at least one hit per file.
   - `grep -n 'useAddTerminalShortcut' frontend/src/components/ProjectView.tsx frontend/src/components/SessionView.tsx` — at least one hit per file.

## Acceptance Criteria

Each criterion in frontmatter has a pass/fail definition via its `verification`. Of note:
- The IPC payload typing for `initialState: { cwd: ... }` must compile cleanly via `TerminalPanelState`; if TypeScript complains, the fix is on the IDEA caller side (pass the full `Partial<TerminalPanelState>`), not on `panelApi`.
- The visible-button criteria explicitly require `pnpm dev` verification because Vite-only rendering at http://localhost:4521 cannot bootstrap standalone (per project CLAUDE.md).
- The kbd-shortcut wiring uses `useAddTerminalShortcut` (defined in TASK-659) — this task imports and calls the hook in both views.

## Test Strategy

Author one Playwright integration spec `tests/standalone-terminal-panels.spec.ts` covering three behaviors (see frontmatter `targets`): project-context add-terminal flow, worktree-context add-terminal flow, and keyboard accessibility of the button. The spec must reach into the running Electron app (the existing Playwright setup in this repo already drives the real app — see `tests/smoke.spec.ts` for the bootstrap shape).

No unit-level test is added because (a) no sibling unit harness exists for these three components, (b) the behavior depends on real IPC + a real Zustand store + real React state, all of which are awkward to mock without large fixture investment, and (c) the visible-button + PTY-rooted-at-cwd assertion is more credibly verified at the E2E layer.

Mocking / fixtures: the project-context test can use the existing test fixtures used by `tests/smoke.spec.ts` (no new fixture). The worktree-context test may need a pre-created workflow-run session; if that fixture cost is prohibitive in this task, `test.skip` it with a clear TODO referencing TASK-659 or a follow-up.

## Hardest Decision

Where to source the cwd in `ProjectView`. The IDEA's Slice 4 says "the project's `rootPath`" but the frontend `Project` type uses `path` (not `rootPath`); meanwhile `mainRepoSession.worktreePath` is already populated to the project root by `getOrCreateMainRepoSession`. Using `mainRepoSession.worktreePath` keeps the call site symmetric with `SessionView` (both read from the session record) and avoids threading `projectData.path` through `ProjectView`'s already-loaded state.

## Rejected Alternatives

1. **Inline the keyboard-shortcut handler in `ProjectView`/`SessionView` directly instead of importing the hook from TASK-659.** Rejected: the hook centralizes the focus-guard logic, the binding choice, and the unit tests. Inlining would duplicate that surface in two files.

2. **Read cwd from `projectData.path` in `ProjectView`.** Rejected: would require either prop-drilling `projectData.path` into `ProjectView` (it currently only gets `projectName`) or a fresh `API.projects.getAll()` round-trip just for the click handler. `mainRepoSession.worktreePath` is already in component state and is set to the project root by the backend.

3. **Make the button a `<Dropdown>` with "Add Terminal" / future "Add Editor" / etc. items.** Rejected: out of scope for this task and adds polish surface area without a second concrete user need yet. The IDEA only asks for Add Terminal; YAGNI.

4. **Render the button inline at the end of the `panels.map` rather than in a trailing container.** Rejected: this collides with the existing `gitBranchActions` block that already uses `ml-auto`. The proposed wrapper container preserves both affordances without layout conflict.

## Lowest Confidence Area

The Playwright E2E setup for the worktree-context case. The existing Playwright specs in `tests/` mostly drive the app shell or hit specific UI surfaces; they don't establish a workflow-run session as a fixture. If creating a worktree session inside the test requires significant additional bootstrapping (git init, project registration, run creation), the worktree case may end up as `test.skip` with a TODO, leaving only the project-context case automatically verified. In that scenario, the worktree behavior is still covered by the manual `pnpm dev` verification step (#7) and by the acceptance criterion's grep on `activeSession.worktreePath`, but the regression risk for future refactors is higher. If a sibling refinement turns up a cheap worktree fixture pattern, lift it into this spec.

A secondary low-confidence area: whether `panelApi.createPanel`'s `initialState` round-trips `cwd` through to `panel.state.customState.cwd` correctly. TASK-657 owns that fix; if T1 lands but does not actually persist `customState.cwd`, the click will succeed but the PTY will still land in `process.cwd()`. The `pwd`-in-PTY visual verification step is the canary for this — if it shows the Electron app bundle directory instead of the project/worktree root, escalate to T1.
