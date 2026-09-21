import { describe, expect, it } from 'vitest';
import { seedKindAccepts, seedKindForWorkflow } from '../workflowSeedKind';
import { WORKFLOW_DEFINITIONS, type WorkflowDefinition } from '../../types/workflows';

/** A custom flow cloned from a built-in keeps the built-in's definition id. */
function cloneAs(id: string, from: WorkflowDefinition): WorkflowDefinition {
  return { ...JSON.parse(JSON.stringify(from)), id } as WorkflowDefinition;
}

describe('seedKindForWorkflow', () => {
  it('maps every built-in by its definition id', () => {
    expect(seedKindForWorkflow(WORKFLOW_DEFINITIONS.sprint)).toBe('tasks');
    expect(seedKindForWorkflow(WORKFLOW_DEFINITIONS.planner)).toBe('ideas');
    expect(seedKindForWorkflow(WORKFLOW_DEFINITIONS.ship)).toBe('idea');
    expect(seedKindForWorkflow(WORKFLOW_DEFINITIONS.compound)).toBe('findings');
    expect(seedKindForWorkflow(WORKFLOW_DEFINITIONS.launch)).toBe('none');
    expect(seedKindForWorkflow(WORKFLOW_DEFINITIONS['verify-setup'])).toBe('none');
  });

  it('a custom flow whose definition keeps a built-in id (a clone) takes that id\'s kind', () => {
    // `dash` — a custom sprint clone whose definition.id is still 'sprint'.
    expect(seedKindForWorkflow(WORKFLOW_DEFINITIONS.sprint)).toBe('tasks');
  });

  it('reads a custom sprint-shaped flow (task fan-out, custom id) structurally', () => {
    expect(seedKindForWorkflow(cloneAs('dash', WORKFLOW_DEFINITIONS.sprint))).toBe('tasks');
  });

  it('reads a custom planner-shaped flow (context + approve-idea, no task fan-out) structurally', () => {
    expect(seedKindForWorkflow(cloneAs('my-planner', WORKFLOW_DEFINITIONS.planner))).toBe('ideas');
  });

  it('reads a custom ship-shaped flow (context + task fan-out) as single-idea seeded', () => {
    expect(seedKindForWorkflow(cloneAs('my-ship', WORKFLOW_DEFINITIONS.ship))).toBe('idea');
  });

  it('reads a custom compound-shaped flow (load-sprint) structurally', () => {
    expect(seedKindForWorkflow(cloneAs('my-compound', WORKFLOW_DEFINITIONS.compound))).toBe('findings');
  });

  it('a flow with no seed step takes no seed', () => {
    const bare: WorkflowDefinition = {
      id: 'docs-review',
      phases: [
        {
          id: 'review',
          label: 'Review',
          color: '#112233',
          steps: [{ id: 'read', name: 'Read', agent: 'docs-writer', mcps: [], retries: 0 }],
        },
      ],
    } as unknown as WorkflowDefinition;
    expect(seedKindForWorkflow(bare)).toBe('none');
  });
});

describe('seedKindAccepts', () => {
  it('taskIds only seed a tasks flow; ideaIds seed both idea kinds; findingIds only findings', () => {
    expect(seedKindAccepts('tasks', 'taskIds')).toBe(true);
    expect(seedKindAccepts('idea', 'taskIds')).toBe(false);
    expect(seedKindAccepts('ideas', 'ideaIds')).toBe(true);
    expect(seedKindAccepts('idea', 'ideaIds')).toBe(true);
    expect(seedKindAccepts('tasks', 'ideaIds')).toBe(false);
    expect(seedKindAccepts('findings', 'findingIds')).toBe(true);
    expect(seedKindAccepts('none', 'findingIds')).toBe(false);
  });
});
