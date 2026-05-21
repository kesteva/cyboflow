---
id: TASK-679
sprint: SPRINT-027
epic: crystal-cuts-and-rebrand
status: done
summary: "Introduced runGit/runGitAsync execFile-based helpers; migrated 4 high-priority shell-interpolated git sites; added TODO(TASK-680) trail for ~20 follow-ups."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
visual_macos: not_applicable
---

# TASK-679 — Done

## What changed
- main/src/utils/runGit.ts (new): runGit (sync, execFileSync), runGitAsync (async, promisify(execFile)). Default maxBuffer 10MB; encoding+env options.
- main/src/utils/__tests__/runGit.test.ts (new): 12 tests — happy paths, adversarial $(touch) proof for both sync+async, error path, cwd, env.
- main/src/ipc/file.ts: migrated 4 sites (2x git add -A + 2x git commit -F) to runGitAsync.
- main/src/services/commitManager.ts: migrated git merge-base + git reset --soft to runGit.
- TODO(TASK-680) markers across files_readonly (plan Step 8 authorized): git.ts, dashboard.ts, executionTracker.ts, gitPlumbingCommands.ts, gitDiffManager.ts, gitStatusManager.ts.

## Verification
- runGit.test.ts: 12/12 pass.
- Full main: 563/564 (pre-existing killProcess timeout only).
- Typecheck + lint: pass.

## Findings logged
- FIND-SPRINT-027-6 (out-of-diff: TODO markers missed on multi-line wrapped execSync git sites in git.ts — 6 sites; mechanical follow-up for TASK-680)

## Minor (advisory only, not blocking)
- encoding: 'buffer' option in RunGitOptions is dead — both functions always return string. Documented in JSDoc. Consider type-narrowing in a follow-up.

## Commits
- 1034b2f feat(TASK-679): add shell-free runGit/runGitAsync helpers
- 448b24b feat(TASK-679): migrate 4 execSync/execAsync git sites to runGit/runGitAsync
