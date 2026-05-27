---
id: TASK-782
idea: SPRINT-040-compound
status: done
created: 2026-05-26T18:00:00Z
files_owned:
  - shared/types/workflows.ts
  - main/src/orchestrator/stepTransitionBridge.ts
  - main/src/orchestrator/trpc/routers/runs.ts
  - main/src/orchestrator/__tests__/stepTransitionBridge.test.ts
  - main/src/orchestrator/trpc/routers/__tests__/runs.test.ts
files_readonly:
  - main/src/orchestrator/trpc/routers/events.ts
  - main/src/index.ts
  - frontend/src/hooks/useWorkflowPhaseState.ts
  - docs/CODE-PATTERNS.md
acceptance_criteria:
  - criterion: "shared/types/workflows.ts exports a WorkflowStepTransitionEvent interface with fields { runId: string; stepId: string; status: WorkflowStepState['status']; timestamp: string }."
    verification: "grep -n 'export interface WorkflowStepTransitionEvent' shared/types/workflows.ts returns exactly 1 match; the status field uses indexed-access WorkflowStepState['status'] (not a re-declared union)."
  - criterion: "stepTransitionBridge.ts no longer declares WorkflowStepTransitionEvent inline; imports from shared/types/workflows.ts."
  - criterion: "stepTransitionBridge.ts re-exports WorkflowStepTransitionEvent so existing imports from the bridge continue to compile (transitional)."
  - criterion: "All non-bridge consumers import the type from shared/types/workflows.ts."
  - criterion: "pnpm typecheck exits 0."
  - criterion: "Bridge + runs unit suites pass with the relocated type."
depends_on: []
estimated_complexity: low
epic: workflow-phase-model
test_strategy:
  needed: false
  justification: "Pure type relocation with no runtime behavior change. The two existing sibling test files (stepTransitionBridge.test.ts, runs.test.ts) already type-annotate emitted events with WorkflowStepTransitionEvent — relocated declaration is structurally exercised once their imports are repointed."
---

# Promote WorkflowStepTransitionEvent to shared/types/workflows.ts

## Objective

Move the `WorkflowStepTransitionEvent` interface from `main/src/orchestrator/stepTransitionBridge.ts` into `shared/types/workflows.ts` alongside `WorkflowStepState`, so cross-process consumers can import the type from the shared types package per the docs/CODE-PATTERNS.md cross-package contract. Closes FIND-SPRINT-040-2.

## Implementation Steps

1. **Sweep grep** the full consumer set:
   ```bash
   grep -rn 'WorkflowStepTransitionEvent' main shared frontend --include='*.ts' --include='*.tsx'
   ```
   Expected: 4 import sites + 1 declaration site (will become re-export).

2. **Add the type to `shared/types/workflows.ts`** immediately after `WorkflowStepState`:
   ```ts
   export interface WorkflowStepTransitionEvent {
     runId: string;
     stepId: string;
     status: WorkflowStepState['status'];
     timestamp: string;
   }
   ```
   Use indexed-access `WorkflowStepState['status']` so the status union cannot drift.

3. **Edit `stepTransitionBridge.ts`:**
   - Delete the inline declaration block.
   - Add to the existing import: `import type { SoloFlowWorkflowName, WorkflowStepTransitionEvent } from '../../../shared/types/workflows';`.
   - Add a transitional re-export: `export type { WorkflowStepTransitionEvent } from '../../../shared/types/workflows';`.

4. **Repoint consumer imports** (3 files):
   - `main/src/orchestrator/trpc/routers/runs.ts:17` — change type import path to `'../../../../../shared/types/workflows'` (mirror sibling WorkflowRunListRow import on line 15).
   - `main/src/orchestrator/__tests__/stepTransitionBridge.test.ts:16-20` — split type/value imports; type import from `'../../../../shared/types/workflows'`.
   - `main/src/orchestrator/trpc/routers/__tests__/runs.test.ts:62` — change type import path to `'../../../../../../shared/types/workflows'`.

5. **Post-flight grep** confirms zero remaining type imports from the bridge file co-occur with `WorkflowStepTransitionEvent` on the same line.

6. **Verify**: `pnpm typecheck` exits 0; `pnpm --filter main test -- stepTransitionBridge runs` exits 0.

## Source

Compound proposal SPRINT-040 item B5; originally FIND-SPRINT-040-2.
