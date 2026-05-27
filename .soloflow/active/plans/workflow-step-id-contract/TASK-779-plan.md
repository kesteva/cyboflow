---
id: TASK-779
idea: SPRINT-040-compound
status: in-flight
created: "2026-05-26T00:00:00Z"
files_owned:
  - main/src/orchestrator/stepTransitionBridge.ts
  - main/src/orchestrator/__tests__/stepTransitionBridge.test.ts
  - main/src/database/migrations/011_workflow_step_tracking.sql
  - main/src/database/__tests__/migration011.test.ts
  - main/src/orchestrator/trpc/routers/__tests__/runs.test.ts
files_readonly:
  - shared/types/workflows.ts
  - main/src/orchestrator/trpc/routers/runs.ts
  - main/src/orchestrator/runExecutor.ts
  - main/src/index.ts
  - main/src/orchestrator/trpc/routers/events.ts
  - frontend/src/hooks/useWorkflowPhaseState.ts
  - frontend/src/components/cyboflow/WorkflowProgressTimeline.tsx
  - main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts
  - main/src/orchestrator/__test_fixtures__/dbAdapter.ts
  - main/src/orchestrator/__test_fixtures__/loggerLikeSpy.ts
  - .soloflow/active/findings/SPRINT-040-findings.md
acceptance_criteria:
  - criterion: TERMINAL_STEP_IDS in stepTransitionBridge.ts emits bare step ids matching WORKFLOW_DEFINITIONS WorkflowStep.id values (not dot-notation).
    verification: "grep over stepTransitionBridge.ts shows soloflow→'implement', planner→'tasks', sprint→'implement', compound→'extract', prune→'scan'. No value contains '.'."
  - criterion: No dot-notation step ids remain in production source (excluding archive/done plan markdown).
    verification: "grep -rnE \"'execute\\.implement'|'compound\\.extract'|'prune\\.scan'|'refine\\.tasks'|'plan\\.context'\" main/src frontend/src shared --exclude-dir=node_modules returns 0 matches."
  - criterion: Migration 011 comment and its test fixture use a bare step id consistent with the new contract.
    verification: "grep -n 'current_step_id' main/src/database/migrations/011_workflow_step_tracking.sql contains the example token 'implement' (bare) and does NOT contain dot-form. grep -n \"'execute.implement'\" main/src/database/__tests__/migration011.test.ts returns 0 matches."
  - criterion: stepTransitionBridge unit tests assert bare step ids for every SOLOFLOW_WORKFLOW_NAMES entry.
    verification: "grep over stepTransitionBridge.test.ts shows soloflow→'implement', planner→'tasks', sprint→'implement', compound→'extract', prune→'scan'."
  - criterion: A new integration test in runs.test.ts wires resolveTerminalStepId + buildStepTransitionEvent through getPhaseState to assert end-to-end stepId contract parity.
    verification: "grep -nE 'end-to-end stepId contract|namespace mismatch|TERMINAL_STEP_IDS resolves into WORKFLOW_DEFINITIONS' main/src/orchestrator/trpc/routers/__tests__/runs.test.ts returns at least one match."
  - criterion: "The new integration test, for every SOLOFLOW_WORKFLOW_NAMES entry, calls buildStepTransitionEvent(runId, resolveTerminalStepId(name)!, 'running', adapter) then asserts caller.cyboflow.runs.getPhaseState returns a stepStates entry with status === 'running' for that stepId."
    verification: "Reading runs.test.ts shows the test iterates SOLOFLOW_WORKFLOW_NAMES, seeds one run per workflow, invokes buildStepTransitionEvent with the resolved id, then asserts the matching stepStates entry has status: 'running'."
  - criterion: pnpm --filter main test passes including the new integration test.
    verification: Run `pnpm --filter main test` from repo root — exit code 0.
depends_on: []
estimated_complexity: medium
epic: workflow-step-id-contract
test_strategy:
  needed: true
  justification: Existing unit tests pin the wrong contract (dot-notation); they must be migrated. A new integration test is the dedicated regression gate against future namespace drift.
  targets:
    - behavior: resolveTerminalStepId returns bare ids matching WORKFLOW_DEFINITIONS for every SOLOFLOW_WORKFLOW_NAMES entry.
      test_file: main/src/orchestrator/__tests__/stepTransitionBridge.test.ts
      type: unit
    - behavior: buildStepTransitionEvent stores and emits a bare step id.
      test_file: main/src/orchestrator/__tests__/stepTransitionBridge.test.ts
      type: unit
    - behavior: Migration 011 fixture round-trip uses a bare step id.
      test_file: main/src/database/__tests__/migration011.test.ts
      type: unit
    - behavior: "End-to-end stepId contract: for each SOLOFLOW_WORKFLOW_NAMES, buildStepTransitionEvent writes a current_step_id that getPhaseState resolves to a non -1 stepStates index."
      test_file: main/src/orchestrator/trpc/routers/__tests__/runs.test.ts
      type: integration
---
# Fix stepId namespace mismatch across the workflow phase chain

