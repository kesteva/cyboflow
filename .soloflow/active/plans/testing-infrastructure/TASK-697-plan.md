---
id: TASK-697
idea: SPRINT-027-compound
status: ready
created: 2026-05-20T00:00:00Z
files_owned:
  - main/src/services/panels/claude/__tests__/claudeCodeManager.killProcess.test.ts
files_readonly:
  - main/src/services/panels/claude/claudeCodeManager.ts
  - main/src/services/panels/claude/__tests__/claudeCodeManagerWiring.test.ts
  - main/src/orchestrator/approvalRouter.ts
  - main/src/test/setup.ts
  - main/vitest.config.ts
acceptance_criteria:
  - criterion: "Test 'killProcess mid-stream clears pipelines, sdkRuns, and processes maps' passes in isolation (single-file run)"
    verification: "cd main && npx vitest run src/services/panels/claude/__tests__/claudeCodeManager.killProcess.test.ts -> exit 0, both cases pass."
  - criterion: "Same test passes deterministically in the full main-package suite -- 3 consecutive runs green"
    verification: "cd main && npx vitest run && npx vitest run && npx vitest run -- each exits 0; killProcess mid-stream completes < 500ms each run."
  - criterion: "Test does NOT await an unresolvable promise -- spawnPromise is no longer awaited before killProcess"
    verification: "grep -n 'await spawnPromise' returns 0 matches BEFORE the killProcess call; if awaited at all, it is AFTER killProcess."
  - criterion: "clearPendingForRun single-source invariant preserved"
    verification: "grep -n 'toHaveBeenCalledOnce|not.toHaveBeenCalled' returns both assertions, unchanged."
  - criterion: "No real wall-clock waits in the test"
    verification: "grep -n 'setTimeout' returns 0 matches in the test body (or only as a bound-on-assertion, not a wait-for-state)."
depends_on: []
estimated_complexity: low
epic: testing-infrastructure
test_strategy:
  needed: true
  justification: "The artifact IS a test file. Work is rewriting the test to be deterministic. Acceptance via test itself passing reliably."
  targets:
    - behavior: "killProcess mid-stream: maps populated after spawn registration, then emptied after killProcess; clearPendingForRunSpy called once."
      test_file: main/src/services/panels/claude/__tests__/claudeCodeManager.killProcess.test.ts
      type: unit
    - behavior: "killProcess on a panel with no active run: idempotent, no throw, maps remain empty, clearPendingForRunSpy never called."
      test_file: main/src/services/panels/claude/__tests__/claudeCodeManager.killProcess.test.ts
      type: unit
---

# Fix intermittent killProcess mid-stream test timeout

## Objective

Rewrite `killProcess mid-stream clears pipelines, sdkRuns, and processes maps` so it does not await `spawnCliProcess` before killing. `spawnCliProcess` internally awaits `iteratorDone` (claudeCodeManager.ts:313), and the mock parks on AbortController until aborted -- so `await spawnPromise` before `killProcess` deadlocks under full-suite load. Fix: register the spawn, wait for maps to populate via microtask drain, then `killProcess`, then await the spawn promise (which now resolves).

## Implementation Steps

1. Open `main/src/services/panels/claude/__tests__/claudeCodeManager.killProcess.test.ts`.

2. In Case 1 (lines ~158-193), restructure to:
   - `const spawnPromise = mgr.spawnCliProcess({...});` (no await)
   - Define a `waitForMaps(mgr, panelId, maxTicks=50)` helper that polls via `await Promise.resolve()` microtask yields, throwing if maps don't populate.
   - `await waitForMaps(mgr, panelId);`
   - Assert maps populated (existing assertions).
   - `await mgr.killProcess(panelId);` -- aborts controller, finally clears maps.
   - `await spawnPromise;` (now resolves because abort fires iteratorDone).
   - Existing post-kill assertions remain unchanged.

3. Case 2 is already deterministic (never spawns) -- no change.

4. Do NOT modify the mock query() in the test file. The `signal.addEventListener('abort', resolve)` path is the unstick mechanism.

5. Add 2-4 line top-of-file comment explaining why spawnPromise must NOT be awaited before killProcess (reference TASK-697).

6. Run vitest in isolation: `cd main && npx vitest run src/services/panels/claude/__tests__/claudeCodeManager.killProcess.test.ts`.

7. Run full suite 3x: `cd main && npx vitest run && npx vitest run && npx vitest run`. Each exit 0.

## Hardest Decision

Microtask polling vs `vi.useFakeTimers()`. Microtask chosen: `spawnCliProcess` has no setTimeout in its path; AbortController + fake timers interact badly. Bounded microtask loop (50 yields) is faster and self-documenting.

## Rejected Alternatives

- Increase test timeout to 30000ms: masks the structural bug.
- `void spawnPromise`: loses spawn-time exceptions.
- Mock runSdkQuery to resolve immediately: short-circuits finally-block tested behavior.
- Increase mock yield count: test stops being mid-stream.

## Lowest Confidence Area

Whether microtask-drain alone is sufficient to observe map population. `withLock` (mutex.ts) may schedule via setTimeout(0) on some paths. Mitigation: if waitForMaps reports timeout in CI, switch yield to `await new Promise(r => setImmediate(r))`.
