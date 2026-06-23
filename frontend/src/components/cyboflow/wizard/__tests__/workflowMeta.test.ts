/**
 * workflowMeta — pure projection unit tests.
 *
 * Covers buildWorkflowMeta:
 *   (a) built-in planner/sprint resolve real phase/step counts (asserted against
 *       WORKFLOW_DEFINITIONS, not hard-coded guesses)
 *   (b) a custom workflow with a broken/empty spec → zero counts, '' subtitle,
 *       title-cased title
 *   (c) isDefault is true only for sprint
 *   (d) lastUsedAt = the newest matching run's created_at; null when the
 *       workflow has no runs
 *   (e) spec_json overrides the built-in fallback
 */
import { describe, it, expect } from 'vitest';
import { buildWorkflowMeta, DEFAULT_WORKFLOW_NAME } from '../workflowMeta';
import type { WorkflowListRow, RunListRow } from '../workflowMeta';
import { WORKFLOW_DEFINITIONS } from '../../../../../../shared/types/workflows';

// Construct rows via the inferred element types so the test stays bound to the
// real router output shapes (same approach as activeRunsStore.test.ts).
function makeWorkflow(overrides: Partial<WorkflowListRow>): WorkflowListRow {
  return {
    id: 'wf-1',
    project_id: 1,
    name: 'sprint',
    workflow_path: null,
    permission_mode: 'default',
    spec_json: '{}',
    created_at: '2026-01-01',
    ...overrides,
  } as WorkflowListRow;
}

function makeRun(overrides: Partial<RunListRow>): RunListRow {
  return {
    id: 'run-1',
    workflow_id: 'wf-1',
    project_id: 1,
    status: 'completed',
    worktree_path: null,
    branch_name: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    started_at: null,
    ended_at: null,
    stuck_reason: null,
    ...overrides,
  } as RunListRow;
}

// Derive the ground-truth counts from the source-of-truth definitions so the
// assertions can never drift from the real workflow graphs.
const PLANNER_PHASES = WORKFLOW_DEFINITIONS.planner.phases.length;
const PLANNER_STEPS = WORKFLOW_DEFINITIONS.planner.phases.reduce(
  (sum, p) => sum + p.steps.length,
  0,
);
const SPRINT_PHASES = WORKFLOW_DEFINITIONS.sprint.phases.length;
const SPRINT_STEPS = WORKFLOW_DEFINITIONS.sprint.phases.reduce(
  (sum, p) => sum + p.steps.length,
  0,
);

