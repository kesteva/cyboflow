---
id: TASK-650
idea: IDEA-018
status: in-flight
created: "2026-05-18T17:45:00Z"
files_owned:
  - main/src/orchestrator/runExecutor.ts
  - main/src/orchestrator/runEventBridge.ts
  - main/src/orchestrator/permissionModeMapper.ts
  - main/src/orchestrator/trpc/routers/runs.ts
  - main/src/orchestrator/runLauncher.ts
  - main/src/orchestrator/__tests__/runExecutor.test.ts
files_readonly:
  - main/src/services/panels/claude/claudeCodeManager.ts
  - main/src/orchestrator/cancelAndRestartHandler.ts
  - main/src/orchestrator/__tests__/runLifecycle.test.ts
  - main/src/orchestrator/__tests__/runLauncher.test.ts
  - main/src/orchestrator/__tests__/runEventBridge.test.ts
  - main/src/orchestrator/__tests__/permissionModeMapper.test.ts
  - main/src/orchestrator/RunQueueRegistry.ts
  - main/src/orchestrator/approvalRouter.ts
  - main/src/orchestrator/workflowPromptReader.ts
  - shared/types/workflows.ts
  - shared/types/cyboflow.ts
acceptance_criteria:
  - criterion: "RunExecutor exposes a public async `cancel(): Promise<void>` that aborts the in-flight SDK spawn via the injected ClaudeSpawnerLike, and ClaudeSpawnerLike declares an `abort(panelId: string): Promise<void>` method."
    verification: "grep -nE 'async cancel\\(\\): Promise<void>' main/src/orchestrator/runExecutor.ts shows the public method; grep -nE 'abort\\(panelId' main/src/orchestrator/runExecutor.ts shows the interface; pnpm --filter cyboflow-main test -- runExecutor"
  - criterion: "ClaudeSpawnerOptions adds an optional `preToolUseHook?: HookCallback` field (imported as type from @anthropic-ai/claude-agent-sdk) and the stale `permissionMode?: 'approve' | 'ignore'` field is removed."
    verification: "grep -nE 'preToolUseHook\\?: HookCallback' main/src/orchestrator/runExecutor.ts shows one match; grep -n \"permissionMode\\?: 'approve' | 'ignore'\" main/src/orchestrator/runExecutor.ts returns zero matches."
  - criterion: "RunExecutor.bridgeEvents() return type is changed from `Promise<void>` to `Promise<RunEventBridge | void>` (or equivalent `Promise<{ dispose(): void } | void>`)."
    verification: "grep -nE 'bridgeEvents\\(.*\\): Promise<RunEventBridge \\| void>|Promise<\\{ dispose\\(\\): void \\} \\| void>' main/src/orchestrator/runExecutor.ts shows one match."
  - criterion: "RunExecutor stores per-run bridge handles in a private `Map<string, { dispose(): void }>` and calls `dispose()` from `cancel()` AND from a `teardownRun(runId)` helper invoked on terminal `onLifecycleTransition` phases."
    verification: "grep -nE 'private (readonly )?(?:bridges|disposers): Map<string, \\{ dispose' main/src/orchestrator/runExecutor.ts shows one match; new unit test asserts `dispose` runs on cancel() and on terminal transition."
  - criterion: "ExecutionPhase enum is widened (or replaced with a richer enum) to cover the workflow_runs lifecycle: pre_spawn | post_spawn | sdk_initialized | completed | failed | canceled. The default `onLifecycleTransition` remains a no-op; integration points override per phase."
    verification: "grep -nE \"type ExecutionPhase = .*'pre_spawn'|'post_spawn'|'sdk_initialized'|'completed'|'failed'|'canceled'\" main/src/orchestrator/runExecutor.ts shows the widened union (any 6+ literal members from that set)."
  - criterion: "buildOptionsOverrides default returns `{ preToolUseHook: buildPreToolUseHook(workflow.permission_mode as PermissionMode, runId, this.logger) }` when permission_mode is set, threading the mapper output into the spawn options."
    verification: "grep -nE 'buildPreToolUseHook' main/src/orchestrator/runExecutor.ts shows at least one match in the runExecutor source body (not just tests); a new unit test exercises the wired path."
  - criterion: "cyboflow.runs.cancel handler's `lookupExecutor` shape still resolves cleanly against the new RunExecutor surface; no signature mismatch between the structural type in runs.ts:63 and the new method."
    verification: pnpm --filter cyboflow-main typecheck passes (`tsc --noEmit` exit 0). The existing 29 runLifecycle.test.ts cases stay green unchanged.
  - criterion: "New / updated runExecutor.test.ts cases cover: (i) execute() returns even when `bridgeEvents` produces a real RunEventBridge (handle stored), (ii) cancel() calls spawner.abort with the synthetic panelId AND fires bridge.dispose(), (iii) terminal onLifecycleTransition fires bridge.dispose() via teardownRun, (iv) buildOptionsOverrides threads the preToolUseHook returned by buildPreToolUseHook. All four pass."
    verification: "pnpm --filter cyboflow-main test -- runExecutor shows >= 4 new vitest cases for the integration paths; full suite exit 0."
  - criterion: Project-wide typecheck and lint pass.
    verification: "pnpm typecheck && pnpm lint exit 0."
