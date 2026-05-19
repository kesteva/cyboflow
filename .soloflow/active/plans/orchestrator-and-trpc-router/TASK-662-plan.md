---
id: TASK-662
idea: IDEA-018
status: ready
created: "2026-05-19T00:00:00Z"
files_owned:
  - main/src/orchestrator/runExecutor.ts
  - main/src/orchestrator/runEventBridge.ts
  - main/src/orchestrator/__tests__/runExecutor.test.ts
  - main/src/orchestrator/__tests__/runEventBridge.test.ts
  - main/src/index.ts
files_readonly:
  - main/src/services/cyboflow/transitions.ts
  - main/src/orchestrator/__tests__/runLifecycle.test.ts
  - .soloflow/active/plans/orchestrator-and-trpc-router/TASK-650-plan.md
  - .soloflow/active/plans/orchestrator-and-trpc-router/TASK-661-plan.md
  - .soloflow/archive/done/orchestrator-and-trpc-router/TASK-644-done.md
acceptance_criteria:
  - criterion: "runEventBridge.ts adds an optional `onFirstMessage?: (firstTyped: ClaudeStreamEvent) => void` field to `BridgeEventsOptions`. The callback fires exactly once per bridge instance — on the first 'output' event whose narrowing succeeds — and is wrapped in try/catch (fail-soft: a throwing callback logs at warn level and does not affect the rest of the bridge pipeline)."
    verification: "grep -nE 'onFirstMessage\\?: \\(' main/src/orchestrator/runEventBridge.ts shows one match in BridgeEventsOptions; grep -nE 'firstMessageFired|onFirstMessage' main/src/orchestrator/runEventBridge.ts returns at least 3 matches (declaration, single-shot guard, invocation); a new unit test asserts the callback fires once across 3 output events; a second new test asserts a throwing callback does not break subsequent INSERT/publish for the same event."
  - criterion: "RunExecutor accepts a new injected `lifecycleTransitions: LifecycleTransitionsLike` collaborator. The Like interface declares four methods: `running(runId)`, `completed(runId, fromStatus)`, `failed(runId, fromStatus, errorMessage)`, `canceled(runId)`. Each is synchronous-or-async; calls are awaited and any thrown TransitionRejectedError is logged at warn (do NOT escalate — the transition guard race is expected, e.g. user cancels mid-iter)."
    verification: "grep -nE 'LifecycleTransitionsLike|interface LifecycleTransitionsLike' main/src/orchestrator/runExecutor.ts returns at least 2 matches; grep -nE 'this\\.lifecycleTransitions\\.(running|completed|failed|canceled)' main/src/orchestrator/runExecutor.ts returns at least 4 matches across onLifecycleTransition and execute()'s try/finally."
  - criterion: "RunExecutor.onLifecycleTransition default implementation maps phase → transition: `'sdk_initialized'` calls `lifecycleTransitions.running(runId)`; `'completed'` calls `lifecycleTransitions.completed(runId, 'running')`; `'failed'` calls `lifecycleTransitions.failed(runId, fromStatus, errorMessage)` where fromStatus is tracked on a private map and defaults to 'running'; `'canceled'` calls `lifecycleTransitions.canceled(runId)`. `'pre_spawn'` and `'post_spawn'` remain no-ops."
    verification: "grep -nE \"case 'sdk_initialized'|case 'completed'|case 'failed'|case 'canceled'\" main/src/orchestrator/runExecutor.ts returns at least 4 matches inside onLifecycleTransition; a new unit test 'onLifecycleTransition routes each phase to the right transition helper' passes."
  - criterion: "RunExecutor's bridgeEvents default implementation (added by TASK-650 step 8) is extended to pass `onFirstMessage: () => this.onLifecycleTransition(runId, 'sdk_initialized')` into the bridgeEvents call. This is the wire that converts the first SDK message into a workflow_runs 'running' status."
    verification: "grep -nE 'onFirstMessage:\\s*\\(\\)\\s*=>\\s*this\\.onLifecycleTransition\\(runId,\\s*[\\\\\"\\']sdk_initialized[\\\\\"\\']\\)' main/src/orchestrator/runExecutor.ts returns at least 1 match; a new test asserts bridgeEvents is called with onFirstMessage set."
  - criterion: "RunExecutor.execute() wraps the SDK iterator drain (post `await this.spawner.spawnCliProcess(...)`) in try/finally — TASK-650 step 6 already adds this for teardownRun. THIS task additionally: (a) on normal completion fires `onLifecycleTransition(runId, 'completed')`; (b) in the catch arm fires `onLifecycleTransition(runId, 'failed')` and passes the error message via a private `pendingFailedMessage` map (set in catch before the phase fire). The cancel path is owned by cancelHandler per TASK-644 and is NOT duplicated here."
    verification: "grep -nE \"onLifecycleTransition\\(runId,\\s*[\\\\\"\\']completed[\\\\\"\\']\\)|onLifecycleTransition\\(runId,\\s*[\\\\\"\\']failed[\\\\\"\\']\\)\" main/src/orchestrator/runExecutor.ts returns at least 2 matches; a new unit test 'execute() fires completed phase on normal terminate' passes; a second test 'execute() fires failed phase with error message on throw' passes."
  - criterion: "main/src/index.ts (or its RunExecutor construction site) instantiates a `LifecycleTransitions` adapter — a 4-method object that delegates to the existing `transitionToRunning`, `transitionToCompleted`, `transitionToFailed`, `transitionToCanceled` from `main/src/services/cyboflow/transitions.ts`. The adapter is the boundary that keeps `runExecutor.ts` free of `main/src/services/*` imports."
    verification: "grep -rnE 'transitionToRunning|transitionToCompleted|transitionToFailed|transitionToCanceled' main/src/index.ts shows the import + adapter (at least 4 matches); grep -nE \"from .*services/cyboflow/transitions\" main/src/orchestrator/runExecutor.ts returns ZERO matches (invariant preserved)."
  - criterion: "Five new unit tests in runEventBridge.test.ts: (i) 'onFirstMessage fires exactly once across multiple output events', (ii) 'onFirstMessage does not fire when no JSON output arrives', (iii) 'onFirstMessage is fail-soft — throws are caught and logged', (iv) 'onFirstMessage fires AFTER the first INSERT + publish complete' (ordering guard so the running transition can't race ahead of event delivery), (v) 'onFirstMessage callback receives the typed first event'."
    verification: "grep -nE 'onFirstMessage fires exactly once|onFirstMessage does not fire|onFirstMessage is fail-soft|onFirstMessage fires AFTER|onFirstMessage callback receives' main/src/orchestrator/__tests__/runEventBridge.test.ts returns at least 5 matches; pnpm --filter cyboflow-main test -- runEventBridge exits 0."
  - criterion: "Three new unit tests in runExecutor.test.ts: (i) 'onLifecycleTransition routes each phase to the right transition helper', (ii) 'execute() fires completed phase on normal terminate' (mock spawner resolves; assert lifecycleTransitions.completed was called with fromStatus='running'), (iii) 'execute() fires failed phase with error message on spawner reject' (mock spawner rejects; assert lifecycleTransitions.failed was called with the error message)."
    verification: "grep -nE 'onLifecycleTransition routes each phase|execute\\(\\) fires completed phase|execute\\(\\) fires failed phase' main/src/orchestrator/__tests__/runExecutor.test.ts returns at least 3 matches; pnpm --filter cyboflow-main test -- runExecutor exits 0."
  - criterion: "End-to-end manual smoke: with `pnpm dev`, click Start Run on the seeded 'prune' workflow. Confirm in `cyboflow-backend-debug.log` that workflow_runs status transitions starting → running (on first SDK message) → completed (on iterator terminate) OR → failed (on error). Recorded as a checkpoint comment in the executor's done report."
    verification: "Manual smoke — not grep-gated. The executor includes a log excerpt in the done report showing the three (or two) UPDATE workflow_runs lines with status='running' and status='completed'|'failed'."
  - criterion: "Project-wide typecheck and lint pass; existing runEventBridge.test.ts (9 cases) and runExecutor.test.ts (existing N + TASK-650's + TASK-661's new cases) all stay green."
    verification: "pnpm typecheck && pnpm lint exit 0; pnpm --filter cyboflow-main test exits 0 with the new + existing case counts visible."
