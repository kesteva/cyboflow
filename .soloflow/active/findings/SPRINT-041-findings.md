---
sprint: SPRINT-041
pending_count: 9
last_updated: "2026-05-27T14:36:52.086Z"
---
# Findings Queue

- SPRINT-041 started with missing infra: docker; tests deferred.
- TASK-755 gated: failing blocking prereq (Sanity check that both fields are still dead before pruning).

## FIND-SPRINT-041-1
- **source:** TASK-754 (verifier)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/ipc/session.ts:312
- **description:** The `sessions:create-quick` JSDoc note (c) now reads "`db.createSession` omits `run_id` from its INSERT column list, so the row naturally gets `run_id = NULL` via TASK-743's migration default." TASK-754 added `run_id` to the INSERT column list (bound `data.run_id ?? null`); the row now gets `run_id = NULL` because the data object omits the field, not because the INSERT omits the column. Functionally still NULL — but the JSDoc rationale is stale and could mislead a future maintainer auditing the quick-session no-runId invariant. The file is in `files_readonly` for TASK-754, so the executor correctly did not touch it.
- **suggested_action:** Update note (c) to: "`SessionManager.createSessionWithId` intentionally omits `run_id` from its `sessionData` literal, so `db.createSession` binds `null` and the row gets `run_id = NULL`. See the comment above the `sessionData` literal in `sessionManager.ts:353-356`."
- **resolved_by:** 

## FIND-SPRINT-041-2
- **source:** TASK-754 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/services/__tests__/sessionManagerRunIdMapping.test.ts:159-163, 207-211
- **description:** The new "DB round-trip" describe block imports `better-sqlite3` via `require('better-sqlite3')` inside an IIFE, requiring two `eslint-disable @typescript-eslint/no-require-imports` comments. The plan said to "mirror the bootstrap pattern from `cyboflowSchema.test.ts:737-742`", and that file uses a top-of-file `import Database from 'better-sqlite3'` (line 24) — cleaner and matches the dominant pattern across migration007/010/011/rawEventsSink tests. Functionally identical, but the chosen path diverges from the file the plan referenced and adds two suppression comments to the test surface. Two near-identical IIFE blocks across Case A and Case B also duplicate the same 4-line raw-DB seeding sequence; a tiny `seedProject(dbPath)` helper local to the file would remove the duplication and the eslint suppressions in one move.
- **suggested_action:** Replace the two `require('better-sqlite3')` IIFEs with a top-of-file `import Database from 'better-sqlite3'`, and extract the 4-line "open raw DB → INSERT projects row → close" sequence into a small local helper. The two `eslint-disable` comments can then be dropped.
- **resolved_by:** 

## FIND-SPRINT-041-3
- **source:** TASK-776 (verifier)
- **type:** claude-md
- **severity:** low
- **status:** open
- **location:** docs/VISUAL-VERIFICATION-SETUP.md
- **description:** Peekaboo MCP reports Accessibility NOT granted for MCP host process binary while Screen Recording IS granted — recurring TCC.db host-process gap documented across SPRINT-031..SPRINT-039 and now SPRINT-041. CLAUDE.md already references docs/VISUAL-VERIFICATION-SETUP.md TCC diagnostic. Recurring across many sprints suggests the doc-fix that resolves once-for-all has not landed; compounder should propose elevating the TCC fix from doc-noted to a tracked setup task (or an automated tcc-check script).
- **suggested_action:** Compounder: open a tracked task to either (a) script the TCC.db host-process check + remediation, OR (b) promote the existing doc walk-through into the project bootstrap / onboarding flow so it stops being a per-sprint resolution-loop.
- **resolved_by:** 

## FIND-SPRINT-041-4
- **type:** scope_deviation
- **source:** TASK-777 (executor)
- **severity:** low
- **status:** resolved
- **location:** tests/helpers/cyboflowTestHarness.ts:83-91
- **description:** required to meet AC: typecheck gate failed because tests/helpers/cyboflowTestHarness.ts uses both `new ApprovalRouter(db, factory)` direct construction and `ApprovalRouter.initialize(db, factory)` — both must be narrowed to 1-arg to satisfy TypeScript after removing the dead parameter from the constructor signature.
- **resolved_by:** verifier — AC-prescribed: AC7/AC8 require `pnpm typecheck` to exit 0; the harness's direct `new ApprovalRouter(dbLike, factory)` + `ApprovalRouter.initialize(dbLike, factory)` calls would have failed typecheck once the dead parameter was removed from the constructor and initialize signatures.

