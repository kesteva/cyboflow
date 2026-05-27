---
id: TASK-774
idea: SPRINT-039-followups
status: in-flight
created: "2026-05-26T00:00:00Z"
files_owned:
  - main/src/orchestrator/cancelAndRestartHandler.ts
  - main/src/orchestrator/__tests__/cancelAndRestart.test.ts
  - main/src/index.ts
files_readonly:
  - main/src/orchestrator/questionRouter.ts
  - main/src/orchestrator/approvalRouter.ts
  - main/src/orchestrator/trpc/routers/runs.ts
  - .soloflow/active/findings/SPRINT-039-findings.md
acceptance_criteria:
  - criterion: "CancelAndRestartDeps interface now includes `questionRouter: Pick<QuestionRouter, 'clearPendingForRun'>`."
    verification: "grep -n 'questionRouter:' main/src/orchestrator/cancelAndRestartHandler.ts returns ≥1 match inside the CancelAndRestartDeps interface body."
  - criterion: cancelAndRestartHandler invokes `questionRouter.clearPendingForRun(runId)` immediately after `approvalRouter.clearPendingForRun(runId)` and before `claudeManagerStop(runId)`.
    verification: "grep -n 'questionRouter.clearPendingForRun' main/src/orchestrator/cancelAndRestartHandler.ts returns ≥1 match; the call site is placed between the existing approvalRouter.clearPendingForRun call (currently line 126) and the existing claudeManagerStop try-block (currently line 137-144)."
  - criterion: main/src/index.ts setCancelAndRestartDeps wiring passes QuestionRouter.getInstance() as `questionRouter`.
    verification: "grep -n 'questionRouter: QuestionRouter' main/src/index.ts returns ≥1 match inside the setCancelAndRestartDeps call (currently lines 774-780)."
  - criterion: "A regression test in main/src/orchestrator/__tests__/cancelAndRestart.test.ts asserts that BOTH `approvalRouter.clearPendingForRun` AND `questionRouter.clearPendingForRun` are called before `claudeManagerStop`, with the relative ordering: approvalRouter first, questionRouter second, claudeManagerStop third."
    verification: "grep -n 'questionRouter\\b' main/src/orchestrator/__tests__/cancelAndRestart.test.ts returns ≥3 matches (mock spy declaration in OrderSpy interface + injection in makeDeps + assertion in a new `it()` case)."
  - criterion: "Main + integration tests pass: pnpm --filter main test exits 0; pnpm typecheck exits 0."
    verification: pnpm --filter main test exits 0; pnpm typecheck exits 0.
depends_on: []
estimated_complexity: low
epic: ask-user-question-roundtrip
test_strategy:
  needed: true
  justification: Behavioral fix that closes a symmetry gap introduced when SPRINT-039 added the awaiting_input gate. A regression test asserting both routers are called before PTY kill is required; without it a future cancel-handler edit could silently re-introduce the bug.
  targets:
    - behavior: "cancelAndRestartHandler calls approvalRouter.clearPendingForRun AND questionRouter.clearPendingForRun before claudeManagerStop, in that order"
      test_file: main/src/orchestrator/__tests__/cancelAndRestart.test.ts
      type: integration
    - behavior: questionRouter.clearPendingForRun is invoked with the correct runId
      test_file: main/src/orchestrator/__tests__/cancelAndRestart.test.ts
      type: integration
    - behavior: noOp path (already-terminal run) does NOT invoke questionRouter.clearPendingForRun
      test_file: main/src/orchestrator/__tests__/cancelAndRestart.test.ts
      type: integration
---
# TASK-774 — Wire questionRouter.clearPendingForRun into cancelAndRestartHandler

## Objective

Close the symmetry gap raised by FIND-SPRINT-039-15: after SPRINT-039 added the `awaiting_input` workflow_runs status and the QuestionRouter, `cancelAndRestartHandler` still clears only approval-gate pending entries before tearing down the Claude SDK run. Question-gate pending entries leak in-process until the SDK abort eventually fires (or the boot recovery path catches them on next restart). Thread `questionRouter.clearPendingForRun(runId)` adjacent to the existing approval clear, extend the deps bag, inject from `main/src/index.ts`, and lock the behavior in with a regression test that asserts the call ordering.

## Implementation Steps

1. **Run the completeness baseline:** `pnpm --filter main test -- cancelAndRestart.test.ts` and confirm the existing tests are green at HEAD. If any pre-existing failures appear, surface them in the done report before continuing.

2. **Extend `CancelAndRestartDeps`** in `main/src/orchestrator/cancelAndRestartHandler.ts` (currently lines 28-48). Add a sibling import near the existing `import type { ApprovalRouter } from './approvalRouter';` (line 17):
   ```ts
   import type { QuestionRouter } from './questionRouter';
   ```
   Add a new field to the interface immediately after the existing `approvalRouter` field (line 30):
   ```ts
   questionRouter: Pick<QuestionRouter, 'clearPendingForRun'>;
   ```

