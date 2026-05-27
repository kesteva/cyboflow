---
sprint: SPRINT-039
pending_count: 15
last_updated: "2026-05-26T23:47:20.908Z"
---
# Findings Queue

## FIND-SPRINT-039-1
- **source:** TASK-756 (verifier)
- **type:** claude-md
- **severity:** medium
- **status:** open
- **location:** docs/VISUAL-VERIFICATION-SETUP.md
- **description:** Recurring TCC-grant gap: Peekaboo MCP server_status reports Screen Recording=granted but Accessibility=not granted, AND live image() capture fails with "The user declined TCCs for application, window, display capture" even on screen:0 / frontmost / by-PID-window. This recurs across SPRINT-031..SPRINT-039 (TASK-655, TASK-715, TASK-752, now TASK-756). Compounder candidate: docs/VISUAL-VERIFICATION-SETUP.md should explicitly call out that BOTH permissions must be granted to the MCP host process (the binary actually issuing the CGDisplay / CGWindow calls), not just to Cyboflow.app or Warp, and include a one-shot diagnostic command. Currently each verifier session re-discovers the gap, escalates to the queue, then proceeds with skipped_unable.

## FIND-SPRINT-039-2
- **category:** flaky_test
- **severity:** medium
- **title:** reviewQueueStore.test.ts has 4 pre-existing failures from TASK-750 trpc-shim removal
- **summary:** pnpm test:unit fails with 4 errors in frontend/src/stores/__tests__/reviewQueueStore.test.ts (TypeError at trpc.cyboflow.events.onApprovalDecided.subscribe). Confirmed pre-existing baseline via git stash against pre-TASK-757 state. Root cause is trpc-shim removal in TASK-750 (SPRINT-038, commits 9927ca8 + 1127800).
- **files:** frontend/src/stores/__tests__/reviewQueueStore.test.ts
- **action:** Open a follow-up task to update reviewQueueStore.test.ts mocks for the post-TASK-750 trpc surface.

## FIND-SPRINT-039-3
- **type:** scope_deviation
- **source:** TASK-758 (executor)
- **severity:** low
- **status:** resolved
- **location:** shared/types/questions.ts
- **description:** QuestionRequest type missing from shared/types/questions.ts (file was files_readonly in plan). Required to meet AC: questionRouter.ts imports QuestionRequest and QuestionAnswer from this module per plan step 2, and questionCreatedBridge.ts buildQuestionCreatedEvent(request: QuestionRequest) also imports it. Added QuestionRequest interface to the shared types file.
- **resolved_by:** verifier — AC-prescribed: plan step 2 explicitly imports QuestionRequest from this module and AC14 requires both questionRouter.ts and questionCreatedBridge.ts to typecheck standalone; AC6 requires workflowName on the returned event. TASK-757's commit b28c084 did not export QuestionRequest nor workflowName on Question, so the additive edit is the only path to satisfy the ACs (planning oversight, not over-reach).

## FIND-SPRINT-039-4
- **type:** scope_deviation
- **source:** TASK-758 (executor)
- **severity:** low
- **status:** resolved
- **location:** main/src/services/panels/claude/__tests__/claudeCodeManagerWiring.test.ts
- **description:** required to meet AC: claudeCodeManager.runSdkQuery finally block now calls QuestionRouter.getInstance().clearPendingForRun(panelId), which throws if QuestionRouter is not initialized. The existing wiring tests initialize ApprovalRouter but not QuestionRouter; they fail with QuestionRouter not initialized error. Updated wiring test to also initialize/reset QuestionRouter in each describe block that exercises runSdkQuery.
- **resolved_by:** verifier — not actually a scope deviation: the file is in files_owned (plan frontmatter line 17). The init/reset additions are AC-prescribed by AC8 + AC14 (test:unit) — without them the suite throws "QuestionRouter not initialized" at runtime.

## FIND-SPRINT-039-5
- **type:** scope_deviation
- **source:** TASK-758 (executor)
- **severity:** low
- **status:** resolved
- **location:** main/src/services/panels/claude/__tests__/claudeCodeManager.killProcess.test.ts
- **description:** required to meet AC: claudeCodeManager.runSdkQuery finally block now calls QuestionRouter.getInstance().clearPendingForRun(panelId). The existing killProcess tests initialize ApprovalRouter but not QuestionRouter, causing failures. Updated to also initialize/reset QuestionRouter.
- **resolved_by:** verifier — not actually a scope deviation: the file is in files_owned (plan frontmatter line 18). The init/reset additions are AC-prescribed by AC8 + AC14 (test:unit) — without them the suite throws "QuestionRouter not initialized" at runtime.

