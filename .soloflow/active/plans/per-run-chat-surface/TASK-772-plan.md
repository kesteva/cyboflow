---
id: TASK-772
idea: SPRINT-039-followups
status: ready
created: 2026-05-26T00:00:00Z
files_owned:
  - frontend/src/components/AskUserQuestion/AskUserQuestionCard.tsx
  - frontend/src/components/AskUserQuestion/__tests__/AskUserQuestionCard.test.tsx
files_readonly:
  - frontend/src/stores/questionStore.ts
  - frontend/src/components/cyboflow/ChatInput.tsx
  - frontend/src/components/cyboflow/RunChatView.tsx
  - shared/types/questions.ts
  - .soloflow/active/findings/SPRINT-039-findings.md
acceptance_criteria:
  - criterion: "AskUserQuestionCard imports useQuestionStore and reads otherText for the active question id."
    verification: "grep -n \"useQuestionStore\" frontend/src/components/AskUserQuestion/AskUserQuestionCard.tsx returns at least one match and 'otherText' is read from the store (grep -n \"otherText\\[\\|store.otherText\\|s\\.otherText\" frontend/src/components/AskUserQuestion/AskUserQuestionCard.tsx returns ≥1 match)."
  - criterion: "When questionStore.otherText[item.id] is a defined string, every sub-question's Other text input renders that value (uniform distribution across the 1–4 sub-questions). Local state only governs the textarea when the bus slot is undefined."
    verification: "New vitest test 'reads otherText from questionStore and prefers bus over local state' renders the card with two sub-questions, sets useQuestionStore.setState({ otherText: { 'q-1': 'from-bus' } }), and asserts BOTH 'Other free-text answer' input values equal 'from-bus'."
  - criterion: "On successful submit, the card calls clearOtherText(item.id) exactly once."
    verification: "New vitest test 'calls clearOtherText after successful submit' wraps useQuestionStore.getState().clearOtherText in a spy, completes a question, fires submit, awaits the mutate promise, then asserts the spy was called once with item.id."
  - criterion: "Multi-sub-question keying semantics are documented in the card's top JSDoc as 'bus is question-level; all sub-questions share the same Other text until each user typing in a sub-question's local input diverges'."
    verification: "grep -n 'bus is question-level' frontend/src/components/AskUserQuestion/AskUserQuestionCard.tsx returns exactly one match in the file header comment."
  - criterion: "Submitting still uses each sub-question's effective Other text (bus value when bus is defined for item.id AND local state has not been edited since mount; local edited value otherwise) — i.e. the existing per-sub-question divergence test remains green."
    verification: "Existing AskUserQuestionCard tests in __tests__/AskUserQuestionCard.test.tsx still pass: pnpm --filter frontend test -- AskUserQuestionCard.test.tsx exits 0."
  - criterion: "Frontend typecheck and lint clean."
    verification: "pnpm --filter frontend typecheck exits 0; pnpm --filter frontend lint exits 0 (or unchanged from baseline)."
depends_on: []
estimated_complexity: medium
epic: per-run-chat-surface
test_strategy:
  needed: true
  justification: "This is the epic completion gate per FIND-SPRINT-039-14; the new reader+clear behavior must be locked in with tests so a future refactor cannot silently regress the otherText round-trip."
  targets:
    - behavior: "Card reads otherText[item.id] from useQuestionStore and renders it in every sub-question's Other input when the bus slot is defined"
      test_file: "frontend/src/components/AskUserQuestion/__tests__/AskUserQuestionCard.test.tsx"
      type: component
    - behavior: "Card calls clearOtherText(item.id) exactly once on successful submit"
      test_file: "frontend/src/components/AskUserQuestion/__tests__/AskUserQuestionCard.test.tsx"
      type: component
    - behavior: "When bus slot is undefined, the card falls back to local useState behavior (typing into a sub-question's Other input only affects that sub-question's value)"
      test_file: "frontend/src/components/AskUserQuestion/__tests__/AskUserQuestionCard.test.tsx"
      type: component
    - behavior: "When user types into a specific sub-question's Other input after the bus pre-fill, the local edit wins for THAT sub-question only (other sub-questions still show the bus value)"
      test_file: "frontend/src/components/AskUserQuestion/__tests__/AskUserQuestionCard.test.tsx"
      type: component