3. **Destructure `questionRouter`** from `deps` in the handler body (line 101) and call it adjacent to the existing `approvalRouter.clearPendingForRun(runId)` call (line 126). Replace lines 101-130 such that the destructure includes the new field and the new call sits between the approval clear and the existing `logger?.debug(...)` line:
   ```ts
   const { db, approvalRouter, questionRouter, runQueues, claudeManagerStop, logger } = deps;
   ```
   And in the queue body, immediately after line 126 (`approvalRouter.clearPendingForRun(runId);`):
   ```ts
   // Symmetry with approvalRouter.clearPendingForRun above — settle any
   // pending AskUserQuestion gate Promises before PTY kill so the
   // awaiting PreToolUse hook callbacks resolve cleanly and the SDK
   // abort does not race with the question router's pending map.
   questionRouter.clearPendingForRun(runId);
   ```
   The existing `logger?.debug(...)` block (lines 127-130) about TASK-304 stays unchanged — it specifically references the approvalRouter's documented no-op for the permission socket, not the question gate.

4. **Update the boot wiring** in `main/src/index.ts` (currently lines 774-780). The current call:
   ```ts
   setCancelAndRestartDeps({
     db,
     approvalRouter: ApprovalRouter.getInstance(),
     runQueues,
     claudeManagerStop: (sessionId: string) => defaultCliManager.stopPanel(sessionId),
     logger: loggerLike,
   });
   ```
   Add a `questionRouter: QuestionRouter.getInstance(),` line after the `approvalRouter:` line. `QuestionRouter` is already imported at line 31. The `QuestionRouter.initialize(...)` call at line 734 already runs before this `setCancelAndRestartDeps` call (line 774), so `getInstance()` will be safe.

5. **Add the regression test** in `main/src/orchestrator/__tests__/cancelAndRestart.test.ts`. Extend the `OrderSpy` interface (currently lines 66-71) to include the question-router spy:
   ```ts
   interface OrderSpy {
     calls: string[];
     clearPendingForRun: ReturnType<typeof vi.fn>;       // approvalRouter
     clearQuestionsForRun: ReturnType<typeof vi.fn>;     // questionRouter
     claudeManagerStop: ReturnType<typeof vi.fn>;
     worktreeRemove: ReturnType<typeof vi.fn>;
   }
   ```
   Extend `makeOrderSpy()` (line 73-89):
   ```ts
   const clearQuestionsForRun = vi.fn((_runId: string) => {
     calls.push('clearQuestionsForRun');
   });
   ```
   And add to the returned object: `clearQuestionsForRun`.

6. **Update `makeDeps`** (currently lines 95-107) to inject the question-router spy:
   ```ts
   function makeDeps(
     db: Database.Database,
     spy: OrderSpy,
     runQueues?: RunQueueRegistry,
   ): HandlerDeps {
     const registry = runQueues ?? new RunQueueRegistry();
     return {
       db: dbAdapter(db),
       approvalRouter: { clearPendingForRun: spy.clearPendingForRun } as unknown as import('../approvalRouter').ApprovalRouter,
       questionRouter: { clearPendingForRun: spy.clearQuestionsForRun },
       runQueues: registry,
       claudeManagerStop: spy.claudeManagerStop,
     };
   }
   ```

7. **Add a new `it()` block** to the existing `describe('cancelAndRestartHandler', ...)` block in the same test file. Place it adjacent to the existing "calls clearPendingForRun BEFORE claudeManagerStop (AC5: deny before kill)" case (line 129-137):
   ```ts
   it('calls approvalRouter.clearPendingForRun → questionRouter.clearPendingForRun → claudeManagerStop in that order', async () => {
     const runId = randomUUID();
     seedWorkflowAndRun(db, runId, 'stuck');

     await cancelAndRestartHandler(runId, makeDeps(db, spy, runQueues));

     expect(spy.calls[0]).toBe('clearPendingForRun');       // approvalRouter
     expect(spy.calls[1]).toBe('clearQuestionsForRun');     // questionRouter (NEW)
     expect(spy.calls[2]).toBe('claudeManagerStop');
   });

   it('calls questionRouter.clearPendingForRun with the correct runId', async () => {
     const runId = randomUUID();
     seedWorkflowAndRun(db, runId, 'stuck');

     await cancelAndRestartHandler(runId, makeDeps(db, spy, runQueues));

     expect(spy.clearQuestionsForRun).toHaveBeenCalledWith(runId);
   });

   it('does NOT call questionRouter.clearPendingForRun on the noOp path (already-terminal run)', async () => {
     const runId = randomUUID();
     seedWorkflowAndRun(db, runId, 'completed');

     const result = await cancelAndRestartHandler(runId, makeDeps(db, spy, runQueues));
     expect('noOp' in result && result.noOp).toBe(true);
     expect(spy.clearQuestionsForRun).not.toHaveBeenCalled();
   });
   ```

