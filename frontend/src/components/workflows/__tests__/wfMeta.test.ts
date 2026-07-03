/**
 * wfMeta tests — the derived headline counts for the three built-in workflows
 * (planner / sprint / compound), asserted against the canonical
 * WORKFLOW_DEFINITIONS so the numbers stay pinned to the source definitions.
 */
import { describe, it, expect } from 'vitest';
import { wfMeta } from '../wfMeta';
import {
  WORKFLOW_DEFINITIONS,
  type WorkflowDefinition,
} from '../../../../../shared/types/workflows';

describe('wfMeta', () => {
  it('planner: 2 phases, 10 steps, 4 human gates, 0 loops', () => {
    expect(wfMeta(WORKFLOW_DEFINITIONS.planner)).toEqual({
      phases: 2,
      steps: 10,
      human: 4,
      loops: 0,
    });
  });

  it('sprint: 3 phases, 5 steps, 1 human gate, 0 loops', () => {
    expect(wfMeta(WORKFLOW_DEFINITIONS.sprint)).toEqual({
      phases: 3,
      steps: 5,
      human: 1,
      loops: 0,
    });
  });

  it('compound: 1 phase, 4 steps, 1 human gate, 0 loops', () => {
    expect(wfMeta(WORKFLOW_DEFINITIONS.compound)).toEqual({
      phases: 1,
      steps: 4,
      human: 1,
      loops: 0,
    });
  });

  it('counts both agent==="human" and step.human, and loopback edges', () => {
    const def: WorkflowDefinition = {
      id: 'fixture',
      phases: [
        {
          id: 'p1',
          label: 'Plan',
          color: '#3b6dd6',
          steps: [
            // human via step.human (non-human agent)
            { id: 'a', name: 'A', agent: 'context', mcps: [], retries: 0, human: true },
            // human via agent === 'human'
            { id: 'b', name: 'B', agent: 'human', mcps: [], retries: 0 },
            // a loopback edge
            { id: 'c', name: 'C', agent: 'implement', mcps: [], retries: 1, loopback: 'a' },
          ],
        },
      ],
    };
    expect(wfMeta(def)).toEqual({ phases: 1, steps: 3, human: 2, loops: 1 });
  });
});
