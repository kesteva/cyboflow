---
id: TASK-647
sprint: SPRINT-024
epic: wire-sprint-005-services
status: done
summary: "Replaced ClaudeCodeManager.sharedDb static injector with constructor DI; removed silent degraded mode (RawEventsSink always created, missing db = TypeError); dropped dead permissionIpcPath constructor parameter (Path B fix from code-review)."
executor_loops: 0
code_review_rounds: 1
visual_mobile: not_applicable
visual_web: not_applicable
---

## Summary

- Constructor DI: `db: Database.Database` now a non-nullable constructor argument; runtime guard throws TypeError on null/undefined.
- Static `sharedDb` field, `setSharedDb` method, and degraded-mode null branch all removed.
- `RawEventsSink` always created in `setupProcessHandlers`; `PipelineTuple.sink` non-nullable.
- Factory threads db: `cliManagerFactory.ts` reads `additionalOptions.db`, throws if missing; `main/index.ts` passes `databaseService.getDb()`.
- Code review caught a follow-up: the original plan added a 4th-position `permissionIpcPath: string | null` parameter that turned out to be dead code (the legacy PTY argv consumer was deleted in SPRINT-008). Applied Path B from review feedback: dropped the parameter entirely; constructor is now 4-arg. `claudeCodeManagerPermissions.test.ts` was deleted (it only exercised the dead parameter — zero real coverage). `TestableClaudeCodeManager` alias also removed (pure indirection after the fix).

Scope expansions logged + resolved: FIND-SPRINT-024-8 (claudeCodeManager.killProcess.test.ts updated for new signature).

## Verifier

APPROVED (both rounds) — all functional ACs met. Visual N/A (pure backend refactor).

## Code review

Round 1: IMPROVEMENTS_NEEDED (1 important: dead `permissionIpcPath` parameter + accompanying no-coverage tests). Path B fix applied; code review cap reached.

## Test-writer

NO_TESTS_NEEDED. All 3 test_strategy.targets covered by the 7 surviving tests (5 wiring incl. TypeError + 2 killProcess).

## Commits

- `291d063 refactor(TASK-647): replace ClaudeCodeManager static sharedDb injector with constructor DI`
- `92ae466 refactor(TASK-647): thread db handle through cliManagerFactory claude factory function`
- `ced4f3e refactor(TASK-647): pass databaseService.getDb() via additionalOptions when creating claude manager`
- `2f853ab refactor(TASK-647): remove setSharedDb call and ClaudeCodeManager import from claudePanel.ts`
- `71f9fff test(TASK-647): update wiring test to pass db as 5th constructor arg, replace degraded-mode test`
- `1af32dd test(TASK-647): add claudeCodeManagerPermissions test with new constructor signature` (later deleted)
- `616a3bb test(TASK-647): update killProcess test to pass db as 5th constructor arg`
- `7b9b774 refactor(TASK-647): drop dead permissionIpcPath parameter from ClaudeCodeManager constructor`
