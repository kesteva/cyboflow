---
id: TASK-760
sprint: SPRINT-039
epic: ask-user-question-roundtrip
status: done
summary: "Shipped frontend AskUserQuestionCard component (chip Pill header, radio/checkbox option groups, collapsible markdown preview, implicit Other free-text) and questionStore Zustand store with init() idempotency + onQuestionCreated/onQuestionAnswered delta subscriptions, mirroring the PendingApprovalCard + reviewQueueStore patterns."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: skipped_unable
---

# TASK-760 — AskUserQuestionCard UI and questionStore

## Outcome

- **`AskUserQuestionCard`** at `frontend/src/components/AskUserQuestion/AskUserQuestionCard.tsx` — props `{ item: Question, onAnswered?: () => void }`. Renders the question payload's `header` inside a `Pill` (truncated to 12 chars + ellipsis); each question is a `<fieldset>` with `aria-label` from full question text. Single-select questions render as radio groups (shared name), multi-select as checkbox groups. Per-option `description` text, optional collapsible `MarkdownPreview` toggled by an `aria-expanded`/`aria-controls` button. Implicit "Other" radio/checkbox enables a sibling free-text input. Submit is disabled until every question has a valid selection (or Other+non-empty text). On submit, calls `trpc.cyboflow.questions.answer.mutate({ questionId: item.id, answers })` with `answers` keyed by full question text and comma-joined labels for multi-select (matches the SDK `Record<string, string>` shape).
- **`questionStore`** at `frontend/src/stores/questionStore.ts` — Zustand store mirroring `reviewQueueStore`. Exports `useQuestionStore` plus `pureAddQuestion` / `pureRemoveQuestion` / `pureReplaceAll`. `init()` runs full-state resync via `trpc.cyboflow.questions.listPending.query()`, then subscribes to `trpc.cyboflow.questions.onQuestionCreated` and `onQuestionAnswered`. Closure-private `initialized` + `cachedUnsubscribe` make `init()` idempotent under React StrictMode double-mount. No `syncBadge` call (questions don't drive the macOS dock badge).
- Cyboflowstore intentionally unchanged.

## Verification

- All 13 ACs met (verifier APPROVED).
- 39 new tests pass (18 component + 21 unit). `pnpm typecheck` (root) 0; `pnpm --filter frontend lint` 0; scoped test command exits 0.
- FIND-SPRINT-039-2 (pre-existing reviewQueueStore failures) unchanged — this task did not modify reviewQueueStore.

## Findings logged

- **FIND-SPRINT-039-8** — Latent leak in `questionStore.onQuestionCreated.onError` (does not unsubscribe sibling `onQuestionAnswered`). Faithful port of the same pattern in `reviewQueueStore.ts:225-239`; cross-cutting fix.
- **FIND-SPRINT-039-9** — Silent submit-failure UX in `AskUserQuestionCard` (`.catch` swallows errors with no user feedback). Faithful port of `PendingApprovalCard.tsx:261-275`; cross-cutting UX gap.

## Notes

- `truncateHeader` uses `String.prototype.slice` (UTF-16 code units, not codepoints). Surrogate-safe truncation would require `[...text].slice(0, n).join('')`. Latent edge case only if header content ever broadens beyond ASCII tool-config labels (current contract caps headers at 12 chars upstream).
- Plan step 2 referenced `trpc.cyboflow.events.onQuestionCreated/onQuestionAnswered`, but the actual router exposes these on `trpc.cyboflow.questions.*` (verified). The implementation targets the real router; test files document this divergence in a header comment.
- Live visual verification of the card is genuinely deferred — the card is not mounted in `CyboflowRoot` until TASK-761 wires it into `RunChatView` / `RunBottomPane`. TASK-761's verifier will exercise the rendered card.

## Commits

- `c73555c` — feat(TASK-760): AskUserQuestionCard component + questionStore (Zustand) + tests
