---
sprint: SPRINT-039
pending_count: 5
last_updated: "2026-05-26T23:15:00.000Z"
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
