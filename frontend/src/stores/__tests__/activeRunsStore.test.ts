/**
 * activeRunsStore — filtering / projection unit tests.
 *
 * Covers buildActiveRunRows:
 *   (a) all non-terminal rows are kept, while terminal retention is limited to
 *       the newest row per parent session plus the selected row
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

// Mirror production: `cyboflow.workflows.list` EXCLUDES the `__quick__` sentinel
// (workflowRegistry.listByProject filters `name != '__quick__'`), so the rows
// resolver never has a name for a quick run — it must match the id suffix.
const workflows: Wf[] = [
  { id: 'wf-planner', project_id: 1, name: 'planner', workflow_path: null, permission_mode: 'default', spec_json: '{}', created_at: '' },
];

describe('buildActiveRunRows', () => {
  it('(a) excludes unpinned parentless terminal runs', () => {
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

  it('(a1) keeps only the newest terminal run for each non-null parent session', () => {
    const rows = buildActiveRunRows(
      [
        makeRun({
          id: 'sess-a-old',
          status: 'completed',
          session_id: 'sess-a',
          created_at: '2026-01-01',
        }),
        makeRun({
          id: 'sess-b-new',
          status: 'failed',
          session_id: 'sess-b',
          created_at: '2026-02-03',
        }),
        makeRun({
          id: 'sess-a-new',
          status: 'canceled',
          session_id: 'sess-a',
          created_at: '2026-02-02',
        }),
        makeRun({
          id: 'sess-b-old',
          status: 'completed',
          session_id: 'sess-b',
          created_at: '2026-01-04',
        }),
        makeRun({ id: 'live', status: 'running', session_id: 'sess-a' }),
        makeRun({ id: 'parentless', status: 'completed', session_id: null }),
      ],
      workflows,
    );

    // Input order is deliberately not newest-first for sess-a. Selection is by
    // created_at, while the returned rows preserve the source list order.
    expect(rows.map((r) => r.id)).toEqual(['sess-b-new', 'sess-a-new', 'live']);
  });

  it('(a2) keeps the pinned (currently-selected) run even when terminal', () => {
    const rows = buildActiveRunRows(
      [
        makeRun({ id: 'r-run', status: 'running' }),
        makeRun({ id: 'r-done', status: 'completed' }),
        makeRun({ id: 'r-fail', status: 'failed' }),
      ],
      workflows,
      'r-done', // the run the user is viewing
    );
    // Active run + the pinned parentless terminal run remain; other parentless
    // terminal history stays dropped.
    expect(rows.map((r) => r.id).sort()).toEqual(['r-done', 'r-run']);
  });

  it('(a2b) keeps an older terminal row when pinned in addition to the newest session row', () => {
    const rows = buildActiveRunRows(
      [
        makeRun({ id: 'new', status: 'completed', session_id: 'sess-a', created_at: '2026-02-01' }),
        makeRun({ id: 'old', status: 'failed', session_id: 'sess-a', created_at: '2026-01-01' }),
      ],
      workflows,
      'old',
    );

    expect(rows.map((r) => r.id)).toEqual(['new', 'old']);
  });

  it('(a3) never resurrects a pinned __quick__ run', () => {
    const rows = buildActiveRunRows(
      [makeRun({ id: 'r-quick', workflow_id: 'wf-1-__quick__', status: 'completed' })],
      workflows,
      'r-quick',
    );
    expect(rows).toEqual([]);
  });

  it('(b) excludes __quick__ sentinel-workflow runs by id suffix (absent from workflows.list)', () => {
    const rows = buildActiveRunRows(
      [
        makeRun({ id: 'r-wf', workflow_id: 'wf-planner', status: 'running' }),
        // Real quick-run id shape: `wf-<projectId>-__quick__`. This workflow is
        // NOT in `workflows`, reproducing the production bug where the old
        // name-based filter let every quick run through as "workflow".
        makeRun({ id: 'r-quick', workflow_id: 'wf-1-__quick__', status: 'running' }),
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
