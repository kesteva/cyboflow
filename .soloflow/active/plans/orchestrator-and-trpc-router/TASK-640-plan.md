---
id: TASK-640
idea: IDEA-018
status: in-flight
created: "2026-05-18T20:30:00Z"
files_owned:
  - main/src/orchestrator/runExecutor.ts
  - main/src/orchestrator/runLauncher.ts
  - main/src/orchestrator/__tests__/runExecutor.test.ts
  - main/src/orchestrator/__tests__/runLauncher.test.ts
files_readonly:
  - main/src/services/panels/claude/claudeCodeManager.ts
  - main/src/orchestrator/RunQueueRegistry.ts
  - main/src/orchestrator/types.ts
  - main/src/orchestrator/workflowRegistry.ts
  - main/src/orchestrator/Orchestrator.ts
  - main/src/orchestrator/__test_fixtures__/dbAdapter.ts
  - main/src/orchestrator/stuckDetector.ts
  - shared/types/workflows.ts
  - .soloflow/active/ideas/IDEA-018.md
acceptance_criteria:
  - criterion: "main/src/orchestrator/runExecutor.ts exists, exports a RunExecutor class with a public async execute(runId: string): Promise<void> method, and does NOT import 'electron', 'better-sqlite3', or any concrete service from main/src/services/* (standalone-typecheck invariant)."
    verification: "test -f main/src/orchestrator/runExecutor.ts && grep -n 'export class RunExecutor' main/src/orchestrator/runExecutor.ts && grep -n 'execute(runId' main/src/orchestrator/runExecutor.ts && ! grep -nE \"from ['\\\"]electron['\\\"]|from ['\\\"]better-sqlite3['\\\"]|from ['\\\"]\\.\\./services/\" main/src/orchestrator/runExecutor.ts"
  - criterion: "RunExecutor takes its ClaudeCodeManager collaborator via a narrow interface (e.g. ClaudeSpawnerLike) declared in runExecutor.ts — NOT a direct import of ClaudeCodeManager — matching the ClaudeManagerLike pattern in main/src/orchestrator/stuckDetector.ts:36."
    verification: "grep -n 'export interface ClaudeSpawnerLike' main/src/orchestrator/runExecutor.ts && ! grep -n \"from.*services/panels/claude/claudeCodeManager\" main/src/orchestrator/runExecutor.ts"
  - criterion: "RunExecutor.execute(runId) loads the workflow_runs row via WorkflowRegistry.getRunById(runId), looks up the workflow row via WorkflowRegistry.getById(workflowId), and throws Error if either is missing."
    verification: "grep -n 'getRunById' main/src/orchestrator/runExecutor.ts && grep -n 'getById' main/src/orchestrator/runExecutor.ts"
  - criterion: "RunExecutor exposes four protected extension hooks reserved for sibling tasks: getPrompt(workflow), bridgeEvents(runId, panelId), buildOptionsOverrides(runId, run, workflow), and onLifecycleTransition(runId, phase). All four are declared as `protected` methods (or comparable equivalent) so subclasses can override them. The default getPrompt() implementation throws an Error with the string 'NOT_IMPLEMENTED: getPrompt' so TASK-641 can confirm it is wired in."
    verification: "grep -nE 'protected (async )?getPrompt|protected (async )?bridgeEvents|protected buildOptionsOverrides|protected (async )?onLifecycleTransition' main/src/orchestrator/runExecutor.ts | wc -l | awk '{ if ($1 < 4) exit 1 }' && grep -n 'NOT_IMPLEMENTED: getPrompt' main/src/orchestrator/runExecutor.ts"
  - criterion: "RunExecutor.execute(runId) synthesizes panelId and sessionId from runId deterministically (e.g. panelId = `run-${runId}`, sessionId = `run-${runId}`) and passes both into ClaudeSpawnerLike.spawnCliProcess({ panelId, sessionId, worktreePath, prompt, ... })."
    verification: "grep -n 'run-' main/src/orchestrator/runExecutor.ts && grep -n 'spawnCliProcess' main/src/orchestrator/runExecutor.ts"
  - criterion: "RunLauncher constructor accepts a new optional RunExecutor collaborator and an optional RunQueueRegistry collaborator (appended after the existing publisher arg as the 10th and 11th constructor parameters), preserving backward compatibility with all existing call sites that pass fewer args (every existing test in runLauncher.test.ts continues to compile and pass)."
    verification: "grep -nE 'private readonly runExecutor\\??:|private readonly runQueueRegistry\\??:' main/src/orchestrator/runLauncher.ts | wc -l | awk '{ if ($1 < 2) exit 1 }' && pnpm --filter cyboflow-main test -- runLauncher.test"
  - criterion: "When both runExecutor and runQueueRegistry are provided to RunLauncher, launch() enqueues runExecutor.execute(runId) via runQueueRegistry.getOrCreate(runId).add(() => runExecutor.execute(runId)) AFTER the publisher.publish('run_started', ...) call and BEFORE the function returns. The enqueue is fire-and-forget — launch() does NOT await the queue's onIdle() and does NOT await the execute() promise."
    verification: "grep -nE 'runQueueRegistry\\.getOrCreate|runQueues?\\.getOrCreate' main/src/orchestrator/runLauncher.ts && grep -nB2 -A4 'getOrCreate' main/src/orchestrator/runLauncher.ts | grep -E '\\.add\\(' && ! grep -nE 'await.*getOrCreate.*onIdle' main/src/orchestrator/runLauncher.ts"
  - criterion: "When either runExecutor or runQueueRegistry is undefined (existing call sites and tests), launch() still completes and returns the same { runId, worktreePath, branchName, permissionMode } shape it returns today, and does NOT throw."
    verification: "All existing tests in main/src/orchestrator/__tests__/runLauncher.test.ts pass unchanged: pnpm --filter cyboflow-main test -- runLauncher.test"
  - criterion: "New test file main/src/orchestrator/__tests__/runExecutor.test.ts exists and covers: (a) execute() throws when workflow_runs row missing, (b) execute() throws when workflow row missing, (c) execute() bubbles up getPrompt's NOT_IMPLEMENTED error in the default class (sentinel-stub contract), (d) RunLauncher.launch enqueues execute() through RunQueueRegistry after publishing run_started, (e) RunLauncher.launch does NOT call execute() synchronously (the queue.add callback is what invokes it). All tests pass."
    verification: "test -f main/src/orchestrator/__tests__/runExecutor.test.ts && pnpm --filter cyboflow-main test -- runExecutor.test"
  - criterion: "Project-wide typecheck and lint pass: pnpm typecheck and pnpm lint both exit 0 (no new `any` introduced, all imports resolve)."
    verification: "pnpm typecheck && pnpm lint"
