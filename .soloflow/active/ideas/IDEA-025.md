---
id: IDEA-025
type: FEATURE
status: answered
created: 2026-05-26T00:00:00Z
epics:
  - bottom-pane-restructure
  - ask-user-question-roundtrip
  - per-run-chat-surface
slices:
  - title: "Three-tab bottom pane shell"
    description: "Replace the current single RunView pane with a tabbed container holding Chat, Terminal (stub), and Data Stream tabs. Data Stream renders the existing RunView content verbatim."
    value_statement: "Establishes the structural foundation all downstream slices build on; unblocks parallel work on each tab without requiring a coordinated cutover."
  - title: "QuestionRouter — main-process interceptor"
    description: "New singleton mirroring ApprovalRouter's pending-promise pattern: intercepts AskUserQuestion tool calls from the SDK hook surface, parks them as in-flight promises keyed by question ID, persists them to a new 'questions' SQLite table, and emits events for renderer subscription."
    value_statement: "Provides the main-process half of the AskUserQuestion round-trip so the agent is no longer silently stalled. This slice is the functional core that makes the tool viable."
  - title: "tRPC questions router and subscription"
    description: "New cyboflow.questions sub-router under the existing appRouter: listPending query, answer mutation (resolves in-process promise, writes DB, returns tool_result to agent), and onQuestionCreated / onQuestionAnswered subscription procedures following the approvals.ts + events.ts pattern."
    value_statement: "Exposes the QuestionRouter over the existing IPC channel so the renderer can subscribe without any new transport or IPC handler wiring."
  - title: "AskUserQuestion card UI"
    description: "Frontend component for a single AskUserQuestion call: chip-style header label, per-question radio (single-select) or checkbox (multi-select) option groups, per-option description text, optional preview markdown panel, and an implicit free-form 'Other' field. Handles 1–4 questions per card. Calls cyboflow.questions.answer on submit."
    value_statement: "The user-facing affordance that lets a user actually respond to an agent question; without this slice the backend round-trip has no input surface."
  - title: "Chat tab — filtered conversation + inline cards"
    description: "Implements the Chat tab content: renders user-prompt and assistant-text messages filtered from the same underlying stream (no new persistence layer), inlines AskUserQuestion cards at the position matching their tool_use event, and inlines per-run-scoped approval cards from the existing approvalsRouter.listPending filtered to the active runId."
    value_statement: "Delivers the curated per-run conversation view with both interactive card types in context, replacing the raw-JSON 'tool: AskUserQuestion' placeholder."
  - title: "Mode-gated chat input"
    description: "Adds a text-input bar at the bottom of the Chat tab. In workflow-run mode the input is disabled/read-only except when an AskUserQuestion card is active. In quick-session mode the input is always enabled (free interactive chat). Dispatches user messages via the existing session IPC path for quick sessions; for workflow runs, input is accepted only as an 'Other' response to the active question card."
    value_statement: "Completes the interactive chat contract described in the synthesis — users can talk freely in quick mode and provide prompted input in workflow mode without the raw stream being the only visible surface."
