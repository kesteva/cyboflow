---
id: TASK-730
sprint: SPRINT-033
epic: typed-stream-event-schema
status: done
summary: "Converge ClaudeCodeManager.runSdkQuery onto TypedEventNarrowing"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-730 — Done

Closed the load-bearing validation gap at `main/src/services/panels/claude/claudeCodeManager.ts`. `runSdkQuery` no longer raw-casts SDK events with `as unknown as ClaudeStreamEvent` before reaching `router.emitForRun`. Instead, the manager owns a `private readonly narrowing: TypedEventNarrowing` field, and every SDK event flows through `this.narrowing.narrow(event)` (the same pattern already used in `runEventBridge.ts:209`). The narrower is fail-soft — returns `{ kind: '__unknown__', raw }` on Zod failure — so it cannot break the SDK iterator loop.

Deliberately preserved: `this.emit('output', { data: event, ... })` continues to forward the raw SDK payload, NOT the narrowed value. `runEventBridge.ts:209` runs its own narrowing on that payload; double-narrowing would create `{ kind: '__unknown__', raw: { kind: '__unknown__', raw: ... } }` envelopes.

Constructor signature unchanged — `cliManagerFactory.ts:191` and both ClaudeCodeManager test files remain binary-compatible. Old 4-line JSDoc justifying the cast deleted.

Test added in `claudeCodeManagerWiring.test.ts` under `describe('TypedEventNarrowing convergence (TASK-730)', ...)`:
- Malformed event (`{ type: 'completely_unknown_variant_xyz' }`) → persisted `raw_events.payload_json` contains `{ "kind": "__unknown__" }`.
- Happy-path event (`{ type: 'result', subtype: 'success', is_error, duration_ms, num_turns }`) → persisted `payload_json` contains `{ "type": "result" }` and no `__unknown__`.

SDK mock refactored to use `vi.hoisted({ sdkYields })` so individual tests can override the yielded sequence. Added a `createTestDbNoFk()` test helper to insert `raw_events` without the FK chain.

Closes FIND-SPRINT-032-2.

Commits:
- d5ed811 feat: converge ClaudeCodeManager.runSdkQuery onto TypedEventNarrowing
- 976a89b test: add TypedEventNarrowing convergence tests
