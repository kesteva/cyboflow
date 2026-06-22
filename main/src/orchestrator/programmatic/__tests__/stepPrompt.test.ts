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

  it('renders the fan-out item block when item context is present', () => {
    const out = composeStepPrompt({
      step: step({ id: 'implement', name: 'Implement', agent: 'implement' }),
      workflowName: 'sprint',
      attempt: 1,
      item: { id: 'TASK-42', over: 'tasks' },
    });
    expect(out).toContain('PARALLEL fan-out');
    expect(out).toContain('**tasks**');
    expect(out).toContain('**TASK-42**');
    expect(out).toContain('do not touch other items');
  });

  it('is byte-identical to today when no item context is supplied', () => {
    const out = composeStepPrompt({
      step: step({ id: 'a', name: 'Step A', agent: 'executor', desc: 'Do the thing.' }),
      workflowName: 'planner',
      attempt: 1,
    });
    // No item ⇒ no fan-out block leaks into the single-step prompt.
    expect(out).not.toContain('PARALLEL fan-out');
    expect(out).toMatchInlineSnapshot(`
      "You are executing **one step** of the "planner" workflow in this git worktree.

      Step: **Step A** (id: \`a\`)

      Do the thing.

      Do ONLY this step:

      1. **Do the work.** Delegate to the \`cyboflow-executor\` subagent via the Task tool (the bundle is installed in this worktree); pass it the context it needs and read its result. Persist every cyboflow state change yourself via the \`cyboflow_*\` MCP tools — you are the single writer; subagents are edit-only.
      2. **Commit atomically.** Make ONE git commit for this step (\`<type>: <what changed>\`), staging only the files this step touched.
      3. **Stop.** Do NOT start any other step — the host orchestrator sequences the workflow and will invoke the next step itself. Report a one-line summary of what this step produced, then end your turn."
    `);
  });
});
