import { describe, expect, it } from 'vitest';

import type { ExperimentRow, ExperimentStatus } from '../../../../shared/types/experiments';
import { findGuardedExperimentForSession } from '../armDismissGuard';

/**
 * Minimal ExperimentRow fixture. Only the fields the guard reads (status +
 * session_a_id / session_b_id) matter; the rest are filled to satisfy the type.
 */
function makeExp(overrides: Partial<ExperimentRow> & { status: ExperimentStatus }): ExperimentRow {
  return {
    id: 'exp-1',
    project_id: 1,
    workflow_id: 'sprint',
    kind: 'side_by_side',
    base_branch: 'main',
    base_sha: 'sha0',
    variant_a_id: 'wfv_a',
    variant_b_id: 'wfv_b',
    run_a_id: 'run-a',
    run_b_id: 'run-b',
    session_a_id: null,
    session_b_id: null,
    seed_idea_id: null,
    seed_idea_clone_a_id: null,
    seed_idea_clone_b_id: null,
    winner_run_id: null,
    winner_arm: null,
    merge_sha: null,
    decided_at: null,
    rerun_of_experiment_id: null,
    promoted_variant_id: null,
    promoted_arm: null,
    promoted_at: null,
    created_at: '2026-07-09T00:00:00Z',
    updated_at: '2026-07-09T00:00:00Z',
    ...overrides,
  };
}

describe('findGuardedExperimentForSession', () => {
  it('returns arm A for a running experiment whose session_a_id matches', () => {
    const exp = makeExp({ id: 'exp-run', status: 'running', session_a_id: 'sess-1' });
    const match = findGuardedExperimentForSession('sess-1', [exp]);
    expect(match).not.toBeNull();
    expect(match?.arm).toBe('A');
    expect(match?.experiment.id).toBe('exp-run');
  });

  it('returns arm B for a running experiment whose session_b_id matches', () => {
    const exp = makeExp({ status: 'running', session_b_id: 'sess-2' });
    const match = findGuardedExperimentForSession('sess-2', [exp]);
    expect(match?.arm).toBe('B');
  });

  it('guards a GRADING experiment (both arms settled, awaiting verdict)', () => {
    const exp = makeExp({ status: 'grading', session_a_id: 'sess-3' });
    const match = findGuardedExperimentForSession('sess-3', [exp]);
    expect(match?.arm).toBe('A');
    expect(match?.experiment.status).toBe('grading');
  });

  it('does NOT guard a decided experiment even when the session matches', () => {
    const exp = makeExp({ status: 'decided', session_a_id: 'sess-4' });
    expect(findGuardedExperimentForSession('sess-4', [exp])).toBeNull();
  });

  it('does NOT guard an abandoned experiment even when the session matches', () => {
    const exp = makeExp({ status: 'abandoned', session_b_id: 'sess-5' });
    expect(findGuardedExperimentForSession('sess-5', [exp])).toBeNull();
  });

  it('returns null for a session that is not an arm of any experiment', () => {
    const exp = makeExp({ status: 'running', session_a_id: 'sess-a', session_b_id: 'sess-b' });
    expect(findGuardedExperimentForSession('sess-other', [exp])).toBeNull();
  });

  it('returns null for an empty experiment list', () => {
    expect(findGuardedExperimentForSession('sess-1', [])).toBeNull();
  });

  it('picks the live experiment when a session appears across a mix of statuses', () => {
    const decided = makeExp({ id: 'exp-old', status: 'decided', session_a_id: 'sess-x' });
    const running = makeExp({ id: 'exp-new', status: 'running', session_b_id: 'sess-x' });
    const match = findGuardedExperimentForSession('sess-x', [decided, running]);
    expect(match?.experiment.id).toBe('exp-new');
    expect(match?.arm).toBe('B');
  });

  it('resolves the degenerate both-columns case to arm A (session_a_id checked first)', () => {
    const exp = makeExp({ status: 'running', session_a_id: 'sess-dup', session_b_id: 'sess-dup' });
    expect(findGuardedExperimentForSession('sess-dup', [exp])?.arm).toBe('A');
  });
});
