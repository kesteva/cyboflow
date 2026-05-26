---
id: IDEA-025-research
idea: IDEA-025
created: 2026-05-26T00:00:00Z
---

# Research Report: Bottom-Pane Three-Tab Restructure with AskUserQuestion Round-Trip

## Library Comparison

### Slice 4 — AskUserQuestion card UI (MarkdownPreview)

No external libraries needed for the markdown rendering surface. `MarkdownPreview.tsx` already exists at `frontend/src/components/MarkdownPreview.tsx` (confirmed present). It imports `react-markdown` and `remark-gfm` and is fully wired with Mermaid support. Its prop signature is `{ content: string; className?: string; id?: string }`. AskUserQuestionCard can use it directly for option `preview` rendering by wrapping the per-option `preview` string in `<MarkdownPreview content={option.preview} />` inside a collapsible panel.

### Slice 1 — Three-tab bottom pane shell (tab switcher)

No external libraries needed. The codebase has one tab-bar component — `frontend/src/components/panels/PanelTabBar.tsx` — but it is a full panel management component (closeable panels, rename support, git branch display, diff panel guards). It is not reusable at the lightweight three-tab local-state level required by `RunBottomPane`.

The `frontend/src/components/ui/` directory contains: `Button`, `Toggle`, `TogglePillImproved`, `SwitchSimple`, `Switch`, `Pill`, `Badge`, `Dropdown`, `Modal`, `CollapsibleCard`, `Select`, `Textarea`, `Input`, `Tooltip`, `StatusDot`. None is a multi-option tab switcher.

**Recommendation:** write a minimal vendor-free `<LocalTabBar tabs={[...]} activeTab={...} onTabChange={...} />` component directly in the `RunBottomPane` file or alongside it — ~30 lines of Tailwind CSS. No Radix, no shadcn; matches the project's existing pattern.

---

## Best Practices

### AskUserQuestion Interception (Slice 2 — QuestionRouter)

