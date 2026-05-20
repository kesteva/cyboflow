---
id: TASK-671
idea: IDEA-SPRINT-024-compound
status: ready
created: 2026-05-20T00:00:00Z
files_owned:
  - main/src/orchestrator/__tests__/runExecutor.test.ts
files_readonly:
  - main/src/orchestrator/runExecutor.ts
  - main/src/orchestrator/runEventBridge.ts
  - main/src/orchestrator/__test_fixtures__/loggerLikeSpy.ts
  - main/src/services/streamParser/eventRouter.ts
  - main/src/services/streamParser/rawEventsSink.ts
  - main/src/services/streamParser/typedEventNarrowing.ts
  - main/src/orchestrator/RunQueueRegistry.ts
acceptance_criteria:
  - criterion: "All previously failing tests in main/src/orchestrator/__tests__/runExecutor.test.ts pass. Specifically the four assertions called out by FIND-SPRINT-024-1 (the `expect(running).toHaveBeenCalledOnce()` at approximately line 626 inside 'onLifecycleTransition routes each phase...'; the `expect(running).toHaveBeenCalledOnce()` at approximately line 807 inside 'source arg: lifecycleTransitions.running() fires when source emits output event'; the `expect(running).not.toHaveBeenCalled()` at approximately line 862 inside 'source absent: bridgeEvents short-circuits...'; and the `expect(running).not.toHaveBeenCalled()` at approximately line 1301 inside 'bridge drops output event when panelId has run- prefix...') all pass."
    verification: "Run `cd main && pnpm exec vitest run src/orchestrator/__tests__/runExecutor.test.ts --reporter=verbose` and confirm exit 0 with zero failed tests."
  - criterion: "No production source file under main/src/orchestrator/ or main/src/services/ is modified — the fix is test-state hygiene only."
    verification: "Run `git diff --name-only HEAD` after the change and confirm the only modified file is main/src/orchestrator/__tests__/runExecutor.test.ts."
  - criterion: "The full main vitest suite remains green (no test made worse by the change)."
    verification: "Run `cd main && pnpm exec vitest run` and confirm exit 0; pre-task baseline (492 pass, 5 fail per FIND-SPRINT-024-1) → expected post-task baseline 497 pass, 0 fail."
  - criterion: "runExecutor.test.ts continues to use makeSpyLogger() from __test_fixtures__/loggerLikeSpy (the TASK-646 migration is preserved)."
    verification: "grep -n 'makeSpyLogger' main/src/orchestrator/__tests__/runExecutor.test.ts returns at least 1 hit; grep -nE 'function makeLogger|const makeLogger|nullLogger' main/src/orchestrator/__tests__/runExecutor.test.ts returns 0 hits."
depends_on: []
estimated_complexity: low
epic: testing-infrastructure
test_strategy:
  needed: false
  justification: "This task IS a test-file repair — the work is to make four pre-existing failing tests pass without touching production code. The acceptance criteria are themselves verified by running the existing test file. Adding new tests for the spy-reset machinery would test test infrastructure, which has no contractual surface to verify."
---

# Fix pre-existing spy state bleed in runExecutor.test.ts

## Objective

Restore `main/src/orchestrator/__tests__/runExecutor.test.ts` to a fully-green state by repairing the four pre-existing test failures FIND-SPRINT-024-1 identified: the transition-spy assertions on `running` get observed call counts that diverge from the expected counts. The TASK-646 `makeSpyLogger` migration already landed; this task is purely test-state hygiene. The fix is to ensure every test in the file starts with fresh spy state, regardless of which `describe` block or `vi.fn()` factory created it, so test execution order does not influence assertion outcomes.

## Implementation Steps

1. **Reproduce the baseline failures.**
   ```
   cd main && pnpm exec vitest run src/orchestrator/__tests__/runExecutor.test.ts --reporter=verbose 2>&1 | tee /tmp/runExecutor-baseline.log
   ```
   Confirm the four named tests fail. Save the precise error text (observed call count, list of `mock.calls[*]`).

2. **Diagnose the leak source.** The file's only top-level reset is `beforeEach(() => vi.clearAllMocks())` at line 105. `vi.clearAllMocks()` clears `.mock.calls`/`.mock.results` on every mock vitest knows about, but does NOT:
   - Restore spies created via `vi.spyOn()` (only `vi.restoreAllMocks()` does that).
   - Detach event listeners attached to `EventEmitter` instances.
   - Reset state on shared `Database(':memory:')` handles that span tests.

   Walk the failing tests and identify the actual leak channel. Likely candidates:
   a. `vi.spyOn(runQueueRegistry, 'getOrCreate')` at line 953.
   b. EventEmitter listener leakage on `source`.
   c. Internal `RunExecutor` state via maps.
   d. The bridge's source listener that may not be cleaned up by `bridge.dispose()`.

3. **Apply the minimal fix.** Based on the diagnosis, apply ONE of:

   **Option A — strengthen the `beforeEach` reset:**
   ```ts
   beforeEach(() => {
     vi.clearAllMocks();
     vi.restoreAllMocks();
   });
   ```

   **Option B — scoped `afterEach` for EventEmitter cleanup** inside each describe block that creates a `source` EventEmitter.

   **Option C — combine A and B with `vi.resetModules()`** only if module-cache contamination is the leak.

   Default to Option A; escalate to B or C only if A is insufficient.

4. **Re-run the targeted test file.**
   ```
   cd main && pnpm exec vitest run src/orchestrator/__tests__/runExecutor.test.ts --reporter=verbose
   ```
   Confirm all four previously-failing tests now pass.

5. **Re-run the full main vitest suite.** `cd main && pnpm exec vitest run` — exit 0.

6. **Confirm production code untouched.** `git diff --name-only HEAD` must list only the test file.

## Acceptance Criteria

See frontmatter.

## Hardest Decision

Choosing between Options A, B, and C without first observing the actual failure mode. The compounder asserts this is "purely test-state hygiene" but does not name the specific spy. Default to the lightest-touch option (A) and escalate only if needed.

## Rejected Alternatives

- **`vi.resetAllMocks()`** at line 105 — would clear spy implementations and break module-level `vi.fn().mockResolvedValue(undefined)` patterns.
- **Inline reset in each failing test** — hides the underlying leak.
- **Touch production `RunExecutor.bridgeEvents`** — compounder is explicit this is test-only.

## Lowest Confidence Area

The diagnosis in step 2 is load-bearing and the planner could not run the failing tests. If the executor's diagnosis points to a fifth root cause, escalate before improvising a production-code change.
