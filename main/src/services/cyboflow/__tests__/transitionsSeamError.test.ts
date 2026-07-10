/**
 * Seam-error instrumentation for transitionToFailed (seam A: run-finalize-failed).
 *
 * transitionToFailed is the single guarded chokepoint every executor-driven run
 * failure funnels through. These tests assert it reports the failure to Sentry
 * via captureSeamError with a classified, low-cardinality tag set — and that a
 * REJECTED transition (wrong fromStatus) reports nothing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// Mock the services telemetry module so we can assert on captureSeamError. The
// real captureSeamError is a no-op in tests (Sentry never initializes), so this
// mock is the only way to observe the call. transitions.ts (in services/cyboflow)
// imports it as '../telemetry' → services/telemetry; from THIS file (in
// services/cyboflow/__tests__) that same absolute module is '../../telemetry'.
// The spy is created via vi.hoisted so it exists when the hoisted vi.mock factory
// runs (a plain const would be in the temporal dead zone at that point).
const { captureSeamError } = vi.hoisted(() => ({ captureSeamError: vi.fn() }));
vi.mock('../../telemetry', () => ({ captureSeamError }));

import { transitionToFailed, TransitionRejectedError } from '../transitions';
import { GATE_SCHEMA } from '../../../database/__test_fixtures__/registrySchema';

const WORKFLOW_ID = 'wf-seam-001';
const RUN_ID = 'run-seam-001';

function seedWorkflow(db: Database.Database, name: string): void {
  db.prepare(
    `INSERT INTO workflows (id, project_id, name, spec_json) VALUES (?, 1, ?, '{}')`,
  ).run(WORKFLOW_ID, name);
}

function seedRun(db: Database.Database, status: string, substrate = 'sdk'): void {
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, worktree_path, status, policy_json, substrate)
     VALUES (?, ?, 1, '/tmp/wt', ?, '{}', ?)`,
  ).run(RUN_ID, WORKFLOW_ID, status, substrate);
}

describe('transitionToFailed → captureSeamError (seam A)', () => {
  let db: Database.Database;

  beforeEach(() => {
    captureSeamError.mockClear();
    db = new Database(':memory:');
    db.exec(GATE_SCHEMA);
    // migration-013 column, absent from GATE_SCHEMA — the report query reads it.
    db.exec("ALTER TABLE workflow_runs ADD COLUMN substrate TEXT NOT NULL DEFAULT 'sdk'");
  });

  afterEach(() => {
    db.close();
  });

  it('reports run-finalize-failed with a classified errorClass + low-cardinality tags', () => {
    seedWorkflow(db, 'sprint');
    seedRun(db, 'running', 'sdk');

    transitionToFailed(db, {
      runId: RUN_ID,
      fromStatus: 'running',
      errorMessage: 'Claude AI usage limit reached|1751234567',
    });

    expect(captureSeamError).toHaveBeenCalledTimes(1);
    const [seam, error, tags] = captureSeamError.mock.calls[0];
    expect(seam).toBe('run-finalize-failed');
    expect(error).toBeInstanceOf(Error);
    expect(tags).toEqual({
      errorClass: 'usage-limit-reached',
      fromStatus: 'running',
      flow: 'sprint',
      substrate: 'sdk',
    });
  });

  it('buckets a user-named custom flow to flow=custom (no PII in tags)', () => {
    seedWorkflow(db, 'My Secret Client Flow');
    seedRun(db, 'running', 'interactive');

    transitionToFailed(db, {
      runId: RUN_ID,
      fromStatus: 'running',
      errorMessage: 'Stream closed unexpectedly',
    });

    expect(captureSeamError).toHaveBeenCalledTimes(1);
    const [, , tags] = captureSeamError.mock.calls[0];
    expect(tags).toMatchObject({ flow: 'custom', substrate: 'interactive', errorClass: 'stream-closed' });
    // The custom flow NAME must never appear in any tag value.
    expect(JSON.stringify(tags)).not.toContain('Secret');
  });

  it('bounds the reported message to 1000 chars', () => {
    seedWorkflow(db, 'sprint');
    seedRun(db, 'running');
    const huge = 'x'.repeat(5000);

    transitionToFailed(db, { runId: RUN_ID, fromStatus: 'running', errorMessage: huge });

    const [, error] = captureSeamError.mock.calls[0];
    expect((error as Error).message.length).toBe(1000);
  });

  it('reports NOTHING when the transition is rejected (wrong fromStatus)', () => {
    seedWorkflow(db, 'sprint');
    seedRun(db, 'completed'); // already terminal — the guard rejects

    expect(() =>
      transitionToFailed(db, {
        runId: RUN_ID,
        fromStatus: 'running',
        errorMessage: 'should not be reported',
      }),
    ).toThrow(TransitionRejectedError);

    expect(captureSeamError).not.toHaveBeenCalled();
  });
});