The official Anthropic docs at [https://code.claude.com/docs/en/agent-sdk/user-input](https://code.claude.com/docs/en/agent-sdk/user-input) establish the canonical pattern. Key findings:

**AskUserQuestion is intercepted via `canUseTool`, not via a `PreToolUse` hook.** The `canUseTool` callback is the primary async gate for both tool-permission prompts and AskUserQuestion. It fires synchronously before tool execution and the agent is paused until the callback returns, matching exactly the pending-promise pattern.

However: cyboflow does not currently use `canUseTool` — it uses `PreToolUse` hooks via `makePreToolUseHook` in `claudeCodeManager.ts`. The docs confirm that `PreToolUse` hooks **also fire for AskUserQuestion** (hooks fire before `canUseTool` and can allow, deny, or modify requests). The `PreToolUseHookInput.tool_name` will equal `"AskUserQuestion"` and `PreToolUseHookInput.tool_input` will be the full `AskUserQuestionInput` object.

**PreToolUse + `updatedInput` is the hook-layer intercept path.** To pass the user's answer back via the `PreToolUse` hook, the hook must:
1. Park the `AskUserQuestionInput` as a pending promise.
2. Return `{ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { questions: [...], answers: {...} } } }`.

The `updatedInput` replaces the original `tool_input` for execution. When the SDK executes `AskUserQuestion` with an `updatedInput` that contains `answers`, the SDK synthesizes the `tool_result` from those answers — the hook does **not** need to inject a tool_result message into the stream manually.

Source: [https://code.claude.com/docs/en/agent-sdk/hooks](https://code.claude.com/docs/en/agent-sdk/hooks) — "For `PreToolUse` hooks, this is where you set `permissionDecision` ... and `updatedInput`. When using `updatedInput`, you must also include `permissionDecision: 'allow'`."

Source: [https://code.claude.com/docs/en/agent-sdk/user-input](https://code.claude.com/docs/en/agent-sdk/user-input) — step-by-step AskUserQuestion handling.

### SQLite CHECK constraint migration pattern

SQLite does not support `ALTER TABLE ... DROP CONSTRAINT` or `ALTER TABLE ... ADD CONSTRAINT`. Adding a new value to a `CHECK (status IN (...))` constraint requires the "create-new-table + copy + swap" recipe. Migrations 007 and 009 show `ALTER TABLE ADD COLUMN` (which SQLite supports). The `workflow_runs` status CHECK constraint in migration 006 cannot be altered with `ALTER TABLE` — a new migration must:
1. `CREATE TABLE workflow_runs_new (..., CHECK (status IN ('queued', ..., 'awaiting_input')))`.
2. `INSERT INTO workflow_runs_new SELECT ... FROM workflow_runs`.
3. `DROP TABLE workflow_runs`.
4. `ALTER TABLE workflow_runs_new RENAME TO workflow_runs`.
5. Re-create all indexes.

This is migration 010 scope, not a simple `ALTER TABLE`.

---

## API Documentation

### Claude Agent SDK — AskUserQuestion tool

- **Package:** `@anthropic-ai/claude-agent-sdk@0.2.141` (installed at `node_modules/.pnpm/@anthropic-ai+claude-agent-sdk@0.2.141_zod@3.25.76/`)
- **Auth:** no separate auth; uses the same session as the running query
- **Tool input type:** `AskUserQuestionInput` (defined in `sdk-tools.d.ts` line 584) — `{ questions: [1-4 items, each with { question, header, options[2-4 with label/description/preview?], multiSelect }] }`
- **Tool output type:** `AskUserQuestionOutput` (defined in `sdk-tools.d.ts` line 2620) — `{ questions: [...], answers: { [questionText: string]: string }, annotations?: { [questionText: string]: { preview?: string; notes?: string } } }`
- **Answer format:** `answers` is keyed by the full `question` text (not the `header`). Values are the selected option's `label`. Multi-select values are comma-separated labels or an array.
- **PreToolUse hook input type:** `PreToolUseHookInput` (sdk.d.ts line 1992) — `{ hook_event_name: 'PreToolUse', tool_name: string, tool_input: unknown, tool_use_id: string }`
- **PreToolUse hook return shape for answering:** `{ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { questions: [...], answers: { [questionText]: labelString } } } }`
- **`toolConfig.askUserQuestion.previewFormat`:** `'markdown' | 'html'` (default: `'markdown'`). Must be set in `Options.toolConfig` to instruct the model to emit `preview` fields. Without it, `preview` is always absent.
- **Docs URL:** [https://code.claude.com/docs/en/agent-sdk/user-input](https://code.claude.com/docs/en/agent-sdk/user-input)

---

## Prior Art

- **Anthropic official example — TypeScript AskUserQuestion terminal handler:** [https://code.claude.com/docs/en/agent-sdk/user-input](https://code.claude.com/docs/en/agent-sdk/user-input) — shows the complete `canUseTool` pattern, `updatedInput` shape with `{ questions, answers }`, and the "Other" free-text pattern. This is the direct implementation reference for the QuestionRouter's `updatedInput` return value shape.

- **PreToolUse hook for blocking/modifying — Anthropic official example:** [https://code.claude.com/docs/en/agent-sdk/hooks](https://code.claude.com/docs/en/agent-sdk/hooks) — shows the exact `hookSpecificOutput.updatedInput` pattern alongside `permissionDecision: 'allow'`. cyboflow's existing `preToolUseHookHelper.ts` already follows this contract for `permissionDecision` but does not currently use `updatedInput`.

---

## Answered Questions

- **Q: Which SDK hook fires for AskUserQuestion — PreToolUse, PostToolUse, or something else?**
- **A:** `PreToolUse` fires for `AskUserQuestion`, with `tool_name === 'AskUserQuestion'` and the full `AskUserQuestionInput` in `tool_input`. There is no dedicated AskUserQuestion-specific hook event. The tool does NOT need to be registered via `mcpServers` — it is a built-in SDK tool. The canonical consumer-facing API is `canUseTool`, but `PreToolUse` hooks fire before `canUseTool` and can intercept the call at the same async gate. Both produce the same pendable-promise semantics. Since cyboflow already uses `PreToolUse` hooks for `ApprovalRouter`, the `QuestionRouter` should hook at `PreToolUse` as well — branch on `pretool.tool_name === 'AskUserQuestion'` in `makePreToolUseHook`.
- **Source:** [https://code.claude.com/docs/en/agent-sdk/user-input](https://code.claude.com/docs/en/agent-sdk/user-input) — "Both trigger your `canUseTool` callback ... To automatically allow or deny tools without prompting users, use hooks instead. Hooks execute before `canUseTool`."

- **Q: What is the hook return contract for passing the user's answer back?**
- **A:** The `PreToolUse` hook must return `{ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { questions: <original input.questions>, answers: { [questionText]: selectedLabel } } } }`. The SDK uses the `updatedInput` as the tool input during execution, which causes the AskUserQuestion tool to execute with the pre-populated answers and synthesize the `tool_result` automatically. The hook does NOT inject a `tool_result` message manually.
- **Source:** sdk.d.ts line 1999–2005 (`PreToolUseHookSpecificOutput` type) + [https://code.claude.com/docs/en/agent-sdk/hooks](https://code.claude.com/docs/en/agent-sdk/hooks) `updatedInput` example + [https://code.claude.com/docs/en/agent-sdk/user-input](https://code.claude.com/docs/en/agent-sdk/user-input) Step 5 return shape.

- **Q: Does the `messages` table have a write path?**
- **A:** No external answer needed; directly verified by codebase inspection. No `INSERT INTO messages` statements exist anywhere in `main/src`. The `messages` table was created in migration 006 as a "derived conversation view" placeholder but has no active write path as of the current codebase. This is a material correction to Assumption 4 (see below).

- **Q: Does the `previewFormat` option need to be set for `preview` fields to appear?**
- **A:** Yes. The `toolConfig.askUserQuestion.previewFormat` must be set to `'markdown'` or `'html'` in the `Options` object passed to `query()`. Without it, Claude does not generate `preview` fields even if the questions array supports them. This is set in `claudeCodeManager.ts` when building the SDK options.
- **Source:** sdk.d.ts line 1643–1656 (`ToolConfig` type) + [https://code.claude.com/docs/en/agent-sdk/user-input](https://code.claude.com/docs/en/agent-sdk/user-input) Option Previews section.

---

## Validated Assumptions

### Assumption 1: AskUserQuestion appears as a `tool_use` block in the assistant stream

- **Evidence:** Confirmed by the SDK type definitions. `AskUserQuestionInput` and `AskUserQuestionOutput` are members of `ToolInputSchemas` and `ToolOutputSchemas` in `sdk-tools.d.ts` (lines 29 and 54). The `PreToolUseHookInput` type (`sdk.d.ts` line 1992) carries `tool_name: string` and `tool_use_id: string`, identical to all other tool calls. The Anthropic docs confirm: "Claude calls the `AskUserQuestion` tool" and the hook fires with `tool_name === 'AskUserQuestion'`. There is no separate event type or first-class async mechanism — it is a standard tool call in the assistant stream, detectable via `block.type === 'tool_use' && block.name === 'AskUserQuestion'` in the existing `AssistantEventRow` branch.
- **Updated confidence:** high

### Assumption 2: The questions table can be migration 010 without touching the 006 CHECK constraint

- **Evidence:** This assumption's validity depends on whether `awaiting_input` status is added. The IDEA's resolved Q2 confirms `awaiting_input` IS being added. The migration 006 `workflow_runs` table at line 22 has: `CHECK (status IN ('queued', 'starting', 'running', 'awaiting_review', 'stuck', 'completed', 'failed', 'canceled'))`. SQLite's `ALTER TABLE` does not support modifying CHECK constraints; the full table-recreation recipe is required. Migrations 007 and 009 confirm the project uses simple `ALTER TABLE ADD COLUMN` where possible, but this constraint change cannot use that path.
- **Updated confidence (for the migration 010 approach alone):** medium — migration 010 can add the `questions` table cleanly, but a second migration (or the same migration) must also recreate `workflow_runs` with an updated CHECK constraint using the create-new-table-copy-swap recipe. This is distinct from the simple `ALTER TABLE ADD COLUMN` pattern used in migrations 007 and 009. The refiner should plan for this additional migration complexity.

### Assumption 3: QuestionRouter's per-run p-queue is deadlock-safe (separate from RunQueueRegistry)

- **Evidence:** Confirmed by `approvalRouter.ts` §3 comment (lines 17–21): "Both requestApproval and respond submit their mutations via an ApprovalRouter-owned per-run p-queue (this.approvalQueues), ensuring serialization of all approval-mutations for the same run. This queue is intentionally separate from RunQueueRegistry's per-run queue: that queue hosts the long-running runExecutor.execute() task, and re-entering it from inside a PreToolUse hook would self-deadlock." Since `AskUserQuestion` is intercepted at the same `PreToolUse` hook from inside `runSdkQuery`'s `for await` loop (same code path as approvals), the same invariant applies. `QuestionRouter` must own its own per-run p-queue.
- **Updated confidence:** high (already high; confirmed by existing documented invariant)

### Assumption 4: The existing `messages` table rows contain tool_use content blocks within assistant content_json

- **Evidence (REFUTED):** The `messages` table has no write path. A comprehensive grep for `INSERT INTO messages` across `main/src` returns zero matches. The test at `main/src/orchestrator/__test_fixtures__/__tests__/orchestratorTestDb.test.ts` line 290 explicitly notes: "messages table is intentionally absent from GATE_SCHEMA." `RawEventsSink` (`main/src/services/streamParser/rawEventsSink.ts`) writes to `raw_events`, not `messages`. `MessageProjection` (`main/src/services/streamParser/messageProjection.ts`) transforms events to `UnifiedMessage` in-memory for the renderer, but writes nothing to the DB.
- **Impact:** HIGH — the planned `cyboflow.runs.listMessages` tRPC query (from IDEA-025 resolved Q3) cannot read from `messages` because the table is empty. The Chat tab's load-on-select DB query has no data source. The actual message history lives in `raw_events` (every `ClaudeStreamEvent` row in `payload_json`) or in the in-memory `streamEvents` in `cyboflowStore`. Slice 5 (`RunChatView`) must either: (a) read from `raw_events` and reconstruct messages via the same `MessageProjection` logic, or (b) use `cyboflowStore.streamEvents` filtered client-side. The messages table write path is a prerequisite for the `listMessages` query approach — it is unimplemented scope, not a ready-to-query table.
- **Updated confidence:** low (assumption is refuted — the table is empty by design at this point)

### Assumption 5: Three-tab shell needs no changes to cyboflowStore

- **Evidence:** Confirmed. `cyboflowStore.ts` owns `activeRunId`, `activeQuickSessionId`, and `streamEvents`. `PanelTabBar.tsx` and other components confirm these are the primary state for all run-view content. No evidence of required store changes.
- **Updated confidence:** high

### Assumption 6: ReviewQueueView stays unchanged

- **Evidence:** Confirmed. The `Approval` type in `shared/types/approvals.ts` carries `runId`, enabling per-run filtering client-side. No evidence of required changes.
- **Updated confidence:** high

---

## Risks

### Risk 1 — Critical: `messages` table has no write path (Assumption 4 refuted)

The resolved Q3 answer in the IDEA ("New `cyboflow.runs.listMessages` tRPC query reading from the messages table") rests on a false premise. The messages table is empty; there is no `RawEventsSink`-equivalent that writes to it. Before `listMessages` can work, a `MessageProjectionSink` (analogous to `RawEventsSink`) must be implemented that writes `UnifiedMessage` or raw assistant/user content rows to the `messages` table during SDK event processing. This is new unplanned scope for Slice 5 and possibly Slice 2. The alternative — client-side filter over `streamEvents` — is functional for the current session but loses history on reload. The refiner must choose between: (a) accepting the reload-loses-history limitation and using `streamEvents` only, (b) adding a messages-table write path as additional Slice 5 scope, or (c) querying `raw_events` directly with JSON extraction via SQLite's `json_extract()`.

### Risk 2 — Medium: SQLite CHECK constraint update requires table recreation

Adding `awaiting_input` to the `workflow_runs.status` CHECK constraint (resolved Q2 answer) cannot use `ALTER TABLE ADD COLUMN`. Migration 010 (or a migration 011) must use the full table-recreation recipe. This is boilerplate but non-trivial: all five indexes on `workflow_runs` must be re-created, and the migration must be tested for data preservation. Reference: [SQLite FAQ — ALTER TABLE](https://www.sqlite.org/faq.html#q11) — "SQLite supports a limited subset of ALTER TABLE. The ALTER TABLE command in SQLite allows the user to rename a table or to add a new column to an existing table. It is not possible to rename a column, remove a column, or add or remove constraints from a table."

### Risk 3 — Medium: `canUseTool` vs `PreToolUse` hook layering

The Anthropic docs state hooks fire **before** `canUseTool`. cyboflow uses `PreToolUse` hooks (not `canUseTool`). If a `PreToolUse` hook returns `permissionDecision: 'allow'` with `updatedInput`, the `canUseTool` callback is NOT invoked for that tool call (the hook short-circuits it). This means cyboflow's existing `makePreToolUseHook` already handles the full permission gating path and adding the AskUserQuestion branch there is architecturally correct. However: the docs also note "In Python, `can_use_tool` requires streaming mode and a `PreToolUse` hook that returns `{"continue_": True}` to keep the stream open." In TypeScript there is no equivalent workaround needed — `canUseTool` is not used and hooks are the sole gate.

### Risk 4 — Low: `AskUserQuestion` not available in subagents

Per the Anthropic docs user-input page Limitations section: "`AskUserQuestion` is not currently available in subagents spawned via the Agent tool." If cyboflow workflows use sub-agent patterns (`AgentInput` tool calls), those sub-agents cannot call `AskUserQuestion`. The QuestionRouter only needs to handle top-level run questions. No action required unless the product scope includes sub-agent questioning.

### Risk 5 — Low: `toolConfig.askUserQuestion.previewFormat` must be set to get `preview` content

If `Options.toolConfig.askUserQuestion.previewFormat` is not set in `claudeCodeManager.ts`, Claude will never emit `preview` fields on options even if the session's questions would benefit from them. The `AskUserQuestionCard` should handle `preview === undefined` gracefully regardless, but the feature will be dormant until the option is set. This is a configuration decision for `claudeCodeManager.ts`'s SDK options builder.