depends_on: []
estimated_complexity: high
epic: orchestrator-and-trpc-router
test_strategy:
  needed: true
  justification: "RunExecutor is a new module with branching logic (missing-row guards, synthetic id derivation, hook stubs) and RunLauncher gains a new optional enqueue branch — both need direct unit coverage. Existing runLauncher.test.ts must also stay green when the new optional collaborators are omitted (backward-compat contract)."
  targets:
    - behavior: RunExecutor.execute throws when WorkflowRegistry.getRunById returns null
      test_file: main/src/orchestrator/__tests__/runExecutor.test.ts
      type: unit
    - behavior: RunExecutor.execute throws when WorkflowRegistry.getById returns null
      test_file: main/src/orchestrator/__tests__/runExecutor.test.ts
      type: unit
    - behavior: Default RunExecutor.getPrompt() throws NOT_IMPLEMENTED so TASK-641 has a wiring signal
      test_file: main/src/orchestrator/__tests__/runExecutor.test.ts
      type: unit
    - behavior: RunExecutor.execute synthesizes panelId/sessionId from runId and invokes ClaudeSpawnerLike.spawnCliProcess with those plus worktreePath from the run row (verified by spy)
      test_file: main/src/orchestrator/__tests__/runExecutor.test.ts
      type: unit
    - behavior: RunLauncher.launch enqueues runExecutor.execute via runQueueRegistry.getOrCreate(runId).add() AFTER publisher.publish run_started; enqueue happens via a spy on PQueue.add. Verified by call-order array.
      test_file: main/src/orchestrator/__tests__/runExecutor.test.ts
      type: integration
    - behavior: RunLauncher.launch with runExecutor/runQueueRegistry omitted still succeeds and returns the expected shape (backward-compat — existing runLauncher.test.ts cases must remain green unmodified).
      test_file: main/src/orchestrator/__tests__/runLauncher.test.ts
      type: unit
---
# Build RunExecutor adapter and wire it into RunLauncher.launch

## Objective

Create the `RunExecutor` adapter that translates a `runId` into the synthetic `panelId`/`sessionId` shape `ClaudeCodeManager.spawnCliProcess()` expects, and extend `RunLauncher.launch()` so the spawn is enqueued onto the per-run `PQueue` after the existing `run_started` publish. This task commits the open_question 1 design (adapter path, option b) and stands up the four extension hooks — `getPrompt()`, `bridgeEvents()`, `buildOptionsOverrides()`, `onLifecycleTransition()` — that sibling tasks TASK-641/642/643/644 plug into. The happy path is intentionally skeletal: `getPrompt()` throws `NOT_IMPLEMENTED` so TASK-641 has an obvious wiring target, and event bridging + lifecycle transitions are no-ops until their owning tasks land.

## Implementation Steps

