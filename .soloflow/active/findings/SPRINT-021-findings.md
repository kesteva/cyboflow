---
sprint: SPRINT-021
pending_count: 8
last_updated: "2026-05-19T21:20:11.371Z"
---
# Findings Queue

## FIND-SPRINT-021-1
- **source:** TASK-650 (verifier)
- **type:** improvement
- **severity:** low
- **status:** resolved
- **location:** main/src/orchestrator/runExecutor.ts:129-160
- **description:** Plan step 5 prescribes "terminal-phase fires from cancel() ('canceled') and execute()'s catch arm ('failed')." The implementation correctly fires 'canceled' from cancel() but uses `try/finally` (not `try/catch`) in execute() — `teardownRun` is called on both paths, but `onLifecycleTransition(runId, 'failed')` is NEVER fired when spawnCliProcess throws. AC5 only requires the union to widen (verified), so this is not a blocker. AC4 only requires dispose() on terminal phase via teardownRun (verified). However, downstream TASK-644 will need an explicit way to distinguish completed-vs-failed runs at the lifecycle hook layer — currently both paths look identical to the default no-op override. Either (a) wrap the try in try/catch + finally and fire 'failed'/'completed' explicitly before re-throw, or (b) document that TASK-644 must use a different signal (e.g. the spawnCliProcess return value or a thrown error caught in the integration override) to detect failure. The plan's step 5 wording implies (a) was intended.
- **suggested_action:** Address in TASK-644 or as a follow-up plan: change `try { ... } finally { teardownRun }` to `try { ... onLifecycleTransition(runId, 'completed') } catch (err) { await onLifecycleTransition(runId, 'failed'); throw err } finally { teardownRun }`. The current public-surface contract for ExecutionPhase suggests the executor itself is responsible for firing these phases.
- **resolved_by:** verifier — status-sync: TASK-662 implemented suggested_action option (a). runExecutor.ts:198-219 now wraps the spawner.spawnCliProcess await in try { ... onLifecycleTransition(runId, 'completed') } catch (err) { pendingFailedMessage.set(...); await onLifecycleTransition(runId, 'failed'); throw err } finally { teardownRun(runId) }. Verified by unit test "execute() fires failed phase with error message on spawner reject" at runExecutor.test.ts:662.

## FIND-SPRINT-021-2
- **source:** TASK-652 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/markdownFrontmatter.ts:6 and main/src/orchestrator/workflowRegistry.ts:10-12
- **description:** Two docstrings reference structures that no longer exist after the TASK-652 extraction. (a) `markdownFrontmatter.ts:6` says the helper is "Shared by workflowPromptReader.readWorkflowPrompt and WorkflowRegistry.parseFrontmatter" — but `parseFrontmatter` was deleted; the registry now consumes the helper from `extractPermissionMode`. (b) `workflowRegistry.ts:10-12` says "the inline parser intentionally avoids js-yaml" — the parser is no longer inline, it lives in `markdownFrontmatter.ts`. Both are cosmetic doc-drift introduced by the refactor; behavior and tests are correct.
- **suggested_action:** Update `markdownFrontmatter.ts` header to "Shared by workflowPromptReader.readWorkflowPrompt and WorkflowRegistry.extractPermissionMode" (or generic: "any markdown caller in main/src/orchestrator that needs flat key:value frontmatter"). Update `workflowRegistry.ts` header note to reference `markdownFrontmatter.ts` instead of describing the parser as inline.
- **resolved_by:** 

## FIND-SPRINT-021-3
- **source:** TASK-661 (verifier)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/runExecutor.ts:103
- **description:** TASK-661 plan AC2 prescribes a required constructor argument (`promptReader: WorkflowPromptReaderLike`) and Implementation Step 2 says "Update every test-file constructor call to pass a stub reader." Executor instead made the parameter optional (`promptReader?: WorkflowPromptReaderLike`) and left three pre-existing test sites calling the 3-arg form (`new RunExecutor(spawner, registry, logger)` at runExecutor.test.ts:166, 908; `new TestableRunExecutor(...)` is unaffected because TestableRunExecutor overrides `getPrompt`). The strict AC2 verification grep (`'private readonly promptReader: WorkflowPromptReaderLike'`) returns NO MATCH because of the `?`. Mitigations the executor added: a clear sentinel error ("RunExecutor.getPrompt: no WorkflowPromptReaderLike injected …") at runExecutor.ts:242, and a new test at runExecutor.test.ts:166 that pins the sentinel as a contract. Spirit of the AC (field stored, interface narrow, no concrete imports, integration site wires concrete adapter) is met; production call site at main/src/index.ts:610 passes the concrete reader. The deviation is a backward-compat hedge rather than a defect — but the AC verification grep is technically failing and a future contributor reading the AC literally will be surprised.
- **suggested_action:** Pick one: (a) Make `promptReader` required and update the 3-arg constructor calls in runExecutor.test.ts:166 and runExecutor.test.ts:908 to pass `makeStubReader({})` (the integration test at :908 deliberately exercises the failure path — switching it to a stub reader works because the test only checks logger.error was called with executor failure; the failure source changes from "getPrompt NOT_IMPLEMENTED" to "WorkflowPromptReadError" but the test assertion is broad). Or (b) update AC2 retroactively to reflect the optional design — but that's an after-the-fact rewrite. Recommend (a) so the plan's literal AC matches the code.
- **resolved_by:** 

