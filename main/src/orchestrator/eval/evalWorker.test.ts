/**
 * Unit tests for the EvalWorker with a fake DatabaseLike, a fake JudgeClient, and a
 * spy reviewItemWriter — no SDK, no better-sqlite3, no queue timing. Pins: the
 * pending→running→complete state machine, per-sample retry-then-drop (>=1 valid to
 * score, else failed), findings dedup + cap + blocking-only-for-catastrophic, and
 * the shutdown pause.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EvalWorker, type JurySlot } from './evalWorker';
import type { DatabaseLike } from '../types';
import type { JudgeClient, JudgeGradeInput } from './evalJury';
import { CodexJurorUnavailableError } from './codexJudge';
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
  calls = 0;
  constructor(
    private readonly impl: (input: JudgeGradeInput, call: number) => Promise<JudgeSample>,
    readonly resolvedModel: string = 'claude-opus-4-8',
  ) {}
  grade(input: JudgeGradeInput): Promise<JudgeSample> {
    const c = this.calls++;
    return this.impl(input, c);
  }
}

function makeClaudeJury(judge: JudgeClient, count: number = 3): JurySlot[] {
  return Array.from({ length: count }, (_unused, index) => ({
    slot: `claude-${index + 1}`,
    provider: 'claude' as const,
    model: 'claude-opus-4-8',
    judge,
  }));
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
      jury: makeClaudeJury(judge),
      reviewItemWriter: writer,
      appVersion: '0.1.11',
      isEvalEnabled: () => true,
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
    expect(complete?.params).toContain(3);
    expect(JSON.parse(complete?.params[10] as string)).toEqual([
      { slot: 'claude-1', provider: 'claude', model: 'claude-opus-4-8', status: 'ok', sampleIndex: 0 },
      { slot: 'claude-2', provider: 'claude', model: 'claude-opus-4-8', status: 'ok', sampleIndex: 1 },
      { slot: 'claude-3', provider: 'claude', model: 'claude-opus-4-8', status: 'ok', sampleIndex: 2 },
    ]);
  });

  it('scores two Claude samples when Codex is unavailable and does not retry Codex', async () => {
    const db = noExistingFindings();
    const claude = new FakeJudge(async () => sampleAllPass(BROAD_PASS));
    const codex = new FakeJudge(async () => {
      throw new CodexJurorUnavailableError('logged out', 'logged-out');
    }, 'gpt-5.4');
    const worker = EvalWorker.initialize(db, undefined, {
      gitDiff: vi.fn(),
      jury: [
        ...makeClaudeJury(claude, 2),
        { slot: 'codex-1', provider: 'codex', model: 'gpt-5.4', judge: codex },
      ],
      reviewItemWriter: vi.fn(async () => ({ reviewItemId: 'ri' })),
      appVersion: '0.1.11',
      isEvalEnabled: () => true,
      sleep: async () => {},
    });
    worker.enqueue('run-1', '1.1');
    await worker._queue().onIdle();

    expect(codex.calls).toBe(1);
    const complete = db.runs.find((run) => run.sql.includes("eval_status = 'complete'"));
    expect(complete?.params[11]).toBe(2);
    expect(JSON.parse(complete?.params[10] as string)).toEqual([
      { slot: 'claude-1', provider: 'claude', model: 'claude-opus-4-8', status: 'ok', sampleIndex: 0 },
      { slot: 'claude-2', provider: 'claude', model: 'claude-opus-4-8', status: 'ok', sampleIndex: 1 },
      { slot: 'codex-1', provider: 'codex', model: 'gpt-5.4', status: 'unavailable', errorCode: 'logged-out' },
    ]);
  });

  it('retries a transient Codex failure once then records the slot failed', async () => {
    const db = noExistingFindings();
    const claude = new FakeJudge(async () => sampleAllPass(BROAD_PASS));
    const codex = new FakeJudge(async () => {
      throw new Error('protocol crash');
    }, 'gpt-5.4');
    const worker = EvalWorker.initialize(db, undefined, {
      gitDiff: vi.fn(),
      jury: [
        ...makeClaudeJury(claude, 2),
        { slot: 'codex-1', provider: 'codex', model: 'gpt-5.4', judge: codex },
      ],
      reviewItemWriter: vi.fn(async () => ({ reviewItemId: 'ri' })),
      appVersion: '0.1.11',
      isEvalEnabled: () => true,
      sleep: async () => {},
    });
    worker.enqueue('run-1', '1.1');
    await worker._queue().onIdle();

    expect(codex.calls).toBe(2);
    const complete = db.runs.find((run) => run.sql.includes("eval_status = 'complete'"));
    const jury = JSON.parse(complete?.params[10] as string) as Array<{ slot: string; status: string }>;
    expect(jury.find((slot) => slot.slot === 'codex-1')).toEqual({
      slot: 'codex-1',
      provider: 'codex',
      model: 'gpt-5.4',
      status: 'failed',
    });
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
      jury: makeClaudeJury(judge),
      reviewItemWriter: vi.fn(async () => ({ reviewItemId: 'ri' })),
      appVersion: '0.1.11',
      isEvalEnabled: () => true,
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
      jury: makeClaudeJury(judge),
      reviewItemWriter: vi.fn(async () => ({ reviewItemId: 'ri' })),
      appVersion: '0.1.11',
      isEvalEnabled: () => true,
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
      jury: makeClaudeJury(judge, 1),
      reviewItemWriter: writer,
      appVersion: '0.1.11',
      isEvalEnabled: () => true,
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

  it('collapses cross-sample paraphrases by sub-check id and reaches the blocking majority', async () => {
    // Live-smoke defect pair (2026-07-02): the K samples paraphrase ONE issue
    // into distinct titles. Under a title-based key that (a) wrote ~K near-
    // duplicate advisory items and (b) split the catastrophic vote 1-per-
    // paraphrase so the majority threshold was never reached.
    const paraphrase = (call: number, catastrophic: boolean): JudgeFinding => ({
      subCheckId: 'COR-3',
      dimension: 'correctness',
      severity: call === 1 ? 'error' : 'warning', // one sample grades it higher
      title: `NaN corruption, wording #${call}`,
      body: '',
      file: 'transfers.ts',
      line: 21,
      netNew: true,
      catastrophic,
    });
    const judge = new FakeJudge(async (_input, call) =>
      sampleAllPass(BROAD_PASS, [
        paraphrase(call, true),
        // General finding (no sub-check id) — title key keeps paraphrases apart.
        { subCheckId: '', dimension: 'robustness', severity: 'info', title: `general note #${call}`, body: '', netNew: true, catastrophic: false },
      ]),
    );
    const writes: Array<{ change: ReviewItemCreate }> = [];
    const worker = EvalWorker.initialize(noExistingFindings(), undefined, {
      gitDiff: vi.fn(),
      jury: makeClaudeJury(judge),
      reviewItemWriter: vi.fn(async (_projectId: number, change: ReviewItemCreate) => {
        writes.push({ change });
        return { reviewItemId: 'ri' };
      }),
      appVersion: '0.1.11',
      isEvalEnabled: () => true,
      sleep: async () => {},
    });
    worker.enqueue('run-1', '1.1');
    await worker._queue().onIdle();

    // ONE deduped COR-3 finding (not 3), blocking via the 3/3 catastrophic
    // majority, carrying the max severity seen across paraphrases…
    const cor3 = writes.filter((w) => JSON.stringify(w.change.payload).includes('COR-3'));
    expect(cor3).toHaveLength(1);
    expect(cor3[0].change.blocking).toBe(true);
    expect(cor3[0].change.severity).toBe('error');
    // …while the sub-check-less general notes still dedup by title (3 distinct).
    const general = writes.filter((w) => w.change.title.startsWith('general note'));
    expect(general).toHaveLength(3);
    expect(writes).toHaveLength(4);
  });

  it('requires a strict catastrophic majority with two surviving samples', async () => {
    const runWithCatastrophicVotes = async (catastrophicVotes: number): Promise<ReviewItemCreate[]> => {
      const writes: ReviewItemCreate[] = [];
      const judge = new FakeJudge(async (_input, call) => sampleAllPass(BROAD_PASS, [{
        subCheckId: 'COR-3',
        dimension: 'correctness',
        severity: 'error',
        title: 'Shared catastrophic candidate',
        body: '',
        file: 'shared.ts',
        netNew: true,
        catastrophic: call < catastrophicVotes,
      }]));
      const worker = EvalWorker.initialize(noExistingFindings(), undefined, {
        gitDiff: vi.fn(),
        jury: makeClaudeJury(judge, 2),
        reviewItemWriter: vi.fn(async (_projectId: number, change: ReviewItemCreate) => {
          writes.push(change);
          return { reviewItemId: 'ri' };
        }),
        appVersion: '0.1.11',
        isEvalEnabled: () => true,
        sleep: async () => {},
      });
      worker.enqueue('run-1', '1.1');
      await worker._queue().onIdle();
      return writes;
    };

    const oneVote = await runWithCatastrophicVotes(1);
    expect(oneVote).toHaveLength(1);
    expect(oneVote[0].blocking).toBe(false);

    const twoVotes = await runWithCatastrophicVotes(2);
    expect(twoVotes).toHaveLength(1);
    expect(twoVotes[0].blocking).toBe(true);
  });

  it('persists dimension name + weight in dimensions_json so panel labels render', async () => {
    const db = noExistingFindings();
    const worker = EvalWorker.initialize(db, undefined, {
      gitDiff: vi.fn(),
      jury: makeClaudeJury(new FakeJudge(async () => sampleAllPass(BROAD_PASS)), 1),
      reviewItemWriter: vi.fn(async () => ({ reviewItemId: 'ri' })),
      appVersion: '0.1.11',
      isEvalEnabled: () => true,
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
      jury: makeClaudeJury(judge, 1),
      reviewItemWriter: writer,
      appVersion: '0.1.11',
      isEvalEnabled: () => true,
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
      jury: makeClaudeJury(new FakeJudge(async () => sampleAllPass(BROAD_PASS))),
      reviewItemWriter: vi.fn(async () => ({ reviewItemId: 'ri' })),
      appVersion: '0.1.11',
      isEvalEnabled: () => true,
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
      jury: makeClaudeJury(new FakeJudge(async () => sampleAllPass(BROAD_PASS))),
      reviewItemWriter: vi.fn(async () => ({ reviewItemId: 'ri' })),
      appVersion: '0.1.11',
      isEvalEnabled: () => true,
      sleep: async () => {},
    });
    await worker.stop();
    expect(worker._queue().isPaused).toBe(true);
  });
});