## Objective

The orchestrator emits dot-notation step ids (`'execute.implement'`, `'compound.extract'`) from `stepTransitionBridge.TERMINAL_STEP_IDS`, but `WORKFLOW_DEFINITIONS.WorkflowStep.id` declares bare ids (`'implement'`, `'extract'`). Every downstream consumer — `getPhaseState`'s `findIndex`, `useWorkflowPhaseState.mergeTransition`'s `indexOf`, and `WorkflowProgressTimeline.stepStatusMap.get(step.id)` — therefore resolves to `-1` / `undefined` in production, silently rendering all steps as `pending` and dropping every real transition event. Unit tests pass only because fixtures use synthetic ids that happen to match on both sides. This task migrates the emitter to bare ids so all four consumer sites resolve correctly without touching consumer code, and adds a real-workflow integration test that locks the contract against future drift.

## Implementation Steps

1. **Pre-flight uniqueness check.** Confirm bare step ids are unique within each workflow definition (the skeptic already verified this — soloflow has 17 unique ids, planner 6, sprint 8, compound 4, prune 4). If a duplicate is later introduced, STOP — option (b) would create within-workflow collisions.

2. **Pre-flight rename grep.** Capture the rename surface:
   ```bash
   grep -rnE "'execute\.implement'|'compound\.extract'|'prune\.scan'|'refine\.tasks'|'plan\.context'" main/src frontend/src shared --exclude-dir=node_modules
   ```
   Expected hits: stepTransitionBridge.ts (TERMINAL_STEP_IDS), migration011.sql (header comment), migration011.test.ts (round-trip fixture), stepTransitionBridge.test.ts (every dot-form arg + assertion).

3. **Edit `main/src/orchestrator/stepTransitionBridge.ts`.**
   - Update the JSDoc on `WorkflowStepTransitionEvent.stepId` from "(e.g. 'execute.implement', 'compound.extract')" to "(e.g. 'implement', 'extract' — bare WorkflowStep.id values)".
   - Update the `TERMINAL_STEP_IDS` block comment to remove the dot-notation rationale; add: "Step ids are bare WorkflowStep.id values from WORKFLOW_DEFINITIONS — matching the lookup keys used by getPhaseState, mergeTransition, and stepStatusMap."
   - Change `TERMINAL_STEP_IDS` values: `soloflow: 'implement', planner: 'tasks', sprint: 'implement', compound: 'extract', prune: 'scan'`.
   - Leave `resolveTerminalStepId` signature, `buildStepTransitionEvent` body, write-then-emit ordering, fail-soft logging, and DB UPDATE behavior UNCHANGED.

4. **Edit `main/src/database/migrations/011_workflow_step_tracking.sql`.** Comment-only edit. Rewrite the header comment so documented example values use bare ids: `'context'`, `'implement'`.

5. **Edit `main/src/database/__tests__/migration011.test.ts`.** Replace both `'execute.implement'` literals with `'implement'`.

6. **Edit `main/src/orchestrator/__tests__/stepTransitionBridge.test.ts`.** Apply dot→bare substitutions on each `buildStepTransitionEvent` arg and each `.toBe(...)` assertion. Update describe-block name from "returns stable dot-notation step ids" to "returns stable bare step ids matching WORKFLOW_DEFINITIONS".

7. **Add the new contract integration test to `main/src/orchestrator/trpc/routers/__tests__/runs.test.ts`.** Append:
   ```ts
   describe('end-to-end stepId contract parity (TERMINAL_STEP_IDS resolves into WORKFLOW_DEFINITIONS — fixes namespace mismatch)', () => {
     // per-workflow loop or per-workflow `it`
     for (const name of SOLOFLOW_WORKFLOW_NAMES) {
       it(`${name}: buildStepTransitionEvent → getPhaseState yields status=running for the resolved terminal step`, async () => {
         const stepId = resolveTerminalStepId(name);
         expect(stepId).not.toBeNull();
         const { adapter, caller } = await setupTestRouterWithWorkflow(name);
         const runId = await seedPhaseRun(adapter, { workflowName: name, currentStepId: null });
         buildStepTransitionEvent(runId, stepId!, 'running', adapter);
         const result = await caller.cyboflow.runs.getPhaseState({ runId });
         const match = result.stepStates.find((s) => s.stepId === stepId);
         expect(match).toBeDefined();
         expect(match!.status).toBe('running');
       });
     }
     afterEach(() => { stepTransitionEvents.removeAllListeners('transition'); });
   });
   ```

8. **Post-flight completeness gate.** Re-run the pre-flight grep — must return 0 matches.

9. **Run `pnpm --filter main test`** — must exit 0 and the new test block must appear in output.

10. **Update `.soloflow/active/findings/SPRINT-040-findings.md`** — append `resolved_by: TASK-779` to FIND-SPRINT-040-10 and FIND-SPRINT-040-13.

## Source

Compound proposal SPRINT-040 item B2 (CRITICAL severity); originally FIND-SPRINT-040-10 + FIND-SPRINT-040-13.