1. **Create `main/src/orchestrator/runExecutor.ts`** (new file). Top of file: file-header comment documenting the standalone-typecheck invariant (no electron / better-sqlite3 / services/* imports) — mirror the wording in `main/src/orchestrator/runLauncher.ts:1-13`.

2. **Declare narrow `ClaudeSpawnerLike` interface in `runExecutor.ts`** following the `ClaudeManagerLike` pattern in `stuckDetector.ts:34-46`. Shape:
   ```ts
   export interface ClaudeSpawnerOptions {
     panelId: string;
     sessionId: string;
     worktreePath: string;
     prompt: string;
     permissionMode?: 'approve' | 'ignore';
   }
   export interface ClaudeSpawnerLike {
     spawnCliProcess(options: ClaudeSpawnerOptions): Promise<void>;
   }
   ```

3. **Declare a narrow `WorkflowRegistryLike` interface in `runExecutor.ts`** with only `getRunById(runId): WorkflowRunRow | null` and `getById(workflowId): WorkflowRow | null` — both types imported as `import type` from `../../../shared/types/workflows`. Avoid importing the concrete `WorkflowRegistry` class to preserve test ergonomics.

4. **Define `RunExecutor` class** with the public `execute(runId)` method and four `protected` extension hooks (`getPrompt`, `bridgeEvents`, `buildOptionsOverrides`, `onLifecycleTransition`). Defaults: `getPrompt()` throws `NOT_IMPLEMENTED: getPrompt — TASK-641 must override`; the others are no-ops. See file-level docstring for the integration contract.

5. **Extend `RunLauncher` constructor** in `main/src/orchestrator/runLauncher.ts`: append two new optional constructor params after the existing `publisher` arg — `runExecutor?: RunExecutor` and `runQueueRegistry?: RunQueueRegistry`. Use `import type` to preserve the standalone-typecheck invariant. Preserves backward compat with every existing call site.

6. **Wire enqueue into `RunLauncher.launch()`** after the existing `this.publisher?.publish(runId, {...})` call and before the `return { runId, ... }`. Use `void this.runQueueRegistry.getOrCreate(runId).add(async () => { try { await executor.execute(runId); } catch (err) { logger.error(...); } });`. The `void` prefix and inner try/catch are load-bearing.

7. **Update the standalone-typecheck invariant comment** at the top of `runLauncher.ts` (lines 10-12) to mention the new optional collaborators (no new electron/services imports).

8. **Create `main/src/orchestrator/__tests__/runExecutor.test.ts`** mirroring the `runLauncher.test.ts` harness. Cover RunExecutor.execute branches (missing row, missing worktree, missing workflow, NOT_IMPLEMENTED, panelId/sessionId synthesis) plus RunLauncher integration (enqueue ordering vs publish, fire-and-forget, log-on-throw, backward-compat smoke).

9. **Run `pnpm --filter cyboflow-main test -- runLauncher.test runExecutor.test`** locally; existing 9 runLauncher tests + new runExecutor cases all green.

10. **Run `pnpm typecheck` and `pnpm lint`** to confirm no new `any`, no electron-import drift, no unresolved types.

## Acceptance Criteria

Restated from the frontmatter — each criterion is independently grep-checkable or test-runnable. The standalone-typecheck invariant criterion is the load-bearing one: a future executor that accidentally adds `import ClaudeCodeManager from '../services/...'` will pass the new tests (the spy stub satisfies the interface) but break the architectural invariant. The grep AC catches that regression.

## Test Strategy

Specified in `test_strategy.targets`. Fixture decisions:
- Stub `ClaudeSpawnerLike` with `vi.fn()` (no real ClaudeCodeManager).
- Stub `WorkflowRegistryLike` with object literals matching the narrow interface.
- Use a real `RunQueueRegistry` (not a stub) — it's 70 lines, no external deps.
- Drain queues via `await runQueueRegistry.getOrCreate(runId).onIdle()` at the end of each enqueue test.

## Hardest Decision

The dependency-injection shape for ClaudeCodeManager. Chose a new narrow `ClaudeSpawnerLike` interface (not reusing `ClaudeManagerLike`, not direct-importing the concrete class) — preserves the standalone-typecheck invariant and matches the established `*Like` interface pattern for every orchestrator-side use of a service.

## Rejected Alternatives

- **Inline the spawn directly into `RunLauncher.launch`** — open_question 1 commits to the adapter; siblings need extension points; inlining would create merge contention.
- **Make hooks abstract** — inconsistent with sequencing (TASK-641 first, others later). NOT_IMPLEMENTED throw on `getPrompt` and no-op on the others matches sibling ordering.
- **Await the spawn inside `launch()`** — would block the tRPC mutation for the full SDK iterator runtime. IDEA slice 6 mandates RunQueueRegistry routing.
- **Have RunExecutor own the enqueue** — hides queue routing from RunLauncher and prevents future policy hooks at the launcher.

## Lowest Confidence Area

The `permissionMode` type-axis mismatch: workflows store `'default' | 'acceptEdits' | 'dontAsk'`, but `ClaudeSpawnOptions.permissionMode` is `'approve' | 'ignore'`. TASK-640 leaves `permissionMode` undefined in the default `buildOptionsOverrides()`; TASK-643 owns the mapper. If `pnpm dev` testing pre-TASK-643 shows wrong permission behavior, document it as a known limitation. Secondary risk: `bridgeEvents()` no-op means SDK output goes nowhere until TASK-642 lands — verify via cyboflow logs that `[ClaudeCodeManager] SDK query started for panel run-<runId>` appears.
