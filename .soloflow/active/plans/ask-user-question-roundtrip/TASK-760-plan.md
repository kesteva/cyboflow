---
id: TASK-760
idea: IDEA-025
status: approved
created: "2026-05-26T00:00:00Z"
files_owned:
  - frontend/src/components/AskUserQuestion/AskUserQuestionCard.tsx
  - frontend/src/components/AskUserQuestion/__tests__/AskUserQuestionCard.test.tsx
  - frontend/src/stores/questionStore.ts
  - frontend/src/stores/__tests__/questionStore.test.ts
  - frontend/src/stores/cyboflowStore.ts
  - questionStore.test.ts
files_readonly:
  - frontend/src/components/ReviewQueue/PendingApprovalCard.tsx
  - frontend/src/stores/reviewQueueStore.ts
  - frontend/src/stores/__tests__/reviewQueueStore.test.ts
  - frontend/src/components/MarkdownPreview.tsx
  - frontend/src/components/ui/Pill.tsx
  - frontend/src/components/ui/Button.tsx
  - frontend/src/components/ui/CollapsibleCard.tsx
  - frontend/src/trpc/client.ts
  - shared/types/questions.ts
  - shared/types/approvals.ts
  - frontend/vitest.config.ts
acceptance_criteria:
  - criterion: "AskUserQuestionCard.tsx exists and exports a `AskUserQuestionCard` React component with props `{ item: Question, onAnswered?: () => void }`."
    verification: "grep -E '^export (function|const) AskUserQuestionCard' frontend/src/components/AskUserQuestion/AskUserQuestionCard.tsx returns exactly one match; `pnpm --filter frontend typecheck` exits 0."
  - criterion: "Each question renders its `header` text inside a `Pill` element (chip-style label), truncated to 12 characters with an ellipsis when longer."
    verification: "Test 'renders header as Pill truncated to 12 chars' in AskUserQuestionCard.test.tsx passes — supplies header='ABCDEFGHIJKLMNO' and asserts the pill text is 'ABCDEFGHIJKL…' (12 chars + ellipsis)."
  - criterion: "Questions with `multiSelect: false` render as a radio group (input[type=radio] sharing the same `name`); questions with `multiSelect: true` render as a checkbox group (input[type=checkbox])."
    verification: "Tests 'single-select renders radio group' and 'multi-select renders checkbox group' assert the correct input type per question via getAllByRole('radio' | 'checkbox')."
  - criterion: "Each option renders its `label` and (when present) `description` text; when `option.preview` is non-empty, a `Show preview` toggle reveals a `<MarkdownPreview content={option.preview} />` panel."
    verification: "Test 'renders option label, description, and preview toggle' asserts label text, description text, and that clicking 'Show preview' mounts the MarkdownPreview region; the preview is initially collapsed (not in DOM)."
  - criterion: Each question shows an implicit `Other` choice as an additional radio/checkbox option; selecting it enables a sibling text input which captures free-form text.
    verification: "Test 'Other option enables free-text input' asserts the text input is disabled until 'Other' is selected, then enabled after; the typed value is included on submit."
  - criterion: "Submit button is disabled until every question has at least one selection (or 'Other' selected with non-empty free-text)."
    verification: "Test 'submit disabled until all answered' asserts the button's `disabled` attribute is true initially, remains true with partial answers, and becomes false only when all questions have a valid selection."
  - criterion: "On submit, the component calls `trpc.cyboflow.questions.answer.mutate({ questionId, answers })` with `answers` keyed by each question's full `question` text (not `header`), value = selected option `label` for single-select OR a comma-separated string of labels for multi-select, OR the free-text content when 'Other' is selected."
    verification: "Test 'submit calls trpc.cyboflow.questions.answer.mutate with answers keyed by question text' mocks `trpc.cyboflow.questions.answer.mutate` and asserts the exact payload shape: `{ questionId: 'q-1', answers: { 'What color?': 'Red', 'Browsers?': 'Chrome,Firefox' } }`."
  - criterion: "After a successful submit, `onAnswered` (if provided) is invoked exactly once and the submit button is re-enabled to its terminal disabled state (mutation success leaves the card in place — parent removes via store)."
    verification: "Test 'onAnswered called once on successful submit' mocks the mutate to resolve, fires submit, and asserts onAnswered toHaveBeenCalledTimes(1); a failed mutate (test 'submit failure does not call onAnswered') resolves rejected and asserts onAnswered NOT called."
  - criterion: "questionStore.ts exports `useQuestionStore` (Zustand) and pure reducer functions `pureAddQuestion`, `pureRemoveQuestion`, `pureReplaceAll` whose signatures and idempotency contracts mirror `reviewQueueStore.ts`."
    verification: "grep -E '^export (function|const) (useQuestionStore|pureAddQuestion|pureRemoveQuestion|pureReplaceAll)' frontend/src/stores/questionStore.ts returns 4 matches; questionStore.test.ts exercises each reducer's idempotency invariant and passes."
  - criterion: "`useQuestionStore.getState().init()` performs full-state resync via `trpc.cyboflow.questions.listPending.query()` then subscribes to `trpc.cyboflow.events.onQuestionCreated` and `trpc.cyboflow.events.onQuestionAnswered`; returns an `unsubscribe` function; calling `init()` twice without unsubscribe is a no-op (returns the cached unsubscribe)."
    verification: "Test 'double init() — listPending.query called exactly once and subscribe called exactly twice' (twice = once per subscription) passes against the mocked tRPC client, mirroring the reviewQueueStore.test.ts idempotency pattern."
  - criterion: "`onQuestionCreated` deltas add via the idempotent `addQuestion` reducer; `onQuestionAnswered` deltas remove via `removeQuestion`."
    verification: "Test 'onQuestionCreated event triggers addQuestion' invokes the captured onData handler with `{ question: { id: 'q-1', ... } }` and asserts the queue contains that question; test 'onQuestionAnswered event triggers removeQuestion' invokes with `{ questionId: 'q-1' }` and asserts removal."
  - criterion: "No file under `frontend/src/stores/questionStore.ts` or the new card imports `RunChatView`, `RunBottomPane`, or modifies `cyboflowStore.ts`."
    verification: "grep -rn -E '(RunChatView|RunBottomPane)' frontend/src/stores/questionStore.ts frontend/src/components/AskUserQuestion/ returns 0 matches; `git diff --name-only` against the worktree base does NOT include frontend/src/stores/cyboflowStore.ts or any frontend/src/components/cyboflow/RunChatView*.tsx file."
  - criterion: "`pnpm --filter frontend test -- --run src/components/AskUserQuestion src/stores/__tests__/questionStore.test.ts` exits 0 with all suites passing; `pnpm --filter frontend typecheck` and `pnpm --filter frontend lint` exit 0."
    verification: Run all three commands; check exit code = 0.
