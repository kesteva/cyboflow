---
id: TASK-776
idea: SPRINT-039-followups
status: ready
created: 2026-05-26T00:00:00Z
files_owned:
  - frontend/src/components/cyboflow/RunChatView.tsx
  - frontend/src/components/cyboflow/__tests__/RunChatView.test.tsx
files_readonly:
  - shared/types/chatMessage.ts
  - shared/types/claudeStream.ts
  - frontend/src/utils/cyboflowApi.ts
  - main/src/orchestrator/runMessagesListing.ts
  - .soloflow/active/findings/SPRINT-039-findings.md
acceptance_criteria:
  - criterion: "RunChatView.mergedTimeline deduplicates historical + live overlap. Specifically: any StreamEvent of type 'assistant' whose `payload.message.id` matches a historicalMessages entry's `id` is dropped from the live arm before concatenation. For 'user' StreamEvents (which carry no stable id), live events whose `timestamp` is ≤ the latest historicalMessages entry's `createdAt` are dropped."
    verification: "grep -n 'historicalIds\\|historicalIdSet\\|latestHistoricalAt\\|dedup\\|Deduplicate' frontend/src/components/cyboflow/RunChatView.tsx returns ≥1 match in the `mergedTimeline` useMemo body (currently lines 242-253). The grep is restricted to RunChatView.tsx."
  - criterion: "When a historicalMessage with id='msg-001' AND a live assistant StreamEvent with payload.message.id='msg-001' are both present, the chat view renders the message ONCE (not twice)."
    verification: "New vitest test 'deduplicates assistant message overlap between historicalMessages and streamEvents' renders the view with both feeds populated for the same message id, then asserts `screen.getAllByText('Hello duplicated')` returns an array of length 1."
  - criterion: "When a live user StreamEvent's timestamp is strictly later than the latest historicalMessage.createdAt, that user event still renders (the timestamp filter is non-inclusive of historical bounds in the post-overlap direction)."
    verification: "New vitest test 'renders a post-history user event that arrives after the latest historicalMessage' asserts the post-history user-bubble content is visible."
  - criterion: "When historicalMessages is empty, all live events render (the dedup pass is a no-op on empty history)."
    verification: "Existing tests in RunChatView.test.tsx that render with empty historical state and only streamEvents continue to pass; the existing test 'renders assistant text content wrapped in markdown-preview class' (line 189) covers this directly."
  - criterion: "Test count increase ≥ 2 over the pre-task baseline in RunChatView.test.tsx."
    verification: "`pnpm --filter frontend test -- RunChatView.test.tsx --reporter=verbose` shows ≥2 more `passed` assertions than the pre-task baseline; the new dedup test names appear in the listing."
  - criterion: "Frontend typecheck and lint clean; all frontend tests pass."
    verification: "pnpm --filter frontend typecheck exits 0; pnpm --filter frontend lint exits 0; pnpm --filter frontend test exits 0."
depends_on: []
estimated_complexity: medium
epic: per-run-chat-surface
test_strategy:
  needed: true
  justification: "Behavioral bug that produces visible UX duplication; without a dedup test the regression is silent until a user notices double bubbles. Two new tests lock in (a) assistant id-based dedup and (b) user timestamp-based dedup."
  targets:
    - behavior: "Assistant StreamEvents whose payload.message.id matches a historicalMessage.id are dropped from the live arm"
      test_file: "frontend/src/components/cyboflow/__tests__/RunChatView.test.tsx"
      type: component
    - behavior: "User StreamEvents whose timestamp ≤ latest historicalMessage.createdAt are dropped from the live arm"
      test_file: "frontend/src/components/cyboflow/__tests__/RunChatView.test.tsx"
      type: component
    - behavior: "Post-history live user events still render (filter is strict-less-than, not less-or-equal in the rendering direction)"
      test_file: "frontend/src/components/cyboflow/__tests__/RunChatView.test.tsx"
      type: component
    - behavior: "Existing render-empty-history tests still pass (dedup is a no-op on empty history)"
      test_file: "frontend/src/components/cyboflow/__tests__/RunChatView.test.tsx"
      type: component
---

# TASK-776 — Deduplicate overlapping historical + live events in RunChatView.mergedTimeline

## Objective

