---
id: TASK-004
idea: IDEA-001
status: in-flight
created: "2026-05-11T00:00:00Z"
files_owned:
  - frontend/src/components/SessionView.tsx
  - frontend/src/hooks/useSessionView.ts
  - frontend/src/components/Help.tsx
  - frontend/src/components/session/CommitMessageDialog.tsx
  - main/src/services/worktreeManager.ts
files_readonly:
  - main/src/ipc/git.ts
  - frontend/src/components/GitStatusIndicator.tsx
  - frontend/src/components/MainBranchWarningDialog.tsx
  - frontend/src/types/electron.d.ts
  - frontend/src/utils/api.ts
  - frontend/src/components/Welcome.tsx
  - docs/cyboflow_system_design.md
acceptance_criteria:
  - criterion: No rebase/squash/merge entries appear in the `branchActions` array constructed in `SessionView.tsx`
    verification: "`grep -nE \"id:\\s*['\\\"]rebase-from-main['\\\"]|id:\\s*['\\\"]rebase-to-main['\\\"]|id:\\s*['\\\"]squash\" frontend/src/components/SessionView.tsx` returns zero matches"
  - criterion: "`worktreeManager.ts` retains its rebase/squash/merge method implementations (NOT deleted) and they are marked with `@cyboflow-hidden` comment blocks"
    verification: "`grep -nE 'rebaseMainIntoWorktree|squashAndMergeWorktreeToMain|mergeWorktreeToMain|abortRebase' main/src/services/worktreeManager.ts` returns at least 4 matches (the method definitions). Additionally `grep -n '@cyboflow-hidden' main/src/services/worktreeManager.ts` returns at least 1 match indicating the class or method group is annotated."
  - criterion: Help dialog no longer documents rebase/squash UI as an active feature
    verification: "`grep -nE 'Rebase from main|Squash and rebase' frontend/src/components/Help.tsx` returns zero matches"
  - criterion: "`useSessionView` hook still exports `handleSquashAndRebaseToMain`, `performSquashWithCommitMessage`, etc. (the methods stay; only the UI entry points are removed)"
    verification: "`grep -n 'handleSquashAndRebaseToMain\\|performSquashWithCommitMessage' frontend/src/hooks/useSessionView.ts` returns at least 2 matches"
  - criterion: "App builds and typechecks: `pnpm run build:frontend && pnpm typecheck` exit 0"
    verification: Run both commands from repo root
  - criterion: "`CommitMessageDialog` is no longer reachable from `SessionView`: the `<CommitMessageDialog />` JSX usage in SessionView is removed or commented with `@cyboflow-hidden`"
    verification: "`grep -nE 'CommitMessageDialog' frontend/src/components/SessionView.tsx | grep -v '@cyboflow-hidden'` returns zero matches"
depends_on: []
estimated_complexity: low
epic: crystal-cuts-and-rebrand
test_strategy:
  needed: false
  justification: "This task hides UI buttons but preserves underlying business logic. No new behavior is introduced. Existing Playwright tests do not appear to cover rebase/squash actions explicitly (Glob found no test files mentioning these IDs). The grep-based ACs are sufficient: they verify (a) the UI entry points are gone and (b) the worktree methods still exist with the hidden annotation."
---
# Hide (Do Not Delete) Rebase/Squash UI Entry Points

## Objective

Crystal's worktree UI exposes "Rebase from main", "Merge to main" (via squash), and the `CommitMessageDialog` confirmation flow as primary actions in the session view's branch-actions dropdown. Cyboflow's v1 thesis is "concentrate human attention on tool-use approvals" — git-history operations are out of scope but plausible v2 features. The cuts epic rule (§3) says: *delete things that mislead; hide things that are harmless out-of-scope*.

This task:
1. Removes the `rebase-from-main` and `rebase-to-main` entries from the `branchActions` array in `SessionView.tsx` (UI hide).
2. Removes the `<CommitMessageDialog />` JSX usage in `SessionView.tsx` (no longer reachable).
3. Removes the "Git Operations" subsection from `Help.tsx`.
4. **Preserves** all underlying code: `handleRebaseMainIntoWorktree`, `handleSquashAndRebaseToMain`, `performSquashWithCommitMessage`, `performSquashWithCommitMessageAndArchive` in `useSessionView.ts` stay intact. `WorktreeManager.rebaseMainIntoWorktree`, `WorktreeManager.squashAndMergeWorktreeToMain`, `WorktreeManager.mergeWorktreeToMain`, `WorktreeManager.abortRebase` stay intact in `worktreeManager.ts`.
5. **Annotates** the preserved methods with `// @cyboflow-hidden` comment blocks so Claude Code agents reading the codebase have a clear "don't depend on this; not active in v1" signal.

The IPC handlers in `main/src/ipc/git.ts` (`sessions:rebase-main-into-worktree`, `sessions:squash-and-rebase-to-main`, `sessions:rebase-to-main`, `sessions:abort-rebase-and-use-claude`) are also preserved — removing them is destructive. Adding a `@cyboflow-hidden` annotation in `git.ts` is encouraged but lower priority; the primary surface is the UI dropdown.

## Implementation Steps

1. **Pre-flight grep** to confirm the surface area:
   