depends_on:
  - TASK-650
  - TASK-661
estimated_complexity: medium
epic: orchestrator-and-trpc-router
test_strategy:
  needed: true
  justification: "This task lights up the actual user-visible workflow lifecycle. Wrong wiring fails silently: status stays at 'starting' forever, OR transitions fire too early/late, OR errors are silently swallowed. Eight new unit tests pin the phase routing (3 in runExecutor), the first-message single-shot semantics (5 in runEventBridge), and the failed-path error propagation. Manual smoke is required because the SDK→DB→UI loop is only fully exercised under `pnpm dev`."
  targets:
    - behavior: "onFirstMessage fires exactly once on the first JSON output event with the typed payload"
      test_file: main/src/orchestrator/__tests__/runEventBridge.test.ts
      type: unit
    - behavior: "onFirstMessage is fail-soft — a throwing callback does not break subsequent INSERT/publish"
      test_file: main/src/orchestrator/__tests__/runEventBridge.test.ts
      type: unit
    - behavior: "onFirstMessage fires AFTER the first INSERT + publish so the running transition cannot race ahead of event delivery"
      test_file: main/src/orchestrator/__tests__/runEventBridge.test.ts
      type: unit
    - behavior: "onLifecycleTransition default routes each phase to the matching LifecycleTransitionsLike method"
      test_file: main/src/orchestrator/__tests__/runExecutor.test.ts
      type: unit
    - behavior: "execute() fires 'completed' phase on normal iterator terminate; lifecycleTransitions.completed called with fromStatus='running'"
      test_file: main/src/orchestrator/__tests__/runExecutor.test.ts
      type: unit
    - behavior: "execute() fires 'failed' phase on spawner reject; lifecycleTransitions.failed receives the original error message"
      test_file: main/src/orchestrator/__tests__/runExecutor.test.ts
      type: unit
