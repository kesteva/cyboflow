---
id: TASK-629
sprint: SPRINT-023
epic: crystal-cuts-and-rebrand
status: done
summary: "Extract formatConsoleArgs to deduplicate 5 console-override formatters in index.ts"
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-629 Done

Added `formatConsoleArgs(args: unknown[]): string` to `main/src/utils/devDebugLog.ts` — handles strings, Error instances (with stack), plain objects (JSON.stringify with 2-space indent), circular structures (try/catch fallback), and null/undefined via `String()`. Collapsed 5 inline formatters in `main/src/index.ts` console.{log,error,warn,info,debug} overrides to call the helper (strict improvement: `console.log` now uses the full Error+circular path). Error-instance extraction preserved on `console.error` and `console.warn`.

## Commits
- 5a79375 feat(TASK-629): extract formatConsoleArgs to deduplicate 5 console-override formatters

## Verification
- Tests: 12 devDebugLog tests pass
- Typecheck/lint: clean
- Verifier: APPROVED
- Code-reviewer: CLEAN
