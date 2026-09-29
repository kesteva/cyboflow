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
import { buildReviewInboxDb as buildInboxFixtureDb, seedInboxRun, runStatus } from '../__test_fixtures__/reviewInboxTestDb';
import type Database from 'better-sqlite3';

afterEach(() => {
  vi.restoreAllMocks();
});

const STALE_THRESHOLD_MS = 45 * 60 * 1000;
const STALE_AGO = new Date(Date.now() - (STALE_THRESHOLD_MS + 60 * 1000)).toISOString();
const FRESH_AGO = new Date(Date.now() - 60 * 1000).toISOString();

/**
 * The inbox fixture's migration set predates execution_model (032), which
 * isLatestRunTurnCompleted reads to exempt programmatic runs. Added locally,
 * as runRecovery.test.ts does, rather than widening the shared fixture.
 */
function buildReviewInboxDb(): Database.Database {
  const db = buildInboxFixtureDb();
  db.exec("ALTER TABLE workflow_runs ADD COLUMN execution_model TEXT NOT NULL DEFAULT 'orchestrated'");
  return db;
}

function makeClaudeManager(active: Set<string> = new Set()): ClaudeManagerLike {
  return { hasActiveRunForId: (runId) => active.has(runId) };
}

function seedRawEvent(db: Database.Database, runId: string, createdAt: string, eventType = 'sdk_message'): void {
  db.prepare(
    `INSERT INTO raw_events (run_id, event_type, payload_json, created_at) VALUES (?, ?, '{}', ?)`,
  ).run(runId, eventType, createdAt);
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

  it('does NOT fire on a long, quiet turn that is still genuinely live (visual-verify fix)', async () => {
    // raw_events recency ALONE cannot tell a truly parked run apart from a run
    // mid-way through a long tool call that has produced no intermediate
    // events for well over the staleness window — both look identical to the
    // SQL scan. hasActiveRunForId is the real-time signal that disambiguates
    // them; a run it reports as still alive must never be stamped stuck just
    // because its last event is old.
    const db = buildReviewInboxDb();
    seedInboxRun(db, 'run-quiet-but-live', 'running');
    seedRawEvent(db, 'run-quiet-but-live', STALE_AGO);

    const emitter = new EventEmitter();
    const events: StuckDetectedEvent[] = [];
    emitter.on('runs:stuck', (e) => events.push(e as StuckDetectedEvent));

    const detector = new StuckDetector({
      db: dbAdapter(db),
      claudeManager: makeClaudeManager(new Set(['run-quiet-but-live'])),
      emitter,
      logger: makeSpyLogger(),
    });

    await detector.scan();

    expect(runStatus(db, 'run-quiet-but-live')).toBe('running');
    expect(events).toHaveLength(0);
  });

  it('does NOT fire on a freshly started run with no raw_events yet (visual-verify fix)', async () => {
    // Before the fix, COALESCE(..., 0) treated "zero raw_events" as maximally
    // stale — a run whose spawn had not yet produced its first SDK message
    // would satisfy `0 < cutoff` on the very next 60s scan tick regardless of
    // how young it actually was. The fallback now reads wr.created_at (which
    // seedInboxRun defaults to "now"), so a fresh run gets the SAME 45-minute
    // grace period as one with events.
    const db = buildReviewInboxDb();
    seedInboxRun(db, 'run-brand-new', 'running');
    // Deliberately no raw_events row at all.

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

    expect(runStatus(db, 'run-brand-new')).toBe('running');
    expect(events).toHaveLength(0);
  });

  // TASK-300 attempt 4: `hasActiveRunForId` alone left the hung-detached-child
  // shape uncaught FOREVER — a background process the agent spawned (e.g. a
  // left-running dev server) keeps that flag wedged true even after the
  // turn itself has actually ended. isLatestRunTurnCompleted resolves the
  // ambiguity from the persisted event log: a `result` row as the LAST event
  // proves the turn is over regardless of what the liveness flag still
  // claims, so this shape now gets classified instead of silently parked
  // forever with no stuck_reason.
  it('transitions a hung-spawn run: hasActiveRunForId reports true but the last event is a result (TASK-300 attempt 4)', async () => {
    const db = buildReviewInboxDb();
    seedInboxRun(db, 'run-hung-child', 'running');
    seedRawEvent(db, 'run-hung-child', STALE_AGO, 'result');

    const emitter = new EventEmitter();
    const events: StuckDetectedEvent[] = [];
    emitter.on('runs:stuck', (e) => events.push(e as StuckDetectedEvent));

    const detector = new StuckDetector({
      db: dbAdapter(db),
      // Exactly the observed bug: a detached background child keeps the
      // process-liveness signal wedged true even though the turn is done.
      claudeManager: makeClaudeManager(new Set(['run-hung-child'])),
      emitter,
      logger: makeSpyLogger(),
    });

    await detector.scan();

    expect(runStatus(db, 'run-hung-child')).toBe('stuck');
    const row = db
      .prepare('SELECT stuck_reason FROM workflow_runs WHERE id = ?')
      .get('run-hung-child') as { stuck_reason: string | null };
    expect(row.stuck_reason).toBe('parked_no_gate');
    expect(events).toHaveLength(1);
  });

  // Negative control for the same fix: a genuinely live long turn (active,
  // last row is a real mid-turn event, not a result) must stay skipped even
  // though it is just as stale by raw_events recency alone.
  it('does NOT fire on a genuinely live long turn: active, last row is an assistant event, stale', async () => {
    const db = buildReviewInboxDb();
    seedInboxRun(db, 'run-live-long-turn', 'running');
    seedRawEvent(db, 'run-live-long-turn', STALE_AGO, 'assistant');

    const emitter = new EventEmitter();
    const events: StuckDetectedEvent[] = [];
    emitter.on('runs:stuck', (e) => events.push(e as StuckDetectedEvent));

    const detector = new StuckDetector({
      db: dbAdapter(db),
      claudeManager: makeClaudeManager(new Set(['run-live-long-turn'])),
      emitter,
      logger: makeSpyLogger(),
    });

    await detector.scan();

    expect(runStatus(db, 'run-live-long-turn')).toBe('running');
    expect(events).toHaveLength(0);
  });

  // A programmatic walk is not one conversation: a step's (or a fan-out lane's)
  // `result` row does not prove the walk ended — the next step, or a sibling
  // lane in a quiet tool call, can still be live under the same run_id. While
  // the executor holds the run, the rung must leave it alone.
  it('does NOT fire on a live programmatic run whose last row is one step/lane result', async () => {
    const db = buildReviewInboxDb();
    seedInboxRun(db, 'run-programmatic', 'running');
    db.prepare("UPDATE workflow_runs SET execution_model = 'programmatic' WHERE id = ?").run('run-programmatic');
    seedRawEvent(db, 'run-programmatic', STALE_AGO, 'result');

    const emitter = new EventEmitter();
    const events: StuckDetectedEvent[] = [];
    emitter.on('runs:stuck', (e) => events.push(e as StuckDetectedEvent));

    const detector = new StuckDetector({
      db: dbAdapter(db),
      claudeManager: makeClaudeManager(new Set(['run-programmatic'])),
      emitter,
      logger: makeSpyLogger(),
    });

    await detector.scan();

    expect(runStatus(db, 'run-programmatic')).toBe('running');
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
