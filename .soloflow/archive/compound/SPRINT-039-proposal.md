---
sprints: [SPRINT-039]
span_label: SPRINT-039
created: 2026-05-26T00:00:00.000Z
counters_start:
  ideas: 27
summary:
  cleanups: 3
  backlog_tasks: 10
  claude_md: 2
  soloflow_improvements: 0
---

# Compound Proposal — SPRINT-039

## A. Clean-up items (execute now)

### A1. Delete duplicate §5 paragraph from questionRouter.ts header comment
- **Summary:** Remove the redundant §5 block in `questionRouter.ts`'s header invariant list, which duplicates §4 verbatim and should be deleted, with §6 renumbered to §5 for parity with ApprovalRouter.
- **Source-Sprint:** SPRINT-039
- **Rationale:** FIND-SPRINT-039-6 identified this as a copy-paste artifact from ApprovalRouter's header; the duplicated paragraph adds no information. ApprovalRouter has §1–§5 with no duplication; QuestionRouter's §5 is a near-verbatim paraphrase of §4 and will mislead readers into thinking there is a meaningful distinction.
- **Blast radius:** `main/src/orchestrator/questionRouter.ts` lines 28–31 (delete 4 lines, renumber one label); no logic change. Risk: trivial.
- **Source:** FIND-SPRINT-039-6 (TASK-758 code-reviewer)
- **Proposed change:**
  ```diff
  # main/src/orchestrator/questionRouter.ts
  # Delete lines 28–31 (the §5 block: "§5 Questions do NOT auto-expire ... the human triages.")
  # Renumber the following "§6" label to "§5".
  
  - * §5  Questions do NOT auto-expire — the workflow pauses until the human triages.
  - *
  - * §6  ...
  + * §5  ...
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed at `main/src/orchestrator/questionRouter.ts:24-31` — §4 and §5 are near-verbatim duplicates ("Questions do NOT auto-expire" / "Questions are NOT auto-expired"), §6 is renumbering trivially, blast radius is 4 lines in a comment with zero logic impact.

### A2. Add `AND status = 'pending'` guard to the cancel-race UPDATE in questionRouter.ts:respond
- **Summary:** Add a `AND status = 'pending'` guard to the unguarded `UPDATE questions SET status='timed_out'` fallback in `questionRouter.ts:respond`, matching the pattern used by `clearPendingForRun` and ApprovalRouter's idempotency conventions.
- **Source-Sprint:** SPRINT-039
- **Rationale:** FIND-SPRINT-039-7 identified that the cancel-race fallback at lines 314–315 of `questionRouter.ts` lacks the status guard present everywhere else in both routers. If `clearPendingForRun` runs first and sets `status='timed_out'` with a timestamp, the unguarded UPDATE then overwrites `answered_at` to a later wall-clock value — minor audit-trail noise but inconsistent. Adding the guard costs nothing and makes the pattern uniform across both routers.
- **Blast radius:** `main/src/orchestrator/questionRouter.ts` lines 314–315 (add `AND status = 'pending'` to one WHERE clause); no semantic change in the happy path. Risk: trivial.
- **Source:** FIND-SPRINT-039-7 (TASK-758 code-reviewer)
- **Proposed change:**
  ```diff
  # main/src/orchestrator/questionRouter.ts:314-315
  - WHERE id = ?
  + WHERE id = ? AND status = 'pending'
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed at `main/src/orchestrator/questionRouter.ts:313-316` — the cancel-race UPDATE has no `AND status = 'pending'` guard, while the sibling `clearPendingForRun` at lines 373-376 does; one-token addition restores idempotency parity at zero risk.

