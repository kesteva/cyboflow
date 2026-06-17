/**
 * wfMeta — derive the small headline counts shown on a workflow gallery card
 * (and the wf-shell meta strip) from a resolved {@link WorkflowDefinition}.
 *
 * PURE + presentational: it walks the static definition only — no run state, no
 * subscription. The four counts:
 *   - steps  — total steps across every phase.
 *   - phases — number of phases.
 *   - human  — steps that pause for a human (`agent === 'human'` OR `step.human`).
 *   - loops  — steps carrying a truthy `loopback` (intra-phase retry edge).
 */
import type { WorkflowDefinition } from '../../../../shared/types/workflows';
import { HUMAN_GATE_AGENT } from '../../../../shared/types/agentIdentity';

export interface WfMeta {
  steps: number;
  phases: number;
  human: number;
  loops: number;
}

export function wfMeta(def: WorkflowDefinition): WfMeta {
  let steps = 0;
  let human = 0;
  let loops = 0;
  for (const phase of def.phases) {
    for (const step of phase.steps) {
      steps += 1;
      if (step.agent === HUMAN_GATE_AGENT || step.human === true) human += 1;
      if (step.loopback) loops += 1;
    }
  }
  return { steps, phases: def.phases.length, human, loops };
}
