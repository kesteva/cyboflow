---
id: TASK-640
sprint: SPRINT-018
epic: orchestrator-and-trpc-router
status: done
summary: "RunExecutor adapter with ClaudeSpawnerLike interface and four protected extension hooks; RunLauncher.launch wired with fire-and-forget enqueue via RunQueueRegistry."
executor_loops: 0
code_review_rounds: 1
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-640 — Done

Created `main/src/orchestrator/runExecutor.ts` with the `RunExecutor` class
(public `execute(runId)`, narrow `ClaudeSpawnerLike` / `WorkflowRegistryLike`
interfaces, four protected extension hooks: `getPrompt`, `bridgeEvents`,
`buildOptionsOverrides`, `onLifecycleTransition`). The default `getPrompt`
throws `NOT_IMPLEMENTED: getPrompt — TASK-641 must override`. The class
preserves the standalone-typecheck invariant (no `electron`,
`better-sqlite3`, or `services/*` runtime imports).

Extended `main/src/orchestrator/runLauncher.ts` with two new optional
constructor params (10th: `runExecutor?: RunExecutor`, 11th:
`runQueueRegistry?: RunQueueRegistry`) and a fire-and-forget enqueue in
`launch()` placed after the existing `publisher?.publish('run_started')`
call. The enqueue uses `void queue.add(async () => { try { await
executor.execute(runId); } catch (err) { logger.error(...) } })` — `void`
prefix and inner try/catch are load-bearing.

Code-review fix-up (round 1) reordered `bridgeEvents()` to run BEFORE
`spawnCliProcess()` in `execute()`, matching the documented order and
eliminating the race where SDK-initialization events could fire before
listeners are registered.

Tests: 10 new cases in `main/src/orchestrator/__tests__/runExecutor.test.ts`
(missing rows, NOT_IMPLEMENTED sentinel, panelId/sessionId synthesis,
enqueue ordering vs publish, fire-and-forget, error swallow,
backward-compat shape, bridgeEvents-before-spawnCliProcess ordering
regression). All 18 existing runLauncher tests pass unmodified. Full main
suite: 353 tests / 37 files pass. Typecheck and lint clean.
