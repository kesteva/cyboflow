---
id: TASK-772
sprint: SPRINT-041
epic: per-run-chat-surface
status: done
summary: "AskUserQuestionCard now subscribes to questionStore.otherText bus and clears it after submit; per-sub-question local-dirty flag preserves divergence."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: skipped_unable
---

# TASK-772 — Wire AskUserQuestionCard to read questionStore.otherText

## Outcome

Closed the writer-without-reader loop in the per-run-chat-surface epic. AskUserQuestionCard subscribes to `useQuestionStore.otherText[item.id]`, distributes the bus value uniformly across sub-question Other inputs, and lets per-sub-question local typing diverge via an `otherTextLocalDirty` flag. On successful submit, `clearOtherText(item.id)` runs in `.then()` only (preserves bus on retry).

## Changes

- `frontend/src/components/AskUserQuestion/AskUserQuestionCard.tsx` — useQuestionStore subscriptions; `otherTextLocalDirty` state; `effectiveOtherText(index)` helper; handler updates; JSDoc "Multi-sub-question keying" paragraph with literal phrase `bus is question-level`.
- `frontend/src/components/AskUserQuestion/__tests__/AskUserQuestionCard.test.tsx` — new `describe('otherText bus integration', ...)` with 4 it() blocks (bus pre-fill, clear-on-submit, local fallback, per-sub-question divergence).

## Commits

- `f3cf341` feat(TASK-772): wire AskUserQuestionCard to read questionStore.otherText
- `a04cba2` test(TASK-772): add 4 otherText bus integration tests for AskUserQuestionCard

## Tests

- AskUserQuestionCard.test.tsx: 22/22 pass.
- pnpm --filter frontend typecheck: 0.
- pnpm --filter frontend lint: 0 errors (warnings unchanged from baseline).
- Note: 4 pre-existing failures in `frontend/src/stores/__tests__/reviewQueueStore.test.ts` — unrelated to this task (confirmed via git diff + commit dates).

## Visual Verification

- visual_macos / visual_web: skipped_unable per recurring TCC + Electron-bootstrap constraints documented in CLAUDE.md / docs/VISUAL-VERIFICATION-SETUP.md.

## Findings

- None new from this task.
