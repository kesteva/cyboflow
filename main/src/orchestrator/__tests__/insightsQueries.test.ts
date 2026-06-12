/**
 * Unit tests for insightsQueries — the pure SELECT/aggregation helpers backing
 * the Insights view.
 *
 * DB setup: a self-contained in-memory better-sqlite3 instance with a hand-rolled
 * schema (workflows + workflow_runs incl. the migration-014 `outcome`/`task_id`
 * columns + review_items from migration 016). The shared GATE_SCHEMA fixture does
 * NOT carry `outcome` or the review_items table, so — per the task's allowance —
 * we create exactly the columns these helpers read. The real DatabaseService
 * satisfies the same DatabaseLike surface; dbAdapter wraps the raw Database.
 *
 * Coverage map:
 *   - selectWorkflowRunStats: empty DB, status/outcome bucketing, nullOutcomeRuns,
 *     errorRatePct 1dp rounding, avgDurationMs, lastRunAt ISO, projectId filter.
 *   - selectRunUsageRollups: assistant-with/without-usage, multiple results
 *     summing cost+turns, malformed JSON skipped, result.usage NOT double-counted,
 *     empty-run seeding.
 *   - selectWorkflowUsageStats: runsWithUsage / avgTotalTokens / cost aggregates.
 *   - selectReviewItemSummary: status + pendingByKind, all-kinds-present default.
 *   - selectQualityFindings: category/locations/sourceStep parsing, LEFT JOIN
 *     null path (run deleted), severity/status narrowing, ordering.
 *   - selectStepTokenBuckets: usage-before-first-report lands in 'unattributed',
 *     suffix-matched MCP tool name, step_id switching, sort order.
 *   - selectUsageTrend: date bucketing, window filter, ascending order.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import {
  selectWorkflowRunStats,
  selectRunUsageRollups,
  selectWorkflowUsageStats,
  selectReviewItemSummary,
  selectQualityFindings,
  selectStepTokenBuckets,
  selectUsageTrend,
} from '../insightsQueries';

// ---------------------------------------------------------------------------
// Schema + seed helpers
// ---------------------------------------------------------------------------

/** Build the minimal schema the insights helpers read (incl. mig-014 + mig-016). */
function createInsightsDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF'); // tests insert rows independently of FK ordering
  db.exec(`
    CREATE TABLE workflows (
      id TEXT PRIMARY KEY,
      project_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      spec_json TEXT NOT NULL DEFAULT '{}',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE workflow_runs (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      project_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      worktree_path TEXT,
      policy_json TEXT,
      outcome TEXT,
      task_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      started_at DATETIME,
      ended_at DATETIME
    );
    CREATE TABLE raw_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE review_items (
      id TEXT PRIMARY KEY,
      project_id INTEGER NOT NULL,
      run_id TEXT,
      entity_type TEXT,
      entity_id TEXT,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      blocking INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL,
      body TEXT,
      severity TEXT,
      source TEXT,
      payload_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      resolved_by TEXT,
      resolution TEXT
    );
  `);
  return db;
}

interface SeedWorkflowOpts {
  id: string;
  name?: string;
  projectId?: number;
}

