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

  it('omits the fan-out and sprint-task blocks when no item / scope is supplied', () => {
    const out = composeStepPrompt({
      step: step({ id: 'a', name: 'Step A', agent: 'executor', desc: 'Do the thing.' }),
      workflowName: 'planner',
      attempt: 1,
    });
    // No item ⇒ no fan-out block; no scope ⇒ no sprint-tasks block leaks in.
    expect(out).not.toContain('PARALLEL fan-out');
    expect(out).not.toContain('# Sprint tasks');
    // The single-step skeleton is still intact.
    expect(out).toContain('Step: **Step A** (id: `a`)');
    expect(out).toContain('Do the thing.');
    expect(out).toContain('cyboflow-executor');
  });

  // -------------------------------------------------------------------------
  // Hardening — pin the subagent + faithful persistence + DB-canonical scope.
  // These guard against the programmatic step agent improvising (general-purpose
  // fallback, disk-state probing, collapsing real edges to "none"). 2026-06-22.
  // -------------------------------------------------------------------------

  it('pins delegation to the installed subagent and forbids the general-purpose fallback', () => {
    const out = composeStepPrompt({
      step: step({ id: 'analyze-dependencies', name: 'Analyze deps', agent: 'dependency-analyzer' }),
      workflowName: 'sprint',
      attempt: 1,
    });
    expect(out).toContain('cyboflow-dependency-analyzer');
    expect(out).toContain('EXACT `subagent_type`');
    expect(out).toContain('do NOT fall back to `general-purpose`');
  });

  it('requires faithfully persisting every returned item (no collapsing edges to "none")', () => {
    const out = composeStepPrompt({ step: step({ id: 'a' }), workflowName: 'sprint', attempt: 1 });
    expect(out).toContain('recording EVERY item the subagent returns');
    expect(out).toContain('cyboflow_add_task_dependency');
    expect(out).toContain('never collapse a non-empty result to "none"');
  });

  it('declares the database canonical and forbids deciding scope/status from disk state', () => {
    const out = composeStepPrompt({ step: step({ id: 'a' }), workflowName: 'sprint', attempt: 1 });
    expect(out).toContain('single source of truth');
    expect(out).toContain('never read on-disk or worktree state files');
  });

  // -------------------------------------------------------------------------
  // Grounding — the `taskScope` block (the linchpin fix for the dependency
  // analyzer concluding "No dependencies" because it never saw the tasks).
  // -------------------------------------------------------------------------

  it('injects the sprint task scope as a `# Sprint tasks` block when provided', () => {
    const out = composeStepPrompt({
      step: step({ id: 'analyze-dependencies', name: 'Analyze deps', agent: 'dependency-analyzer' }),
      workflowName: 'sprint',
      attempt: 1,
      taskScope: '## TASK-001: Init Vite\n\nScaffold the app.\n\n## TASK-002: Add Tailwind\n\nDepends on the scaffold.',
    });
    expect(out).toContain('# Sprint tasks');
    expect(out).toContain('## TASK-001: Init Vite');
    expect(out).toContain('## TASK-002: Add Tailwind');
    expect(out).toContain('EXACT tasks in scope');
    expect(out).toContain('do NOT hunt for task files');
  });

  it('omits the task block when taskScope is empty / whitespace', () => {
    const out = composeStepPrompt({
      step: step({ id: 'a' }),
      workflowName: 'sprint',
      attempt: 1,
      taskScope: '   ',
    });
    expect(out).not.toContain('# Sprint tasks');
  });
});