---

# TASK-772 — Wire AskUserQuestionCard to read questionStore.otherText (epic completion gate)

## Objective

Close the open writer-without-reader loop in the per-run-chat-surface epic: AskUserQuestionCard must subscribe to `useQuestionStore.otherText[item.id]` and surface that bus value in each sub-question's "Other" free-text input. The bottom-bar ChatInput already writes the bus (TASK-762); without this reader, the epic's documented success signal ("typing in the bottom bar forwards as the Other answer") is functionally broken. Also call `clearOtherText(item.id)` from the submit handler so the bus does not leak state between question instances, and document the multi-sub-question keying decision (bus is question-level; sub-questions share the bus value until each diverges via local typing).

## Implementation Steps

1. **Add the store import** to `frontend/src/components/AskUserQuestion/AskUserQuestionCard.tsx` near the existing `import { trpc } from '../../trpc/client';` line: `import { useQuestionStore } from '../../stores/questionStore';`.

2. **Update the file header JSDoc** (the block above the component, currently describing the building-blocks-only surface) to add a `Multi-sub-question keying` paragraph that contains the literal phrase `bus is question-level` — required by AC4. The paragraph should read: "The `otherText` bus in questionStore is keyed by `questionId` only (not by sub-question index). When the bus slot for this card's `item.id` is defined, every sub-question's Other input is pre-filled with the same bus value (uniform distribution). The user can override per-sub-question by typing into a specific input — local edits win for that sub-question while other sub-questions keep showing the bus value. Rationale: the bottom-bar ChatInput writes a single text blob with no sub-question context; uniform distribution is the only correctness-preserving default. Future enhancement (not in this task): extend the bus to `Record<string, Record<number, string>>` keyed by `(questionId, subIndex)` if the multi-sub-question case becomes user-visible. This file is the bus is question-level reader."

3. **Add the store subscription** inside the `AskUserQuestionCard` function body, after the existing `const questionCount = item.questions.length;` line:
   ```ts
   // Subscribe to the otherText bus slot for THIS question id. ChatInput
   // (bottom-bar in workflow-question mode) writes here via setOtherText.
   const busOtherText = useQuestionStore((s) => s.otherText[item.id]);
   const clearOtherText = useQuestionStore((s) => s.clearOtherText);
   ```

4. **Track per-sub-question "local override" flags** so that once the user types into a specific sub-question's input, that input stops echoing the bus value while siblings continue to track the bus. Add immediately after the existing `const [otherText, setOtherText] = useState<string[]>...`:
   ```ts
   // Per-sub-question "has the user typed here?" flag. When false, the input
   // mirrors the bus value; when true, the local state wins.
   const [otherTextLocalDirty, setOtherTextLocalDirty] = useState<boolean[]>(() =>
     Array.from({ length: questionCount }, () => false),
   );
   ```

5. **Compute the effective Other text per sub-question** — replace direct reads of `otherText[index]` in the render loop and submit builder with a small helper. Add before the `isQuestionComplete` declaration:
   ```ts
   function effectiveOtherText(index: number): string {
     if (otherTextLocalDirty[index]) return otherText[index];
     return busOtherText ?? otherText[index];
   }
   ```
   Update the four read sites that currently use `otherText[i]` / `otherText[index]`:
   - Line 230 (`const text = otherText[index];` in `isQuestionComplete`) → `const text = effectiveOtherText(index);`
   - Line 324 (`answers[qp.question] = otherText[i].trim();` in `handleSubmit`) → `answers[qp.question] = effectiveOtherText(i).trim();`
   - Line 371 (`otherText={otherText[index]}` in the JSX render) → `otherText={effectiveOtherText(index)}`
   The `otherText[i]` inside `handleOtherToggle` (the "clear free-text when deselecting Other" branch) stays untouched — it only writes local state, never reads, and the dirty flag handles divergence.

