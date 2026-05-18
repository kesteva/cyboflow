---
sprint: SPRINT-017
pending_count: 11
last_updated: "2026-05-18T22:03:07.628Z"
---
# Findings Queue

SPRINT-017 started with missing infra: docker; tests deferred.

## FIND-SPRINT-017-6
- **source:** TASK-616 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/trpc/routers/approvals.ts:4-8
- **description:** The file-header docstring listing the procedures exposed by `cyboflow.approvals` was updated in TASK-406 to include `approveRestOfRun` but was not updated in TASK-616 to include `rejectRestOfRun`. The new procedure is correctly defined and documented inline (lines 121-149), but the top-of-file procedure index is now stale — readers grepping the header to enumerate the surface will miss `rejectRestOfRun`. Pure docstring; no behavioral impact.
- **suggested_action:** Add `*   - rejectRestOfRun   : mutation → { decided: number } (TASK-616 — per-run batch reject)` line after the `approveRestOfRun` bullet at line 8.
- **resolved_by:** 

## FIND-SPRINT-017-5
- **source:** TASK-608 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/index.ts:673-684
- **description:** TASK-608 extracted `makeLoggerLike` into `main/src/orchestrator/loggerAdapter.ts` so it could be imported by both `index.ts` (AppServices assembly at line 550) and `cyboflow.ts`. The new helper is now used for `cyboflowLogger`, but the older tRPC-orchestrator block (lines 673-684) still defines its own inline `db: DatabaseLike` adapter AND a separate inline `loggerLike` adapter that wraps the same `logger` instance. Two divergences result: (a) the tRPC inline `loggerLike` discards `ctx` (no second-arg handling), while `makeLoggerLike` preserves it via JSON.stringify; (b) the inline `db` adapter at 673-676 has a body byte-identical to the new `cyboflowDb` adapter at 554-557. Both could now collapse into shared helpers (`makeLoggerLike(logger)` and a `makeDatabaseLike(databaseService)` factory).
- **suggested_action:** Replace lines 673-684 with `const db = makeDatabaseLike(databaseService); const loggerLike = makeLoggerLike(logger);` once a `makeDatabaseLike` helper is added next to `makeLoggerLike` in `main/src/orchestrator/loggerAdapter.ts` (or a sibling `dbAdapter.ts`). Eliminates one DRY violation and unifies context-forwarding semantics across all orchestrator-style adapters in `index.ts`.
- **resolved_by:** 

## FIND-SPRINT-017-4
- **source:** TASK-613 (verifier)
- **type:** claude-md
- **severity:** low
- **status:** open
- **location:** .soloflow/active/findings/SPRINT-010-findings.md (FIND-SPRINT-010-1)
- **description:** TASK-613 executor logged a scope_deviation finding to SPRINT-010-findings.md instead of the active sprint's SPRINT-017-findings.md. The executor also misclassified the edit as a scope deviation — all 11 frontend test files modified are explicitly listed in the plan's `files_owned` (lines 9-19 of TASK-613-plan.md). The plan's step 1 said "Expected: three matches" for the pre-flight grep, but that was a pre-flight expectation, not an authorization boundary. Two issues: (a) executor agent appears to use a stale `sprint.id` when writing findings (writing to a non-active sprint's file); (b) the agent classified an in-scope edit as a deviation because the implementation-step prose mentioned a smaller number than the frontmatter `files_owned` list.
- **suggested_action:** (a) Add an executor-side guard that re-reads `.soloflow/sprint.json` (or the orchestrator-injected sprint id) immediately before appending to a findings file, never derive it from cached context. (b) Tighten the executor scope-deviation prompt so a file is only flagged as a deviation when it is OUTSIDE `files_owned`, regardless of whether the implementation-step prose names every file individually. The current FIND-SPRINT-010-1 is already AC-prescribed and should be flipped to resolved by the verifier — see verification report.
- **resolved_by:** 

## FIND-SPRINT-017-1
- **source:** TASK-611 (executor)
- **type:** claude-md
- **severity:** low
- **status:** open
- **location:** frontend/src/components/ReviewQueueView.tsx:9
- **description:** Local interface IPCResponse<T> declared at line 9. CLAUDE.md forbids this — callers must import from frontend/src/utils/api.ts instead. The declaration pre-dates TASK-611 and was not introduced by it.
- **suggested_action:** Replace the local IPCResponse declaration with an import from frontend/src/utils/api.ts and add explicit type parameter to the invoke call.
- **resolved_by:** 

