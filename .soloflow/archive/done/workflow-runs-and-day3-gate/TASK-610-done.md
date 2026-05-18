---
id: TASK-610
sprint: SPRINT-016
epic: workflow-runs-and-day3-gate
status: done
summary: "makeLoggerLike forwards optional context via JSON.stringify ternary — restores structured log fields lost by the original shim"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-610 Done

## Outcome

`makeLoggerLike` in `main/src/ipc/cyboflow.ts` previously dropped the optional `context` second argument on every level. Each forwarder now uses an inline ternary that JSON-stringifies and appends the context when present, falling back to the bare message otherwise. The non-Logger fallback branch was already correct and remains untouched. The fix is bounded to the `makeLoggerLike` body; the `Logger` class signature is unchanged.

## Verification

- Verifier verdict: APPROVED. Typecheck PASS; test failures in the worktree confined to pre-existing better-sqlite3 NODE_MODULE_VERSION mismatch unrelated to this change.
- Code review verdict: CLEAN (0 findings).
- Test writer: NO_TESTS_NEEDED — `makeLoggerLike` is private and unexported; the Logger-backed branch requires constructing a real `Logger` fixture (disproportionate cost for a 4-line ternary). The non-Logger fallback branch is already exercised by every existing `cyboflow.test.ts` case.