open_questions:
  - question: "Which SDK hook point intercepts AskUserQuestion — PreToolUse, a dedicated tool-result hook, or something else?"
    context: "The entire QuestionRouter design assumes we can intercept the tool call before it returns to the agent. If AskUserQuestion requires a different hook (e.g. it fires after tool execution rather than before), the pending-promise architecture needs to match that hook's async contract. The existing PreToolUse hook in preToolUseHookHelper.ts returns HookJSONOutput; if AskUserQuestion needs a different return shape, both main and shared types must be updated."
    candidates:
      - "PreToolUse hook (same as approvals) — intercept before the tool executes, park the promise, resolve with the answer as an updatedInput or allow payload"
      - "A tool-result / PostToolUse hook — intercept after the tool fires and inject the user's answer into the tool_result block"
      - "AskUserQuestion is a built-in SDK mechanism with its own first-class async API (not a standard tool call at all) requiring a distinct handler separate from HookCallback"
      - "AskUserQuestion must be registered as a tool in the SDK options (mcpServers or similar) and the tool call is fully synchronous from the SDK's perspective — the hook just needs to return the user's answer inline"
    answer: "Defer to research — shadow-researcher will consult the Claude Agent SDK docs and pick the correct hook surface before QuestionRouter is implemented."
  - question: "Does the questions table need a new workflow_runs status (e.g. 'awaiting_input'), or should the run stay 'running' while a question is pending?"
    context: "The ApprovalRouter transitions workflow_runs to 'awaiting_review' while a gate is open, which enables the global Pending queue to flag blocking runs. AskUserQuestion is conceptually different: the agent asked a question but is still making progress (it isn't blocked in the same way). Using a distinct status would require a migration, new CHECK constraint value, and downstream status-display updates. Staying 'running' avoids all that but makes the stuck-detector and status indicators unable to distinguish 'running normally' from 'waiting for user answer'."
    candidates:
      - "Add a new 'awaiting_input' status to workflow_runs — clear distinction at the DB level, mirrors the approvals pattern exactly"
      - "Keep status 'running' throughout — simpler migration, use the questions table presence as the sole signal; update stuck-detector to exempt runs with pending questions from 'stuck' classification"
    answer: "Add a new 'awaiting_input' status to workflow_runs. Requires migration updating the CHECK constraint, adding the value to WorkflowRunStatus in shared/types/cyboflow.ts, and exempting awaiting_input runs from the StuckDetector's stuck classification."
  - question: "How should the Chat tab source its filtered message list for workflow runs — read from the messages table (already written by RawEventsSink), subscribe to onStreamEvent and filter client-side, or a new dedicated tRPC query?"
    context: "The messages table in migration 006 stores role='user'|'assistant'|'tool'|'system' rows and is populated by RawEventsSink. The onStreamEvent tRPC subscription is currently a placeholder (makePlaceholderAsyncIterator). A new tRPC query over the messages table would be straightforward and reuse the existing DB pattern. Client-side filtering over onStreamEvent avoids a new query but depends on onStreamEvent being wired first."
    candidates:
      - "New cyboflow.runs.listMessages tRPC query reading from the messages table — clean, load-on-demand, reload-safe"
      - "Client-side filter over the existing cyboflowStore.streamEvents (already populated for the Data Stream tab) — zero new backend work but couples Chat to stream subscription lifecycle"
      - "New onChatMessage tRPC subscription pushing only user+assistant text events — real-time but adds a third subscription channel"
    answer: "New cyboflow.runs.listMessages tRPC query reading from the messages table (chosen by planner). Rationale: reload-safe (session reload doesn't lose history), reuses the existing DB pattern from approvals/runs, doesn't couple the Chat tab to the streamEvents subscription lifecycle, and fits the load-on-select UX. Live deltas continue to flow via the existing streamEvents subscription (which the Data Stream tab also consumes); the Chat tab merges them with the initial query result."
  - question: "For quick-session mode, should the Chat tab's free-text input route through the existing IPC session-message path or through a new tRPC mutation?"
    context: "Quick sessions (no workflow_runs row) today use the AbstractCliManager / IPC path for sending messages. The tRPC router currently only covers orchestrator (workflow_run) concerns. Routing quick-session input through the existing IPC path avoids adding a new mutation but mixes the two transport layers in the same component. A new tRPC mutation would be consistent but requires wiring the session IPC path into the tRPC context."
    candidates:
      - "Use the existing window.electron IPC path (sessions:sendMessage or equivalent) for quick sessions — no backend change needed"
      - "Add a new cyboflow.sessions.sendMessage tRPC mutation that wraps the IPC path — consistent transport but more wiring"
    answer: "Use the existing window.electron IPC sessions:sendMessage path for quick sessions (chosen by planner). Rationale: cyboflow already separates quick-session IPC from orchestrator tRPC by design — that boundary is intentional, not accidental. Adding a tRPC wrapper just for transport consistency would erode the boundary without functional benefit. The Chat component routes to IPC for quick sessions and tRPC for workflow-run answers; this matches the existing architecture."
