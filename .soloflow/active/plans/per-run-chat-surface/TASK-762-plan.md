---
id: TASK-762
idea: IDEA-025
status: in-flight
created: "2026-05-26T00:00:00Z"
files_owned:
  - frontend/src/components/cyboflow/ChatInput.tsx
  - frontend/src/components/cyboflow/RunChatView.tsx
  - frontend/src/components/cyboflow/__tests__/ChatInput.test.tsx
files_readonly:
  - frontend/src/stores/cyboflowStore.ts
  - frontend/src/stores/questionStore.ts
  - frontend/src/utils/api.ts
  - frontend/src/types/electron.d.ts
  - main/src/preload.ts
  - main/src/ipc/session.ts
  - frontend/src/components/ui/Textarea.tsx
  - frontend/src/components/ui/Button.tsx
  - frontend/src/components/ui/Tooltip.tsx
acceptance_criteria:
  - criterion: "File frontend/src/components/cyboflow/ChatInput.tsx exists and default-exports a React component named ChatInput accepting prop { runId: string | null }."
    verification: "test -f frontend/src/components/cyboflow/ChatInput.tsx && grep -nE 'export (default )?(function|const) ChatInput' frontend/src/components/cyboflow/ChatInput.tsx"
  - criterion: "ChatInput in Quick-session mode (cyboflowStore.activeQuickSessionId != null) renders an enabled textarea and Send button, and submitting calls API.sessions.sendInput(activeQuickSessionId, text) (which targets IPC channel 'sessions:input')."
    verification: "grep -nE 'API\\.sessions\\.sendInput|window\\.electronAPI\\.sessions\\.sendInput' frontend/src/components/cyboflow/ChatInput.tsx returns at least one match; the vitest unit test 'quick session: sends input via API.sessions.sendInput' passes."
  - criterion: "ChatInput in Workflow-run mode with no pending question for the active runId renders a disabled textarea AND a Tooltip with the literal text \"Input enabled only when the agent asks a question\"."
    verification: "grep -nE 'Input enabled only when the agent asks a question' frontend/src/components/cyboflow/ChatInput.tsx returns at least one match; the vitest unit test 'workflow run, no question: textarea disabled, tooltip rendered' passes."
  - criterion: "ChatInput in Workflow-run mode with an active question for the active runId enables the textarea and, on Send (or Enter), forwards the typed text to questionStore via its 'Other'-text setter for the active question and clears the textarea — it does NOT call trpc.cyboflow.questions.answer.mutate directly (the AskUserQuestionCard remains the sole submit authority for the answers payload)."
    verification: "The vitest unit test 'workflow run, active question: forwards text to questionStore' passes and asserts (a) the relevant questionStore setter was called with the typed text and (b) trpc.cyboflow.questions.answer.mutate was NOT called from ChatInput."
  - criterion: ChatInput is mounted at the bottom of RunChatView (rendered as the last child of the RunChatView root).
    verification: "grep -nE \"import .*ChatInput.* from '\\./ChatInput'\" frontend/src/components/cyboflow/RunChatView.tsx returns one match; grep -nE '<ChatInput\\b' frontend/src/components/cyboflow/RunChatView.tsx returns one match."
  - criterion: Typecheck and lint pass for the frontend workspace.
    verification: "pnpm --filter frontend typecheck && pnpm --filter frontend lint exit 0."
  - criterion: Frontend unit tests pass (vitest run).
    verification: pnpm --filter frontend test exits 0.
depends_on:
  - TASK-761
estimated_complexity: low
epic: per-run-chat-surface
test_strategy:
  needed: true
  justification: "ChatInput is the user-facing dispatcher for two distinct transports (IPC for quick sessions, questionStore forwarding for workflow runs) and a three-state gate. A focused unit test pins each state and prevents future drift (e.g. someone adding a third call site that bypasses the gate). Existing sibling tests in frontend/src/components/cyboflow/__tests__/ (RunView.test.tsx, CyboflowRoot.test.tsx, WorkflowPicker.test.tsx) do not reference ChatInput / RunChatView / RunBottomPane (verified via grep) and adding this new file cannot affect them."
  targets:
    - behavior: "Quick session mode: textarea is enabled; submitting calls API.sessions.sendInput(activeQuickSessionId, text); textarea is cleared after dispatch; failed IPC response (success: false) surfaces an error indicator without clearing the textarea."
      test_file: frontend/src/components/cyboflow/__tests__/ChatInput.test.tsx
      type: component
    - behavior: "Workflow-run mode with no active question: textarea has the disabled attribute; Send button is disabled; a Tooltip with the literal string \"Input enabled only when the agent asks a question\" is rendered around the disabled control."
      test_file: frontend/src/components/cyboflow/__tests__/ChatInput.test.tsx
      type: component
    - behavior: "Workflow-run mode with an active question for the active runId: textarea enabled; submitting forwards the text to questionStore's 'Other'-text setter (mocked) and clears the textarea; trpc.cyboflow.questions.answer.mutate is NOT called from ChatInput."
      test_file: frontend/src/components/cyboflow/__tests__/ChatInput.test.tsx
      type: component
    - behavior: "Mode-gating: when the underlying cyboflowStore.activeQuickSessionId / questionStore state changes, ChatInput re-renders into the corresponding state without remount artifacts."
      test_file: frontend/src/components/cyboflow/__tests__/ChatInput.test.tsx
      type: component
