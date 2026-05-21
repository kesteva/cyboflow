---
id: TASK-678
sprint: SPRINT-027
epic: crystal-cuts-and-rebrand
status: done
summary: "Security: eliminated shell injection in gitDiffManager.ts (lines 490 + 597) by replacing execSync(wc -l)/execSync(cat) with Node-native fs.readFileSync + fs.statSync. Added adversarial-filename regression tests."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: not_applicable
visual_macos: not_applicable
---

# TASK-678 — Done

## What changed
- main/src/services/gitDiffManager.ts:
  - Added `import * as fs from 'node:fs'`
  - Line 490 (wc -l): replaced with fs.readFileSync + `(content.match(/\n/g) || []).length`
  - Line 597 (cat): replaced with fs.statSync (1MB cap) + fs.readFileSync; preserved byte-for-byte diff output
- main/src/services/__tests__/gitDiffManager.test.ts (new):
  - Adversarial `$(touch)` filename injection test (getDiffStats path)
  - Adversarial backtick filename injection test (createDiffForUntrackedFiles path)
  - Happy-path 2-line file test (additions + canonical diff shape)
  - Gated `it.runIf(process.platform !== 'win32')`

## Verification
- Target vitest: 3/3 pass.
- Full main: 551/552 (pre-existing killProcess timeout only).
- Typecheck + lint: pass.

## Out-of-scope for future task
Lines 229, 350, 356, 362, 426, 458, 519 of gitDiffManager.ts still interpolate git refs (commitHash/mainBranch/fromCommit/toCommit) into execSync(`git ...`). Internal-call surface, not user-controlled filenames. Plan defers to TASK-679 (B6, execFile-backed runGit helper).

## Commits
- 5096efc fix(TASK-678): replace shell-injected execSync wc-l/cat with fs.readFileSync
- 3230474 test(TASK-678): add adversarial injection and happy-path tests for GitDiffManager
