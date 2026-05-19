---
id: TASK-664
sprint: SPRINT-022
epic: orchestrator-and-trpc-router
status: done
summary: "Add skipPersistence flag to BridgeEventsOptions; RunExecutor wires it on so CCM owns raw_events persistence — prevents the double-INSERT regression that TASK-663 would otherwise have introduced."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-664 — Done

## Summary

Resolved the dual raw_events persistence pipeline that would otherwise INSERT twice once TASK-663's panelId fix lets bridge events through. Added `skipPersistence?: boolean` to `BridgeEventsOptions`; `RunExecutor.bridgeEvents()` passes `true` so the bridge attaches listener + publishes envelopes + fires onFirstMessage without constructing its own EventRouter/RawEventsSink. ClaudeCodeManager.runSdkQuery retains exclusive ownership of `raw_events` persistence.

## Changes

- **runEventBridge.ts** — `BridgeEventsOptions` gains `skipPersistence?: boolean` with full JSDoc. Router/sink construction is now conditional (null when true). `router.emitForRun(...)` guarded by `if (router)`. `sink.dispose(...)` guarded by `if (sink)`.
- **runExecutor.ts** — default `bridgeEvents()` override passes `skipPersistence: true` with multi-line comment referencing FIND-SPRINT-021-5 and the CCM-owned pipeline.
- **__tests__/runEventBridge.test.ts** — new `describe('skipPersistence')` block: 5 unit tests (skip construction with throwing-stub db, onFirstMessage still fires, zero rows in real DB, legacy behaviour preserved, dispose idempotent) plus the `dual-pipeline single-INSERT guarantee` integration test.
- **__tests__/runExecutor.test.ts** — TASK-663 source-arg integration test now wires CCM-style EventRouter+RawEventsSink alongside the bridge and tightens to `countRows === 1` (cross-task interlock).

## Commits

- `3699240 feat(TASK-664): add skipPersistence to BridgeEventsOptions; wire in RunExecutor`
- `aa79b67 test(TASK-664): add skipPersistence unit tests and dual-pipeline integration test`

## Verifier

APPROVED (473/473 tests; typecheck clean; lint 0 errors). visual_* = not_applicable (backend-only).

## Code Review

CLEAN (one minor doc-drift category note, not actionable).