assumptions:
  - assumption: "AskUserQuestion produces a tool_use block in the assistant message stream (type='assistant', content block type='tool_use', name='AskUserQuestion') — i.e. it is structurally identical to other tool calls and can be detected in the AssistantEventRow / tool_use branch of RunView's stream dispatch."
    confidence: medium
    validation: "Confirmed by the clarified brief's description and the existing AssistantEventRow in RunView.tsx which already renders a raw 'tool: AskUserQuestion' JSON block. Verify against Claude Agent SDK docs or a live run capturing the raw stream."
  - assumption: "The questions table can be added as a new migration (010) without touching the existing 006 schema — no FK or CHECK constraint changes to workflow_runs are required if the run status stays 'running' during a pending question."
    confidence: high
    validation: "Review migration 006 and the WorkflowRunStatus CHECK constraint in shared/types/cyboflow.ts; if 'awaiting_input' status is chosen, confidence drops to medium and the CHECK constraint must be updated."
  - assumption: "The QuestionRouter can reuse the exact same per-run p-queue pattern as ApprovalRouter (approvalQueues field) without self-deadlock because the AskUserQuestion intercept point fires from outside the RunQueueRegistry's per-run executor task."
    confidence: medium
    validation: "Verify the SDK hook invocation site: if AskUserQuestion is intercepted in PreToolUse (which fires from within runSdkQuery's for-await loop, which is inside RunQueueRegistry's executor task), the same deadlock risk documented in approvalRouter.ts §3 applies and a separate PQueue is mandatory."
  - assumption: "The existing messages table rows (role='assistant') already contain tool_use content blocks when the agent calls AskUserQuestion — so listMessages can return them without a new event-sink path."
    confidence: medium
    validation: "Check RawEventsSink and the messages table write path; confirm tool_use blocks inside assistant content are stored in content_json, not filtered out."
  - assumption: "The three-tab shell can be introduced as a new React component wrapping RunView without modifying cyboflowStore — activeRunId and streamEvents remain the correct state shape for the Data Stream tab."
    confidence: high
    validation: "Review cyboflowStore.ts — activeRunId and streamEvents are already the primary state; the Chat tab only needs a filtered view of the same data, not a parallel store."
  - assumption: "The global Pending review queue panel (ReviewQueueView) can stay unchanged — it already subscribes to all approvals across all runs, and the Chat tab's per-run inline approval cards can be built by filtering the same approvalsRouter.listPending response by runId on the frontend."
    confidence: high
    validation: "Confirmed by the synthesis and the Approval type in shared/types/approvals.ts which carries runId; filtering client-side is straightforward."
research_recommendation: recommended
research_rationale: "The SDK hook interception point for AskUserQuestion is the pivotal architectural decision (it controls whether QuestionRouter uses PreToolUse or a different async contract) and cannot be determined from the codebase alone — the Claude Agent SDK docs must be consulted before QuestionRouter is designed."
---

# Bottom-Pane Three-Tab Restructure with AskUserQuestion Round-Trip

## Raw Input

When the agent inside a cyboflow session calls the Claude Agent SDK's built-in `AskUserQuestion` tool, cyboflow's renderer currently shows only the raw JSON of the tool call (see the assistant message rendering `tool: AskUserQuestion` with the questions/options payload inline). There is no interactive UI for the user to actually pick an answer, and no mechanism to feed the selected answer back to the agent as the corresponding `tool_result`, so the agent stalls waiting on a response it can never receive.

Search confirms zero hits for "AskUserQuestion" anywhere in main/src, frontend/src, or shared — this is a fresh feature, not a half-implemented one.