## FIND-SPRINT-041-5
- **source:** TASK-777 (code-reviewer)
- **type:** cleanup
- **severity:** medium
- **status:** resolved
- **location:** main/src/orchestrator/__tests__/approvalRouter.test.ts:38-51, 70/116/177/231/285/344/395/429/464/529/546-547/605/752/830/880
- **description:** Asymmetric cleanup vs sibling questionRouter.test.ts. The 65af958 chore commit dropped `makeQueueFactory` from questionRouter.test.ts and rewrote all its `await qf.getOrCreate(runId).onIdle()` barriers to `await router['getQuestionQueue'](runId).onIdle()` (which observes the router's REAL internal queue). The same chore left approvalRouter.test.ts with 14 standalone `await qf.getOrCreate(runId).onIdle()` calls + 2 inside `await Promise.all([qf.getOrCreate(A).onIdle(), qf.getOrCreate(B).onIdle()])` (line 545-548) plus the unused `makeQueueFactory` helper at line 38-51. Since `qf` is no longer passed to `ApprovalRouter.initialize`, these queues have zero tasks enqueued and `onIdle()` resolves immediately — the comment at line 128 ("Wait for the queue to be idle so the transaction has committed") is now actively misleading. Tests still pass only because better-sqlite3 transactions are synchronous, so DB state is committed before the next microtask; the synchronization machinery is dead weight that survives only by accident.
- **suggested_action:** Mirror the questionRouter.test.ts fix: replace every `qf.getOrCreate(runId).onIdle()` with `router['getApprovalQueue'](runId).onIdle()` (private-field bracket access), then delete the now-unused `makeQueueFactory` helper + `import PQueue from 'p-queue'`. Verify with `grep -n 'makeQueueFactory\|qf\.' main/src/orchestrator/__tests__/approvalRouter.test.ts` returning 0 matches.
- **resolved_by:** TASK-777

## FIND-SPRINT-041-6
- **source:** TASK-781 (verifier)
- **type:** claude-md
- **severity:** low
- **status:** open
- **location:** docs/VISUAL-VERIFICATION-SETUP.md
- **description:** Visual verification for TASK-781 (WorkflowProgressTimeline retrofit) could not run on either configured platform. visual_web=true but Cyboflow CLAUDE.md documents that Vite renderer at http://localhost:4521 cannot bootstrap without Electron preload-injected electronTRPC — Playwright MCP path is non-functional. visual_macos=true but Peekaboo MCP reports Accessibility NOT granted for the host binary (recurring TCC.db host-process gap, duplicate of FIND-SPRINT-041-3 and the same pattern across SPRINT-031..SPRINT-040). Net result: visual verification has been silently skipped for many sprints. Compounder should either (a) ship a Playwright config that uses _electron.launch() so visual_web becomes functional, or (b) automate the Peekaboo TCC.db host-process fix so visual_macos no longer requires per-sprint manual remediation. Without one of these, the visual-verify checkbox is decorative on this project.
- **suggested_action:** Compounder: open a tracked task to make visual verification actually runnable here — either Playwright over _electron.launch() (preferred per VISUAL-VERIFICATION-SETUP.md) or a scripted Peekaboo TCC remediation step in project bootstrap.
- **resolved_by:** 

## FIND-SPRINT-041-7
- **source:** SPRINT-041 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** frontend/src/components/cyboflow/CyboflowRoot.tsx:37, frontend/src/components/cyboflow/WorkflowProgressTimeline.tsx:176
- **description:** Duplicate useWorkflowPhaseState subscription created across tasks — TASK-780 wired useWorkflowPhaseState(activeRunId) in CyboflowRoot, TASK-781 separately wired useWorkflowPhaseState(runId) inside WorkflowProgressTimeline. When the right-rail Workflow Progress tab is active (the default), both calls fire with the same runId, opening 2 concurrent trpc.cyboflow.runs.onStepTransition.subscribe({ runId }) subscriptions, 2 concurrent getPhaseState.query({ runId }) calls, and 2 independent React state snapshots that can disagree if transition events interleave non-deterministically. The hook (useWorkflowPhaseState.ts:115) has no module-level cache or shared subscription — every consumer pays full cost. Per-task review could not see this since each task touches only one component.
- **suggested_action:** Lift the phase state into a Zustand selector (or pass phaseState as a prop from CyboflowRoot to WorkflowProgressTimeline so the timeline reads from parent state). Alternatively, wrap useWorkflowPhaseState in a per-runId shared subscription store so N component subscribers share one tRPC stream. The simplest fix: change WorkflowProgressTimeline to accept phaseState as a prop and have CyboflowRoot/RunRightRail pass it down — turning the hook back into a single-subscriber primitive.
- **resolved_by:** 





Suspected tasks: TASK-780, TASK-781

## FIND-SPRINT-041-8
- **source:** SPRINT-041 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/orchestrator/approvalRouter.ts:1-460, main/src/orchestrator/questionRouter.ts:1-426
- **description:** ApprovalRouter and QuestionRouter are now near-identical twin classes. Both files implement the same shape: (a) singleton with static initialize/getInstance/_resetForTesting, (b) per-run PQueue map keyed by runId with getApprovalQueue/getQuestionQueue helpers, (c) pending Map<id, PendingEntry> with same PendingEntry shape (request + socketReply + resolve + reject), (d) request* method that runs a guarded txn UPDATE workflow_runs + INSERT into a sibling table, then resolves an awaiter Promise, (e) respond() with fast-path peek + queue-serialized re-fetch + delete + UPDATE pattern, (f) clearPendingForRun(runId) with identical iterate-then-delete loop, guarded UPDATE WHERE status=pending, swallow-DB-errors, resolve-with-fallback semantics, (g) recoverStaleAwaiting* boot-recovery txn that mirrors each other. ~70% of each file is structural duplication. The cross-cutting design invariants in the docblock (queues separate from RunQueueRegistry, write-then-emit, no auto-expire) are repeated verbatim. Per-task code-reviewers see only one file at a time so this pattern is invisible to them. TASK-774 and TASK-777 both touched these twins, exposing the shape but did not consolidate.
- **suggested_action:** Extract a generic GateRouter<TRequest, TResponse> base or a free-function builder factory in a new file (e.g. main/src/orchestrator/gateRouter.ts). Parameters: table name, status columns (awaiting_review vs awaiting_input), response shape, fallback response builder. Each concrete router becomes a thin wrapper that supplies the per-type identifiers. Cuts ~400 lines of structural duplication and ensures invariant changes (e.g. a future timeout policy) land in one place. Worth doing now before a third gate type is added.
- **resolved_by:** 




Suspected tasks: TASK-774, TASK-777

## FIND-SPRINT-041-9
- **source:** SPRINT-041 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** frontend/src/stores/reviewQueueStore.ts:1-307, frontend/src/stores/questionStore.ts:1-294
- **description:** reviewQueueStore and questionStore are near-identical twin Zustand slices. Both implement: (a) ConnectionStatus union, (b) queue + connectionStatus state, (c) addX/removeX/replaceAll/setConnectionStatus reducers with idempotent semantics, (d) closure-private initialized + cachedUnsubscribe in the create() factory, (e) init() with the same shape: setConnectionStatus connecting → listPending query → replaceAll → subscribe-Created + subscribe-Decided/Answered → mirrored onError teardown (the very block TASK-775 just added), (f) `pureAddX` / `pureRemoveX` / `pureReplaceAll` exports for tests. ~80% structural duplication. TASK-775 had to write the second-subscription onError fix into BOTH stores to keep them in lockstep — exactly the kind of forced parallel edit that argues for consolidation. The only meaningful difference is the syncBadge call in reviewQueueStore.
- **suggested_action:** Extract a `createSubscriptionQueueStore<T>(config)` factory in a new file (e.g. frontend/src/stores/createSubscriptionQueueStore.ts) that takes: { listPendingProc, onCreatedSub, onSettledSub, deltaIdField, settledIdField, onMutate?: (queue) => void }. Both stores then become 20-line wrappers that plug in their tRPC procedures + the badge hook (only for reviewQueue). Eliminates the mirrored-edit hazard (the next event-type variant will not need to remember to touch two files).
- **resolved_by:** 



Suspected tasks: TASK-773, TASK-775

## FIND-SPRINT-041-10
- **source:** SPRINT-041 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx:23-34, frontend/src/components/cyboflow/__tests__/RunRightRail.test.tsx:17-28, frontend/src/components/cyboflow/__tests__/WorkflowCanvas.test.tsx:16-27
- **description:** ResizeObserver shim block duplicated across 3 test files added/touched by TASK-780. Each file has the identical 12-line `beforeAll(() => { if (typeof global.ResizeObserver === undefined) { global.ResizeObserver = vi.fn().mockImplementation(() => ({ observe, unobserve, disconnect: vi.fn() })) } })` block. The TASK-780-done.md archive explicitly flagged this as triplication that the per-task code-reviewer chose not to file as a finding. cyboflow already has a centralized frontend test setup at frontend/src/test/setup.ts (configured via vitest.config.ts setupFiles) that hosts the global tRPC stub and afterEach cleanup — the natural home for jsdom polyfills.
- **suggested_action:** Move the ResizeObserver shim into frontend/src/test/setup.ts as a top-level mount (not inside beforeAll — setup.ts runs once per worker). Delete the three local copies. Audit: `grep -rn "global.ResizeObserver = vi.fn" frontend/src` should return 0 hits outside setup.ts.
- **resolved_by:** 


Suspected tasks: TASK-780

## FIND-SPRINT-041-11
- **source:** SPRINT-041 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** .soloflow/archive/done/approval-router-and-permission-fix/TASK-778-done.md
- **description:** TASK-778 was a documented no-op: all 4 ACs were already satisfied by TASK-773 (mock factory exposure of onApprovalDecided.subscribe) + TASK-775 (decided-subscription onError regression test) earlier in the same sprint. The TASK-778-done.md notes the compounder that proposed TASK-778 from SPRINT-040 bucket B1 was not aware that TASK-773 was already queued. Cross-task observation: this is the second compounder-scheduling-blindspot finding in recent sprints — proposals are reviewed individually against the current sprint but not against other proposed tasks. Worth surfacing for the SoloFlow plugin / compounder, not for the cyboflow codebase.

Suspected tasks: TASK-778
- **suggested_action:** Compounder feedback: when proposing a new task that depends on a prior FIND-* or sprint state, the compounder should grep the active sprint plan files for tasks that already touch the same locations/ACs, and skip the proposal (or downgrade to a duplicate-of-X note). Not a cyboflow code task — surface to SoloFlow plugin tester-mode feedback during the next compound run.
- **resolved_by:** 
