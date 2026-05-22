---
id: TASK-698
sprint: SPRINT-030
epic: crystal-cuts-and-rebrand
status: done
summary: "Narrow RunGitOptions: remove dead 'buffer' encoding option and Buffer-to-string coercion"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---
# TASK-698 — Done

Removed `encoding?: 'utf8' | 'buffer'` from `RunGitOptions` in `main/src/utils/runGit.ts`. Both `runGit` and `runGitAsync` now pass the literal `'utf8'` to Node's `execFileSync` / `execFile`, returning string directly. The two dead `typeof result === 'string' ? ... : (result as Buffer).toString('utf8')` coercion branches and the `as BufferEncoding` cast are gone.

Pre-flight grep confirmed zero callers pass `encoding: 'buffer'` across `main/src/`. Public surface remains string-returning, so this is backwards-compatible with all existing callers.

Tests: 12/12 `runGit.test.ts`, full main suite passes (TASK-697 fix resolves the one prior flake). `tsc --noEmit` exits 0.

JSDoc now documents the removal rationale and points future Buffer needs at a dedicated `runGitBinary` helper rather than re-introducing polymorphism.