---

# Light up workflow_runs lifecycle — wire onLifecycleTransition → transitionTo* and the first-message signal

## Objective

After TASK-650, RunExecutor has the right vocabulary (`ExecutionPhase` widened to `'pre_spawn' | 'post_spawn' | 'sdk_initialized' | 'completed' | 'failed' | 'canceled'`) but the **default `onLifecycleTransition` is still a no-op** (`main/src/orchestrator/runExecutor.ts:186-188`). The four `transitionTo*` helpers in `main/src/services/cyboflow/transitions.ts:83-220` (added by TASK-644, done) are correct, guarded, and tested — but nothing calls them. Result: `workflow_runs.status` stays at `'starting'` forever; the RunView never sees the run flip to `'running'`, `'completed'`, or `'failed'`.

Adjacent gap: the SDK's `system/init` message is the natural signal that the model has been initialized and the run is genuinely *executing* — not just queued for execution. `runEventBridge.ts` listens to `source.on('output')` and narrows JSON events, but it does NOT surface a `sdk_initialized` signal back to RunExecutor. Without that signal, there's no event to drive the `'starting' → 'running'` transition.

This task closes both:

1. **runEventBridge gets an `onFirstMessage?: (typed) => void` option.** Single-shot per bridge instance, fires AFTER the first INSERT + publish complete (ordering matters — the running transition must not race ahead of event delivery), fail-soft (a throwing callback is logged and ignored).

2. **RunExecutor overrides `onLifecycleTransition`** to route the phases to a new injected `LifecycleTransitionsLike` collaborator. The Like interface keeps the standalone-typecheck invariant; the concrete adapter in `main/src/index.ts` delegates to the existing `transitionTo*` helpers.

3. **RunExecutor's bridgeEvents default (added by TASK-650 step 8) passes `onFirstMessage: () => this.onLifecycleTransition(runId, 'sdk_initialized')`** into the bridgeEvents call. That's the wire that converts the first SDK message into a `workflow_runs.status = 'running'` UPDATE.

4. **RunExecutor's execute() try/finally (added by TASK-650 step 6)** fires `'completed'` on normal terminate and `'failed'` (with error message) in the catch arm. The cancel path is owned by `cancelHandler` per TASK-644 and is NOT duplicated here.

## Implementation Steps

1. **Extend `runEventBridge.ts:BridgeEventsOptions`** with `onFirstMessage?: (firstTyped: ClaudeStreamEvent) => void`.