Close FIND-SPRINT-039-11: `RunChatView.tsx` lines 242-253 (`mergedTimeline` useMemo) concatenates `historicalMessages` with `streamEvents.filter(e => e.runId === runId)` with no dedup. Any event that arrives between `setActiveRun(runId)` (which begins accumulating streamEvents) and the `cyboflow.runs.listMessages` query resolution (which populates historicalMessages) appears in BOTH arrays — rendering twice in the chat view. Since the overlap window is non-empty on every Chat-tab open for an actively-streaming run, duplicate bubbles are the expected steady-state UX, not an edge case. Add an id-based dedup pass for assistant events (both feeds expose stable `payload.message.id` / `ChatMessage.id`) and a timestamp-based filter for user events (which carry no stable id), so live events overlapping with history are dropped from the live arm.

## Implementation Steps

1. **Probe the current rendering shape.** The historical feed is `ChatMessage[]` with `id: string`, `role: 'user' | 'assistant'`, `createdAt: string` (ISO-8601). The live feed is `StreamEvent[]` where assistant events expose `payload.message.id: string` (per `shared/types/claudeStream.ts:144`) and user events expose `payload.message.content: ToolResultBlock[]` (no stable id at the message level, only per-block `tool_use_id`). Both feeds have `timestamp: string`. The `selectRunMessages` helper at `main/src/orchestrator/runMessagesListing.ts:147` extracts `id` from the SDK's `payload.message.id` when present, falling back to the raw_events autoincrement row id stringified — so assistant id-based correlation between the two feeds is reliable.

2. **Replace the `mergedTimeline` useMemo body** in `frontend/src/components/cyboflow/RunChatView.tsx` (currently lines 242-253). Current code:
   ```tsx
   const mergedTimeline = useMemo<TimelineItem[]>(() => {
     const historicalItems: TimelineItem[] = historicalMessages.map((message) => ({
       kind: 'historical',
       message,
     }));

     const liveItems: TimelineItem[] = streamEvents
       .filter((e) => e.runId === runId)
       .map((event) => ({ kind: 'live', event }));

     return [...historicalItems, ...liveItems];
   }, [historicalMessages, streamEvents, runId]);
   ```
   New code:
   ```tsx
   const mergedTimeline = useMemo<TimelineItem[]>(() => {
     const historicalItems: TimelineItem[] = historicalMessages.map((message) => ({
       kind: 'historical',
       message,
     }));

     // ---- Deduplicate live overlap with history ----
     // Both feeds derive from raw_events. Any live event that arrived between
     // setActiveRun (which begins streamEvents accumulation) and the
     // listMessages query resolution (which populates historicalMessages)
     // appears in BOTH arrays. Drop the live duplicates so each message
     // renders exactly once.
     //
     // Assistant events: dedup by payload.message.id ↔ historicalMessage.id
     //   (selectRunMessages extracts the same id from payload.message.id).
     // User events: no stable id at the message level — fall back to
     //   timestamp filter (drop user events whose timestamp ≤ the latest
     //   historicalMessage.createdAt).

     const historicalAssistantIds = new Set<string>(
       historicalMessages
         .filter((m) => m.role === 'assistant')
         .map((m) => m.id),
     );

     // Latest historical createdAt — used to gate user events. Empty history
     // produces a sentinel that lets everything through (since '' < any ISO).
     const latestHistoricalCreatedAt = historicalMessages.length === 0
       ? ''
       : historicalMessages
           .map((m) => m.createdAt)
           .reduce((a, b) => (a > b ? a : b));

     const liveItems: TimelineItem[] = streamEvents
       .filter((e) => e.runId === runId)
       .filter((e) => {
         if (e.type === 'assistant') {
           const msgId = e.payload.message?.id;
           if (typeof msgId === 'string' && historicalAssistantIds.has(msgId)) {
             return false; // dedup: already in history
           }
           return true;
         }
         if (e.type === 'user') {
           // User events carry no stable message id — gate by timestamp.
           // Strict-less-or-equal: a live event at exactly the same ISO
           // string as the latest historical entry is treated as part of
           // the historical batch (drop it).
           return e.timestamp > latestHistoricalCreatedAt;
         }
         // Other event types (system, result, stream_event, ...) are not
         // rendered by renderTimelineItem anyway; pass them through so
         // future renderer additions are not silently filtered.
         return true;
       })
       .map((event) => ({ kind: 'live', event }));

     return [...historicalItems, ...liveItems];
   }, [historicalMessages, streamEvents, runId]);
   ```

