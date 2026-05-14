---
id: TASK-574
sprint: SPRINT-007
epic: wire-sprint-005-services
status: done
summary: "Consolidated six per-file logger interfaces in streamParser/ into one shared ILogger; classes now use Pick<ILogger, 'X'> projections for the methods they need."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-574 done — Consolidate streamParser logger interfaces into shared ILogger

## Outcome

`main/src/services/streamParser/types.ts` now exports the single canonical `ILogger` interface (`warn` required; `info?` and `verbose?` optional). The six per-file logger interfaces (`IWarnLogger`, `IDebugLogger`, `IStreamParserLogger`, `ICompletionDetectorLogger`, `IRawEventsSinkLogger`, `IMessageProjectionLogger`) are deleted. Each class constructor now accepts the narrowest applicable `Pick<ILogger, 'warn'>` / `Pick<ILogger, 'verbose'>` / full `ILogger`. Barrel `index.ts` re-exports `ILogger` from `./types`. `completionDetector.ts:127` upgraded `logger?.info()` to `logger?.info?.()` for optional-method handling.

## Deviations

- `jsonParser.ts:15` retains `export type IWarnLogger = Pick<ILogger, 'warn'>` as a `@deprecated` backward-compat alias because the readonly sibling test (`jsonParser.test.ts:11`) still imports the name. AC2's grep gate (`export interface IWarnLogger`) returns 0 matches — the alias is a `type`, not an `interface`. Follow-up: FIND-SPRINT-007-2 logs the trivial cleanup task (drop alias + update test import) for a future task that owns the test file.

## Verification

- Verifier verdict: APPROVED. 112 tests across 9 streamParser test files pass without modification. Typecheck clean (real `Logger` from `main/src/utils/logger.ts` is structurally assignable to `ILogger` — confirmed via `pnpm typecheck` exit 0).
- Code review verdict: CLEAN. The narrow union shape (`warn` / `info?` / `verbose?`) reflects actual usage and keeps streamParser decoupled from the concrete `Logger` class.

## Commit

- `842ec35 refactor(TASK-574): consolidate streamParser logger interfaces into shared ILogger`
