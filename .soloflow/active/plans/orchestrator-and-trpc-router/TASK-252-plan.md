---
id: TASK-252
idea: IDEA-006
idea_id: IDEA-006
status: in-flight
created: "2026-05-11T00:00:00Z"
files_owned:
  - main/src/orchestrator/RunQueueRegistry.ts
  - main/src/orchestrator/__tests__/RunQueueRegistry.test.ts
files_readonly:
  - .soloflow/active/ideas/IDEA-006.md
  - .soloflow/active/research/ROADMAP-001-research-architecture.md
  - .soloflow/active/research/ROADMAP-001-research-risks.md
  - main/src/services/__tests__/gitStatusManager.test.ts
acceptance_criteria:
  - criterion: "main/src/orchestrator/RunQueueRegistry.ts exports a class with public methods getOrCreate(runId: string): PQueue, has(runId: string): boolean, delete(runId: string): Promise<void>, drainAll(): Promise<void>, and stats(): { runs: number; totalPending: number; totalActive: number }"
    verification: "grep -nE '^\\s+(public|getOrCreate|has|delete|drainAll|stats)\\b' main/src/orchestrator/RunQueueRegistry.ts shows all five method signatures plus the class declaration"
  - criterion: "Each PQueue is constructed with { concurrency: 1 } and no other concurrency-altering option"
    verification: "grep -n 'new PQueue' main/src/orchestrator/RunQueueRegistry.ts shows exactly one call site with { concurrency: 1 } as the options literal"
  - criterion: "The module file contains zero 'from \"electron\"' or 'require(\"electron\")' imports — orchestrator standalone-typecheck invariant"
    verification: "grep -nE \"from ['\\\"]electron['\\\"]|require\\(['\\\"]electron['\\\"]\\)\" main/src/orchestrator/RunQueueRegistry.ts returns 0 matches"
  - criterion: "A no-recursive-enqueue rule is documented as a top-of-file JSDoc comment block: 'Status-change events flow via EventEmitter, NOT by re-entering the queue.'"
    verification: "grep -n 'no-recursive-enqueue' main/src/orchestrator/RunQueueRegistry.ts shows at least one match and the surrounding JSDoc block references the EventEmitter contract"
  - criterion: "Unit tests in main/src/orchestrator/__tests__/RunQueueRegistry.test.ts cover: (a) two enqueues for the same runId run sequentially, (b) two enqueues for different runIds run concurrently, (c) delete(runId) drains the queue before removing it from the map, (d) drainAll() resolves only after every queue is idle"
    verification: Run pnpm --filter main test -- RunQueueRegistry and confirm all four named test cases pass
  - criterion: TypeScript exhaustive typecheck on main/ does not regress
    verification: pnpm --filter main typecheck exits 0
depends_on:
  - TASK-251
estimated_complexity: low
epic: orchestrator-and-trpc-router
test_strategy:
  needed: true
  justification: RunQueueRegistry is the load-bearing serialization primitive for every state mutation in the orchestrator. Its correctness around drain-on-delete and per-runId concurrency must be locked by tests before TASK-253 builds on it.
  targets:
    - behavior: "Two tasks enqueued for runId='A' execute strictly sequentially (second starts only after first resolves)"
      test_file: main/src/orchestrator/__tests__/RunQueueRegistry.test.ts
      type: unit
    - behavior: "Tasks enqueued for runId='A' and runId='B' execute concurrently (no cross-run blocking)"
      test_file: main/src/orchestrator/__tests__/RunQueueRegistry.test.ts
      type: unit
    - behavior: "delete('A') awaits queue.onIdle() before removing the map entry; an in-flight task for 'A' completes before the entry is gone"
      test_file: main/src/orchestrator/__tests__/RunQueueRegistry.test.ts
      type: unit
    - behavior: drainAll() resolves only after every per-run queue is idle
      test_file: main/src/orchestrator/__tests__/RunQueueRegistry.test.ts
      type: unit
---
# Per-Run PQueue Registry Keyed by runId

## Objective

Build the `RunQueueRegistry` — a `Map<runId, PQueue>` with `{ concurrency: 1 }` per entry — that serializes mutations within a workflow run while allowing different runs to proceed concurrently. This is the orchestrator's single-process answer to the race between Claude stream events and user-initiated actions (start, cancel, approve, reject). The registry exposes a clean lifecycle (`getOrCreate`, `delete` with drain semantics, `drainAll` for shutdown) and lives in `main/src/orchestrator/` with no Electron imports.

## Implementation Steps