## FIND-SPRINT-017-2
- **source:** TASK-586 (code-reviewer)
- **type:** anti-pattern
- **severity:** medium
- **status:** open
- **location:** main/src/orchestrator/Orchestrator.ts:58
- **description:** `Orchestrator.start()` constructs `StuckDetector` with `emitter: new EventEmitter()` — a fresh, inline-constructed emitter that is never stored on `this`, never exposed via a getter, and never returned. Combined with `private detector?: StuckDetector` and `StuckDetector.emitter` being a `private readonly` field with no accessor, this means every `runs:stuck` event emitted by `StuckDetector.transitionRunsToStuck()` (stuckDetector.ts:282) is unreachable by any subscriber outside the test harness. This is functionally equivalent to a `void` sink — the per-component emitter pattern documented in ARCHITECTURE.md §Orchestrator says "callers subscribe directly", but no caller can subscribe to *this* emitter because it has no public reference. The decision to drop the shared `eventBus` was correct (path b in the TASK-586 plan); the implementation choice of an *inline-anonymous* emitter, however, recreates the same "did anyone wire this?" failure mode that motivated the drop — except now the symptom is invisible until a subscriber is added. The TASK-586 plan's "Hardest Decision" section anticipated this: "When the first real consumer needs cross-producer event aggregation, that consumer's plan will design the bus." That consumer's plan will need to add either (a) an `emitter` getter on `Orchestrator`, (b) an `emitter` getter on `StuckDetector` plus exposing `detector` on `Orchestrator`, or (c) accept `emitter` as an optional `OrchestratorDeps` field so the caller owns the lifecycle.
- **suggested_action:** When the first `runs:stuck` consumer task lands (likely in the stream-parser-to-main or admin-UI epic), add an `Orchestrator.onStuck(listener)` method (or expose `stuckEmitter: EventEmitter` as a read-only getter) so subscription paths are part of the public surface. Until then, leave the inline emitter — it correctly isolates the dead-event surface from the renderer and matches the "no speculative wiring" decision. This finding is a forward-looking reminder, not a blocker for TASK-586.
- **resolved_by:** 

## FIND-SPRINT-017-3
- **type:** scope_deviation
- **source:** TASK-600 (executor)
- **severity:** low
- **status:** resolved
- **location:** frontend/src/utils/cyboflowApi.ts
- **description:** required to meet AC: plan step 6 explicitly instructs updating the cyboflow comment in this file; it was listed as files_readonly but the plan implementation step targets it directly
- **resolved_by:** verifier — plan-prescribed: TASK-600 step 6 explicitly instructs rewriting the "When tRPC lands in epic 6, swap the internals" comment in frontend/src/utils/cyboflowApi.ts. The file also appears in files_owned (line 12) alongside files_readonly (line 20) — plan-frontmatter inconsistency, but files_owned authorizes the edit and step 6 prescribes it.

## FIND-SPRINT-017-7
- **source:** SPRINT-017 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/trpc/routers/approvals.ts:54-156
- **description:** approveRestOfRunHandler (lines 54-98) and rejectRestOfRunHandler (lines 112-156) are near-identical ~50-line clones — same withLock scope, same SELECT-pending SQL, same UPDATE pattern, same try/catch/console.error/continue loop, same return-{decided} shape. The only differences are the literal 'approved'/'rejected' in the UPDATE SET clause and the error-log prefix string. TASK-406 created approveRestOfRunHandler; TASK-616 cloned it for rejectRestOfRunHandler. The per-task reviewer for TASK-616 verified the symmetric behavior but did not see the duplication because TASK-406's code was already in tree.
- **suggested_action:** Collapse to a single decideRestOfRunHandler(db, runId, decision: 'approved' | 'rejected'): Promise<{decided:number}> that takes the target status as a parameter. The SQL becomes `UPDATE approvals SET status = ?, decided_at = ?, decided_by = 'user' WHERE id = ? AND status = 'pending'` and the log prefix becomes `[${decision === 'approved' ? 'approveRestOfRun' : 'rejectRestOfRun'}]`. Keep the two named wrappers as thin call-through aliases so the orchestrator trpc routers' TODO comments (lines 109-110 and 139-140 of main/src/orchestrator/trpc/routers/approvals.ts) still grep-replace cleanly when ctx.db is wired.
- **resolved_by:** 






Suspected tasks: TASK-406 (initial author), TASK-616 (cloner)

