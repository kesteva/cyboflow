/**
 * CapturePipeline — unit tests over the legacy capture engine extracted from
 * VerificationScheduler (issue #19 step 7). The scheduler suites still drive this
 * path end-to-end through drain (S2 dev server, S9 static server, S5 pre-diff,
 * timeouts, cancel); these pin the collaborator's OWN contract directly, with no
 * scheduler, lease pool, or drain in front of it: the deterministic-first verdict
 * order, the budget gate, the confidence floor, diagnostics capping, the server
 * spawn/teardown ordering, and the in-flight registry + deadline.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import { CapturePipeline } from '../capturePipeline';
import type { CapturePipelineDeps } from '../capturePipeline';
import { TerminalDelivery } from '../terminalDelivery';
import type { OnVerdict } from '../verificationSchedulerContracts';
import type { LeaseHandle } from '../verificationLeases';
import type { VerificationRequestRow } from '../verificationRequestRows';
import { VISUAL_VERIFY_DEFAULTS } from '../../../../../shared/types/visualVerification';
import type {
  CaptureContext,
  CaptureResult,
  VerdictV1,
  VerificationRequestInput,
  VisualBackend,
  VlmJudge,
} from '../../../../../shared/types/visualVerification';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function buildDb(): Database.Database {
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
      ended_at         DATETIME,
      report_json      TEXT,
      delivery_state   TEXT
    );
  `);
  return db;
}

const PASS_VERDICT: VerdictV1 = {
  status: 'pass',
  confidence: 0.95,
  issues: [],
  feedback: 'looks right',
  judgedFileNames: ['default.png'],
  baselineUsed: false,
  model: 'fake',
};

function row(input: VerificationRequestInput): VerificationRequestRow {
  return {
    id: 'r1',
    run_id: 'run-1',
    project_id: 1,
    status: 'running',
    verify_type: 'static-render-snapshot',
    deliverable_json: JSON.stringify(input),
    chain_json: null,
    current_backend: null,
    attempt: 0,
    enqueued_at: '',
  };
}

function lease(name: string | null, released: string[]): LeaseHandle {
  return { name, release: () => released.push('lease') };
}

function backend(capture: (ctx: CaptureContext, signal: AbortSignal) => Promise<CaptureResult>): VisualBackend {
  return { id: 'playwright', rung: 1, requiredLease: () => null, healthCheck: async () => true, capture };
}

const okCapture = async (): Promise<CaptureResult> => ({ ok: true, fileNames: ['default.png'] });

interface Harness {
  db: Database.Database;
  pipeline: CapturePipeline;
  judge: ReturnType<typeof vi.fn<VlmJudge['judge']>>;
  onVerdict: ReturnType<typeof vi.fn<OnVerdict>>;
  inFlight: Map<string, AbortController>;
  budgetExhausted: { value: boolean };
  judgeCalls: string[];
}

function harness(over: Partial<CapturePipelineDeps> = {}, judgeVerdict: VerdictV1 = PASS_VERDICT): Harness {
  const db = buildDb();
  db.prepare(
    `INSERT INTO verification_requests (id, run_id, project_id, status, verify_type, deliverable_json)
     VALUES ('r1', 'run-1', 1, 'running', 'static-render-snapshot', '{}')`,
  ).run();
  const onVerdict = vi.fn<OnVerdict>(async () => undefined);
  const judge = vi.fn<VlmJudge['judge']>(async () => judgeVerdict);
  const inFlight = new Map<string, AbortController>();
  const budgetExhausted = { value: false };
  const judgeCalls: string[] = [];
  const pipeline = new CapturePipeline({
    judge: { judge },
    config: VISUAL_VERIFY_DEFAULTS,
    artifactsDirResolver: (runId) => `/artifacts/${runId}`,
    requestTimeoutMs: 60_000,
    baselineMatchThreshold: 0.98,
    delivery: new TerminalDelivery({ db: dbAdapter(db), onVerdict }),
    inFlight,
    portFromLease: (name) => (name?.startsWith('verify:port:') ? Number(name.slice('verify:port:'.length)) : null),
    inputDeclaresDevServer: (input) => typeof input.start === 'string' && input.start.trim().length > 0,
    acquireBatchMutex: async () => null,
    isProjectBudgetExhausted: () => budgetExhausted.value,
    incrementJudgeCallsUsed: (id) => judgeCalls.push(id),
    ...over,
  });
  return { db, pipeline, judge, onVerdict, inFlight, budgetExhausted, judgeCalls };
}

function terminal(db: Database.Database): { status: string; verdict: VerdictV1 | null; error: string | null; delivery: string | null } {
  const r = db
    .prepare('SELECT status, verdict_json, error_message, delivery_state FROM verification_requests WHERE id = ?')
    .get('r1') as { status: string; verdict_json: string | null; error_message: string | null; delivery_state: string | null };
  return { status: r.status, verdict: r.verdict_json ? (JSON.parse(r.verdict_json) as VerdictV1) : null, error: r.error_message, delivery: r.delivery_state };
}

// ---------------------------------------------------------------------------

describe('CapturePipeline.runChosen', () => {
  let h: Harness;
  afterEach(() => {
    vi.useRealTimers();
    h.db.close();
  });

  describe('verdict order: deterministic → SSIM → budget → VLM', () => {
    it('uses a backend deterministic verdict and never calls the judge', async () => {
      h = harness();
      const released: string[] = [];
      const input = { intent: 'x', htmlPath: 'dist/index.html' };

      await h.pipeline.runChosen(
        row(input),
        'static-render-snapshot',
        input,
        backend(async () => ({ ok: true, fileNames: ['a.png'], deterministicVerdict: { ...PASS_VERDICT, status: 'fail', confidence: 1 } })),
        lease(null, released),
        null,
      );

      expect(h.judge).not.toHaveBeenCalled();
      expect(terminal(h.db)).toMatchObject({ status: 'failed', delivery: 'delivered' });
      expect(h.onVerdict).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', fileNames: ['a.png'], captureOrigin: 'file' }));
      expect(released).toEqual(['lease']);
      expect(h.inFlight.size).toBe(0);
    });

    it('short-circuits on an SSIM match, re-deriving the gate against its own threshold', async () => {
      h = harness({ baselinePreDiff: async () => ({ baselinePath: '/b/base.png', ssimScore: 0.985, match: false }) });
      const input = { intent: 'x', htmlPath: 'dist/index.html', baselineKey: 'home' };

      await h.pipeline.runChosen(row(input), 'static-render-snapshot', input, backend(okCapture), lease(null, []), null);

      expect(h.judge).not.toHaveBeenCalled();
      expect(h.judgeCalls).toEqual([]);
      const t = terminal(h.db);
      expect(t.status).toBe('passed');
      expect(t.verdict).toMatchObject({ model: 'ssim-prediff', verdictSource: 'ssim_match', ssimScore: 0.985, baselineUsed: true });
    });

    it('routes an exhausted project budget to low_confidence without a vision call', async () => {
      h = harness();
      h.budgetExhausted.value = true;
      const input = { intent: 'x', htmlPath: 'dist/index.html' };

      await h.pipeline.runChosen(row(input), 'static-render-snapshot', input, backend(okCapture), lease(null, []), null);

      expect(h.judge).not.toHaveBeenCalled();
      expect(h.judgeCalls).toEqual([]);
      expect(terminal(h.db)).toMatchObject({ status: 'low_confidence' });
      expect(terminal(h.db).verdict).toMatchObject({ model: 'budget-exhausted' });
    });

    it('counts a real VLM call before judging and threads the baseline path in', async () => {
      h = harness({ baselinePreDiff: async () => ({ baselinePath: '/b/base.png', ssimScore: 0.5, match: false }) });
      const input = { intent: 'the hero renders', htmlPath: 'dist/index.html', baselineKey: 'home' };

      await h.pipeline.runChosen(row(input), 'static-render-snapshot', input, backend(okCapture), lease(null, []), null);

      expect(h.judgeCalls).toEqual(['r1']);
      expect(h.judge).toHaveBeenCalledWith(
        { intent: 'the hero renders', artifactsDir: '/artifacts/run-1', fileNames: ['default.png'], type: 'static-render-snapshot', baselinePath: '/b/base.png' },
        expect.any(AbortSignal),
      );
      const t = terminal(h.db);
      expect(t.status).toBe('passed');
      expect(t.verdict).toMatchObject({ verdictSource: 'vlm_verdict', ssimScore: 0.5 });
    });

    it('demotes a verdict under the confidence floor to low_confidence', async () => {
      h = harness({}, { ...PASS_VERDICT, confidence: VISUAL_VERIFY_DEFAULTS.vlmConfidenceThreshold - 0.01 });
      const input = { intent: 'x', htmlPath: 'dist/index.html' };

      await h.pipeline.runChosen(row(input), 'static-render-snapshot', input, backend(okCapture), lease(null, []), null);

      expect(terminal(h.db).status).toBe('low_confidence');
    });
  });

  describe('failure + diagnostics', () => {
    it('marks a capture with no images failed and caps untrusted diagnostics at 10 entries / 2000 chars', async () => {
      h = harness();
      const diagnostics = Array.from({ length: 12 }, (_, i) => `${i}:`.padEnd(300, 'x'));
      const input = { intent: 'x', htmlPath: 'dist/index.html' };

      await h.pipeline.runChosen(
        row(input),
        'static-render-snapshot',
        input,
        backend(async () => ({ ok: false, fileNames: [], error: 'renderer crashed', diagnostics })),
        lease(null, []),
        null,
      );

      expect(terminal(h.db)).toMatchObject({ status: 'failed', error: 'renderer crashed' });
      const delivered = h.onVerdict.mock.calls[0][0];
      expect(delivered.diagnostics).toHaveLength(7); // 6 × 300 + a 200-char truncated 7th = 2000
      expect(delivered.diagnostics?.reduce((n, d) => n + d.length, 0)).toBe(2000);
      expect(h.judge).not.toHaveBeenCalled();
    });

    it('marks a throwing backend failed, not timeout, when the signal never aborted', async () => {
      h = harness();
      const input = { intent: 'x', htmlPath: 'dist/index.html' };

      await h.pipeline.runChosen(
        row(input),
        'static-render-snapshot',
        input,
        backend(async () => {
          throw new Error('chromium missing');
        }),
        lease(null, []),
        null,
      );

      expect(terminal(h.db)).toMatchObject({ status: 'failed', error: 'chromium missing' });
      expect(h.inFlight.size).toBe(0);
    });
  });

  describe('deadline + in-flight registry', () => {
    it('registers the controller while capturing, aborts at the deadline, and marks timeout', async () => {
      vi.useFakeTimers();
      h = harness({ requestTimeoutMs: 1_000 });
      const released: string[] = [];
      const input = { intent: 'x', htmlPath: 'dist/index.html' };
      let observed: AbortSignal | undefined;
      const work = h.pipeline.runChosen(
        row(input),
        'static-render-snapshot',
        input,
        backend((_ctx, signal) => {
          observed = signal;
          return new Promise<CaptureResult>(() => {}); // abort-unaware: never settles
        }),
        lease('verify:screen', released),
        null,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(h.inFlight.has('r1')).toBe(true);

      await vi.advanceTimersByTimeAsync(1_000);
      await work;

      expect(observed?.aborted).toBe(true);
      expect(terminal(h.db)).toMatchObject({ status: 'timeout', error: 'request timed out' });
      expect(h.inFlight.has('r1')).toBe(false);
      expect(released).toEqual(['lease']);
    });

    it('reports a cancel that arrived mid-capture as timeout with error "aborted"', async () => {
      h = harness();
      const input = { intent: 'x', htmlPath: 'dist/index.html' };

      await h.pipeline.runChosen(
        row(input),
        'static-render-snapshot',
        input,
        backend(async () => {
          h.inFlight.get('r1')?.abort(); // what cancelForRun does
          return { ok: true, fileNames: ['a.png'] };
        }),
        lease(null, []),
        null,
      );

      expect(terminal(h.db)).toMatchObject({ status: 'timeout', error: 'aborted' });
      expect(h.judge).not.toHaveBeenCalled();
    });
  });

  describe('scheduler-owned servers', () => {
    it('stands a dev server up on the leased port, captures its baseUrl, and tears it down before the lease', async () => {
      const released: string[] = [];
      const spawn = vi.fn(async (args: { port: number; cwd: string }) => ({
        baseUrl: `http://127.0.0.1:${args.port}`,
        release: async () => {
          released.push('dev-server');
        },
      }));
      h = harness({ devServerProvider: { spawn } });
      let captured: CaptureContext | undefined;
      const input = { intent: 'x', start: 'npm run dev' };

      await h.pipeline.runChosen(
        row(input),
        'static-render-snapshot',
        input,
        backend(async (ctx) => {
          captured = ctx;
          return { ok: true, fileNames: ['a.png'] };
        }),
        lease('verify:port:5173', released),
        { cwd: '/wt', deliverable: { id: 'web', start: 'npm run dev' } },
      );

      expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ port: 5173, cwd: '/wt' }));
      expect(captured?.input.url).toBe('http://127.0.0.1:5173');
      expect(h.onVerdict).toHaveBeenCalledWith(expect.objectContaining({ captureOrigin: 'dev-server' }));
      expect(released).toEqual(['dev-server', 'lease']);
    });

    it('serves a bare htmlPath statically when no dev server applies, and fail-softs a spawn error', async () => {
      const spawn = vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:4000', release: async () => {} }));
      h = harness({
        staticServerProvider: { spawn },
        staticHtmlContextResolver: async ({ htmlPath }) => ({ absoluteHtmlPath: `/wt/${htmlPath}`, staticRoot: '/wt/dist' }),
      });
      let captured: CaptureContext | undefined;
      const input = { intent: 'x', htmlPath: 'dist/index.html' };
      const capture = backend(async (ctx) => {
        captured = ctx;
        return { ok: true, fileNames: ['a.png'] };
      });

      await h.pipeline.runChosen(row(input), 'static-render-snapshot', input, capture, lease(null, []), null);

      expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ absoluteHtmlPath: '/wt/dist/index.html', staticRoot: '/wt/dist' }));
      expect(captured?.input.url).toBe('http://127.0.0.1:4000');
      expect(h.onVerdict).toHaveBeenCalledWith(expect.objectContaining({ captureOrigin: 'static-server' }));

      // A bind failure never fails the request: the raw htmlPath is captured instead.
      h.db.close();
      h = harness({
        staticServerProvider: {
          spawn: async () => {
            throw new Error('EADDRINUSE');
          },
        },
        staticHtmlContextResolver: async () => ({ absoluteHtmlPath: '/wt/dist/index.html', staticRoot: '/wt/dist' }),
      });
      await h.pipeline.runChosen(row(input), 'static-render-snapshot', input, capture, lease(null, []), null);
      expect(captured?.input.url).toBeUndefined();
      expect(terminal(h.db).status).toBe('passed');
      expect(h.onVerdict).toHaveBeenCalledWith(expect.objectContaining({ captureOrigin: 'file' }));
    });
  });
});
