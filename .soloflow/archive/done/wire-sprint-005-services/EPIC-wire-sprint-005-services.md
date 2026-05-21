---
epic: wire-sprint-005-services
created: 2026-05-13T22:55:00.000Z
status: complete
originating_ideas: [SPRINT-004-005-compound]
---

# Wire SPRINT-005 Services Into Production

## Objective

Connect the six SPRINT-005 stream-parser and state-machine classes
(`MessageProjection`, `CompletionDetector`, `RawEventsSink`,
`ClaudeStreamParser`/`EventRouter`/`TypedEventNarrowing`, `assertTransitionAllowed`,
`transitionToAwaitingReview`/`transitionFromAwaitingReview`) to their first
production callsites in `main/src`. SPRINT-005 delivered the components fully
tested but production-dead; this epic is the critical path that turns that
work into running orchestrator code — and along the way it (a) unblocks the
P0 Claude-panel renderer crash (FIND-SPRINT-005-9) by feeding stored events
through `MessageProjection` before the IPC returns them, and (b) closes the
state-machine guard gap (FIND-SPRINT-005-11) by inserting
`assertTransitionAllowed()` ahead of every workflow_runs status mutation.

## Scope

- **In scope:**
  - `main/src/ipc/session.ts` — wire `MessageProjection` into the
    `panels:get-json-messages` handler so the renderer receives
    `UnifiedMessage[]` instead of raw stream-json (TASK-568 / B1).
  - `main/src/services/cyboflow/transitions.ts` — call
    `assertTransitionAllowed()` at the head of both
    `transitionToAwaitingReview` and `transitionFromAwaitingReview` (TASK-573 / B6).
  - `main/src/services/streamParser/types.ts` (new) — consolidate the six
    per-file logger interfaces into a single shared `ILogger` plus
    `Pick<ILogger, 'warn'>` aliases; update each parser-stage class to consume
    it (TASK-574 / B7).
  - Umbrella tracking plan (TASK-572 / B5) that records the wiring acceptance
    criterion and aggregates B1, B6, B7 plus any follow-on tasks needed to
    attach `ClaudeStreamParser`/`RawEventsSink`/`CompletionDetector` to the
    PTY/child-process surface in `claudeCodeManager.ts`.

- **Out of scope:**
  - The pure-cleanup A-items already scheduled separately (A1–A7).
  - Deletion of `parseClaudeStreamEvent` — that lives in the
    `typed-stream-event-schema` epic (TASK-575 / B8) and only triggers
    *after* this epic's wiring is committed.
  - Renaming or replacing the legacy renderer-side `ClaudeMessageTransformer`
    identity stub. Once the IPC returns `UnifiedMessage[]` directly, that
    stub is dead code, but its deletion is a follow-up sweep, not in scope here.
  - Changes to the workflow-runs DB schema or any new tables — wiring uses
    the schema already delivered in 006_cyboflow_schema.sql.

## Success Signal

```
grep -rn 'MessageProjection\|CompletionDetector\|RawEventsSink\|assertTransitionAllowed\|transitionToAwaitingReview' main/src \
  --include='*.ts' \
  | grep -v __tests__ \
  | grep -v 'streamParser/messageProjection.ts' \
  | grep -v 'streamParser/completionDetector.ts' \
  | grep -v 'streamParser/rawEventsSink.ts' \
  | grep -v 'streamParser/index.ts' \
  | grep -v 'cyboflow/stateMachine.ts' \
  | grep -v 'cyboflow/transitions.ts'
```

returns **at least one production callsite per symbol** (so 5+ matches across at
least 5 different files), and the Claude panel renders a freshly-created
session without throwing `TypeError: Cannot read properties of undefined
(reading 'some')`.