## FIND-SPRINT-017-8
- **source:** SPRINT-017 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** frontend/src/components/ReviewQueueView.tsx:56-82
- **description:** Two window-level keydown listeners are registered against the same review-queue UI surface — useReviewQueueKeyboard.ts (lines 70-130) and ReviewQueueView.tsx (lines 57-82, onboarding-dismiss). TASK-614 hardened the hook by adding a defensive `if (document.activeElement !== document.body && document.activeElement !== null) return;` focus guard (line 77 of the hook), preventing y/n from firing when any Radix focus-trap, modal, or focusable button holds focus. The sibling onboarding-dismiss listener in ReviewQueueView.tsx was NOT updated by TASK-614 — it still only guards against HTMLInputElement / HTMLTextAreaElement / isContentEditable. Result: opening any modal, focusing a button, or stealing keyboard focus while the onboarding card is visible can still dismiss it on a stray y/n keypress, even though the same condition is correctly suppressed by the hook for approve/reject.
- **suggested_action:** Either (a) extract the full guard ladder (modifier-key + activeElement + input-element) into `frontend/src/utils/keyboardGuards.ts::shouldIgnoreKeyboardEvent(event)` and call it from both listeners, OR (b) merge the onboarding-dismiss logic into useReviewQueueKeyboard itself — the hook already has all the right guards and could call `onAnyApproveOrReject?: () => void` once on first y/n. Option (a) is lower-risk and surfaces the pattern for future global keydown listeners in App.tsx, SessionView.tsx, LogsView.tsx, etc., which also lack the activeElement guard.
- **resolved_by:** 





Suspected tasks: TASK-611 (initial onboarding listener author), TASK-614 (hardened the hook but missed the sibling)

## FIND-SPRINT-017-9
- **source:** SPRINT-017 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** frontend/src/App.tsx:34, frontend/src/components/OnboardingCard.tsx:4, frontend/src/components/DiscordPopup.tsx:5, frontend/src/components/ReviewQueueView.tsx:9
- **description:** CLAUDE.md (project-root) explicitly forbids local `interface IPCResponse<T>` declarations in frontend code: "Never declare a local `interface IPCResponse<T>` or inline `{ success; data?; error? }` shape in frontend code — import from `frontend/src/utils/api.ts`." Yet four production frontend files still declare it locally:
- **suggested_action:** Run `grep -rn "interface IPCResponse" frontend/src/` (per the audit recipe in CLAUDE.md) and replace each local declaration with `import type { IPCResponse } from '../utils/api';` (path varies by file). Add explicit type parameters to every `electronInvoke(...)` cast so the wrapper's default `T = unknown` forces narrowing. Suggested touch list: App.tsx, OnboardingCard.tsx, DiscordPopup.tsx, ReviewQueueView.tsx. types/electron.d.ts's ambient global interface IPCResponse can stay — it is the legacy global declaration that the CLAUDE.md audit recipe explicitly exempts.
- **resolved_by:** 



  - frontend/src/App.tsx:34
  - frontend/src/components/OnboardingCard.tsx:4
  - frontend/src/components/DiscordPopup.tsx:5
  - frontend/src/components/ReviewQueueView.tsx:9  (filed as FIND-SPRINT-017-1)

The sprint-level view makes the aggregate pattern visible: per-task reviewers can only see the file in their own diff. FIND-SPRINT-017-1 covers ReviewQueueView.tsx; this finding is the umbrella covering the other 3 pre-existing offenders so the user can fix them in one sweep when triaging.

Suspected tasks: pre-existing for App.tsx/OnboardingCard.tsx/DiscordPopup.tsx; ReviewQueueView.tsx was visible to TASK-611 but the executor didn't replace it (already filed as FIND-SPRINT-017-1).

## FIND-SPRINT-017-10
- **source:** SPRINT-017 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** docs/ARCHITECTURE.md:106-109
- **description:** In the new `cyboflow.* transport status` section that TASK-600 added to docs/ARCHITECTURE.md (lines 79-110), the `tRPC stub (active caller throws)` bucket enumerates the procedures the renderer calls today via tRPC. The bullet at lines 106-109 lists `approvals.listPending, approvals.approve, approvals.reject, approvals.approveRestOfRun` but does NOT include `approvals.rejectRestOfRun`, which TASK-616 added in the same sprint to main/src/orchestrator/trpc/routers/approvals.ts (lines 133-149) and which is now actively called from PendingApprovalCard.tsx (line 126) and useReviewQueueKeyboard.ts (line 122). The doc is one bullet stale.
- **suggested_action:** Replace the `approvals.approveRestOfRun` token on line 108 of docs/ARCHITECTURE.md with `approvals.approveRestOfRun, approvals.rejectRestOfRun` so the bucket accurately enumerates every renderer-called stub. Same paragraph reads: `approvals.listPending, approvals.approve, approvals.reject, approvals.approveRestOfRun — called by PendingApprovalCard, useReviewQueueKeyboard, and reviewQueueStore.` — append `, approvals.rejectRestOfRun` to that list.
- **resolved_by:** 



