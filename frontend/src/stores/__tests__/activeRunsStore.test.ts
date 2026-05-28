/**
 * activeRunsStore — filtering / projection unit tests.
 *
 * Covers buildActiveRunRows:
 *   (a) terminal runs (completed / failed / canceled) are excluded
 *   (b) __quick__ sentinel-workflow runs are excluded
 *   (c) active runs are projected with their resolved workflowName
 *   (d) unknown workflow_id falls back to a generic name
 */
import { describe, it, expect } from 'vitest';
import { buildActiveRunRows } from '../activeRunsStore';

type Run = Parameters<typeof buildActiveRunRows>[0][number];
type Wf = Parameters<typeof buildActiveRunRows>[1][number];

function makeRun(overrides: Partial<Run>): Run {
  return {
    id: 'run-1',
    workflow_id: 'wf-planner',
    project_id: 1,
    status: 'running',
    worktree_path: null,
    branch_name: null,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    started_at: null,
    ended_at: null,
    stuck_reason: null,
    ...overrides,
  } as Run;
}

const workflows: Wf[] = [
  { id: 'wf-planner', project_id: 1, name: 'planner', workflow_path: null, permission_mode: 'default', created_at: '' },
  { id: 'wf-quick', project_id: 1, name: '__quick__', workflow_path: null, permission_mode: 'default', created_at: '' },
];

describe('buildActiveRunRows', () => {
  it('(a) excludes terminal runs', () => {
    const rows = buildActiveRunRows(
      [
        makeRun({ id: 'r-run', status: 'running' }),
        makeRun({ id: 'r-done', status: 'completed' }),
        makeRun({ id: 'r-fail', status: 'failed' }),
        makeRun({ id: 'r-cancel', status: 'canceled' }),
      ],
      workflows,
    );
    expect(rows.map((r) => r.id)).toEqual(['r-run']);
  });

  it('(b) excludes __quick__ sentinel-workflow runs', () => {
    const rows = buildActiveRunRows(
      [
        makeRun({ id: 'r-wf', workflow_id: 'wf-planner', status: 'running' }),
        makeRun({ id: 'r-quick', workflow_id: 'wf-quick', status: 'running' }),
      ],
      workflows,
    );
    expect(rows.map((r) => r.id)).toEqual(['r-wf']);
  });

  it('(c) keeps active runs and resolves the workflow name', () => {
    const rows = buildActiveRunRows(
      [
        makeRun({ id: 'r-q', status: 'queued' }),
        makeRun({ id: 'r-rev', status: 'awaiting_review' }),
        makeRun({ id: 'r-stuck', status: 'stuck' }),
      ],
      workflows,
    );
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.workflowName === 'planner')).toBe(true);
  });

  it('(d) falls back to a generic name for an unknown workflow_id', () => {
    const rows = buildActiveRunRows(
      [makeRun({ id: 'r-orphan', workflow_id: 'wf-missing', status: 'running' })],
      workflows,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].workflowName).toBe('workflow');
  });
});
