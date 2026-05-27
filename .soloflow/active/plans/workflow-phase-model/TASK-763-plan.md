---
id: TASK-763
idea: IDEA-026
status: ready
created: 2026-05-26T16:00:00Z
files_owned:
  - shared/types/workflows.ts
files_readonly:
  - docs/protoflow-design/README.md
  - docs/protoflow-design/direction-a.jsx
  - docs/protoflow-design/data.js
  - .soloflow/active/ideas/IDEA-026.md
  - .soloflow/active/research/IDEA-026-research.md
  - main/src/orchestrator/workflowRegistry.ts
acceptance_criteria:
  - criterion: "shared/types/workflows.ts exports a WorkflowPhase interface with the fields id, label, color, and steps (WorkflowStep[])."
    verification: "grep -nE '^export (interface|type) WorkflowPhase' shared/types/workflows.ts returns exactly one match, and grep -nE '\\b(id|label|color|steps):' surrounding that block confirms all four fields."
  - criterion: "shared/types/workflows.ts exports a WorkflowStep interface with id (string), name (string), agent (string), mcps (string[]), retries (number), and optional fields optional?, human?, loopback?, desc."
    verification: "grep -nE '^export (interface|type) WorkflowStep\\b' shared/types/workflows.ts returns exactly one match; cat shared/types/workflows.ts and visually confirm the field set; running pnpm typecheck succeeds."
  - criterion: "shared/types/workflows.ts exports a WorkflowDefinition interface with id: SoloFlowWorkflowName and phases: WorkflowPhase[]."
    verification: "grep -nE '^export (interface|type) WorkflowDefinition' shared/types/workflows.ts returns exactly one match; the id field type resolves to SoloFlowWorkflowName under tsc."
  - criterion: "shared/types/workflows.ts exports a WorkflowStepState interface with stepId: string and status: 'pending' | 'running' | 'done'."
    verification: "grep -nE '^export (interface|type) WorkflowStepState' shared/types/workflows.ts returns exactly one match; the status union exactly matches the three literals."
  - criterion: "shared/types/workflows.ts exports a constant named WORKFLOW_DEFINITIONS typed as Readonly<Record<SoloFlowWorkflowName, WorkflowDefinition>> containing exactly five keys: soloflow, planner, sprint, compound, prune."
    verification: "grep -nE 'export const WORKFLOW_DEFINITIONS' shared/types/workflows.ts returns one match; visual confirmation that all five SoloFlowWorkflowName keys appear in the object literal."
  - criterion: "Every WorkflowStep across all 5 definitions has a stable string id (kebab-case strings, not array-index ids). Step ids must be unique within a phase."
    verification: "Visual review: every step entry has an id: 'kebab-case-string'. Run pnpm typecheck to confirm shape."
  - criterion: "Any WorkflowStep with a loopback field has loopback typed as string referencing the id of another step within the SAME phase (intra-phase loopbacks only in v1)."
    verification: "Visual review of WORKFLOW_DEFINITIONS — each loopback target value must equal an id present on the same phase's steps array. pnpm typecheck must succeed."
  - criterion: "pnpm typecheck (workspace-wide) passes with no new errors after this change."
    verification: "Run pnpm typecheck; exit code 0; stdout shows 0 errors that are attributable to shared/types/workflows.ts."
  - criterion: "All existing imports of shared/types/workflows (PermissionMode, WorkflowRow, WorkflowRunRow, WorkflowRunListRow, SOLOFLOW_WORKFLOW_NAMES, SoloFlowWorkflowName) continue to resolve unchanged."
    verification: "grep -rn \"from .*shared/types/workflows\" --include='*.ts' --include='*.tsx' . shows the existing import sites and pnpm typecheck passes (zero downstream breakage)."
depends_on: []
estimated_complexity: medium
epic: workflow-phase-model
test_strategy:
  needed: false
  justification: "shared/types/workflows.ts is a pure type and data module with no runtime behavior beyond a static const object literal. There are no sibling test files under shared/types/ (Glob 'shared/types/*.test.ts' → no matches; Glob 'shared/**/__tests__/**' → no matches). Structural correctness of WORKFLOW_DEFINITIONS is enforced by the TypeScript compiler at build time. Downstream tasks (TASK-764 migration, TASK-765 runner instrumentation, TASK-766 tRPC) will add behavioral tests that transitively exercise WORKFLOW_DEFINITIONS."
---

# Define WorkflowDefinition type system and hardcode 5 starter definitions

## Objective

