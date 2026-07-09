import { describe, expect, it } from 'vitest';

import { BASELINE_VARIANT_SENTINEL } from '../../../../shared/types/experiments';
import type { ExperimentRow, ExperimentSummary } from '../../../../shared/types/experiments';
import type { Session } from '../../types/session';
import { groupRailExperiments, railExperimentPill } from '../railExperimentGrouping';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function mkSession(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    name: id,
    worktreePath: `/tmp/${id}`,
    prompt: '',
    status: 'running',
    createdAt: '2026-07-09T00:00:00.000Z',
    output: [],
    jsonMessages: [],
    projectId: 1,
    ...overrides,
  };
}

function mkExperiment(overrides: Partial<ExperimentRow> = {}): ExperimentRow {
  return {
    id: 'exp-1',
    project_id: 1,
    workflow_id: 'wf-1-sprint',
    kind: 'side_by_side',
    base_branch: 'main',
    base_sha: 'abc',
    variant_a_id: BASELINE_VARIANT_SENTINEL,
    variant_b_id: 'wfv_terse',
    run_a_id: 'run-a',
    run_b_id: 'run-b',
    session_a_id: 'sess-a',
    session_b_id: 'sess-b',
    seed_idea_id: null,
    seed_idea_clone_a_id: null,
    seed_idea_clone_b_id: null,
    status: 'running',
    winner_run_id: null,
    winner_arm: null,
    merge_sha: null,
    decided_at: null,
    rerun_of_experiment_id: null,
    promoted_variant_id: null,
    promoted_arm: null,
    promoted_at: null,
    created_at: '2026-07-09T00:00:00.000Z',
    updated_at: '2026-07-09T00:00:00.000Z',
    ...overrides,
  };
}

function mkSummary(overrides: Partial<ExperimentSummary> = {}): ExperimentSummary {
  return {
    experimentId: 'exp-1',
    workflowId: 'wf-1-sprint',
    baseBranch: 'main',
    variantAId: BASELINE_VARIANT_SENTINEL,
    variantBId: 'wfv_terse',
    armALabel: 'Baseline',
    armBLabel: 'terse-prompts',
    verdictPreference: null,
    verdictConfidence: null,
    decision: null,
    status: 'running',
    decidedAt: null,
    createdAt: '2026-07-09T00:00:00.000Z',
    rerunOfExperimentId: null,
    seriesKey: 'wf-1-sprint:__baseline__|wfv_terse',
    ...overrides,
  };
}

const summariesById = (s: ExperimentSummary): Record<string, ExperimentSummary> => ({ [s.experimentId]: s });

// ---------------------------------------------------------------------------
// groupRailExperiments
// ---------------------------------------------------------------------------

