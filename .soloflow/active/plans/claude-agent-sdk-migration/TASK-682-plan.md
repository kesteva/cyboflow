---
id: TASK-682
idea: IDEA-014
status: ready
created: 2026-05-20T00:00:00Z
files_owned:
  - frontend/src/utils/cyboflowApi.ts
  - frontend/src/components/cyboflow/RunView.tsx
  - frontend/src/components/cyboflow/__tests__/RunView.test.tsx
files_readonly:
  - shared/types/claudeStream.ts
  - frontend/src/stores/cyboflowStore.ts
  - main/src/orchestrator/runEventBridge.ts
  - main/src/services/streamParser/derivers.ts
  - frontend/src/stores/__tests__/cyboflowStore.test.ts
acceptance_criteria:
  - criterion: "StreamEvent.type in frontend/src/utils/cyboflowApi.ts is a typed discriminator union covering the five SDK variants plus the catch-all, not a bare `string`."
    verification: "grep -nE \"^\\s*type:\\s*string;\" frontend/src/utils/cyboflowApi.ts returns 0 matches inside the StreamEvent interface body (verify by reading lines 28-33). The new union must include each of: 'system', 'assistant', 'user', 'result', 'stream_event', 'unknown'."
  - criterion: "RunView no longer renders events via a single whole-event JSON.stringify catch-all."
    verification: "grep -n \"JSON.stringify(event\" frontend/src/components/cyboflow/RunView.tsx returns 0 matches. (Per-branch JSON.stringify of a sub-field like a tool_use input is permitted; the prohibition is on stringifying the whole event envelope.)"
  - criterion: "RunView contains explicit render branches for each of the five SDK discriminators ('system', 'assistant', 'user', 'result', 'stream_event') plus the 'unknown' fallback, each producing a non-stringified DOM subtree."
    verification: "grep -nE \"case ['\\\"](system|assistant|user|result|stream_event|unknown)['\\\"]:\" frontend/src/components/cyboflow/RunView.tsx returns at least 6 matches (one per discriminator)."
  - criterion: "RunView.test.tsx asserts each discriminator routes to its dedicated branch and no longer asserts a JSON-blob render path."
    verification: "grep -n \"JSON blob\" frontend/src/components/cyboflow/__tests__/RunView.test.tsx returns 0 matches. The test file must contain assertions for at least all five SDK discriminators by render output (text content distinct from a pretty-printed JSON dump)."
  - criterion: "Typecheck, lint, and the frontend test suite all pass."
    verification: "Run: `pnpm typecheck && pnpm lint && pnpm --filter frontend test`. All three commands exit 0."
  - criterion: "cyboflowStore subscription contract is unchanged (no edits to cyboflowStore.ts or its tests)."
    verification: "git diff --name-only HEAD returns no entries under frontend/src/stores/. The store and its test file are not in files_owned."
depends_on: [TASK-681]
estimated_complexity: low
epic: claude-agent-sdk-migration
test_strategy:
  needed: true
  justification: "RunView.test.tsx is in files_owned and a sibling test exists. The behavior changes from a single JSON-blob render path to six typed render branches — each branch needs a distinct render assertion. Existing tests for the No active run placeholder, runId header, Waiting for events, and the no-subscription invariant must remain green; the JSON blob test (line 84) must be rewritten and four new discriminator tests added."
  targets:
    - behavior: "system/init event renders a typed system-init view (showing model, cwd, session_id) — not a JSON blob."
      test_file: "frontend/src/components/cyboflow/__tests__/RunView.test.tsx"
      type: component
    - behavior: "assistant event renders the assistant message text (and tool_use blocks if present) via the typed branch."
      test_file: "frontend/src/components/cyboflow/__tests__/RunView.test.tsx"
      type: component
    - behavior: "user event renders tool_result content via the typed branch."
      test_file: "frontend/src/components/cyboflow/__tests__/RunView.test.tsx"
      type: component
    - behavior: "result event renders the terminal subtype, num_turns, and total_cost_usd via the typed branch."
      test_file: "frontend/src/components/cyboflow/__tests__/RunView.test.tsx"
      type: component
    - behavior: "stream_event event renders a compact one-line summary via the typed branch (not a JSON blob)."
      test_file: "frontend/src/components/cyboflow/__tests__/RunView.test.tsx"
      type: component
    - behavior: "Unrecognized event type falls through to the 'unknown' branch and is rendered with a visible warning indicator (not silently)."
      test_file: "frontend/src/components/cyboflow/__tests__/RunView.test.tsx"
      type: component
    - behavior: "Existing invariants survive: 'No active run' placeholder, runId header, 'Waiting for events…', and subscription is NOT managed by RunView."
      test_file: "frontend/src/components/cyboflow/__tests__/RunView.test.tsx"
      type: component
