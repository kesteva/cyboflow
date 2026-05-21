---
id: TASK-696
idea: IDEA-021
status: in-flight
created: "2026-05-20T23:55:00Z"
files_owned:
  - shared/types/claudeStream.ts
  - main/src/services/streamParser/schemas.ts
  - main/src/services/streamParser/__tests__/schemas.test.ts
  - main/src/services/streamParser/__tests__/sdkMockFactories.ts
  - frontend/src/components/cyboflow/RunView.tsx
  - frontend/src/components/cyboflow/__tests__/RunView.test.tsx
  - RunView.test.tsx
  - RunView.tsx
files_readonly:
  - main/src/services/panels/claude/claudeCodeManager.ts
  - main/src/services/streamParser/typedEventNarrowing.ts
  - main/src/services/streamParser/types.ts
  - main/src/services/streamParser/derivers.ts
  - frontend/src/utils/cyboflowApi.ts
acceptance_criteria:
  - criterion: claudeStream.ts exports five new typed variants and includes each in the ClaudeStreamEvent union.
    verification: "grep -nE 'export (interface|type) (SessionInfoEvent|RateLimitEvent|SystemHookStartedEvent|SystemHookResponseEvent|SystemStatusEvent)' shared/types/claudeStream.ts returns 5 lines"
  - criterion: schemas.ts defines five new Zod schemas using .passthrough() and incorporates them into claudeStreamEventSchema.
    verification: "grep -nE 'sessionInfoSchema|rateLimitEventSchema|systemHookStartedSchema|systemHookResponseSchema|systemStatusSchema' main/src/services/streamParser/schemas.ts returns ≥10 lines"
  - criterion: Five new factory functions exported from sdkMockFactories.ts.
    verification: "grep -nE 'export function (sessionInfo|rateLimitEvent|systemHookStarted|systemHookResponse|systemStatus)\\b' main/src/services/streamParser/__tests__/sdkMockFactories.ts returns 5 lines"
  - criterion: schemas.test.ts includes parse tests for all five new variants asserting narrow() returns the typed variant (not __unknown__).
    verification: "grep -nE \"describe\\((['\\\"])(SessionInfoEvent|RateLimitEvent|SystemHookStartedEvent|SystemHookResponseEvent|SystemStatusEvent)\\\\1\" main/src/services/streamParser/__tests__/schemas.test.ts returns 5 lines"
  - criterion: Exhaustive-switch test extended to handle session_info and rate_limit_event; assertNever still type-checks.
    verification: "grep -nE \"case '(session_info|rate_limit_event)':\" main/src/services/streamParser/__tests__/schemas.test.ts returns 2 lines; pnpm --filter main exec tsc --noEmit exits 0"
  - criterion: "RunView.tsx includes typed branches for session_info and rate_limit_event; SystemEventRow handles hook_started, hook_response, status. None routes to UnknownEventRow."
    verification: "grep -nE \"case '(session_info|rate_limit_event)':\" frontend/src/components/cyboflow/RunView.tsx returns 2 lines; grep -nE \"payload.subtype === '(hook_started|hook_response|status)'\" RunView.tsx returns 3 lines"
  - criterion: RunView.test.tsx includes one rendering test per new variant. Each asserts a key field is visible AND queryByText(/Unrecognized event/) is absent.
    verification: "grep -nE \"it\\((['\\\"])routes a (session_info|rate_limit_event|system/hook_started|system/hook_response|system/status)\" RunView.test.tsx returns 5 lines"
  - criterion: "pnpm typecheck, pnpm lint, pnpm --filter main test streamParser all exit 0."
    verification: Run all three; each exits 0
  - criterion: "Manual visual verification: workflow run shows no orange 'Unrecognized event' cards for the 5 shapes; session_info renders as 'Run started' header card."
    verification: "Author runs pnpm dev, captures screenshot showing typed rendering"
depends_on: []
estimated_complexity: medium
epic: typed-stream-event-schema
test_strategy:
  needed: true
  justification: "Schema additions need Zod parse tests so new factories don't silently degrade to __unknown__. RunView additions need rendering tests so new branches don't regress to UnknownEventRow. Both sibling test files exist and own the patterns used."
  targets:
    - behavior: Each new factory output narrows to its typed variant via TypedEventNarrowing.narrow()
      test_file: main/src/services/streamParser/__tests__/schemas.test.ts
      type: unit
    - behavior: Exhaustive-switch helper covers session_info + rate_limit_event; assertNever compiles
      test_file: main/src/services/streamParser/__tests__/schemas.test.ts
      type: unit
    - behavior: RunView.tsx routes 5 new shapes to typed rows (NOT UnknownEventRow)
      test_file: frontend/src/components/cyboflow/__tests__/RunView.test.tsx
      type: component
---
# Extend ClaudeStreamEvent union with session_info, rate_limit_event, and three system subtypes

## Objective