---
# Mode-Gated ChatInput Bar for RunChatView

## Objective

Provide a single bottom-of-chat input bar inside RunChatView that adapts to three mutually-exclusive states — Quick-session, Workflow-run-no-question, Workflow-run-active-question — and dispatches user text to the correct transport for each state. This task ships the ChatInput component only; the mount point lives inside RunChatView (owned by TASK-761) and is added here as a single surgical edit (see Implementation Step 5).

## Implementation Steps

1. Create `frontend/src/components/cyboflow/ChatInput.tsx` (new file). The component:
   - Props: `{ runId: string | null }`. Accepts the active workflow run id (null when in quick-session mode or nothing is selected).
   - Reads `activeQuickSessionId` from `useCyboflowStore` (`frontend/src/stores/cyboflowStore.ts`).
   - Reads the active question for the given `runId` from `useQuestionStore` (`frontend/src/stores/questionStore.ts`, shipped by TASK-760). Treat "active question" as: the most-recently-created pending Question whose `runId` equals the prop `runId`. Expose this selector inline (e.g. `const activeQuestion = useQuestionStore((s) => s.queue.find((q) => q.runId === runId && q.status === 'pending'))`).
   - Maintains local state for the textarea: `const [text, setText] = useState('')`.

2. Implement the three-state gate as a single derived value at the top of the render body:
   ```ts
   const mode: 'quick' | 'workflow-question' | 'workflow-idle' | 'none' =
     activeQuickSessionId != null ? 'quick'
     : runId != null && activeQuestion != null ? 'workflow-question'
     : runId != null ? 'workflow-idle'
     : 'none';
   ```
   When `mode === 'none'`, render nothing (return `null`).

3. Render the textarea + Send button using `Textarea` and `Button`. Disabled state:
   - `mode === 'quick'`: textarea enabled, button enabled when `text.trim().length > 0`.
   - `mode === 'workflow-question'`: textarea enabled, button enabled when `text.trim().length > 0`.
   - `mode === 'workflow-idle'`: textarea AND button BOTH have `disabled={true}`. Wrap the textarea in `<Tooltip content="Input enabled only when the agent asks a question">`. The tooltip's `content` string MUST be exactly that literal.
   - Pressing Enter (without Shift) triggers Send in the enabled modes; Shift+Enter inserts a newline.

4. Implement the Send handler with one branch per enabled mode:
   - `mode === 'quick'`: `await API.sessions.sendInput(activeQuickSessionId!, text)` where `API` is imported from `frontend/src/utils/api.ts`. Inspect the `IPCResponse<void>` result: on `success === true`, clear `text` via `setText('')`; on `success === false`, render an inline error and keep the text so the user can retry.
   - `mode === 'workflow-question'`: call the questionStore "Other"-text setter for the active question. The exact setter name is owned by TASK-760; use whichever public setter `questionStore.ts` exposes for forwarding the bottom-bar "Other" text into the active card. After the call, `setText('')`. Do NOT call `trpc.cyboflow.questions.answer.mutate` from ChatInput.
   - Defensive: if `mode === 'workflow-question'` but the questionStore setter is undefined at call time (partial-build scenario), log via `console.warn` and no-op.

5. Make the single surgical mount edit to `frontend/src/components/cyboflow/RunChatView.tsx` (file is declared `readonly` in frontmatter because it is owned by TASK-761; this single mount edit was pre-approved by the orchestrator note and MUST be the only edit to that file in this task):
   - Add `import { ChatInput } from './ChatInput';` to the existing import block.
   - Render `<ChatInput runId={runId} />` as the last child of RunChatView's root element. If TASK-761's RunChatView accepts a `runId` prop, pass it through; otherwise read `activeRunId` from `useCyboflowStore` inside RunChatView and pass that.