3. **Add a comment block above the useMemo** noting the dedup contract so future contributors do not strip it:
   ```tsx
   // mergedTimeline — historical messages (from listMessages query) merged
   // with live stream events (from cyboflowStore.streamEvents). Both feeds
   // derive from raw_events; the dedup pass below removes the overlap that
   // accumulates between setActiveRun and the listMessages resolution.
   // See FIND-SPRINT-039-11 for the original bug report.
   ```

4. **Add the new tests to `frontend/src/components/cyboflow/__tests__/RunChatView.test.tsx`**. Place them adjacent to the existing "AC3" tests (currently around line 189). The tests need to import `ChatMessage` from `shared/types/chatMessage` and seed the listMessages mock to return a populated array:
   ```tsx
   import type { ChatMessage } from '../../../../../shared/types/chatMessage';

   // ... inside describe('RunChatView', () => { ... }):

   it('deduplicates assistant message overlap between historicalMessages and streamEvents', async () => {
     const historicalMessage: ChatMessage = {
       id: 'msg-dup-001',
       runId: 'run-1',
       role: 'assistant',
       text: 'Hello duplicated',
       createdAt: '2026-05-26T00:00:00.000Z',
     };
     mockListMessages.mockImplementationOnce(async () => [historicalMessage]);

     act(() => {
       useCyboflowStore.getState().setActiveRun('run-1');
       // Live event with the SAME payload.message.id as the historical row
       useCyboflowStore.getState().appendStreamEvent({
         runId: 'run-1',
         type: 'assistant',
         payload: {
           type: 'assistant',
           message: {
             id: 'msg-dup-001',                       // same id ⇒ dedup
             model: 'claude-sonnet',
             role: 'assistant',
             content: [{ type: 'text', text: 'Hello duplicated' }],
           },
         },
         timestamp: '2026-05-26T00:00:01.000Z',
       });
     });

     render(<RunChatView runId="run-1" />);

     await waitFor(() => {
       // EXACTLY ONE rendering of the duplicated text
       expect(screen.getAllByText('Hello duplicated')).toHaveLength(1);
     });
   });

   it('renders a post-history user event that arrives after the latest historicalMessage.createdAt', async () => {
     const historicalMessage: ChatMessage = {
       id: 'msg-hist-001',
       runId: 'run-2',
       role: 'assistant',
       text: 'Historical only',
       createdAt: '2026-05-26T00:00:00.000Z',
     };
     mockListMessages.mockImplementationOnce(async () => [historicalMessage]);

     act(() => {
       useCyboflowStore.getState().setActiveRun('run-2');
       // Live user event with timestamp STRICTLY AFTER the historical createdAt
       useCyboflowStore.getState().appendStreamEvent({
         runId: 'run-2',
         type: 'user',
         payload: {
           type: 'user',
           message: {
             role: 'user',
             content: [
               { type: 'tool_result', tool_use_id: 'toolu-z', content: 'Post-history result', is_error: false },
             ],
           },
         },
         timestamp: '2026-05-26T00:00:05.000Z',  // strictly after historical
       });
     });

     render(<RunChatView runId="run-2" />);

     await waitFor(() => {
       expect(screen.getByText('Historical only')).toBeInTheDocument();
       expect(screen.getByText(/Post-history result/)).toBeInTheDocument();
     });
   });
   ```

5. **Run the completeness gate**:
   ```bash
   pnpm --filter frontend test -- RunChatView.test.tsx
   pnpm --filter frontend test
   pnpm --filter frontend typecheck
   pnpm --filter frontend lint
   ```
   All exit 0. The two new tests must pass; the 9 existing RunChatView tests must continue to pass.

## Acceptance Criteria

1. `grep -n 'historicalAssistantIds\|latestHistoricalCreatedAt\|Deduplicate' frontend/src/components/cyboflow/RunChatView.tsx` returns ≥3 matches inside the `mergedTimeline` useMemo body.
2. Test "deduplicates assistant message overlap between historicalMessages and streamEvents" passes: with both feeds containing a message with id `'msg-dup-001'`, `screen.getAllByText('Hello duplicated')` returns an array of length 1.
3. Test "renders a post-history user event that arrives after the latest historicalMessage" passes: both the historical text and the post-history user event content are visible.
4. `pnpm --filter frontend test -- RunChatView.test.tsx` exits 0; new test count ≥ 2 above baseline.
5. `pnpm --filter frontend test`, `pnpm --filter frontend typecheck`, `pnpm --filter frontend lint` all exit 0.

