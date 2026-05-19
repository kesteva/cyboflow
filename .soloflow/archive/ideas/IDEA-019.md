---
id: IDEA-019
type: FEATURE
status: answered
created: 2026-05-19T00:00:00Z
epics: []
slices:
  - title: "Standalone terminal panel on project/session"
    description: "Allow the user to open a new 'terminal' panel on any existing session (worktree or main-repo session) without triggering an AI workflow. The panel uses the existing TerminalPanelManager + TerminalPanel infrastructure and opens a PTY shell rooted at the session's worktree path."
    value_statement: "Lets the user inspect files, run scripts, or launch interactive CLI tools in a worktree context without having to spin up an AI workflow. Unblocks common ad-hoc tasks today."
  - title: "UI entry point: 'Add Terminal' button in panel tab bar"
    description: "Add an 'Add Terminal' action in the panel tab bar (or a '+' affordance) that calls panelApi.createPanel with type='terminal' and routes the cwd to the session's worktreePath. Operates on both worktree sessions and the main-repo project session."
    value_statement: "Without a visible entry point the backend capability is unreachable. Gives users a clear one-click path to open a shell beside their AI panels."
  - title: "Interactive Claude (and other CLI tools) via terminal — kbd-accessible"
    description: "Document and validate that once a terminal panel is open, users can directly invoke 'claude' (interactive mode, no -p flag) or any other CLI AI tool and interact with it via the xterm.js PTY. Ensure the PATH in the PTY environment includes the user's claude binary (already the case via getShellPath/getSystemEnvironment). Add a keyboard shortcut (e.g., Cmd+Shift+T) to open a new terminal panel."
    value_statement: "Fulfills the core user ask — interactive Claude sessions — without needing new AI manager infrastructure."
  - title: "Worktree-aware default cwd selection"
    description: "When creating a terminal panel from a workflow-run session, default the PTY's cwd to the worktree path (already stored on the session). When creating from the main-repo project session, default to the project's rootPath. Expose the cwd in the terminal panel header as a breadcrumb."
    value_statement: "Eliminates the friction of manually cd-ing to the right directory, which is the first thing every developer does after opening a generic terminal."
open_questions:
  - question: "Should a standalone terminal panel require an existing Crystal/cyboflow session to attach to, or should the user be able to open a terminal panel without any session context (i.e., project-level terminal)?"
    context: "Currently every ToolPanel has a mandatory sessionId foreign key. The main-repo project session is a special session used by ProjectView — terminals can attach there. But adding a completely session-less panel would require schema and store changes. The answer constrains Slice 1 architecture significantly."
    candidates:
      - "Attach to the existing main-repo project session (already has a session row, already used by ProjectView/dashboard panels) — no schema change needed"
      - "Attach to the workflow-run session that is currently selected in the sidebar — terminal lives in that session's panel tab bar"
      - "Allow both: a project-level terminal on the main-repo session AND per-run terminals on workflow-run sessions, with the UI entry point appearing in both contexts"
    answer: "Both contexts (Option 3). The UI entry point appears in both the main-repo project session (rooted at projectPath) and on workflow-run sessions (rooted at worktreePath). Same component, different default cwd from the session record."
  - question: "Where should the 'Add Terminal' UI affordance live?"
    context: "The panel tab bar (PanelTabBar.tsx) already renders per-session tabs. Adding a '+' button there is the lowest-friction path but the tab bar has no current add-panel UX. Alternatively, a button in the session header or a right-click context menu on the session list item would work. Choice affects which component gets modified."
    candidates:
      - "'+' icon appended to the right of the existing tab row in PanelTabBar"
      - "Button in the session header / toolbar area of SessionView or ProjectView"
      - "Right-click context menu on the session list item in the sidebar"
      - "Command palette / keyboard shortcut only (Cmd+Shift+T), no persistent UI button"
    answer: "'+' icon (or compact 'Terminal' button) appended to the trailing edge of PanelTabBar (Option 1). Keyboard shortcut Cmd+Shift+T from Slice 3 layers on top as a non-mutually-exclusive secondary affordance — but the visible button is the primary entry point."
  - question: "Should opening a terminal panel create a new Crystal-style session row in the DB, or reuse an existing session?"
    context: "TerminalPanelManager.initializeTerminal already works with a ToolPanel whose sessionId references an existing session. If standalone terminals must work without an AI session, a lightweight 'shell session' row may need to be created, or we repurpose the main-repo project session. Affects whether the ipc/session.ts createSession path is called."
    candidates:
      - "Reuse the project's main-repo session (zero new DB writes, already exists)"
      - "Create a lightweight 'terminal-only' session row with no worktree (new code, schema stays the same — session.worktreePath would be null)"
      - "Always require an existing workflow-run session — only allow terminal panels on runs that already exist"
    answer: "Reuse existing sessions only (Option 1, generalized): project terminals attach to the main-repo project session that ProjectView already creates; per-run terminals attach to the workflow-run session row that already exists. No new session-type schema, no terminal-only session rows. Keeps the change to a UI entry point plus the panels:create call."
  - question: "Should a terminal panel outlive its parent session, and what happens when the user archives or deletes a workflow-run session that has terminal panels?"
    context: "Today TerminalPanelManager.destroyTerminal is called from panels:delete IPC handler and from panels:delete in panelManager. If the session is archived, panels are presumably cleaned up too. Defining the lifecycle prevents state leakage."
    candidates:
      - "Terminal panels are destroyed with the session — same as all other panel types today"
      - "Terminal panels on the main-repo project session persist until the user explicitly closes them"
    answer: "Destroyed with the session (Option 1). Use the existing panel cleanup path — no special lifecycle for terminal panels. The main-repo project session itself is long-lived (exists for the lifetime of the project), so terminals on it naturally persist anyway. Workflow-run terminals get cleaned up alongside their run as expected."
