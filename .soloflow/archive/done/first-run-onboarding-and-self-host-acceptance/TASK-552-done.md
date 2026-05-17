---
id: TASK-552
sprint: SPRINT-013
epic: first-run-onboarding-and-self-host-acceptance
status: done
summary: "Auto-write .cyboflow/worktrees/ to project .gitignore on projects:create handler success; idempotent across leading/trailing-slash forms; errors swallowed so project creation never fails on .gitignore write."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-552 — Auto-Write .cyboflow/worktrees/ to project .gitignore

Delivered:

- `main/src/utils/gitignoreWriter.ts` — `ensureGitignoreEntry(projectPath, entry)` helper. Creates `.gitignore` with `entry + '\n'` if missing; normalizes existing lines (strip leading/trailing `/`, trim) and short-circuits if a match exists; prepends `\n` if the file lacks a trailing newline; entire body wrapped in try/catch that logs to `console.error('[gitignoreWriter]', err)` and never throws.
- `main/src/utils/gitignoreWriter.test.ts` — 8 unit tests covering create-from-scratch, idempotent across three forms (`.cyboflow/worktrees/`, `.cyboflow/worktrees`, `/.cyboflow/worktrees/`), missing-trailing-newline append, no-extra-blank-line, fs.writeFileSync throw → no rethrow, console.error logged with prefix.
- `main/src/ipc/project.ts` — added import; calls `ensureGitignoreEntry(projectData.path, '.cyboflow/worktrees/')` after `databaseService.createProject` success, before the analytics block. Wrapped in defensive try/catch (belt-and-suspenders given the helper's own internal swallow).

Verifier APPROVED with 0 findings. Code-reviewer CLEAN with 0 important/critical findings (one minor categorical nit on commented-`.gitignore`-entry normalization — already documented in plan's "Lowest Confidence Area" as accepted v1 noise). Test-writer: NO_TESTS_NEEDED.