## FIND-SPRINT-021-4
- **source:** SPRINT-021 (sprint-code-reviewer)
- **type:** bug
- **severity:** high
- **status:** open
- **location:** main/src/orchestrator/runExecutor.ts:181-194
- **description:** panelId/runId mismatch breaks ApprovalRouter routing and bridge event filtering — RunExecutor spawns with panelId=`run-${runId}` (line 181) but RunEventBridge filters by runId (runEventBridge.ts:153) and ClaudeCodeManager.makePreToolUseHook routes through ApprovalRouter using panelId (claudeCodeManager.ts:401-402, 506). Two consequences in production wiring: (1) the bridge listener never matches any output event because `p.panelId !== runId` is always true, so onFirstMessage never fires and runs are stuck in `starting` forever — they never transition to `running`. (2) Under permission_mode=default or acceptEdits, ApprovalRouter.requestApproval runs `UPDATE workflow_runs SET ... WHERE id = ?` with `run-${runId}` which matches zero rows, throws RunNotRunningError, and every tool call is denied with `Internal approval-router error`.
- **suggested_action:** Either (a) make RunExecutor pass runId as panelId directly (panelId === runId === sessionId) so ClaudeCodeManager.makePreToolUseHook(panelId) and bridge filter both align with workflow_runs.id, or (b) translate panelId↔runId at the boundary: pass runId to bridgeEvents AND to the spawner.options for the PreToolUse hook source-of-truth. Add an end-to-end integration test that spawns a real CCM with permission_mode=default, fires a tool call, and asserts the approval row lands in workflow_runs (currently no test exercises this path together).
- **resolved_by:** 






Suspected tasks: TASK-650 (introduced synthetic panelId), TASK-661 (wired ClaudeCodeManager as source EventEmitter), TASK-662 (wired onFirstMessage → running transition)

## FIND-SPRINT-021-5
- **source:** SPRINT-021 (sprint-code-reviewer)
- **type:** bug
- **severity:** high
- **status:** open
- **location:** main/src/orchestrator/runEventBridge.ts:111-232
- **description:** Latent double-INSERT of raw_events when bridge filter is corrected. RunEventBridge constructs its own EventRouter + RawEventsSink for each runId (lines 122-123, 132) and attaches them to the bridge listener. ClaudeCodeManager.runSdkQuery ALREADY constructs an EventRouter + RawEventsSink per panelId and INSERTs raw_events via that pipeline (claudeCodeManager.ts:247-255, 341). Once finding FIND-SPRINT-021-4 (panelId/runId mismatch) is fixed and the bridge starts processing events, every SDK event will land in raw_events TWICE — once via ClaudeCodeManager`s own router/sink pipeline and once via the bridge`s router/sink pipeline. RawEventsSink.insert is a plain `INSERT INTO raw_events` with no UNIQUE/PRIMARY KEY guard (rawEventsSink.ts:50), so duplicates persist.
- **suggested_action:** Decide which pipeline owns raw_events persistence and remove the other: either (a) remove the per-panel pipeline in ClaudeCodeManager.runSdkQuery (lines 247-255, 341-344, 366) since the bridge now owns it for workflow runs — but this regresses Cyboflow-legacy panel sessions that have no bridge; or (b) make the bridge skip its sink when source is ClaudeCodeManager (which already has one) and only set up router→sink when no upstream pipeline exists. Recommend (b): pass a `skipPersistence?: boolean` flag (or omit `db`) when wiring the bridge from RunExecutor against a CCM source.
- **resolved_by:** 