1. **Create `main/src/orchestrator/RunQueueRegistry.ts`** (new file). Imports: `PQueue from 'p-queue'`. No imports from `electron`, no imports from `main/src/services/*` (those carry Electron transitively). Pure TypeScript module.
2. **Write the file-level JSDoc** declaring the no-recursive-enqueue rule verbatim: "Status-change events flow via EventEmitter, NOT by re-entering the queue. Calling registry.getOrCreate(runId).add(...) from inside a task already enqueued on the same runId is a self-deadlock — see p-queue README warning."
3. **Implement the class** with these methods:
   - `private queues = new Map<string, PQueue>();`
   - `getOrCreate(runId: string): PQueue` — lazy-creates `new PQueue({ concurrency: 1 })`, stores it, returns it. Idempotent.
   - `has(runId: string): boolean` — pass-through to `this.queues.has`.
   - `async delete(runId: string): Promise<void>` — if no entry, return. Otherwise `await q.onIdle(); this.queues.delete(runId);`. Documents that callers must have already aborted/cancelled any pending tasks before calling delete.
   - `async drainAll(): Promise<void>` — `await Promise.all([...this.queues.values()].map(q => q.onIdle()));` then clear the map.
   - `stats(): { runs: number; totalPending: number; totalActive: number }` — for observability; iterate values and sum `q.size` (pending) and `q.pending` (active).
4. **Add an explanatory comment** under each method that touches the no-recursive-enqueue rule (`getOrCreate` and `delete`) reiterating that recursive enqueue is the documented hazard.
5. **Create `main/src/orchestrator/__tests__/RunQueueRegistry.test.ts`** (new file). Use vitest (matches `gitStatusManager.test.ts` convention). Four test cases per the test_strategy targets. Use `vi.useFakeTimers()` where needed for deterministic sequencing; otherwise use `Promise.resolve()` boundaries and explicit `await` checkpoints.
6. **Run `pnpm --filter main test -- RunQueueRegistry`** and confirm all four tests pass.
7. **Run `pnpm --filter main typecheck`** to confirm no regression. Run `grep -nE "from ['\"]electron['\"]|require\\(['\"]electron['\"]\\)" main/src/orchestrator/RunQueueRegistry.ts` as the standalone-typecheck invariant gate — must return 0 matches.

## Acceptance Criteria

All six AC entries hold. The grep gates (electron-import-zero, single PQueue construction, JSDoc rule presence), the four test cases, and the typecheck are the proof.

## Test Strategy

Unit tests at `main/src/orchestrator/__tests__/RunQueueRegistry.test.ts` using vitest, mirroring the structure of `main/src/services/__tests__/gitStatusManager.test.ts`. No mocks beyond timer control — `p-queue` is exercised directly because its concurrency-1 semantics are the contract under test. Each test resolves the timing question with explicit `await` boundaries rather than wall-clock sleeps.

## Hardest Decision

**Whether `delete(runId)` should also be able to cancel pending tasks via `AbortSignal`.** p-queue supports per-task abort signals (issue #168 in p-queue warns against `queue.clear()` while items are running). The minimal version of `delete` here just awaits idle — assumes callers have already pushed `deny` socket replies or status-transition shutdown work into the queue before calling delete. This keeps the registry's contract simple. The richer "cancel and abort" variant belongs in the higher-level `ApprovalRouter` (a different epic) where pending approvals carry their own AbortControllers.

## Rejected Alternatives

- **Reuse `main/src/utils/mutex.ts`.** Crystal's existing 10ms-polling busy-wait mutex with a 30s hard timeout. Rejected because it has no introspection (`.size`, `.pending`), no per-run isolation, and a hardcoded timeout that does not match the orchestrator's approval-wait pattern (60-minute approval timeouts must not collide with a 30s lock timeout). Mutex stays in place for Crystal's inherited surface; new orchestrator code uses p-queue.
- **Single global PQueue with `priority` per run.** Would interleave runs at task granularity. Rejected because the design invariant is "different runs run concurrently"; a single queue with priorities does not give that.
- **Roll our own per-run task array.** Rejected — re-implements p-queue badly. p-queue's `onIdle()` Promise is the exact primitive needed for drainable shutdown.

## Lowest Confidence Area

The interaction between `delete(runId)` and a queue blocked on a long-running task (e.g., a 60-minute pending approval socket wait). `onIdle()` resolves only when the queue empties — if the approval task is still pending, `delete` will block. The contract here is "callers must cancel before calling delete"; the test for that contract belongs in the ApprovalRouter epic, not here. Confidence is medium that the documented contract is the right split; if downstream surfaces find it awkward, `delete` may grow a second variant `deleteForce(runId)` that abandons rather than awaits.