assumptions:
  - assumption: "The existing TerminalPanelManager + TerminalPanel + PTY stack is fully functional and already supports the 'terminal' panel type end-to-end (create, resize, scrollback, destroy)."
    confidence: high
    validation: "Confirmed by reading terminalPanelManager.ts, TerminalPanel.tsx, panels.ts IPC handler, and PanelContainer.tsx — all wired and handling panel type 'terminal'."
  - assumption: "The main-repo project session (created lazily in ProjectView and used for dashboard/setup-tasks panels) exists for every open project and can accept additional panel rows without schema changes."
    confidence: high
    validation: "ProjectView.tsx always ensures a mainRepoSession exists; panelApi.createPanel with that sessionId would work identically to creating dashboard/setup-tasks panels."
  - assumption: "The PTY environment set up by TerminalPanelManager already includes the user's full PATH (via getShellPath), so 'claude', 'npm', and other CLI tools are reachable without additional setup."
    confidence: high
    validation: "Confirmed in terminalPanelManager.ts line 39: enhancedPath from getShellPath() is injected into the PTY env."
  - assumption: "No new IPC handlers are needed — the existing 'panels:create', 'panels:initialize', 'terminal:input', 'terminal:resize', 'terminal:getState' handlers are sufficient."
    confidence: high
    validation: "Cross-referenced panels.ts IPC and TerminalPanel.tsx — all required IPC calls are already registered and working."
  - assumption: "The user wants to run 'claude' in interactive (REPL) mode, not in -p/pipe mode, which means no stream-json parsing or approval routing is needed."
    confidence: medium
    validation: "User explicitly said 'more interactive claude' — but confirm whether output should be raw PTY passthrough vs. partially parsed for the review queue."
  - assumption: "A single keyboard shortcut (Cmd+Shift+T) is a reasonable default for opening a terminal panel; no conflicts with existing bindings exist."
    confidence: medium
    validation: "Audit existing keyboard shortcut registrations in SessionView.tsx and App.tsx — search for keydown handlers and electron globalShortcut calls."
research_recommendation: not_needed
research_rationale: "The full terminal panel stack (node-pty, xterm.js, TerminalPanelManager, TerminalPanel, panels IPC) already exists in the codebase and is functional; this idea is a UI entry-point + wiring task, not a new technology integration."
---

# IDEA-019: Standalone Terminal Panels

## Raw Input

> users should be able to launch standalone terminal sessions within a project without needing to trigger a workflow for more interactive claude (or other AI) work

## Grounding

