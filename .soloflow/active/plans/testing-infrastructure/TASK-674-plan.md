---
id: TASK-674
idea: SPRINT-025-compounder
status: in-flight
created: "2026-05-20T00:00:00Z"
files_owned:
  - main/src/orchestrator/__tests__/runExecutor.test.ts
files_readonly:
  - main/src/orchestrator/runExecutor.ts
  - main/src/orchestrator/runEventBridge.ts
acceptance_criteria:
  - criterion: "All 4 previously failing test cases in runExecutor.test.ts pass: 'onLifecycleTransition routes each phase', 'source arg: lifecycleTransitions.running() fires when source emits output event', 'source absent: bridgeEvents short-circuits; running() is not called', and 'bridge drops output event when panelId has run- prefix (old broken behaviour)'."
    verification: Run `pnpm --filter @cyboflow/main test -- runExecutor.test.ts` from the repo root; exit code 0 and all 4 named cases appear in the passing list.
  - criterion: No existing passing test case in runExecutor.test.ts regresses.
    verification: Same vitest invocation as above — every prior `✓` line still shows `✓` (no new failures introduced).
  - criterion: "Test assertions accurately reflect the post-715b6c9 production contract: `pre_spawn` phase calls `lifecycleTransitions.running(runId)` once per `execute()` invocation, independent of whether the bridge later fires `sdk_initialized`."
    verification: "Inspect the updated test bodies and confirm each case either (a) accounts for the pre-spawn running() call in its expectation count, or (b) explicitly explains via comment why pre_spawn is bypassed in that test's setup (e.g. test calls `testLifecycleTransition` directly rather than `execute`)."
  - criterion: "The bridge-drop regression test still verifies its core invariant: when an output event has a mismatched panelId (`run-<runId>` prefix), `countRawEvents(db, runId)` remains 0 — i.e. the bridge filter still works."
    verification: "grep -n 'expect(cnt).toBe(0)' main/src/orchestrator/__tests__/runExecutor.test.ts and confirm the bridge-drop test (around line 1288) retains the `countRawEvents(db, run.id) === 0` assertion."
depends_on: []
estimated_complexity: low
epic: testing-infrastructure
test_strategy:
  needed: true
  justification: "This task IS a test fix. The 'tests' to update are the 4 listed cases themselves; no separate test file needs to be authored."
  targets:
    - behavior: "onLifecycleTransition routes each phase to the right transition helper, accounting for the pre_spawn → running() call introduced in commit 715b6c9."
      test_file: main/src/orchestrator/__tests__/runExecutor.test.ts
      type: unit
    - behavior: "When source EventEmitter is wired, both pre_spawn and sdk_initialized phases fire running() — total call count is 2, not 1."
      test_file: main/src/orchestrator/__tests__/runExecutor.test.ts
      type: integration
    - behavior: "When source is absent, only pre_spawn fires running() (call count is 1); bridgeEvents() short-circuits and does NOT fire a second running()."
      test_file: main/src/orchestrator/__tests__/runExecutor.test.ts
      type: integration
    - behavior: "When the bridge sees an output event with a mismatched panelId (`run-<runId>` prefix), no raw_events row is inserted; running() may still be called once via pre_spawn but the bridge correctly filters."
      test_file: main/src/orchestrator/__tests__/runExecutor.test.ts
      type: integration
---
# Fix 4 stale runExecutor.test.ts cases broken by pre-sprint lifecycle and panelId changes

## Objective

Update 4 assertions in `main/src/orchestrator/__tests__/runExecutor.test.ts` that were rendered stale by two pre-sprint commits: `715b6c9` (which moved `transitionTo('running')` to fire at the `pre_spawn` phase, before SDK spawn) and the TASK-663 panelId rebanding (`9195fdf`). The tests still encode the pre-715b6c9 contract where `running()` was only called once via the bridge's `onFirstMessage` callback. Production behavior is correct; the tests are stale.

## Implementation Steps

1. **Re-read the production code that defines the new contract** so the test rewrites match it:
   - `main/src/orchestrator/runExecutor.ts:200` — `execute()` calls `await this.onLifecycleTransition(runId, 'pre_spawn')` before `spawnCliProcess`.
   - `main/src/orchestrator/runExecutor.ts:385-405` — `onLifecycleTransition` calls `lifecycleTransitions.running(runId)` for BOTH `'pre_spawn'` (the new primary trigger) AND `'sdk_initialized'` (the defensive idempotency arm).
   - `main/src/orchestrator/runExecutor.ts:182` — `panelId = runId` (no `run-` prefix). The bridge filter at runEventBridge.ts compares `payload.panelId === runId` directly.

