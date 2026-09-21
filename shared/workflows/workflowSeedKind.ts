/**
 * workflowSeedKind — which seed a workflow accepts at launch, derived from its
 * DEFINITION rather than from the row's display name (TASK-294).
 *
 * Every launch seam used to key seed mapping on the built-in name
 * (`workflow.name === 'sprint' ? taskIds : undefined`, and the launcher's
 * matching guards). A CUSTOM flow cloned from a built-in — say `dash`, whose
 * definition is sprint-shaped — therefore launched with no seeds at all, or was
 * refused by the guard. The shape is what actually consumes a seed: the
 * programmatic fan-out driver resolves `fanOut.over:'tasks'` off the run's
 * batch, the plan phase's `context` step reads the seed idea, the compound
 * `load-sprint` step reads `seed_finding_ids`. So the shape is what decides.
 *
 * Pure and Node-free so both processes (the launcher, the proposal wiring, the
 * renderer's launch surfaces) resolve the same answer.
 */
import { isCyboflowWorkflowName, type CyboflowWorkflowName, type WorkflowDefinition } from '../types/workflows';

/**
 * - `tasks`    — sprint-shaped: a task fan-out step; seeded with `seedTaskIds`.
 * - `ideas`    — planner-shaped: a `context` step and no task fan-out; seeded
 *                with one or more idea ids.
 * - `idea`     — ship-shaped: a `context` step AND a task fan-out; seeded with
 *                a single idea id (the plan half consumes it, the sprint half
 *                materializes its own batch).
 * - `findings` — compound-shaped: a `load-sprint` step; seeded with review-item ids.
 * - `none`     — takes no seed (launch, verify-setup, or any flow with no seed step).
 */
export type WorkflowSeedKind = 'tasks' | 'ideas' | 'idea' | 'findings' | 'none';

/** The seed kind of each built-in, by its (frozen) definition id. */
const BUILT_IN_SEED_KIND: Record<CyboflowWorkflowName, WorkflowSeedKind> = {
  sprint: 'tasks',
  planner: 'ideas',
  ship: 'idea',
  compound: 'findings',
  launch: 'none',
  'verify-setup': 'none',
};

/** Every step of the definition, fan-out inner steps excluded (they never seed). */
function stepIds(definition: WorkflowDefinition): Set<string> {
  const ids = new Set<string>();
  for (const phase of definition.phases) for (const step of phase.steps) ids.add(step.id);
  return ids;
}

function hasTaskFanOut(definition: WorkflowDefinition): boolean {
  for (const phase of definition.phases) {
    for (const step of phase.steps) {
      if (step.fanOut !== undefined && step.fanOut.over === 'tasks') return true;
    }
  }
  return false;
}

/**
 * Derive the seed kind from a definition. A definition whose `id` is a
 * built-in name (the built-ins themselves, and any custom flow cloned from one
 * — the clone keeps the id) takes that built-in's kind directly; anything else
 * is read structurally from its steps.
 */
export function seedKindForWorkflow(definition: WorkflowDefinition): WorkflowSeedKind {
  if (isCyboflowWorkflowName(definition.id)) return BUILT_IN_SEED_KIND[definition.id];
  const ids = stepIds(definition);
  const taskFanOut = hasTaskFanOut(definition);
  if (ids.has('context') && ids.has('approve-idea')) return taskFanOut ? 'idea' : 'ideas';
  if (taskFanOut) return 'tasks';
  if (ids.has('load-sprint')) return 'findings';
  return 'none';
}

/** True when a `seedKind` flow consumes the given launch seed field. */
export function seedKindAccepts(seedKind: WorkflowSeedKind, seed: 'taskIds' | 'ideaIds' | 'findingIds'): boolean {
  switch (seed) {
    case 'taskIds':
      return seedKind === 'tasks';
    case 'ideaIds':
      return seedKind === 'ideas' || seedKind === 'idea';
    case 'findingIds':
      return seedKind === 'findings';
  }
}
