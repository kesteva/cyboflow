---
id: TASK-634
sprint: SPRINT-024
epic: testing-infrastructure
status: done
summary: "Migrated 2 remaining mkdtempSync leak sites (gitignoreWriter.test.ts, workflowRegistry.test.ts) to withTempDir, completing the TASK-605 sweep."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

## Summary

Replaced `mkdtempSync` calls in `main/src/utils/gitignoreWriter.test.ts` and `main/src/orchestrator/__tests__/workflowRegistry.test.ts` with the canonical `withTempDir` helper. Also migrated two additional describe blocks in `workflowRegistry.test.ts` (`resolveSoloFlowPluginRoot`, `DEFAULT_SOLOFLOW_WORKFLOWS`) that had inline `mkdtempSync` calls so the AC `grep` returns 0 matches.

## Verifier

APPROVED — all four ACs met. Pre-existing failures in `runExecutor.test.ts` and `cyboflowSchema.test.ts` confirmed to also fail on HEAD~1; logged as FIND-SPRINT-024-1 / FIND-SPRINT-024-2.

## Code review

CLEAN. One pre-existing dual `path` import noted as FIND-SPRINT-024-3 (not blocking).

## Test-writer

NO_TESTS_NEEDED. Pure refactor, behavior unchanged; existing assertions remain the regression guard.

## Commits

- `5c08a56 refactor(TASK-634): migrate mkdtempSync leak sites to withTempDir`
