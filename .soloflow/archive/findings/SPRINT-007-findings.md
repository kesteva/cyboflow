---
sprint: SPRINT-007
pending_count: 12
last_updated: "2026-05-14T19:19:36.629Z"
---
# Findings Queue

## Step 2.8 prereq override

TASK-575 had failing blocking prereq (grep of legacy parseClaudeStreamEvent — passes only after TASK-572 lands). User opted to keep TASK-575 in scope; the dep scheduler sequences it after TASK-572 completes naturally. No gate applied.

## FIND-SPRINT-007-2
- **source:** TASK-574 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/services/streamParser/jsonParser.ts:14-15, main/src/services/streamParser/__tests__/jsonParser.test.ts:11,17,28,98
- **description:** TASK-574 introduced `export type IWarnLogger = Pick<ILogger, 'warn'>` in `jsonParser.ts` with a `@deprecated` JSDoc tag as a bridge alias, because `jsonParser.test.ts` (in TASK-574's `files_readonly` set) imports `IWarnLogger` and uses it as a type annotation in four places. The alias is otherwise dead code in the production surface — no production file references it. A trivial follow-up can update the test to `import type { ILogger } from '../types'` and replace the three `IWarnLogger & {...}` annotations with `Pick<ILogger, 'warn'> & {...}` (or drop the explicit type and rely on the inline-object structural type), then delete the alias and the `@deprecated` line. The test's existing mock objects already structurally satisfy `Pick<ILogger, 'warn'>` — no runtime changes needed.
- **suggested_action:** In a follow-up task, edit `jsonParser.test.ts` to import `ILogger` from `../types` instead of `IWarnLogger` from `../jsonParser`, then remove the `@deprecated` alias block (lines 14-15) from `jsonParser.ts`. Single small commit.
- **resolved_by:** 

## FIND-SPRINT-007-1
- **source:** TASK-573 (verifier)
- **type:** bug
- **severity:** medium
- **status:** open
- **location:** main/src/orchestrator/trpc/__tests__/router.test.ts
- **description:** Ten tests in `main/src/orchestrator/trpc/__tests__/router.test.ts` fail because the suite predicate `isNotImplemented` (and a literal `expect(...).toBe('NOT_IMPLEMENTED')` at line 124) still assert the legacy tRPC error code `NOT_IMPLEMENTED`, but the implementation migrated to `METHOD_NOT_SUPPORTED` via the `throwNotImplemented` helper (`main/src/orchestrator/trpc/trpc.ts:43`) in commit e671517 (`chore(SPRINT-006): use METHOD_NOT_SUPPORTED + throwNotImplemented helper`). The test file was not updated alongside the helper. Pre-existing on `main` at commit b257f7a (SPRINT-007 start) — TASK-573 does not touch the `trpc/` directory; the failing tests are unrelated to the transitions.ts change. Confirmed via `git diff HEAD~1 HEAD -- main/src/orchestrator/trpc` returning empty.
- **suggested_action:** Update `__tests__/router.test.ts` so `isNotImplemented` returns true for `code === 'METHOD_NOT_SUPPORTED'` and change the literal at line 124 to `'METHOD_NOT_SUPPORTED'`. Likely a one-line + one-line fix.
- **resolved_by:** 

## FIND-SPRINT-007-3
- **source:** TASK-568 (code-reviewer)
- **type:** anti-pattern
- **severity:** low
- **status:** open
- **location:** main/src/ipc/session.ts:929
- **description:** The `panels:get-json-messages` IPC handler does not call `validatePanelExists(panelId)` before invoking `sessionManager.getPanelOutputs(panelId)`. Nearby panel-scoped handlers (`panels:stop-claude` at ~line 884, `panels:get-prompts` at ~994, etc.) all use `validatePanelExists` as a guard. The inconsistency is pre-existing (predates TASK-568) — the prior implementation also skipped validation — but this is the only panelId-keyed IPC in `session.ts` without ownership validation. Out-of-diff for TASK-568.
- **suggested_action:** Add `const panelValidation = validatePanelExists(panelId); if (!panelValidation.isValid) return createValidationError(panelValidation);` at the top of the try block, mirroring the pattern at line 884.
- **resolved_by:** 

## FIND-SPRINT-007-4
- **type:** scope_deviation
- **source:** TASK-572 (executor)
- **severity:** low
- **status:** resolved
- **location:** main/src/ipc/claudePanel.ts
- **description:** Required to meet AC#6 (pnpm typecheck + vitest pass): ClaudeCodeManager.setSharedDb() must be called after DatabaseService is ready. claudePanel.ts is the earliest IPC handler that has both claudeCodeManager and databaseService in scope (via AppServices). File claimed and used to wire the static DB holder.
- **resolved_by:** verifier — plan-prescribed: main/src/ipc/claudePanel.ts is listed in TASK-572-plan.md `files_owned` (line 15); not a deviation

## FIND-SPRINT-007-5
- **type:** scope_deviation
- **source:** TASK-572 (executor)
- **severity:** low
- **status:** resolved
- **location:** main/src/services/panels/claude/claudePanelManager.ts
- **description:** Claimed but not ultimately modified — claudePanel.ts (also claimed) was sufficient to wire setSharedDb. claudePanelManager.ts was claimed as a fallback option in case the IPC handler path was blocked.
- **resolved_by:** verifier — plan-prescribed: main/src/services/panels/claude/claudePanelManager.ts is listed in TASK-572-plan.md `files_owned` (line 14); not a deviation, and ultimately untouched

## FIND-SPRINT-007-6
- **type:** scope_deviation
- **source:** TASK-572 (executor)
- **severity:** low
- **status:** resolved
- **location:** main/src/events.ts
- **description:** Claimed but not ultimately modified — pipeline cleanup and state-machine guard calls were wired entirely within claudeCodeManager.ts. events.ts was claimed as a potential fallback for transitionToAwaitingReview production callsite.
- **resolved_by:** verifier — plan-prescribed: main/src/events.ts is listed in TASK-572-plan.md `files_owned` (line 16); not a deviation, and ultimately untouched

## FIND-SPRINT-007-7
- **source:** TASK-572 (verifier)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/services/panels/claude/claudeCodeManager.ts:68-76, 309, 380
- **description:** ClaudeCodeManager uses a `static sharedDb: Database.Database | null` injector with a `setSharedDb()` static method wired from claudePanel.ts. The plan's recommended approach was constructor injection (a `db` parameter threaded through the single caller in claudePanelManager.ts), with the singleton/static pattern listed as a fallback in the "Lowest Confidence Area" section. The executor chose the fallback to avoid surface-area churn and preserve the existing constructor contract (the permissions test depends on the current shape, see test_strategy.targets[1]). The static pattern works but has known downsides: (a) cross-instance state leak in tests requires explicit reset in `afterEach` (already done correctly here), (b) the `null` branch silently degrades RawEventsSink to a no-op, which could hide a wiring regression in production where setSharedDb is forgotten on a new entry-point path, (c) it diverges from the constructor-DI pattern used elsewhere in the codebase. A future hardening pass could plumb `db` through the constructor once the AbstractAIPanelManager/BaseAIPanelHandler scaffolding is consolidated (cleanup candidate per CLAUDE.md). Not blocking — the static injector is documented in code and was explicitly authorized by the plan.
- **suggested_action:** When the AbstractAIPanelManager scaffolding is collapsed (already on the deferred cleanup list), replace the static sharedDb with a constructor `db` parameter wired through claudePanelManager.ts:39. Add an integration test that exercises the constructor path so the no-DB degraded mode becomes the explicit error path, not the silent default.
- **resolved_by:** 

## FIND-SPRINT-007-8
- **source:** TASK-572 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/services/panels/claude/claudeCodeManager.ts:74, main/src/services/__tests__/claudeCodeManagerWiring.test.ts:184
- **description:** `ClaudeCodeManager.setSharedDb(db: Database.Database)` accepts only a non-null handle, but the underlying static field is typed `Database.Database | null` (line 68). The test `afterEach` at line 184 needs to reset state and does so via `ClaudeCodeManager.setSharedDb(null as unknown as Database.Database)` — a cast that papers over the setter/field signature mismatch and weakens type safety. Either widen the setter to `db: Database.Database | null` (so passing `null` is honest) or add a dedicated `clearSharedDb(): void` reset helper used by tests. Trivial fix; surfaces because the test had to lie to TypeScript to compile.
- **suggested_action:** Pick one of: (a) change line 74 to `static setSharedDb(db: Database.Database | null): void` and drop the cast in the test, or (b) add `static clearSharedDb(): void { ClaudeCodeManager.sharedDb = null; }` and replace the test's cast call with the clear method. Single small commit, no behavior change.
- **resolved_by:** 

## FIND-SPRINT-007-10
- **source:** TASK-575 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/services/streamParser/schemas.ts:6-10
- **description:** The rewritten top-of-module JSDoc says "This module exports: `claudeStreamEventSchema` … `_typeCheck` — compile-time TS↔Zod drift bridge". Only `claudeStreamEventSchema` is actually `export`ed; `_typeCheck` is a module-local `const` used purely for its compile-time assignability check (see line 263, declared with `const` not `export const`). The prose technically misleads a reader skimming the header into thinking `_typeCheck` is part of the public surface. Functionally harmless — no caller would resolve a non-existent import — but the wording could read "This module declares" or split into "Exports:" and "Compile-time checks:" subsections.
- **suggested_action:** Change line 6 from "This module exports:" to "This module declares:", or split into two bullets — "Exports: `claudeStreamEventSchema`" and "Compile-time check: `_typeCheck` — TS↔Zod drift bridge". Single-line documentation edit.
- **resolved_by:** 

## FIND-SPRINT-007-9
- **source:** TASK-572 (code-reviewer)
- **type:** claude-md
- **severity:** low
- **status:** open
- **location:** main/src/services/panels/claude/claudeCodeManager.ts:367-389
- **description:** `tryTransitionToAwaitingReview` is a private method with zero in-class callers — by design, per the JSDoc which marks it as a Day-3 integration point that satisfies AC#4's grep gate. The cyboflow CLAUDE.md prescribes the `@cyboflow-hidden` annotation for "Code that is intentionally unreachable in cyboflow v1 (but preserved from the Crystal baseline for future re-enablement)" with an audit tool `grep -rn '@cyboflow-hidden' main/src frontend/src`. This method is intentionally unreachable in v1 and forward-looking rather than Crystal-preserved, but the same audit/prune tooling that scans for `@cyboflow-hidden` will not find this method, and a future cleanup pass (e.g., `soloflow-dev:prune` or `simplify`) could mark it as dead code and remove it. Either extend the convention to also cover forward-looking placeholders, or add the `@cyboflow-hidden` marker above the method with a re-enable pointer (e.g., "Re-enable by wiring from ApprovalRouter once workflow_runs rows are auto-created on Claude spawn — TASK-302"). The verifier already accepted this method for AC#4's grep gate; the open question is purely the annotation discipline.
- **suggested_action:** Either (a) add `// @cyboflow-hidden: Day-3 placeholder; called only after workflow_runs auto-creation lands. Re-enable by routing through ApprovalRouter.recordToolRequest() → tryTransitionToAwaitingReview().` immediately above the method, or (b) update docs/CODE-PATTERNS.md `@cyboflow-hidden` section to explicitly cover forward-looking placeholders alongside Crystal-preserved code. Option (a) is the smaller change.
- **resolved_by:** 

## FIND-SPRINT-007-11
- **source:** SPRINT-007 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/ipc/session.ts:1236-1310
- **description:** Cross-task gap — legacy sessions:get-json-messages handler not migrated to projectStoredOutputs. TASK-568 wired panels:get-json-messages (preload at main/src/preload.ts:562, panel-keyed entry-point used by RichOutputView/MessagesView) through the new projectStoredOutputs() helper, returning UnifiedMessage[] with .segments. The parallel sessions:get-json-messages handler (main/src/preload.ts:209, session-keyed) still does the legacy raw stream-json spread (line 1300-1305: `{...jsonData, timestamp}`). It is exposed on window.electronAPI.sessions.getJsonMessages and reachable via frontend/src/utils/api.ts:89 — currently dead (no UI caller), but if any caller is added later the FIND-SPRINT-005-9 .some-of-undefined regression returns. Two preload-exposed getJsonMessages handlers now emit different payload shapes; only one task knew both existed.
- **suggested_action:** Either: (a) migrate sessions:get-json-messages to call projectStoredOutputs() on the panel-output branch (lines 1245-1248) before the legacy formatting fork, mirroring the panels: handler, OR (b) delete the session-keyed handler + preload + frontend api binding since no renderer consumer exists. Option (b) is cleaner — removes a footgun. Either path is a single small commit.
- **resolved_by:** 





Suspected tasks: TASK-568

## FIND-SPRINT-007-12
- **source:** SPRINT-007 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/services/panels/claude/claudeCodeManager.ts:333-345, main/src/services/cyboflow/transitions.ts:60,114
- **description:** Cross-task pattern drift — misleading try/catch around assertTransitionAllowed. assertTransitionAllowed(from, to, runId) is a pure literal-table lookup: it throws IllegalTransitionError iff the (from,to) pair is not in ALLOWED_TRANSITIONS. It does NOT touch the DB or check the actual row state. TASK-572 wraps assertTransitionAllowed(running, completed, payload.runId) in try/catch with the comment Fail-soft: no workflow_runs row exists yet (panelId placeholder), so we catch any error. — but row not present is not a failure mode of this function. With both args hardcoded literals known to be in the table (running→completed is allowed), the call is unreachable-failure in production; the catch block is dead code. TASK-573 uses the same call inside transitions.ts:60/114 (also hardcoded literals) and (g)/(h) tests force it to throw only via vi.spyOn — i.e. real production paths never throw. The guard is effectively a compile-time symbol-reference smoke test, not a runtime check. Two tasks landed the same misuse from opposite angles, neither per-task reviewer saw the pattern as a whole.
- **suggested_action:** Pick one: (a) Rewrite the comment in claudeCodeManager.ts:336 to accurately describe what assertTransitionAllowed checks (compile-time legality of from→to literals) and remove the misleading no workflow_runs row exists yet framing — the SQL UPDATEs WHERE status = running is the real row-state guard, not assertTransitionAllowed. (b) Replace the literal-pair call sites with a row-state-aware guard — e.g. a SELECT status FROM workflow_runs WHERE id = ? inside the transaction, then call assertTransitionAllowed(actualStatus, awaiting_review, runId). That would make the guard meaningful at runtime. Option (a) is safer (no behavior change); option (b) is the right fix if the team wants the guard to actually catch concurrent state divergence beyond what the SQL UPDATE WHERE clause already catches.
- **resolved_by:** 




Suspected tasks: TASK-572, TASK-573

## FIND-SPRINT-007-13
- **source:** SPRINT-007 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/services/panels/claude/claudeCodeManager.ts:206-212, main/src/services/streamParser/streamParser.ts:47-50
- **description:** Cross-task efficiency — double line-buffering. AbstractCliManager.setupProcessHandlers (main/src/services/panels/cli/AbstractCliManager.ts:658-672) already splits PTY data on newlines and calls parseCliOutput(line + \n, panelId, sessionId) once per complete line. TASK-572 then calls pipeline.parser.feed(data) inside parseCliOutput (claudeCodeManager.ts:211), and ClaudeStreamParser.feed() runs the chunk through its OWN LineBufferer (streamParser.ts:48-49). So every Claude SDK line traverses two LineBufferer instances. Functionally correct (the inner LineBufferer sees one whole line + an empty trailing segment, processes the line, retains nothing) but redundant — costs one buffer allocation + one split per event. ClaudeStreamParser was designed to consume raw PTY chunks, but in this wiring it consumes pre-line-split data.
- **suggested_action:** Add a processLine(line: string): void method to ClaudeStreamParser that skips LineBufferer entirely (calls processLines([line]) directly), and use it from claudeCodeManager.ts:211 instead of feed(). Keep feed() as the alternative entry-point for callers that have raw chunks (e.g. future direct stream wiring). Single small commit, no behavior change.
- **resolved_by:** 



Suspected tasks: TASK-572

## FIND-SPRINT-007-14
- **source:** SPRINT-007 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/services/panels/claude/claudeCodeManager.ts:204-282, main/src/ipc/session.ts:32-79
- **description:** Cross-task duplicated work — write-side pipeline narrows events, read-side re-narrows the same events from session_outputs. TASK-572 wires ClaudeStreamParser → TypedEventNarrowing → EventRouter → RawEventsSink, persisting raw events into the raw_events table. TASK-568 reads session_outputs in projectStoredOutputs() and runs TypedEventNarrowing.narrow() + MessageProjection.project() at IPC-call time on every refresh. The pipelines narrowing work at write-time is completely discarded for the read path because (a) session_outputs is written by the inline JSON.parse branch at parseCliOutput:215-259 in parallel to the pipeline, (b) the renderer reads session_outputs via panels:get-json-messages, and (c) no consumer reads from EventRouter or raw_events yet. Per the inline comment at claudeCodeManager.ts:206-208 (preserved in parallel until Day-3 migrates the renderer to consume from EventRouter via tRPC), this is intentional. But the parallel-paths intent isnt documented in either MessageProjection or projectStoredOutputs, so a future contributor could merge the paths incorrectly. Every IPC call instantiates a fresh MessageProjection (session.ts:37) and re-narrows the entire history.
- **suggested_action:** Two-part: (a) Add a JSDoc note to projectStoredOutputs (session.ts:24-30) noting that this is the legacy read path and the parallel pipeline in claudeCodeManager intends to take over via EventRouter+raw_events once the renderer migrates. (b) Add a matching note to claudeCodeManager.ts:206-212 referencing projectStoredOutputs as the consumer of the inline-emit-as-json fallback. Both notes should reference the Day-3 cutover task (TBD ID). This converts the cross-task seam from implicit to explicit.
- **resolved_by:** 


Suspected tasks: TASK-568, TASK-572

## FIND-SPRINT-007-15
- **source:** SPRINT-007 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/services/__tests__/claudeCodeManagerWiring.test.ts:174-179
- **description:** Cross-task test-coverage gap — production passes Logger, tests pass undefined. TASK-574 refactored all streamParser classes to accept a shared ILogger (warn/info?/verbose?). TASK-572 passes this.logger from ClaudeCodeManager (a real Logger instance in production) into ClaudeStreamParser, RawEventsSink, CompletionDetector. But claudeCodeManagerWiring.test.ts:176 instantiates the manager with `undefined` for the logger arg, so the `logger?.warn(...)`/`logger?.info?.(...)` paths added in TASK-572 (lines 311-312, 340-342, 374-376 of claudeCodeManager.ts) are not exercised. The branches are defensive (optional-chained), so this isnt a correctness bug, but a wiring regression that mis-passes a non-Logger object would not be caught by the test suite. TASK-574s own __tests__/jsonParser.test.ts does exercise the warn path via makeLoggerSpy, but the cross-task wire from ClaudeCodeManager → pipeline classes isnt covered.

Suspected tasks: TASK-572, TASK-574
- **suggested_action:** Add a spy logger to claudeCodeManagerWiring.test.ts (mirror makeLoggerSpy from jsonParser.test.ts), pass it as the second constructor arg, and assert that completion complete-handler warn paths fire when a `from→to` is illegal (e.g. seed an illegal pair via a spy on assertTransitionAllowed). Confirms the wire from ClaudeCodeManager through to the underlying ILogger surface.
- **resolved_by:** 