6. Add the unit test file `frontend/src/components/cyboflow/__tests__/ChatInput.test.tsx`. Initial cases per `test_strategy.targets[]`. Mocks: stub `useCyboflowStore`, `useQuestionStore`, and `API.sessions.sendInput` via `vi.mock`.

7. Run the verification chain:
   - `pnpm --filter frontend typecheck` exits 0.
   - `pnpm --filter frontend lint` exits 0.
   - `pnpm --filter frontend test` exits 0 (vitest run, one-shot — never bare `vitest`).

## Acceptance Criteria

1. **Component exists and exports `ChatInput`.** Accepts `{ runId: string | null }`.

2. **Quick-session mode dispatches via `API.sessions.sendInput`.** Targets the real IPC channel `sessions:input` (verified in `main/src/preload.ts:208` and `main/src/ipc/session.ts:528`).

3. **Workflow-idle mode disables input with the exact tooltip copy** `Input enabled only when the agent asks a question`.

4. **Workflow-question mode forwards to questionStore, not to tRPC.** The AskUserQuestionCard (TASK-760) retains exclusive ownership of the answers payload submission.

5. **Mount point.** RunChatView imports `ChatInput` from `./ChatInput` and renders `<ChatInput …/>` as its last child.

6. **Quality gates.** typecheck, lint, and test all exit 0.

## Test Strategy

Create `frontend/src/components/cyboflow/__tests__/ChatInput.test.tsx` with four component-level cases (one per `test_strategy.targets[]`). Render via `@testing-library/react` against a mocked store/API surface.

Why no existing sibling tests are affected: `frontend/src/components/cyboflow/__tests__/{RunView,CyboflowRoot,WorkflowPicker}.test.tsx` were greped for `ChatInput|RunChatView|RunBottomPane` — zero hits. The new file cannot regress them.

## Hardest Decision

Choosing whether ChatInput in workflow-question mode forwards text into questionStore versus calling `trpc.cyboflow.questions.answer.mutate` directly. The TASK skeleton's scope_summary reads "calls cyboflow.questions.answer with the Other text" — a direct submit — but the IDEA-025 slice 6 description reads "text typed here is forwarded as the 'Other' free-text answer for the active AskUserQuestionCard" — a forwarding bus. I chose forwarding because:

- A workflow question can have 1–4 sub-questions, each requiring a selected option label keyed by question text. Submitting only the bottom-bar "Other" text would either (a) submit an incomplete `answers` object that the SDK rejects, or (b) require ChatInput to reach into the card's selection state — coupling two components in the wrong direction.
- The AskUserQuestionCard (TASK-760) already owns its Submit button and selection validation. Splitting submit authority across two components is a recipe for double-fires and inconsistent UI state.
- The forwarding pattern keeps ChatInput dumb (it knows only about transport) and the card smart (it owns answers shape).

If TASK-760's questionStore does NOT expose an "Other"-text setter, the executor must escalate before authoring this branch.

## Rejected Alternatives

- **Direct `trpc.cyboflow.questions.answer.mutate` from ChatInput.** Rejected because of the multi-question / partial-answer correctness issue above.

- **Co-locating the input inside AskUserQuestionCard and dropping the bottom bar in workflow-question mode.** Rejected because slice 6 is explicit that the bar exists in all three states.

- **Routing quick-session input through a new tRPC mutation.** Rejected — IDEA-025 Q4 already chose IPC `sessions:input` (the actual channel — the IDEA text says "sessions:sendMessage" but the codebase channel is `sessions:input`; preload exposes it as `sendInput`).

- **Listing RunChatView.tsx in files_owned.** Rejected — the decomposer assigned ownership of that file to TASK-761 and explicitly directed this task to declare it readonly with a documented surgical edit.

## Lowest Confidence Area

The exact public setter name on `questionStore` for the "Other"-text forwarding bus. TASK-760 ships `questionStore.ts` and the bus interface (setter name, signature, whether keyed by `questionId` alone or by `(questionId, questionText)`) is decided there. My plan instructs the executor to use whichever public setter TASK-760 exposes; if TASK-760 lands without one, the executor must stop and escalate rather than reach into questionStore internals. This is the load-bearing seam between TASK-760 and TASK-762.

Secondary low-confidence concern: the orchestrator note says "Declare RunChatView.tsx as readonly and document the single targeted edit." Some orchestrators treat any write to a readonly file as a scope deviation regardless of plan-body language. If this executor stack does, the workaround is for TASK-761 to ship RunChatView pre-mounting `<ChatInput />` (gated on the file existing) and for TASK-762 to ship only the ChatInput component itself.
