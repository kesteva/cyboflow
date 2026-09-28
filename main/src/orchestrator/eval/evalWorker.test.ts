/**
 * Unit tests for the EvalWorker with a fake DatabaseLike, a fake JudgeClient, and a
 * spy reviewItemWriter — no SDK, no better-sqlite3, no queue timing. Pins: the
 * pending→running→complete state machine, per-sample retry-then-drop (>=1 valid to
 * score, else failed), findings dedup + cap + blocking-only-for-catastrophic, and
 * the shutdown pause.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  EvalWorker,
  JUDGE_RETRY_BACKOFF_MS,
  EVAL_REPORT_ARTIFACT_LABEL,
  EVAL_REPORT_POINTER,
  type JurySlot,
} from './evalWorker';
import { MAX_SLOT_ERROR_CHARS, truncateSlotError } from './judgeSlots';
import type { ArtifactCreate } from '../artifactRouter';
import type { DatabaseLike } from '../types';
import type { JudgeClient, JudgeGradeInput } from './evalJury';
import { CodexJurorUnavailableError } from './codexJudge';
import { EvalJudgeMaxTurnsError, EvalJudgeTimeoutError } from './judgeErrors';
import type { JudgeSample, JudgeFinding } from './scoring';
import type { ReviewItemCreate } from '../reviewItemRouter';
import { RUBRIC_VERSION } from './rubric';

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
  experiment_id: null, // normal run → parallel judge lane
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

/**
 * A judge that records the peak number of grades in flight at once, so a test can
 * assert whether the jury was dispatched in parallel (normal lane) or serialized
 * (A/B lane). One shared instance across the jury slots counts across all of them.
 */
