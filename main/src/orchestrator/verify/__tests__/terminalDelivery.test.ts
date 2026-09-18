/**
 * TerminalDelivery — unit tests over the terminal-write + verdict-delivery
 * chokepoint extracted from VerificationScheduler (issue #19 step 6). The three
 * scheduler suites still exercise this path end-to-end through drain /
 * runRecovery; these pin the collaborator's OWN contract directly, without a
 * scheduler in front of it: the status-guarded write and its migration-095
 * fallback, cancel-race suppression, the §5.6 outbox stamps, the retry backoff,
 * and the replay reconstruction.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import { setSeamErrorSink } from '../../telemetrySink';
import { TerminalDelivery } from '../terminalDelivery';
import {
  DELIVERY_RETRY_BASE_MS,
  verificationChannel,
  verificationEvents,
} from '../verificationSchedulerContracts';
import type { OnVerdict, VerificationTerminalEvent } from '../verificationSchedulerContracts';
import type { VerificationRequestRow } from '../verificationRequestRows';
import type { VerdictV1 } from '../../../../../shared/types/visualVerification';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The minimal verification_requests table; `classified` adds the migration-095 columns. */
function buildDb(opts: { classified: boolean }): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE verification_requests (
      id               TEXT PRIMARY KEY,
      run_id           TEXT NOT NULL,
      project_id       INTEGER NOT NULL,
      status           TEXT NOT NULL DEFAULT 'queued',
      verify_type      TEXT NOT NULL,
      deliverable_json TEXT NOT NULL,
      chain_json       TEXT,
      current_backend  TEXT,
      attempt          INTEGER NOT NULL DEFAULT 0,
      verdict_json     TEXT,
      error_message    TEXT,
      enqueued_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      leased_at        DATETIME,
      ended_at         DATETIME,
      task_json        TEXT,
      report_json      TEXT,
      delivery_state   TEXT,
      snapshot_sha     TEXT,
      enqueue_key      TEXT${opts.classified ? `,
      failure_class          TEXT,
      failure_evidence_json  TEXT,
      preflight_json         TEXT` : ''}
    );
  `);
  return db;
}

const INPUT = { intent: 'the page renders', taskRef: 'TASK-7' };

const PASS_VERDICT: VerdictV1 = {
  status: 'pass',
  confidence: 0.95,
  issues: [],
  feedback: 'looks right',
  judgedFileNames: ['default.png'],
  baselineUsed: false,
  model: 'fake',
};

function insertRow(
  db: Database.Database,
  opts: { id: string; status?: string; deliveryState?: string | null; verdictJson?: string | null; reportJson?: string | null },
): void {
  db.prepare(
    `INSERT INTO verification_requests
       (id, run_id, project_id, status, verify_type, deliverable_json, chain_json, attempt, verdict_json, report_json, delivery_state)
     VALUES (?, 'run-1', 1, ?, 'static-render-snapshot', ?, '[]', 0, ?, ?, ?)`,
  ).run(
    opts.id,
    opts.status ?? 'running',
    JSON.stringify(INPUT),
    opts.verdictJson ?? null,
    opts.reportJson ?? null,
    opts.deliveryState ?? null,
  );
}

function row(id: string): VerificationRequestRow {
  return {
    id,
    run_id: 'run-1',
    project_id: 1,
    status: 'running',
    verify_type: 'static-render-snapshot',
    deliverable_json: JSON.stringify(INPUT),
    chain_json: null,
    current_backend: null,
    attempt: 0,
    enqueued_at: '',
  };
}

interface RowState {
  status: string;
  delivery_state: string | null;
  attempt: number;
  verdict_json: string | null;
  error_message: string | null;
  ended_at: string | null;
  failure_class?: string | null;
}

function readRow(db: Database.Database, id: string): RowState {
  return db.prepare('SELECT * FROM verification_requests WHERE id = ?').get(id) as RowState;
}

// ---------------------------------------------------------------------------

describe('TerminalDelivery', () => {
  let db: Database.Database;
  let events: VerificationTerminalEvent[];
  const onEvent = (e: VerificationTerminalEvent): void => {
    events.push(e);
  };

  beforeEach(() => {
    db = buildDb({ classified: true });
    events = [];
    verificationEvents.on(verificationChannel('run-1'), onEvent);
  });

  afterEach(() => {
    verificationEvents.off(verificationChannel('run-1'), onEvent);
    // The sink has no unset value; a no-op sink is the quiet default for later suites.
    setSeamErrorSink(() => {});
    vi.useRealTimers();
    db.close();
  });

  describe('markTerminal — the status-guarded terminal write', () => {
    it('transitions a live row once, stamping the outbox pending and bumping attempt', () => {
      insertRow(db, { id: 'r1', status: 'running' });
      const delivery = new TerminalDelivery({ db: dbAdapter(db) });

      const changes = delivery.markTerminal('r1', 'passed', { backend: 'playwright', verdict: PASS_VERDICT });

      expect(changes).toBe(1);
      const state = readRow(db, 'r1');
      expect(state.status).toBe('passed');
      expect(state.delivery_state).toBe('pending');
      expect(state.attempt).toBe(1);
      expect(JSON.parse(state.verdict_json ?? 'null')).toEqual(PASS_VERDICT);
      expect(state.ended_at).toBeTruthy();
    });

    it('changes nothing on a row that is already terminal — the earlier writer won', () => {
      insertRow(db, { id: 'r1', status: 'timeout' });
      const delivery = new TerminalDelivery({ db: dbAdapter(db) });

      expect(delivery.markTerminal('r1', 'passed', { verdict: PASS_VERDICT })).toBe(0);
      expect(readRow(db, 'r1').status).toBe('timeout');
      expect(readRow(db, 'r1').verdict_json).toBeNull();
    });

    it('writes the migration-095 classification columns in the same guarded write', () => {
      insertRow(db, { id: 'r1' });
      const delivery = new TerminalDelivery({ db: dbAdapter(db) });

      delivery.markTerminal('r1', 'failed', { error: 'boom', failureClass: 'env' });

      const state = readRow(db, 'r1');
      expect(state.status).toBe('failed');
      expect(state.error_message).toBe('boom');
      expect(state.failure_class).toBe('env');
    });

    it('falls back to the legacy write on a pre-095 schema instead of throwing', () => {
      db.close();
      db = buildDb({ classified: false });
      insertRow(db, { id: 'r1' });
      const debug = vi.fn();
      const delivery = new TerminalDelivery({
        db: dbAdapter(db),
        logger: { debug, info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });

      expect(delivery.markTerminal('r1', 'failed', { error: 'boom', failureClass: 'env' })).toBe(1);
      expect(readRow(db, 'r1').status).toBe('failed');
      expect(debug).toHaveBeenCalledWith(
        expect.stringContaining('classification columns unavailable'),
        expect.objectContaining({ requestId: 'r1' }),
      );
    });
  });

  describe('markTerminalAndDeliver', () => {
    it('delivers through the hook, THEN fires the terminal event, and stamps delivered', async () => {
      insertRow(db, { id: 'r1' });
      const order: string[] = [];
      const onVerdict = vi.fn<OnVerdict>(async () => {
        order.push('hook');
      });
      verificationEvents.once(verificationChannel('run-1'), () => order.push('event'));
      const delivery = new TerminalDelivery({ db: dbAdapter(db), onVerdict });

      await delivery.markTerminalAndDeliver(
        row('r1'),
        'passed',
        { backend: 'playwright', captureOrigin: 'agent', diagnostics: ['console: ok'] },
        PASS_VERDICT,
        ['default.png'],
        INPUT,
      );

      expect(order).toEqual(['hook', 'event']);
      expect(onVerdict).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: 'r1',
          runId: 'run-1',
          projectId: 1,
          type: 'static-render-snapshot',
          status: 'passed',
          verdict: PASS_VERDICT,
          fileNames: ['default.png'],
          input: INPUT,
          captureOrigin: 'agent',
          diagnostics: ['console: ok'],
        }),
      );
      expect(events).toEqual([
        { runId: 'run-1', requestId: 'r1', projectId: 1, status: 'passed', type: 'static-render-snapshot', taskRef: 'TASK-7' },
      ]);
      expect(readRow(db, 'r1').delivery_state).toBe('delivered');
    });

    it('suppresses delivery entirely when the guarded write lost the race', async () => {
      insertRow(db, { id: 'r1', status: 'timeout' });
      const onVerdict = vi.fn<OnVerdict>(async () => undefined);
      const delivery = new TerminalDelivery({ db: dbAdapter(db), onVerdict });

      await delivery.markTerminalAndDeliver(row('r1'), 'passed', {}, PASS_VERDICT, [], INPUT);

      expect(onVerdict).not.toHaveBeenCalled();
      expect(events).toEqual([]);
      expect(readRow(db, 'r1').status).toBe('timeout');
    });

    it('reports failed/timeout to the telemetry seam but never a skip', async () => {
      insertRow(db, { id: 'r1' });
      insertRow(db, { id: 'r2' });
      const seams: string[] = [];
      setSeamErrorSink((seam) => {
        seams.push(seam);
      });
      const delivery = new TerminalDelivery({ db: dbAdapter(db) });

      await delivery.markTerminalAndDeliver(row('r1'), 'skipped', { error: 'no backend' }, undefined, []);
      await delivery.markTerminalAndDeliver(row('r2'), 'failed', { error: 'capture threw' }, undefined, []);

      expect(seams).toEqual(['verify-request-failed']);
    });

    it('still fires the terminal event when the hook throws, and leaves the row pending', async () => {
      insertRow(db, { id: 'r1' });
      const error = vi.fn();
      const delivery = new TerminalDelivery({
        db: dbAdapter(db),
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error },
        onVerdict: async () => {
          throw new Error('router down');
        },
      });

      await delivery.markTerminalAndDeliver(row('r1'), 'passed', {}, PASS_VERDICT, [], INPUT);

      expect(events).toHaveLength(1);
      expect(readRow(db, 'r1')).toMatchObject({ status: 'passed', delivery_state: 'pending' });
      expect(error).toHaveBeenCalledWith(expect.stringContaining('onVerdict hook threw'), expect.objectContaining({ requestId: 'r1' }));
    });
  });

  describe('retry sweep + replay (§5.6 outbox)', () => {
    it('re-delivers a pending row after the base backoff and stamps it delivered once the hook succeeds', async () => {
      vi.useFakeTimers();
      insertRow(db, { id: 'r1' });
      let succeed = false;
      const onVerdict = vi.fn<OnVerdict>(async () => succeed);
      const delivery = new TerminalDelivery({ db: dbAdapter(db), onVerdict });

      await delivery.markTerminalAndDeliver(row('r1'), 'passed', {}, PASS_VERDICT, ['default.png'], INPUT);
      expect(readRow(db, 'r1').delivery_state).toBe('pending');
      expect(onVerdict).toHaveBeenCalledTimes(1);

      succeed = true;
      await vi.advanceTimersByTimeAsync(DELIVERY_RETRY_BASE_MS - 1);
      expect(onVerdict).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);

      expect(onVerdict).toHaveBeenCalledTimes(2);
      expect(readRow(db, 'r1').delivery_state).toBe('delivered');
    });

    it('doubles the backoff while deliveries keep failing', async () => {
      vi.useFakeTimers();
      insertRow(db, { id: 'r1' });
      const onVerdict = vi.fn<OnVerdict>(async () => false);
      const delivery = new TerminalDelivery({ db: dbAdapter(db), onVerdict });

      await delivery.markTerminalAndDeliver(row('r1'), 'passed', {}, PASS_VERDICT, [], INPUT);
      await vi.advanceTimersByTimeAsync(DELIVERY_RETRY_BASE_MS); // first sweep fails → re-armed at 2× base
      expect(onVerdict).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(DELIVERY_RETRY_BASE_MS);
      expect(onVerdict).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(DELIVERY_RETRY_BASE_MS);
      expect(onVerdict).toHaveBeenCalledTimes(3);
      expect(readRow(db, 'r1').delivery_state).toBe('pending');
    });

    it('replays only terminal rows marked pending, reconstructing verdict, input, and agent file names', async () => {
      insertRow(db, {
        id: 'agent-row',
        status: 'failed',
        deliveryState: 'pending',
        verdictJson: JSON.stringify({ ...PASS_VERDICT, status: 'fail' }),
        reportJson: JSON.stringify({ screenshots: [{ fileName: 'shot-1.png' }, { fileName: 'shot-2.png' }] }),
      });
      insertRow(db, { id: 'legacy-row', status: 'passed', deliveryState: null, verdictJson: JSON.stringify(PASS_VERDICT) });
      insertRow(db, { id: 'done-row', status: 'passed', deliveryState: 'delivered' });
      insertRow(db, { id: 'live-row', status: 'running', deliveryState: 'pending' });
      const onVerdict = vi.fn<OnVerdict>(async () => undefined);
      const delivery = new TerminalDelivery({ db: dbAdapter(db), onVerdict });

      const replayed = await delivery.replayPendingDeliveries();

      expect(replayed).toBe(1);
      expect(onVerdict).toHaveBeenCalledTimes(1);
      expect(onVerdict).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: 'agent-row',
          status: 'failed',
          verdict: expect.objectContaining({ status: 'fail' }),
          fileNames: ['shot-1.png', 'shot-2.png'],
          input: INPUT,
          captureOrigin: 'agent',
        }),
      );
      expect(readRow(db, 'agent-row').delivery_state).toBe('delivered');
      expect(readRow(db, 'legacy-row').delivery_state).toBeNull();
      expect(events.map((e) => e.requestId)).toEqual(['agent-row']);
    });

    it('is a no-op on a schema without delivery_state (fail-soft)', async () => {
      db.close();
      db = new Database(':memory:');
      db.exec(`CREATE TABLE verification_requests (id TEXT PRIMARY KEY, status TEXT NOT NULL)`);
      const delivery = new TerminalDelivery({ db: dbAdapter(db) });

      await expect(delivery.replayPendingDeliveries()).resolves.toBe(0);
    });
  });
});
