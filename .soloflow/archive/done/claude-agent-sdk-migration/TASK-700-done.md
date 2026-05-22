---
id: TASK-700
sprint: SPRINT-030
epic: claude-agent-sdk-migration
status: done
summary: "Hoist StreamEventType to shared; narrow StreamEvent to discriminated union; tighten publisher signature; render run_started Starting placeholder"
executor_loops: 1
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---
# TASK-700 — Done

Closed FIND-SPRINT-026-16 and FIND-SPRINT-026-20. Hoisted `StreamEventType` to `shared/types/claudeStream.ts` with all 9 wire-shape members including the previously-orphaned `run_started`, `session_info`, and `rate_limit_event` discriminants. Re-exported from `frontend/src/utils/cyboflowApi.ts` and replaced the legacy `StreamEvent` interface (with bare `payload: unknown`) with a 9-arm discriminated union over `event.type`.

Tightened `StreamEventPublisher.publish` and `runEventBridge.StreamEnvelope` to type `event.type` as `StreamEventType` (not bare string). Renderer-side, each row component now takes its per-arm narrowed `Extract<StreamEvent, { type: '...' }>` parameter, eliminating all five `as` casts on `event.payload` in `RunView.tsx`. The TASK-696-era local `ExtendedStreamEventType` alias is also deleted (resolves FIND-SPRINT-030-2).

Added a dedicated `RunStartedEventRow` component and `case 'run_started':` arm rendering a "Starting" placeholder card with the truncated runId and branch name — closes the AC#8/TASK-683 path-B intent (50-500ms UI-bootstrap aid). The plan suggested `payload?: undefined` for the new arm; executor opted instead for `payload: RunStartedEvent` matching what `runLauncher.ts` actually emits, so the placeholder carries identifying info rather than being a content-free stub.

Round 2 (executor_loops=1) addressed a verifier-flagged typecheck regression in two consumer test files (`cyboflow-stream-publisher.test.ts` and `cyboflowStore.test.ts`) where inline event literals had inferred `type: string`. Added explicit annotations to keep AC9 (`pnpm typecheck` exits 0) intact. The readonly-vs-AC9 conflict is captured as FIND-SPRINT-030-5 for planner-skill follow-up.

Tests: frontend 279/279, main targeted (runLauncher + runEventBridge + publisher) 47/47, typecheck 0, lint 0 errors.

Follow-up: test-writer added a runId-truncation lock-in test for `RunStartedEventRow`.
Resolved: FIND-SPRINT-030-2.
