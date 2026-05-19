---
id: TASK-642
sprint: SPRINT-018
epic: orchestrator-and-trpc-router
status: done
summary: "runEventBridge module bridges ClaudeCodeManager 'output' events to RawEventsSink + StreamEventPublisher with synchronous narrow→INSERT→publish ordering and fail-soft semantics."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-642 — Done

Added `main/src/orchestrator/runEventBridge.ts` exporting
`bridgeEvents({ runId, source, publisher, db, logger?, router?, sink?,
narrowing? })`. Listener filters `source.on('output')` by `panelId ===
runId && type === 'json'`, narrows via `TypedEventNarrowing`, then runs
`router.emitForRun(runId, typed)` → `publisher.publish(runId, { type,
payload, timestamp })` synchronously. INSERT-failure fail-soft is
preserved by the sink's internal try/catch; publish-failure fail-soft is
preserved by the bridge's outer try/catch. `dispose()` is idempotent;
removes the listener and disposes the sink.

Tests: 9 integration cases in
`main/src/orchestrator/__tests__/runEventBridge.test.ts` covering all 8
plan AC paths (happy/order/INSERT-fail/panelId-filter/non-json-filter/
envelope/unknown-mapping/dispose) plus a 9th case for publish-failure
fail-soft. Hygiene pass removed an unused TypedEventNarrowing import and
unused `unknownEvent` fixture. Full main workspace typecheck clean.

`deriveEnvelopeType` duplicates `deriveEventType` in
`rawEventsSink.ts:38-44`; queued as FIND-SPRINT-018-3 for compound.
