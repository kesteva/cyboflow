---
sprint: SPRINT-013
pending_count: 12
last_updated: "2026-05-17T16:59:42.599Z"
---
# Findings Queue

SPRINT-013 started with missing infra: docker; tests deferred.
TASK-555 gated: failing blocking prereq (Notarization requires Apple ID + team ID + app-specific password).

## FIND-SPRINT-013-1
- **type:** scope_deviation
- **source:** TASK-504 (executor)
- **severity:** low
- **status:** resolved
- **location:** main/src/trpc/routers/runs.ts
- **description:** Claimed new file to host getStuckInspectionHandler following the approveRestOfRunHandler pattern in main/src/trpc/routers/approvals.ts. Required to meet AC for backend integration test which tests the handler directly. The orchestrator trpc router path (main/src/orchestrator/trpc/routers/runs.ts) is owned by TASK-254.
- **resolved_by:** verifier — plan-prescribed: `main/src/trpc/routers/runs.ts` is explicitly listed in TASK-504 plan `files_owned` (line 12); not a real deviation.

## FIND-SPRINT-013-2
- **type:** improvement
- **source:** TASK-503 (executor)
- **severity:** low
- **status:** open
- **location:** frontend/src/hooks/useStuckNotifications.ts:54
- **description:** The hook accesses cyboflow.events.onStuckDetected via a cast through unknown because TASK-254 (in-flight, owns the events router) has not yet added the subscription to the tRPC router. When TASK-254 lands, the cast on line 130 should be removed and the import updated to use the typed tRPC path directly.
- **suggested_action:** After TASK-254 merges, remove the StuckEventsClient interface and cast in useStuckNotifications.ts; use trpc.cyboflow.events.onStuckDetected directly.

## FIND-SPRINT-013-3
- **type:** scope_deviation
- **source:** TASK-504 (executor)
- **severity:** low
- **status:** resolved
- **location:** frontend/src/components/ReviewQueue/__tests__/PendingApprovalCard.test.tsx
- **description:** Claimed new file per test_strategy in TASK-504 plan which lists this file as a test target. The plan says tests should be additive alongside TASK-502 tests in this same file.
- **resolved_by:** verifier — plan-prescribed: `frontend/src/components/ReviewQueue/__tests__/PendingApprovalCard.test.tsx` is explicitly listed in TASK-504 plan `files_owned` (line 13) and in `test_strategy.targets`; not a real deviation.

## FIND-SPRINT-013-4
- **source:** TASK-501 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/stuckDetector.ts:258-267
- **description:** `transitionToStuck` wraps a single `UPDATE` statement in a `db.transaction(() => ...)`, which adds no atomicity benefit — a lone UPDATE is already atomic in SQLite. The wrapping also forces the awkward `(txn as () => { changes: number })()` double-cast on call. The `WHERE id = ? AND status = 'awaiting_review'` guard (not the transaction) is what provides the idempotency safety.
- **suggested_action:** Drop the `db.transaction()` wrapper, run the UPDATE directly, and remove the cast on the call site.
- **resolved_by:** 

## FIND-SPRINT-013-5
- **source:** TASK-501 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/stuckDetector.ts:153-156, 219-222, 229-233, 259-263
- **description:** `db.prepare()` is called inside `scan()` and `classifyStaleApproval()` on every tick / every approval row. better-sqlite3 has internal statement caching so the cost is small, but the four statements (stale-approval SELECT, self-deadlock COUNT, cross-run SELECT, transition UPDATE) are static SQL with no dynamic structure — hoisting them to private readonly fields prepared once in the constructor would be cleaner and clearly cheaper.
- **suggested_action:** Prepare the four static statements lazily once and cache them on the instance.
- **resolved_by:** 