6. **Update `handleOtherText`** (line 303-309) to set the dirty flag the first time the user types in a sub-question, so subsequent renders of that sub-question stop echoing the bus value:
   ```ts
   function handleOtherText(questionIndex: number, text: string): void {
     setOtherText((prev) => {
       const next = [...prev];
       next[questionIndex] = text;
       return next;
     });
     setOtherTextLocalDirty((prev) => {
       if (prev[questionIndex]) return prev;
       const next = [...prev];
       next[questionIndex] = true;
       return next;
     });
   }
   ```

7. **Update `handleOtherToggle`** to clear the dirty flag for that sub-question when the user deselects Other — keeps the bus reconnect symmetric with the local-text clear that already happens on line 287-291.
   Inside the existing `if (!checked) { ... }` block (line 285-292), append after the `setOtherText` call:
   ```ts
   setOtherTextLocalDirty((prev) => {
     if (!prev[questionIndex]) return prev;
     const next = [...prev];
     next[questionIndex] = false;
     return next;
   });
   ```

8. **Call `clearOtherText(item.id)` from `handleSubmit`** after the mutation resolves successfully. In the `.then(() => { onAnswered?.(); })` block (line 337-339), prepend the clear:
   ```ts
   .then(() => {
     clearOtherText(item.id);
     onAnswered?.();
   })
   ```
   This satisfies the FIND-SPRINT-039-14 requirement that the bus value not leak across question instances. Do NOT clear in `.catch` — the user may want the bus value preserved for a retry.

9. **Update the test file** `frontend/src/components/AskUserQuestion/__tests__/AskUserQuestionCard.test.tsx`:
   - Add `import { useQuestionStore } from '../../../stores/questionStore';` after the existing `import { AskUserQuestionCard } ...` line.
   - Add a `beforeEach` (or extend the existing one) that resets the questionStore: `useQuestionStore.setState({ queue: [], connectionStatus: 'idle', otherText: {} });`.
   - Add four new `it()` blocks under a new `describe('otherText bus integration', ...)` covering:
     a. "reads otherText from questionStore and prefers bus over local state": set bus, render card, assert both sub-question Other inputs show the bus value.
     b. "calls clearOtherText after successful submit": spy on the reducer, complete a question, fire submit, await, assert spy called with `item.id` exactly once.
     c. "falls back to local useState when bus slot is undefined": no bus set, type into one sub-question's Other input, assert only that input shows the typed text.
     d. "local edit in one sub-question does not affect bus-prefilled sibling": set bus to 'from-bus', render card with 2 sub-questions, type 'override' into sub-question 0's Other input, assert sub-question 0 shows 'override' and sub-question 1 still shows 'from-bus'.
   - The bus subscription needs the `useQuestionStore` mock to be a real Zustand store (NOT mocked at module level). The existing test file only mocks `trpc/client`, leaving the real questionStore in place — keep that arrangement; subscribe by `useQuestionStore.setState(...)` in the test's `act()` block as RunChatView.test.tsx already does.

10. **Run the completeness gate**:
    ```bash
    pnpm --filter frontend test -- AskUserQuestionCard.test.tsx
    pnpm --filter frontend typecheck
    pnpm --filter frontend lint
    ```
    All three must exit 0. If any sibling test file in `frontend/src/components/AskUserQuestion/__tests__/` exists beyond `AskUserQuestionCard.test.tsx`, run those too — the directory currently contains only that one test file (verified at plan time).

## Acceptance Criteria