## FIND-SPRINT-039-6
- **source:** TASK-758 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/questionRouter.ts:24-30
- **description:** Header-comment §4 and §5 are near-duplicates — both state "Questions do NOT auto-expire ... workflow pauses until the human (responds|triages)". Looks like a paraphrase artifact from copying ApprovalRouter's invariant list. The ApprovalRouter header has §1–§5 with no duplication; QuestionRouter's §5 should be deleted (it adds no information beyond §4) and the trailing §6 renumbered to §5, keeping parity with ApprovalRouter.
- **suggested_action:** Delete questionRouter.ts lines 28–31 (§5 paragraph + blank-line separator); renumber existing §6 to §5.
- **resolved_by:** 

## FIND-SPRINT-039-7
- **source:** TASK-758 (code-reviewer)
- **type:** anti-pattern
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/questionRouter.ts:312-316
- **description:** In `respond`'s `info.changes === 0` cancel-race fallback, the `UPDATE questions SET status='timed_out', answered_at=? WHERE id=?` is unguarded (no `AND status='pending'` filter). If `clearPendingForRun(runId)` has already run and set `status='timed_out'` with a prior timestamp, this UPDATE clobbers `answered_at` to a later value — minor audit-trail noise but inconsistent with `clearPendingForRun`'s guarded pattern (questionRouter.ts:374-376) and ApprovalRouter's idempotency conventions. Idempotent in the steady state but the lack of guard hides any future double-write bug.
- **suggested_action:** Change line 314-315 to `WHERE id = ? AND status = 'pending'` for parity with clearPendingForRun and ApprovalRouter's clear path.
- **resolved_by:** 

## FIND-SPRINT-039-8
- **source:** TASK-760 (code-reviewer)
- **type:** anti-pattern
- **severity:** low
- **status:** open
- **location:** frontend/src/stores/reviewQueueStore.ts:225-239 (and now mirrored in frontend/src/stores/questionStore.ts:194-209)
- **description:** Cross-cutting onError closure-cleanup asymmetry: in both reviewQueueStore.ts and the freshly-ported questionStore.ts, the FIRST subscription's onError handler clears `initialized = false` and `cachedUnsubscribe = null` so a subsequent init() re-subscribes, but the SECOND subscription's onError handler only sets connectionStatus to 'disconnected'. If the second (decided/answered) subscription drops independently of the first, the store is "still initialized" by the closure flag → init() returns the cached unsubscribe → user is stuck on a disconnected store with no path to recover. TASK-760 faithfully ports this pattern from the upstream reviewQueueStore (per plan), so this is NOT a new defect in TASK-760's diff — it is a latent issue in the shared pattern across both stores.
- **suggested_action:** In a follow-up task, make the second subscription's onError mirror the first: unsubscribe both subscriptions, reset `initialized = false`, clear `cachedUnsubscribe = null`. Apply to both reviewQueueStore.ts:236-239 and questionStore.ts:205-208. Add a unit test asserting that triggering the second subscription's onError allows a subsequent init() to re-subscribe.

