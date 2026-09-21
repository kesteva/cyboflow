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
import {
  buildWorkflowMeta,
  DEFAULT_WORKFLOW_NAME,
  SETUP_WORKFLOW_NAMES,
  VERIFY_SETUP_WORKFLOW_NAME,
  launcherWorkflowMetas,
} from '../workflowMeta';
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
    // Migration 122: the LEVEL decides which graph resolves, so a fixture that
    // wants its spec_json to win must stamp 'custom' — the state the app
    // produces (updateSpec stamps it; the 122 backfill stamped existing rows).
    tuning_level: 'standard',
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
    expect(PLANNER_STEPS).toBe(10);
    expect(SPRINT_PHASES).toBe(3);
    expect(SPRINT_STEPS).toBe(6);

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

  it('(a3) verify-setup resolves its built-in title + subtitle and its 5-step definition', () => {
    // The 5th built-in is the one whose raw name is NOT a single lowercase word, so
    // it is also the case that proves the title map beats the titleCase() fallback
    // (which would render 'Verify-setup').
    const meta = buildWorkflowMeta(
      [makeWorkflow({ id: 'wf-verify-setup', name: 'verify-setup', spec_json: '{}' })],
      [],
    );

    const verifySetup = meta.find((m) => m.name === 'verify-setup')!;
    expect(verifySetup.title).toBe('Verify Setup');
    expect(verifySetup.slashCommand).toBe('/verify-setup');
    expect(verifySetup.subtitle).toBe(
      "Derive → prove → persist this project's visual-verification runbook",
    );
    // Counts come from the built-in fallback definition (one phase, five steps).
    expect(verifySetup.phaseCount).toBe(1);
    expect(verifySetup.stepCount).toBe(5);
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

  it("(e) a 'custom'-stamped spec_json overrides the built-in fallback counts", () => {
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
      [
        makeWorkflow({
          id: 'wf-x',
          name: 'sprint',
          spec_json: JSON.stringify(customDef),
          tuning_level: 'custom',
        }),
      ],
      [],
    );

    // The custom slot wins over the built-in sprint definition.
    expect(meta[0].phaseCount).toBe(1);
    expect(meta[0].stepCount).toBe(1);
  });

  it("(e2) the SAME spec_json is dormant while a preset level is selected", () => {
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
      [
        makeWorkflow({
          id: 'wf-x',
          name: 'sprint',
          spec_json: JSON.stringify(customDef),
          tuning_level: 'thorough',
        }),
      ],
      [],
    );

    // Thorough is agent-pins + optional-flips only on sprint — no structural
    // edit — so the counts are the built-in's, not the slot's one-step graph.
    expect(meta[0].phaseCount).toBe(SPRINT_PHASES);
    expect(meta[0].stepCount).toBe(SPRINT_STEPS);
  });
});

/**
 * (f) Setup-flow visibility — the launcher-hiding half of the verify-setup
 * finding. These pin the SEAM, not just the flag: the model must keep the row
 * (so the Workflows gallery, the runs rail's name map, and the Verify Queue's
 * own launch can all still resolve it) while marking it not-for-the-launcher.
 */
describe('buildWorkflowMeta — setup flows', () => {
  it('marks verify-setup hiddenFromLauncher and leaves the work flows visible', () => {
    const metas = buildWorkflowMeta(
      [
        makeWorkflow({ id: 'wf-sprint', name: 'sprint' }),
        makeWorkflow({ id: 'wf-planner', name: 'planner' }),
        makeWorkflow({ id: 'wf-verify', name: 'verify-setup' }),
      ],
      [],
    );

    const byName = new Map(metas.map((m) => [m.name, m]));
    expect(byName.get('verify-setup')?.hiddenFromLauncher).toBe(true);
    expect(byName.get('sprint')?.hiddenFromLauncher).toBe(false);
    expect(byName.get('planner')?.hiddenFromLauncher).toBe(false);
  });

  it('still RETURNS the hidden row — hiding is presentation, not exclusion', () => {
    // The registry deliberately does not filter setup flows out of
    // `workflows.list` (that would break the Workflows editor and the
    // active-runs rail's workflow_id → name map), so the projection must not
    // drop them either. The launcher filters at its render site.
    const metas = buildWorkflowMeta([makeWorkflow({ id: 'wf-verify', name: 'verify-setup' })], []);

    expect(metas).toHaveLength(1);
    expect(metas[0].name).toBe('verify-setup');
    expect(metas[0].title).toBe('Verify Setup');
    // And it resolves a real definition, so it is launchable once a surface
    // offers it — not a dead card.
    expect(metas[0].stepCount).toBeGreaterThan(0);
  });

  it('the launcher filter drops exactly the setup flows', () => {
    // Calls the FUNCTION the wizard maps over, not a re-implementation of it.
    // A copy of the predicate written here would keep passing while the render
    // site lost its filter — which is how a hidden flow silently comes back, or
    // a work flow silently disappears.
    const metas = buildWorkflowMeta(
      [
        makeWorkflow({ id: 'wf-sprint', name: 'sprint' }),
        makeWorkflow({ id: 'wf-verify', name: 'verify-setup' }),
        makeWorkflow({ id: 'wf-ship', name: 'ship' }),
      ],
      [],
    );

    expect(launcherWorkflowMetas(metas).map((m) => m.name)).toEqual(['ship', 'sprint']);
  });

  it('orders the launcher list ship → planner → sprint → launch → compound, custom flows trailing', () => {
    // The curated display order, independent of the registry tuple order the
    // rows arrive in. Custom flows keep their incoming relative order after
    // the built-ins (stable sort).
    const metas = buildWorkflowMeta(
      [
        makeWorkflow({ id: 'wf-custom-b', name: 'my-flow-b' }),
        makeWorkflow({ id: 'wf-compound', name: 'compound' }),
        makeWorkflow({ id: 'wf-launch', name: 'launch' }),
        makeWorkflow({ id: 'wf-planner', name: 'planner' }),
        makeWorkflow({ id: 'wf-ship', name: 'ship' }),
        makeWorkflow({ id: 'wf-sprint', name: 'sprint' }),
        makeWorkflow({ id: 'wf-custom-a', name: 'my-flow-a' }),
      ],
      [],
    );

    expect(launcherWorkflowMetas(metas).map((m) => m.name)).toEqual([
      'ship',
      'planner',
      'sprint',
      'launch',
      'compound',
      'my-flow-b',
      'my-flow-a',
    ]);
  });

  it('the hide-list and the CTA name the SAME flow', () => {
    // Two copies of the literal could drift into a flow that is hidden from the
    // launcher while the CTA preselects something else — hidden with no way in.
    expect(SETUP_WORKFLOW_NAMES.has(VERIFY_SETUP_WORKFLOW_NAME)).toBe(true);
  });

  it('a custom flow that merely CONTAINS the name is not treated as setup', () => {
    // Exact-name membership, not a substring test — a user flow called
    // "verify-setup-notes" is ordinary work and must stay launchable.
    const metas = buildWorkflowMeta([makeWorkflow({ id: 'wf-c', name: 'verify-setup-notes' })], []);

    expect(metas[0].hiddenFromLauncher).toBe(false);
  });
});