depends_on:
  - TASK-640
  - TASK-642
  - TASK-643
  - TASK-644
estimated_complexity: high
epic: orchestrator-and-trpc-router
test_strategy:
  needed: true
  justification: "Integration task that crosses four helper boundaries. Each gap has a sharp acceptance test (cancel-fires-dispose, preToolUseHook-is-threaded, ExecutionPhase-routes-to-transition). Without per-gap tests, regressions surface only in production end-to-end."
  targets:
    - behavior: "RunExecutor.cancel() invokes spawner.abort(panelId) with the synthetic 'run-${runId}' panelId derived during execute()."
      test_file: main/src/orchestrator/__tests__/runExecutor.test.ts
      type: unit
    - behavior: RunExecutor.cancel() calls bridge.dispose() exactly once for the active run; double-cancel is idempotent.
      test_file: main/src/orchestrator/__tests__/runExecutor.test.ts
      type: unit
    - behavior: "buildOptionsOverrides() returns { preToolUseHook: <result of buildPreToolUseHook> } when workflow.permission_mode is set."
      test_file: main/src/orchestrator/__tests__/runExecutor.test.ts
      type: unit
    - behavior: Terminal onLifecycleTransition phases (completed/failed/canceled) fire bridge.dispose() via teardownRun(runId).
      test_file: main/src/orchestrator/__tests__/runExecutor.test.ts
      type: unit
    - behavior: "End-to-end smoke: a single execute() call drives spawn → bridgeEvents → SDK iterator drain → terminal transition → dispose, all via the public surface (with stub spawner). No assertion changes to existing 9 tests; new test validates the wired path."
      test_file: main/src/orchestrator/__tests__/runExecutor.test.ts
      type: integration
---
# Integrate SPRINT-018 RunExecutor helpers — cancel surface + bridge handle + ExecutionPhase + preToolUseHook slot

## Objective

Resolve the four cross-helper contract gaps identified by SPRINT-018's sprint-code-reviewer (FIND-7/8/9/10) in a single coherent integration task. These four gaps are load-bearing on each other: cancel() needs the bridge handle to call dispose; the bridge handle needs a richer return type from bridgeEvents; ExecutionPhase needs to widen to support the cancel/dispose lifecycle; and the preToolUseHook slot is the conduit that closes the type-axis mismatch documented in runExecutor.ts:17-19.

## Implementation Steps

1. **Widen `ClaudeSpawnerLike`** in `main/src/orchestrator/runExecutor.ts`:
   - Add `abort(panelId: string): Promise<void>` method.
   - Replace `permissionMode?: 'approve' | 'ignore'` on `ClaudeSpawnerOptions` with `preToolUseHook?: HookCallback` (`import type { HookCallback } from '@anthropic-ai/claude-agent-sdk'`).
   - Confirm `ClaudeCodeManager.killProcess` or equivalent fits the `abort` shape; if not, add a thin `async abort(panelId)` wrapper inside ClaudeCodeManager that delegates to the existing kill path. The interface stays narrow.

2. **Add `RunExecutor.cancel()`**:
   - Store the synthetic `panelId` (e.g. `run-${runId}`) on a private `Map<string, string>` field during `execute()` so cancel can look it up.
   - Body: look up panelId; if present, `await this.spawner.abort(panelId)`. Then call `this.teardownRun(runId)`. Idempotent — double-cancel is a no-op.

3. **Change `bridgeEvents` return type** from `Promise<void>` to `Promise<RunEventBridge | void>`. Update the default no-op to return `void`. Inside `execute()`, capture the returned handle into a private `Map<string, RunEventBridge>` field.

4. **Add `private teardownRun(runId: string)`** that disposes the bridge from the per-run map, deletes the panelId entry, and is safe to call repeatedly.

