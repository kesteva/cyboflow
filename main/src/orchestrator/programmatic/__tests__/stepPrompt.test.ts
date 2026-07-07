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

  // -------------------------------------------------------------------------
  // Artifact follow-up — the programmatic plane has no top-level agent to read
  // planner.md's "after your subagent returns, report/fold this" prose, so
  // composeStepPrompt must inline the same instruction per outputArtifact atype
  // or the artifact silently never gets minted. 2026-07-06.
  // -------------------------------------------------------------------------

  it('instructs a ui-prototype step to extract the URL and call cyboflow_report_artifact', () => {
    const out = composeStepPrompt({
      step: step({
        id: 'ui-prototype',
        name: 'UI prototype',
        agent: 'ui-prototype',
        outputArtifact: { atype: 'ui-prototype', label: 'UI prototype' },
      }),
      workflowName: 'planner',
      attempt: 1,
    });
    expect(out).toContain('## Artifact to report');
    expect(out).toContain('cyboflow_report_artifact');
    expect(out).toContain("atype: 'ui-prototype'");
    expect(out).toContain('"UI prototype"');
    expect(out).toContain('{"url": "<the url>"}');
  });

  it('instructs an architecture step to fold the section into the idea body via cyboflow_update_task, not report_artifact', () => {
    const out = composeStepPrompt({
      step: step({
        id: 'architecture',
        name: 'Architecture design',
        agent: 'architecture',
        outputArtifact: { atype: 'arch-design', label: 'Architecture design' },
      }),
      workflowName: 'planner',
      attempt: 1,
    });
    expect(out).toContain('## Artifact to report');
    expect(out).toContain('cyboflow_update_task');
    expect(out).toContain('## Architecture design');
    expect(out).toContain('REPLACE that section');
    expect(out).not.toContain('report_artifact');
  });

  it('adds no artifact addendum for an outputArtifact atype that mints without a follow-up (idea-spec)', () => {
    const out = composeStepPrompt({
      step: step({
        id: 'context',
        name: 'Get context on user idea',
        agent: 'context',
        outputArtifact: { atype: 'idea-spec', label: 'Idea spec' },
      }),
      workflowName: 'planner',
      attempt: 1,
    });
    expect(out).not.toContain('## Artifact to report');
  });

  it('adds no artifact addendum when the step has no outputArtifact at all', () => {
    const out = composeStepPrompt({
      step: step({ id: 'approve-idea', name: 'Approve idea spec', agent: 'human' }),
      workflowName: 'planner',
      attempt: 1,
    });
    expect(out).not.toContain('## Artifact to report');
  });

  it('composes the artifact addendum correctly with the fan-out item context variant', () => {
    const out = composeStepPrompt({
      step: step({
        id: 'ui-prototype',
        name: 'UI prototype',
        agent: 'ui-prototype',
        outputArtifact: { atype: 'ui-prototype', label: 'UI prototype' },
      }),
      workflowName: 'planner',
      attempt: 1,
      item: { id: 'IDEA-1', over: 'ideas' },
    });
    expect(out).toContain('PARALLEL fan-out');
    expect(out).toContain('## Artifact to report');
    expect(out).toContain('cyboflow_report_artifact');
  });

  // -------------------------------------------------------------------------
  // Operator guidance — mid-run steering text (RunDirectives) appended as a tail
  // section. Present ONLY when the operator steered this step; empty/whitespace
  // or absent ⇒ no section (output unchanged).
  // -------------------------------------------------------------------------

  it('renders an Operator guidance section when userGuidance is provided', () => {
    const out = composeStepPrompt({
      step: step({ id: 'implement', name: 'Implement', agent: 'implement' }),
      workflowName: 'sprint',
      attempt: 1,
      userGuidance: 'Keep the change under the feature flag.',
    });
    expect(out).toContain('## Operator guidance');
    expect(out).toContain('Keep the change under the feature flag.');
  });

  it('omits the Operator guidance section when userGuidance is undefined', () => {
    const out = composeStepPrompt({
      step: step({ id: 'a' }),
      workflowName: 'sprint',
      attempt: 1,
    });
    expect(out).not.toContain('## Operator guidance');
  });

  it('omits the Operator guidance section when userGuidance is empty / whitespace', () => {
    const out = composeStepPrompt({
      step: step({ id: 'a' }),
      workflowName: 'sprint',
      attempt: 1,
      userGuidance: '   ',
    });
    expect(out).not.toContain('## Operator guidance');
  });
});
