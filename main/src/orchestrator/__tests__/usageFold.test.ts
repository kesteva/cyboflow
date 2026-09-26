/**
 * Unit tests for the shared usage fold (usageFold.ts) — the Claude rules of
 * docs/proposals/codex-workflow-efficiency.md §5.3 "Rollups": message dedup,
 * outer/child separation, process segments, and the fold's diagnostics. The
 * DB-level cases (mixed Claude+Codex run == Σ daily buckets, older
 * accounting_version) live in insightsQueries.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  ACCOUNTING_VERSION,
  foldRunUsage,
  mostSevereCoverage,
  usageFoldModeForVersion,
  type UsageFoldRow,
} from '../usageFold';

const DAY = '2026-09-20T10:00:00.000Z';

function rowBuilder(): {
  rows: UsageFoldRow[];
  add: (eventType: string, payload: Record<string, unknown>, dedupKey?: string | null, createdAt?: string) => void;
} {
  const rows: UsageFoldRow[] = [];
  return {
    rows,
    add(eventType, payload, dedupKey = null, createdAt = DAY) {
      rows.push({ id: rows.length + 1, eventType, payloadJson: JSON.stringify(payload), dedupKey, createdAt });
    },
  };
}

interface Usage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheCreation?: number;
}

function snake(u: Usage): Record<string, number> {
  return {
    input_tokens: u.input ?? 0,
    output_tokens: u.output ?? 0,
    cache_read_input_tokens: u.cacheRead ?? 0,
    cache_creation_input_tokens: u.cacheCreation ?? 0,
  };
}

function camel(u: Usage): Record<string, number> {
  return {
    inputTokens: u.input ?? 0,
    outputTokens: u.output ?? 0,
    cacheReadInputTokens: u.cacheRead ?? 0,
    cacheCreationInputTokens: u.cacheCreation ?? 0,
  };
}

function assistant(
  id: string,
  model: string,
  usage: Usage,
  opts: { session?: string; parent?: string | null } = {},
): Record<string, unknown> {
  return {
    type: 'assistant',
    session_id: opts.session ?? 's1',
    parent_tool_use_id: opts.parent ?? null,
    message: { id, model, role: 'assistant', content: [{ type: 'text', text: 'x' }], usage: snake(usage) },
  };
}

function result(
  usage: Usage,
  modelUsage: Record<string, Usage> | null,
  opts: { session?: string; pid?: string; cost?: number; turns?: number } = {},
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    type: 'result',
    subtype: 'success',
    session_id: opts.session ?? 's1',
    usage: snake(usage),
    num_turns: opts.turns ?? 1,
  };
  if (opts.cost !== undefined) payload.total_cost_usd = opts.cost;
  if (modelUsage !== null) {
    payload.modelUsage = Object.fromEntries(Object.entries(modelUsage).map(([m, u]) => [m, camel(u)]));
  }
  if (opts.pid !== undefined) payload.cyboflow_process_instance_id = opts.pid;
  return payload;
}

function logger(): { warn: ReturnType<typeof vi.fn>; events: () => string[] } {
  const warn = vi.fn();
  return {
    warn,
    events: () => warn.mock.calls.map((c) => (c[1] as { event: string }).event),
  };
}

describe('usageFoldModeForVersion', () => {
  it('keeps the legacy fold only for rows written by an older version', () => {
    expect(usageFoldModeForVersion(null)).toBe('current');
    expect(usageFoldModeForVersion(0)).toBe('legacy');
    expect(usageFoldModeForVersion(ACCOUNTING_VERSION)).toBe('current');
  });

  it('orders coverage from least to most severe', () => {
    expect(mostSevereCoverage('complete', 'codex-model-inferred')).toBe('codex-model-inferred');
    expect(mostSevereCoverage('claude-segments-inferred', 'codex-run-level')).toBe('claude-segments-inferred');
  });
});

describe('foldRunUsage — Claude (current version)', () => {
  it('counts a multi-block assistant message once, and never as tokens', () => {
    const b = rowBuilder();
    // One message split over three content-block rows, each repeating usage.
    b.add('assistant', assistant('m1', 'claude-sonnet-5', { input: 10, output: 5, cacheRead: 100 }));
    b.add('assistant', assistant('m1', 'claude-sonnet-5', { input: 10, output: 5, cacheRead: 100 }));
    b.add('assistant', assistant('m1', 'claude-sonnet-5', { input: 10, output: 5, cacheRead: 100 }));
    b.add('result', result({ input: 10, output: 5, cacheRead: 100 }, { 'claude-sonnet-5': { input: 10, output: 5, cacheRead: 100 } }, { pid: 'p1' }));

    const fold = foldRunUsage(b.rows, { mode: 'current' });
    expect(fold.assistantMessageCount).toBe(1);
    // Tokens come from result.usage only (the 3 rows would have tripled them).
    expect(fold).toMatchObject({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, totalTokens: 15 });
    expect(fold.accountingVersion).toBe(ACCOUNTING_VERSION);
    expect(fold.coverage).toBe('complete');
  });

  it('an open query counts its deduplicated parentless message usage as provisional outer tokens', () => {
    const b = rowBuilder();
    // A closed query first: only its result counts.
    b.add('assistant', assistant('m0', 'claude-sonnet-5', { input: 999, output: 999 }));
    b.add('result', result({ input: 10, output: 5 }, { 'claude-sonnet-5': { input: 10, output: 5 } }, { pid: 'p1' }));
    // The open query: m1 over two content-block rows (counted once), m2, and a
    // parented Task-child message (never counted).
    b.add('assistant', assistant('m1', 'claude-sonnet-5', { input: 20, output: 2 }), null, '2026-09-21T09:00:00.000Z');
    b.add('assistant', assistant('m1', 'claude-sonnet-5', { input: 20, output: 2 }), null, '2026-09-21T09:00:00.000Z');
    b.add('assistant', assistant('m2', 'claude-opus-5-5', { input: 30, output: 3 }), null, '2026-09-21T09:01:00.000Z');
    b.add('assistant', assistant('c1', 'claude-haiku-4-5', { input: 500, output: 50 }, { parent: 'toolu_1' }));

    const fold = foldRunUsage(b.rows, { mode: 'current' });
    expect(fold).toMatchObject({ inputTokens: 60, outputTokens: 10, assistantMessageCount: 3 });
    expect(fold.perModel.get('claude-opus-5-5')).toMatchObject({ inputTokens: 30, outputTokens: 3 });
    expect(fold.perModel.has('claude-haiku-4-5')).toBe(false);
    // Provisional usage lands on its message row's day.
    const day21 = fold.contributions.filter((c) => c.day === '2026-09-21');
    expect(day21.reduce((sum, c) => sum + c.inputTokens, 0)).toBe(50);
  });

  it('once the open query\'s result lands, only result.usage counts for it', () => {
    const b = rowBuilder();
    b.add('assistant', assistant('m1', 'claude-sonnet-5', { input: 20, output: 2 }));
    b.add('assistant', assistant('m2', 'claude-sonnet-5', { input: 30, output: 3 }));
    const open = foldRunUsage(b.rows, { mode: 'current' });
    expect(open).toMatchObject({ inputTokens: 50, outputTokens: 5 });

    b.add('result', result({ input: 45, output: 6 }, { 'claude-sonnet-5': { input: 45, output: 6 } }, { pid: 'p1' }));
    const closed = foldRunUsage(b.rows, { mode: 'current' });
    expect(closed).toMatchObject({ inputTokens: 45, outputTokens: 6, assistantMessageCount: 2 });
  });

  it('keeps parented assistant messages out of the outer per-model split and the message count', () => {
    const b = rowBuilder();
    b.add('assistant', assistant('m1', 'claude-opus-5-5', { input: 10, output: 10 }));
    // Forwarded Task-child messages on another model: attribution only.
    b.add('assistant', assistant('c1', 'claude-haiku-4-5', { input: 999, output: 999 }, { parent: 'toolu_1' }));
    b.add('assistant', assistant('c2', 'claude-haiku-4-5', { input: 999, output: 999 }, { parent: 'toolu_1' }));
    // modelUsage: outer opus 10/10 + child haiku 40/20.
    b.add(
      'result',
      result(
        { input: 10, output: 10 },
        { 'claude-opus-5-5': { input: 10, output: 10 }, 'claude-haiku-4-5': { input: 40, output: 20 } },
        { pid: 'p1' },
      ),
    );

    const fold = foldRunUsage(b.rows, { mode: 'current' });
    expect(fold.assistantMessageCount).toBe(1);
    expect(fold.multiModel).toBe(true);
    expect(fold).toMatchObject({ inputTokens: 50, outputTokens: 30 });
    expect(fold.perModel.get('claude-opus-5-5')).toEqual({
      inputTokens: 10,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    // The haiku bucket is the child delta, not the 2×999 forwarded messages.
    expect(fold.perModel.get('claude-haiku-4-5')).toEqual({
      inputTokens: 40,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  it('derives child tokens from successive modelUsage readings within one process', () => {
    const b = rowBuilder();
    // Query 1: outer 10/5, child 30/10 → modelUsage 40/15.
    b.add('result', result({ input: 10, output: 5 }, { 'claude-sonnet-5': { input: 40, output: 15 } }, { pid: 'p1' }));
    // Query 2 (same process): outer 20/5, child 0 → modelUsage 60/20.
    b.add('result', result({ input: 20, output: 5 }, { 'claude-sonnet-5': { input: 60, output: 20 } }, { pid: 'p1' }));
    const fold = foldRunUsage(b.rows, { mode: 'current' });
    expect(fold).toMatchObject({ inputTokens: 60, outputTokens: 20 });
  });

  it('a new process_instance_id starts a new segment — its first reading counts from zero', () => {
    const b = rowBuilder();
    b.add('result', result({ input: 10, output: 5 }, { 'claude-sonnet-5': { input: 40, output: 15 } }, { pid: 'p1' }));
    // Cold resume: same session, new process, counters restart.
    b.add('result', result({ input: 10, output: 5 }, { 'claude-sonnet-5': { input: 25, output: 8 } }, { pid: 'p2' }));
    const fold = foldRunUsage(b.rows, { mode: 'current' });
    // p1: 40/15 (outer 10/5 + child 30/10); p2: 25/8 (outer 10/5 + child 15/3).
    expect(fold).toMatchObject({ inputTokens: 65, outputTokens: 23, coverage: 'complete' });
  });

  it('a restarted process whose first reading is ABOVE the previous totals still starts a new segment (with ids)', () => {
    const b = rowBuilder();
    b.add('result', result({ input: 10, output: 5 }, { 'claude-sonnet-5': { input: 40, output: 15 } }, { pid: 'p1' }));
    // The new process's first reading passes the old totals: no counter goes
    // down, so only the recorded identity can tell it is a restart.
    b.add('result', result({ input: 10, output: 5 }, { 'claude-sonnet-5': { input: 100, output: 50 } }, { pid: 'p2' }));
    const fold = foldRunUsage(b.rows, { mode: 'current' });
    // Treated as a continuation it would read Δ = 60/35; as a new segment it is 100/50.
    expect(fold).toMatchObject({ inputTokens: 140, outputTokens: 65 });
  });

  it('without process ids, infers a restart from a counter decrease and marks the run claude-segments-inferred', () => {
    const b = rowBuilder();
    b.add('result', result({ input: 10, output: 5 }, { 'claude-sonnet-5': { input: 40, output: 15 } }, { cost: 0.4 }));
    b.add('result', result({ input: 20, output: 5 }, { 'claude-sonnet-5': { input: 60, output: 20 } }, { cost: 0.6 }));
    // Counters (and cost) went down → a new process.
    b.add('result', result({ input: 10, output: 5 }, { 'claude-sonnet-5': { input: 25, output: 8 } }, { cost: 0.2 }));
    const fold = foldRunUsage(b.rows, { mode: 'current' });
    expect(fold).toMatchObject({ inputTokens: 85, outputTokens: 28, coverage: 'claude-segments-inferred' });
    // Cost ladder: segment maxima 0.6 + 0.2.
    expect(fold.costUsd).toBeCloseTo(0.8, 10);
  });

  it('without process ids, a reading that grew by less than this query\'s outer usage is a new segment', () => {
    const b = rowBuilder();
    b.add('result', result({ input: 10, output: 5 }, { 'claude-sonnet-5': { input: 40, output: 15 } }));
    // Σ grew by 5 < outer 30 → cannot be the same process.
    b.add('result', result({ input: 25, output: 5 }, { 'claude-sonnet-5': { input: 45, output: 15 } }));
    const fold = foldRunUsage(b.rows, { mode: 'current' });
    expect(fold).toMatchObject({ inputTokens: 85, outputTokens: 30 });
  });

  it('clamps a negative child delta to zero per token type and logs claude_child_delta_negative', () => {
    const b = rowBuilder();
    const log = logger();
    // modelUsage below result.usage for output (a malformed reading).
    b.add('result', result({ input: 10, output: 50 }, { 'claude-sonnet-5': { input: 30, output: 20 } }, { pid: 'p1' }));
    const fold = foldRunUsage(b.rows, { mode: 'current', logger: log, runId: 'r1' });
    // Outer 10/50 + child max(0, 30−10)=20 / max(0, 20−50)=0.
    expect(fold).toMatchObject({ inputTokens: 30, outputTokens: 50 });
    expect(log.events()).toEqual(['claude_child_delta_negative']);
    expect(log.warn.mock.calls[0][1]).toMatchObject({ runId: 'r1', negative: { outputTokens: -30 } });
  });

  it('a result without modelUsage contributes zero child tokens and logs claude_model_usage_missing', () => {
    const b = rowBuilder();
    const log = logger();
    b.add('result', result({ input: 10, output: 5 }, null, { pid: 'p1' }));
    // The next reading covers both queries: outer 10/5 + 20/5, child 30/10.
    b.add('result', result({ input: 20, output: 5 }, { 'claude-sonnet-5': { input: 60, output: 20 } }, { pid: 'p1' }));
    const fold = foldRunUsage(b.rows, { mode: 'current', logger: log });
    expect(log.events()).toEqual(['claude_model_usage_missing']);
    // The earlier outer usage is not re-counted as child.
    expect(fold).toMatchObject({ inputTokens: 60, outputTokens: 20 });
  });

  it('logs claude_outer_mismatch when parentless messages disagree sharply with result.usage', () => {
    const b = rowBuilder();
    const log = logger();
    b.add('assistant', assistant('m1', 'claude-sonnet-5', { input: 50_000, output: 10 }));
    b.add('result', result({ input: 1_000, output: 10 }, { 'claude-sonnet-5': { input: 1_000, output: 10 } }, { pid: 'p1' }));
    foldRunUsage(b.rows, { mode: 'current', logger: log });
    expect(log.events()).toEqual(['claude_outer_mismatch']);
  });

  it('groups modelUsage keys by canonicalModel so the outer and child splits share a bucket', () => {
    const b = rowBuilder();
    b.add('assistant', assistant('m1', 'claude-opus-5-5', { input: 10, output: 10 }));
    const payload = result({ input: 10, output: 10 }, null, { pid: 'p1' });
    payload.modelUsage = { 'claude-opus-5-5[1m]': { ...camel({ input: 30, output: 12 }), canonicalModel: 'claude-opus-5-5' } };
    b.add('result', payload);
    const fold = foldRunUsage(b.rows, { mode: 'current' });
    expect(Array.from(fold.perModel.keys())).toEqual(['claude-opus-5-5']);
    expect(fold.perModel.get('claude-opus-5-5')).toMatchObject({ inputTokens: 30, outputTokens: 12 });
  });

  it('does not double-count dynamic-workflow `subagent:` rows (modelUsage already holds them)', () => {
    const b = rowBuilder();
    b.add('assistant', assistant('m1', 'claude-sonnet-5', { input: 10, output: 5 }));
    // The workflow's agent (haiku) ran inside the same SDK process.
    b.add('result', result({ input: 10, output: 5 }, { 'claude-sonnet-5': { input: 10, output: 5 }, 'claude-haiku-4-5': { input: 70, output: 7 } }, { pid: 'p1' }));
    b.add(
      'subagent_usage',
      { type: 'subagent_usage', subagent: { wfRunId: 'wf', agentId: 'a' }, message: { model: 'claude-haiku-4-5', usage: snake({ input: 70, output: 7 }) } },
      'subagent:wf:a',
    );
    const fold = foldRunUsage(b.rows, { mode: 'current' });
    expect(fold).toMatchObject({ inputTokens: 80, outputTokens: 12 });
    expect(fold.perModel.get('claude-haiku-4-5')).toMatchObject({ inputTokens: 70, outputTokens: 7 });
  });

  it('ladders cost exactly by process id: a new id opens a segment even when the cost does not drop', () => {
    const b = rowBuilder();
    b.add('result', result({ output: 5 }, null, { pid: 'p1', cost: 0.3 }));
    b.add('result', result({ output: 5 }, null, { pid: 'p1', cost: 0.5 }));
    b.add('result', result({ output: 5 }, null, { pid: 'p2', cost: 0.7 }));
    const fold = foldRunUsage(b.rows, { mode: 'current' });
    expect(fold.costUsd).toBeCloseTo(1.2, 10);
    expect(fold.numTurns).toBe(3);
  });

  it('records every counted token as a (day, model) contribution — the daily buckets sum to the totals', () => {
    const b = rowBuilder();
    b.add('assistant', assistant('m1', 'claude-sonnet-5', { input: 1, output: 1 }), null, '2026-09-19T23:59:00.000Z');
    b.add('result', result({ input: 10, output: 5 }, { 'claude-sonnet-5': { input: 40, output: 15 } }, { pid: 'p1' }), null, '2026-09-20T00:01:00.000Z');
    const fold = foldRunUsage(b.rows, { mode: 'current' });
    const sum = fold.contributions.reduce(
      (acc, c) => ({ input: acc.input + c.inputTokens, output: acc.output + c.outputTokens, messages: acc.messages + c.assistantMessageCount }),
      { input: 0, output: 0, messages: 0 },
    );
    expect(sum).toEqual({ input: fold.inputTokens, output: fold.outputTokens, messages: fold.assistantMessageCount });
    expect(fold.contributions.find((c) => c.day === '2026-09-19')?.assistantMessageCount).toBe(1);
    expect(fold.contributions.find((c) => c.day === '2026-09-20')?.inputTokens).toBe(40);
  });
});

describe('foldRunUsage — providers (current version)', () => {
  it('counts agent_result and every codex- row, labelling a model-less agent_result from the last provider assistant row', () => {
    const b = rowBuilder();
    b.add('agent_assistant', { type: 'agent_message', provider: 'codex', role: 'assistant', model: 'gpt-6-sol', content: [] });
    b.add('agent_result', { type: 'agent_result', provider: 'codex', usage: snake({ input: 100, output: 10 }), num_turns: 1 });
    const child = (inferred: boolean): Record<string, unknown> => ({
      type: 'subagent_usage',
      provider: 'codex',
      thread_id: 't2',
      model_inferred: inferred,
      message: { model: 'gpt-6-luna', usage: snake({ input: 50, output: 5 }) },
    });
    b.add('subagent_usage', child(false), 'codex-subagent:inv1:t2');
    b.add('subagent_usage', child(true), 'codex-unattributed:r1:t3');
    b.add('subagent_usage', child(false), 'codex-usage-topup:r1:t4');
    b.add('subagent_usage', child(false), 'codex-subagent-run:r1:t1:turn1:t5');

    const fold = foldRunUsage(b.rows, { mode: 'current' });
    expect(fold).toMatchObject({ inputTokens: 300, outputTokens: 30, assistantMessageCount: 1 });
    expect(fold.perModel.get('gpt-6-sol')).toMatchObject({ inputTokens: 100 });
    expect(fold.perModel.get('gpt-6-luna')).toMatchObject({ inputTokens: 200 });
    // codex-model-inferred outranks codex-run-level.
    expect(fold.coverage).toBe('codex-model-inferred');
  });

  it('falls back to the caller\'s label for provider-result usage with no model anywhere', () => {
    const b = rowBuilder();
    b.add('agent_result', { type: 'agent_result', provider: 'omp', usage: snake({ input: 7, output: 3 }) });
    const fold = foldRunUsage(b.rows, { mode: 'current', fallbackModelLabel: (p) => `${p}:label` });
    expect(Array.from(fold.perModel.keys())).toEqual(['omp:label']);
  });
});

describe('foldRunUsage — legacy version', () => {
  it('keeps the pre-v1 rules: assistant rows are the token source and result usage is ignored beside them', () => {
    const b = rowBuilder();
    b.add('assistant', assistant('m1', 'claude-sonnet-5', { input: 10, output: 5 }));
    b.add('assistant', assistant('m1', 'claude-sonnet-5', { input: 10, output: 5 }));
    b.add('subagent_usage', { type: 'subagent_usage', message: { model: 'claude-haiku-4-5', usage: snake({ input: 3, output: 1 }) } }, 'subagent:wf:a');
    b.add('agent_result', { type: 'agent_result', provider: 'codex', usage: snake({ input: 500, output: 50 }) });
    const fold = foldRunUsage(b.rows, { mode: 'legacy' });
    expect(fold).toMatchObject({
      inputTokens: 23,
      outputTokens: 11,
      assistantMessageCount: 2,
      accountingVersion: 0,
      coverage: 'legacy',
    });
  });

  it('uses the result-usage fallback only when no assistant message carried usage, outside the per-model split', () => {
    const b = rowBuilder();
    b.add('agent_result', { type: 'agent_result', provider: 'codex', usage: snake({ input: 500, output: 50 }) });
    const fold = foldRunUsage(b.rows, { mode: 'legacy', fallbackModelLabel: () => 'codex:gpt' });
    expect(fold).toMatchObject({ inputTokens: 500, outputTokens: 50, assistantMessageCount: 1 });
    expect(fold.perModel.size).toBe(0);
    expect(fold.contributions).toEqual([
      expect.objectContaining({ model: 'codex:gpt', inputTokens: 500, assistantMessageCount: 1 }),
    ]);
  });
});
