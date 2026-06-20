import { describe, it, expect } from 'vitest';
import { composeStepPrompt } from '../stepPrompt';
import type { WorkflowStep } from '../../../../../shared/types/workflows';

function step(p: Partial<WorkflowStep> & { id: string }): WorkflowStep {
  return { name: p.id, agent: 'executor', mcps: [], retries: 0, ...p };
}

describe('composeStepPrompt', () => {
  it('scopes the prompt to one step and names its subagent', () => {
    const out = composeStepPrompt({ step: step({ id: 'epics', name: 'Create epics', agent: 'epics' }), workflowName: 'planner', attempt: 1 });
    expect(out).toContain('one step');
    expect(out).toContain('`epics`');
    expect(out).toContain('Create epics');
    expect(out).toContain('cyboflow-epics');
    expect(out).toContain('"planner" workflow');
    // Tells the agent NOT to advance — the host sequences.
    expect(out).toContain('Do NOT start any other step');
  });

  it('includes the step description when present', () => {
    const out = composeStepPrompt({ step: step({ id: 'a', desc: 'Capture the idea.' }), workflowName: 'planner', attempt: 1 });
    expect(out).toContain('Capture the idea.');
  });

  it('adds a retry note only on attempts after the first', () => {
    expect(composeStepPrompt({ step: step({ id: 'a' }), workflowName: 'w', attempt: 1 })).not.toContain('attempt');
    const retry = composeStepPrompt({ step: step({ id: 'a' }), workflowName: 'w', attempt: 3 });
    expect(retry).toContain('attempt 3');
  });
});
