---
epic: quick-session
created: 2026-05-23T00:00:00Z
status: active
originating_ideas: [IDEA-024]
---

# Quick Session — Start Chat or Terminal Without a Flow

## Objective

Allow users to start a Chat or Terminal session directly from the app header or the WorkflowPicker modal, bypassing the workflow selection step entirely. Quick sessions get an auto-generated worktree branch (`quick-YYYYMMDD-HHmmss`), a `run_id = null` DB record, and first-class representation in the session list. All run-aware query surfaces tolerate the null linkage.

## Scope

- In scope:
  - Migration adding nullable `run_id` column to sessions table
  - `sessions:create-quick` IPC handler with timestamp branch naming
  - NULL-tolerance audit of all run-aware queries, orchestrator state, and MCP query handler
  - Quick Chat / Quick Terminal buttons in WorkflowPicker
  - Standalone Quick Session button + inline mode picker in CyboflowRoot header
  - `useAddQuickSessionShortcut` keyboard shortcut hook
  - Quick badge on SessionListItem; archive/rename/favorite verified on null-run sessions

- Out of scope:
  - WorkflowRun creation for quick sessions (nullable run_id path chosen; no synthetic workflow rows)
  - Encoding panel type in the auto-generated branch name
  - Redirect-to-project-selector behavior when no project is selected (deferred; disable+tooltip is the default)
  - Panel type beyond `claude` and `none` (terminal) — no new ToolPanelType values

## Success Signal

A user can open the app, click Quick Session in the header (or use the keyboard shortcut), pick Chat or Terminal, and land in a new session with a `quick-YYYYMMDD-HHmmss` worktree — without selecting a workflow. The session appears in the sidebar with a Quick badge. Archive, rename, and favorite all work. `pnpm test:unit` exits 0. No run-list UI, MCP handler, or orchestrator path throws on a session with `run_id = NULL`.