---

# Replace 'unknown' stream-event tag with SDK discriminator handling in renderer

## Objective

The renderer currently types `StreamEvent.type` as a bare `string` (`frontend/src/utils/cyboflowApi.ts:30`) and `RunView.tsx:46-53` renders every event as a `JSON.stringify(event, null, 2)` blob inside a single `<pre>` tag. As a result, post-SDK-migration runs display a raw JSON dump instead of typed Claude output. This task narrows `StreamEvent.type` to the SDK discriminator union sourced from `shared/types/claudeStream.ts` (`'system' | 'assistant' | 'user' | 'result' | 'stream_event' | 'unknown'`) and replaces RunView's single-blob renderer with a `switch (event.type)` dispatch that routes each discriminator to a small, dedicated typed-rendering branch. The IPC channel name, payload shape, store subscription contract, and runEventBridge envelope are all left untouched — this is a renderer-only typing + UI change.

## Implementation Steps

1. **Open `frontend/src/utils/cyboflowApi.ts`** and replace the `StreamEvent` interface (lines 28-33) so `type` becomes a typed union. The new shape is:

   ```ts
   /**
    * Discriminator values emitted by main/src/services/streamParser/derivers.ts:deriveEventType.
    * The five SDK-shaped values mirror shared/types/claudeStream.ts ClaudeStreamEvent.type.
    * 'unknown' is the catch-all produced when the main-process narrower cannot classify an event.
    */
   export type StreamEventType =
     | 'system'
     | 'assistant'
     | 'user'
     | 'result'
     | 'stream_event'
     | 'unknown';

   export interface StreamEvent {
     runId: string;
     type: StreamEventType;
     payload: unknown;
     timestamp: string;
   }
   ```

   Leave `payload` as `unknown` — RunView is the boundary that narrows it per-branch. Export `StreamEventType` so RunView can import it. Do NOT touch `subscribeToStreamEvents`, `listWorkflows`, `startRun`, or `approveRun`.

