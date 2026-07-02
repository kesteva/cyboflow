/**
 * Unit tests for the EvalWorker with a fake DatabaseLike, a fake JudgeClient, and a
 * spy reviewItemWriter — no SDK, no better-sqlite3, no queue timing. Pins: the
 * pending→running→complete state machine, per-sample retry-then-drop (>=1 valid to
 * score, else failed), findings dedup + cap + blocking-only-for-catastrophic, and
 * the shutdown pause.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EvalWorker } from './evalWorker';
import type { DatabaseLike } from '../types';
import type { JudgeClient, JudgeGradeInput } from './evalJury';
import type { JudgeSample, JudgeFinding } from './scoring';
import type { ReviewItemCreate } from '../reviewItemRouter';

interface Call {
  sql: string;
  params: unknown[];
}

class FakeDb implements DatabaseLike {
  runs: Call[] = [];
  constructor(
    private onGet: (sql: string, params: unknown[]) => unknown,
    private onAll: (sql: string, params: unknown[]) => unknown[] = () => [],
  ) {}
  prepare(sql: string) {
    return {
      get: (...params: unknown[]) => this.onGet(sql, params),
      run: (...params: unknown[]) => {
        this.runs.push({ sql, params });
        return { changes: 1, lastInsertRowid: 1 };
      },
      all: (...params: unknown[]) => this.onAll(sql, params),
    };
  }
  transaction<T>(fn: (...args: unknown[]) => T) {
    return fn;
  }
}

const evalRunRow = () => ({
  project_id: 7,
  worktree_path: '/wt/run-1',
  diff_text: 'diff --git a/x b/x\n+changed',
  diff_stats_json: JSON.stringify({ additions: 1, deletions: 0, filesChanged: 1 }),
  gate_results_json: null,
});

/** A sample marking every listed id PASS (others absent => resolve NA/UNKNOWN). */
function sampleAllPass(ids: string[], findings: JudgeFinding[] = []): JudgeSample {
  return {
    verdicts: ids.map((id) => ({ id, verdict: 'PASS' as const, evidence: '' })),
    findings,
  };
}

class FakeJudge implements JudgeClient {
  readonly name = 'fake';
  readonly resolvedModel = 'claude-opus-4-8';
  calls = 0;
  constructor(private readonly impl: (input: JudgeGradeInput, call: number) => Promise<JudgeSample>) {}
  grade(input: JudgeGradeInput): Promise<JudgeSample> {
    const c = this.calls++;
    return this.impl(input, c);
  }
}

// A broad set of PASS verdicts so at least two dimensions activate (>=2 applicable).
const BROAD_PASS = [
  'COR-1', 'COR-2', 'COR-3', 'COR-6', 'COR-8',
  'SEC-5', 'SEC-8',
  'MTN-2', 'MTN-5',
  'SCP-1', 'SCP-2', 'SCP-3', 'SCP-4',
];

const noExistingFindings = () => new FakeDb(() => evalRunRow(), () => []);

beforeEach(() => {
  // Reset the singleton between tests (no public reset — reach through initialize).
});