The terminal panel infrastructure is almost entirely complete in the codebase today. The relevant files and what each contributes:

**Backend PTY management**
- `/Users/raimundoesteva/Developer/cyboflow/main/src/services/terminalPanelManager.ts` — `TerminalPanelManager` singleton. Spawns a PTY shell (via `@homebridge/node-pty-prebuilt-multiarch`) with the session's cwd, handles scrollback buffering, resize, and state save/restore. Already injects `getShellPath()` as the PTY PATH so user-installed tools like `claude` are discoverable.
- `/Users/raimundoesteva/Developer/cyboflow/main/src/services/terminalSessionManager.ts` — Older session-level terminal manager (pre-panel era). Still referenced by `SessionManager` but largely superseded by `TerminalPanelManager` for the panel-based flow.
- `/Users/raimundoesteva/Developer/cyboflow/main/src/ipc/panels.ts` — `panels:initialize`, `panels:checkInitialized`, `panels:delete` handlers all have explicit `panel.type === 'terminal'` branches that route to `terminalPanelManager`.

**Frontend terminal rendering**
- `/Users/raimundoesteva/Developer/cyboflow/frontend/src/components/panels/TerminalPanel.tsx` — Full xterm.js panel. Calls `panels:initialize` IPC on mount, subscribes to `terminal:output` events, forwards user keystrokes via `terminal:input`, handles resize via `ResizeObserver`. Already functional.
- `/Users/raimundoesteva/Developer/cyboflow/frontend/src/components/panels/PanelContainer.tsx` — Already routes `panel.type === 'terminal'` to `<TerminalPanel>`.
- `/Users/raimundoesteva/Developer/cyboflow/frontend/src/components/panels/PanelTabBar.tsx` — Renders a `<Terminal>` icon for `type === 'terminal'` panels. No "Add Terminal" button exists today.

**Shared types**
- `/Users/raimundoesteva/Developer/cyboflow/shared/types/panels.ts` — `ToolPanelType` already includes `'terminal'`. `TerminalPanelState` is fully defined with cwd, scrollbackBuffer, commandHistory, etc.

**Panel creation API**
- `/Users/raimundoesteva/Developer/cyboflow/frontend/src/services/panelApi.ts` — `panelApi.createPanel({ sessionId, type: 'terminal', title: 'Terminal' })` is the exact call needed. No new API surface required.

**Current gap:** There is no UI entry point that lets users create a `terminal` panel on-demand. The only terminals that appear today are ones auto-created by specific code paths or left over from Crystal-era session initialization. The `ProjectView.tsx` only auto-creates `dashboard` and `setup-tasks` panels. Neither `SessionView.tsx` nor `ProjectView.tsx` exposes an "Add Terminal" affordance.

## Slices

### Slice 1: Standalone terminal panel on project/session

The PTY backend, IPC bridge, and React component are all working. What is missing is a call site that invokes `panelApi.createPanel({ sessionId, type: 'terminal', title: 'Terminal', ... })` in response to a user action.

The cleanest attachment point for v1: the main-repo project session that `ProjectView` already creates and uses for `dashboard` and `setup-tasks` panels. A terminal panel created on this session will use the project's root git checkout as its cwd — giving the user access to the full repo without being scoped to any worktree.

Optionally (and orthogonally), the same button can appear on workflow-run sessions, opening a terminal that defaults to the run's worktree path. This is useful for debugging a specific run.

### Slice 2: UI entry point — "Add Terminal" button in panel tab bar

`PanelTabBar.tsx` renders panel tabs and already imports the `Terminal` lucide icon. Adding a small `+` or explicit "Terminal" button at the trailing edge of the tab row is the lowest-friction change.

The handler calls `panelApi.createPanel` with `type: 'terminal'` and activates the resulting panel. Because `PanelTabBar` already passes an `onPanelSelect` callback, the activation pattern is established.

A keyboard shortcut (`Cmd+Shift+T`) should accompany the button and be registered in the component or a global shortcut handler.

### Slice 3: Interactive CLI tools via terminal — keyboard-accessible + PATH validation

