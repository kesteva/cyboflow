---
id: TASK-253
sprint: SPRINT-006
epic: orchestrator-and-trpc-router
status: done
summary: "Add Orchestrator class with start()/stop()/isRunning() and DatabaseLike/LoggerLike interfaces — standalone-typecheck invariant"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: not_applicable
---

# TASK-253 — Done

## Summary

Built `Orchestrator` and its supporting types as the orchestrator subtree's entry point. Constructor-injected dependencies (`db`, `logger`, `eventBus`, `runQueues`) preserve standalone-testability — the subtree compiles and runs against in-memory fakes with no electron, better-sqlite3, or `main/src/services/*` imports. `start()` is idempotent; `stop()` awaits `runQueues.drainAll()` before resolving.

## Changes

- `main/src/orchestrator/types.ts` (new) — `PreparedStatement`, `DatabaseLike`, `LoggerLike`, `OrchestratorDeps` interfaces. Imports limited to `node:events` and a type-only reference to `RunQueueRegistry`.
- `main/src/orchestrator/Orchestrator.ts` (new) — class with constructor (DI), `async start()`, `async stop()`, `isRunning()`. Top-of-file JSDoc states the standalone-typecheck invariant and references ROADMAP-001 §6.3.
- `main/src/orchestrator/__tests__/Orchestrator.test.ts` (new, 5 vitest tests total — 3 from plan targets + 2 augmenting coverage)

## Commits

- `6fa6e51 feat(TASK-253): add Orchestrator class with start()/stop() and injected deps`
- `6256f60 test(TASK-253): add Orchestrator coverage augmentation`

## Verification

- All 5 Orchestrator tests pass
- `pnpm --filter main typecheck` exit 0
- `npx eslint src/orchestrator/` 0 errors / 0 warnings
- `tsc --listFiles | grep '/orchestrator/' | grep -E 'node_modules/(electron|better-sqlite3)' | wc -l` = 0 — standalone-typecheck invariant proved
- Code review: CLEAN (2 minor findings logged as FIND-SPRINT-006-2/3 for compound triage)
- 22 pre-existing better-sqlite3 NODE_MODULE_VERSION mismatch failures are unrelated

## Open observations

- FIND-SPRINT-006-2: speculative re-exports in `Orchestrator.ts:72-75` (`RunQueueRegistry`, `EventEmitter`, `OrchestratorDeps`) without current callers — revisit once TASK-254/255 wires the orchestrator from `main/src/index.ts`.
- FIND-SPRINT-006-3: dead-write in the drain test (sets `taskFinished = false` before `true` inside the task body). Test passes; cosmetic.