describe('EvalWorker.process (via enqueue + queue drain)', () => {
  it('runs pending→running→complete and persists the verdict', async () => {
    const db = noExistingFindings();
    const judge = new FakeJudge(async () => sampleAllPass(BROAD_PASS));
    const writer = vi.fn(async () => ({ reviewItemId: 'ri-1' }));
    const worker = EvalWorker.initialize(db, undefined, {
      gitDiff: vi.fn(),
      judge,
      reviewItemWriter: writer,
      appVersion: '0.1.11',
      sampleCount: 3,
      sleep: async () => {},
    });

    worker.enqueue('run-1', '1.1');
    await worker._queue().onIdle();

    expect(judge.calls).toBe(3);
    const running = db.runs.find((r) => r.sql.includes("eval_status = 'running'"));
    const complete = db.runs.find((r) => r.sql.includes("eval_status = 'complete'"));
    expect(running).toBeTruthy();
    expect(running?.params[0]).toBe('claude-opus-4-8'); // judge_model stamped
    expect(complete).toBeTruthy();
    // sample_count param present (9th positional in the complete UPDATE).
    expect(complete?.params).toContain(3);
  });

  it('retries a malformed sample once then drops it; >=1 valid still scores', async () => {
    const db = noExistingFindings();
    // call 0: throws (malformed) then its retry (call 1) also throws -> dropped.
    // remaining sample slots succeed.
    const judge = new FakeJudge(async (_input, call) => {
      if (call < 2) throw new Error('malformed');
      return sampleAllPass(BROAD_PASS);
    });
    const worker = EvalWorker.initialize(db, undefined, {
      gitDiff: vi.fn(),
      judge,
      reviewItemWriter: vi.fn(async () => ({ reviewItemId: 'ri' })),
      appVersion: '0.1.11',
      sampleCount: 3,
      sleep: async () => {},
    });
    worker.enqueue('run-1', '1.1');
    await worker._queue().onIdle();
    expect(db.runs.some((r) => r.sql.includes("eval_status = 'complete'"))).toBe(true);
  });

  it('marks the eval failed when every sample is malformed (0 valid)', async () => {
    const db = noExistingFindings();
    const judge = new FakeJudge(async () => {
      throw new Error('always malformed');
    });
    const worker = EvalWorker.initialize(db, undefined, {
      gitDiff: vi.fn(),
      judge,
      reviewItemWriter: vi.fn(async () => ({ reviewItemId: 'ri' })),
      appVersion: '0.1.11',
      sampleCount: 3,
      maxRetries: 1,
      sleep: async () => {},
    });
    worker.enqueue('run-1', '1.1');
    await worker._queue().onIdle();
    const failed = db.runs.find((r) => r.sql.includes("eval_status = 'failed'"));
    expect(failed).toBeTruthy();
    expect(String(failed?.params[0])).toMatch(/no valid sample/);
  });

  it('writes net-new findings blocking=false, catastrophic blocking=true, deduped against existing', async () => {
    const existingTitle = 'pre-existing finding';
    const db = new FakeDb(
      () => evalRunRow(),
      (sql) => {
        if (sql.includes('FROM review_items')) {
          return [{ title: existingTitle, payload_json: JSON.stringify({ locations: [{ path: 'a.ts' }] }) }];
        }
        return [];
      },
    );
    const findings: JudgeFinding[] = [
      // duplicate of an existing item (file + title) -> skipped
      { subCheckId: 'COR-3', dimension: 'correctness', severity: 'warning', title: existingTitle, body: '', file: 'a.ts', netNew: true, catastrophic: false },
      // net-new advisory
      { subCheckId: 'COR-8', dimension: 'correctness', severity: 'warning', title: 'inverted guard', body: 'b', file: 'b.ts', line: 4, netNew: true, catastrophic: false },
      // catastrophic -> blocking
      { subCheckId: 'SCP-1', dimension: 'scope', severity: 'error', title: 'AC not met', body: 'c', netNew: true, catastrophic: true },
      // not net-new -> skipped
      { subCheckId: 'MTN-2', dimension: 'maintainability', severity: 'info', title: 'naming', body: '', netNew: false, catastrophic: false },
    ];
    const judge = new FakeJudge(async () => sampleAllPass(BROAD_PASS, findings));
    const writes: Array<{ projectId: number; change: ReviewItemCreate }> = [];
    const writer = vi.fn(async (projectId: number, change: ReviewItemCreate) => {
      writes.push({ projectId, change });
      return { reviewItemId: 'ri' };
    });
    const worker = EvalWorker.initialize(db, undefined, {
      gitDiff: vi.fn(),
      judge,
      reviewItemWriter: writer,
      appVersion: '0.1.11',
      sampleCount: 1,
      sleep: async () => {},
    });
    worker.enqueue('run-1', '1.1');
    await worker._queue().onIdle();

    // Only the two net-new, non-duplicate findings are written.
    expect(writes).toHaveLength(2);
    const titles = writes.map((w) => w.change.title).sort();
    expect(titles).toEqual(['AC not met', 'inverted guard']);
    for (const w of writes) {
      expect(w.projectId).toBe(7);
      expect(w.change.actor).toBe('agent:eval');
      expect(w.change.kind).toBe('finding');
      if (w.change.title === 'AC not met') expect(w.change.blocking).toBe(true);
      if (w.change.title === 'inverted guard') expect(w.change.blocking).toBe(false);
    }
  });

  it('persists dimension name + weight in dimensions_json so panel labels render', async () => {
    const db = noExistingFindings();
    const worker = EvalWorker.initialize(db, undefined, {
      gitDiff: vi.fn(),
      judge: new FakeJudge(async () => sampleAllPass(BROAD_PASS)),
      reviewItemWriter: vi.fn(async () => ({ reviewItemId: 'ri' })),
      appVersion: '0.1.11',
      sampleCount: 1,
      sleep: async () => {},
    });
    worker.enqueue('run-1', '1.1');
    await worker._queue().onIdle();
    const complete = db.runs.find((r) => r.sql.includes("eval_status = 'complete'"));
    const dims = JSON.parse(complete?.params[8] as string) as Array<{ name: unknown; weight: unknown }>;
    expect(dims.length).toBe(7);
    for (const d of dims) {
      expect(typeof d.name).toBe('string');
      expect((d.name as string).length).toBeGreaterThan(0);
      expect(typeof d.weight).toBe('number');
    }
  });

  it('synthesizes a BLOCKING review item when a cap fires with no catastrophic finding', async () => {
    const db = noExistingFindings();
    // SCP-1 FAIL fires the overall_fair_cap with NO findings[] entry — the blocking
    // half of the rubric's cap⇒blocking invariant must be synthesized.
    const judge = new FakeJudge(async () => ({
      verdicts: BROAD_PASS.map((id) => ({
        id,
        verdict: (id === 'SCP-1' ? 'FAIL' : 'PASS') as 'FAIL' | 'PASS',
        evidence: '',
      })),
      findings: [],
    }));
    const writes: ReviewItemCreate[] = [];
    const writer = vi.fn(async (_projectId: number, change: ReviewItemCreate) => {
      writes.push(change);
      return { reviewItemId: 'ri' };
    });
    const worker = EvalWorker.initialize(db, undefined, {
      gitDiff: vi.fn(),
      judge,
      reviewItemWriter: writer,
      appVersion: '0.1.11',
      sampleCount: 1,
      sleep: async () => {},
    });
    worker.enqueue('run-1', '1.1');
    await worker._queue().onIdle();
    expect(writes).toHaveLength(1);
    expect(writes[0].blocking).toBe(true);
    expect(writes[0].source).toBe('agent:eval');
    expect(writes[0].title).toMatch(/catastrophic/i);
  });

  it('recoverInterrupted re-enqueues each pending/running row on boot', () => {
    const db = new FakeDb(
      () => evalRunRow(),
      (sql) =>
        sql.includes('eval_status IN')
          ? [
              { run_id: 'r-a', rubric_version: '1.1' },
              { run_id: 'r-b', rubric_version: '1.0' },
            ]
          : [],
    );
    const worker = EvalWorker.initialize(db, undefined, {
      gitDiff: vi.fn(),
      judge: new FakeJudge(async () => sampleAllPass(BROAD_PASS)),
      reviewItemWriter: vi.fn(async () => ({ reviewItemId: 'ri' })),
      appVersion: '0.1.11',
      sleep: async () => {},
    });
    const spy = vi.spyOn(worker, 'enqueue');
    worker.recoverInterrupted();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenCalledWith('r-a', '1.1');
    expect(spy).toHaveBeenCalledWith('r-b', '1.0');
  });

  it('stop() pauses the queue', async () => {
    const worker = EvalWorker.initialize(noExistingFindings(), undefined, {
      gitDiff: vi.fn(),
      judge: new FakeJudge(async () => sampleAllPass(BROAD_PASS)),
      reviewItemWriter: vi.fn(async () => ({ reviewItemId: 'ri' })),
      appVersion: '0.1.11',
      sleep: async () => {},
    });
    await worker.stop();
    expect(worker._queue().isPaused).toBe(true);
  });
});