class ConcurrencyProbeJudge implements JudgeClient {
  readonly name = 'probe';
  readonly resolvedModel = 'claude-opus-4-8';
  inFlight = 0;
  maxInFlight = 0;
  async grade(): Promise<JudgeSample> {
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    // Yield a macrotask so concurrently-dispatched grades overlap before any resolves.
    await new Promise((resolve) => setTimeout(resolve, 0));
    this.inFlight -= 1;
    return sampleAllPass(BROAD_PASS);
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
      { slot: 'codex-1', provider: 'codex', model: 'gpt-5.4', status: 'unavailable', errorCode: 'logged-out', error: 'logged out' },
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
      // The failure reason is persisted for post-hoc diagnosis (previously the
      // message survived only in the per-launch-truncated backend log).
      error: 'protocol crash',
    });
  });

  it('backs off once before the transient retry, but never for a deterministic failure', async () => {
    // Transient (non-deterministic) codex failure: one back-off before the single
    // retry. Two Claude slots pass without failing, so the ONLY sleep is the codex
    // slot's pre-retry back-off — asserting the count pins it to the retry path.
    const transientDb = noExistingFindings();
    const claude = new FakeJudge(async () => sampleAllPass(BROAD_PASS));
    const codex = new FakeJudge(async () => {
      throw new Error('protocol crash');
    }, 'gpt-5.4');
    const transientSleep = vi.fn(async () => {});
    const transientWorker = EvalWorker.initialize(transientDb, undefined, {
      gitDiff: vi.fn(),
      jury: [
        ...makeClaudeJury(claude, 2),
        { slot: 'codex-1', provider: 'codex', model: 'gpt-5.4', judge: codex },
      ],
      reviewItemWriter: vi.fn(async () => ({ reviewItemId: 'ri' })),
      appVersion: '0.1.11',
      isEvalEnabled: () => true,
      sleep: transientSleep,
    });
    transientWorker.enqueue('run-1', '1.1');
    await transientWorker._queue().onIdle();
    expect(codex.calls).toBe(2); // initial try + one retry
    expect(transientSleep).toHaveBeenCalledTimes(1);
    expect(transientSleep).toHaveBeenCalledWith(JUDGE_RETRY_BACKOFF_MS);

    // Deterministic timeout: bails on the first try, no retry -> no back-off sleep.
    const timeoutDb = noExistingFindings();
    const timedOut = new FakeJudge(async () => {
      throw new EvalJudgeTimeoutError('eval judge query timed out after 600000ms');
    });
    const timeoutSleep = vi.fn(async () => {});
    const timeoutWorker = EvalWorker.initialize(timeoutDb, undefined, {
      gitDiff: vi.fn(),
      jury: makeClaudeJury(timedOut),
      reviewItemWriter: vi.fn(async () => ({ reviewItemId: 'ri' })),
      appVersion: '0.1.11',
      isEvalEnabled: () => true,
      sleep: timeoutSleep,
    });
    timeoutWorker.enqueue('run-1', '1.1');
    await timeoutWorker._queue().onIdle();
    expect(timeoutSleep).not.toHaveBeenCalled();
  });

  it('retries a malformed sample once then drops it; >=1 valid still scores', async () => {
    const db = noExistingFindings();
    // One slot's judge throws on the initial try AND its one retry -> that slot is
    // dropped; the two good slots survive and still score. A dedicated throwing
    // judge (rather than a global call counter) keeps this deterministic whether
    // the jurors grade serially or in parallel.
    const good = new FakeJudge(async () => sampleAllPass(BROAD_PASS));
    const malformed = new FakeJudge(async () => {
      throw new Error('malformed');
    });
    const worker = EvalWorker.initialize(db, undefined, {
      gitDiff: vi.fn(),
      jury: [
        ...makeClaudeJury(good, 2),
        { slot: 'claude-3', provider: 'claude', model: 'claude-opus-4-8', judge: malformed },
      ],
      reviewItemWriter: vi.fn(async () => ({ reviewItemId: 'ri' })),
      appVersion: '0.1.11',
      isEvalEnabled: () => true,
      sleep: async () => {},
    });
    worker.enqueue('run-1', '1.1');
    await worker._queue().onIdle();
    expect(malformed.calls).toBe(2); // initial try + one retry, then dropped
    const complete = db.runs.find((r) => r.sql.includes("eval_status = 'complete'"));
    expect(complete).toBeTruthy();
    expect(complete?.params[11]).toBe(2); // sample_count = the two survivors
  });

  it('grades the jury in parallel for a normal run (normal lane)', async () => {
    const db = noExistingFindings(); // evalRunRow has experiment_id: null
    const probe = new ConcurrencyProbeJudge();
    const worker = EvalWorker.initialize(db, undefined, {
      gitDiff: vi.fn(),
      jury: makeClaudeJury(probe, 3),
      reviewItemWriter: vi.fn(async () => ({ reviewItemId: 'ri' })),
      appVersion: '0.1.11',
      isEvalEnabled: () => true,
      sleep: async () => {},
    });
    worker.enqueue('run-1', '1.1');
    await worker._queue().onIdle();
    // Default normal-lane concurrency is 3, so all three jurors overlap.
    expect(probe.maxInFlight).toBeGreaterThan(1);
  });

  it('serializes the jury for a side-by-side experiment arm (ab lane)', async () => {
    const db = new FakeDb(() => ({ ...evalRunRow(), experiment_id: 'exp-1' }), () => []);
    const probe = new ConcurrencyProbeJudge();
    const worker = EvalWorker.initialize(db, undefined, {
      gitDiff: vi.fn(),
      jury: makeClaudeJury(probe, 3),
      reviewItemWriter: vi.fn(async () => ({ reviewItemId: 'ri' })),
      appVersion: '0.1.11',
      isEvalEnabled: () => true,
      sleep: async () => {},
    });
    worker.enqueue('run-1', '1.1');
    await worker._queue().onIdle();
    // A tagged experiment arm grades on the concurrency-1 'ab' lane — never overlaps.
    expect(probe.maxInFlight).toBe(1);
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

  it('fails a timed-out slot on the FIRST try and skips the whole-eval retry when all slots are deterministic', async () => {
    const db = noExistingFindings();
    const timedOut = new FakeJudge(async () => {
      throw new EvalJudgeTimeoutError('eval judge query timed out after 600000ms');
    });
    const worker = EvalWorker.initialize(db, undefined, {
      gitDiff: vi.fn(),
      jury: makeClaudeJury(timedOut),
      reviewItemWriter: vi.fn(async () => ({ reviewItemId: 'ri' })),
      appVersion: '0.1.11',
      isEvalEnabled: () => true,
      sleep: async () => {},
    });
    worker.enqueue('run-1', '1.1');
    await worker._queue().onIdle();
    // 3 slots × 1 try × 1 whole-eval attempt. Before the deterministic-failure
    // policy this was 3 slots × 2 tries × 3 attempts = 18 full-deadline grades —
    // the amplification the adversarial review flagged on the 300s bump.
    expect(timedOut.calls).toBe(3);
    const failed = db.runs.find((r) => r.sql.includes("eval_status = 'failed'"));
    expect(failed).toBeTruthy();
    expect(String(failed?.params[0])).toMatch(/deterministic/);
    // Provenance records WHY each slot failed.
    const jury = JSON.parse(failed?.params[1] as string) as Array<{
      status: string;
      errorCode?: string;
    }>;
    expect(jury).toHaveLength(3);
    expect(jury.every((s) => s.status === 'failed' && s.errorCode === 'timeout')).toBe(true);
  });

  it('keeps the whole-eval retry when any failure is retryable; max-turns slots still skip the slot retry', async () => {
    const db = noExistingFindings();
    const maxTurns = new FakeJudge(async () => {
      throw new EvalJudgeMaxTurnsError('eval judge hit the 20-turn budget before emitting structured output');
    });
    const malformed = new FakeJudge(async () => {
      throw new Error('garbled sample');
    });
    const worker = EvalWorker.initialize(db, undefined, {
      gitDiff: vi.fn(),
      jury: [
        ...makeClaudeJury(maxTurns, 1),
        { slot: 'claude-2', provider: 'claude', model: 'claude-opus-4-8', judge: malformed },
      ],
      reviewItemWriter: vi.fn(async () => ({ reviewItemId: 'ri' })),
      appVersion: '0.1.11',
      isEvalEnabled: () => true,
      maxRetries: 1,
      sleep: async () => {},
    });
    worker.enqueue('run-1', '1.1');
    await worker._queue().onIdle();
    // max-turns: 1 try per attempt × 2 attempts; malformed (retryable): 2 tries × 2 attempts.
    expect(maxTurns.calls).toBe(2);
    expect(malformed.calls).toBe(4);
    const failed = db.runs.find((r) => r.sql.includes("eval_status = 'failed'"));
    expect(failed).toBeTruthy();
    expect(String(failed?.params[0])).not.toMatch(/deterministic/);
  });

  it('a surviving sample still completes the eval when another slot times out (no wasted timeout retry)', async () => {
    const db = noExistingFindings();
    const good = new FakeJudge(async () => sampleAllPass(BROAD_PASS));
    const timedOut = new FakeJudge(async () => {
      throw new EvalJudgeTimeoutError('eval judge query timed out after 600000ms');
    });
    const worker = EvalWorker.initialize(db, undefined, {
      gitDiff: vi.fn(),
      jury: [
        ...makeClaudeJury(good, 2),
        { slot: 'claude-3', provider: 'claude', model: 'claude-opus-4-8', judge: timedOut },
      ],
      reviewItemWriter: vi.fn(async () => ({ reviewItemId: 'ri' })),
      appVersion: '0.1.11',
      isEvalEnabled: () => true,
      sleep: async () => {},
    });
    worker.enqueue('run-1', '1.1');
    await worker._queue().onIdle();
    expect(timedOut.calls).toBe(1); // deterministic — no second identical try
    const complete = db.runs.find((r) => r.sql.includes("eval_status = 'complete'"));
    expect(complete).toBeTruthy();
    expect(complete?.params[11]).toBe(2); // the two good samples score
    const jury = JSON.parse(complete?.params[10] as string) as Array<{
      slot: string;
      status: string;
      errorCode?: string;
    }>;
    expect(jury.find((s) => s.slot === 'claude-3')).toMatchObject({
      status: 'failed',
      errorCode: 'timeout',
    });
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
    expect(dims.length).toBe(8);
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

  // ── Ad-hoc completion summary (migration 090 origin='adhoc') ─────────────

  it("writes ONE info summary review item when the row's origin is 'adhoc'", async () => {
    const db = new FakeDb(() => ({ ...evalRunRow(), origin: 'adhoc' }), () => []);
    const writer = vi.fn(async () => ({ reviewItemId: 'ri-summary' }));
    const worker = EvalWorker.initialize(db, undefined, {
      gitDiff: vi.fn(),
      jury: makeClaudeJury(new FakeJudge(async () => sampleAllPass(BROAD_PASS))),
      reviewItemWriter: writer,
      appVersion: '0.1.11',
      isEvalEnabled: () => true,
      sleep: async () => {},
    });
    worker.enqueue('run-1', RUBRIC_VERSION);
    await worker._queue().onIdle();

    // No judge findings in these samples, so the summary is the ONLY write.
    expect(writer).toHaveBeenCalledTimes(1);
    const [projectId, change] = writer.mock.calls[0] as unknown as [number, ReviewItemCreate];
    expect(projectId).toBe(7);
    expect(change.kind).toBe('finding');
    expect(change.severity).toBe('info');
    expect(change.blocking).toBe(false);
    expect(change.runId).toBe('run-1');
    expect(change.payload).toMatchObject({ category: 'eval' });
    expect(change.title).toMatch(/^Ad-hoc eval: .+ \(.+\/100\)$/);
    // Body carries the rollup: overall + CI + per-dimension lines.
    expect(change.body).toContain('**Overall:');
    expect(change.body).toContain('95% CI');
    expect(change.body).toContain('**Per dimension**');
  });

  it('does NOT write the summary for an automatic (origin NULL) row', async () => {
    const db = noExistingFindings(); // evalRunRow() has no origin => NULL
    const writer = vi.fn(async () => ({ reviewItemId: 'ri' }));
    const worker = EvalWorker.initialize(db, undefined, {
      gitDiff: vi.fn(),
      jury: makeClaudeJury(new FakeJudge(async () => sampleAllPass(BROAD_PASS))),
      reviewItemWriter: writer,
      appVersion: '0.1.11',
      isEvalEnabled: () => true,
      sleep: async () => {},
    });
    worker.enqueue('run-1', RUBRIC_VERSION);
    await worker._queue().onIdle();

    expect(writer).not.toHaveBeenCalled();
    expect(db.runs.some((r) => r.sql.includes("eval_status = 'complete'"))).toBe(true);
  });

  it('a summary-write failure never fails the eval (still complete, never failed)', async () => {
    const db = new FakeDb(() => ({ ...evalRunRow(), origin: 'adhoc' }), () => []);
    const worker = EvalWorker.initialize(db, undefined, {
      gitDiff: vi.fn(),
      jury: makeClaudeJury(new FakeJudge(async () => sampleAllPass(BROAD_PASS))),
      reviewItemWriter: vi.fn(async () => {
        throw new Error('review queue exploded');
      }),
      appVersion: '0.1.11',
      isEvalEnabled: () => true,
      sleep: async () => {},
    });
    worker.enqueue('run-1', RUBRIC_VERSION);
    await worker._queue().onIdle();

    expect(db.runs.some((r) => r.sql.includes("eval_status = 'complete'"))).toBe(true);
    expect(db.runs.some((r) => r.sql.includes("eval_status = 'failed'"))).toBe(false);
  });

  // ── Ad-hoc eval-report artifact (migration 091 atype) ────────────────────

  it("publishes ONE 'eval-report' artifact with the full verdict when origin is 'adhoc'", async () => {
    const db = new FakeDb(() => ({ ...evalRunRow(), origin: 'adhoc' }), () => []);
    const artifactWriter = vi.fn(async () => ({ artifactId: 'art-1' }));
    const worker = EvalWorker.initialize(db, undefined, {
      gitDiff: vi.fn(),
      jury: makeClaudeJury(
        new FakeJudge(async () =>
          sampleAllPass(BROAD_PASS, [
            {
              subCheckId: 'SEC-2',
              dimension: 'security',
              severity: 'error',
              title: 'Unvalidated path join',
              body: 'The handler joins user input into a filesystem path.',
              file: 'main/src/x.ts',
              line: 42,
              netNew: true,
              catastrophic: false,
            },
          ]),
        ),
      ),
      reviewItemWriter: vi.fn(async () => ({ reviewItemId: 'ri' })),
      artifactWriter,
      appVersion: '0.1.11',
      isEvalEnabled: () => true,
      sleep: async () => {},
    });
    worker.enqueue('run-1', RUBRIC_VERSION);
    await worker._queue().onIdle();

    expect(artifactWriter).toHaveBeenCalledTimes(1);
    const [projectId, change] = artifactWriter.mock.calls[0] as unknown as [number, ArtifactCreate];
    expect(projectId).toBe(7);
    expect(change.op).toBe('create');
    expect(change.runId).toBe('run-1');
    expect(change.atype).toBe('eval-report');
    expect(change.label).toBe(EVAL_REPORT_ARTIFACT_LABEL);
    expect(change.actor).toBe('agent:eval');

    const payload = JSON.parse(change.payloadJson as string) as { markdown: string };
    const md = payload.markdown;
    // Headline score + band, the per-dimension table, the flags block, and the
    // deduped findings digest all render.
    expect(md).toMatch(/# Ad-hoc code-review eval/);
    expect(md).toMatch(/\*\*\d+\/100 — \w+\*\*/);
    expect(md).toContain('Jury samples scored: 3');
    expect(md).toContain('## Dimensions');
    expect(md).toContain('| Dimension | Score | Band | Pass | Fail | Unknown |');
    expect(md).toContain('## Flags');
    expect(md).toContain('## Findings');
    expect(md).toContain('Unvalidated path join');
    expect(md).toContain('`main/src/x.ts:42`');
    expect(md).toContain('[SEC-2]');
    // Graded-at timestamp is an ISO string.
    expect(md).toMatch(/Graded at: \d{4}-\d{2}-\d{2}T/);
  });

  it("the summary review item points at the 'Eval report' artifact tab", async () => {
    const db = new FakeDb(() => ({ ...evalRunRow(), origin: 'adhoc' }), () => []);
    const writer = vi.fn(async () => ({ reviewItemId: 'ri' }));
    const worker = EvalWorker.initialize(db, undefined, {
      gitDiff: vi.fn(),
      jury: makeClaudeJury(new FakeJudge(async () => sampleAllPass(BROAD_PASS))),
      reviewItemWriter: writer,
      artifactWriter: vi.fn(async () => ({ artifactId: 'art-1' })),
      appVersion: '0.1.11',
      isEvalEnabled: () => true,
      sleep: async () => {},
    });
    worker.enqueue('run-1', RUBRIC_VERSION);
    await worker._queue().onIdle();

    const [, change] = writer.mock.calls[0] as unknown as [number, ReviewItemCreate];
    expect(change.body).toContain(EVAL_REPORT_POINTER);
  });

  it('does NOT publish the artifact for an automatic (origin NULL) row', async () => {
    const db = noExistingFindings(); // evalRunRow() has no origin => NULL
    const artifactWriter = vi.fn(async () => ({ artifactId: 'art' }));
    const worker = EvalWorker.initialize(db, undefined, {
      gitDiff: vi.fn(),
      jury: makeClaudeJury(new FakeJudge(async () => sampleAllPass(BROAD_PASS))),
      reviewItemWriter: vi.fn(async () => ({ reviewItemId: 'ri' })),
      artifactWriter,
      appVersion: '0.1.11',
      isEvalEnabled: () => true,
      sleep: async () => {},
    });
    worker.enqueue('run-1', RUBRIC_VERSION);
    await worker._queue().onIdle();

    expect(artifactWriter).not.toHaveBeenCalled();
    expect(db.runs.some((r) => r.sql.includes("eval_status = 'complete'"))).toBe(true);
  });

  it('an artifact-write failure never fails the eval and never skips the review item', async () => {
    const db = new FakeDb(() => ({ ...evalRunRow(), origin: 'adhoc' }), () => []);
    const writer = vi.fn(async () => ({ reviewItemId: 'ri' }));
    const worker = EvalWorker.initialize(db, undefined, {
      gitDiff: vi.fn(),
      jury: makeClaudeJury(new FakeJudge(async () => sampleAllPass(BROAD_PASS))),
      reviewItemWriter: writer,
      artifactWriter: vi.fn(async () => {
        throw new Error('artifact router exploded');
      }),
      appVersion: '0.1.11',
      isEvalEnabled: () => true,
      sleep: async () => {},
    });
    worker.enqueue('run-1', RUBRIC_VERSION);
    await worker._queue().onIdle();

    expect(writer).toHaveBeenCalledTimes(1); // the summary still landed
    expect(db.runs.some((r) => r.sql.includes("eval_status = 'complete'"))).toBe(true);
    expect(db.runs.some((r) => r.sql.includes("eval_status = 'failed'"))).toBe(false);
  });

  it('a review-item failure never skips the artifact (independent sibling surfaces)', async () => {
    const db = new FakeDb(() => ({ ...evalRunRow(), origin: 'adhoc' }), () => []);
    const artifactWriter = vi.fn(async () => ({ artifactId: 'art-1' }));
    const worker = EvalWorker.initialize(db, undefined, {
      gitDiff: vi.fn(),
      jury: makeClaudeJury(new FakeJudge(async () => sampleAllPass(BROAD_PASS))),
      reviewItemWriter: vi.fn(async () => {
        throw new Error('review queue exploded');
      }),
      artifactWriter,
      appVersion: '0.1.11',
      isEvalEnabled: () => true,
      sleep: async () => {},
    });
    worker.enqueue('run-1', RUBRIC_VERSION);
    await worker._queue().onIdle();

    expect(artifactWriter).toHaveBeenCalledTimes(1);
    expect(db.runs.some((r) => r.sql.includes("eval_status = 'failed'"))).toBe(false);
  });

  it('a requeued eval re-publishes the SAME atype (UPSERT overwrites the markdown)', async () => {
    const db = new FakeDb(() => ({ ...evalRunRow(), origin: 'adhoc' }), () => []);
    const artifactWriter = vi.fn(async () => ({ artifactId: 'art-1' }));
    // Second grade reports a different verdict shape (one FAIL) so the two
    // published payloads must differ.
    let round = 0;
    const worker = EvalWorker.initialize(db, undefined, {
      gitDiff: vi.fn(),
      jury: makeClaudeJury(
        new FakeJudge(async () => {
          const ids = round === 0 ? BROAD_PASS : BROAD_PASS.slice(1);
          const sample = sampleAllPass(ids);
          if (round > 0) sample.verdicts.push({ id: 'COR-1', verdict: 'FAIL', evidence: 'regressed' });
          return sample;
        }),
      ),
      reviewItemWriter: vi.fn(async () => ({ reviewItemId: 'ri' })),
      artifactWriter,
      appVersion: '0.1.11',
      isEvalEnabled: () => true,
      sleep: async () => {},
    });

    worker.enqueue('run-1', RUBRIC_VERSION);
    await worker._queue().onIdle();
    round = 1;
    worker.enqueue('run-1', RUBRIC_VERSION); // the requeue path
    await worker._queue().onIdle();

    expect(artifactWriter).toHaveBeenCalledTimes(2);
    const [first, second] = artifactWriter.mock.calls.map(
      (call) => (call as unknown as [number, ArtifactCreate])[1],
    );
    // Same identity (run, atype) => the router UPSERTs one row, not two tabs.
    expect(second.runId).toBe(first.runId);
    expect(second.atype).toBe('eval-report');
    expect(second.payloadJson).not.toBe(first.payloadJson);
  });

  it('skips the artifact (and never throws) when no artifactWriter is wired', async () => {
    const db = new FakeDb(() => ({ ...evalRunRow(), origin: 'adhoc' }), () => []);
    const writer = vi.fn(async () => ({ reviewItemId: 'ri' }));
    const worker = EvalWorker.initialize(db, undefined, {
      gitDiff: vi.fn(),
      jury: makeClaudeJury(new FakeJudge(async () => sampleAllPass(BROAD_PASS))),
      reviewItemWriter: writer,
      appVersion: '0.1.11',
      isEvalEnabled: () => true,
      sleep: async () => {},
    });
    worker.enqueue('run-1', RUBRIC_VERSION);
    await worker._queue().onIdle();

    expect(writer).toHaveBeenCalledTimes(1);
    expect(db.runs.some((r) => r.sql.includes("eval_status = 'complete'"))).toBe(true);
  });

  it('runAdHoc delegates to the ad-hoc snapshot and does NOT swallow its errors', async () => {
    // The auto trigger swallows; the ad-hoc entry point must propagate so the MCP
    // handler can answer the waiting caller. A run row that is absent makes the
    // snapshot return rejected/run_not_found rather than throw, so assert both:
    // the delegated result, and that a thrown DB fault surfaces.
    const okDb = new FakeDb(() => undefined, () => []);
    const worker = EvalWorker.initialize(okDb, undefined, {
      gitDiff: vi.fn(),
      jury: makeClaudeJury(new FakeJudge(async () => sampleAllPass(BROAD_PASS))),
      reviewItemWriter: vi.fn(async () => ({ reviewItemId: 'ri' })),
      appVersion: '0.1.11',
      isEvalEnabled: () => true,
      sleep: async () => {},
    });
    expect(await worker.runAdHoc('missing')).toEqual({
      outcome: 'rejected',
      reason: 'run_not_found',
    });

    const throwingDb = new FakeDb(() => {
      throw new Error('db down');
    }, () => []);
    const throwingWorker = EvalWorker.initialize(throwingDb, undefined, {
      gitDiff: vi.fn(),
      jury: makeClaudeJury(new FakeJudge(async () => sampleAllPass(BROAD_PASS))),
      reviewItemWriter: vi.fn(async () => ({ reviewItemId: 'ri' })),
      appVersion: '0.1.11',
      isEvalEnabled: () => true,
      sleep: async () => {},
    });
    await expect(throwingWorker.runAdHoc('run-1')).rejects.toThrow('db down');
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

describe('truncateSlotError', () => {
  it('passes through a short message unchanged', () => {
    expect(truncateSlotError('protocol crash')).toBe('protocol crash');
  });

  it('truncates an over-long message and marks the elision', () => {
    const long = 'x'.repeat(MAX_SLOT_ERROR_CHARS + 50);
    const out = truncateSlotError(long);
    expect(out).toHaveLength(MAX_SLOT_ERROR_CHARS + 1); // cap + the ellipsis
    expect(out.endsWith('…')).toBe(true);
    expect(out.startsWith('x'.repeat(MAX_SLOT_ERROR_CHARS))).toBe(true);
  });
});