## FIND-SPRINT-013-6
- **source:** TASK-501 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/stuckDetector.ts:174, main/src/orchestrator/stuckDetector.ts:46-48
- **description:** Two minor surface issues. (a) `this.logger.warn('[StuckDetector] scan failed', { error: String(err) })` drops the stack trace — passing `err` directly (or `{ error: err instanceof Error ? err.stack : String(err) }`) gives debuggability for the v1 self-host phase where this path may fire. (b) `PermissionServerLike.hasClientForSession(runId: string)` has a parameter named `runId` but a method named `Session`; the same naming inconsistency appears in `StuckDetectorDeps.permissionServer` JSDoc ("connected for a given run ID") — pick one ("Run" or "Session") so callers don't second-guess which identifier to pass.
- **suggested_action:** Log the Error object directly (not `String(err)`); rename `hasClientForSession` to `hasClientForRun` since the schema uses `run_id` not `session_id`.
- **resolved_by:** 

## FIND-SPRINT-013-7
- **type:** scope_deviation
- **source:** TASK-504 (executor)
- **severity:** low
- **status:** resolved
- **location:** shared/types/stuckInspection.ts
- **description:** required to meet Important #1 improvement: extract StuckInspectionResult, RawEvent, PendingApproval, and WorkflowRunStatus re-export to shared module to break the import cycle between main/src/orchestrator/trpc/routers/runs.ts and main/src/trpc/routers/runs.ts
- **resolved_by:** verifier — plan-prescribed: `shared/types/stuckInspection.ts` is explicitly listed in TASK-504 plan `files_owned` (line 14); not a real deviation.

## FIND-SPRINT-013-8
- **type:** scope_deviation
- **source:** TASK-502 (verifier)
- **severity:** low
- **status:** resolved
- **location:** main/src/orchestrator/cancelAndRestartHandler.ts
- **description:** New file created to host the cancel-and-restart business logic, extracted from the tRPC mutation. Not listed in TASK-502 `files_owned`. The plan's Step 6 specifies the mutation body inline; the executor extracted to a handler module following the established pattern in TASK-504's `main/src/trpc/routers/runs.ts` (`getStuckInspectionHandler`) so the orchestration is unit-testable without a tRPC context. The integration test (`cancelAndRestart.test.ts`, plan-owned) calls the handler directly and would not be feasible without this extraction.
- **resolved_by:** verifier — AC-prescribed: AC4 mandates "Integration test in `cancelAndRestart.test.ts`" that asserts ordered side effects, DB state, and the absence of `worktreeManager.remove`. The handler extraction is required to satisfy AC4's testability without coupling the integration test to the tRPC context.

## FIND-SPRINT-013-9
- **type:** scope_deviation
- **source:** TASK-502 (verifier)
- **severity:** low
- **status:** resolved
- **location:** main/src/orchestrator/trpc/routers/runs.ts
- **description:** Plan `files_owned[3]` references `main/src/orchestrator/router/runs.ts` (a path that does not exist in the tree). The actual cyboflow runs router lives at `main/src/orchestrator/trpc/routers/runs.ts` (created by TASK-254 skeleton, previously modified by TASK-504). The executor correctly added the `cancelAndRestart` procedure to the canonical file rather than creating a duplicate directory.
- **resolved_by:** verifier — plan-prescribed: `main/src/orchestrator/router/runs.ts` is a typo in TASK-502's `files_owned` list for the canonical `main/src/orchestrator/trpc/routers/runs.ts`; same logical file.

## FIND-SPRINT-013-10
- **type:** improvement
- **source:** TASK-502 (verifier)
- **severity:** low
- **status:** open
- **location:** frontend/src/components/ReviewQueue/StuckBadge.tsx:41-50
- **description:** Plan Step 1 specifies the tooltip should render BOTH `stuck_reason` AND `stuck_detected_at` (relative time). Implementation renders only the `reason` string via the native `title` attribute and does not surface `stuck_detected_at`. AC1 only requires the reason, so this is not a blocker, but the plan-prescribed "(relative time)" enrichment is missing.
- **suggested_action:** Add an optional `detectedAt?: number | string` prop to `StuckBadgeProps`; format it relative to now (e.g. via `formatAge`) and append to the title string as `"<reason> · <relativeTime>"`. Update PendingApprovalCard to pass `detectedAt` once the slice exposes it (currently the slice keeps detectedAt internal to `applyStuckEvent` but does not store it).
- **resolved_by:** 