Five event shapes — orchestrator-synthetic `session_info`, SDK `rate_limit_event`, and SDK `system/{hook_started, hook_response, status}` — currently render in `RunView` as the orange "Unrecognized event" fallback. This task extends the locked `ClaudeStreamEvent` discriminated union and matching Zod schema with these five variants, ships dedicated RunView row renderers for each, and adds matching parse + render tests. The `unknown` catch-all stays as the permanent drift safety net.

## Implementation Steps

1. **Ground the SDK shapes (read-only).** Open `node_modules/.pnpm/@anthropic-ai+claude-agent-sdk@0.2.141_zod@3.25.76/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` and confirm:
   - `SDKRateLimitEvent`: `{ type: 'rate_limit_event'; rate_limit_info: SDKRateLimitInfo; uuid: UUID; session_id: string }`. **Note: `status`, `resetsAt`, `overageStatus` are nested inside `rate_limit_info`, NOT direct fields on the event (IDEA description is wrong on this).**
   - `SDKRateLimitInfo`: `{ status: 'allowed' | 'allowed_warning' | 'rejected'; resetsAt?: number; rateLimitType?: ...; utilization?: number; overageStatus?: ...; overageResetsAt?: number; overageDisabledReason?: ...; isUsingOverage?: boolean; surpassedThreshold?: number }`.
   - `SDKHookStartedMessage`: `{ type: 'system'; subtype: 'hook_started'; hook_id: string; hook_name: string; hook_event: string; uuid: UUID; session_id: string }`.
   - `SDKHookResponseMessage`: `{ type: 'system'; subtype: 'hook_response'; hook_id; hook_name; hook_event; output: string; stdout: string; stderr: string; exit_code?: number; outcome: 'success' | 'error' | 'cancelled'; uuid; session_id }`. **Note: outcome enum is `success | error | cancelled`, NOT `allow | deny | defer` (IDEA description is wrong).**
   - `SDKStatusMessage`: `{ type: 'system'; subtype: 'status'; status: 'compacting' | 'requesting' | null; permissionMode?: PermissionMode; compact_result?: 'success' | 'failed'; compact_error?: string; uuid; session_id }`.
   - For `session_info`: read `claudeCodeManager.ts` lines 251-260 — emitted shape is `{ type: 'session_info'; initial_prompt: string; claude_command: string; worktree_path: string; model: string; permission_mode: string; timestamp: string }`.

2. **Extend `shared/types/claudeStream.ts`.** Add five exported interfaces:
   - `SessionInfoEvent` — top-level discriminant `type: 'session_info'`; the 7 fields from claudeCodeManager.ts:251.
   - `RateLimitEvent` — top-level discriminant `type: 'rate_limit_event'`; nested `rate_limit_info` with literal-union types matching sdk.d.ts.
   - `SystemHookStartedEvent` — `{ type: 'system'; subtype: 'hook_started'; ... }`.
   - `SystemHookResponseEvent` — `{ type: 'system'; subtype: 'hook_response'; ...; outcome: 'success' | 'error' | 'cancelled' }`.
   - `SystemStatusEvent` — `{ type: 'system'; subtype: 'status'; status: 'compacting' | 'requesting' | null; ... }`.

   Append all five to the `ClaudeStreamEvent` union (before `UnknownStreamEvent`). Update JSDoc to mention the new subtypes.

3. **Extend `main/src/services/streamParser/schemas.ts`.** Add five Zod schemas with `.passthrough()`:
   - `sessionInfoSchema` and `rateLimitEventSchema` go into the top-level `claudeStreamEventSchema = z.union([...])`.
   - `systemHookStartedSchema`, `systemHookResponseSchema`, `systemStatusSchema` go into the inner `systemUnionSchema = z.discriminatedUnion('subtype', [...])`.

   The bottom `_typeCheck` drift bridge catches any TS↔Zod mismatch at compile time.

4. **Extend `sdkMockFactories.ts`.** Five new exported factory functions returning fully-typed values:
   - `sessionInfo()` — values: `initial_prompt: 'Refactor parser to use the typed event helper.'`, `worktree_path: '/tmp/cyboflow-worktree-abc123'`, `model: 'claude-sonnet-4-5'`, `permission_mode: 'approve'`, etc.
   - `rateLimitEvent()` — `rate_limit_info: { status: 'allowed_warning', resetsAt: 1747776000, rateLimitType: 'five_hour', utilization: 0.85 }`.
   - `systemHookStarted()`, `systemHookResponse()` (outcome: 'success'), `systemStatus()` (status: 'requesting').

5. **Extend `schemas.test.ts`:**
   - Five new `describe` blocks (one per variant) asserting factory output narrows via `narrower.narrow(raw)` to expected typed variant (not `__unknown__`).
   - Extend the `summarize()` helper inside `describe('exhaustive union coverage', ...)`: add `case 'session_info'` and `case 'rate_limit_event'`. (No new system subtype cases needed — the existing `case 'system': return \`system/${event.subtype}\`` covers hook_*/status automatically.)
   - Extend the `fixtures` array with five new pairs.

