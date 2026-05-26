---
id: TASK-765
idea: IDEA-026
status: ready
created: 2026-05-26T16:00:00Z
files_owned:
  - main/src/orchestrator/trpc/routers/events.ts
  - main/src/orchestrator/stepTransitionBridge.ts
  - main/src/orchestrator/runExecutor.ts
  - main/src/orchestrator/__tests__/stepTransitionBridge.test.ts
  - main/src/orchestrator/__tests__/runExecutor.test.ts
  - main/src/index.ts
files_readonly:
  - shared/types/workflows.ts
  - main/src/database/migrations/011_workflow_step_tracking.sql
  - main/src/orchestrator/runEventBridge.ts
  - main/src/orchestrator/runLauncher.ts
  - main/src/orchestrator/runQueries.ts
  - main/src/orchestrator/approvalCreatedBridge.ts
  - main/src/orchestrator/questionCreatedBridge.ts
  - main/src/orchestrator/types.ts
  - main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts
  - main/src/orchestrator/__test_fixtures__/loggerLikeSpy.ts
  - main/src/orchestrator/__test_fixtures__/dbAdapter.ts
acceptance_criteria:
  - criterion: "events.ts exports a module-level stepTransitionEvents EventEmitter (singleton, no constructor args)."
    verification: "grep -n 'export const stepTransitionEvents = new EventEmitter()' main/src/orchestrator/trpc/routers/events.ts returns exactly 1 match."
  - criterion: "stepTransitionBridge.ts exports buildStepTransitionEvent(runId, stepId, status, db) that returns a typed WorkflowStepTransitionEvent (shape from shared/types/workflows.ts, defined by TASK-763) and emits via stepTransitionEvents.emit('transition', event)."
    verification: "grep -n 'export function buildStepTransitionEvent' main/src/orchestrator/stepTransitionBridge.ts returns 1 match; grep -n \"stepTransitionEvents.emit('transition'\" main/src/orchestrator/stepTransitionBridge.ts returns at least 1 match."
  - criterion: "stepTransitionBridge.ts writes current_step_id to workflow_runs via parameterized UPDATE before emitting (write-then-emit ordering)."
    verification: "grep -n 'UPDATE workflow_runs SET current_step_id' main/src/orchestrator/stepTransitionBridge.ts returns at least 1 match; emit call appears AFTER the .run() line."
  - criterion: "stepTransitionBridge.ts honors the standalone-typecheck invariant — no imports from 'electron', 'better-sqlite3', or main/src/services/*."
    verification: "grep -nE \"from 'electron'|from 'better-sqlite3'|from '../../services/\" main/src/orchestrator/stepTransitionBridge.ts returns 0 matches."
  - criterion: "RunExecutor exposes a stepEmitter?: StepTransitionEmitterLike constructor seam and calls it at run start (status='running') and run end (status='done' on completed/failed/canceled paths)."
    verification: "grep -n 'stepEmitter' main/src/orchestrator/runExecutor.ts shows at least 4 matches; grep -n 'StepTransitionEmitterLike' main/src/orchestrator/runExecutor.ts returns at least 1 match."
  - criterion: "RunExecutor's step-emission is fail-soft: a throwing emitter is logged at warn level and does NOT escalate."
    verification: "grep -n 'stepEmitter' -A 10 main/src/orchestrator/runExecutor.ts contains a try/catch with this.logger.warn in the catch arm."
  - criterion: "v1 step-id resolution via resolveTerminalStepId(workflowName) returns a stable starter step id for each SoloFlowWorkflowName; returns null for unknown names. When null, no DB write and no emit occurs."
    verification: "grep -n 'function resolveTerminalStepId' main/src/orchestrator/stepTransitionBridge.ts returns at least 1 match."
  - criterion: "stepTransitionBridge.test.ts proves (a) happy-path emit fires with correct shape, (b) DB current_step_id is updated, (c) emit happens after UPDATE, (d) unknown workflow name returns null with no DB write/emit, (e) missing workflow_runs row logs warn and does NOT throw."
    verification: "pnpm --filter main test -- main/src/orchestrator/__tests__/stepTransitionBridge.test.ts exits 0 with at least 5 named test cases."
  - criterion: "runExecutor.test.ts grows test cases proving run-start and run-end emissions fire on happy and failure paths, AND a throwing stepEmitter does not crash the executor."
    verification: "pnpm --filter main test -- main/src/orchestrator/__tests__/runExecutor.test.ts exits 0; grep -n 'stepEmitter' main/src/orchestrator/__tests__/runExecutor.test.ts returns at least 3 matches."
  - criterion: "Existing pnpm --filter main test suite remains green."
    verification: "pnpm --filter main test exits 0."