5. **Widen `ExecutionPhase`** to `'pre_spawn' | 'post_spawn' | 'sdk_initialized' | 'completed' | 'failed' | 'canceled'`. Update the existing `onLifecycleTransition('spawning')` / `('spawned')` call sites to use `'pre_spawn'` / `'post_spawn'`. Add terminal-phase fires from `cancel()` (`'canceled'`) and `execute()`'s catch arm (`'failed'`); `'completed'` is fired by the integration override (or via a future event listener).

6. **Wire `teardownRun` into terminal phases**: in `execute()`, wrap the SDK iterator drain in try/finally and call `teardownRun(runId)` from the finally arm (covers both completed and failed paths). `cancel()` calls it directly.

7. **Update `buildOptionsOverrides`** default implementation: if `workflow.permission_mode` is present, call `buildPreToolUseHook(workflow.permission_mode as PermissionMode, runId, this.logger)` and return `{ preToolUseHook: <result> }`. Otherwise return `{}`.

8. **Drop `bridgeEvents` no-op** in favor of a default implementation that calls `bridgeEvents({ runId, source: this.spawner as unknown as EventEmitter, publisher: this.publisher, db: this.db, logger: this.logger })`. Wait — this requires `publisher` and `db` on RunExecutor's constructor. Decide ownership in step 9.

9. **Decide constructor surface**: either (a) add `publisher`, `db` to RunExecutor's constructor so the default `bridgeEvents` works, OR (b) keep `bridgeEvents` as a hook the integration layer overrides. Recommended: (a), since the existing wiring at TASK-642's plan documents bridgeEvents as a launch-time call, not an optional override. Add publisher/db to RunExecutorOptions constructor args.

10. **Wire `setCancelDeps` from main/src/index.ts**: pass a `lookupExecutor` function that reads from a new `RunExecutorRegistry` populated when RunLauncher.launch creates the executor. (The registry can live in runLauncher.ts as a module-level Map for v1; promote to a class only if it grows beyond ~30 LOC.)

11. **Add the four new unit tests** listed in `test_strategy.targets`.

12. **Verify locally**: `pnpm typecheck && pnpm lint && pnpm --filter cyboflow-main test`.

## Acceptance Criteria

Each criterion is independently grep-checkable or test-runnable. AC1 (cancel + abort signature), AC3 (bridgeEvents return type), AC4 (per-run handle map), AC5 (ExecutionPhase widening) all guard against the four sprint-code-reviewer findings re-surfacing. AC6 (preToolUseHook threading) and AC2 (slot exists) jointly close the type-axis mismatch documented at runExecutor.ts:17-19.

## Test Strategy

See `test_strategy.targets`. Four new vitest cases in `runExecutor.test.ts` exercising the wired cancel+dispose paths and the hook-threading path. Stub spawner now needs an `abort` method; the existing 10 cases stay green because the new optional fields default to undefined/no-op.

## Hardest Decision

Whether to keep `bridgeEvents` as a defaultable hook (with publisher/db on the constructor) OR keep it abstract and require integration overrides. Recommendation: defaultable. The publisher/db are already implicit dependencies of any real RunExecutor — making them constructor-required matches the integration reality and lets per-helper unit tests run without setting up override scaffolding.

## Rejected Alternatives

- **Build a separate `RunHandle { runId, cancel() }` wrapper** instead of widening RunExecutor — FIND-SPRINT-018-8 Option B. Rejected because the `cancelHandler` in runs.ts:63 expects the executor-shaped surface; a wrapper would force a second indirection and a second registry.
- **Keep ExecutionPhase narrow at `spawning|spawned|error`** and rely on the integration layer to invent a separate lifecycle vocabulary. Rejected — FIND-SPRINT-018-10 documents this as the silent-coupling failure mode.
- **Pass `preToolUseHook` outside `ClaudeSpawnerOptions`** (e.g. via a separate hooks bag). Rejected — the SDK API already groups hooks under spawn options; mirroring that shape keeps the adapter thin.
- **Defer the integration to a later sprint** without TASK-650. Rejected — the four findings will silently re-surface as cross-task contract leaks; consolidating them keeps the discovery-to-fix loop within one plan.

## Lowest Confidence Area

The exact `ClaudeCodeManager.killProcess` / `stopProcess` signature — whether it accepts panelId, sessionId, or a process handle. If neither matches the new `abort(panelId)` shape, a thin adapter inside `claudeCodeManager.ts` is required (files_readonly for this task — would need to move it to files_owned or split into a separate prep task). If discovery reveals a mismatch beyond a 5-line adapter, escalate to STUCK rather than expand scope.