2. **Add the single-shot signal.** In the `onOutput` handler (around `runEventBridge.ts:128`):
   - After the narrowing succeeds AND after `router.emitForRun(runId, typed)` AND `publisher.publish(runId, envelope)` both complete, check a per-bridge `let firstMessageFired = false` flag.
   - If `!firstMessageFired && opts.onFirstMessage`, set the flag to `true`, then wrap `opts.onFirstMessage(typed)` in try/catch. On throw, log at warn via `logger?.warn('[runEventBridge] onFirstMessage threw', { ... })` and continue.
   - The "fires AFTER INSERT/publish" ordering is the key guarantee — if we fired before publish, the renderer could see a "running" transition before any event, breaking the UI's mental model.

3. **Add `LifecycleTransitionsLike` to runExecutor.ts.** A 4-method narrow interface:
   ```ts
   export interface LifecycleTransitionsLike {
     running(runId: string): void;
     completed(runId: string, fromStatus: 'running'): void;
     failed(runId: string, fromStatus: 'starting' | 'running' | 'awaiting_review' | 'stuck', errorMessage: string): void;
     canceled(runId: string): void;
   }
   ```
   Synchronous (matches the existing transitions API).

4. **Extend RunExecutor's constructor** to accept `lifecycleTransitions: LifecycleTransitionsLike` as the 5th arg (after promptReader from TASK-661). Store on `this.lifecycleTransitions`.

5. **Override `onLifecycleTransition`.** Replace the no-op body with a `switch (phase)`:
   - `'sdk_initialized'` → `try { this.lifecycleTransitions.running(runId); } catch (err) { /* expected race when cancel happens between system/init and the next tick */ this.logger.warn('[RunExecutor] running transition rejected', { runId, error: err... }); }`
   - `'completed'` → wrap `this.lifecycleTransitions.completed(runId, 'running')` in the same try/catch.
   - `'failed'` → `this.lifecycleTransitions.failed(runId, this.pendingFailedFromStatus.get(runId) ?? 'running', this.pendingFailedMessage.get(runId) ?? 'unknown error')`. Same try/catch.
   - `'canceled'` → `this.lifecycleTransitions.canceled(runId)`. Same try/catch.
   - `'pre_spawn'` / `'post_spawn'` → return immediately (no-op).
   
   The `pendingFailedMessage` (and optional `pendingFailedFromStatus`) maps are populated by execute()'s catch arm before firing the `'failed'` phase. Clear them in `teardownRun`.

6. **Extend bridgeEvents default in execute().** TASK-650 step 8 adds a default bridgeEvents that calls `bridgeEvents({ runId, source, publisher, db, logger })`. Extend the options literal:
   ```ts
   bridgeEvents({
     runId,
     source: this.spawner as unknown as EventEmitter,
     publisher: this.publisher,
     db: this.db,
     logger: this.logger,
     onFirstMessage: () => this.onLifecycleTransition(runId, 'sdk_initialized'),
   });
   ```

7. **Extend execute()'s try/finally.** TASK-650 step 6 already wraps the SDK iterator drain in try/finally for teardownRun. Add to the same try block (or replace it):
   ```ts
   try {
     // ... existing spawner.spawnCliProcess + drain
     await this.onLifecycleTransition(runId, 'completed');
   } catch (err) {
     const message = err instanceof Error ? err.message : String(err);
     this.pendingFailedMessage.set(runId, message);
     await this.onLifecycleTransition(runId, 'failed');
     throw err;  // preserve existing error-bubble contract (the caller's catch in runLauncher.ts logs it)
   } finally {
     this.teardownRun(runId);  // already there from TASK-650
   }
   ```

8. **Wire the concrete adapter in main/src/index.ts.** Where TASK-650 step 10 / TASK-661 step 9 construct RunExecutor:
   ```ts
   import {
     transitionToRunning,
     transitionToCompleted,
     transitionToFailed,
     transitionToCanceled,
   } from './services/cyboflow/transitions';
   
   const lifecycleTransitions: LifecycleTransitionsLike = {
     running: (runId) => transitionToRunning(db, { runId }),
     completed: (runId, fromStatus) => transitionToCompleted(db, { runId, fromStatus }),
     failed: (runId, fromStatus, errorMessage) =>
       transitionToFailed(db, { runId, fromStatus, errorMessage }),
     canceled: (runId) => transitionToCanceled(db, { runId }),
   };
   ```
   Pass `lifecycleTransitions` to the RunExecutor constructor.

