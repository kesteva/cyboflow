---
id: TASK-766
idea: IDEA-026
status: ready
created: 2026-05-26T16:00:00Z
files_owned:
  - main/src/orchestrator/trpc/routers/runs.ts
  - main/src/orchestrator/trpc/routers/events.ts
  - main/src/orchestrator/trpc/routers/__tests__/runs.test.ts
  - main/src/orchestrator/trpc/__tests__/router.test.ts
files_readonly:
  - shared/types/workflows.ts
  - main/src/orchestrator/runQueries.ts
  - main/src/orchestrator/types.ts
  - main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts
  - main/src/orchestrator/__test_fixtures__/dbAdapter.ts
  - main/src/orchestrator/inspectorQueries.ts
  - main/src/database/migrations/006_cyboflow_schema.sql
  - .soloflow/active/ideas/IDEA-026.md
  - .soloflow/active/research/IDEA-026-research.md
acceptance_criteria:
  - criterion: "main/src/orchestrator/trpc/routers/runs.ts exports a cyboflow.runs.getPhaseState query whose input is z.object({ runId: z.string() }) and whose return type is { definition: WorkflowDefinition; currentStepId: string | null; stepStates: WorkflowStepState[] }."
    verification: "grep -nE 'getPhaseState:\\s*protectedProcedure' main/src/orchestrator/trpc/routers/runs.ts returns 1 match; grep -nE 'WorkflowDefinition|WorkflowStepState' main/src/orchestrator/trpc/routers/runs.ts returns at least 2 matches; pnpm --filter main typecheck exits 0."
  - criterion: "getPhaseState looks up the workflow row for the given runId via JOIN, resolves WorkflowDefinition via WORKFLOW_DEFINITIONS map keyed by SoloFlowWorkflowName, and throws TRPCError NOT_FOUND when workflow name is not recognized."
    verification: "Vitest test seeds workflow_run with workflow.name='soloflow', asserts result.definition.id === 'soloflow'. Second test with unknown name asserts TRPCError NOT_FOUND."
  - criterion: "getPhaseState reads current_step_id from the workflow_runs row (column added by TASK-764) and returns it verbatim as currentStepId (string when set, null when NULL)."
    verification: "Vitest test seeds current_step_id='plan.idea-extract', asserts result.currentStepId === 'plan.idea-extract'. Second test with NULL asserts result.currentStepId === null."
  - criterion: "getPhaseState computes stepStates[] by walking WorkflowDefinition.phases[*].steps[] in declaration order: steps before currentStepId → 'done'; matching step → 'running'; after → 'pending'. When currentStepId is null OR not in definition (orphan id), all 'pending', no throw."
    verification: "Four-case vitest coverage: null → all pending; first step → first running, rest pending; middle step → preceding done, matching running, trailing pending; orphan id → all pending, no throw."
  - criterion: "getPhaseState throws TRPCError PRECONDITION_FAILED when ctx.db is undefined (matching runs.list / runs.getStuckInspection guard pattern)."
    verification: "Vitest test against context with no db asserts TRPCError PRECONDITION_FAILED."
  - criterion: "getPhaseState throws TRPCError NOT_FOUND when the runId does not exist in workflow_runs."
    verification: "Vitest test with non-existent runId asserts TRPCError NOT_FOUND."
  - criterion: "main/src/orchestrator/trpc/routers/runs.ts exports a cyboflow.runs.onStepTransition subscription whose input is z.object({ runId: z.string() }) and which yields WorkflowStepTransitionEvent payloads."
    verification: "grep -nE 'onStepTransition:\\s*protectedProcedure' main/src/orchestrator/trpc/routers/runs.ts returns 1 match; grep -n 'WorkflowStepTransitionEvent' main/src/orchestrator/trpc/routers/runs.ts returns at least 1 match."
  - criterion: "onStepTransition consumes the stepTransitionEvents EventEmitter via eventToAsyncIterable<WorkflowStepTransitionEvent>(stepTransitionEvents, 'transition', abortSignal) — NOT the placeholder makePlaceholderAsyncIterator. The async generator filters server-side: if ev.runId !== input.runId continue."
    verification: "grep -n 'eventToAsyncIterable' main/src/orchestrator/trpc/routers/runs.ts returns at least 1 match; grep -n 'makePlaceholderAsyncIterator' main/src/orchestrator/trpc/routers/runs.ts returns 0 matches; grep -nE 'if \\(ev\\.runId !== input\\.runId\\) continue' main/src/orchestrator/trpc/routers/runs.ts returns at least 1 match. Vitest test emits two events (runId='run-A' and 'run-B'), drains run-A subscription, asserts exactly one event received with runId='run-A'."
  - criterion: "onStepTransition terminates cleanly when AbortSignal fires (parallel to existing onApprovalCreated abort test)."
    verification: "Vitest test in router.test.ts calls callSubscription('cyboflow.runs.onStepTransition', ...), aborts before draining, asserts collected.length === 0 and the for-await loop completes."
  - criterion: "eventToAsyncIterable is shared with events.ts (export-modifier change) — runs.ts does NOT redefine it. No circular import is introduced."
    verification: "grep -nE 'function eventToAsyncIterable|const eventToAsyncIterable' main/src/orchestrator/trpc/routers/runs.ts returns 0 matches; grep -nE 'export function eventToAsyncIterable' main/src/orchestrator/trpc/routers/events.ts returns 1 match. pnpm --filter main typecheck exits 0."
  - criterion: "All existing tests in routers/__tests__/runs.test.ts and trpc/__tests__/router.test.ts continue to pass unchanged. New tests are additive only."
    verification: "pnpm --filter main test -- --run trpc/routers/__tests__/runs.test.ts exits 0; pnpm --filter main test -- --run trpc/__tests__/router.test.ts exits 0."