2. **Fix `onLifecycleTransition routes each phase to the right transition helper`** (test file lines 587-628):
   - The test calls `testLifecycleTransition` directly (bypassing `execute()`) so `pre_spawn` would NOT auto-fire `running()` in this test. Add explicit `await executor.testLifecycleTransition(run.id, 'pre_spawn')` BEFORE the `'sdk_initialized'` call, then assert `expect(running).toHaveBeenCalledTimes(2)` (once for pre_spawn, once for sdk_initialized's defensive arm).
   - The final assertion block (`expect(running).toHaveBeenCalledOnce()` at line 626) must change to `expect(running).toHaveBeenCalledTimes(2)` — because the explicit `pre_spawn` and `sdk_initialized` calls each fire `running()` exactly once.
   - Update the JSDoc comment in the test to note: "pre_spawn and sdk_initialized both route to running() — the second is a defensive idempotency call (see runExecutor.ts:399-404)."

3. **Fix `source arg: lifecycleTransitions.running() fires when source emits output event`** (test file lines 708-814):
   - Change `expect(running).toHaveBeenCalledOnce()` (line 796) to `expect(running).toHaveBeenCalledTimes(2)` — one call from `pre_spawn` (fired by execute()), one from `sdk_initialized` (fired by onFirstMessage when the source emits its first output event).
   - Add `expect(running).toHaveBeenNthCalledWith(1, run.id)` and `expect(running).toHaveBeenNthCalledWith(2, run.id)` to lock in both call sites use the runId.
   - Rename the test from "fires when source emits output event" to "fires twice: once on pre_spawn and once when source emits output event" to make the contract explicit (the IDEA listed the prior title; preserve searchability by leaving the original substring intact in the new title).

4. **Fix `source absent: bridgeEvents short-circuits; running() is not called`** (test file lines 820-848):
   - The test asserts `expect(running).not.toHaveBeenCalled()`. With the new pre_spawn behavior, `running()` IS called once (by pre_spawn) even when source is absent — the bridge does not fire the second call.
   - Change to `expect(running).toHaveBeenCalledTimes(1)` and add `expect(running).toHaveBeenCalledWith(run.id)`.
   - Rename the test from "running() is not called" to "running() fires once via pre_spawn only — bridgeEvents short-circuits". Preserve "source absent: bridgeEvents short-circuits" substring at the start so existing greps still hit it.

5. **Fix `bridge drops output event when panelId has run- prefix (old broken behaviour)`** (test file lines 1232-1289):
   - The test asserts `expect(running).not.toHaveBeenCalled()` at line 1284. With pre_spawn now firing, `running()` is called once.
   - Change `expect(running).not.toHaveBeenCalled()` to `expect(running).toHaveBeenCalledTimes(1)` and add comment: "// pre_spawn fires running() once; the bridge correctly drops the prefixed-panelId event so no SECOND call happens."
   - Keep `expect(cnt).toBe(0)` (line 1288) unchanged — the core invariant under test is that the bridge does not persist a raw_events row for a mismatched panelId. That invariant is unchanged.

6. **Run the test file in isolation** to confirm all 4 cases pass:
   ```bash
   pnpm --filter @cyboflow/main test -- runExecutor.test.ts
   ```
   Expected: exit 0, no failures.

7. **Run the full main workspace test suite** to confirm no other test depends on the old assertion shape:
   ```bash
   pnpm --filter @cyboflow/main test
   ```

## Acceptance Criteria

See frontmatter. All 4 named cases pass, no regression in the rest of the file, and the bridge-drop test still asserts `countRawEvents === 0`.

## Test Strategy

This task updates 4 existing test cases in `main/src/orchestrator/__tests__/runExecutor.test.ts`. No new test files are required. Each updated case must still cover its original behavior intent (lifecycle routing, source-arg wiring, source-absent short-circuit, prefix-panelId drop) but with assertions that match the post-715b6c9 production contract.

## Hardest Decision

**Whether to keep or remove the `'sdk_initialized'` defensive arm in onLifecycleTransition.** The code at runExecutor.ts:398-404 explicitly fires `running()` a second time as a defensive idempotency measure (the comment notes test subclasses might override `bridgeEvents` and skip `pre_spawn`). Removing the second call would simplify the test fix to "running() called exactly once" everywhere — but it would weaken production resilience for cases where a future executor subclass overrides `bridgeEvents` without calling super. Chosen approach: keep production behavior unchanged, update the tests to assert the doubled-call shape. This preserves the defensive contract that the production engineer (in 715b6c9) explicitly chose to encode with a comment.

## Rejected Alternatives

- **Remove the defensive `'sdk_initialized'` running() call from runExecutor.ts:404.** Rejected because it loses a deliberate idempotency safeguard documented in the source. Would change if a follow-up sprint determines the defensive arm masks real ordering bugs (no evidence today).
- **Skip the test fix and mark the 4 cases as `.skip()`.** Rejected because they encode real invariants (lifecycle phase routing, panelId filter) that a test failure would normally catch. Skipping leaves us blind to regressions of those invariants.
- **Convert the lifecycle-routing test to use a fresh executor for each phase call.** Rejected because the test's value is in walking the same executor through multiple phases and checking the cumulative spy state — a stronger contract than per-phase isolation.

## Lowest Confidence Area

The "source arg" integration test's exact call count (2 vs some other number). If the test setup somehow short-circuits `pre_spawn` (e.g. the `LifecycleTestExecutor` subclass overrides `execute`), the assertion `toHaveBeenCalledTimes(2)` could be wrong. The mitigation is to run the test once locally before final assertion — if the count is 1, the explanation is that `pre_spawn`'s `running()` was suppressed by an injection seam I missed; in that case adjust to `toHaveBeenCalledTimes(1)` and add a comment explaining why pre_spawn was bypassed.
