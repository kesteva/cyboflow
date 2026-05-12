---
id: TASK-004
sprint: SPRINT-001
epic: crystal-cuts-and-rebrand
status: done
summary: "Hid (preserved-but-disconnected) rebase/squash/merge UI entry points in SessionView and Help; annotated underlying worktreeManager methods with @cyboflow-hidden."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-004 — Hide Rebase/Squash UI Entry Points

## Commits

- `90340fd feat(TASK-004): hide rebase/squash UI entry points for cyboflow v1`

## Changes

- Removed `rebase-from-main` / `rebase-to-main` entries from `SessionView.tsx` `branchActions`
- Replaced `<CommitMessageDialog />` JSX with `@cyboflow-hidden` comment
- Stripped `GitMerge` import (no longer used)
- Removed "Rebase from main" / "Squash and rebase" bullets from `Help.tsx`
- Added `@cyboflow-hidden` block annotation above preserved methods in `worktreeManager.ts:472`
- Preserved underlying handlers (`handleSquashAndRebaseToMain`, `performSquashWithCommitMessage`, `rebaseMainIntoWorktree`, `squashAndMergeWorktreeToMain`, `mergeWorktreeToMain`, `abortRebase`) and IPC layer untouched

## Verification

All 7 acceptance criteria passed. Code-review verdict: CLEAN.

## Carryover findings

- FIND-SPRINT-001-3: Add `@cyboflow-hidden` header to `CommitMessageDialog.tsx` for parity with worktreeManager (polish).
- FIND-SPRINT-001-4: Add `@cyboflow-hidden` annotation to preserved handler group in `useSessionView.ts` (polish).
