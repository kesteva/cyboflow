---
id: TASK-718
idea: SPRINT-029-compound-B1
status: in-flight
created: "2026-05-21T00:00:00.000Z"
files_owned:
  - main/src/services/panels/claude/__tests__/claudeCodeManager.killProcess.test.ts
files_readonly:
  - main/src/services/panels/claude/claudeCodeManager.ts
  - main/src/services/panels/cli/AbstractCliManager.ts
  - main/src/orchestrator/approvalRouter.ts
  - main/src/orchestrator/__test_fixtures__/dbAdapter.ts
  - main/src/database/migrations/006_cyboflow_schema.sql
  - .soloflow/active/compound/SPRINT-029-proposal.md
  - .soloflow/active/findings/SPRINT-029-findings.md
acceptance_criteria:
  - criterion: Both it blocks in claudeCodeManager.killProcess.test.ts pass without timeout.
    verification: "pnpm --filter main exec vitest run src/services/panels/claude/__tests__/claudeCodeManager.killProcess.test.ts --reporter=verbose 2>&1 | grep -E '2 passed|Tests\\s+2 passed'"
  - criterion: The mid-stream test does not hit the 5s vitest timeout — it completes in under 1 second.
    verification: "pnpm --filter main exec vitest run src/services/panels/claude/__tests__/claudeCodeManager.killProcess.test.ts --reporter=verbose 2>&1 | grep 'killProcess mid-stream' | grep -vE 'timed out|5000ms'"
  - criterion: "No `TypeError: Cannot read properties of undefined (reading 'close')` in the test output."
    verification: "pnpm --filter main exec vitest run src/services/panels/claude/__tests__/claudeCodeManager.killProcess.test.ts 2>&1 | grep -E \"Cannot read properties of undefined.*close\" | wc -l | tr -d ' ' | grep -qx 0"
  - criterion: "The invariants the original tests assert remain intact: after killProcess the pipelines, sdkRuns, and processes maps are empty, and clearPendingForRun was called exactly once from runSdkQuery's finally block."
    verification: "grep -nE \"\\.has\\(panelId\\)\\)\\.toBe\\(false\\)|clearPendingForRunSpy\\)\\.toHaveBeenCalledOnce\\(\\)\" main/src/services/panels/claude/__tests__/claudeCodeManager.killProcess.test.ts | wc -l | tr -d ' ' | awk '{ if ($1 >= 4) print \"ok\"; else exit 1 }'"
  - criterion: Full main-workspace unit suite passes (no new regressions).
    verification: "pnpm --filter main test 2>&1 | tail -50 | grep -E 'Tests.*failed' | grep -vE 'Tests\\s+0 failed' | wc -l | tr -d ' ' | grep -qx 0"
depends_on: []
estimated_complexity: low
epic: cli-tool-integration
test_strategy:
  needed: true
  justification: "This task IS the test fix. The owned file IS the test file. Rewrite the failing test cases so they exercise the same invariants without deadlocking on spawnCliProcess's `await iteratorDone`."
  targets:
    - behavior: "killProcess mid-stream aborts the SDK run and clears pipelines/sdkRuns/processes maps; clearPendingForRun fires exactly once from runSdkQuery's finally."
      test_file: main/src/services/panels/claude/__tests__/claudeCodeManager.killProcess.test.ts
      type: unit
    - behavior: "killProcess on a panel with no active run is idempotent: no throw, maps stay empty, clearPendingForRun is never called."
      test_file: main/src/services/panels/claude/__tests__/claudeCodeManager.killProcess.test.ts
      type: unit
---
# Fix pre-existing 5s timeout in claudeCodeManager.killProcess.test.ts

## Objective

The test `killProcess mid-stream clears pipelines, sdkRuns, and processes maps` has been timing out at 5000ms since at least base SHA `28f8281`. The cause is a deadlock: `spawnCliProcess` awaits `iteratorDone` (claudeCodeManager.ts:313), but the SDK `query()` mock parks on the AbortController until aborted. Spawn cannot resolve until kill is called; kill cannot be called until spawn resolves. Rewrite the test to issue `killProcess` *while* `spawnCliProcess` is still in flight (gated on the `'spawned'` event), then `await` both.

## Implementation Steps

1. Re-read the deadlock path end-to-end: `claudeCodeManager.ts:206-314` (spawnCliProcess), `:321-380` (runSdkQuery), `:540-546` (abortCurrentRun).

2. Probe Case 2's `db.close()` TypeError by running the file once and capturing stderr. Determine whether it's a cascade from Case 1's timeout or independent.

3. **Rewrite Case 1 (mid-stream)** — replace `await spawnPromise` deadlock with a `'spawned'`-event gate:
   ```typescript
   const spawnedEvent = new Promise<void>((resolve) => { mgr.once('spawned', () => resolve()); });
   const spawnPromise = mgr.spawnCliProcess({ panelId, sessionId, worktreePath: '/tmp/test-worktree', prompt: 'do something', permissionMode: 'ignore' });
   await spawnedEvent;
   expect(getPipelines(mgr).has(panelId)).toBe(true);
   expect(getSdkRuns(mgr).has(panelId)).toBe(true);
   expect(getProcesses(mgr).has(panelId)).toBe(true);
   await mgr.killProcess(panelId);
   await spawnPromise;
   expect(getPipelines(mgr).has(panelId)).toBe(false);
   expect(getSdkRuns(mgr).has(panelId)).toBe(false);
   expect(getProcesses(mgr).has(panelId)).toBe(false);
   expect(clearPendingForRunSpy).toHaveBeenCalledOnce();
   expect(clearPendingForRunSpy).toHaveBeenCalledWith(panelId);
   ```

4. **Harden afterEach** with `if (db)` guard:
   ```typescript
   afterEach(() => {
     ApprovalRouter._resetForTesting();
     if (db) db.close();
     vi.clearAllMocks();
   });
   ```

5. Run `pnpm --filter main exec vitest run src/services/panels/claude/__tests__/claudeCodeManager.killProcess.test.ts --reporter=verbose` — must report `2 passed` in under 1s.

6. **Do NOT touch production code.** The `await iteratorDone` at claudeCodeManager.ts:313 is intentional — RunExecutor uses it as the turn-complete signal.

## Hardest Decision

**Whether to fix this in the test or in production.** Chose test: production's `await iteratorDone` encodes a real invariant (running → completed gating). The test was wrong; the contract is right. The `'spawned'` event is the documented sync point for "spawn has registered" without forcing "turn complete".

## Rejected Alternatives

- `vi.useFakeTimers()` — mock uses AbortController, not setTimeout. Fake timers wouldn't unblock.
- Move `await spawnPromise` after `await killProcess` without an event gate — races where killProcess fires before maps are populated.
- Rewrite SDK mock to not park — defeats the purpose of testing mid-stream kill.
- Increase vitest timeout — hides the deadlock.

## Lowest Confidence Area

Case 2's `db.close()` TypeError mechanism. Strongest hypothesis: cascade from Case 1's timeout. Step 2 probes empirically. Defensive `if (db)` guard protects regardless of root cause.