8. **Update the existing "AC5: deny BEFORE PTY kill" assertion** at lines 129-137 to also tolerate the new call between clearPendingForRun and claudeManagerStop. The existing assertion uses indices 0 and 1 (`spy.calls[0]` and `spy.calls[1]`). Update to:
   ```ts
   expect(spy.calls[0]).toBe('clearPendingForRun');
   expect(spy.calls.indexOf('claudeManagerStop')).toBeGreaterThan(spy.calls.indexOf('clearPendingForRun'));
   ```
   Or extend it to mirror step 7's three-step assertion. The latter is preferred for clarity; pick one consistent style.

9. **Run the completeness gate**:
   ```bash
   pnpm --filter main test -- cancelAndRestart.test.ts
   pnpm --filter main test
   pnpm typecheck
   ```
   All three exit 0. If `pnpm --filter main test` requires `pnpm rebuild better-sqlite3` first (CLAUDE.md note on better-sqlite3 NMV mismatch), run that prep step.

## Acceptance Criteria

1. `grep -n 'questionRouter:' main/src/orchestrator/cancelAndRestartHandler.ts` returns ≥1 match in the CancelAndRestartDeps interface.
2. `grep -n 'questionRouter.clearPendingForRun' main/src/orchestrator/cancelAndRestartHandler.ts` returns exactly 1 match in the queued handler body (between approvalRouter.clearPendingForRun and claudeManagerStop).
3. `grep -n 'questionRouter: QuestionRouter' main/src/index.ts` returns ≥1 match in the setCancelAndRestartDeps call.
4. `grep -n 'clearQuestionsForRun\|spy.clearQuestionsForRun' main/src/orchestrator/__tests__/cancelAndRestart.test.ts` returns ≥3 matches.
5. `pnpm --filter main test` exits 0 and shows ≥3 new passing tests beyond the pre-task baseline.
6. `pnpm typecheck` exits 0.

## Test Strategy

Three new `it()` blocks added to `main/src/orchestrator/__tests__/cancelAndRestart.test.ts`:
1. **Ordering test:** asserts the call-order array contains `clearPendingForRun → clearQuestionsForRun → claudeManagerStop` in that sequence.
2. **Argument test:** asserts `spy.clearQuestionsForRun` is called with the correct runId.
3. **NoOp test:** asserts the questionRouter clear is NOT called on the already-terminal noOp path.

The existing OrderSpy harness already proves the pattern works for the approvalRouter clear — extending it for the questionRouter clear is a mechanical mirror.

## Hardest Decision

Whether `questionRouter.clearPendingForRun` should be called BEFORE or AFTER `approvalRouter.clearPendingForRun`. Chose **after** because: (1) `awaiting_review` (approvals) is the older, more battle-tested gate; the deny-replies-before-PTY-kill ordering rationale in cancelAndRestartHandler's AC5 was written against it specifically; (2) preserving approvalRouter as the first call keeps the existing AC5 test ("clearPendingForRun BEFORE claudeManagerStop") true with minimal change; (3) the QuestionRouter's `clearPendingForRun` is synchronous and DB-only (no socket write — unlike a hypothetical approval socket reply), so its position relative to claudeManagerStop is less time-sensitive. Both clears are atomic on the in-process pending maps, so a different ordering would also be correct, but "approval first, then question" matches the order they were introduced into the codebase and reads cleanly in the diff.

## Rejected Alternatives

- **Make QuestionRouter listen for `cancelAndRestart` events** (event-bus rather than direct injection). Rejected: the existing approvalRouter pattern is direct injection via the deps bag, and matching that pattern preserves the testable handler's standalone-typecheck invariant (cancelAndRestartHandler.ts MUST NOT import from `main/src/services/*` or `better-sqlite3` — direct injection through a narrow `Pick<>` surface honors that).
- **Push the entire pending-gate cleanup into a single helper `clearAllPendingGatesForRun(runId)`** in a new module. Rejected: premature abstraction. FIND-SPRINT-039-16 separately tracks the broader "shared GateRouter abstraction" idea — this task is the immediate symmetry fix, not the abstraction. Reconsider once a third gate type lands.
- **Call `questionRouter.clearPendingForRun` AFTER `claudeManagerStop`** (let the SDK abort fire first). Rejected: leaves a window where the question router still thinks the run is awaiting input even though the PTY is dead. The pending Promises hang for awaiting hook callers; the symmetry-with-approvalRouter argument is the clearer model.

## Lowest Confidence Area

Whether `QuestionRouter.getInstance()` is safely available at the `setCancelAndRestartDeps` call site (main/src/index.ts:774). Verified at plan time that `QuestionRouter.initialize(...)` runs at line 734, well before the `setCancelAndRestartDeps` call at line 774, so `getInstance()` will not throw. If a future refactor re-orders boot to place setCancelAndRestartDeps before QuestionRouter init, the `getInstance()` throw will surface immediately at boot — preferable to silently passing `undefined`. No mitigation needed beyond this note.
```

---

```markdown