depends_on: [TASK-765]
estimated_complexity: medium
epic: workflow-phase-model
test_strategy:
  needed: true
  justification: "Two net-new tRPC procedures: a query with non-trivial logic (workflow lookup + WorkflowDefinition resolution + stepStates derivation with four edge cases) and a subscription consuming a real EventEmitter with server-side runId filtering. Sibling-test scan: runs.test.ts (canonical home for runs-router integration tests) and router.test.ts (subscription-abort contract tests). Both existing test files MUST gain additive tests."
  targets:
    - behavior: "getPhaseState returns correct WorkflowDefinition for known SoloFlowWorkflowName; throws NOT_FOUND for unknown workflow name."
      test_file: main/src/orchestrator/trpc/routers/__tests__/runs.test.ts
      type: integration
    - behavior: "getPhaseState returns currentStepId verbatim (string and null cases) from workflow_runs.current_step_id."
      test_file: main/src/orchestrator/trpc/routers/__tests__/runs.test.ts
      type: integration
    - behavior: "getPhaseState computes stepStates[] correctly across four cases: null currentStepId, first-step, middle-step, orphan-id."
      test_file: main/src/orchestrator/trpc/routers/__tests__/runs.test.ts
      type: integration
    - behavior: "getPhaseState rejects with PRECONDITION_FAILED when ctx.db is missing, NOT_FOUND when runId does not exist."
      test_file: main/src/orchestrator/trpc/routers/__tests__/runs.test.ts
      type: integration
    - behavior: "onStepTransition filters by runId server-side: emitting two events (run-A, run-B) yields only run-A for a run-A subscriber."
      test_file: main/src/orchestrator/trpc/routers/__tests__/runs.test.ts
      type: integration
    - behavior: "onStepTransition yields zero events and terminates cleanly when AbortSignal fires before any emit."
      test_file: main/src/orchestrator/trpc/__tests__/router.test.ts
      type: integration
---

# Expose getPhaseState query + onStepTransition subscription on the runs tRPC router

## Objective

Surface the workflow-phase data model (introduced by TASK-763 in `shared/types/workflows.ts`, TASK-764 in migration `current_step_id`, and TASK-765 in `stepTransitionEvents` emitter) to the frontend via two new tRPC procedures on `cyboflow.runs`: `getPhaseState(runId)` (query → `{ definition, currentStepId, stepStates }`) and `onStepTransition({ runId })` (subscription → `WorkflowStepTransitionEvent` deltas filtered server-side by runId). The subscription MUST follow the real-EventEmitter pattern used by `onApprovalCreated` — NOT the non-functional `makePlaceholderAsyncIterator` pattern used by `onStreamEvent` (research Area E flags this as a known foot-gun).

## Implementation Steps

1. **Promote `eventToAsyncIterable` to an exported symbol in `events.ts`** by changing `function eventToAsyncIterable<T>(` to `export function eventToAsyncIterable<T>(`. Strict-additive symbol exposure; no behavior change. (Fallback if circular import emerges: extract to new `main/src/orchestrator/trpc/eventToAsyncIterable.ts` module.)

2. **Add imports to runs.ts**:
   - `import type { WorkflowDefinition, WorkflowStepState, WorkflowStepTransitionEvent, SoloFlowWorkflowName } from '../../../../../shared/types/workflows';`
   - `import { WORKFLOW_DEFINITIONS, SOLOFLOW_WORKFLOW_NAMES } from '../../../../../shared/types/workflows';`
   - `import { stepTransitionEvents, eventToAsyncIterable } from './events';`