depends_on: [TASK-763, TASK-764]
estimated_complexity: high
epic: workflow-phase-model
test_strategy:
  needed: true
  justification: "New emitter + bridge wiring + RunExecutor lifecycle integration. Three concerns: (1) the bridge builds events / writes DB / fail-softly emits; (2) RunExecutor calls the emitter at specific lifecycle points; (3) the existing runExecutor.test.ts is the canonical regression net for executor lifecycle and MUST be extended."
  targets:
    - behavior: "buildStepTransitionEvent emits correctly shaped event and updates workflow_runs.current_step_id via DB before emit fires."
      test_file: "main/src/orchestrator/__tests__/stepTransitionBridge.test.ts"
      type: unit
    - behavior: "buildStepTransitionEvent missing-row fallback: logs warn, does NOT throw."
      test_file: "main/src/orchestrator/__tests__/stepTransitionBridge.test.ts"
      type: unit
    - behavior: "resolveTerminalStepId returns canonical terminal step id for each of the five SOLOFLOW_WORKFLOW_NAMES and null for unknown."
      test_file: "main/src/orchestrator/__tests__/stepTransitionBridge.test.ts"
      type: unit
    - behavior: "RunExecutor.execute fires stepEmitter.emit on run start and run end (happy/failure/cancel paths)."
      test_file: "main/src/orchestrator/__tests__/runExecutor.test.ts"
      type: integration
    - behavior: "RunExecutor.execute is fail-soft against a throwing stepEmitter — no escalation, one warn logged."
      test_file: "main/src/orchestrator/__tests__/runExecutor.test.ts"
      type: integration
---

# Add stepTransitionEvents emitter and instrument run lifecycle to emit step transitions

## Objective

Stand up cyboflow's first-class step-transition event surface in the orchestrator: a module-level `stepTransitionEvents` EventEmitter, a small `stepTransitionBridge` that builds events / writes `workflow_runs.current_step_id` / emits, and RunExecutor lifecycle hooks that call the bridge at run start and run end. The new event flow follows the existing `approvalEvents` / `questionEvents` pattern exactly. For v1, cyboflow's Claude Agent SDK runs ONE session per workflow_run; the runner cannot decompose internal step boundaries without additional instrumentation. We therefore adopt the **single-step-per-workflow** model: each `WorkflowDefinition` (from TASK-763) exposes ONE terminal step id; the executor emits `running` at run start and `done` at run end.

## v1 Step-Boundary Detection Decision

Three options were considered:

| Option | Approach | Verdict |
|---|---|---|
| 1. Time-based phase mock | Emit transitions on a 30s timer | Rejected — dishonest signal; creates debugging anti-pattern. |
| 2. Single-step-per-workflow | Treat the SDK session as a single "execute" step; emit `running` at start, `done` at end | **CHOSEN.** Lowest-risk, honest signal, fully sufficient for visualization. |
| 3. MCP-tool-driven transitions | Add a `cyboflow_step_transition` MCP tool | Rejected for v1 — requires changes to every workflow prompt. Revisit as separate IDEA. |

The chosen design preserves the seam needed for option 3 later: `stepTransitionBridge` and the executor's `stepEmitter` collaborator both accept arbitrary `stepId` strings.

## Implementation Steps

1. **Read TASK-763's WorkflowStepTransitionEvent type** in `shared/types/workflows.ts`. Match its actual shape verbatim. Identify each definition's canonical "terminal" step id (the single step v1 toggles between `running` and `done`).