## Test Strategy

Two new `it()` blocks added inside `describe('RunChatView', ...)`:
1. **Assistant dedup:** seed a historical message and a streamEvent with the SAME id; assert single render.
2. **Post-history user passthrough:** seed a historical message and a user streamEvent timestamped AFTER the historical createdAt; assert both visible.

The existing test "renders assistant text content wrapped in markdown-preview class" (line 189) implicitly covers the no-history empty-dedup case (`mockListMessages` returns `[]` by default). The existing tests rely on the dedup pass being a no-op when `historicalMessages` is empty — `historicalAssistantIds` is an empty Set, `latestHistoricalCreatedAt` is the empty string, and the timestamp filter `e.timestamp > ''` is true for any ISO timestamp.

## Hardest Decision

User events have no stable message-level id at any layer. The SDK's `UserEvent.payload.message` shape (lines 170-184 of shared/types/claudeStream.ts) defines `role: 'user'` and `content: ToolResultBlock[]` only — no `id`. `selectRunMessages` (main/src/orchestrator/runMessagesListing.ts) extracts user-message id from the autoincrement raw_events row id stringified, which is not visible to the renderer at the StreamEvent layer. Two options:
1. **(a) Timestamp filter:** drop live user events with `timestamp ≤ latestHistoricalCreatedAt`. Simple, no wire-shape change, works correctly for the dominant overlap pattern (live events that arrive during the listMessages query window) but suffers a known edge case: a user event with the exact same timestamp string as the latest historical entry is dropped even if it is logically distinct (rare in ISO ms precision, but possible).
2. **(b) Wire-shape change:** add a raw_events row id field to UserEvent payload at the IPC layer so the renderer can dedup by id. Requires touching main/src/services/panels/claude/* (IPC envelope construction) and shared/types/claudeStream.ts (wire shape).

Picked **(a)** because: (1) it ships now with no IPC-shape coordination; (2) the timestamp-collision edge case is genuinely rare (ms-precision ISO + RTC clock); (3) FIND-SPRINT-039-11 's suggested action explicitly endorses this fallback ("OR (simpler) only mix in streamEvents whose timestamp postdates the latest historicalMessages.createdAt"). If post-launch user reports reveal real timestamp collisions, option (b) can land later as a stricter id-based dedup for both event types.

## Rejected Alternatives

- **Option (b) above — extend UserEvent with a raw_events row id field.** Rejected for the reasons listed in Hardest Decision; reconsider if real-user reports surface timestamp collisions or if listMessages itself starts returning user rows that overlap with live in a way the timestamp gate cannot resolve.
- **Drop dedup entirely and accept duplicate bubbles.** Rejected: FIND-SPRINT-039-11 explicitly notes that overlap is steady-state, not edge-case. UX cost is permanent until fixed.
- **Filter historicalMessages by `< setActiveRun timestamp` instead of filtering live by `> latestHistorical`.** Rejected: requires tracking the setActiveRun timestamp in cyboflowStore, an extra coupling. The latest-historical timestamp is already available from the local data.
- **Use a Maps-based dedup with `(role, text)` as a composite key.** Rejected: text content matching is fragile (streaming partials may produce intermediate strings that don't match the final). Id-based correlation for assistants is reliable; timestamp filter for users is sufficient.

## Lowest Confidence Area

Whether the timestamp comparison `e.timestamp > latestHistoricalCreatedAt` works correctly when both are ISO strings of differing precision. ISO 8601 strings compare lexicographically equivalent to chronologically when both have the same precision and timezone offset (UTC `Z` in this codebase). The listMessages helper formats via `new Date(row.createdAt).toISOString()` (line 151 of runMessagesListing.ts), producing a `2026-05-26T00:00:00.000Z` style string. StreamEvent `timestamp` is also typically ISO 8601 UTC (the test fixtures use this). If a future wire-shape change adopts a different timestamp format (epoch ms, non-Z timezone), the lexicographic comparison breaks silently — add a defensive `new Date(a).getTime() > new Date(b).getTime()` if that risk materializes. For this task, the simpler string comparison is sufficient because both feeds round-trip through `Date.prototype.toISOString()` at their construction sites.
```

---

```markdown