depends_on:
  - TASK-759
estimated_complexity: medium
epic: ask-user-question-roundtrip
test_strategy:
  needed: true
  justification: "Net-new UI component with conditional rendering branches (single vs multi-select, preview toggle, Other option) AND a net-new Zustand store with init() idempotency and delta-subscription reducers — both classes of behavior already have established test patterns in this codebase (PendingApprovalCard.test.tsx, reviewQueueStore.test.ts) that this task must mirror to remain consistent. Untested submit-shape is the single highest-risk regression vector because the answers payload must match the SDK schema exactly (keyed by question text, not header)."
  targets:
    - behavior: "Header is rendered as a Pill, truncated to 12 chars with ellipsis when longer."
      test_file: frontend/src/components/AskUserQuestion/__tests__/AskUserQuestionCard.test.tsx
      type: component
    - behavior: Single-select question renders radio inputs; multi-select renders checkbox inputs.
      test_file: frontend/src/components/AskUserQuestion/__tests__/AskUserQuestionCard.test.tsx
      type: component
    - behavior: Per-option preview panel is initially collapsed; toggle button mounts MarkdownPreview.
      test_file: frontend/src/components/AskUserQuestion/__tests__/AskUserQuestionCard.test.tsx
      type: component
    - behavior: "'Other' option appears in every question's group; selecting it enables the free-text input."
      test_file: frontend/src/components/AskUserQuestion/__tests__/AskUserQuestionCard.test.tsx
      type: component
    - behavior: Submit is disabled until every question has a valid selection; enabled when complete.
      test_file: frontend/src/components/AskUserQuestion/__tests__/AskUserQuestionCard.test.tsx
      type: component
    - behavior: "On submit, trpc.cyboflow.questions.answer.mutate is called with answers keyed by question.question text; multi-select values are comma-joined labels; Other contributes the free-text value."
      test_file: frontend/src/components/AskUserQuestion/__tests__/AskUserQuestionCard.test.tsx
      type: component
    - behavior: onAnswered callback fires once on resolved mutate; not called on rejected mutate.
      test_file: frontend/src/components/AskUserQuestion/__tests__/AskUserQuestionCard.test.tsx
      type: component
    - behavior: pureAddQuestion is idempotent on duplicate id (returns same reference); pureRemoveQuestion no-ops on missing id; pureReplaceAll returns a new array.
      test_file: frontend/src/stores/__tests__/questionStore.test.ts
      type: unit
    - behavior: "init() double-call is a no-op (single listPending.query, single set of subscribe calls); unsubscribe → init re-subscribes; subscription onError resets closure state."
      test_file: frontend/src/stores/__tests__/questionStore.test.ts
      type: unit
    - behavior: onQuestionCreated delta dispatches addQuestion; onQuestionAnswered delta dispatches removeQuestion; malformed event payloads are silently ignored.
      test_file: frontend/src/stores/__tests__/questionStore.test.ts
      type: unit
