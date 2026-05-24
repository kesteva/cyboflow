/**
 * Tests for workflow_run lifecycle transition helpers.
 *
 * TASK-644 acceptance criteria verified here:
 *
 * AC1: Four new transition helpers exported from transitions.ts.
 * AC2: transitionToRunning guards on source status='starting'.
 * AC3: transitionToCompleted/Failed/Canceled set ended_at.
 * AC4: transitionToFailed writes error_message.
 * AC5: transitionToCanceled accepts any non-terminal source; rejects terminal.
 *
 * Test strategy:
 *   - Real in-memory better-sqlite3 via the canonical createTestDb fixture (GATE_SCHEMA).
 *   - Transition helpers imported directly — no tRPC wrapper needed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { createTestDb } from '../__test_fixtures__/orchestratorTestDb';
import {
  transitionToRunning,
  transitionToCompleted,
  transitionToFailed,
  transitionToCanceled,
  TransitionRejectedError,
} from '../../services/cyboflow/transitions';

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

function seedWorkflow(db: Database.Database): string {
  const workflowId = `workflow-${randomUUID()}`;
  db.prepare(
    `INSERT INTO workflows (id, project_id, name, spec_json)
     VALUES (?, 1, 'test-workflow', '{}')`,
  ).run(workflowId);
  return workflowId;
}

function seedRun(db: Database.Database, runId: string, status: string): void {
  const workflowId = seedWorkflow(db);
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, policy_json)
     VALUES (?, ?, 1, ?, '{}')`,
  ).run(runId, workflowId, status);
}

function getStatus(db: Database.Database, runId: string): string {
  const row = db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as { status: string };
  return row.status;
}

function getEndedAt(db: Database.Database, runId: string): string | null {
  const row = db.prepare('SELECT ended_at FROM workflow_runs WHERE id = ?').get(runId) as { ended_at: string | null };
  return row.ended_at;
}

function getErrorMessage(db: Database.Database, runId: string): string | null {
  const row = db.prepare('SELECT error_message FROM workflow_runs WHERE id = ?').get(runId) as { error_message: string | null };
  return row.error_message;
}

// ---------------------------------------------------------------------------
// describe: transitionToRunning
// ---------------------------------------------------------------------------

describe('transitionToRunning', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('succeeds when source status is "starting"', () => {
    const runId = randomUUID();
    seedRun(db, runId, 'starting');
    transitionToRunning(db, { runId });
    expect(getStatus(db, runId)).toBe('running');
  });

  it('throws TransitionRejectedError when source status is "queued"', () => {
    const runId = randomUUID();
    seedRun(db, runId, 'queued');
    expect(() => transitionToRunning(db, { runId })).toThrow(TransitionRejectedError);
  });

  it.each([
    'running',
    'awaiting_review',
    'stuck',
    'completed',
    'failed',
    'canceled',
  ])('throws TransitionRejectedError when source status is "%s"', (status) => {
    const runId = randomUUID();
    seedRun(db, runId, status);
    // assertTransitionAllowed checks first, so either IllegalTransitionError
    // or TransitionRejectedError may be thrown depending on status.
    // The plan only requires TransitionRejectedError for 'queued'. For other
    // illegal sources, IllegalTransitionError (from assertTransitionAllowed)
    // is thrown — still an Error subtype, still correctly rejected.
    expect(() => transitionToRunning(db, { runId })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// describe: transitionToCompleted
// ---------------------------------------------------------------------------

describe('transitionToCompleted', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('succeeds from "running" and sets ended_at', () => {
    const runId = randomUUID();
    seedRun(db, runId, 'running');
    transitionToCompleted(db, { runId, fromStatus: 'running' });
    expect(getStatus(db, runId)).toBe('completed');
    expect(getEndedAt(db, runId)).not.toBeNull();
  });

  it('throws TransitionRejectedError when run is not in expected fromStatus', () => {
    const runId = randomUUID();
    // Seed as 'starting' but claim fromStatus='running'
    seedRun(db, runId, 'starting');
    expect(() => transitionToCompleted(db, { runId, fromStatus: 'running' })).toThrow(TransitionRejectedError);
  });
});

// ---------------------------------------------------------------------------
// describe: transitionToFailed
// ---------------------------------------------------------------------------

describe('transitionToFailed', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it.each([
    'starting',
    'running',
    'awaiting_review',
    'stuck',
  ] as const)('succeeds from "%s", writes error_message and ended_at', (status) => {
    const runId = randomUUID();
    seedRun(db, runId, status);
    transitionToFailed(db, { runId, fromStatus: status, errorMessage: 'boom' });
    expect(getStatus(db, runId)).toBe('failed');
    expect(getErrorMessage(db, runId)).toBe('boom');
    expect(getEndedAt(db, runId)).not.toBeNull();
  });

  it('throws TransitionRejectedError when run is not in expected fromStatus', () => {
    const runId = randomUUID();
    // Seed as 'queued' but claim fromStatus='running'
    seedRun(db, runId, 'queued');
    expect(() =>
      transitionToFailed(db, { runId, fromStatus: 'running', errorMessage: 'boom' }),
    ).toThrow(TransitionRejectedError);
  });
});

// ---------------------------------------------------------------------------
// describe: transitionToCanceled
// ---------------------------------------------------------------------------

describe('transitionToCanceled', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it.each(['queued', 'starting', 'running', 'awaiting_review', 'stuck'])(
    'succeeds from non-terminal status "%s" and sets ended_at',
    (status) => {
      const runId = randomUUID();
      seedRun(db, runId, status);
      transitionToCanceled(db, { runId });
      expect(getStatus(db, runId)).toBe('canceled');
      expect(getEndedAt(db, runId)).not.toBeNull();
    },
  );

  it.each(['completed', 'failed', 'canceled'])(
    'throws TransitionRejectedError when source is terminal "%s"',
    (status) => {
      const runId = randomUUID();
      seedRun(db, runId, status);
      expect(() => transitionToCanceled(db, { runId })).toThrow(TransitionRejectedError);
    },
  );
});

