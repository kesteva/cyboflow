/**
 * proposalExecutorLaunchDeps — the launch-run closure's two decisions (TASK-294):
 * which workflow row a proposal launches (by id, else by name, custom flows
 * included, project rows shadowing global ones) and which seeds reach the
 * launcher (by the flow's SHAPE, with the rest reported as ignored).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  buildProposalExecutorLaunchDeps,
  partitionLaunchSeeds,
  resolveLaunchWorkflowRow,
  type ProposalExecutorLaunchCollaborators,
} from './proposalExecutorLaunchDeps';
import { WORKFLOW_DEFINITIONS, type WorkflowDefinition, type WorkflowRow } from '../../../../shared/types/workflows';

function row(id: string, name: string, projectId: number | null, specJson: string | null = null): WorkflowRow {
  return {
    id,
    project_id: projectId,
    name,
    workflow_path: null,
    permission_mode: 'default',
    spec_json: specJson,
    tuning_level: 'standard',
    runtime_mix: null,
    created_at: 'now',
    archived_at: null,
  } as unknown as WorkflowRow;
}

/** A custom sprint clone whose definition keeps sprint's id (what the editor's "duplicate" produces). */
const DASH_SPEC = JSON.stringify(WORKFLOW_DEFINITIONS.sprint);
/** A custom planner-shaped flow under its own id. */
const MY_PLANNER_SPEC = JSON.stringify({ ...(JSON.parse(JSON.stringify(WORKFLOW_DEFINITIONS.planner)) as WorkflowDefinition), id: 'my-planner' });

const ROWS: WorkflowRow[] = [
  row('wf-sprint', 'sprint', null),
  row('wf-planner', 'planner', null),
  row('wf-dash', 'dash', null, DASH_SPEC),
  row('wf-p1-dash', 'dash', 1, DASH_SPEC),
  row('wf-p1-my-planner', 'my-planner', 1, MY_PLANNER_SPEC),
  row('wf-p2-secret', 'secret', 2, DASH_SPEC),
];

function registry(): ProposalExecutorLaunchCollaborators['workflowRegistry'] {
  return {
    getById: (id) => ROWS.find((r) => r.id === id) ?? null,
    listByProject: (projectId) => ROWS.filter((r) => r.project_id === null || r.project_id === projectId),
    getEffectiveDefinition: (id) => {
      const r = ROWS.find((w) => w.id === id);
      if (!r) return null;
      if (r.spec_json !== null) return JSON.parse(r.spec_json) as WorkflowDefinition;
      return (WORKFLOW_DEFINITIONS as Record<string, WorkflowDefinition>)[r.name] ?? null;
    },
  };
}

describe('resolveLaunchWorkflowRow', () => {
  it('resolves by workflowId only when the row is global or the project\'s own', () => {
    const reg = registry();
    expect(resolveLaunchWorkflowRow(reg, { projectId: 1, workflowId: 'wf-dash', workflowName: 'x' })?.id).toBe('wf-dash');
    expect(resolveLaunchWorkflowRow(reg, { projectId: 2, workflowId: 'wf-p2-secret', workflowName: 'x' })?.id).toBe('wf-p2-secret');
    expect(resolveLaunchWorkflowRow(reg, { projectId: 1, workflowId: 'wf-p2-secret', workflowName: 'x' })).toBeNull();
    expect(resolveLaunchWorkflowRow(reg, { projectId: 1, workflowId: 'wf-missing', workflowName: 'x' })).toBeNull();
  });

  it('resolves by name among the visible rows, preferring the project-scoped one', () => {
    const reg = registry();
    expect(resolveLaunchWorkflowRow(reg, { projectId: 1, workflowName: 'dash' })?.id).toBe('wf-p1-dash');
    expect(resolveLaunchWorkflowRow(reg, { projectId: 2, workflowName: 'dash' })?.id).toBe('wf-dash');
    expect(resolveLaunchWorkflowRow(reg, { projectId: 1, workflowName: 'sprint' })?.id).toBe('wf-sprint');
    expect(resolveLaunchWorkflowRow(reg, { projectId: 1, workflowName: 'secret' })).toBeNull();
  });
});