Suspected tasks: TASK-650 (introduced RunEventBridge), TASK-661 (wired CCM EventEmitter as bridge source), TASK-662 (kept the bridge active alongside CCM`s internal pipeline)

## FIND-SPRINT-021-6
- **source:** SPRINT-021 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/orchestrator/runExecutor.ts:243-255
- **description:** cancel() tears down per-run state BEFORE firing the canceled lifecycle transition, leaving the transition with no access to stashed metadata. The sequence is `await this.spawner.abort(panelId); this.teardownRun(runId); await this.onLifecycleTransition(runId, canceled)`. teardownRun() deletes pendingFailedMessage, pendingFailedFromStatus, pendingSystemPromptAppend — so any future enhancement that wants to record a cancel reason or include the failure context cannot reach it. Today the canceled phase only calls lifecycleTransitions.canceled(runId) which doesn`t use those maps, so it works by accident.
- **suggested_action:** Move teardownRun(runId) AFTER onLifecycleTransition(runId, canceled) in cancel(), matching the execute() pattern where teardown runs in the finally block AFTER all transitions have fired. This is symmetrical with how failed/completed phases consume pendingFailedMessage before teardown.
- **resolved_by:** 




Suspected tasks: TASK-650 (introduced cancel/teardownRun), TASK-662 (added pending* maps)

## FIND-SPRINT-021-7
- **source:** SPRINT-021 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/index.ts:610-613
- **description:** Unsafe double-cast on the ClaudeSpawnerLike adapter defeats TypeScript`s structural-type protection. The adapter wraps defaultCliManager via `(defaultCliManager as unknown as { spawnCliProcess(opts): Promise<void> }).spawnCliProcess(options)` and the same pattern for killProcess. This bypasses the public abstract contract on AbstractCliManager / ClaudeCodeManager. If ClaudeCodeManager.spawnCliProcess signature drifts (e.g. a new required field is added) TypeScript will not flag the call site — the adapter will silently pass an incomplete options object. The codebase has a global ban on `any` (CLAUDE.md) and these double-casts are the moral equivalent of `any` for these two methods.
- **suggested_action:** Replace the `unknown` double-cast with a direct method binding now that ClaudeCodeManager publicly extends AbstractCliManager which exposes spawnCliProcess and killProcess: `spawnCliProcess: defaultCliManager.spawnCliProcess.bind(defaultCliManager)`. If a structural mismatch surfaces, fix the ClaudeSpawnerLike interface to match the public ClaudeSpawnOptions superset rather than hiding the mismatch with `as unknown as`.
- **resolved_by:** 



Suspected tasks: TASK-661 (introduced ClaudeSpawnerLike adapter)

## FIND-SPRINT-021-8
- **source:** SPRINT-021 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/runLauncher.ts:55-65
- **description:** Stale doc comment on StreamEventPublisher. The JSDoc says "The concrete implementation lives in main/src/ipc/cyboflow.ts, which is the only place that calls win.webContents.send for cyboflow stream events." After SPRINT-021 it actually lives in main/src/index.ts:568-574 (the cyboflowPublisher inline in initializeServices). The comment in index.ts:566 also claims "This is the only place in the codebase that calls win.webContents.send for cyboflow stream events" — both statements agree directionally but the runLauncher reference is now wrong.
- **suggested_action:** Update runLauncher.ts:58-60 to read "The concrete implementation lives in main/src/index.ts (initializeServices), which is the only place...". Trivial.
- **resolved_by:** 


Suspected tasks: TASK-660 (moved RunLauncher construction to index.ts and made cyboflow.ts a thin getter)

## FIND-SPRINT-021-9
- **source:** SPRINT-021 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/runEventBridge.ts:5-10
- **description:** Stale integration contract in runEventBridge JSDoc. The header reads "After ClaudeCodeManager.spawnCliProcess(options) succeeds with options.panelId === runId, call bridgeEvents({...}) once." The sprint-021 wiring actually passes options.panelId = `run-${runId}` (runExecutor.ts:181), violating the documented contract — this is the surface manifestation of FIND-SPRINT-021-4. Whoever fixes the runId/panelId alignment should also update this comment so the next reader is not misled.

Suspected tasks: TASK-650 (authored bridge), TASK-661/662 (wired the production caller that breaks the contract)
- **suggested_action:** Once FIND-SPRINT-021-4 lands, refresh this docblock to reflect the chosen convention. If panelId === runId becomes the rule again, no comment change is needed; if a panelId↔runId boundary is documented elsewhere, point to it here.
- **resolved_by:** 
