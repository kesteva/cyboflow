/**
 * TASK-300 regression pin — StuckDetector 'parked_no_gate' rung.
 *
 * Reproduces the shape from the ticket: an SDK run whose turn cleanly ended
 * (a fresh raw_events row exists, then nothing further) parked at
 * status='running' with NO approvals row and NO questions row — the
 * observed run stayed 'running' at a human-review step with
 * pending_questions_count 0. Queued input against a run in this shape used
 * to buffer forever with no delivery trigger; the detector must notice and
 * stamp stuck_reason so the run reads as "waiting on you" instead of
 * "executing".
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { StuckDetector, type ClaudeManagerLike } from '../stuckDetector';
import type { StuckDetectedEvent } from '../../../../shared/types/stuckDetection';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { makeSpyLogger } from '../__test_fixtures__/loggerLikeSpy';
import { buildReviewInboxDb, seedInboxRun, runStatus } from '../__test_fixtures__/reviewInboxTestDb';
import type Database from 'better-sqlite3';

afterEach(() => {
  vi.restoreAllMocks();
});

const STALE_THRESHOLD_MS = 45 * 60 * 1000;
const STALE_AGO = new Date(Date.now() - (STALE_THRESHOLD_MS + 60 * 1000)).toISOString();
const FRESH_AGO = new Date(Date.now() - 60 * 1000).toISOString();

function makeClaudeManager(active: Set<string> = new Set()): ClaudeManagerLike {
  return { hasActiveRunForId: (runId) => active.has(runId) };
}

function seedRawEvent(db: Database.Database, runId: string, createdAt: string): void {
  db.prepare(
    `INSERT INTO raw_events (run_id, event_type, payload_json, created_at) VALUES (?, 'sdk_message', '{}', ?)`,
  ).run(runId, createdAt);
}

describe('StuckDetector — parked_no_gate rung (TASK-300)', () => {
  it('transitions a run parked running with a stale last turn and no gate of any kind', async () => {
    const db = buildReviewInboxDb();
    seedInboxRun(db, 'run-parked', 'running');
    // The turn's final raw_events row landed a while ago — no further activity.
    seedRawEvent(db, 'run-parked', STALE_AGO);

    const emitter = new EventEmitter();
    const events: StuckDetectedEvent[] = [];
    emitter.on('runs:stuck', (e: StuckDetectedEvent) => events.push(e));

    const detector = new StuckDetector({
      db: dbAdapter(db),
      claudeManager: makeClaudeManager(),
      emitter,
      logger: makeSpyLogger(),
    });

    await detector.scan();

    expect(runStatus(db, 'run-parked')).toBe('stuck');
    const row = db
      .prepare('SELECT stuck_reason FROM workflow_runs WHERE id = ?')
      .get('run-parked') as { stuck_reason: string | null };
    expect(row.stuck_reason).toBe('parked_no_gate');
    expect(events).toHaveLength(1);
    expect(events[0].reason).toEqual({ kind: 'parked_no_gate' });
    expect(events[0].approvalId).toBeUndefined();
  });

  it('does NOT fire while the last turn is still fresh', async () => {
    const db = buildReviewInboxDb();
    seedInboxRun(db, 'run-fresh', 'running');
    seedRawEvent(db, 'run-fresh', FRESH_AGO);

    const emitter = new EventEmitter();
    const events: StuckDetectedEvent[] = [];
    emitter.on('runs:stuck', (e) => events.push(e as StuckDetectedEvent));

    const detector = new StuckDetector({
      db: dbAdapter(db),
      claudeManager: makeClaudeManager(),
      emitter,
      logger: makeSpyLogger(),
    });

    await detector.scan();

    expect(runStatus(db, 'run-fresh')).toBe('running');
    expect(events).toHaveLength(0);
  });

  it('does NOT fire when a pending awaited approval is open (a real gate, not this rung)', async () => {
    // A pending tool-approval gate is the case this rung must stay OUT of the
    // way of: the run genuinely has an answerable surface (Approve/Reject),
    // so parked_no_gate's NOT EXISTS guard must exclude it even though the
    // run's status is 'running' and its last raw_events row is stale.
    const db = buildReviewInboxDb();
    seedInboxRun(db, 'run-gated', 'running');
    seedRawEvent(db, 'run-gated', STALE_AGO);
    db.prepare(
      `INSERT INTO approvals (id, run_id, tool_name, tool_input_json, tool_use_id, status, awaited, created_at)
       VALUES ('appr-1', 'run-gated', 'Bash', '{}', 'appr-1', 'pending', 1, ?)`,
    ).run(STALE_AGO);

    const emitter = new EventEmitter();
    const events: StuckDetectedEvent[] = [];
    emitter.on('runs:stuck', (e) => events.push(e as StuckDetectedEvent));

    const detector = new StuckDetector({
      db: dbAdapter(db),
      claudeManager: makeClaudeManager(),
      emitter,
      logger: makeSpyLogger(),
    });

    await detector.scan();

    expect(runStatus(db, 'run-gated')).toBe('running');
    expect(events).toHaveLength(0);
  });

  it('does NOT fire when a pending question is open', async () => {
    const db = buildReviewInboxDb();
    seedInboxRun(db, 'run-asked', 'awaiting_input');
    seedRawEvent(db, 'run-asked', STALE_AGO);
    db.prepare(
      `INSERT INTO questions (id, run_id, tool_use_id, questions_json, status, created_at)
       VALUES ('q-1', 'run-asked', 'tu-1', '[]', 'pending', ?)`,
    ).run(STALE_AGO);

    const emitter = new EventEmitter();
    const events: StuckDetectedEvent[] = [];
    emitter.on('runs:stuck', (e) => events.push(e as StuckDetectedEvent));

    const detector = new StuckDetector({
      db: dbAdapter(db),
      claudeManager: makeClaudeManager(),
      emitter,
      logger: makeSpyLogger(),
    });

    await detector.scan();

    // Not 'running' in the first place (awaiting_input), so the rung's own
    // status filter already excludes it — belt-and-suspenders with the
    // questions NOT EXISTS clause for a run that WAS running with a pending
    // question is covered implicitly (status would be awaiting_input, never
    // running, while a question is pending — see questionRouter.ts).
    expect(runStatus(db, 'run-asked')).toBe('awaiting_input');
    expect(events).toHaveLength(0);
  });

  it('is idempotent across repeated scans (one event only)', async () => {
    const db = buildReviewInboxDb();
    seedInboxRun(db, 'run-parked', 'running');
    seedRawEvent(db, 'run-parked', STALE_AGO);

    const emitter = new EventEmitter();
    const events: StuckDetectedEvent[] = [];
    emitter.on('runs:stuck', (e) => events.push(e as StuckDetectedEvent));

    const detector = new StuckDetector({
      db: dbAdapter(db),
      claudeManager: makeClaudeManager(),
      emitter,
      logger: makeSpyLogger(),
    });

    await detector.scan();
    await detector.scan();
    await detector.scan();

    expect(events).toHaveLength(1);
  });
});