Extend `shared/types/workflows.ts` with the first-class phase/step data model that downstream tasks (TASK-764 migration, TASK-765 runner instrumentation, TASK-766 tRPC, and the workflow-progress-visualization epic) will consume. Add four new exported types — `WorkflowPhase`, `WorkflowStep`, `WorkflowDefinition`, `WorkflowStepState` — and one new exported constant `WORKFLOW_DEFINITIONS` holding cyboflow-shaped phase/step structures for each of the five `SoloFlowWorkflowName` values. This task is types + static data ONLY: no migration, no runtime behavior, no tRPC surface, no imports of these new exports added elsewhere in this change.

## Implementation Steps

1. Open `shared/types/workflows.ts`. Preserve the existing `PermissionMode`, `WorkflowRow`, `WorkflowRunRow`, `WorkflowRunListRow`, `SOLOFLOW_WORKFLOW_NAMES`, `SoloFlowWorkflowName` exports verbatim — downstream imports depend on them.

2. Below the existing `SoloFlowWorkflowName` export, add the four new type declarations:
   - `WorkflowStep { id, name, agent, mcps, retries, optional?, human?, loopback?, desc? }` — stable kebab-case `id`, JSDoc documenting the intra-phase-loopback invariant for v1.
   - `WorkflowPhase { id, label, color, steps: WorkflowStep[] }` — `color` is a 7-char hex string matching the protoflow phase palette.
   - `WorkflowDefinition { id: SoloFlowWorkflowName; phases: WorkflowPhase[] }`.
   - `WorkflowStepState { stepId: string; status: 'pending' | 'running' | 'done' }`.

3. Add the hardcoded `WORKFLOW_DEFINITIONS` constant typed as `Readonly<Record<SoloFlowWorkflowName, WorkflowDefinition>>` so the compiler enforces all five keys.

4. Fill in each definition using `docs/protoflow-design/data.js` as the structural reference:
   - **soloflow** (5 phases): plan (#3b6dd6), refine (#5a4ad6), execute (#c96442, with `task-verify → implement` loopback), sprint-review (#a87a2c), compound (#8b5cf6).
   - **planner** (2 phases): plan + refine.
   - **sprint** (2 phases): execute + sprint-review.
   - **compound** (1 phase): compound.
   - **prune** (1 phase, #8a4a4a).

   Per-step fields: pull `agent`, `mcps`, `retries`, `optional`, `human`, `loopback`, `desc` from `data.js`. Do NOT introduce new agents, MCPs, or phase ids beyond what `data.js` uses.

5. Loopback discipline: in `data.js`, the only loopback is `task-verify → implement` inside the `execute` phase. Mirror that exactly in soloflow and sprint. Do NOT add cross-phase loopbacks.

6. Do NOT add any imports of the new types/constant to any other file in this change. Downstream tasks introduce the first consumers.

7. Run `pnpm typecheck` and confirm exit code 0.

## Acceptance Criteria

Restated from frontmatter. Five-key completeness enforced by the `Readonly<Record<SoloFlowWorkflowName, WorkflowDefinition>>` annotation. No downstream breakage: 15 existing import sites continue to resolve unchanged.

## Test Strategy

`test_strategy.needed: false`. Pure type + static-data module. No existing test files under `shared/types/` (Glob confirmed). New type declarations have no runtime behavior; `WORKFLOW_DEFINITIONS` correctness is enforced by its `Readonly<Record<SoloFlowWorkflowName, WorkflowDefinition>>` annotation. Downstream tasks own behavioral tests.

## Hardest Decision

**How to type `WORKFLOW_DEFINITIONS` so the compiler enforces five-key completeness.** Chose `Readonly<Record<SoloFlowWorkflowName, WorkflowDefinition>>` annotation + `as const` literal — same pattern `SOLOFLOW_WORKFLOW_NAMES` already uses. Forces missing-key errors at compile time; preserves narrow phase/step literal types.

## Rejected Alternatives

1. **Parse YAML at workflow_path and populate spec_json at run-start.** Rejected — YAML lives in `soloflow-dev` plugin, not cyboflow; Direction-A editor needs first-class data structures.
2. **Store definitions in `workflows.spec_json` TEXT column.** Rejected — research Area F confirmed `workflowRegistry.getById()` and `WorkflowRow` both omit `spec_json`; v1 is hardcoded per IDEA-026 Q4 answer.
3. **Treat `loopback` as a separate edge list (n8n/ReactFlow style).** Rejected — protoflow phases→steps shape is idiomatic for editor-mutable pipelines.
4. **Cross-phase loopback semantics.** Rejected — `data.js` only uses intra-phase; JSDoc declares the v1 invariant.

## Lowest Confidence Area

**`WorkflowStep.agent` is typed as `string` for v1.** If a future task adds a typed `AgentId` union, tightening could fail for unanticipated values. Mitigation: JSDoc documents the v1 deliberate string; future tightening grep is single-file (the `WORKFLOW_DEFINITIONS` literal).

Secondary: `phase.color` is typed `string` (not a literal union). Intentional looseness pending a future design-system task.