9. **Add the new unit tests** per `test_strategy.targets`. The runEventBridge tests extend the existing 9-case file — add the 5 onFirstMessage cases via a new `describe('onFirstMessage', ...)`. The runExecutor tests add 3 cases under a new `describe('lifecycle transitions', ...)`.

10. **Manual smoke** under `pnpm dev`:
    - Start Run on the seeded "prune" workflow.
    - Watch `cyboflow-backend-debug.log` (use the read-only-via-subagent CLAUDE.md pattern):
      - Confirm `UPDATE workflow_runs SET status = 'running'` fires shortly after Start Run.
      - Confirm `UPDATE workflow_runs SET status = 'completed'` (or `'failed'`) fires at end.
    - Confirm the RunView (frontend) reflects each status flip in real time.

11. **Verify locally**: `pnpm typecheck && pnpm lint && pnpm --filter cyboflow-main test`.

## Acceptance Criteria

See `acceptance_criteria` in frontmatter. Each is grep-checkable or test-runnable. The manual smoke criterion is the only one not gated by grep — it's the end-to-end gate for IDEA-018 closing.

## Test Strategy

See `test_strategy.targets`. The bridge-side ordering test (onFirstMessage fires AFTER INSERT/publish) is the most important behavioral guard — it catches the "running transition raced ahead of any event" failure mode that would otherwise only surface as a flaky UI state under `pnpm dev`.

## Hardest Decision

Whether to fire `'completed'` from inside execute() or rely on the SDK iterator's natural terminate event. The SDK emits a `result` message that signals end-of-conversation, which could in principle drive the completion transition. Two options:

- **(A) Fire `'completed'` from execute() post-drain.** Single source of truth; no race between iterator-terminate and a separate result-listener. This plan picks this.
- **(B) Have bridgeEvents fire an `onComplete?: () => void` callback when the `result` message arrives.** Cleaner separation but adds two surfaces that must agree on terminate semantics.

Recommendation: **A**. The SDK's iterator-as-async-iterable surface is already the natural completion signal; bolting a second result-listener on bridgeEvents duplicates the contract. The `result` message still flows through bridgeEvents' INSERT/publish path — it just doesn't separately drive lifecycle.

## Rejected Alternatives

- **Inline the transition helpers directly in runExecutor.ts.** Rejected — would violate the standalone-typecheck invariant by importing from `main/src/services/*`. The Like interface + adapter pattern is the project's established workaround (TASK-644 follows it for cancelHandler).
- **Fire `'sdk_initialized'` from RunExecutor.execute() right after `spawnCliProcess` resolves, instead of going through bridgeEvents' onFirstMessage.** Rejected — `spawnCliProcess` resolves when the SDK query() promise resolves, which can be BEFORE the first message lands (the SDK initializes the conversation in the background). Firing 'running' at that point is premature; the user-visible signal "Claude has started executing" is the first message, not the spawn resolution.
- **Merge this task with TASK-661.** Rejected — semantically distinct surfaces (prompt construction vs lifecycle wiring) and combining them produces a task too large to verify in one executor pass. Sequential dep chain is the right shape.

## Lowest Confidence Area

The exact placement of step 7 inside execute()'s try/finally — depends on what TASK-650's step 6 looks like when it lands. The plan as written assumes TASK-650 puts the iterator drain inside the try block (so a throw during drain hits the catch arm). If TASK-650 instead awaits the drain OUTSIDE the try (e.g. uses a separate try just for teardownRun), the 'failed' phase wiring needs to land in a different place. Mitigation: read the TASK-650 done report's execute() body before starting; adjust step 7 to match.

## Dependencies

Depends on **TASK-650** (which adds the ExecutionPhase widening, bridgeEvents default, try/finally teardownRun, and the RunExecutor construction in index.ts) and **TASK-661** (which adds the promptReader constructor argument that this task extends). Trying to land in parallel would produce guaranteed merge conflicts on `runExecutor.ts`.
