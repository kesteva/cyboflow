---
id: TASK-761
idea: IDEA-025
status: approved
created: "2026-05-26T00:00:00Z"
files_owned:
  - frontend/src/components/cyboflow/RunChatView.tsx
  - frontend/src/components/cyboflow/__tests__/RunChatView.test.tsx
  - frontend/src/components/cyboflow/RunBottomPane.tsx
files_readonly:
  - frontend/src/components/cyboflow/RunView.tsx
  - frontend/src/components/cyboflow/CyboflowRoot.tsx
  - frontend/src/stores/cyboflowStore.ts
  - frontend/src/stores/questionStore.ts
  - frontend/src/stores/reviewQueueStore.ts
  - frontend/src/components/AskUserQuestion/AskUserQuestionCard.tsx
  - frontend/src/components/ReviewQueue/PendingApprovalCard.tsx
  - frontend/src/components/MarkdownPreview.tsx
  - frontend/src/trpc/client.ts
  - frontend/src/utils/cyboflowApi.ts
  - shared/types/approvals.ts
  - shared/types/claudeStream.ts
  - .soloflow/active/ideas/IDEA-025.md
  - .soloflow/active/research/IDEA-025-research.md
acceptance_criteria:
  - criterion: "frontend/src/components/cyboflow/RunChatView.tsx exists and exports a named React component `RunChatView` with the prop signature `{ runId: string | null }`."
    verification: "cat frontend/src/components/cyboflow/RunChatView.tsx | grep -E 'export function RunChatView|export const RunChatView' returns at least one match; tsc compiles the file."
  - criterion: "When `runId` is non-null, RunChatView calls `trpc.cyboflow.runs.listMessages.query({ runId })` exactly once on mount (and again whenever `runId` changes) and merges the result with `useCyboflowStore.getState().streamEvents` filtered by `runId`."
    verification: "Vitest unit test mocks trpc.cyboflow.runs.listMessages.query, mounts the component with runId='run-A', asserts the mock was called once with { runId: 'run-A' }; remount with runId='run-B' triggers a second call."
  - criterion: "RunChatView renders user-prompt bubbles for every StreamEvent where `event.type === 'user'` and the inner content blocks are text-bearing tool_result entries OR raw user text. Assistant text blocks (`event.type === 'assistant'` with content block `type === 'text'`) are rendered through `<MarkdownPreview content={block.text} />`."
    verification: "Vitest test appends a representative assistant event with a text block via `useCyboflowStore.getState().appendStreamEvent`, renders RunChatView, asserts the text is in the DOM and is wrapped in an element with class containing 'markdown-preview' (MarkdownPreview's root class)."
  - criterion: "For every assistant event with a content block where `block.type === 'tool_use' && block.name === 'AskUserQuestion'`, RunChatView renders an `<AskUserQuestionCard>` at that position, sourced from `questionStore` by matching the question's `toolUseId` to `block.id`. Tool-use blocks whose name is NOT 'AskUserQuestion' fall back to a compact tool-name + JSON preview (same shape as RunView's AssistantEventRow tool branch)."
    verification: "Vitest test seeds questionStore with one pending question carrying toolUseId='tu-q1', appends an assistant event with a tool_use block { id: 'tu-q1', name: 'AskUserQuestion', input: <questions> }, renders RunChatView, asserts an element rendered by the mocked AskUserQuestionCard is in the DOM."
  - criterion: "RunChatView renders inline `<PendingApprovalCard>` instances ONLY for approvals where `approval.runId === runId` (sourced from `useReviewQueueStore((s) => s.queue)`)."
    verification: "Vitest test seeds reviewQueueStore with two approvals (one for runId='run-A', one for runId='run-B'), renders RunChatView with runId='run-A', asserts the run-A approval card mock is in the DOM and the run-B card mock is NOT."
  - criterion: "When `runId` is null AND `activeQuickSessionId` is non-null, RunChatView renders the placeholder text 'Quick session chat (history rendered by panel surface)' and does NOT call `trpc.cyboflow.runs.listMessages.query`. This task does NOT include a separate quick-session history renderer — the existing PanelTabBar/PanelContainer in CyboflowRoot continues to handle quick-session UI."
    verification: "Vitest test sets activeQuickSessionId via store, renders <RunChatView runId={null} />, asserts the placeholder text is in the DOM and the listMessages mock was not called."
  - criterion: "When `runId` is null AND `activeQuickSessionId` is also null, RunChatView renders the placeholder text 'No active run'."
    verification: "Vitest test renders <RunChatView runId={null} /> with both store fields null, asserts 'No active run' is in the DOM."
  - criterion: "RunBottomPane.tsx's Chat tab body mounts `<RunChatView runId={activeRunId} />` (replacing TASK-756's inline placeholder string). This is a single targeted edit; no other modifications to RunBottomPane.tsx are permitted."
    verification: "git diff --stat HEAD -- frontend/src/components/cyboflow/RunBottomPane.tsx shows at most 2 lines added (import + JSX mount) and 1 line removed (placeholder); `grep -n 'RunChatView' frontend/src/components/cyboflow/RunBottomPane.tsx` returns at least 2 matches (import + mount)."
  - criterion: "`pnpm run --filter frontend typecheck` exits 0 and `pnpm run --filter frontend test` exits 0 with the RunChatView.test.tsx suite green."
    verification: Run both commands; both exit 0.
