---
id: TASK-596
idea: IDEA-014
status: in-flight
created: "2026-05-14T00:00:00Z"
files_owned:
  - main/src/services/panels/claude/claudeCodeManager.ts
  - main/src/services/panels/claude/__tests__/claudeCodeManager.killProcess.test.ts
files_readonly:
  - main/src/services/panels/cli/AbstractCliManager.ts
  - main/src/services/streamParser/index.ts
  - main/src/orchestrator/approvalRouter.ts
  - .soloflow/active/findings/SPRINT-008-findings.md
  - .soloflow/archive/done/claude-agent-sdk-migration/TASK-590-done.md
acceptance_criteria:
  - criterion: "killProcess no longer calls cleanupPipeline directly — pipeline disposal is owned solely by runSdkQuery's finally block."
    verification: "grep -n 'cleanupPipeline' main/src/services/panels/claude/claudeCodeManager.ts shows exactly TWO matches: the declaration at line ~464 and the call inside runSdkQuery's finally block (~line 311). The match inside killProcess MUST be gone."
  - criterion: "killProcess body, after the change, is: (1) await abortCurrentRun(panelId), (2) processes.delete(panelId). No cleanupPipeline call, no other state mutations."
    verification: Open main/src/services/panels/claude/claudeCodeManager.ts and visually confirm the override killProcess method body matches the spec above; reviewer signs off.
  - criterion: "A code comment inside killProcess explicitly explains the deliberate ordering: abort first so the SDK iterator's finally runs cleanupPipeline before any tail events are lost, and so that pipeline disposal is single-sourced."
    verification: "grep -n 'single-sourced\\|tail events\\|deliberate ordering' main/src/services/panels/claude/claudeCodeManager.ts returns at least one match inside the killProcess method."
  - criterion: "New unit test claudeCodeManager.killProcess.test.ts proves that killProcess() leaves pipelines, sdkRuns, and processes maps empty after returning."
    verification: "cd main && pnpm vitest run src/services/panels/claude/__tests__/claudeCodeManager.killProcess.test.ts exits 0 with the new test cases passing."
  - criterion: pnpm typecheck and pnpm lint are green for the main workspace.
    verification: "cd main && pnpm typecheck && pnpm lint both exit 0."
depends_on: []
estimated_complexity: low
epic: claude-agent-sdk-migration
test_strategy:
  needed: true
  justification: killProcess is on the hot path for continuePanel / restartPanelWithHistory and the failure mode (silent event-loss on kill-mid-stream) is non-observable from the UI. A unit test guards the ordering invariant.
  targets:
    - behavior: "killProcess on a running panel leaves pipelines, sdkRuns, and processes maps empty after returning."
      test_file: main/src/services/panels/claude/__tests__/claudeCodeManager.killProcess.test.ts
      type: unit
    - behavior: "killProcess on a panel with no active run is a no-op (idempotent — abortCurrentRun early-returns when sdkRuns has no entry, processes.delete is a no-op when key absent)."
      test_file: main/src/services/panels/claude/__tests__/claudeCodeManager.killProcess.test.ts
      type: unit
---
# Audit killProcess cleanup ordering to prevent raw_events loss on kill-mid-stream

## Objective

Remove the redundant `cleanupPipeline(panelId)` call from `killProcess()` so that pipeline disposal is single-sourced through `runSdkQuery`'s `finally` block. The current ordering (cleanupPipeline → abortCurrentRun) creates a window in which the SDK async iterator can push events to `router.emitForRun(runId, event)` after the `RawEventsSink` listener has been disposed, silently dropping `raw_events` rows. The pre-SDK PTY substrate did not have this race because OS-level kill was synchronous. The fix is to delete the redundant call (option b from the source-finding) and rely on `runSdkQuery`'s `finally` block — `iteratorDone` only resolves after the `finally` runs, so `abortCurrentRun` waiting on `iteratorDone` is sufficient to guarantee cleanup before `killProcess` returns.

## Implementation Steps