### A3. Replace inlined `widenWorkflowRunsCheckToNineStatuses` in stuckDetector.test.ts with `createTestDb({ includeQuestionsTable: true })`
- **Summary:** Eliminate the private copy of the migration 010 schema literal in `stuckDetector.test.ts` by calling the shared `createTestDb({ includeQuestionsTable: true })` helper that TASK-757 added to `orchestratorTestDb.ts`, and add a comment in `orchestratorTestDb.ts` noting it is the single source of truth for the post-010 schema in tests.
- **Source-Sprint:** SPRINT-039
- **Rationale:** FIND-SPRINT-039-17 identified that `stuckDetector.test.ts:51-99` contains a private `widenWorkflowRunsCheckToNineStatuses` helper that re-creates `workflow_runs` with the 9-status CHECK constraint — the exact same SQL that `createTestDb({ includeQuestionsTable: true })` applies. Both copies must be kept in sync on every future migration that widens the CHECK constraint; the shared helper exists in the same sprint and removes that risk. TASK-757 modified `stuckDetector.test.ts` (to seed `awaiting_input` runs in TEST 8) but chose to inline rather than parameterize.
- **Blast radius:** `main/src/orchestrator/__tests__/stuckDetector.test.ts` (delete private helper, call `createTestDb({ includeQuestionsTable: true })`), `main/src/orchestrator/__tests__/orchestratorTestDb.ts` (add one-line comment at :46). Re-run `pnpm --filter main test` to confirm green. Risk: low.
- **Source:** FIND-SPRINT-039-17 (sprint-code-reviewer)
- **Proposed change:**
  ```diff
  # stuckDetector.test.ts — remove inline widenWorkflowRunsCheckToNineStatuses function
  # and replace its call-sites with:
  - const db = createTestDb();
  - widenWorkflowRunsCheckToNineStatuses(db);
  + const db = createTestDb({ includeQuestionsTable: true });
  
  # orchestratorTestDb.ts:46 — add comment
  + // includeQuestionsTable: true is the single source of truth for the post-migration-010
  + // workflow_runs 9-status CHECK constraint in tests. Do NOT inline this SQL elsewhere.
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed `stuckDetector.test.ts:60-99` re-creates `workflow_runs` with the 9-status CHECK identically to `orchestratorTestDb.ts:66-81` (which loads migration 010 verbatim from file); two copies will drift on the next CHECK widening — drop-in helper swap is the smallest fix and the shared helper exists in this same sprint.

---

## B. Backlog tasks (refine into execution-ready plans)

### B1. Wire AskUserQuestionCard to read from questionStore.otherText (CRITICAL — epic completion gate)
- **Summary:** The `otherText` forwarding bus added by TASK-762 has a writer (ChatInput) but no reader; AskUserQuestionCard still uses its own local `useState` for the "Other" text input, so typing in the bottom bar in workflow-question mode is a no-op from the user's perspective.
- **Source-Sprint:** SPRINT-039
- **Source:** FIND-SPRINT-039-14 (TASK-762 verifier, HIGH severity)
- **Problem:** `ChatInput` in workflow-question mode calls `questionStore.setOtherText(activeQuestion.id, text)`, populating `questionStore.otherText[questionId]`. However `AskUserQuestionCard.tsx:216` maintains its own `useState<string[]>` for "Other" text and never imports or reads from `useQuestionStore`. The entire epic success signal ("when a question is pending, typing in the bottom bar forwards the text as the 'Other' answer in the card" — EPIC-per-run-chat-surface.md lines 14 and 34) remains unimplemented. Additionally: `clearOtherText` has no callers in the codebase today, so submitted answers leak bus state across question instances.
- **Proposed direction:** Subscribe `AskUserQuestionCard` to `useQuestionStore` and derive the "Other" text for each sub-question from `questionStore.otherText[item.id]`, preferring the bus value and falling back to local `useState` when the bus slot is undefined. Call `questionStore.clearOtherText(item.id)` from the submit handler so the bus slot is cleaned up. Separately, decide the multi-sub-question keying semantics: the current bus uses `Record<string, string>` keyed by `questionId`, but a single `Question` can carry 1–4 sub-questions — so all sub-questions share one "Other" slot. Options: (a) extend to `Record<string, Record<number, string>>` keyed by `(questionId, subIndex)`, (b) document that the bus is question-level only and the card distributes the same text to all sub-questions' Other fields uniformly. Files to touch: `frontend/src/components/AskUserQuestion/AskUserQuestionCard.tsx`, `frontend/src/stores/questionStore.ts` (if keying semantics change), relevant tests.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed `AskUserQuestionCard.tsx:216` uses only local `useState` for `otherText` and never imports `useQuestionStore`, while `ChatInput.tsx:112` writes to `setOtherText` and `clearOtherText` has zero callers across the codebase — the epic's stated success signal (typing in bottom bar forwards as "Other" answer) is fully unimplemented, severity high, this is the epic completion gate.

### B2. Fix pre-existing reviewQueueStore.test.ts failures from TASK-750 trpc-shim removal
- **Summary:** Four test failures in `frontend/src/stores/__tests__/reviewQueueStore.test.ts` have been present since TASK-750 (SPRINT-038) removed the tRPC shim; update the test mocks to reflect the post-TASK-750 tRPC subscription surface.
- **Source-Sprint:** SPRINT-039
- **Source:** FIND-SPRINT-039-2 (TASK-757 verifier; confirmed pre-existing via `git stash` baseline)
- **Problem:** `pnpm test:unit` exits non-zero due to `TypeError at trpc.cyboflow.events.onApprovalDecided.subscribe` in `reviewQueueStore.test.ts`. The four failing tests were authored against the pre-TASK-750 tRPC shim surface; the shim was removed in TASK-750 (commits `9927ca8` + `1127800`, SPRINT-038) without updating these tests. Every sprint from SPRINT-038 onward carries this noise in the test baseline, making it harder to identify genuine new failures. Separately: `questionStore.test.ts` (new in TASK-760) was written against the post-shim surface so it can serve as a template for the fix.
- **Proposed direction:** Update the four failing test cases in `frontend/src/stores/__tests__/reviewQueueStore.test.ts` to mock `trpc.cyboflow.events.onApprovalDecided` using the same pattern `questionStore.test.ts` uses for `trpc.cyboflow.questions.onQuestionAnswered` — i.e. mock the async-generator subscription procedure directly rather than going through the former shim. Files to touch: `frontend/src/stores/__tests__/reviewQueueStore.test.ts`. Confirm `pnpm test:unit` exits 0 after the fix (net improvement: removing the 4 pre-existing failures).
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Reproduced live — `pnpm --filter frontend test` shows exactly 4 failing tests in `reviewQueueStore.test.ts` with TypeErrors at `trpc.cyboflow.events.onApprovalDecided.subscribe`, while sibling `questionStore.test.ts` (lines 47-379) uses the correct post-shim mock pattern; persistent red baseline masks new regressions each sprint and the template exists.

### B3. Fix cancelAndRestartHandler to clear pending questions symmetrically with approvals
- **Summary:** `cancelAndRestartHandler.ts` calls `approvalRouter.clearPendingForRun` before `claudeManagerStop` but never calls `questionRouter.clearPendingForRun`, breaking the symmetry that TASK-757/758 established for the `awaiting_input` gate.
- **Source-Sprint:** SPRINT-039
- **Source:** FIND-SPRINT-039-15 (sprint-code-reviewer, medium severity)
- **Problem:** `cancelAndRestartHandler.ts:126` calls only `approvalRouter.clearPendingForRun(runId)` before `claudeManagerStop(runId)`. After TASK-757 added the `awaiting_input` run status and TASK-758 added `QuestionRouter`, a run paused on an AskUserQuestion gate that is `cancelAndRestart`d will not have its `QuestionRouter.pending` Map entry cleared until the SDK abort fires — losing the documented AC5 ordering rationale (send deny BEFORE PTY kill) for the question path. `CancelAndRestartDeps` has no `questionRouter` field; `main/src/index.ts` does not inject it. Practically benign today because the finally-block cleanup is idempotent, but the symmetry is broken and any future cancel-without-claude-stop path would leak.
- **Proposed direction:** Extend `CancelAndRestartDeps` to include `questionRouter: Pick<QuestionRouter, 'clearPendingForRun'>`. Add the `questionRouter.clearPendingForRun(runId)` call in `cancelAndRestartHandler.ts` immediately after the existing `approvalRouter.clearPendingForRun(runId)` call at line 126, with the same ordering-rationale comment. Inject `QuestionRouter.getInstance()` in `main/src/index.ts` via `setCancelAndRestartDeps()`. Add a regression test asserting both routers are called before `claudeManagerStop`. Files to touch: `main/src/orchestrator/cancelAndRestartHandler.ts`, `main/src/index.ts`, `main/src/orchestrator/__tests__/cancelAndRestartHandler.test.ts`.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed `cancelAndRestartHandler.ts:30` declares only `approvalRouter` in `CancelAndRestartDeps` and line 126 calls only `approvalRouter.clearPendingForRun(runId)` — after TASK-757/758 added the `awaiting_input` gate and `QuestionRouter`, the symmetry is genuinely broken; small surgical wiring fix that closes a correctness gap before any future cancel-without-claude-stop path exposes it.

### B4. Resolve onError asymmetry in reviewQueueStore and questionStore dual-subscription cleanup
- **Summary:** In both `reviewQueueStore.ts` and `questionStore.ts`, the second subscription's `onError` handler does not reset the `initialized` flag or unsubscribe the first subscription, leaving the store permanently "initialized" with no recovery path when the second subscription drops.
- **Source-Sprint:** SPRINT-039
- **Source:** FIND-SPRINT-039-8 (TASK-760 code-reviewer)
- **Problem:** In `reviewQueueStore.ts:225-239` and the mirrored pattern in `questionStore.ts:194-209`, the FIRST subscription's `onError` resets `initialized = false` and `cachedUnsubscribe = null` so a subsequent `init()` call can re-subscribe. The SECOND subscription's `onError` only sets `connectionStatus = 'disconnected'`. If the second subscription drops independently, the store remains "initialized" (the closure flag is true) and any subsequent `init()` call returns the stale cached unsubscribe without re-subscribing. Both stores are affected because `questionStore` was modeled on `reviewQueueStore` per plan.
- **Proposed direction:** In both `reviewQueueStore.ts` and `questionStore.ts`, update the second subscription's `onError` handler to mirror the first: call the cached unsubscribe for both subscriptions, reset `initialized = false`, and clear `cachedUnsubscribe = null`. Add a unit test in each store's test file asserting that triggering the second subscription's `onError` allows a subsequent `init()` call to re-subscribe successfully. Files to touch: `frontend/src/stores/reviewQueueStore.ts`, `frontend/src/stores/questionStore.ts`, their respective `__tests__` files.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed `reviewQueueStore.ts:236-239` and `questionStore.ts:248-251` both stop at `setConnectionStatus('disconnected')` without resetting `initialized`/`cachedUnsubscribe` — the FIRST subscriptions at lines 212-218 / 224-230 do the full reset, so the asymmetry strands the store unrecoverable across two production stores; targeted 4-line fix per store.

### B5. Add shared error-toast utility for action-card submit failures (AskUserQuestionCard + PendingApprovalCard)
- **Summary:** Both `AskUserQuestionCard` and `PendingApprovalCard` silently swallow submit errors with `.catch(() => {})`, giving users no feedback when `answer.mutate` or `approve/reject` fails due to network drop, stale question/approval ID, or server validation.
- **Source-Sprint:** SPRINT-039
- **Source:** FIND-SPRINT-039-9 (TASK-760 code-reviewer)
- **Problem:** `AskUserQuestionCard.tsx:335-345` and `PendingApprovalCard.tsx:261-275` both resolve submit failures by re-enabling the button and discarding the error. When `trpc.cyboflow.questions.answer.mutate` or the approve/reject mutation rejects (e.g. network drop, `NOT_FOUND` on a stale id, server validation error), the user sees only the button re-enabling — no indication of what went wrong. Re-clicking will continue to fail with no feedback.
- **Proposed direction:** Add a shared toast/error-surface utility — either a lightweight `useErrorToast()` hook that calls into the existing `cyboflowStore` error sink or a small standalone notification component. Consume it in both `PendingApprovalCard`'s approve/reject handlers (`PendingApprovalCard.tsx:261-275`) and `AskUserQuestionCard`'s submit handler (`AskUserQuestionCard.tsx:335-345`). Surface the underlying error message and the actionable ID (questionId / approvalId) so users can identify stale entries. Update tests to assert that a rejected mutation surfaces the error message. Files to touch: `frontend/src/components/AskUserQuestion/AskUserQuestionCard.tsx`, `frontend/src/components/ReviewQueue/PendingApprovalCard.tsx`, shared utility location TBD (likely `frontend/src/utils/` or `frontend/src/hooks/`).
- **Scope:** small

### Skeptic Verdict
- **Verdict:** DONT_IMPLEMENT
- **Confidence:** medium
- **Reasoning:** `grep` shows no existing toast/notification utility nor `cyboflowStore` error sink in the frontend — this task creates a new UX primitive (toast system + hook) speculatively for two callers when no user-reported friction is documented, and the proposal's "location TBD" admits the direction is unresolved; defer until either a user actually reports a silent failure or a third caller materializes.
- **Counterfactual:** A real user report of a silent submit failure, OR a pre-existing toast utility that just needs wiring up, would flip this to IMPLEMENT.

### B6. Deduplicate overlapping historical + live events in RunChatView.mergedTimeline
- **Summary:** `RunChatView.mergedTimeline` concatenates a point-in-time snapshot from `listMessages` with live stream events from `cyboflowStore.streamEvents` without deduplication; any event that arrived between `setActiveRun` and the `listMessages` query resolution renders twice in the chat view.
- **Source-Sprint:** SPRINT-039
- **Source:** FIND-SPRINT-039-11 (TASK-761 code-reviewer)
- **Problem:** `RunChatView.tsx:241-252` computes `mergedTimeline` as `historicalMessages.concat(streamEvents.filter(e => e.runId === runId))`. Both feeds derive from `raw_events`: `listMessages` returns a snapshot at query time while `streamEvents` accumulates from `setActiveRun` onward. The overlap window (events between `setActiveRun` and query resolution) is non-empty whenever a run is actively streaming when the user opens the Chat tab — duplicate bubbles are the expected steady-state UX for active runs, not an edge case. The plan acknowledged this as an "accepted low-cost tradeoff" but noted it was worth resolving before users report it.
- **Proposed direction:** Deduplicate by stable identity: ChatMessage rows have an `id` field (raw_events row id); StreamEvent assistant events expose `payload.message.id`. Build a `Set<string>` of historical message IDs and filter `streamEvents` to exclude events whose underlying message ID is already in the set before concatenating. Alternatively (simpler and ID-agnostic): only merge in `streamEvents` whose `timestamp` postdates the latest `historicalMessages` entry's `createdAt`. Add a unit test asserting that the overlap window does not produce duplicate bubbles. File to touch: `frontend/src/components/cyboflow/RunChatView.tsx`.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed `RunChatView.tsx:242-253` blind-concatenates historical + filtered live streams with no dedup; per the finding this is the steady-state UX (not edge case) for any actively-streaming run opened in the Chat tab — single-file fix, timestamp-only path is one line, and TASK-761's plan explicitly flagged this as worth resolving before users notice.

### B7. Extract shared GateRouter abstraction from ApprovalRouter and QuestionRouter
- **Summary:** `QuestionRouter` was cloned wholesale from `ApprovalRouter` (TASK-758), and the two share ~70% identical structure; extract a parameterized `GateRouter` base to prevent compounding duplication as future gate types are added.
- **Source-Sprint:** SPRINT-039
- **Source:** FIND-SPRINT-039-16 (sprint-code-reviewer, medium severity)
- **Problem:** The following are structurally identical across both routers: singleton pattern with `initialize/getInstance/_resetForTesting` (lines 140–162 in both), per-run `PQueue` map with lazy `getQueue` helper and no-recursive-enqueue docstring (lines 96–115), `requestX` shape with guarded transaction + `RunNotRunningError` (lines 222–258), `respond` shape with enqueue-recheck dance + auto-superseded path (lines 272–363), `clearPendingForRun` with idempotency guards (lines 355–419), `recoverStaleAwaiting*` with FK-cascade-style transitions (lines 398–456). The two created-bridge files (`approvalCreatedBridge.ts`, `questionCreatedBridge.ts`) share the same JOIN + `workflowName` fallback pattern with only table name and payload shape differing. A third gate type (e.g. policy-violation gates, IDEA-013 shell hooks) would compound the duplication further.
- **Proposed direction:** Extract a generic `GateRouter<TRequest, TResponse, TStatus>` base class or factory in `main/src/orchestrator/gateRouterCore.ts` parameterized on `{ tableName, parentAwaitingStatus, parentRunningStatus, gateInsertColumns, gateChildStatusOnTimeout }`. Move the shared PQueue scaffolding, transaction wrappers, and lifecycle methods into the core. Refactor `ApprovalRouter` and `QuestionRouter` as thin shells that delegate to it. Similarly extract a `buildGateCreatedEvent<TGate>` factory used by both bridges. Add a parity test that exercises the same race-condition matrix (requestX → respond, clearPendingForRun → respond interleave, recoverStale) against both router instances via the shared core. Files to touch: `main/src/orchestrator/approvalRouter.ts`, `main/src/orchestrator/questionRouter.ts`, new `gateRouterCore.ts`, `approvalCreatedBridge.ts`, `questionCreatedBridge.ts`.
- **Scope:** large

### Skeptic Verdict
- **Verdict:** DONT_IMPLEMENT
- **Confidence:** medium
- **Reasoning:** The rationale rests on speculative future gate types — IDEA-013 (cited as a third gate) is actually about replacing the SDK substrate, not adding a new gate kind, and "policy-violation gates" do not exist in any plan or idea today; a 900-line refactor across both routers + both bridges + new core + parity tests is disproportionate to two existing concrete callers, and the rule-of-three has not been hit yet.
- **Counterfactual:** A concrete third gate type entering planning (not just speculation) would flip this to IMPLEMENT — extract at extraction-time, not pre-emptively.

### B8. Extract shared preToolUseQuestionHookHelper mirroring preToolUseHookHelper
- **Summary:** The AskUserQuestion PreToolUse routing logic is inlined inside `claudeCodeManager.ts` instead of extracted as a sibling helper, giving it a hardcoded `[ClaudeCodeManager]` log label and making it uncallable from any other call-site (e.g. a future permissionModeMapper analogue).
- **Source-Sprint:** SPRINT-039
- **Source:** FIND-SPRINT-039-18 (sprint-code-reviewer, low severity)
- **Problem:** `claudeCodeManager.ts:551-590` contains a private `routeAskUserQuestion` method that performs the try/catch + hookSpecificOutput shape for AskUserQuestion routing. The existing `preToolUseHookHelper.ts` provides `routePreToolUseThroughApprovalRouter(pretool, callerId, callerLabel, logger)` with a parameterized `[${callerLabel}]` log label callable from any context. The question-routing path bakes in `[ClaudeCodeManager]` as a literal (line 583) and is entirely private to the manager. If `permissionModeMapper` or another caller ever needs to route an AskUserQuestion, the whole block must be duplicated.
- **Proposed direction:** Extract a `routePreToolUseThroughQuestionRouter(pretool, callerId, callerLabel, logger)` function — either as a new `main/src/orchestrator/preToolUseQuestionHookHelper.ts` or as an additive export in the existing `preToolUseHookHelper.ts`. Inline the `updatedInput: { questions, answers, ...annotations }` shape there. Update `claudeCodeManager.makePreToolUseHook` to call the extracted helper. Mirror the approval helper's test (`preToolUseHookHelper.test.ts`) with a question-routing variant. Files to touch: `main/src/services/panels/claude/claudeCodeManager.ts`, new/extended helper file, new test file.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** DONT_IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed `claudeCodeManager.ts:550-559` routes AskUserQuestion to `this.routeAskUserQuestion` (private method, ~30 lines) while non-question tools delegate to the shared helper, but only ONE caller exists (`claudeCodeManager`) — the hypothetical "future permissionModeMapper analogue" is speculative, the hard-coded `[ClaudeCodeManager]` log label is cosmetic, and extracting a new sibling file + new test for a one-caller method fails proportionality (low-RoI cleanup).
- **Counterfactual:** A second concrete caller needing AskUserQuestion routing would flip this to IMPLEMENT.

### B9. Extract shared selectPendingGate helper from questionListing.ts and approvalListing.ts
- **Summary:** `questionListing.ts` and `approvalListing.ts` share an identical SELECT-JOIN-with-renaming pattern (including JSON.parse try/catch and ORDER BY created_at ASC); a third gate listing would compound the duplication, so extract a parameterized `gateListing.ts` helper now.
- **Source-Sprint:** SPRINT-039
- **Source:** FIND-SPRINT-039-19 (sprint-code-reviewer, low severity)
- **Problem:** `questionListing.ts:42-82` and `approvalListing.ts` both: SELECT JOIN `workflow_runs` JOIN `workflows` with `column AS camelCaseColumn` aliasing; JSON.parse a payload column inside a row-mapping loop with `try/catch + console.warn` on failure; ORDER BY `created_at ASC`. Only the table name and projection shape differ. A third gate-table addition (policy violations, shell hooks) would require a third copy.
- **Proposed direction:** Create `main/src/orchestrator/gateListing.ts` with a `selectPendingGate<TRow, TGate>(db, opts: { table: string; payloadColumn: string; mapRow: (row: TRow) => TGate })` helper. Refactor both `questionListing.ts` and `approvalListing.ts` to delegate to it. Add a unit test asserting that a JSON.parse failure in `mapRow` returns the gate record with an empty payload (mirroring current `questionListing.ts` behavior). Files to touch: `main/src/orchestrator/questionListing.ts`, `main/src/orchestrator/approvalListing.ts`, new `main/src/orchestrator/gateListing.ts`.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** DONT_IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Both files are short (73 + 82 lines), the projection shapes differ per row, and the rationale invokes "a third gate-table addition (policy violations, shell hooks)" that does not exist in any current plan or idea — extracting a generic `selectPendingGate<TRow, TGate>` for two callers adds a new file and a new generic abstraction layer to save ~15 LOC, which fails proportionality.
- **Counterfactual:** A concrete third gate-listing entering planning would flip this — extract at extraction-time.

### B10. Remove dead constructor parameter from ApprovalRouter and QuestionRouter
- **Summary:** Both `ApprovalRouter` and `QuestionRouter` accept an `_getQueueForRun` constructor parameter marked unused (underscore prefix + jsdoc note), creating a misleading dependency-injection API surface that tests populate but the implementation silently ignores.
- **Source-Sprint:** SPRINT-039
- **Source:** FIND-SPRINT-039-20 (sprint-code-reviewer, low severity)
- **Problem:** `ApprovalRouter` and `QuestionRouter` constructors both accept `_getQueueForRun` as a parameter. Both implementations operate their own internal PQueue maps and ignore the injected factory. The parameter exists for parity with prior callers and the underscore prefix signals it is unused. This misleads readers into thinking the queue factory is a real injection point, and tests inject a queue factory that is never consulted. New gate-router additions copying either class will propagate the dead parameter. The planned `GateRouter` extraction (B7) would also inherit it unless it is cleaned up first or as part of that task.
- **Proposed direction:** Drop the `_getQueueForRun` parameter from both constructor signatures. Update the static `initialize` methods to 1-arg forms. Update all call-sites in `main/src/index.ts` and all test files that pass the now-unused factory argument. Add a comment in each constructor explaining why per-router PQueues are intentional (no recursive-enqueue with RunQueueRegistry). This can be done independently of B7 or rolled into the same task. Files to touch: `main/src/orchestrator/approvalRouter.ts`, `main/src/orchestrator/questionRouter.ts`, `main/src/index.ts`, relevant test files.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed `approvalRouter.ts:125` and `questionRouter.ts:125` both take an unused `_getQueueForRun` and grep finds 8+ call sites (4 in test files + `main/src/index.ts:719,734`) passing the now-dead factory; the misleading injection surface will propagate to any new gate-router copy and the fix is mechanical signature narrowing — small, contained, removes a real footgun for future contributors.

### B11. Extract shared ToolUseBlockRow component from RunChatView and RunView
- **Summary:** `RunChatView`'s `renderAssistantBlock` and `RunView`'s `AssistantEventRow` both inline an identical compact `tool:<name>` + JSON-stringified-input rendering snippet; extract a shared component so future tool-block UI changes only need one edit.
- **Source-Sprint:** SPRINT-039
- **Source:** FIND-SPRINT-039-12 (TASK-761 code-reviewer, low severity)
- **Problem:** `RunChatView.tsx:86-95` and `RunView.tsx:117-127` both render tool_use blocks as a compact `tool: <name>` label plus a JSON-stringified `input` box. The duplication was intentional (per TASK-761 plan's "Hardest Decision" section, TASK-761 mirrored RunView's shape), but the snippet now lives in two places. Any future styling change to the tool-use block must be applied twice.
- **Proposed direction:** Extract a `renderToolUseBlock(block: ToolUseBlock): ReactElement` function (or a small `ToolUseBlockRow` component) to `frontend/src/components/cyboflow/eventBlockRenderers.tsx`. Call it from both `RunView`'s `AssistantEventRow` and `RunChatView`'s `renderAssistantBlock`. Re-run frontend tests; both files should shrink by approximately 8 lines each. Files to touch: `frontend/src/components/cyboflow/RunChatView.tsx`, `frontend/src/components/cyboflow/RunView.tsx`, new `frontend/src/components/cyboflow/eventBlockRenderers.tsx`.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** DONT_IMPLEMENT
- **Confidence:** low
- **Reasoning:** Confirmed `RunChatView.tsx:87-96` and `RunView.tsx:117-127` render identical tool_use blocks (~8 LOC each), but the duplication was the documented "Hardest Decision" of TASK-761 (intentional, plan-acknowledged), no styling change is queued, and creating a new `eventBlockRenderers.tsx` file with its own import surface to save 8 lines fails proportionality — wait until the next styling change touches one site to extract opportunistically.
- **Counterfactual:** A queued task that changes tool-block styling would flip this to IMPLEMENT — extract during the next touch.

---

## C. CLAUDE.md / CODE-PATTERNS.md improvements (apply now)

### C1. Add one-shot Peekaboo TCC diagnostic to CLAUDE.md visual verification section
- **Summary:** Update the CLAUDE.md visual verification section to explicitly state that both Screen Recording and Accessibility grants must be held by the MCP host process binary (not just by Cyboflow.app or Warp), and include a one-shot diagnostic command that confirms which process holds each grant.
- **Source-Sprint:** SPRINT-039
- **Target file:** `CLAUDE.md`
- **Rationale:** FIND-SPRINT-039-1 identified that this TCC gap has recurred across SPRINT-031 through SPRINT-039 (TASK-655, TASK-715, TASK-752, TASK-756, TASK-761). Each verifier session re-discovers the same failure (`"The user declined TCCs for application, window, display capture"`) and escalates to the queue, then proceeds with `skipped_unable`. The current CLAUDE.md line reads only "Both Screen Recording AND Accessibility grants are required — see `docs/VISUAL-VERIFICATION-SETUP.md`" without specifying *which binary* must hold the grants. The human-review-queue entry for `visual_macos_unavailable` (dedup_key) has accumulated five affected tasks across multiple sprints (TASK-655, TASK-715, TASK-752, TASK-756, TASK-761) and was last updated at `2026-05-26T23:13:57.893Z`.
- **Proposed change:**
  ```diff
  # CLAUDE.md — in the existing visual verification paragraph (after "Both Screen Recording AND Accessibility grants are required")
  
  - The `visual_web` / Playwright MCP path is NON-FUNCTIONAL here (renderer cannot bootstrap without Electron `preload`). Use `visual_macos` via Peekaboo MCP with `pnpm dev` running. Both Screen Recording AND Accessibility grants are required — see `docs/VISUAL-VERIFICATION-SETUP.md`.
  + The `visual_web` / Playwright MCP path is NON-FUNCTIONAL here (renderer cannot bootstrap without Electron `preload`). Use `visual_macos` via Peekaboo MCP with `pnpm dev` running. Both Screen Recording AND Accessibility grants are required — see `docs/VISUAL-VERIFICATION-SETUP.md`.
  +
  + **TCC grant host note (recurring failure across SPRINT-031..SPRINT-039):** grants must be held by the **MCP host process binary** (the process that issues CGDisplay / CGWindow capture calls — typically the Claude Code CLI binary or its Node subprocess), not only by Cyboflow.app or the terminal emulator (Warp). If `mcp__peekaboo__image` fails with "The user declined TCCs for application, window, display capture" even when `server_status` reports grants as present, run the one-shot diagnostic:
  + ```bash
  + # Confirm which process holds Screen Recording + Accessibility grants:
  + sqlite3 ~/Library/Application\ Support/com.apple.TCC/TCC.db \
  +   "SELECT client, auth_value, last_modified FROM access WHERE service IN ('kTCCServiceScreenCapture','kTCCServiceAccessibility') ORDER BY service, client;"
  + ```
  + Look for the MCP host binary path (e.g. `/usr/local/bin/node` or the Claude Code CLI) in the `client` column with `auth_value=2`. If missing, grant Screen Recording and Accessibility to that binary in System Settings → Privacy & Security, then restart `pnpm dev`.
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed recurrence — `.soloflow/human-review-queue.md:35-40` lists 5 affected tasks (TASK-655, TASK-715, TASK-752, TASK-756, TASK-761) under one dedup key spanning SPRINT-031..SPRINT-039, and the existing CLAUDE.md line at line 45 says "both grants are required" without identifying which binary; verifier sessions keep re-discovering the gap, and a one-shot diagnostic command is a high-leverage addition.
- **Counterfactual:** If the per-machine memory note about Warp now holding grants meant new verifier sessions actually pass, the recurrence would stop — but the queue's most recent update timestamp (2026-05-26) and TASK-761's done report at line 26 show the gap is still live.

