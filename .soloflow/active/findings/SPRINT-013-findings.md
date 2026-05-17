---
sprint: SPRINT-013
pending_count: 21
last_updated: "2026-05-17T17:42:38.896Z"
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

## FIND-SPRINT-013-18
- **type:** improvement
- **source:** TASK-553 (executor)
- **severity:** low
- **status:** open
- **location:** frontend/src/stores/mcpHealthStore.ts:subscribeToMcpHealth
- **description:** The mcpHealthStore currently polls via the cyboflow:mcp-health IPC channel (5-second interval) because the TASK-535 (cyboflow-mcp-server epic) dependency does not yet exist. When TASK-535 lands and emits a push-based health event, this store should subscribe to trpc.cyboflow.events.onMcpHealth instead of polling. The subscription wiring point is the subscribeToMcpHealth() action — replace the setInterval block with the tRPC subscription and remove the polling interval.
- **suggested_action:** After TASK-535 merges, replace the setInterval polling in mcpHealthStore.subscribeToMcpHealth() with trpc.cyboflow.events.onMcpHealth.subscribe(). Remove the FUTURE comment markers.
- **resolved_by:** 

## FIND-SPRINT-013-19
- **source:** TASK-553 (verifier)
- **type:** cleanup
- **severity:** medium
- **status:** open
- **location:** frontend/src/stores/mcpHealthStore.ts + frontend/src/hooks/useMcpHealth.ts + frontend/src/components/Sidebar.tsx (lines 9, 22, 177-183)
- **description:** TASK-553 introduces a Zustand `mcpHealthStore` that polls `cyboflow:mcp-health` every 5s and renders a colored dot via the new `StatusBar` + `McpHealthIndicator`. A parallel implementation already exists: the `useMcpHealth` hook (`frontend/src/hooks/useMcpHealth.ts`) polls the same channel on the same 5s interval, and `Sidebar.tsx` already renders a green/yellow/red MCP dot driven by that hook. The runtime now runs two independent 5s polling loops against the same IPC channel and shows two MCP status dots (one in the sidebar's drag-handle area, one in the new status bar). The TASK-553 plan listed the existing hook only obliquely (the Sidebar dot is in neither `files_owned` nor `files_readonly`), so the executor was not formally directed to consolidate — but the duplication is real and should be resolved before TASK-535 lands the push subscription (otherwise both consumers will need migrating).
- **suggested_action:** When TASK-535 lands the push-based `onMcpHealth` subscription, refactor `useMcpHealth` to read from `mcpHealthStore` (one polling/subscription owner) and either remove the sidebar dot in favor of the status bar dot or keep both UIs but feed them from the single store. Decide product-side which dot location wins.

## FIND-SPRINT-013-20
- **source:** TASK-553 (verifier)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** frontend/src/stores/mcpHealthStore.ts:lastError mapping
- **description:** The store maps `McpServerHealth.lastError` from the IPC payload to its `lastError` field on every poll without preserving the previous error when the next poll returns no error (e.g., status flips to 'running' but `lastError` is undefined). This is technically correct (latest snapshot wins), but combined with AC4 ("last error message (if any)") it means a transient error briefly shown to the user disappears on the next clean tick — the user has 5s max to see it before it's overwritten. Consider preserving `lastError` until the user dismisses the popover or status is healthy for N successive polls. Not a blocker — current behavior is consistent with the IPC contract.
- **suggested_action:** Either preserve `lastError` across polls when transitioning healthy→error→healthy quickly, or document the "5s visibility window" tradeoff in the store doc-comment so future readers know it is intentional.
- **resolved_by:** 

## FIND-SPRINT-013-21
- **source:** SPRINT-013 (sprint-code-reviewer)
- **type:** bug
- **severity:** high
- **status:** open
- **location:** frontend/src/components/ReviewQueueView.tsx:3, frontend/src/stores/reviewQueueSlice.ts (unused), main/src/orchestrator/trpc/routers/runs.ts:40 (setCancelAndRestartDeps never called)
- **description:** Sprint-wide integration gap — the entire stuck-detection UI surface introduced by TASK-502 and TASK-504 is unreachable at runtime. Three independent disconnects:
- **suggested_action:** Add a backlog follow-up task that: (1) replaces ReviewQueueView.tsx:3 with `import { PendingApprovalCard } from ./ReviewQueue/PendingApprovalCard;` and threads runStatus + stuckReason props through; (2) mounts `useReviewQueueSlice.subscribeToStuckEvents()` once at app top-level (e.g., inside App.tsx alongside `useStuckNotifications`) and exposes a `useRunStatus(runId)` selector for cards; (3) calls `setCancelAndRestartDeps({ db, approvalRouter, runQueues, claudeManagerStop })` from main/src/index.ts during bootstrap. Without (1)+(2)+(3) the whole sprint UI is invisible.
- **resolved_by:** 






1. ReviewQueueView.tsx:3 imports `PendingApprovalCard` from `./PendingApprovalCard` (the base Crystal-era card), NOT from `./ReviewQueue/PendingApprovalCard` (the new stuck-detection-aware variant). The new card renders StuckBadge, the `Why stuck?` button, and the `Cancel and restart` button — none of these ever appear in the running app.

2. `useReviewQueueSlice` (frontend/src/stores/reviewQueueSlice.ts) is not imported by any non-test consumer. Its `subscribeToStuckEvents()` action is never called from App.tsx or any view, so the `runs:stuck` subscription is never established and `runStatusMap` stays empty.

3. `setCancelAndRestartDeps()` (main/src/orchestrator/trpc/routers/runs.ts:40) is never called anywhere in main/src/. Even if the cancel button were rendered, the mutation would throw METHOD_NOT_SUPPORTED.

Net effect: zero observable behaviour from the stuck-detection-and-observability epic until a follow-up wires (a) the new card into ReviewQueueView, (b) reviewQueueSlice into the view + slice → card prop pipeline, and (c) setCancelAndRestartDeps at boot. The detector still classifies runs as stuck and writes the DB column, but the user can never see or act on it.

Suspected tasks: TASK-502, TASK-504

## FIND-SPRINT-013-22
- **source:** SPRINT-013 (sprint-code-reviewer)
- **type:** bug
- **severity:** high
- **status:** open
- **location:** frontend/src/hooks/useStuckNotifications.ts:22-28, 136-153
- **description:** StuckDetectedEvent schema divergence between the orchestrator (TASK-501) and the notification hook (TASK-503). They are NOT compatible.
- **suggested_action:** In useStuckNotifications.ts: (1) delete lines 22-28 (the locally-redeclared StuckDetectedEvent interface); (2) `import type { StuckDetectedEvent, StuckReason } from ../../../shared/types/stuckDetection`; (3) change `stuckReasonText(kind: StuckReasonKind)` to `stuckReasonText(reason: StuckReason)` and switch on `reason.kind`; (4) drop `sessionId`/`workflowName` references in the notification body — fetch the workflow name from a lookup (e.g., useReviewQueueStore by `runId`) and use `runId` for suppression keying (or have the orchestrator add a `workflowName` field to the canonical event if product wants it in the toast). Coordinates with FIND-SPRINT-013-2 (the cast through `unknown`).
- **resolved_by:** 





Orchestrator emits (shared/types/stuckDetection.ts:42-51, stuckDetector.ts:270-276):
```
{ runId: string; approvalId: string; reason: StuckReason (object {kind:...}); detectedAt: number }
```

useStuckNotifications.ts:22-28 locally redeclares its own interface with the same name but different shape:
```
{ runId; sessionId; workflowName; reason: StuckReasonKind (plain string); detectedAt }
```

Fields `sessionId` and `workflowName` do NOT exist in the orchestrator payload. `reason` is treated as a plain string (`stuckReasonText(reason)` at line 149 expects `case orphan_pty: ...`) but the real payload sends an object like `{kind: orphan_pty}`.

When TASK-254 wires `trpc.cyboflow.events.onStuckDetected` to the real event bus, the notification body becomes `Run "undefined" is stuck: undefined` (or worse, throws a switch-exhaustiveness error because `reason` is an object).

The existing test suite passes because tests construct events from the hooks own re-declared type — they never see the real wire shape.

The parallel slice in reviewQueueSlice.ts correctly imports the canonical `StuckDetectedEvent` from `shared/types/stuckDetection.ts`. The hook should do the same; the divergence is hook-only.

Suspected tasks: TASK-503 (introduced the divergence), TASK-501 (owns the canonical schema)

## FIND-SPRINT-013-23
- **source:** SPRINT-013 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** frontend/src/components/ReviewQueue/StuckInspectorModal.tsx:27-37, frontend/src/hooks/useStuckNotifications.ts:42-49
- **description:** Duplicate stuck-reason → human-readable label maps with divergent wording, owned by two different tasks. Same four StuckReason variants are mapped twice, in different ways, for different UI surfaces:
- **suggested_action:** Move the canonical reason-label map to `shared/types/stuckDetection.ts` (or a new `shared/types/stuckReasonLabels.ts` if pure-type module purity is required — though strings are constants, not runtime). Export both a verbose form (modal) and a short form (notification body) keyed by `StuckReason["kind"]`. Both consumers then import the single source. When a new variant is added the TS exhaustiveness check forces both labels in lockstep.
- **resolved_by:** 




StuckInspectorModal.tsx (TASK-504, line 27-37):
- self_deadlock → `Self-deadlock — this run has multiple pending approvals stacked up`
- cross_run_deadlock → `Cross-run deadlock — another run is also awaiting review`
- orphan_pty → `Orphan PTY — the Claude process for this run is no longer running`
- stale_socket → `Stale socket — the permission socket client has disconnected`

useStuckNotifications.ts (TASK-503, line 42-49):
- self_deadlock → `self-deadlock`
- cross_run_deadlock → `cross-run deadlock`
- orphan_pty → `Claude process exited`
- stale_socket → `permission socket disconnected`

Different casing, different terminology (`Claude process exited` vs `Claude process is no longer running`), and if a fifth variant is ever added in shared/types/stuckDetection.ts only one site will be updated.

Suspected tasks: TASK-503, TASK-504

## FIND-SPRINT-013-24
- **source:** SPRINT-013 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** frontend/src/hooks/useStuckNotifications.ts:60-70, frontend/src/stores/reviewQueueSlice.ts:46-56
- **description:** Duplicate `StuckEventsClient` forward-looking subscription interface, declared identically in two files added by different tasks (TASK-502 + TASK-503). Both define the same 5-line interface and the same `trpc.cyboflow.events as unknown as StuckEventsClient` cast.
- **suggested_action:** Either (a) consolidate the two `StuckEventsClient` interface declarations into a single forward-looking shim module (e.g., `frontend/src/utils/stuckEventsShim.ts`) exporting a typed `getStuckEventsClient()` helper that both consumers call, so the TASK-254 cleanup is a single-file edit; or (b) defer the consolidation to the TASK-254 cleanup itself and document the constraint in FIND-SPRINT-013-2/12 so the eventual removal touches both files. (a) is lower-friction and reduces the cleanup tasks blast radius.
- **resolved_by:** 



This is the cross-task companion of FIND-SPRINT-013-2 and FIND-SPRINT-013-12 — each pre-existing finding only tracks the cast in its own file. The duplication itself is what makes them cross-task: when TASK-254 lands the typed subscription, two files need the same edit and any divergence (e.g., one file adds `runId` filter, the other doesnt) will silently desync the two consumers.

This is also a near-miss: the per-task code-reviewer sees only one file, so neither flagged the duplication.

Suspected tasks: TASK-502 (slice), TASK-503 (hook)

## FIND-SPRINT-013-25
- **source:** SPRINT-013 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** frontend/src/stores/mcpHealthStore.ts:43, frontend/src/hooks/useMcpHealth.ts:23, shared/types/mcpHealth.ts
- **description:** Inconsistent MCP status enum between the new mcpHealthStore (TASK-553) and the pre-existing Sidebar dot. Both surfaces show MCP health, but use different enums and different colour mapping:
- **suggested_action:** When consolidating per FIND-SPRINT-013-19, also pick a single canonical UI-side enum and put it in shared/types/mcpHealth.ts as `McpHealthUiStatus`. Either expand the existing wire enum to four UI states OR fold both surfaces onto the new three-value `McpHealthStatus`. Sidebar.tsx and McpHealthIndicator.tsx should then both read from the single store and use the single enum.
- **resolved_by:** 


- `useMcpHealth` hook (Sidebar): four-value `McpServerHealth.status` from shared/types/mcpHealth.ts — `running | starting | failed | stopped`. Sidebar.tsx:182-184 maps `running → success, starting → warning, anything else → error`.
- `useMcpHealthStore` (StatusBar/McpHealthIndicator): three-value `McpHealthStatus` — `healthy | starting | error`. Store does the four-to-three mapping internally (`running → healthy`, `failed|stopped → error`).

Different enums mean: (a) the two dots can drift if the shared type adds a fifth state; (b) `lastError`/`pid` fields are surfaced only by the new indicator, even though both can derive them from the same IPC payload; (c) a developer reading the codebase has to learn two vocabularies (`healthy` vs `running`).

Companion to FIND-SPRINT-013-19 (which tracks the dual-polling-loop problem). The polling is one symptom; the enum split is another from the same root cause — two parallel implementations of the same concept.

Suspected tasks: TASK-553 (introduced the second enum)

## FIND-SPRINT-013-26
- **source:** SPRINT-013 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/cancelAndRestartHandler.ts:122, main/src/orchestrator/approvalRouter.ts:328
- **description:** Forward-dependency note: `cancelAndRestartHandler` (TASK-502) documents AC5 — `Claude receives deny responses on the socket before the process is aborted` — as being satisfied by `approvalRouter.clearPendingForRun(runId)` at line 122. However, that method is a documented no-op until TASK-304 lands (see approvalRouter.ts:328-337 — `// Silent no-op until then`).

So the structurally-ordered side-effect chain is in place, but the actual deny-replies do not yet fire. Once cancel-and-restart is wired (per FIND-SPRINT-013-21) and TASK-304 lands, the AC will be satisfied; until then, calling cancel-and-restart leaves Claude waiting on the socket for a response that never arrives. The retry/timeout behaviour of the Claude SDK then determines whether the PTY actually exits cleanly.

Not a blocker for v1 because (a) the button isnt wired (FIND-21) and (b) the test suite uses a fake approvalRouter that records the call. Logging this so the dependency is tracked at sprint level rather than relying on the two per-task notes scattered across files.

Suspected tasks: TASK-502 (relies on it), TASK-304 (owner, out of sprint)
- **suggested_action:** Track as a blocker dependency on the FIND-SPRINT-013-21 cleanup task — until TASK-304 lands the real `clearPendingForRun` body, cancel-and-restart should be either gated off in the UI or documented as `kills Claude, deny-replies sent best-effort`. Add a one-line WARN log to cancelAndRestartHandler when the injected `approvalRouter.clearPendingForRun` is the stub (detect via a `_isStub` marker or just leave the noop comment more prominent).
- **resolved_by:** 