6. **Extend `RunView.tsx`:**
   - Import the 5 new types from `'../../../../shared/types/claudeStream'`.
   - In `SystemEventRow`, add three new subtype branches after `compact_boundary`: `hook_started` (small collapsed row), `hook_response` (color-coded outcome), `status` (collapsed row with status + permissionMode + compact_result).
   - Widen `SystemEventRow`'s `payload` cast union.
   - Add new `SessionInfoEventRow` component: top-anchored card (emerald/blue left-border) showing worktree_path, model, permission_mode, truncated initial_prompt. Header "Run started".
   - Add new `RateLimitEventRow` component: yellow/warning row showing status, resetsAt (formatted), overageStatus.
   - Update `renderEvent`'s `switch (event.type)`: add `case 'session_info'` and `case 'rate_limit_event'`.
   - **Local-widened type workaround for `cyboflowApi.ts` (readonly).** `StreamEventType` in cyboflowApi.ts doesn't include the new discriminators. Resolution: declare local `type ExtendedStreamEventType = StreamEventType | 'session_info' | 'rate_limit_event'` at the top of `RunView.tsx` and assert `event.type as ExtendedStreamEventType` before the switch. Add a `// TODO(IDEA-021 follow-up): widen StreamEventType in cyboflowApi.ts in a sibling task` comment.

7. **Extend `RunView.test.tsx`.** Five new `it(...)` tests after the existing `system/compact_boundary` test, following the same pattern (set active run, append stream event, render, assert key field visible AND `screen.queryByText(/Unrecognized event/)` NOT in document):
   - `session_info` test asserts "Run started" header + worktree path + model.
   - `rate_limit_event` test asserts status text visible.
   - `system/hook_started` test asserts "system/hook_started" + hook_name.
   - `system/hook_response` test asserts "system/hook_response" + outcome.
   - `system/status` test asserts "system/status" + status value.

   For session_info and rate_limit_event tests, cast `type` field: `type: 'session_info' as StreamEvent['type']` because current `StreamEventType` doesn't include them.

8. **Type-check and run tests.** `pnpm typecheck`, `pnpm lint`, `pnpm --filter main test streamParser`, `pnpm --filter frontend test RunView`. All exit 0.

9. **Visual verification.** `pnpm dev`. Start workflow run. Confirm: `session_info` renders as "Run started" card at top; `rate_limit_event` (if emitted) renders distinctly yellow; `system/hook_*` and `system/status` render as collapsed rows. No orange Unrecognized cards for the 5 shapes. Capture screenshot as evidence.

## Acceptance Criteria

See frontmatter.

## Test Strategy

**Schema parse tests** (schemas.test.ts) — 5 new describe blocks asserting narrow() returns typed variant. Extend exhaustive `summarize()` with 2 new case arms; existing `case 'system'` auto-covers the 3 new subtypes. Extend `fixtures` array.

**Component rendering tests** (RunView.test.tsx) — 5 new `it(...)` tests. Mocking patterns already in place (`vi.mock` for cyboflowApi, jsdom stub for scrollIntoView). No new test files needed.

## Hardest Decision

**Inheriting the `cyboflowApi.ts` `StreamEventType` constraint without owning that file.** The skeleton designates cyboflowApi.ts as read-only. Adding `'session_info'` / `'rate_limit_event'` to RunView's switch won't type-check against the existing union. Alternatives: (1) re-claim cyboflowApi.ts as files_owned — rejected, violates decomposer boundary and canonical widening place is alongside backend `derivers.ts`; (2) cast at switch site with local widened type — **selected**, smallest local change, ships with TODO for follow-up; (3) filter at backend so neither shape reaches renderer with those discriminators — rejected, defeats the rendering goal.

## Rejected Alternatives

- **Hand-author payloads (per IDEA description).** Reading sdk.d.ts revealed IDEA has at least two inaccuracies (rate_limit_event nested-vs-flat fields, hook_response outcome enum). Sdk.d.ts is source of truth.
- **Move session_info filtering to orchestrator** (open-question candidate 2). Rejected — would leave RunView without the run-metadata header.
- **On-disk `__fixtures__/*.json` files.** Rejected — convention since TASK-594 is inline factories; introducing disk fixtures re-introduces a pattern TASK-594 explicitly removed.
- **Subdivide `systemUnionSchema` with nested discriminated unions per subtype.** Existing flat `discriminatedUnion('subtype', [...])` handles 5+ branches cleanly.

## Lowest Confidence Area

**Whether `RateLimitEvent`'s wire shape arrives renderer-side with nested `rate_limit_info` intact.** The orchestrator pipeline (`RawEventsSink` → publisher envelope → `StreamEvent.payload`) may transform or flatten the SDK shape. Not fully traced from query() iterator through EventRouter through IPC envelope through subscribeToStreamEvents through useCyboflowStore.streamEvents through RunView.payload. If pipeline flattens, schema and renderer need to match flattened shape. Mitigation: `.passthrough()` + visual verification catches mismatch as a `__unknown__` fallback.

Secondary: `session_info` shape — read claudeCodeManager.ts:251-260 directly so should be exact, but if orchestrator adds a field without updating the type, `.passthrough()` preserves it but the typed interface lags.
