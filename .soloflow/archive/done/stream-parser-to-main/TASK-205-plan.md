---
id: TASK-205
idea: IDEA-005
idea_id: IDEA-005
status: in-flight
created: "2026-05-11T00:00:00Z"
files_owned:
  - frontend/src/components/panels/claude/RichOutputWithSidebar.tsx
  - frontend/src/components/panels/claude/ClaudePanel.tsx
  - frontend/src/components/panels/ai/transformers/ClaudeMessageTransformer.ts
  - main/src/services/streamParser/messageProjection.ts
  - main/src/services/streamParser/__tests__/messageProjection.test.ts
  - shared/types/unifiedMessage.ts
  - frontend/src/components/panels/ai/transformers/MessageTransformer.ts
files_readonly:
  - frontend/src/components/panels/ai/RichOutputView.tsx
  - frontend/src/components/panels/ai/transformers/MessageTransformer.ts
  - frontend/src/components/panels/ai/transformers/CodexMessageTransformer.ts
  - frontend/src/components/panels/ai/MessagesView.tsx
  - main/src/services/streamParser/streamParser.ts
  - main/src/services/streamParser/eventRouter.ts
  - main/src/services/streamParser/typedEventNarrowing.ts
acceptance_criteria:
  - criterion: "frontend/src/components/panels/ai/transformers/ClaudeMessageTransformer.ts no longer exists, OR is reduced to a thin stub that imports the projected message type from shared/types/unifiedMessage.ts and exports a passthrough transformer that does no parsing (renderer never sees raw JSONL)."
    verification: "Either: test -f frontend/src/components/panels/ai/transformers/ClaudeMessageTransformer.ts returns exit 1 (deleted); OR cat frontend/src/components/panels/ai/transformers/ClaudeMessageTransformer.ts | wc -l shows <= 30 lines AND grep -n 'JSON.parse\\|tool_use\\|ContentBlock' frontend/src/components/panels/ai/transformers/ClaudeMessageTransformer.ts returns no matches."
  - criterion: "main/src/services/streamParser/messageProjection.ts exists and projects ClaudeStreamEvent (typed union from TASK-201) into the UnifiedMessage shape consumed by the renderer. The projection logic is the renderer-side parser's behavior, moved to main."
    verification: "grep -n \"export.*projectEventToMessage\\|export class MessageProjection\" main/src/services/streamParser/messageProjection.ts returns at least 1 match; pnpm --filter main test -- messageProjection.test.ts passes."
  - criterion: shared/types/unifiedMessage.ts defines the UnifiedMessage type as a shared contract between main and renderer. Both processes import the same type — no duplicated definitions.
    verification: "grep -n \"export.*UnifiedMessage\" shared/types/unifiedMessage.ts returns 1 match; grep -rn \"from.*['\\\"]\\(\\.\\./\\)\\+shared/types/unifiedMessage['\\\"]\" frontend/src main/src returns at least 2 matches (one from each process)."
  - criterion: "RichOutputWithSidebar.tsx and ClaudePanel.tsx no longer instantiate a ClaudeMessageTransformer that does JSON parsing. They either receive pre-projected UnifiedMessage[] directly from main, or use a passthrough that asserts the input is already in UnifiedMessage shape."
    verification: "grep -n \"new ClaudeMessageTransformer\" frontend/src/components/panels/claude/ClaudePanel.tsx frontend/src/components/panels/claude/RichOutputWithSidebar.tsx returns matches only against the passthrough stub (verify by reading the context lines — the constructor must not perform parsing logic). Run: grep -rn 'JSON.parse' frontend/src/components/panels/ai/transformers/ClaudeMessageTransformer.ts returns 0 matches."
  - criterion: "messageProjection.test.ts asserts that feeding a captured stream-json fixture through ClaudeStreamParser + MessageProjection yields the same UnifiedMessage[] sequence that the OLD renderer-side ClaudeMessageTransformer would have produced for the same input. Behavior parity is the gate."
    verification: "pnpm --filter main test -- messageProjection.test.ts passes; test imports a frozen snapshot of expected UnifiedMessage[] (captured by running the old transformer on a fixture before deletion), runs the new main-side pipeline, asserts deep equality."
  - criterion: "Renderer no longer parses raw JSONL. grep -rn \"JSON.parse\" frontend/src/components/panels/claude/ frontend/src/components/panels/ai/transformers/ returns no matches against parsing logic (matches inside the stub or against the literal string in a comment are acceptable; verify by reading context)."
    verification: "grep -rn 'JSON.parse' frontend/src/components/panels/claude/ frontend/src/components/panels/ai/transformers/ClaudeMessageTransformer.ts shows at most matches that are not parsing logic (e.g., empty stub file or doc comment). Run the grep manually and visually confirm zero parser logic remains."