depends_on:
  - TASK-756
  - TASK-760
estimated_complexity: medium
epic: per-run-chat-surface
test_strategy:
  needed: true
  justification: "RunChatView is a net-new component with three distinct rendering branches (workflow-run mode, quick-session placeholder, empty placeholder) and non-trivial merge logic between an async tRPC query result and a live store-backed event stream. Sibling tests exist at frontend/src/components/cyboflow/__tests__/ (RunView.test.tsx, CyboflowRoot.test.tsx, WorkflowPicker.test.tsx) but none of them exercise RunChatView's behavior — those siblings cover RunView/CyboflowRoot/WorkflowPicker which are unmodified by this task. A new test file is required."
  targets:
    - behavior: "On mount with runId set, calls trpc.cyboflow.runs.listMessages.query exactly once with { runId }."
      test_file: frontend/src/components/cyboflow/__tests__/RunChatView.test.tsx
      type: component
    - behavior: Renders assistant text content via MarkdownPreview and routes AskUserQuestion tool_use blocks to AskUserQuestionCard (mocked) at the stream position.
      test_file: frontend/src/components/cyboflow/__tests__/RunChatView.test.tsx
      type: component
    - behavior: Filters reviewQueueStore.queue by runId — only approvals for the active run render as inline PendingApprovalCard.
      test_file: frontend/src/components/cyboflow/__tests__/RunChatView.test.tsx
      type: component
    - behavior: "Quick-session mode (runId=null, activeQuickSessionId set) renders the placeholder and skips the listMessages query."
      test_file: frontend/src/components/cyboflow/__tests__/RunChatView.test.tsx
      type: component
    - behavior: "RunBottomPane.tsx Chat tab actually mounts <RunChatView />, proving the wiring."
      test_file: frontend/src/components/cyboflow/__tests__/RunChatView.test.tsx
      type: component
---
# RunChatView — filtered conversation + inline question and approval cards

## Objective

Create the Chat tab content for the per-run bottom pane: a curated, scrollable conversation rendering user prompts and assistant text bubbles for the active run, with inline AskUserQuestionCard instances at the position of their `tool_use` event and per-run-filtered PendingApprovalCard instances from the existing review queue. The component bootstraps from `cyboflow.runs.listMessages` (created by TASK-759 and consumed transitively via TASK-760) and merges live deltas from `cyboflowStore.streamEvents`. This task does NOT add a chat input bar (TASK-762) and does NOT touch the QuestionRouter, tRPC, or DB layers. It makes ONE targeted edit to RunBottomPane.tsx (owned by TASK-756) to mount the new component in the Chat tab body, replacing the placeholder string.

## Implementation Steps

1. **Create `frontend/src/components/cyboflow/RunChatView.tsx` as a new file.** Export a named function component `export function RunChatView({ runId }: { runId: string | null }): ReactElement`. Import `useCyboflowStore` from `../../stores/cyboflowStore`, `useReviewQueueStore` from `../../stores/reviewQueueStore`, `useQuestionStore` from `../../stores/questionStore` (created by TASK-760), `MarkdownPreview` from `../MarkdownPreview`, `AskUserQuestionCard` from `../AskUserQuestion/AskUserQuestionCard` (created by TASK-760), `PendingApprovalCard` from `../ReviewQueue/PendingApprovalCard`, `trpc` from `../../trpc/client`, and `StreamEvent` type from `../../utils/cyboflowApi`.