## FIND-SPRINT-039-9
- **source:** TASK-760 (code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** frontend/src/components/AskUserQuestion/AskUserQuestionCard.tsx:335-345 (matches frontend/src/components/ReviewQueue/PendingApprovalCard.tsx:261-275)
- **description:** Silent submit-failure UX: when `trpc.cyboflow.questions.answer.mutate` rejects, the card swallows the error in `.catch(() => {})` and only re-enables the button — there is no toast, no inline error, no console message visible to the user. The same pattern exists in PendingApprovalCard.tsx for approve/reject. Re-clicking submit may continue to fail with no indication of what went wrong (network drop, server validation, NOT_FOUND on a stale questionId). TASK-760 faithfully ports the PendingApprovalCard idiom per plan step 6, so this is NOT a TASK-760-introduced defect — it's a cross-cutting UX gap in the action-card pattern. TASK-761's wiring task is a natural place to introduce a shared error-toast utility consumed by both card families.
- **suggested_action:** Add a shared toast/snackbar utility (or surface to an existing error sink in cyboflowStore) and call it from both PendingApprovalCard's approve/reject handlers and AskUserQuestionCard's submit handler. Include the underlying error message and the actionable id so users can recover.

## FIND-SPRINT-039-10
- **type:** scope_deviation
- **source:** TASK-761 (executor)
- **severity:** low
- **status:** resolved
- **location:** frontend/src/components/cyboflow/__tests__/RunBottomPane.test.tsx
- **description:** RunBottomPane.test.tsx references data-testid run-bottom-pane-chat-placeholder which was removed by this tasks RunBottomPane.tsx edit (AC8). The Chat tab test needs updating to assert RunChatView renders instead. Required to meet AC typecheck gate.
- **resolved_by:** TASK-761

## FIND-SPRINT-039-11
- **source:** TASK-761 (code-reviewer)
- **type:** bug
- **severity:** low
- **status:** open
- **location:** frontend/src/components/cyboflow/RunChatView.tsx:241-252 (mergedTimeline)
- **description:** RunChatView's mergedTimeline concatenates `historicalMessages` (from `cyboflow.runs.listMessages`) with `streamEvents.filter(e => e.runId === runId)` with no deduplication. Both feeds derive from raw_events: listMessages returns a snapshot of all assistant-text + user-text turns at query time, while streamEvents accumulates from `setActiveRun(runId)` onward (the store resets streamEvents on setActiveRun). Any event that arrived between the setActiveRun call and listMessages query resolution will appear in BOTH arrays, rendering twice in the chat view. The plan explicitly acknowledged this as an accepted low-cost tradeoff ("Hardest Decision" section), but in practice every time a user opens the Chat tab for an actively-streaming run, the overlap window is non-empty — so duplicate bubbles are the expected steady-state UX, not the edge case. Worth resolving before users notice and report it.
- **suggested_action:** When merging, dedupe by stable identity: ChatMessage rows have `id` (raw_events row id or assistant message id); StreamEvent assistant events expose `payload.message.id` and user events expose `payload.message` content with `tool_use_id`. Drop any streamEvent whose underlying message id is already present in historicalMessages, OR (simpler) only mix in streamEvents whose timestamp postdates the latest historicalMessages.createdAt. Add a test asserting overlap dedup. Coordinate with TASK-759 owner if a stronger id-correlation contract is needed on the wire shape.
- **resolved_by:** 

## FIND-SPRINT-039-12
- **source:** TASK-761 (code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** frontend/src/components/cyboflow/RunChatView.tsx:86-95 + frontend/src/components/cyboflow/RunView.tsx:117-127
- **description:** Light duplication between RunChatView's non-AskUserQuestion tool_use rendering branch (`renderAssistantBlock`) and RunView's `AssistantEventRow` tool_use branch. The plan explicitly chose to mirror RunView's shape ("same compact `tool: <name>` + JSON-stringified input box that RunView's AssistantEventRow renders") so the duplication is intentional, but the snippet is now in two places. Extracting a tiny `ToolUseBlockRow` shared component (or a `renderToolUseBlock(block)` helper) would let both call sites share output, and would also localize any future styling change. Not a blocker — small surface, both copies are short — but worth considering when the next tool-block UI tweak lands.
- **suggested_action:** Extract `renderToolUseBlock(block: ToolUseBlock): ReactElement` to a small shared module under `frontend/src/components/cyboflow/` (e.g. `eventBlockRenderers.tsx`) and call from both RunView's AssistantEventRow and RunChatView's renderAssistantBlock. Re-run frontend tests; both files should shrink by ~8 lines each.
- **resolved_by:** 

## FIND-SPRINT-039-13
- **type:** scope_deviation
- **source:** TASK-762 (executor)
- **severity:** low
- **status:** open
- **location:** frontend/src/stores/questionStore.ts
- **description:** TASK-760 did not ship an "Other"-text bus setter (confirmed by reading the file). TASK-762 plan explicitly anticipated this gap in its Lowest Confidence Area section and pre-authorized Option A: adding otherText: Record<string, string> keyed by questionId plus setOtherText/clearOtherText reducers. This minimal extension keeps ChatInput dumb and AskUserQuestionCard the sole submit authority — required to meet AC4 (workflow-question mode forwards to questionStore, not tRPC).
- **suggested_action:** No action needed — extension is intentional and pre-authorized by TASK-762 plan orchestrator note.
- **resolved_by:** 

## FIND-SPRINT-039-14
- **source:** TASK-762 (verifier)
- **type:** bug
- **severity:** high
- **status:** open
- **location:** frontend/src/components/AskUserQuestion/AskUserQuestionCard.tsx:216-218 (and frontend/src/stores/questionStore.ts:52-100, frontend/src/components/cyboflow/ChatInput.tsx:106-114)
- **description:** The `otherText` bus added by TASK-762 to `questionStore` is currently a write-only sink — ChatInput populates `questionStore.otherText[questionId]` via `setOtherText` in workflow-question mode, but AskUserQuestionCard maintains its own LOCAL `useState<string[]>` for "Other" text (line 216) and never imports or subscribes to `useQuestionStore` for that field. Result: typing in the bottom-bar ChatInput in workflow-question mode silently writes to a store nothing reads. The user sees their text disappear from the textarea (ChatInput clears on send) but the card's "Other" field stays empty. From the user's perspective the bottom-bar input is a no-op in workflow-question mode. This breaks the epic's stated success signal ("when a question is pending, typing forwards the text as the 'Other' answer", per EPIC-per-run-chat-surface.md line 14 and line 34). TASK-762's literal AC4 passes (ChatInput calls setOtherText and not trpc.answer.mutate; both unit tests assert this), but the consumer-side wiring was never planned: TASK-760 didn't ship a reader (its plan predates the bus), TASK-762's plan focused on ChatInput only, and the epic has no third task. The plan's "Hardest Decision" justified the forwarding pattern on the assumption that AskUserQuestionCard would read from the bus — that assumption was never realized in code. Recommend a follow-up task to (a) make AskUserQuestionCard subscribe to questionStore.otherText keyed by item.id, prefer the bus value over local state in the "Other" text input, fall back to local state when bus value is undefined, and (b) decide on bus semantics for multi-sub-question cards (currently keyed by questionId not (questionId, subIndex), so multi-sub-question cards would stomp each other on the otherText[item.id] slot). Also unused: the `clearOtherText` reducer has no callers in the codebase.
- **suggested_action:** Open a follow-up task (suggest TASK-772 against the per-run-chat-surface epic, or roll into a future ask-user-question-roundtrip fix) to wire AskUserQuestionCard to read `questionStore.otherText[item.id]` and use it to prefill the per-question "Other" input. Also clarify keying semantics for multi-sub-question cards (extend the bus to `Record<string, Record<number, string>>` keyed by `(questionId, subIndex)`, or document that the bus is question-level only and the card distributes the text to all sub-questions' Other fields uniformly). Call `clearOtherText(questionId)` from AskUserQuestionCard's submit handler so the bus value doesn't leak across question instances.
- **resolved_by:** 

## FIND-SPRINT-039-15
- **source:** SPRINT-039 (sprint-code-reviewer)
- **type:** bug
- **severity:** medium
- **status:** open
- **location:** main/src/orchestrator/cancelAndRestartHandler.ts:126
- **description:** cancelAndRestartHandler clears pending approvals but not pending questions — symmetry violation across the new awaiting_input gate.
- **suggested_action:** In cancelAndRestartHandler.ts, immediately after the approvalRouter.clearPendingForRun call at line 126 add `questionRouter.clearPendingForRun(runId)` with the same ordering rationale comment. Extend CancelAndRestartDeps to require a `questionRouter: Pick<QuestionRouter, clearPendingForRun>` field and inject in main/src/index.ts setCancelAndRestartDeps(). Add a regression test that asserts both routers are called before claudeManagerStop.
- **resolved_by:** 






cancelAndRestartHandler.ts:126 calls only `approvalRouter.clearPendingForRun(runId)` before `claudeManagerStop(runId)`. After TASK-757 added the `awaiting_input` run status and TASK-758 added `QuestionRouter`, a run paused on an AskUserQuestion gate that is `cancelAndRestart`d:
  1. Will NOT have its in-process `QuestionRouter.pending` Map entry cleared until the SDK abort fires.
  2. Loses the documented ordering rationale from cancelAndRestart AC5 (send deny BEFORE PTY kill) for the question path — the question Promise only resolves AFTER `claudeManagerStop` reaches the runSdkQuery `finally` block at claudeCodeManager.ts:391.

Practically benign today because the finally-block cleanup is idempotent (both clears can race without corruption), but the symmetry is broken and any future direct cancel-without-claude-stop path would leak.

Suspected tasks: TASK-757 (added awaiting_input), TASK-758 (added QuestionRouter + finally cleanup) — neither owns cancelAndRestartHandler.ts and the cross-task gap was not noticed.

## FIND-SPRINT-039-16
- **source:** SPRINT-039 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/orchestrator/questionRouter.ts (vs main/src/orchestrator/approvalRouter.ts)
- **description:** Significant cross-task duplication between QuestionRouter and ApprovalRouter — extraction candidate.
- **suggested_action:** Open a follow-up cleanup task that extracts a shared `GateRouter` abstraction. Concrete shape: parameterize on (tableName, parentAwaitingStatus, parentRunningStatus, gateInsertColumns, gateChildStatusOnTimeOut). Move the shared transaction-and-PQueue scaffolding into `gateRouterCore.ts`. Approval and question routers become thin shells delegating to the core. Bridges merge into `buildGateCreatedEvent<TGate>` parameterized by table + projection. Add a parity test that exercises the same race-condition matrix against both router instances.
- **resolved_by:** 





The pair is structurally identical for ~70%+ of their public surface:
  - Singleton pattern with identical initialize/getInstance/_resetForTesting (questionRouter.ts:140-162 vs approvalRouter.ts:140-162).
  - Per-run PQueue map with identical lazy getQueue helper, identical no-recursive-enqueue docstring (questionRouter.ts:96-115 vs approvalRouter.ts:96-114).
  - `requestX` shape: same db.transaction wrapping a guarded UPDATE workflow_runs (status=running guard) + INSERT into the gate table; same `RunNotRunningError` (questionRouter.ts:222-255 vs approvalRouter.ts:222-258).
  - `respond` shape: same enqueue-then-recheck dance, same guarded UPDATE, same auto-superseded path (questionRouter.ts:272-335 vs approvalRouter.ts:281-363).
  - `clearPendingForRun`: identical shape including the guarded UPDATE for idempotency and the swallow-on-shutdown comment (questionRouter.ts:355-388 vs approvalRouter.ts:383-419).
  - `recoverStaleAwaiting{Input,Review}`: nearly identical FK-cascade-style transitions on parent + child rows (questionRouter.ts:398-424 vs approvalRouter.ts:430-456).
  - The two createdBridge files (approvalCreatedBridge.ts, questionCreatedBridge.ts) share the same JOIN-at-bridge / workflowName fallback / console.warn-on-missing pattern with only the table name and event payload shape differing.

TASK-758 cloned ApprovalRouter to build QuestionRouter — the per-task code-reviewer (FIND-SPRINT-039-6 / -7) caught individual drift but only a sprint-level view sees that the whole pair is begging for a shared `GateRouter<TRequest, TResponse, TStatus>` base. Future gate types (e.g. policy-violation gates, IDEA-013 shell hooks) will compound the duplication.

Suspected tasks: TASK-758 (whole-cloth clone) — but the extraction must happen across both routers, so this is sprint-level work, not a TASK-758 callback.

## FIND-SPRINT-039-17
- **source:** SPRINT-039 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/orchestrator/__tests__/stuckDetector.test.ts:51-99
- **description:** Cross-task test-fixture drift: stuckDetector.test.ts inlines the migration 010 table-recreation SQL via a private `widenWorkflowRunsCheckToNineStatuses` helper instead of using the shared `createTestDb({ includeQuestionsTable: true })` extension TASK-757 added to orchestratorTestDb.ts:66-81.
- **suggested_action:** Replace the inline `widenWorkflowRunsCheckToNineStatuses` body in stuckDetector.test.ts with a call to `createTestDb({ includeQuestionsTable: true })`. Re-run vitest. Add a comment in orchestratorTestDb.ts:46 noting that this option is the single source of truth for the post-010 schema in tests.
- **resolved_by:** 




Both helpers do the exact same thing — recreate workflow_runs with the 9-status CHECK constraint — by copy-pasting the schema literal. If migration 011 (or any subsequent CHECK widening) lands, BOTH copies must be updated in lockstep or the test silently runs against a stale CHECK.

The shared helper exists in this very sprint (TASK-757); the divergence is an integration miss. The stuckDetector test was modified by TASK-757 (to seed `awaiting_input` runs in TEST 8) but the test author chose to inline rather than parameterize createTestDb. Per-task review only saw one file at a time; only sprint scope catches the duplication.

Suspected tasks: TASK-757 (added both the helper and the inline copy).

## FIND-SPRINT-039-18
- **source:** SPRINT-039 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/services/panels/claude/claudeCodeManager.ts:551-590 vs main/src/orchestrator/preToolUseHookHelper.ts
- **description:** AskUserQuestion PreToolUse routing duplicates the shape of routePreToolUseThroughApprovalRouter without using the shared helper.
- **suggested_action:** Add `routePreToolUseThroughQuestionRouter(pretool, callerId, callerLabel, logger)` to a new file `main/src/orchestrator/preToolUseQuestionHookHelper.ts` (or extend preToolUseHookHelper.ts with both routes). Inline the AskUserQuestion-specific updatedInput shape there. Update claudeCodeManager.makePreToolUseHook to dispatch via the routed pair. Mirror the approval helper test (preToolUseHookHelper.test.ts) for the question variant.
- **resolved_by:** 



The approval path (preToolUseHookHelper.ts) provides a `routePreToolUseThroughApprovalRouter(pretool, callerId, callerLabel, logger)` helper that wraps the try/catch + hookSpecificOutput shape, callable from both permissionModeMapper and claudeCodeManager. TASK-758 added an analogous `routeAskUserQuestion` method INSIDE claudeCodeManager.ts (lines 561-590) instead of extracting a sibling helper.

Results:
  - The two routes have hard-coded log labels (`[ClaudeCodeManager]` baked into the literal at line 583) vs the parameterized `[${callerLabel}]` pattern in the approval helper.
  - Question routing cannot be invoked from any other caller (e.g. a future permissionModeMapper analogue) without further duplication.
  - The `updatedInput: { questions, answers, ...annotations }` shape is hand-rolled and would diverge from a future shared shape.

Cross-task: TASK-758 owned both files but the existing helper convention (preToolUseHookHelper.ts predates this sprint) was not extended; per-task code-reviewer accepted the inline implementation.

Suspected tasks: TASK-758.

## FIND-SPRINT-039-19
- **source:** SPRINT-039 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/questionListing.ts vs main/src/orchestrator/approvalListing.ts
- **description:** Duplicated SELECT-JOIN-with-renaming pattern across listing modules.
- **suggested_action:** Extract a `selectPendingGate<TRow, TGate>(db, opts: { table; payloadColumn; mapRow: (row) => TGate })` helper in a new `main/src/orchestrator/gateListing.ts`. Both questionListing and approvalListing become thin wrappers. Add a unit test confirming the JSON.parse failure path returns the gate with an empty payload (mirroring the current questionListing behavior).
- **resolved_by:** 


questionListing.ts:42-82 and approvalListing.ts have the same shape: SELECT JOIN workflow_runs JOIN workflows with `column AS camelCaseColumn` aliasing, JSON.parse of a payload column inside the row-mapping loop with a try/catch + console.warn on parse failure, ORDER BY created_at ASC. Only the table name and the projection shape differ.

With two listings already cloned, a third gate-table addition (e.g. policy violations, shell hooks) will compound the duplication. Worth extracting now while the pattern is fresh.

Suspected tasks: TASK-759 (cloned approvalListing.ts) — the per-task reviewer would not flag this since approvalListing.ts is outside the task scope.

## FIND-SPRINT-039-20
- **source:** SPRINT-039 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/questionRouter.ts:123-128 (and main/src/orchestrator/approvalRouter.ts:123-128)
- **description:** Dead constructor parameter pattern propagated across both routers.

Both ApprovalRouter and QuestionRouter accept _getQueueForRun as a constructor parameter and explicitly mark it unused via underscore prefix and jsdoc note. Both routers operate their own per-router PQueue map internally. The parameter exists for parity with prior callers and tests.

This is a cross-task code smell: a misleading API surface that suggests dependency injection and tests do inject a queue factory while the implementation ignores the input. New router additions are likely to copy the same dead-parameter dance.

Suspected tasks: TASK-758 propagated the pattern from approvalRouter.ts.
- **suggested_action:** Drop the unused parameter from both constructor signatures and update the initialize static method to a 1-arg form. Update all call sites in main/src/index.ts and tests. Add a comment in the constructor explaining why per-router PQueues are intentional - no recursive-enqueue with RunQueueRegistry.
- **resolved_by:** 