Once the terminal panel is open, users can type `claude` at the shell prompt and enter Claude's interactive REPL. The PTY already has the enhanced PATH. This slice is mostly documentation + smoke-test validation, plus ensuring the cwd breadcrumb is visible in the terminal panel header (currently the panel renders only the xterm viewport with no header chrome).

A lightweight header showing the shell type and current cwd (read from `panel.state.customState.cwd`) would make the terminal feel purposeful rather than anonymous.

### Slice 4: Worktree-aware default cwd selection

`TerminalPanelManager.initializeTerminal(panel, cwd)` accepts the cwd at init time. The caller (`panels:initialize` in `main/src/ipc/panels.ts`, line 126) currently takes the cwd from `options?.cwd || process.cwd()`, which in Electron's main process is the app bundle directory — not useful.

The fix: when creating a terminal panel from the frontend, pass the session's `worktreePath` (for workflow-run sessions) or the project's `rootPath` (for the main-repo project session) as the `initialState.cwd`. The `panels:create` handler stores this in `panel.state.customState.cwd`, and `panels:initialize` should prefer `panel.state.customState.cwd` over `process.cwd()`.

## Open Questions

### Q1: Session attachment model

Should standalone terminals attach to the main-repo project session, the currently-selected workflow-run session, or both? This determines whether the user gets one shared terminal context per project or one per run. The main-repo session already exists and has no worktree constraint; run sessions have a precise worktree cwd. Both are valid and the panel system supports both — but the UI affordance and mental model differ.

**Answer:** Both contexts (Option 3). The UI entry point appears in both the main-repo project session (rooted at `projectPath`) and on workflow-run sessions (rooted at `worktreePath`). Same component, different default cwd from the session record.

### Q2: UI placement for "Add Terminal"

A `+` button in `PanelTabBar` is the lowest-diff path but the tab bar is already compact. Alternatives include a button in the session header, a right-click context menu on the session sidebar item, or keyboard-shortcut-only. The choice affects which component is modified and how discoverable the feature is.

**Answer:** '+' icon (or compact 'Terminal' button) appended to the trailing edge of `PanelTabBar` (Option 1). Keyboard shortcut `Cmd+Shift+T` from Slice 3 layers on top as a non-mutually-exclusive secondary affordance — but the visible button is the primary entry point.

### Q3: New session row or reuse existing?

If terminals must be launchable outside of any existing AI session, a lightweight session row would need to be created. If terminals always attach to existing sessions (main-repo or workflow-run), no schema change is required. The reuse approach is lower risk for v1.

**Answer:** Reuse existing sessions only (Option 1, generalized): project terminals attach to the main-repo project session that `ProjectView` already creates; per-run terminals attach to the workflow-run session row that already exists. No new session-type schema, no terminal-only session rows. Keeps the change to a UI entry point plus the `panels:create` call.

### Q4: Terminal panel lifecycle on session archive/delete

When a workflow-run session is archived or deleted, do its terminal panels get destroyed along with it (current behavior for all panel types), or do terminals on the main-repo project session persist indefinitely? Defining this avoids PTY process leaks.

**Answer:** Destroyed with the session (Option 1). Use the existing panel cleanup path — no special lifecycle for terminal panels. The main-repo project session itself is long-lived (exists for the lifetime of the project), so terminals on it naturally persist anyway. Workflow-run terminals get cleaned up alongside their run as expected.

## Assumptions

- The `TerminalPanelManager` + `TerminalPanel` + panels IPC stack is production-ready for new terminal panel creation — only a UI entry point is missing.
- `getShellPath()` already provides a PATH that includes `claude`, `npm`, `git`, etc. — no extra PATH configuration needed for interactive AI CLI use.
- No new IPC handlers are required; existing `panels:create`, `panels:initialize`, `terminal:input`, `terminal:resize`, and `terminal:getState` handlers cover all needed operations.
- Interactive Claude (no `-p`) in a PTY does not need to go through `AbstractCliManager`, stream parsing, or the approval queue — it is raw shell I/O, same as any user command.
- Creating a terminal panel on the main-repo project session (which already holds `dashboard` and `setup-tasks` panels) is safe and requires no schema changes.
- A keyboard shortcut of `Cmd+Shift+T` has no existing conflict — requires a quick audit of keydown handlers in `SessionView.tsx` and `App.tsx` to confirm.