## FIND-SPRINT-013-11
- **type:** improvement
- **source:** TASK-502 (verifier)
- **severity:** low
- **status:** open
- **location:** frontend/src/stores/reviewQueueSlice.ts:71, 89-89
- **description:** Plan Step 4 says "Add a `runStatus` field to each queue item, defaulted from the approval's joined `workflow_runs.status`." Implementation maintains a separate `runStatusMap: Record<runId, WorkflowRunStatus>` rather than augmenting each `QueueItem`. The architectural rationale is documented inline (lines 1-30) and ReviewQueueView is expected to do the lookup when wiring up. AC6 is satisfied (reducer flips the matching runId's status reactively), and the implementation is arguably cleaner — but the plan-prescribed per-item field is not present. Also `applyStuckEvent` receives `reason` and `detectedAt` parameters but discards them — the reducer body only writes 'stuck' to the map.
- **suggested_action:** Either (a) add `runReasonMap` and `runDetectedAtMap` to persist reason / detectedAt alongside status, enabling StuckBadge to render the full tooltip; or (b) drop the unused parameters from the reducer signature to make the discard explicit.
- **resolved_by:** 

## FIND-SPRINT-013-12
- **type:** anti-pattern
- **source:** TASK-502 (verifier)
- **severity:** low
- **status:** open
- **location:** frontend/src/stores/reviewQueueSlice.ts:147-162
- **description:** `subscribeToStuckEvents` casts `trpc.cyboflow.events` through `unknown` to a hand-rolled `StuckEventsClient` interface because TASK-254 (in-flight, owns events router) has not yet added the typed `onStuckDetected` subscription. Same pattern as FIND-SPRINT-013-2 in `useStuckNotifications.ts`. When TASK-254 lands, both casts should be removed in a single sweep.
- **suggested_action:** After TASK-254 merges, remove `StuckEventsClient` interface and the `as unknown as StuckEventsClient` cast in `reviewQueueSlice.ts`; use `trpc.cyboflow.events.onStuckDetected` directly. Coordinate with the resolution of FIND-SPRINT-013-2.
- **resolved_by:** 

## FIND-SPRINT-013-8
- **type:** bug
- **source:** TASK-551 (verifier)
- **severity:** low
- **status:** open
- **location:** main/src/utils/nodeFinder.ts:42, main/src/utils/shellDetector.ts:105
- **description:** `pnpm --filter frontend typecheck` fails on `main` (and on the TASK-551 worktree) with two TS6133 unused-variable errors: `'pattern' is declared but its value is never read` in nodeFinder.ts:42 and `'findExecutable' is declared but its value is never read` in shellDetector.ts:105. Pre-existing — not introduced by TASK-551 (last touched in commit `beccb21` by TASK-003 during the Crystal-baseline platform-conditional cleanup). Frontend typecheck transitively includes the main package via project refs, so this surfaces on every frontend verification but is owned by main. Should be cleaned up so future verifiers don't have to repeatedly note "pre-existing baseline failure."
- **suggested_action:** Either remove the unused `pattern` / `findExecutable` declarations, prefix them with `_` to opt out of TS6133, or add `// eslint-disable-next-line` equivalents (`@ts-expect-error` won't apply to declarations). Lowest-friction fix: delete the two unused locals/imports.

## FIND-SPRINT-013-14
- **source:** TASK-551 (code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** frontend/src/components/ReviewQueueView.tsx:28-53, frontend/src/hooks/useReviewQueueKeyboard.ts:63-130
- **description:** TASK-551 adds a second `window.keydown` listener inside `ReviewQueueView` solely to detect the first y/n keypress for onboarding dismissal. This duplicates the modifier-key check (`metaKey/ctrlKey/altKey`) and the input-focus guard (`HTMLInputElement` / `HTMLTextAreaElement` / `isContentEditable`) that already live in `useReviewQueueKeyboard.ts:67-74`. Two listeners now fire on every keystroke and both maintain identical guard logic — divergence risk if one is updated and the other forgotten. The hook already knows when y/n was pressed against a non-empty queue; passing a single `onFirstDecide?: () => void` callback into `useReviewQueueKeyboard` (invoked from the y/n branches at lines 91-122) would let the view drop its second listener entirely.
- **suggested_action:** Add an optional `onDecide?: (key: 'y' | 'n') => void` param to `useReviewQueueKeyboard`, call it from the y/n switch arms after the mutation fires, and replace the new keydown effect in `ReviewQueueView` with a memoized callback that fires `dismissOnboarding()` once via a ref guard. Net effect: one listener, one guard, same behavior.
- **resolved_by:** 

## FIND-SPRINT-013-15
- **source:** TASK-551 (verifier)
- **type:** bug
- **severity:** medium
- **status:** open
- **location:** frontend/src/components/PendingApprovalCard.tsx:120, 127, 150, 156
- **description:** AC3 of TASK-551 states the card should dismiss when "clicking Got it button OR approving/rejecting any queue item." The current implementation only dismisses on (a) Got it button click and (b) keyboard `y`/`n` keypress (via ReviewQueueView's keydown listener). Mouse-clicking the Approve / Reject button in PendingApprovalCard does NOT call `dismissOnboarding()` — the approve/reject mutation fires but the onboarding card remains visible until the user either clicks "Got it" or uses keyboard navigation. The executor chose the keydown layer to respect `files_owned` boundaries (PendingApprovalCard is not in files_owned for TASK-551), but the AC text reads as covering both interaction modalities. Pre-existing from round 1 — round 2 did not introduce or worsen this; it focused on the keyboard-unmount fix.
- **suggested_action:** Either (a) follow-up task that adds an `onDecide?: () => void` prop to PendingApprovalCard and wires it from ReviewQueueView so click-decide also fires dismissOnboarding, or (b) tighten AC3's text in future tasks to clarify "keyboard-decide only" if click-decide auto-dismiss is not desired UX. Note: the preference IS eventually written on the user's first keyboard interaction, so the dismissal is not permanently blocked — only delayed for mouse-only users.
- **resolved_by:** 

## FIND-SPRINT-013-16
- **source:** TASK-551 (verifier)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** frontend/src/components/OnboardingCard.tsx:43-44, frontend/src/components/ReviewQueueView.tsx:28-55
- **description:** Round 2 fix lifts the dismissed state to ReviewQueueView. In controlled mode, OnboardingCard initialises `checked=true` (line 44) and renders immediately, since the parent owns the preference read. However, ReviewQueueView's mount effect (lines 38-55) reads the preference asynchronously — so for a returning user (preference='true'), the card briefly renders before the parent's async effect commits `setOnboardingDismissed(true)`. The window is one async tick (typically <16ms) and may not produce a visible flash on most hardware, but it is a regression from round 1's behavior, where OnboardingCard gated rendering on its own internal `checked` state. AC4 says "reloading the renderer never shows the card again" — strictly, a sub-16ms render does technically violate this.
- **suggested_action:** Either (a) add a `loading?: boolean` prop to OnboardingCard so the parent can signal "preference not yet read"; or (b) have ReviewQueueView initialise `onboardingDismissed` from the preference synchronously via a non-async read (not currently possible with the IPC channel); or (c) accept the trade-off and document that the parent-owned-state model has a one-frame window. Recommend (a) — minimal API surface change, restores round-1 no-flash behavior.
- **resolved_by:** 

## FIND-SPRINT-013-17
- **type:** improvement
- **source:** TASK-502 (verifier)
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/__tests__/cancelAndRestart.test.ts
- **description:** The round-2 transaction wrap (commit 20e1e3a) adds a `changes === 0` guard inside `db.transaction()` that throws when the run was concurrently moved to a terminal state between the row-fetch guard and the UPDATE. This is the precise race-window the transaction wrap is designed to handle, but no test exercises it — the existing 12 tests cover only the happy path, the noOp-on-terminal-status path (where the row-fetch guard fires), and the claudeManagerStop rejection branches. Adding a regression test (e.g., a deps with a db whose UPDATE prepare returns `{ changes: 0 }`) would lock in the behavior and prevent silent regression if a future edit drops the guard.
- **suggested_action:** Add one test case in cancelAndRestart.test.ts that stubs the UPDATE prepare to return changes=0 and asserts the handler throws with the expected message and that the new-run INSERT is NOT executed.