describe('buildWorkflowMeta', () => {
  it('(a) resolves real built-in planner/sprint phase + step counts', () => {
    const meta = buildWorkflowMeta(
      [
        makeWorkflow({ id: 'wf-planner', name: 'planner', spec_json: '{}' }),
        makeWorkflow({ id: 'wf-sprint', name: 'sprint', spec_json: '{}' }),
      ],
      [],
    );

    // Pin the actual built-in shape so a regression in this helper OR a change
    // to the definitions is caught loudly.
    expect(PLANNER_PHASES).toBe(2);
    expect(PLANNER_STEPS).toBe(7);
    expect(SPRINT_PHASES).toBe(3);
    expect(SPRINT_STEPS).toBe(5);

    const planner = meta.find((m) => m.name === 'planner')!;
    const sprint = meta.find((m) => m.name === 'sprint')!;

    expect(planner.phaseCount).toBe(PLANNER_PHASES);
    expect(planner.stepCount).toBe(PLANNER_STEPS);
    expect(planner.title).toBe('Planner');
    expect(planner.slashCommand).toBe('/planner');
    expect(planner.subtitle).toBe('Idea → epics → tasks (plan + refine, no execute)');

    expect(sprint.phaseCount).toBe(SPRINT_PHASES);
    expect(sprint.stepCount).toBe(SPRINT_STEPS);
    expect(sprint.title).toBe('Sprint');
    expect(sprint.slashCommand).toBe('/sprint');
    expect(sprint.subtitle).toBe('Parallel task fan-out → sprint review');
  });

  it('(a2) ship resolves its built-in title + subtitle', () => {
    const meta = buildWorkflowMeta(
      [makeWorkflow({ id: 'wf-ship', name: 'ship', spec_json: '{}' })],
      [],
    );

    const ship = meta.find((m) => m.name === 'ship')!;
    expect(ship.title).toBe('Ship');
    expect(ship.slashCommand).toBe('/ship');
    expect(ship.subtitle).toBe(
      'Idea → epics → tasks → execute → integrate (planner + sprint, end to end)',
    );
  });

  it('(b) a custom workflow with a broken/empty spec yields zero counts and a blank subtitle', () => {
    const meta = buildWorkflowMeta(
      [
        makeWorkflow({ id: 'wf-broken', name: 'my-custom', spec_json: 'not json' }),
        makeWorkflow({ id: 'wf-empty', name: 'other-custom', spec_json: '{}' }),
      ],
      [],
    );

    for (const m of meta) {
      expect(m.phaseCount).toBe(0);
      expect(m.stepCount).toBe(0);
      expect(m.subtitle).toBe('');
    }
    // Title falls back to a title-cased raw name for custom flows.
    expect(meta.find((m) => m.name === 'my-custom')!.title).toBe('My-custom');
    expect(meta.find((m) => m.name === 'other-custom')!.title).toBe('Other-custom');
  });

  it('(c) isDefault is true only for the sprint workflow', () => {
    const meta = buildWorkflowMeta(
      [
        makeWorkflow({ id: 'wf-planner', name: 'planner' }),
        makeWorkflow({ id: 'wf-sprint', name: 'sprint' }),
        makeWorkflow({ id: 'wf-ship', name: 'ship', spec_json: '{}' }),
        makeWorkflow({ id: 'wf-custom', name: 'my-custom', spec_json: '{}' }),
      ],
      [],
    );

    expect(DEFAULT_WORKFLOW_NAME).toBe('sprint');
    expect(meta.find((m) => m.name === 'sprint')!.isDefault).toBe(true);
    expect(meta.find((m) => m.name === 'planner')!.isDefault).toBe(false);
    // Ship is a full end-to-end flow but must NOT be the wizard default.
    expect(meta.find((m) => m.name === 'ship')!.isDefault).toBe(false);
    expect(meta.find((m) => m.name === 'my-custom')!.isDefault).toBe(false);
  });

  it('(d) lastUsedAt is the newest matching run created_at; null with no runs', () => {
    const meta = buildWorkflowMeta(
      [
        makeWorkflow({ id: 'wf-sprint', name: 'sprint' }),
        makeWorkflow({ id: 'wf-planner', name: 'planner' }),
      ],
      [
        makeRun({ id: 'r1', workflow_id: 'wf-sprint', created_at: '2026-02-01T00:00:00.000Z' }),
        makeRun({ id: 'r2', workflow_id: 'wf-sprint', created_at: '2026-03-15T12:00:00.000Z' }),
        makeRun({ id: 'r3', workflow_id: 'wf-sprint', created_at: '2026-01-09T00:00:00.000Z' }),
        // A run for a DIFFERENT workflow must not bleed into the sprint card.
        makeRun({ id: 'r4', workflow_id: 'wf-other', created_at: '2026-12-31T00:00:00.000Z' }),
      ],
    );

    expect(meta.find((m) => m.name === 'sprint')!.lastUsedAt).toBe('2026-03-15T12:00:00.000Z');
    // planner has no runs → null.
    expect(meta.find((m) => m.name === 'planner')!.lastUsedAt).toBeNull();
  });

  it('(e) a valid spec_json overrides the built-in fallback counts', () => {
    // A one-phase / one-step custom graph that resolveWorkflowDefinition accepts.
    const customDef = {
      id: 'custom',
      phases: [
        {
          id: 'only',
          label: 'Only',
          color: '#c96442',
          steps: [{ id: 'do-it', name: 'Do it', agent: 'executor', mcps: [], retries: 0 }],
        },
      ],
    };
    const meta = buildWorkflowMeta(
      [makeWorkflow({ id: 'wf-x', name: 'sprint', spec_json: JSON.stringify(customDef) })],
      [],
    );

    // spec_json wins over the built-in sprint definition.
    expect(meta[0].phaseCount).toBe(1);
    expect(meta[0].stepCount).toBe(1);
  });
});