2. **Component state and effects.**
   - Select from cyboflowStore: `activeQuickSessionId`, `streamEvents`.
   - Select from reviewQueueStore: `queue` (Approval[]).
   - Select from questionStore: `queue` (PendingQuestion[]).
   - Local state: `historicalEvents: StreamEvent[]` (default `[]`), `isLoadingHistory: boolean`, `loadError: string | null`.
   - `useEffect(() => { ... }, [runId])`: when `runId` is non-null, set `isLoadingHistory=true`, call `trpc.cyboflow.runs.listMessages.query({ runId })`, then `setHistoricalEvents(result)` and clear loading. On error, set `loadError`. Effect cleans up via an `aborted` flag.
   - Compute `mergedEvents` as `[...historicalEvents, ...streamEvents.filter(e => e.runId === runId)]` via `useMemo` keyed on both arrays' identities.

3. **Render branches.** Use a single top-level branch:
   - If `runId === null && activeQuickSessionId !== null`: render `<div>Quick session chat (history rendered by panel surface)</div>`. Do NOT call the listMessages query.
   - If `runId === null && activeQuickSessionId === null`: render `<div>No active run</div>` (matches RunView's empty-state copy).
   - Otherwise (`runId !== null`): render the conversation view (step 4).

4. **Conversation rendering.** Inside an `overflow-auto` scroll container styled to match RunView (`flex h-full flex-col gap-2`, `flex-1 overflow-auto rounded border border-border-primary bg-bg-secondary p-2`):
   - If `isLoadingHistory`: a small "Loading history..." line at the top.
   - If `loadError !== null`: a small red error line.
   - Iterate `mergedEvents` with `.map((event, idx) => renderConversationEvent(event, idx, ...deps))`.
   - `renderConversationEvent(event, idx, { questionQueue, approvalQueue, runId })`:
     - `event.type === 'user'`: render a user-bubble div containing each text-bearing content block joined; tool_result error blocks render with a red "error" badge.
     - `event.type === 'assistant'`: iterate `event.payload.message.content` blocks:
       - `block.type === 'text'`: `<MarkdownPreview content={block.text} />` inside an assistant bubble.
       - `block.type === 'tool_use' && block.name === 'AskUserQuestion'`: find the matching pending question via `questionQueue.find(q => q.toolUseId === block.id)`; if found, render `<AskUserQuestionCard item={question} />`; if not found, render a small muted "Question already answered" line.
       - `block.type === 'tool_use'` (other tool name): render the same compact `tool: <name>` + JSON-stringified input box that RunView's `AssistantEventRow` renders.
       - `block.type === 'thinking'`: skip.
     - Other event types: return `null`.
   - **After** the merged-events loop, render the per-run approval cards in a "Pending approvals" section, ONLY if `approvalQueue.filter(a => a.runId === runId).length > 0`.

5. **Auto-scroll.** Use the same `useRef<HTMLDivElement>(null)` + `useEffect` pattern as RunView. Place an empty `<div ref={bottomRef} />` after the events map.

6. **Targeted edit to `frontend/src/components/cyboflow/RunBottomPane.tsx`** (owned by TASK-756, listed in this plan as readonly per the minimal-stitch convention). Locate the Chat tab body and replace the placeholder with `<RunChatView runId={activeRunId} />` and add `import { RunChatView } from './RunChatView';`. The diff must be small: one import line added, one placeholder JSX expression replaced. No other changes.

7. **Create `frontend/src/components/cyboflow/__tests__/RunChatView.test.tsx` as a new file.** Mirror the setup pattern from `__tests__/RunView.test.tsx`:
   - `vi.mock('../../../utils/cyboflowApi', ...)` to no-op `subscribeToStreamEvents`.
   - `vi.mock('../../../trpc/client', () => ({ trpc: { cyboflow: { runs: { listMessages: { query: vi.fn(async () => []) } } } } }))`.
   - `vi.mock('../../AskUserQuestion/AskUserQuestionCard', ...)` with a testid stub.
   - `vi.mock('../../ReviewQueue/PendingApprovalCard', ...)` with a testid stub.
   - `beforeEach`: clear cyboflowStore, reviewQueueStore, questionStore. Stub `HTMLElement.prototype.scrollIntoView = vi.fn()`.
   - One test per behavior listed in `test_strategy.targets[]`.

8. **Typecheck and test.** Run `pnpm --filter frontend typecheck` and `pnpm --filter frontend test --run components/cyboflow/__tests__/RunChatView.test.tsx`. Both must exit 0.

## Acceptance Criteria

(See frontmatter for the verifiable list. Pass/fail summary for review convenience:)

- New file `RunChatView.tsx` exists, exports `RunChatView`, prop signature `{ runId: string | null }`.
- On mount with non-null `runId`, calls `trpc.cyboflow.runs.listMessages.query({ runId })` exactly once; re-calls on runId change.
- Assistant text blocks render via `<MarkdownPreview>`; user blocks render as user bubbles.
- `tool_use` blocks where `name === 'AskUserQuestion'` route to `AskUserQuestionCard` resolved by `toolUseId === block.id` from questionStore.
- Approval cards filtered to `approval.runId === runId` render at the bottom; other-run approvals do NOT render.
- Quick-session mode renders a placeholder and skips the query; empty mode renders "No active run".
- RunBottomPane Chat tab mounts `<RunChatView />` (single import + JSX edit, no other modifications).
- Frontend typecheck and the new test suite both pass.

## Test Strategy

A new test file `frontend/src/components/cyboflow/__tests__/RunChatView.test.tsx` is created. Tests use `@testing-library/react`'s `render` + `screen`, mock the three external dependencies, and drive store state via the existing `useCyboflowStore.getState()` / `useReviewQueueStore.getState()` / `useQuestionStore.getState()` patterns.

Five test cases per the targets list. Additionally, one test asserts the RunBottomPane wiring by rendering `<RunBottomPane />` (TASK-756's component), selecting the Chat tab, and asserting the mocked `RunChatView` is in the DOM. If TASK-756's tab API requires a deeper integration touch, scope this test down to a snapshot of RunBottomPane's Chat tab body rendering RunChatView.

## Hardest Decision

**How to source the historical-message backlog while live deltas keep flowing.** Three options were considered: (1) streamEvents-only (loses history on reload), (2) `listMessages` query merged with live streamEvents (reload-safe, small dedup risk), (3) third tRPC subscription replaying historical backlog (over-engineered).

Chose option 2 because the IDEA's resolved Q3 explicitly chose this path. The dedup risk is small in practice — `streamEvents` only carries events received since `setActiveRun` was last called, and `listMessages` returns events as of query time. If a tiny overlap window exists, the render output simply repeats one event; this is a low-cost defect compared to the reload-safety win.

## Rejected Alternatives

- **Inline the chat view into RunBottomPane.tsx instead of a separate component.** Would tightly couple the bottom-pane shell to chat-specific rendering logic.
- **Read from raw_events directly via a new SQLite query that does JSON extraction.** Research Risk 1 flagged that the `messages` table has no write path today, but TASK-759 owns adding the query against raw_events. This task consumes whichever shape TASK-759 ships.
- **Render quick-session message history inline.** The Chat tab tries to be one component for both modes, but quick-session message data lives in the panel-surface system, entirely outside `streamEvents`. Re-implementing that would balloon scope.
- **Subscribe to questionStore + reviewQueueStore via `init()` inside RunChatView.** The convention is for the app shell to call `init()` once at mount; doing so inside RunChatView would re-initialize on every mount/unmount cycle.

## Lowest Confidence Area

**The exact router path for the historical-messages query (`cyboflow.runs.listMessages` vs `cyboflow.questions.listMessages`).** The IDEA's resolved Q3 chose `cyboflow.runs.listMessages` but TASK-759's title implies it might live under `cyboflow.questions`. The executor MUST grep `main/src/orchestrator/trpc/routers/` for `listMessages` after TASK-759 merges and use whichever path is actually registered.

A secondary uncertainty is the exact shape of `questionStore.queue[i]` (created by TASK-760). This plan assumes it has fields `{ id, runId, toolUseId, questions }`. If TASK-760 renames `toolUseId` (e.g. to `tool_use_id`) the matching logic must follow.