1. Confirm the current ordering by reading `main/src/services/panels/claude/claudeCodeManager.ts` lines 443-447 (`killProcess`) and lines 265-324 (`runSdkQuery`'s try/finally) and lines 452-458 (`abortCurrentRun`). Verify mentally that `iteratorDone` is the promise wrapping `runSdkQuery`'s entire execution including its `finally`; `await run.iteratorDone.catch(() => {})` in `abortCurrentRun` therefore waits until the `finally` block has run `this.cleanupPipeline(panelId)`, `ApprovalRouter.getInstance().clearPendingForRun(panelId)`, `this.processes.delete(panelId)`, `this.sdkRuns.delete(panelId)`, and emitted `exit`. The redundant `cleanupPipeline` call in `killProcess` is therefore both racy AND a no-op once the abort completes.
2. Edit `killProcess` (currently at `main/src/services/panels/claude/claudeCodeManager.ts:443-447`). New body:
   ```ts
   override async killProcess(panelId: string): Promise<void> {
     // Deliberate ordering: await abortCurrentRun first so the SDK iterator's
     // finally block runs cleanupPipeline / clearPendingForRun / processes.delete
     // BEFORE we return. Calling cleanupPipeline here directly would dispose the
     // RawEventsSink listener while the iterator is still pushing tail events,
     // silently dropping raw_events rows — pipeline disposal is single-sourced
     // through runSdkQuery's finally to eliminate that race.
     await this.abortCurrentRun(panelId);
     this.processes.delete(panelId);
   }
   ```
   Note: `processes.delete(panelId)` is retained as a defensive idempotent call — `runSdkQuery`'s `finally` also does this, but `killProcess` may be called on a panel whose `runSdkQuery` never started (e.g., spawn threw before `runSdkQuery` was invoked, in which case `sdkRuns` has no entry, `abortCurrentRun` early-returns, and we still want `processes` cleared).
3. Create `main/src/services/panels/claude/__tests__/claudeCodeManager.killProcess.test.ts` with the test strategy below. Use the same vitest pattern as `main/src/orchestrator/__tests__/approvalRouter.test.ts`. Mock `@anthropic-ai/claude-agent-sdk` `query()` to return an async iterable that yields one `system/init` event then waits indefinitely on a deferred promise — so the test can call `killProcess` mid-stream and assert post-conditions on the manager's private maps via small `as unknown as { pipelines: Map<...>; sdkRuns: Map<...>; processes: Map<...> }` casts.
4. Run `cd main && pnpm vitest run src/services/panels/claude/__tests__/claudeCodeManager.killProcess.test.ts` — confirm green.
5. Run `cd main && pnpm typecheck && pnpm lint` — confirm green.

## Acceptance Criteria

Re-stated from frontmatter — each is objectively verifiable:

1. `cleanupPipeline` is invoked exactly once per run (from `runSdkQuery`'s `finally`); grep confirms no direct call in `killProcess`.
2. `killProcess` body is the two-line abort + processes.delete sequence.
3. A code comment inside `killProcess` documents the ordering rationale.
4. New vitest file passes; covers both "kill mid-stream" and "kill with no active run" cases.
5. `pnpm typecheck` and `pnpm lint` are green.

## Test Strategy

Create `main/src/services/panels/claude/__tests__/claudeCodeManager.killProcess.test.ts` with two test cases:

**Case 1: killProcess mid-stream leaves all maps empty.** Instantiate `ClaudeCodeManager` with a mock `SessionManager` and a stubbed shared db (sufficient to instantiate `RawEventsSink`). Mock the SDK `query()` to return an async iterable that yields one `system/init` event then awaits a deferred promise (never resolves on its own). Call `spawnClaudeCode(...)`. Wait one tick. Assert `pipelines`, `sdkRuns`, `processes` each have 1 entry. Call `killProcess(panelId)`. Assert all three maps have 0 entries. Assert `ApprovalRouter.getInstance().clearPendingForRun` was called once with `panelId` (use vitest spy on the singleton).

**Case 2: killProcess on a panel with no active run is idempotent.** Instantiate the manager without spawning. Call `killProcess('nonexistent-panel-id')`. Expect no throw, no error event, all maps still empty.

Mocking notes:
- Use `vi.mock('@anthropic-ai/claude-agent-sdk', ...)` at the top of the test file to replace `query` with the controllable async iterable factory.
- The `RawEventsSink` and `EventRouter` are pulled in via `main/src/services/streamParser/index.ts` — pass a real in-memory `better-sqlite3` via `ClaudeCodeManager.setSharedDb(...)` to keep the sink alive, matching `approvalRouter.test.ts`'s pattern of using a real in-memory DB.

No new mocks needed for `ApprovalRouter` — use `ApprovalRouter._resetForTesting()` then `ApprovalRouter.initialize(dbAdapter, queueFactory)` per existing test fixture pattern.

## Hardest Decision

**Removing the call versus reordering.** The source-finding offered two options: (a) reorder — abort first, then cleanup; (b) delete the redundant cleanup. I chose (b) because the `finally` block in `runSdkQuery` already runs `cleanupPipeline(panelId)` and `iteratorDone` resolves only after that `finally` has run (an async function's returned promise resolves AFTER `finally` executes). Therefore the cleanupPipeline call in `killProcess` is strictly redundant once the abort completes — keeping it as a "belt and suspenders" call only creates ambiguity about ownership of pipeline disposal. Single-sourcing the disposal makes the invariant easier to reason about and easier to extend (future cleanup steps that belong on every run termination land in `runSdkQuery`'s `finally`, not in two places).

## Rejected Alternatives

**Reorder instead of delete (option a).** Would also fix the race but leaves a redundant call that future readers would assume is load-bearing. Would change my mind if there were a scenario where `runSdkQuery` could exit without running its `finally` — e.g., a synchronous throw before the try block. Read of the code shows the `try` block immediately wraps the `query()` call so any throw lands in the `catch`/`finally` pair; no path exists where `runSdkQuery` exits without running `finally`. Rejected.

**Add explicit awaiting of pipeline disposal in killProcess (e.g., a `disposalDone` promise on the pipeline tuple).** Over-engineered for a clearly-defined async function whose returned promise already encodes "everything in this function has completed including finally". Rejected.

## Lowest Confidence Area

The vitest mock for the SDK's async iterator. The current code at `claudeCodeManager.ts:276-299` uses `for await (const event of q)`; mocking `query()` to return an object that satisfies that loop (i.e., an iterable that exposes `[Symbol.asyncIterator]`) without accidentally hitting other SDK type surfaces (the `query()` return type is `Query` in `@anthropic-ai/claude-agent-sdk`, which extends `AsyncIterable<SDKMessage>`) may require a small type cast inside the test. If the cast turns out to be problematic, fall back to using `vi.mocked(query).mockImplementation(...)` after `vi.mock('@anthropic-ai/claude-agent-sdk')` rather than a hand-rolled object.