3. **Add the `getPhaseState` query procedure** AFTER `getStuckInspection`:
   - PRECONDITION_FAILED if `ctx.db` is undefined.
   - SELECT workflow_runs JOIN workflows by runId; NOT_FOUND if row missing.
   - Narrow workflow.name to SoloFlowWorkflowName; NOT_FOUND if not in SOLOFLOW_WORKFLOW_NAMES.
   - Resolve definition via WORKFLOW_DEFINITIONS[name]. Flatten phases.flatMap(p => p.steps). Compute stepStates by walking flatSteps with currentStepId index (orphan id → all pending).

4. **Add the `onStepTransition` subscription procedure** immediately after getPhaseState. Mirror `onApprovalCreated` (events.ts lines 180–192) with runId filter:
   ```
   .subscription(async function* ({ input, signal }) {
     const abortSignal = signal ?? new AbortController().signal;
     const source = eventToAsyncIterable<WorkflowStepTransitionEvent>(
       stepTransitionEvents, 'transition', abortSignal);
     for await (const ev of source) {
       if (ev.runId !== input.runId) continue;
       yield ev;
     }
   })
   ```
   No throttle wrapper — step transitions are infrequent.

5. **Verify standalone-typecheck invariant**: grep runs.ts for forbidden imports — must return 0 matches.

6. **Add integration tests to `runs.test.ts`** following inline-seed-helper pattern. New describe blocks for `getPhaseState` (6 query cases) and `onStepTransition` (runId-filter case). Use `callProcedure` from `@trpc/server/unstable-core-do-not-import`. Open subscription with AbortController, emit two events on stepTransitionEvents, assert only matching runId is yielded. CRITICAL afterEach hygiene: `stepTransitionEvents.removeAllListeners('transition')`.

7. **Add subscription-abort test to `router.test.ts`** inside existing `appRouter subscription placeholders` describe block. Mirror the onApprovalCreated abort-yields-zero test.

8. **Run verification gates**: `pnpm --filter main typecheck`, `pnpm --filter main test -- --run trpc/routers/__tests__/runs.test.ts`, `pnpm --filter main test -- --run trpc/__tests__/router.test.ts`. All exit 0.

## Acceptance Criteria

See frontmatter. Together: getPhaseState exported with input shape + return type; resolves WorkflowDefinition via WORKFLOW_DEFINITIONS keyed by SoloFlowWorkflowName; returns current_step_id verbatim; stepStates derivation correct across null/first/middle/orphan; throws PRECONDITION_FAILED for missing db, NOT_FOUND for missing run; onStepTransition uses real EventEmitter pattern with runId filter; terminates on abort; eventToAsyncIterable shared; all pre-existing tests pass.

## Test Strategy

Additive tests added to two existing test files. No new test file. Reuses createTestDb + dbAdapter + appRouter.createCaller fixture chain. Mocking: NONE — real EventEmitter via direct .emit(), real in-memory SQLite via createTestDb.

## Hardest Decision

**Whether to inline stepStates derivation or extract a `getPhaseStateHandler` to runQueries.ts.** Chose inline (~12 lines, well below extraction threshold; runQueries.ts is files_readonly per skeleton; query body ~25 lines comparable to getStuckInspection).

## Rejected Alternatives

- **Mirror onStreamEvent placeholder pattern** to decouple from TASK-765. Rejected — research Area E names onStreamEvent as a non-functional stub explicitly NOT to template against.
- **Filter onStepTransition runId via tRPC middleware.** Rejected — tRPC v11 subscription middlewares can't inspect yielded values; filter MUST happen in the async generator.
- **Throttle the onStepTransition subscription** like onStreamEvent does. Rejected — step transitions are infrequent boundary events; onApprovalCreated doesn't throttle and is the canonical template.
- **Extract eventToAsyncIterable to a new shared module.** Rejected — 40-line utility with two callers; export-modifier edit is smallest possible diff.

## Lowest Confidence Area

**The 'transition' event name on stepTransitionEvents.** TASK-765 chooses this when it emits. Plan adopts 'transition' per research Area E. If TASK-765 chose differently, step 4's eventName literal must be updated to match — executor should grep `stepTransitionEvents.emit` before implementing.

Secondary: exact export names from shared/types/workflows.ts for `WORKFLOW_DEFINITIONS`. If TASK-763 chose different identifiers, update step 2 imports accordingly. If TASK-763 omits SOLOFLOW_WORKFLOW_NAMES narrowing, fall back to `Object.prototype.hasOwnProperty.call(WORKFLOW_DEFINITIONS, row.name)` membership test.
