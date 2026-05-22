---
id: TASK-696
sprint: SPRINT-030
epic: typed-stream-event-schema
status: done
summary: "Extend ClaudeStreamEvent union with session_info, rate_limit_event, and three system subtypes (hook_started, hook_response, status)"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---
# TASK-696 — Done

Five new typed variants added end-to-end:
- `SessionInfoEvent`, `RateLimitEvent`, `SystemHookStartedEvent`, `SystemHookResponseEvent`, `SystemStatusEvent` exported from `shared/types/claudeStream.ts` and appended to the `ClaudeStreamEvent` union.
- Matching Zod schemas with `.passthrough()` added to `main/src/services/streamParser/schemas.ts` (top-level union for `session_info` / `rate_limit_event`; inner `systemUnionSchema` for the three system subtypes). The `_typeCheck` drift bridge continues to compile.
- 5 new factory functions in `sdkMockFactories.ts`; 5 new parse-and-narrow `describe` blocks + 2 new `case` arms in the exhaustive `summarize()` switch in `schemas.test.ts`.
- `RunView.tsx` gains `SessionInfoEventRow`, `RateLimitEventRow`, and three new `SystemEventRow` subtype branches; local `ExtendedStreamEventType` widens past read-only `cyboflowApi.ts` with a TODO follow-up comment.
- 5 new rendering tests in `RunView.test.tsx`; test-writer added 4 additional branch-coverage tests (rejected rate-limit status, null status display, error outcome color, prompt truncation at 120 chars).

Tests: streamParser 69/69, RunView 24/24. `tsc --noEmit` and `pnpm lint` green.

Deferred (visual): manual `pnpm dev` workflow run to confirm no orange "Unrecognized event" cards for the 5 shapes — queued via verifier.

Follow-up: FIND-SPRINT-030-2 captures the sibling task to widen `StreamEventType` in `cyboflowApi.ts` once tRPC routers land.