### C2. Add SQLite migration pattern for PRAGMA foreign_keys outside transaction to CODE-PATTERNS.md
- **Summary:** Document in `docs/CODE-PATTERNS.md` that `PRAGMA foreign_keys=OFF/ON` must be toggled outside the `db.transaction(...)` wrapper in migration runners, because SQLite silently ignores pragma changes issued inside a transaction — a footgun that nearly caused silent cascade-deletion of all approvals, messages, and raw_events rows during migration 010.
- **Source-Sprint:** SPRINT-039
- **Target file:** `docs/CODE-PATTERNS.md`
- **Rationale:** TASK-757 hit a critical data-loss bug: the original migration 010 implementation toggled `PRAGMA foreign_keys=OFF` inside `this.transaction(...)`, which SQLite silently no-ops. In production `runFileBasedMigrations`, this meant the `DROP TABLE workflow_runs` in migration 010 would have CASCADE-deleted every row in `approvals`, `messages`, and `raw_events` on upgrade. The fix (move the pragma toggle outside the transaction wrapper, add a `finally` to unconditionally restore `ON`) was caught only by a code reviewer who noticed the discrepancy between the dev test path (direct `db.exec` under autocommit) and the production path. TASK-757's done report notes this as a code-review-driven critical fix (`executor_loops: 0, code_review_rounds: 1`). Any future migration that needs to DROP + RENAME a table with FK children will need this same pattern.
- **Proposed change:**
  ```diff
  # docs/CODE-PATTERNS.md — add a new section "SQLite Migration Patterns" (or append to existing DB section)
  
  + ## SQLite Migration Patterns
  +
  + ### PRAGMA foreign_keys must be toggled OUTSIDE db.transaction()
  +
  + SQLite silently ignores `PRAGMA` statements issued inside a transaction. If a migration needs to
  + temporarily disable FK enforcement (e.g. to DROP and RENAME a table that has FK children),
  + the pragma toggle MUST be outside the transaction wrapper:
  +
  + ```typescript
  + // CORRECT — pragma outside the transaction:
  + db.pragma('foreign_keys = OFF');
  + try {
  +   db.transaction(() => {
  +     db.exec('DROP TABLE workflow_runs');
  +     db.exec('ALTER TABLE workflow_runs_new RENAME TO workflow_runs');
  +   })();
  + } finally {
  +   db.pragma('foreign_keys = ON');
  + }
  +
  + // WRONG — pragma inside the transaction (silently no-ops; FK enforcement stays ON):
  + db.transaction(() => {
  +   db.pragma('foreign_keys = OFF'); // ← ignored by SQLite
  +   db.exec('DROP TABLE workflow_runs'); // ← CASCADE deletes all FK children
  + })();
  + ```
  +
  + See `main/src/database/database.ts` `runFileBasedMigrations` for the production implementation
  + and `main/src/database/__tests__/fileMigrationRunner.test.ts` for the regression test that
  + exercises the production-path wrapper (added in TASK-757 after this footgun caused a near
  + data-loss event during migration 010 development).
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed `main/src/database/database.ts:1591-1625` already encodes the pattern with a sourced explanatory comment ("SQLite docs: PRAGMA foreign_keys toggles are no-ops inside a transaction") that nearly caused silent cascade deletion in TASK-757 production migration 010; CODE-PATTERNS.md has a Database section but no migration footgun entry, severity = data-loss class, and any future DROP+RENAME migration will need the same shape — the rule will pay for itself the next time someone writes a destructive migration.

---

## Reconciled Findings (informational)

The following findings had `status: open` in the findings file but were reported as resolved in done reports. No triage action needed; recorded here as a safety-net audit trail.

- FIND-SPRINT-039-3 — findings file status was `resolved`; done report TASK-758 confirms resolution.
- FIND-SPRINT-039-4 — findings file status was `resolved`; done report TASK-758 confirms resolution.
- FIND-SPRINT-039-5 — findings file status was `resolved`; done report TASK-758 confirms resolution.
- FIND-SPRINT-039-10 — findings file status was `resolved`; done report TASK-761 confirms resolution.
- FIND-SPRINT-039-13 — findings file status was `resolved` (pre-authorized scope deviation); done report TASK-762 confirms resolution.