function seedWorkflow(db: Database.Database, opts: SeedWorkflowOpts): void {
  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, project_id, name) VALUES (?, ?, ?)`,
  ).run(opts.id, opts.projectId ?? 1, opts.name ?? opts.id);
}

interface SeedRunOpts {
  id: string;
  workflowId: string;
  projectId?: number;
  status?: string;
  outcome?: string | null;
  createdAt?: string;
  startedAt?: string | null;
  endedAt?: string | null;
}

function seedRun(db: Database.Database, opts: SeedRunOpts): void {
  db.prepare(
    `INSERT INTO workflow_runs
       (id, workflow_id, project_id, status, outcome, created_at, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), ?, ?)`,
  ).run(
    opts.id,
    opts.workflowId,
    opts.projectId ?? 1,
    opts.status ?? 'completed',
    opts.outcome ?? null,
    opts.createdAt ?? null,
    opts.startedAt ?? null,
    opts.endedAt ?? null,
  );
}

/** Insert a raw_events row with a JSON payload (or a raw string for malformed). */
function seedEvent(
  db: Database.Database,
  runId: string,
  eventType: string,
  payload: unknown,
  createdAt?: string,
): void {
  const payloadJson = typeof payload === 'string' ? payload : JSON.stringify(payload);
  db.prepare(
    `INSERT INTO raw_events (run_id, event_type, payload_json, created_at)
     VALUES (?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`,
  ).run(runId, eventType, payloadJson, createdAt ?? null);
}

interface SeedReviewOpts {
  id: string;
  projectId?: number;
  runId?: string | null;
  kind?: string;
  status?: string;
  title?: string;
  severity?: string | null;
  source?: string | null;
  payload?: unknown;
  resolution?: string | null;
  createdAt?: string;
}

function seedReview(db: Database.Database, opts: SeedReviewOpts): void {
  const payloadJson =
    opts.payload === undefined
      ? null
      : typeof opts.payload === 'string'
        ? opts.payload
        : JSON.stringify(opts.payload);
  db.prepare(
    `INSERT INTO review_items
       (id, project_id, run_id, kind, status, title, severity, source, payload_json, resolution, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`,
  ).run(
    opts.id,
    opts.projectId ?? 1,
    opts.runId ?? null,
    opts.kind ?? 'finding',
    opts.status ?? 'pending',
    opts.title ?? 'A finding',
    opts.severity ?? null,
    opts.source ?? null,
    payloadJson,
    opts.resolution ?? null,
    opts.createdAt ?? null,
  );
}

/** Construct an assistant payload with the given usage tokens. */
function assistantPayload(usage: {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheCreation?: number;
} | null): Record<string, unknown> {
  const message: Record<string, unknown> = {
    id: 'msg_x',
    model: 'claude-opus-4-5',
    role: 'assistant',
    content: [{ type: 'text', text: 'hello' }],
  };
  if (usage !== null) {
    message.usage = {
      input_tokens: usage.input ?? 0,
      output_tokens: usage.output ?? 0,
      cache_read_input_tokens: usage.cacheRead ?? 0,
      cache_creation_input_tokens: usage.cacheCreation ?? 0,
    };
  }
  return { type: 'assistant', message };
}

/** Construct a result payload with cost/turns (and a usage block to prove it's ignored). */
function resultPayload(cost: number | null, turns: number | null): Record<string, unknown> {
  const payload: Record<string, unknown> = { type: 'result', subtype: 'success', is_error: false };
  if (cost !== null) payload.total_cost_usd = cost;
  if (turns !== null) payload.num_turns = turns;
  // A usage block on the result MUST be ignored by the token sums.
  payload.usage = { input_tokens: 99999, output_tokens: 88888 };
  return payload;
}

/** Assistant payload whose content reports a step via a suffix-matched MCP tool. */
function reportStepPayload(
  stepId: string,
  usage: { input?: number; output?: number } | null,
  toolName = 'mcp__cyboflow__cyboflow_report_step',
): Record<string, unknown> {
  const base = assistantPayload(usage);
  const message = base.message as Record<string, unknown>;
  message.content = [
    { type: 'text', text: 'advancing' },
    { type: 'tool_use', id: 'tu_1', name: toolName, input: { step_id: stepId } },
  ];
  return base;
}

// ---------------------------------------------------------------------------
// 1. selectWorkflowRunStats
// ---------------------------------------------------------------------------

describe('selectWorkflowRunStats', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createInsightsDb();
  });

  it('returns [] on an empty DB', () => {
    expect(selectWorkflowRunStats(dbAdapter(db), null)).toEqual([]);
  });

  it('buckets statuses, outcomes, nullOutcomeRuns and rounds errorRatePct to 1dp', () => {
    seedWorkflow(db, { id: 'wf-1', name: 'Planner' });
    // 3 completed (1 merged, 1 dismissed, 1 null-outcome), 1 failed (null outcome),
    // 1 canceled (null outcome), 1 running (active).
    seedRun(db, { id: 'r1', workflowId: 'wf-1', status: 'completed', outcome: 'merged' });
    seedRun(db, { id: 'r2', workflowId: 'wf-1', status: 'completed', outcome: 'dismissed' });
    seedRun(db, { id: 'r3', workflowId: 'wf-1', status: 'completed', outcome: null });
    seedRun(db, { id: 'r4', workflowId: 'wf-1', status: 'failed', outcome: null });
    seedRun(db, { id: 'r5', workflowId: 'wf-1', status: 'canceled', outcome: null });
    seedRun(db, { id: 'r6', workflowId: 'wf-1', status: 'running', outcome: null });

    const [stats] = selectWorkflowRunStats(dbAdapter(db), null);
    expect(stats.workflowName).toBe('Planner');
    expect(stats.totalRuns).toBe(6);
    expect(stats.completedRuns).toBe(3);
    expect(stats.failedRuns).toBe(1);
    expect(stats.canceledRuns).toBe(1);
    expect(stats.activeRuns).toBe(1);
    expect(stats.mergedRuns).toBe(1);
    expect(stats.dismissedRuns).toBe(1);
    // terminal = completed(3)+failed(1)+canceled(1) = 5; null-outcome terminals
    // = r3 + r4 + r5 = 3 (r1/r2 have an outcome; r6 is active, not terminal).
    expect(stats.nullOutcomeRuns).toBe(3);
    // failed(1) / terminal(5) * 100 = 20.0
    expect(stats.errorRatePct).toBe(20);
  });

  it('rounds errorRatePct to 1 decimal place (non-trivial fraction)', () => {
    seedWorkflow(db, { id: 'wf-1' });
    // 1 failed of 3 terminal → 33.333..% → 33.3
    seedRun(db, { id: 'r1', workflowId: 'wf-1', status: 'failed' });
    seedRun(db, { id: 'r2', workflowId: 'wf-1', status: 'completed' });
    seedRun(db, { id: 'r3', workflowId: 'wf-1', status: 'completed' });

    const [stats] = selectWorkflowRunStats(dbAdapter(db), null);
    expect(stats.errorRatePct).toBe(33.3);
  });

  it('reports errorRatePct 0 and avgDurationMs null when there are no terminal runs', () => {
    seedWorkflow(db, { id: 'wf-1' });
    seedRun(db, { id: 'r1', workflowId: 'wf-1', status: 'running' });
    seedRun(db, { id: 'r2', workflowId: 'wf-1', status: 'awaiting_review' });

    const [stats] = selectWorkflowRunStats(dbAdapter(db), null);
    expect(stats.errorRatePct).toBe(0);
    expect(stats.avgDurationMs).toBeNull();
    expect(stats.activeRuns).toBe(2);
  });

  it('averages duration over terminal runs with both stamps and emits ISO lastRunAt', () => {
    seedWorkflow(db, { id: 'wf-1' });
    // 10s run + 20s run → avg 15000ms. A terminal run missing started_at is excluded.
    seedRun(db, {
      id: 'r1',
      workflowId: 'wf-1',
      status: 'completed',
      startedAt: '2026-06-01 10:00:00',
      endedAt: '2026-06-01 10:00:10',
      createdAt: '2026-06-01 09:59:00',
    });
    seedRun(db, {
      id: 'r2',
      workflowId: 'wf-1',
      status: 'completed',
      startedAt: '2026-06-02 10:00:00',
      endedAt: '2026-06-02 10:00:20',
      createdAt: '2026-06-02 09:59:00',
    });
    seedRun(db, {
      id: 'r3',
      workflowId: 'wf-1',
      status: 'failed',
      startedAt: null,
      endedAt: '2026-06-03 10:00:00',
      createdAt: '2026-06-03 09:59:00',
    });

    const [stats] = selectWorkflowRunStats(dbAdapter(db), null);
    expect(stats.avgDurationMs).not.toBeNull();
    expect(Math.round(stats.avgDurationMs as number)).toBe(15000);
    // lastRunAt = MAX(created_at) = r3's 09:59 on 2026-06-03, normalized to ISO.
    expect(stats.lastRunAt).toBe('2026-06-03T09:59:00.000Z');
  });

  it('filters by projectId when non-null', () => {
    seedWorkflow(db, { id: 'wf-a', name: 'A', projectId: 1 });
    seedWorkflow(db, { id: 'wf-b', name: 'B', projectId: 2 });
    seedRun(db, { id: 'r1', workflowId: 'wf-a', projectId: 1 });
    seedRun(db, { id: 'r2', workflowId: 'wf-b', projectId: 2 });

    const all = selectWorkflowRunStats(dbAdapter(db), null);
    expect(all).toHaveLength(2);

    const onlyP2 = selectWorkflowRunStats(dbAdapter(db), 2);
    expect(onlyP2).toHaveLength(1);
    expect(onlyP2[0].workflowName).toBe('B');
    expect(onlyP2[0].projectId).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 2. selectRunUsageRollups
// ---------------------------------------------------------------------------

describe('selectRunUsageRollups', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createInsightsDb();
  });

  it('returns [] for an empty run-id list', () => {
    expect(selectRunUsageRollups(dbAdapter(db), [])).toEqual([]);
  });

  it('seeds a zeroed rollup for a run with no events', () => {
    seedWorkflow(db, { id: 'wf-1' });
    seedRun(db, { id: 'r1', workflowId: 'wf-1' });
    const [rollup] = selectRunUsageRollups(dbAdapter(db), ['r1']);
    expect(rollup).toMatchObject({
      runId: 'r1',
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: null,
      numTurns: null,
      assistantMessageCount: 0,
    });
  });

  it('sums assistant usage and counts only payloads that carry a usage object', () => {
    seedWorkflow(db, { id: 'wf-1' });
    seedRun(db, { id: 'r1', workflowId: 'wf-1' });
    seedEvent(db, 'r1', 'assistant', assistantPayload({ input: 100, output: 50, cacheRead: 10, cacheCreation: 5 }));
    seedEvent(db, 'r1', 'assistant', assistantPayload({ input: 200, output: 25 }));
    // assistant WITHOUT a usage object — not counted.
    seedEvent(db, 'r1', 'assistant', assistantPayload(null));

    const [rollup] = selectRunUsageRollups(dbAdapter(db), ['r1']);
    expect(rollup.inputTokens).toBe(300);
    expect(rollup.outputTokens).toBe(75);
    expect(rollup.cacheReadTokens).toBe(10);
    expect(rollup.cacheCreationTokens).toBe(5);
    expect(rollup.totalTokens).toBe(375);
    expect(rollup.assistantMessageCount).toBe(2);
  });

  it('sums total_cost_usd and num_turns across multiple result events', () => {
    seedWorkflow(db, { id: 'wf-1' });
    seedRun(db, { id: 'r1', workflowId: 'wf-1' });
    // Resumed run → two result events; cost + turns SUM across them.
    seedEvent(db, 'r1', 'result', resultPayload(0.02, 3));
    seedEvent(db, 'r1', 'result', resultPayload(0.03, 2));

    const [rollup] = selectRunUsageRollups(dbAdapter(db), ['r1']);
    expect(rollup.costUsd).toBeCloseTo(0.05, 5);
    expect(rollup.numTurns).toBe(5);
  });

  it('keeps costUsd/numTurns null when no result ever carried them', () => {
    seedWorkflow(db, { id: 'wf-1' });
    seedRun(db, { id: 'r1', workflowId: 'wf-1' });
    // A result event with NEITHER total_cost_usd NOR num_turns.
    seedEvent(db, 'r1', 'result', { type: 'result', subtype: 'success', is_error: false });
    const [rollup] = selectRunUsageRollups(dbAdapter(db), ['r1']);
    expect(rollup.costUsd).toBeNull();
    expect(rollup.numTurns).toBeNull();
  });

  it('does NOT add result.usage tokens into the assistant sums (no double-count)', () => {
    seedWorkflow(db, { id: 'wf-1' });
    seedRun(db, { id: 'r1', workflowId: 'wf-1' });
    seedEvent(db, 'r1', 'assistant', assistantPayload({ input: 100, output: 50 }));
    // resultPayload() embeds a usage block of 99999/88888 that MUST be ignored.
    seedEvent(db, 'r1', 'result', resultPayload(0.01, 1));

    const [rollup] = selectRunUsageRollups(dbAdapter(db), ['r1']);
    expect(rollup.inputTokens).toBe(100);
    expect(rollup.outputTokens).toBe(50);
    expect(rollup.totalTokens).toBe(150);
  });

  it('skips malformed JSON rows silently', () => {
    seedWorkflow(db, { id: 'wf-1' });
    seedRun(db, { id: 'r1', workflowId: 'wf-1' });
    seedEvent(db, 'r1', 'assistant', assistantPayload({ input: 100, output: 50 }));
    seedEvent(db, 'r1', 'assistant', '{ this is not valid json'); // malformed
    seedEvent(db, 'r1', 'result', '}{ also broken'); // malformed

    const [rollup] = selectRunUsageRollups(dbAdapter(db), ['r1']);
    expect(rollup.inputTokens).toBe(100);
    expect(rollup.assistantMessageCount).toBe(1);
    expect(rollup.costUsd).toBeNull();
  });

  it('returns rollups in the requested run-id order, isolated per run', () => {
    seedWorkflow(db, { id: 'wf-1' });
    seedRun(db, { id: 'rA', workflowId: 'wf-1' });
    seedRun(db, { id: 'rB', workflowId: 'wf-1' });
    seedEvent(db, 'rA', 'assistant', assistantPayload({ input: 10, output: 1 }));
    seedEvent(db, 'rB', 'assistant', assistantPayload({ input: 20, output: 2 }));

    const rollups = selectRunUsageRollups(dbAdapter(db), ['rB', 'rA']);
    expect(rollups.map((r) => r.runId)).toEqual(['rB', 'rA']);
    expect(rollups[0].inputTokens).toBe(20);
    expect(rollups[1].inputTokens).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// 3. selectWorkflowUsageStats
// ---------------------------------------------------------------------------

describe('selectWorkflowUsageStats', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createInsightsDb();
  });

  it('aggregates usage and cost across a workflow runs', () => {
    seedWorkflow(db, { id: 'wf-1', name: 'Sprint' });
    seedRun(db, { id: 'r1', workflowId: 'wf-1' });
    seedRun(db, { id: 'r2', workflowId: 'wf-1' });
    // r1: 150 tokens, cost 0.02 ; r2: 250 tokens, no cost.
    seedEvent(db, 'r1', 'assistant', assistantPayload({ input: 100, output: 50 }));
    seedEvent(db, 'r1', 'result', resultPayload(0.02, 1));
    seedEvent(db, 'r2', 'assistant', assistantPayload({ input: 200, output: 50 }));

    const [stats] = selectWorkflowUsageStats(dbAdapter(db), null);
    expect(stats.workflowName).toBe('Sprint');
    expect(stats.runsWithUsage).toBe(2);
    // avg over (150, 250) = 200.
    expect(stats.avgTotalTokens).toBe(200);
    // only r1 carried cost.
    expect(stats.totalCostUsd).toBeCloseTo(0.02, 5);
    expect(stats.avgCostUsd).toBeCloseTo(0.02, 5);
  });

  it('reports null usage/cost aggregates when no run has usage', () => {
    seedWorkflow(db, { id: 'wf-1' });
    seedRun(db, { id: 'r1', workflowId: 'wf-1' });
    // an event with no usage → run has events (included) but runsWithUsage stays 0.
    seedEvent(db, 'r1', 'assistant', assistantPayload(null));

    const [stats] = selectWorkflowUsageStats(dbAdapter(db), null);
    expect(stats.runsWithUsage).toBe(0);
    expect(stats.avgTotalTokens).toBeNull();
    expect(stats.totalCostUsd).toBeNull();
    expect(stats.avgCostUsd).toBeNull();
  });

  it('honors the limitRunsPerWorkflow window', () => {
    seedWorkflow(db, { id: 'wf-1' });
    // 3 runs each with usage; window of 2 → only the 2 most recent counted.
    seedRun(db, { id: 'r1', workflowId: 'wf-1', createdAt: '2026-06-01 10:00:00' });
    seedRun(db, { id: 'r2', workflowId: 'wf-1', createdAt: '2026-06-02 10:00:00' });
    seedRun(db, { id: 'r3', workflowId: 'wf-1', createdAt: '2026-06-03 10:00:00' });
    seedEvent(db, 'r1', 'assistant', assistantPayload({ input: 1, output: 0 }));
    seedEvent(db, 'r2', 'assistant', assistantPayload({ input: 2, output: 0 }));
    seedEvent(db, 'r3', 'assistant', assistantPayload({ input: 3, output: 0 }));

    const [stats] = selectWorkflowUsageStats(dbAdapter(db), null, 2);
    expect(stats.runsWithUsage).toBe(2);
    // most recent 2 = r3(3) + r2(2) → avg 2.5 → rounded 3 (banker-agnostic round).
    expect(stats.avgTotalTokens).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 4. selectReviewItemSummary
// ---------------------------------------------------------------------------

describe('selectReviewItemSummary', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createInsightsDb();
  });

  it('returns all-zero counters with all kinds present on an empty DB', () => {
    const summary = selectReviewItemSummary(dbAdapter(db), null);
    expect(summary).toEqual({
      total: 0,
      pending: 0,
      resolved: 0,
      dismissed: 0,
      pendingByKind: { finding: 0, permission: 0, decision: 0, human_task: 0 },
    });
  });

  it('counts statuses and pendingByKind, defaulting absent kinds to 0', () => {
    seedReview(db, { id: 'v1', kind: 'finding', status: 'pending' });
    seedReview(db, { id: 'v2', kind: 'finding', status: 'pending' });
    seedReview(db, { id: 'v3', kind: 'permission', status: 'pending' });
    seedReview(db, { id: 'v4', kind: 'decision', status: 'resolved' });
    seedReview(db, { id: 'v5', kind: 'human_task', status: 'dismissed' });

    const summary = selectReviewItemSummary(dbAdapter(db), null);
    expect(summary.total).toBe(5);
    expect(summary.pending).toBe(3);
    expect(summary.resolved).toBe(1);
    expect(summary.dismissed).toBe(1);
    expect(summary.pendingByKind).toEqual({
      finding: 2,
      permission: 1,
      decision: 0, // the only decision is resolved → not pending
      human_task: 0,
    });
  });

  it('filters by projectId', () => {
    seedReview(db, { id: 'v1', projectId: 1, status: 'pending' });
    seedReview(db, { id: 'v2', projectId: 2, status: 'pending' });
    const summary = selectReviewItemSummary(dbAdapter(db), 2);
    expect(summary.total).toBe(1);
    expect(summary.pending).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. selectQualityFindings
// ---------------------------------------------------------------------------

describe('selectQualityFindings', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createInsightsDb();
  });

  it('returns [] on an empty DB', () => {
    expect(selectQualityFindings(dbAdapter(db), null)).toEqual([]);
  });

  it('parses category/locations/sourceStep and joins the run + workflow', () => {
    seedWorkflow(db, { id: 'wf-1', name: 'Sprint' });
    seedRun(db, { id: 'r1', workflowId: 'wf-1', outcome: 'merged', endedAt: '2026-06-01 10:00:00' });
    seedReview(db, {
      id: 'v1',
      runId: 'r1',
      kind: 'finding',
      status: 'pending',
      severity: 'warning',
      source: 'agent:executor',
      payload: {
        kind: 'finding',
        category: 'security',
        locations: [
          { path: 'src/a.ts', line: 42 },
          { path: 'src/b.ts' }, // no line
          { path: 12345 }, // invalid path → skipped
          'not-an-object', // skipped
        ],
      },
    });

    const [finding] = selectQualityFindings(dbAdapter(db), null);
    expect(finding.id).toBe('v1');
    expect(finding.severity).toBe('warning');
    expect(finding.status).toBe('pending');
    expect(finding.source).toBe('agent:executor');
    expect(finding.sourceStep).toBe('executor');
    expect(finding.category).toBe('security');
    expect(finding.locations).toEqual([
      { path: 'src/a.ts', line: 42 },
      { path: 'src/b.ts' },
    ]);
    expect(finding.runId).toBe('r1');
    expect(finding.runOutcome).toBe('merged');
    expect(finding.runEndedAt).toBe('2026-06-01T10:00:00.000Z');
    expect(finding.workflowName).toBe('Sprint');
  });

  it('surfaces findings with null run fields when the run was deleted (LEFT JOIN)', () => {
    // No matching workflow_runs row for run_id 'ghost'.
    seedReview(db, {
      id: 'v1',
      runId: 'ghost',
      kind: 'finding',
      source: null,
      payload: { kind: 'finding' }, // no category/locations
    });

    const [finding] = selectQualityFindings(dbAdapter(db), null);
    expect(finding.runId).toBe('ghost');
    expect(finding.runOutcome).toBeNull();
    expect(finding.runEndedAt).toBeNull();
    expect(finding.workflowName).toBeNull();
    expect(finding.category).toBeNull();
    expect(finding.locations).toEqual([]);
    expect(finding.sourceStep).toBeNull();
  });

  it('only returns kind=finding rows, newest-first, honoring the limit', () => {
    seedReview(db, { id: 'old', kind: 'finding', createdAt: '2026-06-01 10:00:00' });
    seedReview(db, { id: 'new', kind: 'finding', createdAt: '2026-06-03 10:00:00' });
    seedReview(db, { id: 'mid', kind: 'finding', createdAt: '2026-06-02 10:00:00' });
    seedReview(db, { id: 'perm', kind: 'permission', createdAt: '2026-06-04 10:00:00' });

    const all = selectQualityFindings(dbAdapter(db), null);
    expect(all.map((f) => f.id)).toEqual(['new', 'mid', 'old']); // no 'perm'

    const limited = selectQualityFindings(dbAdapter(db), null, 2);
    expect(limited.map((f) => f.id)).toEqual(['new', 'mid']);
  });

  it('handles malformed payload_json by falling back to null category / [] locations', () => {
    seedReview(db, { id: 'v1', kind: 'finding', payload: '{ broken json' });
    const [finding] = selectQualityFindings(dbAdapter(db), null);
    expect(finding.category).toBeNull();
    expect(finding.locations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6. selectStepTokenBuckets
// ---------------------------------------------------------------------------

describe('selectStepTokenBuckets', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createInsightsDb();
  });

  it('returns [] when the workflow has no runs', () => {
    seedWorkflow(db, { id: 'wf-1' });
    expect(selectStepTokenBuckets(dbAdapter(db), 'wf-1')).toEqual([]);
  });

  it('attributes pre-report usage to unattributed, then switches on a suffix-matched tool', () => {
    seedWorkflow(db, { id: 'wf-1' });
    seedRun(db, { id: 'r1', workflowId: 'wf-1' });
    // 1) usage before any report_step → 'unattributed'.
    seedEvent(db, 'r1', 'assistant', assistantPayload({ input: 100, output: 0 }));
    // 2) a message that BOTH carries usage AND reports step 'plan'.
    //    Its own usage is attributed to the PREVIOUS step (still unattributed),
    //    THEN the current step becomes 'plan'.
    seedEvent(db, 'r1', 'assistant', reportStepPayload('plan', { input: 10, output: 0 }));
    // 3) usage now lands under 'plan'.
    seedEvent(db, 'r1', 'assistant', assistantPayload({ input: 30, output: 0 }));
    // 4) switch to 'execute' via the bare (non-prefixed) tool name too.
    seedEvent(db, 'r1', 'assistant', reportStepPayload('execute', null, 'cyboflow_report_step'));
    // 5) usage under 'execute'.
    seedEvent(db, 'r1', 'assistant', assistantPayload({ input: 7, output: 0 }));

    const buckets = selectStepTokenBuckets(dbAdapter(db), 'wf-1');
    const byStep = new Map(buckets.map((b) => [b.stepId, b]));

    // unattributed = step1(100) + step2-own-usage(10) = 110.
    expect(byStep.get('unattributed')?.totalTokens).toBe(110);
    expect(byStep.get('unattributed')?.assistantMessageCount).toBe(2);
    // plan = step3(30) (step4 carries no usage).
    expect(byStep.get('plan')?.totalTokens).toBe(30);
    // execute = step5(7).
    expect(byStep.get('execute')?.totalTokens).toBe(7);

    // sorted by totalTokens desc.
    expect(buckets.map((b) => b.stepId)).toEqual(['unattributed', 'plan', 'execute']);
  });

  it('resets the current step per run and aggregates across runs', () => {
    seedWorkflow(db, { id: 'wf-1' });
    seedRun(db, { id: 'r1', workflowId: 'wf-1', createdAt: '2026-06-01 10:00:00' });
    seedRun(db, { id: 'r2', workflowId: 'wf-1', createdAt: '2026-06-02 10:00:00' });
    // r1: report 'plan' then usage 50.
    seedEvent(db, 'r1', 'assistant', reportStepPayload('plan', null));
    seedEvent(db, 'r1', 'assistant', assistantPayload({ input: 50, output: 0 }));
    // r2: usage 20 BEFORE any report → must NOT inherit r1's 'plan'; → 'unattributed'.
    seedEvent(db, 'r2', 'assistant', assistantPayload({ input: 20, output: 0 }));

    const buckets = selectStepTokenBuckets(dbAdapter(db), 'wf-1');
    const byStep = new Map(buckets.map((b) => [b.stepId, b]));
    expect(byStep.get('plan')?.totalTokens).toBe(50);
    expect(byStep.get('unattributed')?.totalTokens).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// 7. selectUsageTrend
// ---------------------------------------------------------------------------

describe('selectUsageTrend', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createInsightsDb();
  });

  it('returns [] when no runs fall in the window', () => {
    expect(
      selectUsageTrend(dbAdapter(db), { workflowId: null, projectId: null }),
    ).toEqual([]);
  });

  it('buckets totalTokens + run count by date, ascending', () => {
    seedWorkflow(db, { id: 'wf-1' });
    // Two runs on the same recent day + one on another recent day.
    // Use datetime('now') anchored dates so they land inside the default 30-day window.
    const today = db.prepare(`SELECT date('now') AS d`).get() as { d: string };
    const yesterday = db.prepare(`SELECT date('now','-1 days') AS d`).get() as { d: string };

    seedRun(db, { id: 'r1', workflowId: 'wf-1', createdAt: `${yesterday.d} 10:00:00` });
    seedRun(db, { id: 'r2', workflowId: 'wf-1', createdAt: `${today.d} 10:00:00` });
    seedRun(db, { id: 'r3', workflowId: 'wf-1', createdAt: `${today.d} 11:00:00` });
    seedEvent(db, 'r1', 'assistant', assistantPayload({ input: 10, output: 0 }));
    seedEvent(db, 'r2', 'assistant', assistantPayload({ input: 20, output: 0 }));
    seedEvent(db, 'r3', 'assistant', assistantPayload({ input: 5, output: 0 }));

    const trend = selectUsageTrend(dbAdapter(db), { workflowId: null, projectId: null });
    expect(trend).toHaveLength(2);
    // ascending by date → yesterday first.
    expect(trend[0].date).toBe(yesterday.d);
    expect(trend[0].totalTokens).toBe(10);
    expect(trend[0].runs).toBe(1);
    expect(trend[1].date).toBe(today.d);
    expect(trend[1].totalTokens).toBe(25); // 20 + 5
    expect(trend[1].runs).toBe(2);
  });

  it('excludes runs older than the window', () => {
    seedWorkflow(db, { id: 'wf-1' });
    seedRun(db, { id: 'old', workflowId: 'wf-1', createdAt: '2000-01-01 10:00:00' });
    seedEvent(db, 'old', 'assistant', assistantPayload({ input: 100, output: 0 }));
    const trend = selectUsageTrend(dbAdapter(db), { workflowId: null, projectId: null, days: 7 });
    expect(trend).toEqual([]);
  });

  it('filters by workflowId and projectId', () => {
    seedWorkflow(db, { id: 'wf-a', projectId: 1 });
    seedWorkflow(db, { id: 'wf-b', projectId: 2 });
    const today = db.prepare(`SELECT date('now') AS d`).get() as { d: string };
    seedRun(db, { id: 'ra', workflowId: 'wf-a', projectId: 1, createdAt: `${today.d} 10:00:00` });
    seedRun(db, { id: 'rb', workflowId: 'wf-b', projectId: 2, createdAt: `${today.d} 10:00:00` });
    seedEvent(db, 'ra', 'assistant', assistantPayload({ input: 10, output: 0 }));
    seedEvent(db, 'rb', 'assistant', assistantPayload({ input: 20, output: 0 }));

    const onlyA = selectUsageTrend(dbAdapter(db), { workflowId: 'wf-a', projectId: null });
    expect(onlyA).toHaveLength(1);
    expect(onlyA[0].totalTokens).toBe(10);

    const onlyP2 = selectUsageTrend(dbAdapter(db), { workflowId: null, projectId: 2 });
    expect(onlyP2).toHaveLength(1);
    expect(onlyP2[0].totalTokens).toBe(20);
  });

  it('clamps days to the 1..90 range', () => {
    seedWorkflow(db, { id: 'wf-1' });
    // A run ~60 days ago: visible with days=90 (clamped from 999) but not days=7.
    const sixtyAgo = db.prepare(`SELECT datetime('now','-60 days') AS d`).get() as { d: string };
    seedRun(db, { id: 'r1', workflowId: 'wf-1', createdAt: sixtyAgo.d });
    seedEvent(db, 'r1', 'assistant', assistantPayload({ input: 10, output: 0 }));

    const wide = selectUsageTrend(dbAdapter(db), { workflowId: null, projectId: null, days: 999 });
    expect(wide).toHaveLength(1);
    const narrow = selectUsageTrend(dbAdapter(db), { workflowId: null, projectId: null, days: 7 });
    expect(narrow).toEqual([]);
  });
});