describe('partitionLaunchSeeds', () => {
  it('routes each seed field by shape and reports the rest as ignored', () => {
    expect(partitionLaunchSeeds('tasks', { taskIds: ['T1'], findingIds: ['F1'] })).toEqual({
      seedTaskIds: ['T1'],
      findingIds: undefined,
      ideaId: undefined,
      launchOptions: undefined,
      ignoredSeeds: ['findingIds'],
    });
    expect(partitionLaunchSeeds('ideas', { ideaIds: ['I1', 'I2'] })).toMatchObject({ launchOptions: { ideaIds: ['I1', 'I2'] }, ideaId: undefined, ignoredSeeds: [] });
    expect(partitionLaunchSeeds('idea', { ideaIds: ['I1', 'I2'] })).toMatchObject({ ideaId: 'I1', launchOptions: undefined, ignoredSeeds: [] });
    expect(partitionLaunchSeeds('findings', { findingIds: ['F1'] })).toMatchObject({ findingIds: ['F1'], ignoredSeeds: [] });
    expect(partitionLaunchSeeds('none', { taskIds: ['T1'], ideaIds: ['I1'], findingIds: ['F1'] }).ignoredSeeds).toEqual([
      'taskIds',
      'ideaIds',
      'findingIds',
    ]);
  });

  it('treats an empty seed array as absent (never ignored, never passed)', () => {
    expect(partitionLaunchSeeds('tasks', { taskIds: [], findingIds: [] })).toMatchObject({ seedTaskIds: undefined, ignoredSeeds: [] });
  });
});

describe('buildProposalExecutorLaunchDeps.launchRun', () => {
  function build(launch = vi.fn(async () => ({ runId: 'run-1', worktreePath: '/wt', branchName: 'br', permissionMode: 'default' as const }))) {
    const deps = buildProposalExecutorLaunchDeps({
      workflowRegistry: registry(),
      getProjectById: (projectId) => (projectId === 1 || projectId === 2 ? { path: `/proj/${projectId}` } : undefined),
      runLauncher: { launch },
    });
    return { deps, launch };
  }

  it('launches a custom sprint-shaped flow by id with its taskIds seeded as lanes', async () => {
    const { deps, launch } = build();
    const result = await deps.launchRun({ projectId: 1, workflowName: 'dash', workflowId: 'wf-dash', sessionId: 's1', taskIds: ['T1', 'T2'] });
    expect(result).toEqual({ runId: 'run-1', worktreePath: '/wt', branchName: 'br' });
    const call = launch.mock.calls[0] as unknown[];
    expect(call[0]).toBe('wf-dash');
    expect(call[1]).toBe('/proj/1');
    expect(call[5]).toBe('s1');
    expect(call[8]).toEqual(['T1', 'T2']); // seedTaskIds
    expect(call[9]).toBe(1); // projectId
    expect(call[11]).toBeUndefined(); // findingIds
  });

  it('launches the same flow by name (project row shadows the global one)', async () => {
    const { deps, launch } = build();
    await deps.launchRun({ projectId: 1, workflowName: 'dash', sessionId: 's1', taskIds: ['T1'] });
    expect((launch.mock.calls[0] as unknown[])[0]).toBe('wf-p1-dash');
  });

  it('seeds a custom planner-shaped flow with ideaIds and ignores taskIds, reporting them', async () => {
    const { deps, launch } = build();
    const result = await deps.launchRun({
      projectId: 1,
      workflowName: 'my-planner',
      workflowId: 'wf-p1-my-planner',
      sessionId: 's1',
      taskIds: ['T1'],
      ideaIds: ['I1', 'I2'],
    });
    expect(result.ignoredSeeds).toEqual(['taskIds']);
    const call = launch.mock.calls[0] as unknown[];
    expect(call[8]).toBeUndefined(); // seedTaskIds
    expect(call[15]).toEqual({ ideaIds: ['I1', 'I2'] }); // launchOptions
  });

  it('keeps the built-in mapping byte-identical: sprint→taskIds, planner→ideaIds batch', async () => {
    const { deps, launch } = build();
    await deps.launchRun({ projectId: 1, workflowName: 'sprint', sessionId: 's1', taskIds: ['T1'] });
    await deps.launchRun({ projectId: 1, workflowName: 'planner', sessionId: 's1', ideaIds: ['I1'] });
    expect((launch.mock.calls[0] as unknown[])[8]).toEqual(['T1']);
    expect((launch.mock.calls[1] as unknown[])[15]).toEqual({ ideaIds: ['I1'] });
    expect((launch.mock.calls[1] as unknown[])[4]).toBeUndefined();
  });

  it('throws a named error for an unresolvable workflow or project', async () => {
    const { deps } = build();
    await expect(deps.launchRun({ projectId: 1, workflowName: 'nope', sessionId: 's1' })).rejects.toThrow("no 'nope' workflow for project 1");
    await expect(deps.launchRun({ projectId: 1, workflowName: 'x', workflowId: 'wf-p2-secret', sessionId: 's1' })).rejects.toThrow(
      "no 'wf-p2-secret' workflow for project 1",
    );
    await expect(deps.launchRun({ projectId: 9, workflowName: 'sprint', sessionId: 's1' })).rejects.toThrow('project 9 not found');
  });
});