What we need:
1. Detect the `AskUserQuestion` tool call in the stream and route it to a dedicated renderer (it's structurally similar to the existing approval review queue but distinct — approvals gate execution, this gates on a user response).
2. Render the question(s) as interactive UI: single-select radio buttons, multi-select checkboxes, the chip-style `header` label, the per-option `description` text, and the optional `preview` markdown panel for visual-comparison questions. There's always an implicit "Other" option that lets the user type a free-text answer. The tool schema supports 1–4 questions per call.
3. Capture the user's selection(s) (plus any "Other" text and per-option notes/preview metadata) and feed it back to the agent as the `tool_result` for that tool_use_id, so the agent unblocks and continues the conversation.
4. Persist the asked-and-answered state so a reload or session reconnect doesn't lose it (mirrors the approvals table pattern).

## Grounding

**Current bottom pane — RunView:**
- `/Users/raimundoesteva/Developer/cyboflow/frontend/src/components/cyboflow/RunView.tsx` — the current single-view stream renderer. The `AssistantEventRow` component already renders a `tool_use` content block (name + JSON.stringify input) when `block.type === 'tool_use'` — this is where `AskUserQuestion` appears today as raw JSON. This is the component being wrapped into the "Data Stream" tab.

**cyboflowStore:**
- `/Users/raimundoesteva/Developer/cyboflow/frontend/src/stores/cyboflowStore.ts` — owns `activeRunId`, `activeQuickSessionId` (mutual exclusion invariant per IDEA-024/TASK-743), and `streamEvents`. The three-tab shell builds on this store with no state changes needed.

**Approval pattern to mirror:**
- `/Users/raimundoesteva/Developer/cyboflow/main/src/orchestrator/approvalRouter.ts` — the canonical main-process singleton pattern: per-run p-queue serialization, `pending` Map of in-flight promises, `requestApproval` / `respond` / `clearPendingForRun`, `emit('approvalCreated', …)`. QuestionRouter follows this exact shape with a different payload.
- `/Users/raimundoesteva/Developer/cyboflow/main/src/orchestrator/preToolUseHookHelper.ts` — routes `PreToolUseHookInput` through `ApprovalRouter` and returns `HookJSONOutput`. The equivalent for AskUserQuestion will either extend this or add a parallel helper.
- `/Users/raimundoesteva/Developer/cyboflow/main/src/orchestrator/approvalCreatedBridge.ts` — enriches the in-memory `ApprovalRequest` with workflowName via a DB JOIN before emitting the SSE event. An analogous `questionCreatedBridge.ts` follows the same pattern.

**tRPC wiring:**
- `/Users/raimundoesteva/Developer/cyboflow/main/src/orchestrator/trpc/routers/approvals.ts` — `listPending`, `approve`, `reject`, `approveRestOfRun`, `rejectRestOfRun` — all five procedures are the template for `cyboflow.questions.*`.
- `/Users/raimundoesteva/Developer/cyboflow/main/src/orchestrator/trpc/routers/events.ts` — exports `approvalEvents` EventEmitter, `eventToAsyncIterable` helper, `onApprovalCreated` and `onApprovalDecided` subscription procedures. A parallel `questionEvents` emitter and `onQuestionCreated` / `onQuestionAnswered` subscriptions slot into this same file.
- `/Users/raimundoesteva/Developer/cyboflow/main/src/orchestrator/trpc/router.ts` — root router wiring all sub-routers; `cyboflow.questions` added here.

**DB schema:**
- `/Users/raimundoesteva/Developer/cyboflow/main/src/database/migrations/006_cyboflow_schema.sql` — the `approvals` table is the structural template for a new `questions` table (migration 010). The `workflow_runs` status CHECK constraint currently lists 8 values; an 'awaiting_input' status would require updating this constraint.

**Frontend review queue (approval UI reference):**
- `/Users/raimundoesteva/Developer/cyboflow/frontend/src/components/ReviewQueueView.tsx` — global cross-run pending queue; stays unchanged per synthesis.
- `/Users/raimundoesteva/Developer/cyboflow/frontend/src/components/ReviewQueue/PendingApprovalCard.tsx` — `CardChrome` component structure (header, payload preview, action buttons, stuck-run extensions) is the layout reference for `AskUserQuestionCard`.
- `/Users/raimundoesteva/Developer/cyboflow/frontend/src/stores/reviewQueueStore.ts` — `init()` full-state resync + delta subscription pattern; `questionStore` mirrors this exactly.

**Shared types:**
- `/Users/raimundoesteva/Developer/cyboflow/shared/types/approvals.ts` — `Approval`, `ApprovalCreatedEvent`, `ApprovalDecidedEvent` — the wire-type pattern for new `Question`, `QuestionCreatedEvent`, `QuestionAnsweredEvent` types in a new `shared/types/questions.ts`.
- `/Users/raimundoesteva/Developer/cyboflow/shared/types/cyboflow.ts` — `WorkflowRunStatus` with the CHECK constraint source; `ApprovalRow` is the DB-row type template for `QuestionRow`.

**ClaudeCodeManager hook site:**
- `/Users/raimundoesteva/Developer/cyboflow/main/src/services/panels/claude/claudeCodeManager.ts` — `makePreToolUseHook` (line ~530) is the concrete `HookCallback` that routes every PreToolUse event to `routePreToolUseThroughApprovalRouter`. If AskUserQuestion is intercepted at PreToolUse, this is where a branch for `pretool.tool_name === 'AskUserQuestion'` routes to `QuestionRouter` instead of `ApprovalRouter`. The `runSdkQuery` finally block also calls `ApprovalRouter.getInstance().clearPendingForRun(panelId)`; a matching `QuestionRouter.getInstance().clearPendingForRun(panelId)` call belongs here too.

**Tab bar reference:**
- `/Users/raimundoesteva/Developer/cyboflow/frontend/src/components/panels/PanelTabBar.tsx` — existing tab-bar component; the three-tab shell for the run view is a new lighter-weight local tab switcher (not this full panel-management component, which handles closeable/renameable panels).
- `/Users/raimundoesteva/Developer/cyboflow/frontend/src/components/panels/TerminalPanel.tsx` — uses `@xterm/xterm`; the Terminal tab stub avoids this dependency until a later IDEA wires it.

**Zero existing AskUserQuestion hits:**
- `grep "AskUserQuestion"` across `main/src`, `frontend/src`, `shared/` returns zero matches (confirmed by the codebase search). This is a net-new feature with no partial implementation to reconcile.

## Slices

**Slice 1 — Three-tab bottom pane shell**

Create a `RunBottomPane` component that wraps the current `RunView` inside a tab-switching shell with three tabs: Chat, Terminal, Data Stream. The Data Stream tab renders `<RunView />` verbatim — it is a zero-behavior-change relocation. The Terminal tab renders a "Terminal — coming soon" placeholder. The Chat tab renders a new `<RunChatView runId={activeRunId} />` stub (empty for now). Replace the current `<RunView />` mount point in the cyboflow session layout with `<RunBottomPane />`. The `cyboflowStore` state shape is unchanged. Tab selection state lives in local component state (not the store).

**Slice 2 — QuestionRouter main-process singleton**

New file `main/src/orchestrator/questionRouter.ts`. Follows `approvalRouter.ts` exactly:
- `QuestionRequest` type: `{ id, runId, toolUseId, questions: QuestionPayload[], timestamp }` where `QuestionPayload` is the SDK's AskUserQuestion schema (1–4 questions, each with `question`, `header`, `multiSelect`, `options[2–4]` with `label`, `description`, optional `preview`).
- `PendingEntry` map: `{ request, resolve, reject }`.
- Per-run p-queue (separate from `RunQueueRegistry` to avoid self-deadlock — same invariant documented in `approvalRouter.ts §3`).
- `requestQuestion(runId, toolUseId, questions, socketReply)` — writes to `questions` DB table, emits `'questionCreated'`, returns `Promise<QuestionAnswer>`.
- `respond(questionId, answer)` — resolves the promise, writes `answered_at` + `answer_json` to DB, emits `'questionAnswered'`.
- `clearPendingForRun(runId)` — resolves all pending promises with a synthetic empty answer (mirrors `clearPendingForRun` in `approvalRouter.ts`).
- `recoverStaleAwaitingInput()` — boot-time recovery if a 'awaiting_input' status is chosen (or a no-op if 'running' is kept).
- Migration 010 adds the `questions` table: `id TEXT PK, run_id TEXT FK, tool_use_id TEXT NOT NULL, questions_json TEXT NOT NULL, answer_json TEXT, status TEXT ('pending'|'answered'|'timed_out'), created_at, answered_at`.

The hook intercept point (PreToolUse branch vs dedicated hook) is resolved after external SDK research. The call site in `claudeCodeManager.ts`'s `makePreToolUseHook` adds a branch: `if (pretool.tool_name === 'AskUserQuestion') { return routeAskUserQuestionThroughQuestionRouter(...) }`.

**Slice 3 — tRPC questions router and subscription**

New file `main/src/orchestrator/trpc/routers/questions.ts`. Procedures:
- `listPending` — query reading `questions WHERE status='pending'` joined with `workflow_runs` / `workflows` for `workflowName`. Return type `Question[]` from new `shared/types/questions.ts`.
- `answer` — mutation accepting `{ questionId, answers: QuestionAnswer }` (answers keyed by question text per SDK schema). Calls `QuestionRouter.getInstance().respond(...)`. Maps `QuestionNotFoundError` → `TRPCError NOT_FOUND`.
- `onQuestionCreated` — subscription backed by `questionEvents.on('created', …)` via the existing `eventToAsyncIterable` helper in `events.ts`. Yields `QuestionCreatedEvent`.
- `onQuestionAnswered` — subscription backed by `questionEvents.on('answered', …)`. Yields `QuestionAnsweredEvent`.

Add `questionsRouter` to `main/src/orchestrator/trpc/router.ts` under `cyboflow.questions`.

Add `questionEvents` EventEmitter to `main/src/orchestrator/trpc/routers/events.ts` (same module-level pattern as `approvalEvents`).

Wire the QuestionRouter initialization in `main/src/index.ts` after the `ApprovalRouter.initialize()` call.

**Slice 4 — AskUserQuestion card UI**

New component `frontend/src/components/AskUserQuestion/AskUserQuestionCard.tsx`. Props: `{ item: QuestionItem, onAnswer: (answer: QuestionAnswer) => void }`.

Renders per question:
- Chip-style `header` label (≤12 chars, truncated; rendered as a small pill using the existing `Pill` component from `frontend/src/components/ui/Pill.tsx`).
- `question` text as the card title.
- `multiSelect: false` → radio-button group; `multiSelect: true` → checkbox group.
- Per option: `label` + optional `description` text below.
- When option has `preview`, a collapsible `<MarkdownPreview />` panel (already exists at `frontend/src/components/MarkdownPreview.tsx`).
- Implicit "Other" option below the group: selecting it activates a text input for free-form answer.

Submit button disabled until each question has at least one selection. On submit, calls `trpc.cyboflow.questions.answer.mutate(...)`.

A companion `frontend/src/stores/questionStore.ts` mirrors `reviewQueueStore.ts`: `init()` with full-state resync + delta subscriptions (`onQuestionCreated`, `onQuestionAnswered`), `addQuestion` / `removeQuestion` / `replaceAll`.

**Slice 5 — Chat tab content**

Implements `RunChatView` in `frontend/src/components/cyboflow/RunChatView.tsx`. On mount, reads messages filtered to the active run — either from `cyboflowStore.streamEvents` (client-side filter for `type='assistant'` text content and `type='user'`) or from a new `cyboflow.runs.listMessages` tRPC query (resolved by open question 3). Renders:
- User prompt bubbles.
- Assistant text bubbles (markdown via `MarkdownPreview`).
- `AskUserQuestionCard` instances at the position where the corresponding `tool_use` event appears in the stream, sourced from `questionStore`.
- Per-run approval cards (inline `PendingApprovalCard` variant) sourced from `reviewQueueStore.queue.filter(a => a.runId === activeRunId)`.

For quick sessions (`activeQuickSessionId != null`), the same component renders the existing session message history.

**Slice 6 — Mode-gated chat input**

Adds a `<ChatInput>` component at the bottom of `RunChatView`. States:
- **Quick session**: always enabled, text area + send button, dispatches via the existing IPC `sessions:sendMessage` path (or new tRPC mutation per open question 4).
- **Workflow run, no active question**: read-only (`disabled`, tooltip "Input enabled only when the agent asks a question").
- **Workflow run, active question open**: enabled — text typed here is forwarded as the "Other" free-text answer for the active `AskUserQuestionCard`, not as a new agent message.

Enabled/disabled state derives from `questionStore` (any pending question for this runId) and `cyboflowStore.activeQuickSessionId`.

## Open Questions

**Q1: SDK hook interception point for AskUserQuestion**

Context: The QuestionRouter's design — and specifically whether it can follow the PreToolUse / `HookJSONOutput` pattern exactly — depends on which SDK hook fires for AskUserQuestion. `preToolUseHookHelper.ts` currently returns `HookJSONOutput` with `permissionDecision: 'allow'|'deny'`. If AskUserQuestion uses a different hook (e.g. it is a first-class SDK async mechanism or a PostToolUse hook), the return shape and the async lifecycle differ. This is the single largest architectural unknown; it must be resolved before QuestionRouter is implemented. See `candidates` in the frontmatter.

**Answer:** Defer to research — the shadow-researcher will consult the Claude Agent SDK docs and pick the correct hook surface before QuestionRouter is implemented.

**Q2: workflow_runs status during pending question**

Context: `approvalRouter.ts` transitions `workflow_runs.status → 'awaiting_review'` atomically with the approval INSERT. If QuestionRouter does the same with a new 'awaiting_input' status, it requires: updating the CHECK constraint in migration 006 (via a new migration), adding the value to `WorkflowRunStatus` in `shared/types/cyboflow.ts`, updating the `StuckDetector` (which reads status to classify orphan_pty, awaiting_input runs should not be classified stuck), and updating the `recoverStaleAwaitingReview` boot recovery in `approvalRouter.ts`. The 'keep running' path avoids all this but weakens observability.

**Answer:** Add a new 'awaiting_input' status to workflow_runs. Requires migration updating the CHECK constraint, adding the value to `WorkflowRunStatus` in `shared/types/cyboflow.ts`, and exempting `awaiting_input` runs from the StuckDetector's stuck classification.

**Q3: Chat tab message source**

Context: The `messages` table (migration 006) is populated by `RawEventsSink`. The `onStreamEvent` tRPC subscription is currently a placeholder in `events.ts` (uses `makePlaceholderAsyncIterator` — yields nothing). A new `listMessages` query is straightforward but adds a DB query. Client-side filtering over `cyboflowStore.streamEvents` works today but only shows messages received since the current app session (not historical). For load-on-select fidelity, a DB query is preferred.

**Answer:** New `cyboflow.runs.listMessages` tRPC query reading from the messages table (chosen by planner). Reload-safe, reuses existing DB pattern, doesn't couple Chat to the streamEvents subscription lifecycle, fits load-on-select UX. Live deltas continue via the existing streamEvents subscription; Chat merges them with the initial query result.

**Q4: Quick-session chat input transport**

Context: Quick sessions use `AbstractCliManager`'s IPC path (`window.electron.invoke`) for sending messages. The tRPC router covers orchestrator concerns (workflow_runs). Mixing transports in the same Chat component is inelegant but avoids creating a session-IPC wrapper in the tRPC layer. The answer affects which code path `ChatInput` calls and whether `cyboflow.sessions.sendMessage` needs to be added to the tRPC router.

**Answer:** Use the existing window.electron IPC `sessions:sendMessage` path for quick sessions (chosen by planner). cyboflow already separates quick-session IPC from orchestrator tRPC by design — preserve that boundary. Chat routes to IPC for quick sessions and tRPC for workflow-run answers.

## Assumptions

1. **AskUserQuestion appears as a tool_use block in the assistant stream** (type='assistant', content block type='tool_use', name='AskUserQuestion'). Confidence: medium. Confirmed structurally by the existing `AssistantEventRow` in `RunView.tsx` which already renders it as raw JSON — the `block.name` field would be 'AskUserQuestion'. Verify against live run or SDK docs.

2. **The questions table can be a migration 010 without touching the 006 CHECK constraint**, assuming the 'running' status approach is chosen. Confidence: high. The CHECK constraint in `006_cyboflow_schema.sql` only needs updating if 'awaiting_input' status is added.

3. **QuestionRouter's per-run p-queue is deadlock-safe** because the SDK hook fires from within `runSdkQuery`'s `for await` loop (inside the `RunQueueRegistry` executor task), making a separate p-queue mandatory — same reasoning as `approvalRouter.ts §3`. Confidence: high (mirrors documented invariant; the same code path applies).

4. **The existing messages table rows contain tool_use content blocks** within the assistant content_json, not filtered. Confidence: medium. `RawEventsSink` writes the narrowed event payload; verify that the assistant-event writer stores the full `message.content` array including tool_use blocks.

5. **The three-tab shell needs no changes to cyboflowStore**. Confidence: high. `activeRunId`, `activeQuickSessionId`, and `streamEvents` are the correct state for the Data Stream tab; the Chat tab needs only a filtered view.

6. **The global ReviewQueueView stays unchanged**. Confidence: high. The synthesis explicitly states it; the `Approval` type already carries `runId` for per-run filtering.
