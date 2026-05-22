---
id: TASK-697
sprint: SPRINT-030
epic: testing-infrastructure
status: done
summary: "Fix intermittent killProcess mid-stream test deadlock via fire-and-forget spawn + microtask-drain helper"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---
# TASK-697 — Done

Rewrote `killProcess mid-stream clears pipelines, sdkRuns, and processes maps` (Case 1 in `main/src/services/panels/claude/__tests__/claudeCodeManager.killProcess.test.ts`) so it no longer awaits `spawnCliProcess` before calling `killProcess`. The previous pattern deadlocked under full-suite load because `spawnCliProcess` internally awaits `iteratorDone`, and the test's mock `query()` parks the iterator on an `AbortController` until aborted — so `await spawnPromise` could never resolve before kill.

New shape: fire-and-forget the spawn, drain microtasks via a bounded `waitForMaps` helper (50-tick loop, `await Promise.resolve()`), assert maps populated, call `killProcess` (which aborts the controller and triggers iteratorDone), then await `spawnPromise` for any spawn-time errors.

File-top comment block references TASK-697 and explains the deadlock so a future reader cannot innocently regress this. Case 2 (no active run, idempotent) is unchanged.

Tests: 587/587 across 3 consecutive full-suite runs. killProcess case completes in ~7-11ms each run (well under the 500ms acceptance bound).
