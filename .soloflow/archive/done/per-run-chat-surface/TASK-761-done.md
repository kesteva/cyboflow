---
id: TASK-761
sprint: SPRINT-039
epic: per-run-chat-surface
status: done
summary: "Created RunChatView (filtered conversation + inline AskUserQuestionCard and PendingApprovalCard cards) and wired it into RunBottomPane's Chat tab, replacing TASK-756's placeholder. Sources history from trpc.cyboflow.runs.listMessages and merges live deltas from cyboflowStore.streamEvents."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: not_applicable
---

# TASK-761 — RunChatView with inline question + approval cards

## Outcome

- **`RunChatView`** at `frontend/src/components/cyboflow/RunChatView.tsx` — exports `RunChatView({ runId: string | null })`. On mount with non-null runId, calls `trpc.cyboflow.runs.listMessages.query({ runId })` and merges results with `cyboflowStore.streamEvents` filtered by runId. Renders user-prompt bubbles, assistant text via `MarkdownPreview`, AskUserQuestion tool_use blocks via `AskUserQuestionCard` (matched by `toolUseId === block.id`), other tool_use blocks as compact `tool:<name>` + JSON, and per-run-filtered `PendingApprovalCard`s. Quick-session mode renders a placeholder (no listMessages call). Empty state renders "No active run".
- **`RunBottomPane.tsx`** Chat tab now mounts `<RunChatView runId={activeRunId} />` (added selector for `activeRunId`; replaced TASK-756 placeholder block). Minimal targeted edit per AC8.
- **Tests** — 11 RunChatView tests cover all 5 plan targets plus 6 substantive extras (re-mount on runId change, user-block tool_result, "Question already answered" fallback, no-active-run placeholder, `is_error` red badge, aborted-flag stale-fetch guard). 5 RunBottomPane tests updated to mock RunChatView in place of the removed placeholder testid.

## Verification

- 9 ACs met (verifier APPROVED_WITH_DEFERRED).
- 11/11 RunChatView tests pass; 5/5 RunBottomPane tests pass.
- `pnpm --filter frontend typecheck` 0; root `pnpm typecheck` 0; `pnpm --filter frontend lint` 0.
- visual_macos check is genuinely deferred — recurring Peekaboo Accessibility TCC gap (already tracked in FIND-SPRINT-039-1; this run added a TASK-761 entry to the existing `visual_macos_unavailable` dedup key).

## Findings logged

- **FIND-SPRINT-039-10** (resolved in-task) — TASK-761 needed to update RunBottomPane.test.tsx because its old `run-bottom-pane-chat-placeholder` testid was removed when RunChatView replaced the placeholder. Plan listed the test file in files_owned; claim + update was AC-prescribed (AC8 + AC9).
- **FIND-SPRINT-039-11** — RunChatView merge logic does not dedupe overlapping historical + live events. Plan acknowledged as known low-cost defect; fix path: dedupe by message id or timestamp watermark.
- **FIND-SPRINT-039-12** — RunChatView duplicates RunView's `AssistantEventRow` tool_use rendering. Worth extracting a shared `ToolUseBlockRow` helper.

## Notes

- Chat tab is now actually live for the first time in this branch — visual smoke after Peekaboo TCC grant is recommended at sprint close (queued).
- `pnpm dev` boot path is coherent end-to-end: TASK-759 wired QuestionRouter.initialize + recoverStaleAwaitingInput in index.ts; TASK-761 surfaces the Chat tab content; AskUserQuestionCard renders inline when an `AskUserQuestion` tool_use lands. End-to-end agent → SDK hook → QuestionRouter → tRPC SSE → questionStore → AskUserQuestionCard → user submit → tRPC answer mutation → QuestionRouter.respond → updatedInput.answers → agent continuation chain is wired (though only the renderer side was added in this task).

## Commits

- `a58bc3b` — feat(TASK-761): RunChatView with filtered conversation + inline question and approval cards; wire into RunBottomPane Chat tab
- `e2d6b70` — test(TASK-761): cover is_error badge and aborted-flag stale-fetch guard