describe('groupRailExperiments', () => {
  it('running: both arm sessions grouped and removed from the flat list', () => {
    const sessions = [mkSession('sess-a'), mkSession('sess-b')];
    const exp = mkExperiment({ status: 'running' });
    const { groups, ungroupedSessions } = groupRailExperiments(sessions, [exp], summariesById(mkSummary()));

    expect(groups).toHaveLength(1);
    expect(groups[0].arms.map((a) => a.arm)).toEqual(['A', 'B']);
    expect(groups[0].arms[0].label).toBe('baseline'); // arm A is the baseline sentinel
    expect(groups[0].arms[1].label).toBe('terse-prompts');
    expect(groups[0].arms[0].runId).toBe('run-a');
    expect(groups[0].arms[1].session.id).toBe('sess-b');
    // Both arm sessions are claimed → the flat list is empty.
    expect(ungroupedSessions).toHaveLength(0);
  });

  it('grading: both arms grouped just like running', () => {
    const sessions = [mkSession('sess-a'), mkSession('sess-b')];
    const exp = mkExperiment({ status: 'grading' });
    const { groups, ungroupedSessions } = groupRailExperiments(
      sessions,
      [exp],
      summariesById(mkSummary({ status: 'grading' })),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].arms).toHaveLength(2);
    expect(ungroupedSessions).toHaveLength(0);
  });

  it('decided + winner session still open: winner-only group', () => {
    const sessions = [mkSession('sess-b')]; // loser (A) session already dismissed
    const exp = mkExperiment({ status: 'decided', winner_arm: 'B', winner_run_id: 'run-b' });
    const { groups, ungroupedSessions } = groupRailExperiments(sessions, [exp], summariesById(mkSummary()));

    expect(groups).toHaveLength(1);
    expect(groups[0].arms).toHaveLength(1);
    expect(groups[0].arms[0].arm).toBe('B');
    expect(groups[0].arms[0].session.id).toBe('sess-b');
    expect(ungroupedSessions).toHaveLength(0);
  });

  it('decided + winner session archived (absent): no group, no claim', () => {
    // Winner arm is A but sess-a is not in the visible list anymore.
    const sessions = [mkSession('other')];
    const exp = mkExperiment({ status: 'decided', winner_arm: 'A', winner_run_id: 'run-a' });
    const { groups, ungroupedSessions } = groupRailExperiments(sessions, [exp], summariesById(mkSummary()));

    expect(groups).toHaveLength(0);
    expect(ungroupedSessions.map((s) => s.id)).toEqual(['other']);
  });

  it('decided + discard-both (winner_arm null): never a group', () => {
    const sessions = [mkSession('sess-a'), mkSession('sess-b')];
    const exp = mkExperiment({ status: 'decided', winner_arm: null });
    const { groups, ungroupedSessions } = groupRailExperiments(sessions, [exp], summariesById(mkSummary()));

    expect(groups).toHaveLength(0);
    // Nothing claimed → both pass through untouched.
    expect(ungroupedSessions.map((s) => s.id).sort()).toEqual(['sess-a', 'sess-b']);
  });

  it('abandoned: never a group; its sessions pass through', () => {
    const sessions = [mkSession('sess-a'), mkSession('sess-b')];
    const exp = mkExperiment({ status: 'abandoned' });
    const { groups, ungroupedSessions } = groupRailExperiments(sessions, [exp], summariesById(mkSummary()));

    expect(groups).toHaveLength(0);
    expect(ungroupedSessions).toHaveLength(2);
  });

  it('arm session missing: group renders with the single present arm', () => {
    const sessions = [mkSession('sess-a')]; // arm B session not visible
    const exp = mkExperiment({ status: 'running' });
    const { groups, ungroupedSessions } = groupRailExperiments(sessions, [exp], summariesById(mkSummary()));

    expect(groups).toHaveLength(1);
    expect(groups[0].arms).toHaveLength(1);
    expect(groups[0].arms[0].arm).toBe('A');
    expect(ungroupedSessions).toHaveLength(0);
  });

  it('missing summary: falls back to A/B labels (baseline still resolves)', () => {
    const sessions = [mkSession('sess-a'), mkSession('sess-b')];
    const exp = mkExperiment({
      status: 'running',
      variant_a_id: 'wfv_x', // real variant, no summary loaded
      variant_b_id: 'wfv_y',
    });
    const { groups } = groupRailExperiments(sessions, [exp], {});
    expect(groups[0].arms[0].label).toBe('A');
    expect(groups[0].arms[1].label).toBe('B');
  });

  it('non-experiment sessions are untouched', () => {
    const sessions = [mkSession('sess-a'), mkSession('sess-b'), mkSession('plain-1'), mkSession('plain-2')];
    const exp = mkExperiment({ status: 'running' });
    const { groups, ungroupedSessions } = groupRailExperiments(sessions, [exp], summariesById(mkSummary()));

    expect(groups).toHaveLength(1);
    expect(ungroupedSessions.map((s) => s.id).sort()).toEqual(['plain-1', 'plain-2']);
  });

  it('no experiments: every session passes through, no groups', () => {
    const sessions = [mkSession('plain-1'), mkSession('plain-2')];
    const { groups, ungroupedSessions } = groupRailExperiments(sessions, [], {});
    expect(groups).toHaveLength(0);
    expect(ungroupedSessions).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// railExperimentPill
// ---------------------------------------------------------------------------

describe('railExperimentPill', () => {
  it('running → running tone', () => {
    expect(railExperimentPill(mkExperiment({ status: 'running' }), mkSummary())).toEqual({
      text: 'running',
      tone: 'running',
    });
  });

  it('grading without a verdict → grading tone', () => {
    expect(
      railExperimentPill(mkExperiment({ status: 'grading' }), mkSummary({ status: 'grading', verdictPreference: null })),
    ).toEqual({ text: 'grading…', tone: 'grading' });
  });

  it('grading with a completed verdict → verdict ready (amber)', () => {
    expect(
      railExperimentPill(
        mkExperiment({ status: 'grading' }),
        mkSummary({ status: 'grading', verdictPreference: 'B' }),
      ),
    ).toEqual({ text: 'verdict ready', tone: 'ready' });
  });

  it('grading with no summary at all → grading tone', () => {
    expect(railExperimentPill(mkExperiment({ status: 'grading' }), undefined)).toEqual({
      text: 'grading…',
      tone: 'grading',
    });
  });

  it('decided → "<winner> won" (green)', () => {
    expect(railExperimentPill(mkExperiment({ status: 'decided', winner_arm: 'A' }), mkSummary())).toEqual({
      text: 'A won',
      tone: 'won',
    });
  });
});
