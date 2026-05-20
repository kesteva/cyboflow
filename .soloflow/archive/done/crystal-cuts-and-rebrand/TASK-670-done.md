---
id: TASK-670
sprint: SPRINT-025
epic: crystal-cuts-and-rebrand
status: done
summary: "Migrated 3 ad-hoc shell-arg escape sites (git:execute-project, git commit -m, WORKTREE_PATH export) to canonical escapeShellArg/escapeShellArgs helpers; added 26+8 unit tests covering adversarial inputs; closes a real injection surface in commit messages where the old escape left $(...) and backticks live"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-670: Migrate ad-hoc shell-arg escapes to canonical helpers

## Outcome

Three sites in `main/` were doing their own shell-arg escaping with materially-broken patterns. The most dangerous (`worktreeManager.ts`'s `fullMessage.replace(/"/g, '\\"')` for `git commit -m`) left `$(...)`, backticks, and `${...}` live inside the double-quoted wrapper — a real shell injection surface for adversarial commit messages. All three migrated to canonical `escapeShellArg`/`escapeShellArgs` helpers (POSIX single-quote wrap with `'\''` for embedded quotes). Comprehensive helper-level tests (26) plus call-site simulation tests (8) cover injection, embedded quotes, backticks, `$(...)`, `${...}`, semicolons, `&&`/`||`, newlines.

## Changes

- `main/src/ipc/file.ts` — `git:execute-project` handler uses `escapeShellArgs(request.args)`
- `main/src/services/worktreeManager.ts` — `git commit -m` uses `escapeShellArg(fullMessage)` (security fix)
- `main/src/services/runCommandManager.ts` — `WORKTREE_PATH` export uses `escapeShellArg(worktreePath)`
- `main/src/utils/__tests__/shellEscape.test.ts` — new file (26 adversarial tests)
- `main/src/ipc/__tests__/fileGitExecuteProject.test.ts` — new file (8 call-site simulation tests)

## Commits

- `6c23b2f` — `fix(TASK-670): migrate 3 ad-hoc shell-arg escape sites to escapeShellArg/escapeShellArgs`
- `316ff0e` — call-site simulation tests for git:execute-project

## Verification

- pnpm typecheck: PASS
- pnpm lint: PASS (0 errors)
- pnpm build:main: PASS
- shellEscape.test.ts: 26/26 pass
- shadow-verifier verdict: APPROVED
- code-reviewer verdict: CLEAN
- test-writer: TESTS_WRITTEN (8 call-site simulation tests)

## Out-of-diff findings filed

- FIND-SPRINT-025-11 — ~30 other `execSync(\`git ... ${value}\`)` sites in `main/` use no escape function at all; recommend a `runGit(cwd, args[])` helper backed by `execFile`
- FIND-SPRINT-025-12 — Two `git commit -F ${tmpFile}` calls in `file.ts` already use `execAsync` and are one-token migrations to `execFile`
- FIND-SPRINT-025-13 — `gitDiffManager.ts:490` and `:597` interpolate file paths from `git ls-files --others` — high-severity injection surface for adversarial filenames in untrusted repos
