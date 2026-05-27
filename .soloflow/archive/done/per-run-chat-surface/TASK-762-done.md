---
id: TASK-762
sprint: SPRINT-039
epic: per-run-chat-surface
status: done
summary: "Added mode-gated ChatInput bar (quick / workflow-question / workflow-idle / none) to the bottom of RunChatView, dispatching to API.sessions.sendInput in quick-session mode and to questionStore.setOtherText in workflow-question mode (does NOT call trpc.cyboflow.questions.answer.mutate). Extended questionStore with otherText forwarding bus (setOtherText/clearOtherText)."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: skipped_unable
---

# TASK-762 — Mode-gated ChatInput bar

## Outcome

- **`ChatInput`** at `frontend/src/components/cyboflow/ChatInput.tsx` — props `{ runId: string | null }`. Computes mode (`'quick' | 'workflow-question' | 'workflow-idle' | 'none'`) from cyboflowStore.activeQuickSessionId + questionStore.queue + runId. Renders the textarea + Send button, gated per mode. Quick mode dispatches via `API.sessions.sendInput(activeQuickSessionId, text)` (typed `IPCResponse<void>` explicit per CLAUDE.md). Workflow-question mode calls `questionStore.setOtherText(activeQuestion.id, text)`. Workflow-idle disables the textarea and wraps it in a Tooltip with the exact literal `Input enabled only when the agent asks a question`. None returns null. Enter sends (Shift+Enter inserts newline). On IPC failure, the textarea retains the text and an inline error renders so the user can retry.
- **`questionStore.ts`** extended with the `otherText` bus: `otherText: Record<string, string>` (keyed by questionId), plus `setOtherText(questionId, text)` and `clearOtherText(questionId)` reducers. Pre-authorized scope deviation per plan's Lowest Confidence Area.
- **`RunChatView.tsx`** surgical edit: added `import { ChatInput }` and `<ChatInput runId={runId} />` as the last child of the runId-non-null branch's root element. Plan-prescribed (Implementation Step 5).

## Verification

- All 7 ACs met (verifier APPROVED).
- 12 new ChatInput tests + 9 new questionStore otherText/bus tests + 1 replaceAll-doesn't-clear-otherText regression test pass.
- `pnpm --filter frontend typecheck` 0; root `pnpm typecheck` 0; `pnpm --filter frontend lint` 0.
- 4 pre-existing reviewQueueStore.test.ts failures remain pre-existing (FIND-SPRINT-039-2).
- visual_macos deferred to recurring Peekaboo Accessibility TCC grant (FIND-SPRINT-039-1).

## Findings

- **FIND-SPRINT-039-13** — Scope deviation for claiming `questionStore.ts` to add the otherText bus. Pre-authorized; explicitly anticipated by plan's Lowest Confidence Area.
- **FIND-SPRINT-039-14 (HIGH SEVERITY — follow-up required before epic archive)** — The otherText bus has a writer (ChatInput) but no reader (AskUserQuestionCard still uses its own local useState for Other text). Typing in the bottom bar populates `questionStore.otherText[questionId]` but the card stays empty. The epic-level success signal (`text typed here is forwarded as the 'Other' answer for the active AskUserQuestionCard`) is functionally broken until a follow-up task wires AskUserQuestionCard to read from `questionStore.otherText[item.id]` and to call `clearOtherText(item.id)` on submit. The follow-up also needs to decide the multi-sub-question keying semantics (a single Question can carry 1–4 sub-questions; current bus keys by questionId alone). Code reviewer declined to extend scope into AskUserQuestionCard since it requires a design decision, not a mechanical fix.

## Notes

- Per the code reviewer's analysis, expanding scope to also wire AskUserQuestionCard would violate the planner→executor contract (the card is not in TASK-762's files_owned and the keying-semantics question is not a mechanical fix). FIND-SPRINT-039-14 captures the gap for a follow-up task before the per-run-chat-surface epic is archived.

## Commits

- `7918e78` — feat(TASK-762): add otherText bus to questionStore for ChatInput forwarding
- `6a2aee8` — feat(TASK-762): add mode-gated ChatInput bar and mount in RunChatView
- `f16c276` — test(TASK-762): cover otherText bus + replaceAll-doesn't-clear-otherText regression