depends_on:
  - TASK-201
  - TASK-203
estimated_complexity: high
epic: stream-parser-to-main
test_strategy:
  needed: true
  justification: "This is the renderer-vs-orchestrator drift elimination. The behavior-parity test (old transformer output vs. new main-side projection output) is the only way to prove the migration is lossless. Without it, the renderer silently renders different content than before — invisible regression."
  targets:
    - behavior: "Fixture stream-json → ClaudeStreamParser → MessageProjection produces UnifiedMessage[] identical to what the OLD ClaudeMessageTransformer would have produced for the same input."
      test_file: main/src/services/streamParser/__tests__/messageProjection.test.ts
      type: integration
    - behavior: "Each variant (system/init, system/compact, assistant with tool_use, assistant with thinking, user with tool_result, result/success, result/error_during_execution, unknown) projects to the correct UnifiedMessage shape."
      test_file: main/src/services/streamParser/__tests__/messageProjection.test.ts
      type: integration
    - behavior: "Tool-result content as string vs. content as [{type:'text', text:'...'}] both project equivalently (matches the inconsistent encoding noted in architecture research §1)."
      test_file: main/src/services/streamParser/__tests__/messageProjection.test.ts
      type: integration
---
# Replace renderer ClaudeMessageTransformer with tRPC subscription to main-process projection

## Objective

Eliminate renderer-side stream-json parsing. Move the existing `ClaudeMessageTransformer` logic (in `frontend/src/components/panels/ai/transformers/`) to a main-process `MessageProjection` reducer that consumes the typed `ClaudeStreamEvent` union from TASK-201's parser. The renderer receives already-projected `UnifiedMessage[]` and never touches raw JSONL again. This is the single-source-of-truth fix that eliminates the renderer-vs-orchestrator drift the design doc §6.2 calls out as a day-1 discipline.

Note on tRPC subscription transport: the IDEA-005 frontmatter and design doc §6.2 reference a "tRPC subscription" as the wire format. However, tRPC v11 + `trpc-electron` are net-new dependencies that the codebase does not yet carry (per architecture research §3 and ecosystem research §3). The full tRPC wiring is a separate epic. This task therefore implements the **main-side projection and renderer-side consumption** using Crystal's existing IPC event channel (`window.electron?.on(outputEventName, ...)` per `RichOutputView.tsx`) — the same channel already used for renderer output. When the tRPC subscription wiring lands later, the renderer-side subscription source swaps, but the main-side projection and the UnifiedMessage contract do not change. This sequencing is captured under "Lowest Confidence Area" below.

## Implementation Steps

1. Create `shared/types/unifiedMessage.ts`. Move the `UnifiedMessage`, `MessageSegment`, `ToolCall`, `ToolResult` type definitions out of `frontend/src/components/panels/ai/transformers/MessageTransformer.ts` (currently a renderer-private file) and into the shared `shared/types/` directory so both main and renderer can import the same contract. Update `frontend/src/components/panels/ai/transformers/MessageTransformer.ts` to re-export from `shared/types/unifiedMessage.ts` for backward compatibility with other renderer files (CodexMessageTransformer, RichOutputView).

