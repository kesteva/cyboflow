---
epic: session-lifecycle-actions
created: 2026-05-27T00:00:00Z
status: active
originating_ideas: [IDEA-028]
---

# Session Lifecycle Actions (Merge, Create PR, Dismiss)

## Objective

Surface session lifecycle management actions in the CyboflowRoot header bar: Merge (squash or preserve-commits into main branch, auto-cleanup worktree), Create PR (push branch, open GitHub compare URL, auto-cleanup), and Dismiss (confirm destructive close, archive session, remove worktree). Re-enables the `@cyboflow-hidden` WorktreeManager merge methods that were preserved during the Crystal-cuts-and-rebrand epic and wires them to new frontend dialog components.

## Scope

- In scope:
  - SessionLifecycleActionBar component injected into CyboflowRoot header row
  - SessionActionToast component for post-action success feedback
  - SessionMergeDialog with squash/preserve-commits strategy selection
  - SessionCreatePrDialog with git push + GitHub URL construction + system browser open
  - New `sessions:get-remote-url` IPC handler for remote URL + branch name retrieval
  - SessionDismissDialog wrapping ConfirmDialog with destructive styling
  - Button enable/disable logic: Merge and Create PR disabled when session is running; Dismiss always enabled
  - Auto-cleanup (sessions:delete) after successful merge or PR creation

- Out of scope:
  - GitLab, Bitbucket, or other non-GitHub provider support for Create PR
  - Removing `@cyboflow-hidden` annotations from WorktreeManager methods (they stay hidden until this UI ships)
  - Merge conflict resolution UI (errors surface via ErrorDialog; user resolves in terminal)
  - Batch session operations (one session at a time)

## Success Signal

A user can click Merge, Create PR, or Dismiss on any active non-main-repo session from the header bar. Merge offers squash vs preserve-commits; Create PR pushes and opens GitHub; Dismiss confirms and archives. All three auto-cleanup the worktree on success. Buttons are disabled during active Claude runs. `pnpm test:unit` and `pnpm typecheck` pass.

## Tasks

- TASK-792 — Add SessionLifecycleActionBar shell to CyboflowRoot header
- TASK-793 — Implement local Merge dialog (squash vs preserve-commits)
- TASK-794 — Add sessions:get-remote-url IPC and implement Create PR flow
- TASK-795 — Wire Dismiss action with ConfirmDialog
