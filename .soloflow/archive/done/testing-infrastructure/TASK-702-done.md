---
id: TASK-702
sprint: SPRINT-030
epic: testing-infrastructure
status: done
summary: "Investigate FIND-SPRINT-026-10 runExecutor.test.ts failures; document the production fix with inline + JSDoc traceability"
executor_loops: 0
code_review_rounds: 1
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---
# TASK-702 — Done

Investigated FIND-SPRINT-026-10. The 4 historically-failing test cases in `runExecutor.test.ts` (lifecycle transitions, bridgeEvents source arg integration, source absent, panelId/runId alignment) are now all passing 26/26. The fixes had been applied in prior sprints (commits `715b6c9` and `a5f0a83`); TASK-702 closes the loop by adding traceability documentation so the regression class doesn't re-occur.

## Root-cause classification

| Failure | Verdict | Fix location |
|---|---|---|
| `lifecycle transitions — onLifecycleTransition routes each phase` (`running()` call count) | **Production regression** — `pre_spawn` was a no-op; should call `running()`. Fixed in `715b6c9` (`main/src/orchestrator/runExecutor.ts` `case 'pre_spawn'`). | runExecutor.ts |
| `RunExecutor.bridgeEvents — source arg integration` (`running()` once vs twice) | **Test-assertion drift** — assertion stale after the `pre_spawn` production fix; updated in `a5f0a83`. | runExecutor.test.ts |
| `source absent: bridgeEvents short-circuits; running() is not called` | **Test-assertion drift** — same cause; assertion updated in `a5f0a83`. | runExecutor.test.ts |
| `panelId/runId alignment — bridge drops output event when panelId has run- prefix` | **Test-assertion drift** — same cause; assertion updated in `a5f0a83`. | runExecutor.test.ts |

## Documentation changes

- Added FIND-SPRINT-026-10 traceability comment to the `case 'pre_spawn':` arm of `onLifecycleTransition`, explaining the regression contract.
- Code-review round 1 flagged that the JSDoc routing table immediately above the method was stale (still listed `pre_spawn` as no-op). Round 1 updated the table to match actual routing: `pre_spawn` → primary `running()` path, `sdk_initialized` → defensive idempotency fallback, `post_spawn` → no-op.

Tests: `pnpm --filter main test` 593/593, `pnpm --filter frontend test` 277/277, typecheck 0. Per-file `runExecutor.test.ts` 26/26.

Follow-up: FIND-SPRINT-030-4 captures a pre-existing schema-parity bug (`verify:schema` script fails with `no such column: permission_mode`) surfaced during AC#5 verification; out of scope for TASK-702 since the script and schema files are not in `files_owned` and the failure pre-dates this sprint.
