---
id: TASK-671
sprint: SPRINT-027
epic: testing-infrastructure
status: done
summary: "Repaired four stale call-count assertions in runExecutor.test.ts to match production where pre_spawn + sdk_initialized both route to lifecycleTransitions.running()."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
visual_macos: not_applicable
---

# TASK-671 — Done

## What changed
- main/src/orchestrator/__tests__/runExecutor.test.ts — updated four running() call-count assertions and inline comments to reflect production routing where both pre_spawn and sdk_initialized arms of onLifecycleTransition invoke lifecycleTransitions.running() (idempotent by design).

## Diagnosis vs plan
The plan hypothesized spy-state bleed and recommended vi.restoreAllMocks(). The executor diagnosed the real root cause: the four assertions had been written against a pre-TASK-644 production routing that has since added the pre_spawn -> running() arm. The plan's "Lowest Confidence Area" clause explicitly authorized re-diagnosis.

## Environment note
better-sqlite3 was compiled against Node 23.x (NODE_MODULE_VERSION 136) but local Node is 22.15.1 (NODE_MODULE_VERSION 127). pnpm rebuild better-sqlite3 restored it. Prerequisite for running the test suite at all; relates to TASK-687's BLOCKING_PREREQ check.

## Verification
- vitest target: 26/26 pass.
- vitest full: 536 pass; 2 pre-existing failures (cyboflowSchema.test.ts, claudeCodeManager.killProcess.test.ts) on base SHA 8a5c413, unrelated to TASK-671.
- git diff scope: single file (the test file).

## Commit
- a5f0a83 fix(TASK-671): update running() call-count assertions to match pre_spawn behavior