---
# AskUserQuestionCard UI and questionStore

## Objective

Build the renderer-side surface for AskUserQuestion: a self-contained interactive card component that renders one `Question` record (chip-style header pill, radio or checkbox option groups, optional collapsible markdown preview, implicit free-text "Other") and submits answers via `trpc.cyboflow.questions.answer`, plus a Zustand `questionStore` that mirrors `reviewQueueStore`'s init-resync + delta-subscription pattern so the queue stays consistent across reloads and reconnects. This task ships the building blocks only — wiring them into `RunChatView` / `RunBottomPane` is TASK-761.

## Implementation Steps

1. **Confirm the upstream type surface from TASK-757.** Read `shared/types/questions.ts`. The plan below assumes it exports — verbatim, as written in IDEA-025 §Slice 2 + §Slice 4 and the SDK research — at minimum: `QuestionOption`, `QuestionPayload`, `Question`, `QuestionAnswer`, `QuestionCreatedEvent`, `QuestionAnsweredEvent`. If TASK-757 named any of these differently, adapt imports at the top of both owned files; do NOT redeclare types locally.

2. **Create `frontend/src/stores/questionStore.ts`.** Structure it as a near-mechanical port of `frontend/src/stores/reviewQueueStore.ts`:
   - Imports: `create` from `zustand`, `{ trpc }` from `'../trpc/client'`, types from `'../../../shared/types/questions'`.
   - State interface `QuestionStoreState`: `{ queue: Question[]; connectionStatus: ConnectionStatus; addQuestion; removeQuestion; replaceAll; setConnectionStatus; init }`. Re-export the same `ConnectionStatus` union (`'idle' | 'connecting' | 'connected' | 'disconnected'`).
   - Closure-private `initialized` flag and `cachedUnsubscribe` mirroring `reviewQueueStore.ts:121-124`.
   - Reducers: `addQuestion(q)`, `removeQuestion(id)`, `replaceAll(items)` — same idempotency contracts as reviewQueueStore.
   - `init()`: set status `connecting`; call `trpc.cyboflow.questions.listPending.query()`; on success → `replaceAll(items)` + status `connected`; on error → status `disconnected`. Subscribe to `trpc.cyboflow.events.onQuestionCreated` with an onData guard checking `evt.question` is a non-null object, then `addQuestion(evt.question)`. Subscribe to `trpc.cyboflow.events.onQuestionAnswered` with an onData guard checking `typeof evt.questionId === 'string'`, then `removeQuestion(evt.questionId)`. onError handlers mirror `reviewQueueStore.ts:212-219`.
   - **Do NOT include a `syncBadge` call.** Questions do not contribute to the macOS dock badge — that is approvals-only.
   - Export pure reducer functions `pureAddQuestion`, `pureRemoveQuestion`, `pureReplaceAll` at the bottom of the file.

3. **Create `frontend/src/stores/__tests__/questionStore.test.ts`.** Port `reviewQueueStore.test.ts` 1:1 with `makeQuestion()` helper analog of `makeApproval`. Reducer tests, init() idempotency tests, and delta-dispatch tests.

4. **Create `frontend/src/components/AskUserQuestion/AskUserQuestionCard.tsx`.** Public signature: `{ item: Question, onAnswered?: () => void }`. Internal state: `selections`, `otherText`, `otherSelected`, `busy`.

   Render layout: chip header via `<Pill variant="default" size="sm">`, per-question fieldset with radio (single) or checkbox (multi) groups, per-option description text, collapsible MarkdownPreview when `option.preview` is set, implicit "Other" choice with sibling text input. Submit button `<Button variant="primary" type="submit" disabled={busy || !isComplete}>Submit answer</Button>`.

   Submit handler builds `answers` keyed by `q.question`; single-select returns the chosen label; multi-select comma-joins selected labels; Other returns the trimmed free-text. Calls `trpc.cyboflow.questions.answer.mutate({ questionId: item.id, answers })`. On resolve, invokes `onAnswered?.()`.

