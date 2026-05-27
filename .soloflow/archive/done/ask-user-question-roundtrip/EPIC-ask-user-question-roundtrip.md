---
epic: ask-user-question-roundtrip
created: 2026-05-26T00:00:00Z
status: active
originating_ideas: [IDEA-025]
---

# AskUserQuestion Agent Round-Trip

## Objective

Enable cyboflow to intercept the Claude Agent SDK's built-in `AskUserQuestion` tool call, persist the question to a new `questions` SQLite table, expose it over tRPC to the renderer, render an interactive card the user can answer, and feed the answer back to the agent via the `PreToolUse` hook's `updatedInput: { questions, answers }` payload — unblocking the agent so it can continue rather than stalling indefinitely.

The implementation mirrors `ApprovalRouter`'s established pattern: a singleton main-process router holding pending promises serialized by a per-run PQueue, a tRPC sub-router exposing `listPending` / `answer` / `onQuestionCreated` / `onQuestionAnswered`, and a Zustand `questionStore` that performs full-state resync on `init()` plus delta subscriptions. The SDK hook intercept is added as a `tool_name === 'AskUserQuestion'` branch in `claudeCodeManager.makePreToolUseHook`. The `messages` table is intentionally NOT used as a data source (it has no write path); the Chat-tab message backlog reads from `raw_events` via SQLite `json_extract()` in a new `cyboflow.runs.listMessages` procedure shipped alongside the questions router.

## Scope

- In scope:
  - `QuestionRouter` main-process singleton (per-run PQueue, pending Map, `requestQuestion` / `respond` / `clearPendingForRun` / `recoverStaleAwaitingInput`)
  - Migration 010: `questions` table + `workflow_runs.status` CHECK-constraint update adding `'awaiting_input'` via SQLite's table-recreation recipe
  - `'awaiting_input'` added to `WorkflowRunStatus` union and `ALLOWED_TRANSITIONS`; StuckDetector exemption verified
  - `PreToolUse` branch in `claudeCodeManager.makePreToolUseHook` routing `AskUserQuestion` to `QuestionRouter`
  - `toolConfig.askUserQuestion.previewFormat = 'markdown'` set in the SDK options builder
  - `tRPC` `cyboflow.questions` router (listPending, answer, subscriptions) and `cyboflow.runs.listMessages` query
  - `shared/types/questions.ts` and `shared/types/chatMessage.ts` wire types
  - `AskUserQuestionCard` UI component (chip header, radio/checkbox option groups, optional MarkdownPreview, implicit "Other" free-text)
  - `questionStore` frontend Zustand store (init + delta subscriptions)
- Out of scope:
  - Chat tab layout wiring (owned by `per-run-chat-surface` epic)
  - Mode-gated chat input bar (owned by `per-run-chat-surface` epic)
  - Global pending-questions queue view (future IDEA — cross-run question triage panel)
  - Timeout / auto-answer policy (deliberately omitted — the IDEA's resolved spec is "no timeout, pending until the user triages")
  - AskUserQuestion in sub-agents (per SDK docs, not available there)

## Success Signal

An agent workflow that calls `AskUserQuestion` during a `cyboflow` run presents an interactive card to the user (eventually surfaced in the Chat tab by the `per-run-chat-surface` epic). Selecting an answer unblocks the agent (verified via the SDK's `updatedInput.answers` synthesis of the `tool_result`), and the run continues to completion. The `questions` row in the DB reflects status='answered' with the recorded `answer_json`. The workflow_run status transitions `running → awaiting_input → running` cleanly around the gate. A renderer reload while a question is pending re-hydrates the queue via `listPending`.

## Tasks

- TASK-757 — Shared Question types and DB migration 010
- TASK-758 — QuestionRouter singleton, PreToolUse hook intercept, SDK toolConfig wiring
- TASK-759 — tRPC questions router, listMessages query, root wiring
- TASK-760 — AskUserQuestionCard UI and questionStore