1. `grep -n "useQuestionStore" frontend/src/components/AskUserQuestion/AskUserQuestionCard.tsx` returns ≥1 match and the store's `otherText` is read into a subscription line.
2. With `questionStore.otherText['q-1'] = 'from-bus'` set before render, every sub-question's "Other free-text answer" input renders `'from-bus'`.
3. After a successful submit, `clearOtherText(item.id)` has been called exactly once.
4. `grep -n 'bus is question-level' frontend/src/components/AskUserQuestion/AskUserQuestionCard.tsx` returns exactly one match (the JSDoc paragraph from step 2).
5. The existing 9 AskUserQuestionCard tests + the 4 new tests all pass: `pnpm --filter frontend test -- AskUserQuestionCard.test.tsx` exits 0.
6. `pnpm --filter frontend typecheck` and `pnpm --filter frontend lint` exit 0.

## Test Strategy

Four new `it()` blocks added to `frontend/src/components/AskUserQuestion/__tests__/AskUserQuestionCard.test.tsx` under a new `describe('otherText bus integration', ...)` group. The questionStore stays real (it is not mocked at module level in this file); tests set bus state via `useQuestionStore.setState(...)` inside an `act()` wrapper. The `clearOtherText` test spies on the reducer by intercepting `useQuestionStore.setState` via `vi.spyOn(useQuestionStore.getState(), 'clearOtherText')` immediately after a `useQuestionStore.setState` that injects a stub reducer for the duration of the test. Existing tests in the file keep their tRPC-only mock surface — no changes needed there.

## Hardest Decision

Choosing the **multi-sub-question keying semantics**: extend the bus to `Record<string, Record<number, string>>` keyed by `(questionId, subIndex)` (FIND-14 option a) or keep the bus question-level and have the card distribute the text uniformly across all sub-questions (option b). Picked **option b** because: (1) it requires no schema/migration change on the bus type and keeps the ChatInput producer unchanged; (2) the bottom-bar input is a single textarea — there is no UI affordance for the user to target a specific sub-question, so a per-subIndex bus would have no producer; (3) in the dominant single-sub-question case (TASK-760's tests, current production traffic), uniform = correct; (4) the per-sub-question "local dirty" override gives users full control to diverge a specific input from the broadcast value. Option a would force ChatInput to grow a sub-question picker UI, which is out of scope and pollutes the chat input.

## Rejected Alternatives

- **Extend the bus to `Record<string, Record<number, string>>` (FIND-14 option a)**. Rejected: no producer; ChatInput has no UI to target a sub-question. Would require an unrelated UI change in the bottom bar before anyone could benefit. Reconsider if a future "Reply to sub-question N" affordance lands.
- **Read the bus once on mount via a useEffect and copy into local `otherText` state**. Rejected: the bus is reactive (ChatInput keystrokes update it as the user types). A one-shot mount-time read would only catch the initial value; subsequent typing in the bottom bar would not update the card. The subscription pattern (step 3) is required for live propagation.
- **Drop the local-dirty flag and always echo the bus**. Rejected: the card has its own Other text input visible to the user. Typing there must take precedence (otherwise the card's input is read-only from the user's perspective, which is a UX regression from the pre-bus behavior).

## Lowest Confidence Area

Whether the test "calls clearOtherText after successful submit" can spy on the reducer cleanly without mocking the whole store. Zustand reducers are bound at store creation; the spy approach in step 9 requires patching `useQuestionStore.getState()` after the test's `useQuestionStore.setState` resets state. If that pattern proves unstable in vitest, the fallback is to: (1) set `useQuestionStore.setState({ otherText: { 'q-1': 'sentinel' } })` before submit, then (2) after submit assert `useQuestionStore.getState().otherText['q-1']` is undefined (clearOtherText's documented behavior is `delete next[questionId]`). The fallback is more robust and avoids spy fragility — switch to it if the spy approach hits unmockable behavior.
```

---

```markdown