Suspected tasks: TASK-600 (wrote the bucket bullets), TASK-616 (added rejectRestOfRun without updating the doc)

## FIND-SPRINT-017-11
- **source:** SPRINT-017 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/trpc/__tests__/approvals.test.ts:39-54
- **description:** main/src/orchestrator/__test_fixtures__/dbAdapter.ts provides a canonical `dbAdapter(db: Database.Database): DatabaseLike` helper, and its docstring explicitly states: "The compile-time `: DatabaseLike` return type ensures any future widening of DatabaseLike fails the build here, not in 4 silently-drifting test copies." TASK-616's new test file main/src/trpc/__tests__/approvals.test.ts declared its OWN local `dbAdapter` (lines 39-54) instead of importing the shared one. Worse, the new local copy has a strictly narrower shape (only `all` and `run`, no `transaction`) — so it cannot satisfy `DatabaseLike` and bypasses the type-safety the shared fixture is designed to enforce.
- **suggested_action:** Replace the local `dbAdapter` (lines 39-54) in main/src/trpc/__tests__/approvals.test.ts with `import { dbAdapter } from '../../orchestrator/__test_fixtures__/dbAdapter';`. If the import path is awkward, move dbAdapter to a higher-level fixture dir (e.g. main/src/__test_fixtures__/) so all 6 test files can import without `../../orchestrator/__test_fixtures__` traversal. Backlog: sweep the remaining 5 pre-existing local dbAdapter sites in a single dedupe pass.
- **resolved_by:** 


This is the very drift the shared fixture's docstring warned about: instead of the fixture's comment dropping from "4 silently-drifting test copies" to fewer, this sprint added a 7th drift site (per grep, the existing local copies are in cancelAndRestart.test.ts, inspectorQueries.test.ts, approvalRouter.test.ts, stuckDetector.test.ts, mcpServer/__tests__/mcpQueryHandler.test.ts plus this new one in trpc/__tests__/approvals.test.ts).

Suspected tasks: TASK-616 (new local copy); pre-existing for the other 5 sites

## FIND-SPRINT-017-12
- **source:** SPRINT-017 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/__tests__/workflowRegistry.test.ts:42-56, main/src/orchestrator/__tests__/runLauncher.test.ts:39-46, main/src/ipc/__tests__/cyboflow.test.ts:47-54, tests/helpers/cyboflowTestHarness.ts:32-37
- **description:** The orchestrator test suite has 5+ near-identical `makeLogger()`/`makeSilentLogger()`/`nullLogger` helpers, each returning a LoggerLike with `vi.fn()` spies (or no-op closures). TASK-607 added a 4th in main/src/ipc/__tests__/cyboflow.test.ts (`makeSilentLogger`). TASK-608 created the production-side `makeLoggerLike` helper in main/src/orchestrator/loggerAdapter.ts — but it's production code that wraps a real Logger instance, not a vi.fn-spying test fixture, so the test sites cannot reuse it. The result: every new orchestrator test file copies the same 5-7 lines of vi.fn boilerplate, and minor drift accumulates (e.g. workflowRegistry.test.ts adds `warnCalls`/`errorCalls` arrays for assertion, runLauncher.test.ts/cyboflow.test.ts return pure vi.fn spies, cyboflowTestHarness.ts uses no-op closures).

Suspected tasks: TASK-586 (Orchestrator.test.ts touched, stuckDetector.test.ts touched), TASK-607 (added makeSilentLogger), TASK-636 (workflowRegistry.test.ts touched). Pre-existing for stuckDetector.test.ts and mcpServerLifecycle.test.ts.
- **suggested_action:** Add `main/src/orchestrator/__test_fixtures__/loggerLikeSpy.ts` exporting `makeSpyLogger(): LoggerLike & { calls: Array<{level,message,ctx?}> }` so all test sites can `import { makeSpyLogger } from '../__test_fixtures__/loggerLikeSpy';` and replace their local copy. Match the union of features currently in use: vi.fn for spying + an optional `calls` array for ordered assertion (workflowRegistry.test.ts's style). Cleanup in a follow-up task; not a sprint blocker.
- **resolved_by:** 