2. Create `main/src/services/streamParser/messageProjection.ts`. Export class `MessageProjection` with constructor `(runId: string, logger?: Logger)`. Method `project(event: ClaudeStreamEvent): UnifiedMessage | UnifiedMessage[] | null` that takes one typed event and returns the projected message(s) — null if the event does not produce a renderable message (e.g., `stream_event` deltas are absorbed but don't emit a complete message). Port the logic from the existing `frontend/.../ClaudeMessageTransformer.ts` (read it in `files_readonly`), preserving:
   - `parseUserMessage` / `parseAssistantMessage` / `parseSystemMessage` / `parseResultMessage` shape mapping
   - Slash-command extraction (`<local-command-stdout>` tag handling)
   - Tool-call/tool-result correlation via `tool_use_id`
   - Sub-agent (`parent_tool_use_id`) parent/child relationship building
   - Thinking-block rendering
   - Synthetic error detection (`message.model === '<synthetic>'`)
   
   The key shift: the old transformer received a batched array (`transform(rawMessages[])`) and ran three passes over it. The new projection is **streaming** — one event in, zero-or-more messages out. State that the old code maintained across passes (the `toolResults` map, the `parentToolMap`, the `allToolCalls` map) lives on the `MessageProjection` instance as private fields and is updated incrementally per event.

3. Wire `MessageProjection` to the `EventRouter` from TASK-201. For each runId, the orchestrator creates one `MessageProjection` instance and subscribes it to the router. The projection emits `UnifiedMessage` updates via an EventEmitter (or pushes through the existing Crystal IPC `outputEventName` channel — the renderer already listens on it via `window.electron?.on(outputEventName, handleOutputAvailable)` per `frontend/src/components/panels/ai/RichOutputView.tsx`). Use the existing channel; do not introduce a new IPC surface in this task.

4. Update `frontend/src/components/panels/claude/ClaudePanel.tsx` and `frontend/src/components/panels/claude/RichOutputWithSidebar.tsx`. The current code (`ClaudePanel.tsx` line 31: `React.useMemo(() => new ClaudeMessageTransformer(), [])` and `RichOutputWithSidebar.tsx` line 76: `messageTransformer={transformer || new ClaudeMessageTransformer()}`) instantiates the transformer for client-side parsing. Replace those instantiations with a passthrough `IdentityMessageTransformer` that asserts the incoming data is already in `UnifiedMessage` shape (since main has done the projection). Alternatively, refactor the `messageTransformer` prop out of `RichOutputView` for the Claude path — but that ripples into `CodexMessageTransformer` which is still active. Safest: keep the prop, swap the value for an identity transformer.

5. Reduce `frontend/src/components/panels/ai/transformers/ClaudeMessageTransformer.ts` to a thin stub: import `UnifiedMessage` from `shared/types/unifiedMessage.ts`, export a class implementing `MessageTransformer` where `transform(messages: UnifiedMessage[]): UnifiedMessage[] { return messages; }` and the other methods (`supportsStreaming`, etc.) return the same values they did before. ALL parsing logic is gone from this file. Add a comment block at the top: `// @cyboflow-stub — parsing has moved to main/src/services/streamParser/messageProjection.ts. This file is retained as an IdentityMessageTransformer for compatibility with the renderer's MessageTransformer prop contract. DO NOT add parsing logic here.`

6. Write `main/src/services/streamParser/__tests__/messageProjection.test.ts`. The test strategy is **behavior parity**:
   - Before deleting the old transformer logic, run the old transformer against captured stream-json fixtures and serialize the resulting `UnifiedMessage[]` to a JSON snapshot file under `main/src/services/streamParser/__fixtures__/expected-messages.json`. (Do this BEFORE step 5 so the snapshot reflects pre-migration behavior.)
   - In the test, feed the same fixtures through `ClaudeStreamParser` → `MessageProjection`, collect the emitted `UnifiedMessage[]`, and assert deep equality against the snapshot.
   - Include variant-specific cases: system/init, system/compact, assistant with tool_use, assistant with thinking, user with tool_result (string content), user with tool_result (array content), result/success, result/error_during_execution, and an unknown variant.

7. Run the grep completeness gate: `grep -rn 'JSON.parse' frontend/src/components/panels/claude/ frontend/src/components/panels/ai/transformers/ClaudeMessageTransformer.ts` — should return zero parsing-logic matches. Run `grep -rn 'tool_use\|ContentBlock\|tool_result' frontend/src/components/panels/ai/transformers/ClaudeMessageTransformer.ts` — should return zero (parsing logic gone). This is step 1 of acceptance verification per the sweep-grep rule (5d).

## Acceptance Criteria

- Renderer files (`ClaudePanel.tsx`, `RichOutputWithSidebar.tsx`) no longer instantiate a parsing transformer for Claude. They use an identity passthrough.
- `ClaudeMessageTransformer.ts` is either deleted or reduced to <= 30 lines of stub code with no parsing logic. All `JSON.parse`, `ContentBlock`, `tool_use`, `tool_result` parsing references are gone from this file.
- `main/src/services/streamParser/messageProjection.ts` exists and implements the projection. Test file passes behavior-parity assertions against the pre-migration snapshot.
- `shared/types/unifiedMessage.ts` is the single home of the `UnifiedMessage` contract; both main and renderer import from it.
- The renderer continues to render Claude sessions correctly (sanity check by running the app and starting a session — covered by integration smoke once the orchestrator wiring lands; this task's automated gate is the parity test).

## Test Strategy

See frontmatter. Behavior parity is the load-bearing assertion: capture the OLD transformer's output for a fixture, then prove the NEW main-side pipeline produces deep-equal output. This is the only way to guarantee no UI-visible regression. Variant coverage in the parity test must include all 7+ event types named in IDEA-003's union, plus the inconsistent tool-result encoding case (string vs. array — flagged in architecture research §1).

## Hardest Decision

Whether to delete `ClaudeMessageTransformer.ts` entirely vs. keep a thin identity stub. Chose: keep an identity stub. The `MessageTransformer` prop is wired through `RichOutputView` and reused for the Codex panel (`CodexMessageTransformer` is still active). Removing the prop entirely is a larger refactor that touches Codex code, which is out of scope (and `crystal-cuts-and-rebrand` epic deletes Codex anyway — but that's a separate epic). The identity stub is a 10-line bridge that lets the migration land cleanly; once `crystal-cuts-and-rebrand` removes Codex, a follow-up can remove the prop entirely.

## Rejected Alternatives

- **Wire the renderer to a tRPC subscription in this task.** Rejected — tRPC v11 + `trpc-electron` are not installed yet (architecture research §3) and adding them is a separate epic with its own day-1 discipline tasks. Doing it here would balloon scope and block this task on dependency provisioning. The existing IPC channel works; the swap to tRPC is a follow-up task that changes the renderer-side subscription source but not the contract.
- **Keep the renderer-side parser as a fallback for legacy code paths.** Rejected — the design doc §6.2 commits to a single source of truth. Keeping two parsers (one in main for new flows, one in renderer for legacy) re-introduces the drift this task is supposed to eliminate.
- **Project events lazily on the renderer when first rendered.** Rejected — the projection must happen in main so the orchestrator-side approval router, raw_events sink, and downstream reducers see the same event interpretation as the UI. Lazy renderer projection breaks the single-source-of-truth invariant.

## Lowest Confidence Area

The transport story. IDEA-005's frontmatter and the design doc §6.2 specify a tRPC subscription as the wire. tRPC v11 + `trpc-electron` are not in the project's package.json (verified via grep). I've sequenced this task to use Crystal's existing `outputEventName` IPC channel as the transport, with a clear migration path to tRPC when that epic lands. The risk is that another concurrent task may add tRPC infrastructure mid-flight and the executor of this task picks up that infrastructure inconsistently. The mitigation: the `UnifiedMessage` contract in `shared/types/unifiedMessage.ts` is transport-agnostic — whether the bytes arrive via Electron IPC or via a tRPC subscription, the renderer code is unchanged. Confidence in the contract is high; confidence in the chosen transport is moderate until the orchestration/tRPC task is refined.
