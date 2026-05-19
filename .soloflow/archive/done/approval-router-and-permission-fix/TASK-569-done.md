---
id: TASK-569
sprint: SPRINT-020
epic: approval-router-and-permission-fix
status: done
summary: "Flipped all user-facing permissionMode defaults from 'ignore' to 'approve' across UI + main process; removed 'Skip' card from ClaudeCodeConfig"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-569 — permissionMode 'ignore' callsite sweep

Flipped 15 user-facing callsites of `permissionMode: 'ignore'` to `'approve'`, removed the 'Skip' option card from `ClaudeCodeConfig.tsx`, added 5 regression tests covering store default, `ConfigManager.DEFAULT_CONFIG`, inline fallback, and top-level `defaultPermissionMode`. Type-level `'ignore' | 'approve'` unions in shared/types and database CHECK constraint preserved as escape hatches.

Verifier: APPROVED (parallel mode → visual verify skipped).
Code reviewer: CLEAN (no findings).
Test writer: TESTS_WRITTEN (1 new test case).
Tests: 412/412 main, 209/209 frontend, typecheck + lint clean.

Out-of-scope findings filed: FIND-SPRINT-020-4 (BaseCliPanel.tsx + Settings.tsx still expose 'ignore' option), FIND-SPRINT-020-5 (plan premise was stale — TASK-204 throw no longer exists).
