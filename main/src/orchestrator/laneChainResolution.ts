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
 * mcpQueryHandler.handleReportStep) and return the id-deduped UNION of every
 * fanOut-bearing step's inner chain (see resolveRunFanOutInner's doc for why the
 * union, not just the first match). Three seams share this single resolution so
 * they can't drift from one another or from the programmatic plane:
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
 * Resolve the run's fan-out lane vocabulary — the inner chains of EVERY step
 * carrying a `fanOut` spec in the run's resolved definition, concatenated in
 * phases/steps walk order and deduplicated by step id (first occurrence wins).
 *
 * ALL fan-out steps contribute, not just the first, because the orchestrated
 * prompt generator (`buildFanOutAppend`, prompts/fan-out-instructions.ts) emits
 * one instruction section PER fanOut step — an edited workflow with two fan-out
 * steps instructs the orchestrator to write the SECOND chain's step ids too,
 * and a first-chain-only vocabulary here would reject those valid writes as
 * out-of-vocabulary. v1 built-ins declare exactly one fan-out step, for which
 * the union IS that step's inner chain — byte-identical to before.
 *
 * Multi-fan-out caveat (edited workflows only): consumers that pick ONE id out
 * of the chain (mergeGateLaneAdvance's default loopback, the dispatch
 * backstop's agent→step map) resolve against the merged chain, so a canonical
 * id appearing in both chains resolves to its first occurrence.
 *
 * Returns null when the run row is missing, the definition fails to resolve
 * (resolveWorkflowDefinition returns null), or no step contributes any inner
 * id — every caller treats null as the canonical-fallback signal.
 */
export function resolveRunFanOutInner(db: DatabaseLike, runId: string): readonly FanOutInnerStep[] | null {
  const row = resolveRunFrozenSpec(db, runId);
  if (!row) return null;
  const def = resolveWorkflowDefinition(row.workflowName, row.specJson);
  if (def === null) return null;
  const seen = new Set<string>();
  const union: FanOutInnerStep[] = [];
  for (const phase of def.phases) {
    for (const step of phase.steps) {
      if (step.fanOut === undefined) continue;
      for (const innerStep of step.fanOut.inner) {
        if (seen.has(innerStep.id)) continue;
        seen.add(innerStep.id);
        union.push(innerStep);
      }
    }
  }
  return union.length > 0 ? union : null;
}
