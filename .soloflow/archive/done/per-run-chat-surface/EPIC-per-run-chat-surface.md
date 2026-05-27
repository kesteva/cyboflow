---
epic: per-run-chat-surface
created: 2026-05-26T00:00:00Z
status: active
originating_ideas: [IDEA-025]
---

# Per-Run Chat Tab Surface

## Objective

Populate the Chat tab created by the `bottom-pane-restructure` epic with the curated per-run conversation: user-prompt and assistant-text message bubbles filtered from the same underlying SDK stream, inline `AskUserQuestionCard` instances at the position of their `tool_use` event, inline `PendingApprovalCard` instances scoped to the active run, and a mode-gated text-input bar at the bottom.

This epic replaces today's raw-JSON `tool: AskUserQuestion` placeholder with an interactive surface. Chat-input behavior is mode-gated: Quick-session mode allows free interactive chat (dispatched via the existing `sessions:input` IPC channel); workflow-run mode disables the input except when a pending question is open, in which case the typed text forwards as the active question's "Other" free-text answer (the `AskUserQuestionCard` retains exclusive authority over the answers payload submission).

The global `ReviewQueueView` panel (cross-run pending list) stays unchanged — the inline Chat-tab approval cards are a same-data filtered view of the same `reviewQueueStore.queue`.

## Scope

- In scope:
  - `RunChatView` component — historical message load via `cyboflow.runs.listMessages` query merged with live `cyboflowStore.streamEvents` deltas; user/assistant bubbles via `MarkdownPreview`; inline `AskUserQuestionCard` at `tool_use` positions; per-run filtered `PendingApprovalCard` instances
  - `ChatInput` mode-gated text-input bar
  - Single-line stitch in `RunBottomPane` Chat tab to mount `<RunChatView />`
  - Single-line stitch in `RunChatView` to mount `<ChatInput />` at the bottom
- Out of scope:
  - `messages` table write path (the IDEA's Risk 1 was resolved by reading from `raw_events` directly via `json_extract()` in `cyboflow.runs.listMessages` — that procedure is owned by the `ask-user-question-roundtrip` epic)
  - `onStreamEvent` tRPC subscription implementation (current placeholder remains)
  - Terminal tab wiring
  - Global `ReviewQueueView` changes
  - Quick-session message history renderer (the existing `PanelContainer` in `CyboflowRoot` continues to serve that history; Chat tab shows a placeholder in quick-session mode)

## Success Signal

Opening the Chat tab during a workflow run shows the run's conversation history (preserved across renderer reload), inlines an `AskUserQuestionCard` at the correct position when the agent calls the tool, and inlines per-run approval cards. Submitting an answer unblocks the agent (verified by the run continuing). The chat input is enabled in Quick-session mode and disabled-with-tooltip during workflow-runs with no pending question; when a question is pending, typing forwards the text as the "Other" answer.

## Tasks

- TASK-761 — `RunChatView` filtered conversation + inline cards
- TASK-762 — Mode-gated `ChatInput` bar
