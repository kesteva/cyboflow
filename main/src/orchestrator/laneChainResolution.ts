/**
 * laneChainResolution — resolve a run's LANE STEP VOCABULARY from its resolved
 * (frozen) workflow definition, instead of the fixed SPRINT_LANE_STEP_IDS
 * default.
 *
 * Workflow steps now declare a structured `fanOut` spec (shared/types/workflows.ts)
 * whose `inner[].id`s ARE the sprint-lane step vocabulary — user-editable via the
 * workflow editor (spec_json). The programmatic plane already derives its lane
 * driving straight from `step.fanOut.inner` (programmatic/workflowController.ts
 * runFanOut). This module is the ORCHESTRATED-plane mirror: given a runId, walk
 * its resolved definition (resolveRunFrozenSpec + resolveWorkflowDefinition — the
 * SAME frozen-spec contract every other per-run reader uses, e.g.
 * mcpQueryHandler.handleReportStep) and return the FIRST fanOut-bearing step's
 * inner chain. Three seams share this single resolution so they can't drift from
 * one another or from the programmatic plane:
 *   - mcpQueryHandler.handleUpdateSprintTask  (allowedStepIds for the MCP write)
 *   - sprintLaneStore.deriveLaneFromTaskDispatch (the PreToolUse auto-derive backstop)
 *   - verify/mergeGateLaneAdvance.ts          (the visual merge-gate's advance/loopback ids)
 *
 * Fail-soft by design: returns null when the run/definition is unresolvable or no
 * step declares `fanOut`. Every caller treats null as "fall back to the canonical
 * SPRINT_LANE_STEP_IDS / SPRINT_SUBAGENT_TO_LANE_STEP defaults", so an unedited
 * sprint/ship run (and any pre-fanOut-generalization DB) is byte-identical to
 * before this module existed.
 *
 * Standalone-typecheck invariant: reads through the narrow DatabaseLike surface
 * only (via resolveRunFrozenSpec) and imports only pure shared types — no
 * 'electron' / 'better-sqlite3' / service import. Safe for the callers above,
 * which carry the same invariant.
 */
import type { DatabaseLike } from './types';
import { resolveRunFrozenSpec } from './runFrozenSpec';
import { resolveWorkflowDefinition } from '../../../shared/types/workflows';
import type { FanOutInnerStep } from '../../../shared/types/workflows';

/**
 * Resolve the run's fan-out inner chain — the FIRST step carrying a `fanOut`
 * spec in the run's resolved definition, found by walking phases/steps in
 * order. v1 workflows declare at most one fan-out step (the sprint/ship
 * 'execute-tasks' step), but this does not assume that — it returns the first
 * match. Returns null when the run row is missing, the definition fails to
 * resolve (resolveWorkflowDefinition returns null), or no step declares
 * `fanOut`.
 */
export function resolveRunFanOutInner(db: DatabaseLike, runId: string): readonly FanOutInnerStep[] | null {
  const row = resolveRunFrozenSpec(db, runId);
  if (!row) return null;
  const def = resolveWorkflowDefinition(row.workflowName, row.specJson);
  if (def === null) return null;
  for (const phase of def.phases) {
    for (const step of phase.steps) {
      if (step.fanOut) return step.fanOut.inner;
    }
  }
  return null;
}