2. **Open `frontend/src/components/cyboflow/RunView.tsx`** and replace the single-`<pre>` map (lines 46-53) with a per-event dispatch. Keep the surrounding container, the `activeRunId` guard, the "Waiting for events…" placeholder, the `bottomRef` auto-scroll, and the runId header unchanged.

   Add a small `renderEvent(event: StreamEvent)` helper near the top of the file body (before `export function RunView`). Skeleton:

   ```ts
   import type { StreamEvent, StreamEventType } from '../../utils/cyboflowApi';
   import type {
     SystemInitEvent,
     AssistantEvent,
     UserEvent,
     ResultEvent,
     StreamEvent as ClaudeStreamEventVariant,
   } from '../../../../shared/types/claudeStream';

   function renderEvent(event: StreamEvent): JSX.Element {
     switch (event.type) {
       case 'system':       return <SystemEventRow event={event} />;
       case 'assistant':    return <AssistantEventRow event={event} />;
       case 'user':         return <UserEventRow event={event} />;
       case 'result':       return <ResultEventRow event={event} />;
       case 'stream_event': return <StreamEventRow event={event} />;
       case 'unknown':      return <UnknownEventRow event={event} />;
     }
   }
   ```

   Each `*Row` is a small inline component in the same file that consumes `event.payload`, narrows it via a typed cast against the corresponding `shared/types/claudeStream.ts` type, and renders a non-stringified view:

   - **`SystemEventRow`** — narrows `payload` to `SystemInitEvent | SystemApiRetryEvent | SystemCompactEvent | SystemCompactBoundaryEvent` via the nested `subtype`. For `init`, render `model`, `cwd`, short `session_id` as labeled spans. For other subtypes, render a one-line summary (`api_retry: attempt N/M`, `compact: <summary>`, `compact_boundary: trigger=<…>`).
   - **`AssistantEventRow`** — narrows `payload` to `AssistantEvent`. Iterate `payload.message.content`: render `TextBlock.text` in a `<p>`, `ToolUseBlock` as `<div>` with `name` and a `<pre>` for the input (this is the only place a sub-field `JSON.stringify` is allowed; format with `JSON.stringify(block.input, null, 2)`), `ThinkingBlock` as a dim `<details>`. Tag with assistant-pink border per existing color scheme guidance — use existing tailwind tokens already in the file (`text-text-primary`, `border-border-primary`, `bg-bg-secondary`).
   - **`UserEventRow`** — narrows to `UserEvent`. Iterate `payload.message.content` (each a `ToolResultBlock`): render `tool_use_id` short hash + the `content` string (or joined `{ text }` array). Indicate `is_error: true` with a red badge.
   - **`ResultEventRow`** — narrows to `ResultEvent`. Render `subtype`, `num_turns`, `duration_ms`, `total_cost_usd` (formatted to 4dp USD if present) as a single key-value row.
   - **`StreamEventRow`** — narrows to `ClaudeStreamEventVariant` (the SDK partial-message wire variant — note the local rename to avoid colliding with the renderer's own `StreamEvent` type). Render a one-line compact summary: `<inner event.type> idx=<event.index>` and, for `content_block_delta` with `delta.text`, append the delta text inline. Do NOT JSON-stringify the envelope.
   - **`UnknownEventRow`** — render a yellow/amber warning row with the literal text "Unrecognized event" plus the raw `event.type` value. Inside a collapsed `<details>` show the `payload` rendered via a sub-field stringify (`JSON.stringify(event.payload, null, 2)`) — this is the only place stringification of a meaningful payload happens, and it is gated behind the user explicitly expanding the details block. Crucially this branch must NOT call `JSON.stringify(event, …)` on the whole envelope.

   Update the JSX to call `{streamEvents.map((event, idx) => <div key={idx}>{renderEvent(event)}</div>)}` and delete the `<pre>{JSON.stringify(event, null, 2)}</pre>` block at line 47-52.

3. **Open `frontend/src/components/cyboflow/__tests__/RunView.test.tsx`** and update the suite:

   - Rewrite the docstring header (lines 1-17): replace the "Renders stream events from the store as JSON blobs" bullet with "Renders each SDK discriminator (system / assistant / user / result / stream_event / unknown) through its dedicated typed branch (not a JSON blob)."
   - Replace the existing `it('renders stream events from the store as JSON blobs', …)` test (lines 84-105) with six new tests, one per discriminator. Suggested shape for the `system/init` case:

     ```ts
     it('routes a system/init event to the typed system branch', () => {
       act(() => { useCyboflowStore.getState().setActiveRun('run-1'); });
       const event: StreamEvent = {
         runId: 'run-1',
         type: 'system',
         payload: {
           type: 'system',
           subtype: 'init',
           session_id: 'sess-xyz',
           cwd: '/tmp/wt',
           model: 'claude-sonnet-4-5',
           tools: [],
           mcp_servers: [],
           permissionMode: 'default',
         },
         timestamp: '2026-05-20T00:00:00Z',
       };
       act(() => { useCyboflowStore.getState().appendStreamEvent(event); });
       render(<RunView />);
       expect(screen.getByText(/claude-sonnet-4-5/)).toBeInTheDocument();
       expect(screen.getByText(/\/tmp\/wt/)).toBeInTheDocument();
       // Must NOT be a whole-event JSON dump — the runId string should appear in the
       // header (rendered by RunView itself) but not as the payload's session_id sibling
       // wrapped in {} braces from JSON.stringify.
       expect(screen.queryByText(/"session_id"/)).not.toBeInTheDocument();
     });
     ```

     Repeat the pattern for `assistant` (assert visible assistant text content from `TextBlock`), `user` (assert tool_result content visible), `result` (assert subtype + num_turns visible), `stream_event` (assert one-line summary visible, not JSON), and `unknown` (assert "Unrecognized event" string visible and the raw payload is NOT rendered un-collapsed). Use payloads that match the corresponding `shared/types/claudeStream.ts` variant shapes.
   - Keep the four existing invariant tests (`No active run` placeholder, runId header, Waiting for events, subscription-not-managed-by-RunView) unchanged.
   - Update the mock object literal at lines 27-35 if needed (no changes expected — the `subscribeToStreamEvents`/`cyboflowApi` mock surface is identical).

4. **Run the verification gates locally** (and inline in your COMPLETED report):

   ```bash
   pnpm typecheck
   pnpm lint
   pnpm --filter frontend test
   ```

   All three must exit 0. If `pnpm typecheck` complains that a payload narrowing cast is unsafe, prefer a small `isAssistantPayload(payload): payload is AssistantEvent` user-defined type guard over `as` casts where reasonable; use `as` only for the leaf branch shape.

5. **Self-check the AC greps** before reporting COMPLETED:

   ```bash
   grep -nE "^\s*type:\s*string;" frontend/src/utils/cyboflowApi.ts   # must return 0 inside StreamEvent body
   grep -n "JSON.stringify(event" frontend/src/components/cyboflow/RunView.tsx   # must return 0
   grep -nE "case ['\"]system['\"]:|case ['\"]assistant['\"]:|case ['\"]user['\"]:|case ['\"]result['\"]:|case ['\"]stream_event['\"]:|case ['\"]unknown['\"]:" frontend/src/components/cyboflow/RunView.tsx   # must return 6 distinct matches
   grep -n "JSON blob" frontend/src/components/cyboflow/__tests__/RunView.test.tsx   # must return 0
   ```

## Acceptance Criteria

1. `StreamEvent.type` is a typed `StreamEventType` union (six variants: `system | assistant | user | result | stream_event | unknown`), not `string`. Pass = `cyboflowApi.ts` exports `StreamEventType` and `StreamEvent.type: StreamEventType`. Fail = `type: string` survives.
2. `RunView.tsx` contains no `JSON.stringify(event` whole-envelope call. Pass = grep returns 0 matches for that exact substring. Fail = the existing `JSON.stringify(event, null, 2)` blob, or any equivalent whole-envelope stringification, remains.
3. `RunView.tsx` switch-dispatches every event by `event.type` across all six discriminators with non-stringified typed renderers. Pass = at least one `case '<discriminator>':` per the six values exists in the file.
4. `RunView.test.tsx` no longer references "JSON blob" and has explicit assertions for each of the six discriminators that rely on rendered text content distinct from a JSON.stringify dump. Pass = grep "JSON blob" returns 0; six new render-branch tests are present.
5. `pnpm typecheck`, `pnpm lint`, and `pnpm --filter frontend test` all exit 0.
6. cyboflowStore.ts and `frontend/src/stores/__tests__/cyboflowStore.test.ts` are not modified by this task. Pass = `git diff --name-only` shows no entries under `frontend/src/stores/`.

## Test Strategy

Tests are required because the rendering behavior is the load-bearing observable change. The seven test targets enumerated in `test_strategy.targets` cover (a) each new discriminator branch with a representative payload shaped per `shared/types/claudeStream.ts`, (b) the negative assertion that whole-event JSON dumps are gone, and (c) the four invariants preserved from the prior suite (placeholder, header, waiting state, no-subscription-in-component). Tests live in the same file the existing suite occupies — `frontend/src/components/cyboflow/__tests__/RunView.test.tsx` — and reuse the existing `vi.mock('../../../utils/cyboflowApi', ...)` setup at lines 27-35 with no changes (the API surface is unchanged; only the `StreamEvent.type` field's TypeScript type narrows, and the mock's `vi.fn()` returns are structurally compatible).

No mocking of `shared/types/claudeStream.ts` types is needed — they are TypeScript-only. The test payloads are plain object literals that satisfy the type checker.

## Hardest Decision

Where to put the per-branch render components — inline in `RunView.tsx` vs. a sibling `RunViewRows/` directory. Chose inline because each branch is ~5-15 lines and inline keeps the file self-contained, mirrors the existing single-file convention, and avoids a directory restructure that would balloon `files_owned`. If branches grow beyond ~30 lines apiece in a follow-up task, splitting to `RunView/` with one file per discriminator becomes the natural refactor — but doing it now is premature.

The secondary hard choice is whether to introduce runtime type guards (`isAssistantPayload`) vs. trust the main-process narrower (`runEventBridge` already runs `TypedEventNarrowing.narrow` before publishing). Chose to trust the narrower for the five SDK variants and treat the `'unknown'` branch as the catch-all for any narrowing failure that does slip through — this matches the existing `deriveEventType` contract in `main/src/services/streamParser/derivers.ts:20-25` where `'unknown'` is explicitly the value emitted when the parser cannot classify. Runtime guards in the renderer would duplicate work and add friction without changing the failure mode (a malformed `assistant` payload would crash inside the branch with or without a guard).

## Rejected Alternatives

- **Importing `ClaudeStreamEvent` directly into `cyboflowApi.ts` and typing `payload: ClaudeStreamEvent`.** Rejected because the renderer must tolerate the `'unknown'` value that the narrower emits when the payload doesn't match any SDK variant — `ClaudeStreamEvent` does include `UnknownStreamEvent` with `kind: '__unknown__'`, but the envelope's `type` discriminator (set by `deriveEventType`) collapses that to the string `'unknown'` while the payload itself may carry arbitrary shape. Decoupling — `StreamEvent.type: StreamEventType` + `StreamEvent.payload: unknown` narrowed per branch in RunView — is more honest about that boundary. Would change my mind if a future task aligns `deriveEventType` and `ClaudeStreamEvent` such that the renderer can rely on payload shape without a runtime escape hatch.

- **Adding Zod runtime validation in the renderer before dispatch.** Rejected because the typed-event-narrowing layer in the main process is the single source of truth for runtime validation (EPIC scope §3, "schemas.ts stays typed-narrow (no Zod runtime validation needed for in-process events)"). Duplicating Zod in the renderer is the kind of plumbing the SDK migration is explicitly removing.

- **Keeping the JSON-blob fallback as a hidden dev-only feature toggle.** Rejected because the IDEA's manual visual verification step requires the right pane to show typed output, not raw JSON, and a hidden toggle would mask regression detection. The `'unknown'` branch already provides a debug escape hatch (collapsed `<details>` with payload-level stringify).

## Lowest Confidence Area

The `stream_event` (partial-message) branch's compact summary format. The IDEA mentions "live token stream" but this task does NOT implement live-typing UI — that's a polish concern. The chosen rendering ("compact one-line summary") may produce a noisy log when partial messages are dense; the test will pass because it asserts only the absence of a JSON blob and the presence of the inner event type, not visual UX. If user testing in TASK-683 reveals the `stream_event` log dominates the right pane, a follow-up task should collapse partial-message events into a single coalesced row that mutates as new deltas arrive — explicitly out of scope here.

The second area of uncertainty: whether `payload` arriving at the renderer matches `shared/types/claudeStream.ts` shapes verbatim, or whether the narrower silently re-shapes fields. I read `runEventBridge.ts` and confirmed it forwards `typed` (the output of `narrowing.narrow(p.data)`) directly to the publisher envelope as `payload`. If TASK-681's narrowing logic deviates from the literal SDK wire shape (e.g. by adding a synthetic field), the per-branch render code may need a small adapter. This is the area most likely to surface a fix during TASK-683's integration verify.