2. **Read TASK-764's migration** in `main/src/database/migrations/011_workflow_step_tracking.sql`. Confirm it adds `current_step_id TEXT` (nullable) to `workflow_runs`.

3. **Add `stepTransitionEvents` emitter to `events.ts`** mirroring the `questionEvents` declaration. Add no router procedures — TASK-766 owns those.

4. **Create `main/src/orchestrator/stepTransitionBridge.ts`** with `buildStepTransitionEvent(runId, stepId, status, db)` and `resolveTerminalStepId(workflowName): string | null`. Write-then-emit ordering. Missing row → warn, no throw. Honor the standalone-typecheck invariant — no imports from electron/better-sqlite3/services/*.

5. **Wire RunExecutor to call the bridge.** Add `StepTransitionEmitterLike` interface near `LifecycleTransitionsLike`. Add `stepEmitter?: StepTransitionEmitterLike` as optional constructor parameter. Private `emitStep(runId, status)` helper that looks up workflow via registry, calls resolveTerminalStepId, emits if non-null. Fail-soft try/catch. Call sites: after pre_spawn lifecycle transition (status='running'), after completed/failed lifecycle (status='done'), in cancel() after canceled transition (status='done').

6. **Wire the production adapter in `main/src/index.ts`** — construct a `StepTransitionEmitterLike` adapter that delegates to `buildStepTransitionEvent(runId, stepId, status, db)` and pass as 9th argument to `new RunExecutor(...)`. Import `buildStepTransitionEvent` and `StepTransitionEmitterLike`.

7. **Add unit tests for stepTransitionBridge** at `main/src/orchestrator/__tests__/stepTransitionBridge.test.ts`. Five test cases per test_strategy.

8. **Extend `main/src/orchestrator/__tests__/runExecutor.test.ts`** with at least three new it cases (running on start, done on completion/failure, fail-soft against throwing emitter).

9. **Sweep grep** for `current_step_id` across `main/src` and `shared` to confirm the column name matches the migration.

10. **Run the full main-workspace test suite**: `pnpm rebuild better-sqlite3 && pnpm --filter main test` then `pnpm typecheck`.

## Acceptance Criteria

See frontmatter. Together: the emitter is declared as a module-level singleton; the bridge builds correct events, writes DB before emit, is fail-soft on missing rows, respects the standalone-typecheck invariant; RunExecutor emits at start/end on all lifecycle arms; resolveTerminalStepId returns canonical ids; new tests exist and the main workspace test suite remains green.

## Test Strategy

Two test files: `stepTransitionBridge.test.ts` (NEW, ~5 unit tests) and `runExecutor.test.ts` (EXTEND, ~3 new it cases). `stepEmitter` is a `vi.fn()` passed at construction; no DB needed in runExecutor.test.ts because the executor uses the abstraction.

## Hardest Decision

**Where does the executor get the workflow name for step-id resolution?** Chose re-query the workflow row inside `emitStep` (~1 SQL SELECT, in-memory better-sqlite3 lookup is cheap, codepath fires at most ~4 times per workflow run). Keeps the StepTransitionEmitterLike interface trivially narrow.

## Rejected Alternatives

- **Time-based mock transitions.** Rejected — lies about agent state.
- **MCP-tool-driven step transitions for v1.** Rejected — too invasive for this batch.
- **Reuse `onLifecycleTransition` with new phase labels.** Rejected — conflates run-state and step-state domains; lifecycle's fail-soft swallowing is correct for run states but wrong for step emissions.
- **Emit on the existing `streamEnvelope` publisher path.** Rejected — step-transition events are orchestrator-level signals, not SDK stream events.

## Lowest Confidence Area

**TASK-763's exact `WorkflowStepTransitionEvent` shape and `WorkflowDefinition` step ids.** Plan assumes `{ runId, stepId, status, timestamp }` with status `'pending' | 'running' | 'done'`. If TASK-763 lands with different field names or status vocabulary, the executor's emission code and resolver must be updated to match.

Secondary: `createTestDb` fixture may need an inline ALTER TABLE if it doesn't auto-run migration 011 once TASK-764 lands.