5. **Create `frontend/src/components/AskUserQuestion/__tests__/AskUserQuestionCard.test.tsx`.** Test scaffold (mirror `PendingApprovalCard.test.tsx`):
   - `vi.hoisted` block exposing `mockAnswerMutate`.
   - `vi.mock('../../../trpc/client', ...)` factory.
   - `makeQuestion()` fixture helper returning a `Question` with one single-select question, one multi-select, and one option carrying a `preview` markdown string.
   - Use `@testing-library/react` (`render`, `screen`, `fireEvent`, `waitFor`).
   - Write the tests enumerated in the `test_strategy.targets[]` frontmatter.

6. **TypeScript/lint hygiene.** `any` is forbidden. The subscription `onData(evt: unknown)` pattern from `reviewQueueStore.ts:194-211` is mandatory. The card's `setBusy(true)` → mutate → `.finally(setBusy(false))` pattern follows `PendingApprovalCard.tsx:261-275`.

7. **Run the verification chain (also the AC gate):**
   ```bash
   pnpm --filter frontend typecheck
   pnpm --filter frontend lint
   pnpm --filter frontend test -- --run src/components/AskUserQuestion src/stores/__tests__/questionStore.test.ts
   ```
   All three must exit 0.

## Acceptance Criteria

Restated from frontmatter — each must be objectively passing before this task can be marked COMPLETED:

1. The card module exports `AskUserQuestionCard` with the documented props.
2. Header rendered inside `Pill`, truncated to 12 chars + ellipsis.
3. Single-select questions → radio; multi-select → checkbox.
4. Each option shows label, optional description, opt-in `Show preview` toggle mounting `<MarkdownPreview />`.
5. Implicit `Other` choice with sibling free-text input.
6. Submit disabled until every question has a valid answer.
7. Submit calls `trpc.cyboflow.questions.answer.mutate({ questionId, answers })` with the documented format.
8. `onAnswered` fires once on resolved mutate; not on rejected.
9. `questionStore.ts` exports `useQuestionStore` and the three pure reducers.
10. `init()` is idempotent and uses both subscriptions.
11. Subscription deltas drive `addQuestion` / `removeQuestion`.
12. No file in this task's scope imports or modifies `RunChatView`, `RunBottomPane`, or `cyboflowStore.ts`.
13. typecheck, lint, and scoped test all exit 0.

## Test Strategy

A net-new component AND a net-new store, both with established analog test files in this repo (`PendingApprovalCard.test.tsx`, `reviewQueueStore.test.ts`). Both target test files are net-new. The strategy ports both established patterns verbatim.

No `pnpm dev` / Playwright / visual verification needed — both files are unit/component scope, the testbed is jsdom.

## Hardest Decision

**Answer payload shape for multi-select questions.** The SDK research says `answers: { [questionText: string]: string }` and that "multi-select values are comma-separated labels or an array." The card must pick one. Choice taken: **comma-joined string of labels** for multi-select. Rationale:
1. The SDK's `AskUserQuestionOutput.answers` field is typed `{ [questionText: string]: string }` (string values, not arrays — verified in `sdk-tools.d.ts:2620` per the research report).
2. The TASK-759 `answer` mutation will pass this through to `QuestionRouter.respond` which calls the SDK hook's `updatedInput.answers`. A string field cannot hold an array without a schema bump in TASK-759.
3. Keeping the wire shape `{ [questionText: string]: string }` end-to-end avoids drift between this task and TASK-759 / SDK conformance.
4. The "Other" free-text answer is already a string, so a single-string shape unifies both cases.

If TASK-759's schema validation explicitly accepts arrays, this can be revisited.

## Rejected Alternatives

- **`answers: { [questionText: string]: string | string[] }` (union shape).** Rejected because the SDK's documented output type is `string` only.
- **`react-hook-form` for form state.** Rejected — `frontend/src/components/ui/` favors local `useState` patterns. The form is simple (1–4 questions, ≤4 options each).
- **Sourcing preview-format toolConfig from the card itself.** Rejected — `option.preview` is supplied by the agent (research Risk 5 — set in `claudeCodeManager.ts`).
- **Putting question-related dock-badge updates in the store.** Rejected — `cyboflow.events.setBadgeCount` is approvals-scoped by convention.

## Lowest Confidence Area

**Annotations omission and the implicit `Other` mapping to `answers`.** The SDK research notes annotations are `{ preview?, notes? }` per question and "feel free to omit annotations in v1." This plan omits them entirely — the card never emits `annotations` on submit. If the agent's downstream behavior on the next turn depends on receiving annotations, the round-trip is functionally complete but semantically lossy. Mitigation: TASK-761 / TASK-762 retro-fit can add an annotations input.

Secondary risk: the question-text key used in `answers` must EXACTLY match `q.question` (full string, possibly multi-line, possibly with trailing punctuation). The test asserts the exact string is the key.
