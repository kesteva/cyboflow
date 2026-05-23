---
epic: standalone-terminal-panels
created: 2026-05-19T00:00:00Z
status: active
originating_ideas: [IDEA-019]
---

# Standalone Terminal Panels

## Objective

Allow cyboflow users to open on-demand PTY terminal panels on any project or workflow-run session without triggering an AI workflow. Terminals default to the session's worktree (for workflow-run sessions) or project root (for the main-repo project session), are reachable via a visible button in the panel tab bar and a keyboard shortcut, and display the active cwd in a header breadcrumb so users can confirm where commands will execute before they type.

## Scope

- In scope:
  - Backend cwd resolution fix in `panels:initialize` so terminal PTYs spawn at the worktree/project root, not the app bundle directory.
  - Persistence of the resolved cwd in `panel.state.customState.cwd` as the single source of truth.
  - Frontend "Add Terminal" affordance in `PanelTabBar.tsx` (trailing-edge button) plus a global keyboard shortcut.
  - cwd breadcrumb header inside `TerminalPanel.tsx` rendering `panel.state.customState.cwd`.
  - Reuse of existing main-repo project sessions and workflow-run sessions — no new session-row types.

- Out of scope:
  - New "terminal-only" session schema or DB migrations.
  - Stream parsing / approval routing for `claude` invoked inside a terminal — it remains raw PTY I/O.
  - tmux-style persistence beyond the existing scrollback buffer.
  - Right-click / command-palette entry points (deferred — button + shortcut are sufficient for v1).
  - Lifecycle changes (terminal panels continue to be destroyed with their parent session, same as all other panel types).

## Success Signal

A user can: (a) click a visible "Add Terminal" button in the panel tab bar of either a workflow-run session or the main-repo project session and get a PTY shell rooted at the correct directory; (b) press the global keyboard shortcut to achieve the same; (c) read the active cwd from the terminal panel header at any time; (d) type `claude` (or any other CLI tool on their PATH) and enter the tool's interactive REPL. No session-row or schema changes appear in `git diff`. `pnpm typecheck`, `pnpm lint`, and `pnpm test` all exit 0 after the epic's three tasks land.
