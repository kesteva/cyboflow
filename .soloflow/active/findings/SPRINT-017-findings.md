---
sprint: SPRINT-017
pending_count: 2
last_updated: "2026-05-18T21:00:00.000Z"
---
# Findings Queue

SPRINT-017 started with missing infra: docker; tests deferred.

## FIND-SPRINT-017-1
- **source:** TASK-611 (executor)
- **type:** claude-md
- **severity:** low
- **status:** open
- **location:** frontend/src/components/ReviewQueueView.tsx:9
- **description:** Local interface IPCResponse<T> declared at line 9. CLAUDE.md forbids this — callers must import from frontend/src/utils/api.ts instead. The declaration pre-dates TASK-611 and was not introduced by it.
- **suggested_action:** Replace the local IPCResponse declaration with an import from frontend/src/utils/api.ts and add explicit type parameter to the invoke call.
- **resolved_by:** 

## FIND-SPRINT-017-2
- **source:** TASK-586 (code-reviewer)
- **type:** anti-pattern
- **severity:** medium
- **status:** open
- **location:** main/src/orchestrator/Orchestrator.ts:58
- **description:** `Orchestrator.start()` constructs `StuckDetector` with `emitter: new EventEmitter()` — a fresh, inline-constructed emitter that is never stored on `this`, never exposed via a getter, and never returned. Combined with `private detector?: StuckDetector` and `StuckDetector.emitter` being a `private readonly` field with no accessor, this means every `runs:stuck` event emitted by `StuckDetector.transitionRunsToStuck()` (stuckDetector.ts:282) is unreachable by any subscriber outside the test harness. This is functionally equivalent to a `void` sink — the per-component emitter pattern documented in ARCHITECTURE.md §Orchestrator says "callers subscribe directly", but no caller can subscribe to *this* emitter because it has no public reference. The decision to drop the shared `eventBus` was correct (path b in the TASK-586 plan); the implementation choice of an *inline-anonymous* emitter, however, recreates the same "did anyone wire this?" failure mode that motivated the drop — except now the symptom is invisible until a subscriber is added. The TASK-586 plan's "Hardest Decision" section anticipated this: "When the first real consumer needs cross-producer event aggregation, that consumer's plan will design the bus." That consumer's plan will need to add either (a) an `emitter` getter on `Orchestrator`, (b) an `emitter` getter on `StuckDetector` plus exposing `detector` on `Orchestrator`, or (c) accept `emitter` as an optional `OrchestratorDeps` field so the caller owns the lifecycle.
- **suggested_action:** When the first `runs:stuck` consumer task lands (likely in the stream-parser-to-main or admin-UI epic), add an `Orchestrator.onStuck(listener)` method (or expose `stuckEmitter: EventEmitter` as a read-only getter) so subscription paths are part of the public surface. Until then, leave the inline emitter — it correctly isolates the dead-event surface from the renderer and matches the "no speculative wiring" decision. This finding is a forward-looking reminder, not a blocker for TASK-586.
- **resolved_by:** 
