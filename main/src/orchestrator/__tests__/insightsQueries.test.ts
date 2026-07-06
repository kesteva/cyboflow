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
 *     empty-run seeding, materialized-row preference (run_usage wins over a
 *     contradicting raw_events scan), mixed materialized + fallback cohort.
 *   - selectRunUsageRollupsFromRawEvents: force-scan path IGNORES an existing
 *     run_usage row (the writer's re-materialization contract — never read back
 *     its own row), empty-id list, caller-order array, zero-seeding.
 *   - selectWorkflowUsageStats: runsWithUsage / avgTotalTokens / totalTokens / cost
 *     aggregates (totalTokens null when no run has usage), run_usage hit path
 *     qualifies a run with no raw_events.
 *   - selectDailyModelUsage: (day, model) grouping, project scoping, day-window
 *     cutoff, cache exclusion from totalTokens, 'unknown' model fallback,
 *     non-assistant events ignored, malformed payload_json skipped, sort order.
 *   - selectReviewItemSummary: status + pendingByKind, all-kinds-present default.
 *   - selectQualityFindings: category/locations/sourceStep parsing, LEFT JOIN
 *     null path (run deleted), severity/status narrowing, ordering.
 *   - selectStepTokenBuckets: usage-before-first-report lands in 'unattributed',
 *     suffix-matched MCP tool name, step_id switching, sort order (tool_use
 *     fallback); persisted step_transition rows drive attribution by row-id
 *     interleaving incl. 'unattributed' head; fallback unchanged sans transitions.
 *   - selectUsageTrend: date bucketing, window filter, ascending order.
 *
 * Migration-025 fixtures: the in-memory schema carries the `run_usage` table so
 * the two-tier (materialized-first) read paths can be exercised; `seedRunUsage`
 * inserts a precomputed rollup row and `seedEvent` with event_type
 * 'step_transition' seeds the persisted-timeline path (AUTOINCREMENT id =
 * insertion order = the row-id ordering both attribution paths interleave on).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import {
  selectWorkflowRunStats,
  selectRunUsageRollups,
  selectRunUsageRollupsFromRawEvents,
  selectWorkflowUsageStats,
  selectReviewItemSummary,
  selectQualityFindings,
  selectStepTokenBuckets,
  selectUsageTrend,
  selectWorkflowRevisionStats,
  selectDailyModelUsage,
  selectSessionRunTokenTotals,
  getRunEval,
} from '../insightsQueries';
import { computeSpecHash } from '../specHash';

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
      project_id INTEGER,
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
      session_id TEXT,
      substrate TEXT NOT NULL DEFAULT 'sdk',
      spec_hash TEXT,
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
    CREATE TABLE run_usage (
      run_id TEXT PRIMARY KEY,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL,
      num_turns INTEGER,
      assistant_message_count INTEGER NOT NULL DEFAULT 0,
      computed_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
    CREATE TABLE workflow_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id TEXT NOT NULL,
      spec_hash TEXT NOT NULL,
      spec_json TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (workflow_id, spec_hash)
    );
    -- migration-043 run_evals (created here by the sibling migration task; the
    -- getRunEval read path is tested against this hand-rolled twin).
    CREATE TABLE run_evals (
      run_id TEXT NOT NULL,
      rubric_version TEXT NOT NULL,
      eval_status TEXT NOT NULL DEFAULT 'pending',
      base_sha TEXT,
      diff_text TEXT,
      diff_stats_json TEXT,
      gate_results_json TEXT,
      human_influenced INTEGER NOT NULL DEFAULT 0,
      snapshot_at TEXT NOT NULL,
      overall_score INTEGER,
      band TEXT,
      ci_low REAL,
      ci_high REAL,
      gated INTEGER NOT NULL DEFAULT 0,
      security_flag INTEGER NOT NULL DEFAULT 0,
      requirements_unmet INTEGER NOT NULL DEFAULT 0,
      cap_triggers_json TEXT,
      dimensions_json TEXT,
      per_sample_json TEXT,
      judge_model TEXT,
      sample_count INTEGER,
      prompt_hash TEXT,
      judge_build_id TEXT,
      workflow_id TEXT NOT NULL,
      workflow_name TEXT NOT NULL,
      spec_hash TEXT,
      run_model TEXT,
      subagent_models_json TEXT,
      difficulty_proxy_prerun REAL,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      PRIMARY KEY (run_id, rubric_version)
    );
  `);
  return db;
}

interface SeedWorkflowOpts {
  id: string;
  name?: string;
  projectId?: number;
  /** Live spec_json — hashed by selectWorkflowRevisionStats to flag isCurrent. */
  specJson?: string;
}

function seedWorkflow(db: Database.Database, opts: SeedWorkflowOpts): void {
  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES (?, ?, ?, ?)`,
  ).run(opts.id, opts.projectId ?? 1, opts.name ?? opts.id, opts.specJson ?? '{}');
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
  /** Frozen spec_hash (the revision bucket key); null = pre-mig-025 historic run. */
  specHash?: string | null;
  /** Owning quick session (migration 019); null = standalone flow run. */
  sessionId?: string | null;
  /** CLI substrate stamp (IDEA-013); defaults to 'sdk'. The SDK `__quick__` sentinel exclusion keys off it. */
  substrate?: string;
}

function seedRun(db: Database.Database, opts: SeedRunOpts): void {
  db.prepare(
    `INSERT INTO workflow_runs
       (id, workflow_id, project_id, status, outcome, session_id, substrate, spec_hash, created_at, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), ?, ?)`,
  ).run(
    opts.id,
    opts.workflowId,
    opts.projectId ?? 1,
    opts.status ?? 'completed',
    opts.outcome ?? null,
    opts.sessionId ?? null,
    opts.substrate ?? 'sdk',
    opts.specHash ?? null,
    opts.createdAt ?? null,
    opts.startedAt ?? null,
    opts.endedAt ?? null,
  );
}

interface SeedRevisionOpts {
  workflowId: string;
  specHash: string;
  specJson?: string;
  createdAt?: string;
}

/** Insert a migration-026 `workflow_revisions` snapshot row. */
function seedRevision(db: Database.Database, opts: SeedRevisionOpts): void {
  db.prepare(
    `INSERT OR IGNORE INTO workflow_revisions (workflow_id, spec_hash, spec_json, created_at)
     VALUES (?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`,
  ).run(
    opts.workflowId,
    opts.specHash,
    opts.specJson ?? '{}',
    opts.createdAt ?? null,
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

interface SeedRunUsageOpts {
  runId: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** When omitted, defaults to input + output to mirror the migration-026 contract. */
  totalTokens?: number;
  costUsd?: number | null;
  numTurns?: number | null;
  assistantMessageCount?: number;
}

/** Insert a precomputed migration-026 `run_usage` row (the materialized tier). */
function seedRunUsage(db: Database.Database, opts: SeedRunUsageOpts): void {
  const input = opts.inputTokens ?? 0;
  const output = opts.outputTokens ?? 0;
  db.prepare(
    `INSERT INTO run_usage
       (run_id, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
        total_tokens, cost_usd, num_turns, assistant_message_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.runId,
    input,
    output,
    opts.cacheReadTokens ?? 0,
    opts.cacheCreationTokens ?? 0,
    opts.totalTokens ?? input + output,
    opts.costUsd === undefined ? null : opts.costUsd,
    opts.numTurns === undefined ? null : opts.numTurns,
    opts.assistantMessageCount ?? 0,
  );
}

interface SeedRunEvalOpts {
  runId: string;
  rubricVersion?: string;
  evalStatus?: string;
  humanInfluenced?: number;
  snapshotAt?: string;
  overallScore?: number | null;
  band?: string | null;
  gated?: number;
  securityFlag?: number;
  requirementsUnmet?: number;
  capTriggersJson?: string | null;
  dimensionsJson?: string | null;
  perSampleJson?: string | null;
  diffStatsJson?: string | null;
  subagentModelsJson?: string | null;
  workflowId?: string;
  workflowName?: string;
  error?: string | null;
}

/** Insert a migration-043 `run_evals` row (the code-review eval read fixture). */
function seedRunEval(db: Database.Database, opts: SeedRunEvalOpts): void {
  db.prepare(
    `INSERT INTO run_evals
       (run_id, rubric_version, eval_status, human_influenced, snapshot_at,
        overall_score, band, gated, security_flag, requirements_unmet, cap_triggers_json,
        dimensions_json, per_sample_json,
        diff_stats_json, subagent_models_json, workflow_id, workflow_name, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.runId,
    opts.rubricVersion ?? '1.1',
    opts.evalStatus ?? 'complete',
    opts.humanInfluenced ?? 0,
    opts.snapshotAt ?? '2026-07-01T10:00:00.000Z',
    opts.overallScore === undefined ? 82 : opts.overallScore,
    opts.band === undefined ? 'Good' : opts.band,
    opts.gated ?? 0,
    opts.securityFlag ?? 0,
    opts.requirementsUnmet ?? 0,
    opts.capTriggersJson === undefined ? null : opts.capTriggersJson,
    opts.dimensionsJson === undefined ? null : opts.dimensionsJson,
    opts.perSampleJson === undefined ? null : opts.perSampleJson,
    opts.diffStatsJson === undefined ? null : opts.diffStatsJson,
    opts.subagentModelsJson === undefined ? null : opts.subagentModelsJson,
    opts.workflowId ?? 'wf-1',
    opts.workflowName ?? 'Sprint',
    opts.error === undefined ? null : opts.error,
  );
}

/** Construct a persisted `step_transition` raw_events payload (migration 026). */
function stepTransitionPayload(
  stepId: string,
  status: 'running' | 'done' = 'running',
): Record<string, unknown> {
  return {
    kind: 'step_transition',
    step_id: stepId,
    status,
    timestamp: '2026-06-11T10:00:00.000Z',
  };
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

/**
 * Assistant payload with a caller-chosen model (or NO model field when `model`
 * is null, exercising the 'unknown' fallback). When `usage` is null the message
 * carries no usage object, so the daily-model scan skips it.
 */
function assistantPayloadWithModel(
  model: string | null,
  usage: { input?: number; output?: number; cacheRead?: number; cacheCreation?: number } | null,
): Record<string, unknown> {
  const base = assistantPayload(usage);
  const message = base.message as Record<string, unknown>;
  if (model === null) delete message.model;
  else message.model = model;
  return base;
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

  it('prefers the materialized run_usage row over a contradicting raw_events scan', () => {
    seedWorkflow(db, { id: 'wf-1' });
    seedRun(db, { id: 'r1', workflowId: 'wf-1' });
    // raw_events DELIBERATELY disagree with the materialized row — they would
    // produce 100/50/150 if scanned. The two-tier read must IGNORE them entirely
    // for a run that carries a run_usage row.
    seedEvent(db, 'r1', 'assistant', assistantPayload({ input: 100, output: 50 }));
    seedEvent(db, 'r1', 'result', resultPayload(0.99, 9));
    seedRunUsage(db, {
      runId: 'r1',
      inputTokens: 300,
      outputTokens: 200,
      cacheReadTokens: 11,
      cacheCreationTokens: 7,
      costUsd: 0.02,
      numTurns: 3,
      assistantMessageCount: 4,
    });

    const [rollup] = selectRunUsageRollups(dbAdapter(db), ['r1']);
    // Materialized values win — NOT the 100/50 from raw_events.
    expect(rollup.inputTokens).toBe(300);
    expect(rollup.outputTokens).toBe(200);
    expect(rollup.cacheReadTokens).toBe(11);
    expect(rollup.cacheCreationTokens).toBe(7);
    // totalTokens re-derived from input + output (500), not the contradicting scan.
    expect(rollup.totalTokens).toBe(500);
    expect(rollup.costUsd).toBeCloseTo(0.02, 5);
    expect(rollup.numTurns).toBe(3);
    expect(rollup.assistantMessageCount).toBe(4);
  });

  it('keeps materialized cost/turns null when the row carried none', () => {
    seedWorkflow(db, { id: 'wf-1' });
    seedRun(db, { id: 'r1', workflowId: 'wf-1' });
    seedRunUsage(db, { runId: 'r1', inputTokens: 10, outputTokens: 5, costUsd: null, numTurns: null });

    const [rollup] = selectRunUsageRollups(dbAdapter(db), ['r1']);
    expect(rollup.totalTokens).toBe(15);
    expect(rollup.costUsd).toBeNull();
    expect(rollup.numTurns).toBeNull();
  });

  it('mixes a materialized run with a raw_events-fallback run in one call', () => {
    seedWorkflow(db, { id: 'wf-1' });
    seedRun(db, { id: 'rMat', workflowId: 'wf-1' });
    seedRun(db, { id: 'rRaw', workflowId: 'wf-1' });
    // rMat: materialized only (no raw_events at all — pruned).
    seedRunUsage(db, { runId: 'rMat', inputTokens: 80, outputTokens: 20, costUsd: 0.05, assistantMessageCount: 2 });
    // rRaw: no run_usage row → falls back to the live scan.
    seedEvent(db, 'rRaw', 'assistant', assistantPayload({ input: 40, output: 10 }));
    seedEvent(db, 'rRaw', 'result', resultPayload(0.01, 1));

    const rollups = selectRunUsageRollups(dbAdapter(db), ['rMat', 'rRaw']);
    const byId = new Map(rollups.map((r) => [r.runId, r]));

    expect(byId.get('rMat')?.totalTokens).toBe(100);
    expect(byId.get('rMat')?.costUsd).toBeCloseTo(0.05, 5);
    expect(byId.get('rMat')?.assistantMessageCount).toBe(2);

    expect(byId.get('rRaw')?.totalTokens).toBe(50);
    expect(byId.get('rRaw')?.costUsd).toBeCloseTo(0.01, 5);
    expect(byId.get('rRaw')?.assistantMessageCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2a. selectSessionRunTokenTotals (whole-session run-token sum, by session_id)
// ---------------------------------------------------------------------------

describe('selectSessionRunTokenTotals', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createInsightsDb();
    seedWorkflow(db, { id: 'wf1' });
  });

  it('returns zeros for a session with no hosted runs', () => {
    expect(selectSessionRunTokenTotals(dbAdapter(db), 'sess-empty')).toEqual({
      runInputTokens: 0,
      runOutputTokens: 0,
      runCacheReadTokens: 0,
      runCacheCreationTokens: 0,
    });
  });

  it('sums per-category tokens across every run hosted by the session', () => {
    // Two runs on sess-1 (one materialized, one live raw_events) + one on sess-2.
    seedRun(db, { id: 'r1', workflowId: 'wf1', sessionId: 'sess-1' });
    seedRunUsage(db, {
      runId: 'r1',
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 1000,
      cacheCreationTokens: 500,
      totalTokens: 140,
    });
    seedRun(db, { id: 'r2', workflowId: 'wf1', sessionId: 'sess-1' });
    seedEvent(db, 'r2', 'assistant', assistantPayload({ input: 200, output: 60, cacheRead: 2000, cacheCreation: 800 }));
    seedRun(db, { id: 'r3', workflowId: 'wf1', sessionId: 'sess-2' });
    seedRunUsage(db, { runId: 'r3', inputTokens: 999, outputTokens: 999, cacheReadTokens: 999, cacheCreationTokens: 999, totalTokens: 1998 });

    expect(selectSessionRunTokenTotals(dbAdapter(db), 'sess-1')).toEqual({
      runInputTokens: 300,
      runOutputTokens: 100,
      runCacheReadTokens: 3000,
      runCacheCreationTokens: 1300,
    });
  });

  it('ignores standalone flow runs (session_id NULL)', () => {
    seedRun(db, { id: 'r1', workflowId: 'wf1', sessionId: null });
    seedRunUsage(db, { runId: 'r1', inputTokens: 100, outputTokens: 40, cacheReadTokens: 1000, cacheCreationTokens: 500, totalTokens: 140 });
    expect(selectSessionRunTokenTotals(dbAdapter(db), 'sess-1').runInputTokens).toBe(0);
  });

  // ─── SDK __quick__ sentinel exclusion (permission-mode redesign slice 1b, §7d) ───

  it('EXCLUDES the SDK __quick__ sentinel run (its tokens are already counted via session_outputs)', () => {
    // Once the SDK sentinel's session_id is stamped, this run scan would otherwise
    // double-count every SDK chat turn (getSessionTokenUsage already counts it).
    seedWorkflow(db, { id: 'wf-quick', name: '__quick__' });
    seedRun(db, { id: 'r-sdk', workflowId: 'wf-quick', sessionId: 'sess-x', substrate: 'sdk' });
    seedRunUsage(db, {
      runId: 'r-sdk',
      inputTokens: 500, outputTokens: 500, cacheReadTokens: 500, cacheCreationTokens: 500, totalTokens: 1000,
    });

    expect(selectSessionRunTokenTotals(dbAdapter(db), 'sess-x')).toEqual({
      runInputTokens: 0,
      runOutputTokens: 0,
      runCacheReadTokens: 0,
      runCacheCreationTokens: 0,
    });
  });

  it('COUNTS the INTERACTIVE __quick__ sentinel run (no session_outputs to double-count)', () => {
    // Interactive sentinels write NO session_outputs, so they MUST stay counted via
    // the run scan — hence the substrate discriminator (only sdk sentinels excluded).
    seedWorkflow(db, { id: 'wf-quick', name: '__quick__' });
    seedRun(db, { id: 'r-int', workflowId: 'wf-quick', sessionId: 'sess-x', substrate: 'interactive' });
    seedRunUsage(db, {
      runId: 'r-int',
      inputTokens: 70, outputTokens: 30, cacheReadTokens: 200, cacheCreationTokens: 100, totalTokens: 100,
    });

    expect(selectSessionRunTokenTotals(dbAdapter(db), 'sess-x')).toEqual({
      runInputTokens: 70,
      runOutputTokens: 30,
      runCacheReadTokens: 200,
      runCacheCreationTokens: 100,
    });
  });

  it('excludes ONLY the SDK sentinel — the session\'s real (non-__quick__) SDK flow run is still counted', () => {
    seedWorkflow(db, { id: 'wf-quick', name: '__quick__' });
    // SDK sentinel — excluded.
    seedRun(db, { id: 'r-sdk', workflowId: 'wf-quick', sessionId: 'sess-x', substrate: 'sdk' });
    seedRunUsage(db, { runId: 'r-sdk', inputTokens: 999, outputTokens: 999, cacheReadTokens: 999, cacheCreationTokens: 999, totalTokens: 1998 });
    // A real SDK flow run on the same session — same substrate, but NOT __quick__, so counted.
    seedRun(db, { id: 'r-flow', workflowId: 'wf1', sessionId: 'sess-x', substrate: 'sdk' });
    seedRunUsage(db, { runId: 'r-flow', inputTokens: 10, outputTokens: 5, cacheReadTokens: 20, cacheCreationTokens: 8, totalTokens: 15 });

    expect(selectSessionRunTokenTotals(dbAdapter(db), 'sess-x')).toEqual({
      runInputTokens: 10,
      runOutputTokens: 5,
      runCacheReadTokens: 20,
      runCacheCreationTokens: 8,
    });
  });
});

// ---------------------------------------------------------------------------
// 2b. selectRunUsageRollupsFromRawEvents (the writer's force-scan path)
// ---------------------------------------------------------------------------

describe('selectRunUsageRollupsFromRawEvents', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createInsightsDb();
  });

  it('returns [] for an empty run-id list', () => {
    expect(selectRunUsageRollupsFromRawEvents(dbAdapter(db), [])).toEqual([]);
  });

  it('IGNORES an existing run_usage row and recomputes from raw_events', () => {
    // This is the materializer's contract: rollupRunUsage reads back the row it
    // is about to REPLACE, so it must NEVER serve the stale materialized tier —
    // otherwise every re-rollup freezes the row at its first value. Here the
    // materialized row DELIBERATELY contradicts the (larger) raw_events log; the
    // force-scan path must return the raw_events values, NOT the stale 300/200.
    seedWorkflow(db, { id: 'wf-1' });
    seedRun(db, { id: 'r1', workflowId: 'wf-1' });
    seedRunUsage(db, {
      runId: 'r1',
      inputTokens: 300,
      outputTokens: 200,
      costUsd: 0.99,
      numTurns: 9,
      assistantMessageCount: 4,
    });
    // raw_events tell the TRUE, now-larger story (the later turns the stale row missed).
    seedEvent(db, 'r1', 'assistant', assistantPayload({ input: 100, output: 50, cacheRead: 3, cacheCreation: 2 }));
    seedEvent(db, 'r1', 'assistant', assistantPayload({ input: 200, output: 100 }));
    seedEvent(db, 'r1', 'result', resultPayload(0.05, 2));

    const [rollup] = selectRunUsageRollupsFromRawEvents(dbAdapter(db), ['r1']);
    // Raw-events values win — the materialized 300/200/0.99/9/4 are ignored.
    expect(rollup.inputTokens).toBe(300); // 100 + 200 from the events
    expect(rollup.outputTokens).toBe(150); // 50 + 100
    expect(rollup.cacheReadTokens).toBe(3);
    expect(rollup.cacheCreationTokens).toBe(2);
    expect(rollup.totalTokens).toBe(450);
    expect(rollup.costUsd).toBeCloseTo(0.05, 5);
    expect(rollup.numTurns).toBe(2);
    expect(rollup.assistantMessageCount).toBe(2);
  });

  it('seeds a zeroed rollup for an id with no raw_events even when no run_usage row exists', () => {
    seedWorkflow(db, { id: 'wf-1' });
    seedRun(db, { id: 'r1', workflowId: 'wf-1' });
    const [rollup] = selectRunUsageRollupsFromRawEvents(dbAdapter(db), ['r1']);
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

  it('returns rollups in the requested run-id order, isolated per run', () => {
    seedWorkflow(db, { id: 'wf-1' });
    seedRun(db, { id: 'rA', workflowId: 'wf-1' });
    seedRun(db, { id: 'rB', workflowId: 'wf-1' });
    seedEvent(db, 'rA', 'assistant', assistantPayload({ input: 10, output: 1 }));
    seedEvent(db, 'rB', 'assistant', assistantPayload({ input: 20, output: 2 }));

    const rollups = selectRunUsageRollupsFromRawEvents(dbAdapter(db), ['rB', 'rA']);
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
    // r1: 150 in/out tokens (+1200 cache), cost 0.02 ; r2: 250 in/out (+3500 cache), no cost.
    seedEvent(db, 'r1', 'assistant', assistantPayload({ input: 100, output: 50, cacheRead: 1000, cacheCreation: 200 }));
    seedEvent(db, 'r1', 'result', resultPayload(0.02, 1));
    seedEvent(db, 'r2', 'assistant', assistantPayload({ input: 200, output: 50, cacheRead: 3000, cacheCreation: 500 }));

    const [stats] = selectWorkflowUsageStats(dbAdapter(db), null);
    expect(stats.workflowName).toBe('Sprint');
    expect(stats.runsWithUsage).toBe(2);
    // avg over (150, 250) = 200.
    expect(stats.avgTotalTokens).toBe(200);
    // raw SUM over (150, 250) = 400 — the unaveraged companion to avgTotalTokens.
    // Cache is EXCLUDED from totalTokens (mirrors the migration-026 contract).
    expect(stats.totalTokens).toBe(400);
    // ...but surfaced separately: cache read + creation = (1200) + (3500) = 4700.
    expect(stats.totalCacheTokens).toBe(4700);
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
    // totalTokens is null (not 0) when no run carried usage — distinguishes
    // "no data" from "a real zero" for the by-flow bars.
    expect(stats.totalTokens).toBeNull();
    expect(stats.totalCacheTokens).toBeNull();
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

  it('qualifies a run via its materialized run_usage row even with no raw_events', () => {
    seedWorkflow(db, { id: 'wf-1', name: 'Sprint' });
    // rMat has NO raw_events (pruned) — it must still count via EXISTS(run_usage).
    seedRun(db, { id: 'rMat', workflowId: 'wf-1' });
    seedRunUsage(db, {
      runId: 'rMat',
      inputTokens: 120,
      outputTokens: 80,
      costUsd: 0.04,
      assistantMessageCount: 3,
    });
    // rRaw uses the fallback scan path.
    seedRun(db, { id: 'rRaw', workflowId: 'wf-1' });
    seedEvent(db, 'rRaw', 'assistant', assistantPayload({ input: 100, output: 0 }));

    const [stats] = selectWorkflowUsageStats(dbAdapter(db), null);
    // both runs carried usage (rMat materialized, rRaw scanned).
    expect(stats.runsWithUsage).toBe(2);
    // avg over (200, 100) = 150.
    expect(stats.avgTotalTokens).toBe(150);
    // only rMat carried cost.
    expect(stats.totalCostUsd).toBeCloseTo(0.04, 5);
    expect(stats.avgCostUsd).toBeCloseTo(0.04, 5);
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
      pendingByKind: { finding: 0, permission: 0, decision: 0, human_task: 0, notification: 0 },
    });
  });

  it('counts statuses and pendingByKind, defaulting absent kinds to 0', () => {
    seedReview(db, { id: 'v1', kind: 'finding', status: 'pending' });
    seedReview(db, { id: 'v2', kind: 'finding', status: 'pending' });
    seedReview(db, { id: 'v3', kind: 'permission', status: 'pending' });
    seedReview(db, { id: 'v4', kind: 'decision', status: 'resolved' });
    seedReview(db, { id: 'v5', kind: 'human_task', status: 'dismissed' });
    seedReview(db, { id: 'v6', kind: 'notification', status: 'pending' });

    const summary = selectReviewItemSummary(dbAdapter(db), null);
    expect(summary.total).toBe(6);
    expect(summary.pending).toBe(4);
    expect(summary.resolved).toBe(1);
    expect(summary.dismissed).toBe(1);
    expect(summary.pendingByKind).toEqual({
      finding: 2,
      permission: 1,
      decision: 0, // the only decision is resolved → not pending
      human_task: 0,
      notification: 1,
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

  it('drives attribution from persisted step_transition rows via row-id interleaving', () => {
    seedWorkflow(db, { id: 'wf-1' });
    seedRun(db, { id: 'r1', workflowId: 'wf-1' });
    // Insertion order = AUTOINCREMENT id order:
    //   id1 assistant 100 → BEFORE any transition → 'unattributed'.
    //   id2 step_transition running 'plan' → switch.
    //   id3 assistant 30 → 'plan' (most recent transition with a smaller id).
    //   id4 step_transition running 'execute' → switch.
    //   id5 assistant 7 → 'execute'.
    seedEvent(db, 'r1', 'assistant', assistantPayload({ input: 100, output: 0 }));
    seedEvent(db, 'r1', 'step_transition', stepTransitionPayload('plan', 'running'));
    seedEvent(db, 'r1', 'assistant', assistantPayload({ input: 30, output: 0 }));
    seedEvent(db, 'r1', 'step_transition', stepTransitionPayload('execute', 'running'));
    seedEvent(db, 'r1', 'assistant', assistantPayload({ input: 7, output: 0 }));

    const buckets = selectStepTokenBuckets(dbAdapter(db), 'wf-1');
    const byStep = new Map(buckets.map((b) => [b.stepId, b]));
    expect(byStep.get('unattributed')?.totalTokens).toBe(100);
    expect(byStep.get('unattributed')?.assistantMessageCount).toBe(1);
    expect(byStep.get('plan')?.totalTokens).toBe(30);
    expect(byStep.get('execute')?.totalTokens).toBe(7);
    expect(buckets.map((b) => b.stepId)).toEqual(['unattributed', 'plan', 'execute']);
  });

  it('keeps the just-finished step current across a done transition until the next running', () => {
    seedWorkflow(db, { id: 'wf-1' });
    seedRun(db, { id: 'r1', workflowId: 'wf-1' });
    //   id1 step_transition running 'plan'.
    //   id2 assistant 10 → 'plan'.
    //   id3 step_transition done 'plan' (most recent transition keeps 'plan' current).
    //   id4 assistant 5 → 'plan' (still — no new running yet).
    //   id5 step_transition running 'execute'.
    //   id6 assistant 8 → 'execute'.
    seedEvent(db, 'r1', 'step_transition', stepTransitionPayload('plan', 'running'));
    seedEvent(db, 'r1', 'assistant', assistantPayload({ input: 10, output: 0 }));
    seedEvent(db, 'r1', 'step_transition', stepTransitionPayload('plan', 'done'));
    seedEvent(db, 'r1', 'assistant', assistantPayload({ input: 5, output: 0 }));
    seedEvent(db, 'r1', 'step_transition', stepTransitionPayload('execute', 'running'));
    seedEvent(db, 'r1', 'assistant', assistantPayload({ input: 8, output: 0 }));

    const buckets = selectStepTokenBuckets(dbAdapter(db), 'wf-1');
    const byStep = new Map(buckets.map((b) => [b.stepId, b]));
    expect(byStep.get('plan')?.totalTokens).toBe(15); // 10 + 5
    expect(byStep.get('execute')?.totalTokens).toBe(8);
    expect(byStep.has('unattributed')).toBe(false); // no usage before the first transition
  });

  it('ignores tool_use-embedded transitions when persisted step_transition rows exist', () => {
    seedWorkflow(db, { id: 'wf-1' });
    seedRun(db, { id: 'r1', workflowId: 'wf-1' });
    // The persisted rows are authoritative. The reportStep tool_use names a
    // DIFFERENT step ('ghost') that must be IGNORED because a transition row is present.
    seedEvent(db, 'r1', 'step_transition', stepTransitionPayload('plan', 'running'));
    seedEvent(db, 'r1', 'assistant', reportStepPayload('ghost', { input: 40, output: 0 }));

    const buckets = selectStepTokenBuckets(dbAdapter(db), 'wf-1');
    const byStep = new Map(buckets.map((b) => [b.stepId, b]));
    expect(byStep.get('plan')?.totalTokens).toBe(40);
    expect(byStep.has('ghost')).toBe(false);
  });

  it('falls back to the tool_use scan for runs with NO step_transition rows (per-run decision)', () => {
    seedWorkflow(db, { id: 'wf-1' });
    seedRun(db, { id: 'rTrans', workflowId: 'wf-1', createdAt: '2026-06-01 10:00:00' });
    seedRun(db, { id: 'rTool', workflowId: 'wf-1', createdAt: '2026-06-02 10:00:00' });
    // rTrans uses the persisted-timeline path.
    seedEvent(db, 'rTrans', 'step_transition', stepTransitionPayload('plan', 'running'));
    seedEvent(db, 'rTrans', 'assistant', assistantPayload({ input: 12, output: 0 }));
    // rTool has NO transition rows → tool_use fallback: the reporting message's
    // own usage (10) counts under the PREVIOUS step ('unattributed'), then 'build'.
    seedEvent(db, 'rTool', 'assistant', reportStepPayload('build', { input: 10, output: 0 }));
    seedEvent(db, 'rTool', 'assistant', assistantPayload({ input: 3, output: 0 }));

    const buckets = selectStepTokenBuckets(dbAdapter(db), 'wf-1');
    const byStep = new Map(buckets.map((b) => [b.stepId, b]));
    // rTrans 'plan' + rTool fallback 'build' aggregate independently.
    expect(byStep.get('plan')?.totalTokens).toBe(12);
    expect(byStep.get('unattributed')?.totalTokens).toBe(10); // rTool's reporting-message usage
    expect(byStep.get('build')?.totalTokens).toBe(3);
  });

  it('skips a malformed step_transition payload (no step_id) but still scans the run via the transition path', () => {
    seedWorkflow(db, { id: 'wf-1' });
    seedRun(db, { id: 'r1', workflowId: 'wf-1' });
    // A broken transition row makes the run a "has-transition" run, but the
    // unparseable row contributes no switch — usage stays 'unattributed'.
    seedEvent(db, 'r1', 'step_transition', '{ broken json');
    seedEvent(db, 'r1', 'assistant', assistantPayload({ input: 9, output: 0 }));

    const buckets = selectStepTokenBuckets(dbAdapter(db), 'wf-1');
    const byStep = new Map(buckets.map((b) => [b.stepId, b]));
    expect(byStep.get('unattributed')?.totalTokens).toBe(9);
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

// ---------------------------------------------------------------------------
// 8. selectWorkflowRevisionStats
// ---------------------------------------------------------------------------

describe('selectWorkflowRevisionStats', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createInsightsDb();
  });

  it('returns [] when the workflow has no recorded revisions', () => {
    seedWorkflow(db, { id: 'wf-1' });
    expect(selectWorkflowRevisionStats(dbAdapter(db), 'wf-1')).toEqual([]);
  });

  it('aggregates runs split across two revisions, newest revision first', () => {
    const oldSpec = '{"v":1}';
    const newSpec = '{"v":2}';
    const oldHash = computeSpecHash(oldSpec);
    const newHash = computeSpecHash(newSpec);
    // Live spec is the NEW revision → it is the current one.
    seedWorkflow(db, { id: 'wf-1', specJson: newSpec });
    seedRevision(db, {
      workflowId: 'wf-1',
      specHash: oldHash,
      specJson: oldSpec,
      createdAt: '2026-06-01 00:00:00',
    });
    seedRevision(db, {
      workflowId: 'wf-1',
      specHash: newHash,
      specJson: newSpec,
      createdAt: '2026-06-10 00:00:00',
    });

    // Old revision: 1 merged + 1 dismissed (2 terminal-with-outcome) + 1 failed
    // (no outcome) → success = merged(1)/outcome(2) = 50%. failedRuns = 1.
    seedRun(db, { id: 'o1', workflowId: 'wf-1', status: 'completed', outcome: 'merged', specHash: oldHash });
    seedRun(db, { id: 'o2', workflowId: 'wf-1', status: 'completed', outcome: 'dismissed', specHash: oldHash });
    seedRun(db, { id: 'o3', workflowId: 'wf-1', status: 'failed', outcome: null, specHash: oldHash });
    // New revision: 1 merged of 1 outcome → 100%; runs=1.
    seedRun(db, { id: 'n1', workflowId: 'wf-1', status: 'completed', outcome: 'merged', specHash: newHash });

    // Materialized usage rows so avgTotalTokens has data.
    seedRunUsage(db, { runId: 'o1', inputTokens: 100, outputTokens: 100 }); // total 200
    seedRunUsage(db, { runId: 'o2', inputTokens: 100, outputTokens: 300 }); // total 400 → avg 300
    seedRunUsage(db, { runId: 'n1', inputTokens: 500, outputTokens: 500 }); // total 1000

    const out = selectWorkflowRevisionStats(dbAdapter(db), 'wf-1');
    expect(out).toHaveLength(2);

    // Newest revision first.
    const [newest, oldest] = out;
    expect(newest.specHash).toBe(newHash);
    expect(oldest.specHash).toBe(oldHash);

    // Newest revision (live) is current; older is not.
    expect(newest.isCurrent).toBe(true);
    expect(oldest.isCurrent).toBe(false);

    // Newest: 1 run, all merged of 1 outcome → 100%, avg 1000 tokens.
    expect(newest.runs).toBe(1);
    expect(newest.mergedRuns).toBe(1);
    expect(newest.failedRuns).toBe(0);
    expect(newest.successRatePct).toBe(100);
    expect(newest.avgTotalTokens).toBe(1000);

    // Oldest: 3 runs, 1 merged of 2 outcome → 50%, failedRuns 1, avg over the
    // TWO materialized rows (o1=200, o2=400; o3 unmaterialized) = 300.
    expect(oldest.runs).toBe(3);
    expect(oldest.mergedRuns).toBe(1);
    expect(oldest.failedRuns).toBe(1);
    expect(oldest.successRatePct).toBe(50);
    expect(oldest.avgTotalTokens).toBe(300);
  });

  it('rounds successRatePct to 1dp and reports 0 when no run carries an outcome', () => {
    const spec = '{"x":1}';
    const hash = computeSpecHash(spec);
    seedWorkflow(db, { id: 'wf-1', specJson: spec });
    seedRevision(db, { workflowId: 'wf-1', specHash: hash, specJson: spec });
    // 1 merged of 3 outcome-bearing runs → 33.33..% → 33.3.
    seedRun(db, { id: 'a', workflowId: 'wf-1', outcome: 'merged', specHash: hash });
    seedRun(db, { id: 'b', workflowId: 'wf-1', outcome: 'dismissed', specHash: hash });
    seedRun(db, { id: 'c', workflowId: 'wf-1', outcome: 'dismissed', specHash: hash });

    const [rev] = selectWorkflowRevisionStats(dbAdapter(db), 'wf-1');
    expect(rev.successRatePct).toBe(33.3);
  });

  it('reports successRatePct 0 and avgTotalTokens null for a revision with no runs', () => {
    const spec = '{"fresh":1}';
    const hash = computeSpecHash(spec);
    // Live spec matches this revision → current, even with zero runs.
    seedWorkflow(db, { id: 'wf-1', specJson: spec });
    seedRevision(db, { workflowId: 'wf-1', specHash: hash, specJson: spec });

    const [rev] = selectWorkflowRevisionStats(dbAdapter(db), 'wf-1');
    expect(rev.runs).toBe(0);
    expect(rev.mergedRuns).toBe(0);
    expect(rev.failedRuns).toBe(0);
    expect(rev.successRatePct).toBe(0);
    expect(rev.avgTotalTokens).toBeNull();
    expect(rev.isCurrent).toBe(true);
  });

  it('makes spec_hash=NULL (pre-mig-025) runs INVISIBLE — they belong to no revision', () => {
    const spec = '{"y":1}';
    const hash = computeSpecHash(spec);
    seedWorkflow(db, { id: 'wf-1', specJson: spec });
    seedRevision(db, { workflowId: 'wf-1', specHash: hash, specJson: spec });
    // One run on the revision, one historic (null spec_hash).
    seedRun(db, { id: 'r-on-rev', workflowId: 'wf-1', outcome: 'merged', specHash: hash });
    seedRun(db, { id: 'r-historic', workflowId: 'wf-1', outcome: 'merged', specHash: null });

    const [rev] = selectWorkflowRevisionStats(dbAdapter(db), 'wf-1');
    // The historic run does not inflate the revision's run count.
    expect(rev.runs).toBe(1);
  });

  it('flags isCurrent false for every revision when the live spec moved on to an unrecorded hash', () => {
    const oldSpec = '{"a":1}';
    const oldHash = computeSpecHash(oldSpec);
    // Live spec is a THIRD spec whose hash was never recorded as a revision.
    seedWorkflow(db, { id: 'wf-1', specJson: '{"a":3}' });
    seedRevision(db, { workflowId: 'wf-1', specHash: oldHash, specJson: oldSpec });

    const [rev] = selectWorkflowRevisionStats(dbAdapter(db), 'wf-1');
    expect(rev.isCurrent).toBe(false);
  });

  it('scopes strictly to the requested workflow', () => {
    const specA = '{"wf":"a"}';
    const specB = '{"wf":"b"}';
    seedWorkflow(db, { id: 'wf-a', specJson: specA });
    seedWorkflow(db, { id: 'wf-b', specJson: specB });
    seedRevision(db, { workflowId: 'wf-a', specHash: computeSpecHash(specA), specJson: specA });
    seedRevision(db, { workflowId: 'wf-b', specHash: computeSpecHash(specB), specJson: specB });

    const out = selectWorkflowRevisionStats(dbAdapter(db), 'wf-a');
    expect(out).toHaveLength(1);
    expect(out[0].specHash).toBe(computeSpecHash(specA));
    expect(out[0].workflowId).toBe('wf-a');
  });
});

// ---------------------------------------------------------------------------
// 9. selectDailyModelUsage
// ---------------------------------------------------------------------------

describe('selectDailyModelUsage', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createInsightsDb();
  });

  /** A datetime in the window, N days ago, at 10:00 — first 10 chars are the day. */
  function daysAgoAt(n: number, hhmmss = '10:00:00'): { day: string; ts: string } {
    const day = (
      db.prepare(`SELECT date('now', ?) AS d`).get(`-${n} days`) as { d: string }
    ).d;
    return { day, ts: `${day} ${hhmmss}` };
  }

  it('returns [] on an empty DB', () => {
    expect(selectDailyModelUsage(dbAdapter(db), null, 30)).toEqual([]);
  });

  it('groups by (day, model), sums tokens, and excludes cache from totalTokens', () => {
    seedWorkflow(db, { id: 'wf-1' });
    seedRun(db, { id: 'r1', workflowId: 'wf-1' });
    const t0 = daysAgoAt(0);
    const t1 = daysAgoAt(1);
    // Same day + same model → one bucket summing two messages (cache excluded).
    seedEvent(
      db,
      'r1',
      'assistant',
      assistantPayloadWithModel('claude-opus', { input: 100, output: 50, cacheRead: 10, cacheCreation: 5 }),
      t0.ts,
    );
    seedEvent(
      db,
      'r1',
      'assistant',
      assistantPayloadWithModel('claude-opus', { input: 20, output: 5 }),
      t0.ts,
    );
    // Same day, DIFFERENT model → its own bucket.
    seedEvent(
      db,
      'r1',
      'assistant',
      assistantPayloadWithModel('claude-sonnet', { input: 7, output: 3 }),
      t0.ts,
    );
    // Different (earlier) day, same model as the first → separate day bucket.
    seedEvent(
      db,
      'r1',
      'assistant',
      assistantPayloadWithModel('claude-opus', { input: 1, output: 1 }),
      t1.ts,
    );

    const points = selectDailyModelUsage(dbAdapter(db), null, 30);
    const byKey = new Map(points.map((p) => [`${p.day}|${p.model}`, p]));

    const todayOpus = byKey.get(`${t0.day}|claude-opus`);
    expect(todayOpus?.inputTokens).toBe(120); // 100 + 20
    expect(todayOpus?.outputTokens).toBe(55); // 50 + 5
    // cache (10/5) is EXCLUDED from the total.
    expect(todayOpus?.totalTokens).toBe(175);
    expect(todayOpus?.assistantMessageCount).toBe(2);

    const todaySonnet = byKey.get(`${t0.day}|claude-sonnet`);
    expect(todaySonnet?.totalTokens).toBe(10);
    expect(todaySonnet?.assistantMessageCount).toBe(1);

    const yesterdayOpus = byKey.get(`${t1.day}|claude-opus`);
    expect(yesterdayOpus?.totalTokens).toBe(2);
  });

  it('sorts by day ASC then model ASC', () => {
    seedWorkflow(db, { id: 'wf-1' });
    seedRun(db, { id: 'r1', workflowId: 'wf-1' });
    const t0 = daysAgoAt(0);
    const t1 = daysAgoAt(1);
    // Seed out of order; expect day-then-model ascending in the output.
    seedEvent(db, 'r1', 'assistant', assistantPayloadWithModel('zebra', { input: 1, output: 0 }), t0.ts);
    seedEvent(db, 'r1', 'assistant', assistantPayloadWithModel('alpha', { input: 1, output: 0 }), t0.ts);
    seedEvent(db, 'r1', 'assistant', assistantPayloadWithModel('mid', { input: 1, output: 0 }), t1.ts);

    const points = selectDailyModelUsage(dbAdapter(db), null, 30);
    expect(points.map((p) => `${p.day}|${p.model}`)).toEqual([
      `${t1.day}|mid`, // earlier day first
      `${t0.day}|alpha`, // same day → model ASC
      `${t0.day}|zebra`,
    ]);
  });

  it("falls back to model 'unknown' when the assistant message carries no model", () => {
    seedWorkflow(db, { id: 'wf-1' });
    seedRun(db, { id: 'r1', workflowId: 'wf-1' });
    const t0 = daysAgoAt(0);
    seedEvent(db, 'r1', 'assistant', assistantPayloadWithModel(null, { input: 9, output: 1 }), t0.ts);

    const points = selectDailyModelUsage(dbAdapter(db), null, 30);
    expect(points).toHaveLength(1);
    expect(points[0].model).toBe('unknown');
    expect(points[0].totalTokens).toBe(10);
  });

  it('scopes to a single project when projectId is non-null', () => {
    seedWorkflow(db, { id: 'wf-a', projectId: 1 });
    seedWorkflow(db, { id: 'wf-b', projectId: 2 });
    seedRun(db, { id: 'ra', workflowId: 'wf-a', projectId: 1 });
    seedRun(db, { id: 'rb', workflowId: 'wf-b', projectId: 2 });
    const t0 = daysAgoAt(0);
    seedEvent(db, 'ra', 'assistant', assistantPayloadWithModel('m', { input: 10, output: 0 }), t0.ts);
    seedEvent(db, 'rb', 'assistant', assistantPayloadWithModel('m', { input: 20, output: 0 }), t0.ts);

    // Cross-project sees both runs (same day+model → one bucket of 30).
    const all = selectDailyModelUsage(dbAdapter(db), null, 30);
    expect(all).toHaveLength(1);
    expect(all[0].totalTokens).toBe(30);

    // Project 2 only sees rb.
    const onlyP2 = selectDailyModelUsage(dbAdapter(db), 2, 30);
    expect(onlyP2).toHaveLength(1);
    expect(onlyP2[0].totalTokens).toBe(20);
  });

  it('excludes events older than the day window and clamps days to [1, 365]', () => {
    seedWorkflow(db, { id: 'wf-1' });
    seedRun(db, { id: 'r1', workflowId: 'wf-1' });
    const recent = daysAgoAt(2);
    // ~200 days ago: visible with the clamped-from-9999 max (365) but not days=7.
    const old = (
      db.prepare(`SELECT datetime('now','-200 days') AS d`).get() as { d: string }
    ).d;
    seedEvent(db, 'r1', 'assistant', assistantPayloadWithModel('m', { input: 5, output: 0 }), recent.ts);
    seedEvent(db, 'r1', 'assistant', assistantPayloadWithModel('m', { input: 50, output: 0 }), old);

    // days=7 → only the recent event.
    const narrow = selectDailyModelUsage(dbAdapter(db), null, 7);
    expect(narrow).toHaveLength(1);
    expect(narrow[0].totalTokens).toBe(5);

    // days=9999 clamps to 365 → the ~200-day-old event is now also in window.
    const wide = selectDailyModelUsage(dbAdapter(db), null, 9999);
    const total = wide.reduce((sum, p) => sum + p.totalTokens, 0);
    expect(total).toBe(55);
  });

  it('ignores non-assistant events (result rows never count)', () => {
    seedWorkflow(db, { id: 'wf-1' });
    seedRun(db, { id: 'r1', workflowId: 'wf-1' });
    const t0 = daysAgoAt(0);
    // A result event whose embedded usage block (99999/88888) MUST be ignored —
    // the WHERE clause only scans assistant rows.
    seedEvent(db, 'r1', 'result', resultPayload(0.01, 1), t0.ts);
    seedEvent(db, 'r1', 'assistant', assistantPayloadWithModel('m', { input: 4, output: 1 }), t0.ts);

    const points = selectDailyModelUsage(dbAdapter(db), null, 30);
    expect(points).toHaveLength(1);
    expect(points[0].totalTokens).toBe(5); // not the result's 99999/88888
  });

  it('skips malformed payload_json and assistant rows with no usage object', () => {
    seedWorkflow(db, { id: 'wf-1' });
    seedRun(db, { id: 'r1', workflowId: 'wf-1' });
    const t0 = daysAgoAt(0);
    seedEvent(db, 'r1', 'assistant', '{ not valid json', t0.ts); // malformed → skip
    seedEvent(db, 'r1', 'assistant', assistantPayloadWithModel('m', null), t0.ts); // no usage → skip
    seedEvent(db, 'r1', 'assistant', assistantPayloadWithModel('m', { input: 6, output: 0 }), t0.ts);

    const points = selectDailyModelUsage(dbAdapter(db), null, 30);
    expect(points).toHaveLength(1);
    expect(points[0].totalTokens).toBe(6);
    expect(points[0].assistantMessageCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// selectRunUsageRollups — runtime timestamps (migration-020 started_at/ended_at)
// ---------------------------------------------------------------------------

describe('selectRunUsageRollups runtime timestamps', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createInsightsDb();
  });

  it('folds started_at / ended_at from workflow_runs into the rollup (ISO-normalized)', () => {
    seedWorkflow(db, { id: 'wf-1' });
    seedRun(db, {
      id: 'r1',
      workflowId: 'wf-1',
      startedAt: '2026-07-01 10:00:00',
      endedAt: '2026-07-01 10:05:00',
    });
    seedEvent(db, 'r1', 'assistant', { message: { usage: { input_tokens: 3, output_tokens: 1 } } });

    const [rollup] = selectRunUsageRollups(dbAdapter(db), ['r1']);
    expect(rollup.startedAt).toBe('2026-07-01T10:00:00.000Z');
    expect(rollup.endedAt).toBe('2026-07-01T10:05:00.000Z');
    // Token aggregation is unaffected by the timestamp fold.
    expect(rollup.totalTokens).toBe(4);
  });

  it('leaves endedAt null while the run is still in flight', () => {
    seedWorkflow(db, { id: 'wf-1' });
    seedRun(db, { id: 'r1', workflowId: 'wf-1', startedAt: '2026-07-01 10:00:00', endedAt: null });

    const [rollup] = selectRunUsageRollups(dbAdapter(db), ['r1']);
    expect(rollup.startedAt).toBe('2026-07-01T10:00:00.000Z');
    expect(rollup.endedAt).toBeNull();
  });

  it('leaves both timestamps null when the run row is absent', () => {
    const [rollup] = selectRunUsageRollups(dbAdapter(db), ['ghost']);
    expect(rollup.startedAt).toBeNull();
    expect(rollup.endedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getRunEval (migration-043 run_evals read path)
// ---------------------------------------------------------------------------

describe('getRunEval', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createInsightsDb();
  });

  it('returns null when the run has no eval row', () => {
    expect(getRunEval(dbAdapter(db), 'nope')).toBeNull();
  });

  it('maps snake_case columns to the camelCase RunEval shape', () => {
    seedRunEval(db, {
      runId: 'r1',
      rubricVersion: '1.1',
      evalStatus: 'complete',
      overallScore: 91,
      band: 'Excellent',
      gated: 1,
      securityFlag: 0,
      workflowId: 'wf-9',
      workflowName: 'Ship',
    });

    const evalRow = getRunEval(dbAdapter(db), 'r1');
    expect(evalRow).not.toBeNull();
    expect(evalRow).toMatchObject({
      runId: 'r1',
      rubricVersion: '1.1',
      evalStatus: 'complete',
      overallScore: 91,
      band: 'Excellent',
      gated: true, // INTEGER 1 → boolean
      securityFlag: false, // INTEGER 0 → boolean
      humanInfluenced: false,
      workflowId: 'wf-9',
      workflowName: 'Ship',
    });
  });

  it('parses dimensions_json into a typed dimension array', () => {
    seedRunEval(db, {
      runId: 'r1',
      dimensionsJson: JSON.stringify([
        {
          key: 'correctness',
          name: 'Correctness',
          weight: 0.4,
          score: 88,
          active: true,
          passCount: 2,
          failCount: 1,
          unknownCount: 0,
        },
        'garbage-non-object', // skipped defensively
      ]),
    });

    const evalRow = getRunEval(dbAdapter(db), 'r1');
    expect(evalRow?.dimensions).toEqual([
      {
        key: 'correctness',
        name: 'Correctness',
        weight: 0.4,
        score: 88,
        active: true,
        passCount: 2,
        failCount: 1,
        unknownCount: 0,
      },
    ]);
  });

  it('excludes the heavy diff_text / per_sample_json columns from the polled read', () => {
    // getRunEval is polled every 10s by the summary panel, which reads neither of
    // these (potentially multi-MB) columns — so the read must never ship them.
    seedRunEval(db, {
      runId: 'r1',
      perSampleJson: JSON.stringify([{ verdict: 'pass', score: 90 }]),
    });
    const evalRow = getRunEval(dbAdapter(db), 'r1');
    expect(evalRow?.perSample).toBeNull();
    expect(evalRow?.diffText).toBeNull();
  });

  it('parses cap_triggers_json + requirements_unmet (capped 69 distinguishable from organic)', () => {
    seedRunEval(db, {
      runId: 'r1',
      overallScore: 69,
      band: 'Fair',
      requirementsUnmet: 1,
      capTriggersJson: JSON.stringify(['SCP-1', 'security', 42]),
    });
    const evalRow = getRunEval(dbAdapter(db), 'r1');
    expect(evalRow?.requirementsUnmet).toBe(true);
    expect(evalRow?.capTriggers).toEqual(['SCP-1', 'security']); // non-strings dropped
  });

  it('maps an empty / absent cap_triggers_json to null (not capped)', () => {
    seedRunEval(db, { runId: 'r1', capTriggersJson: JSON.stringify([]) });
    seedRunEval(db, { runId: 'r2' });
    expect(getRunEval(dbAdapter(db), 'r1')?.capTriggers).toBeNull();
    expect(getRunEval(dbAdapter(db), 'r2')?.capTriggers).toBeNull();
  });

  it('yields null JSON fields on malformed JSON rather than throwing', () => {
    seedRunEval(db, {
      runId: 'r1',
      dimensionsJson: '{ not json',
      diffStatsJson: '[not an object array', // parseJsonRecord → null
      subagentModelsJson: '{ broken',
    });
    const evalRow = getRunEval(dbAdapter(db), 'r1');
    expect(evalRow?.dimensions).toBeNull();
    expect(evalRow?.diffStats).toBeNull();
    expect(evalRow?.subagentModels).toBeNull();
  });

  it('prefers the first non-human_influenced snapshot when several rows exist', () => {
    // A later, human-influenced re-fire of the same run (different rubric_version)
    // must not win over the pristine pre-human snapshot.
    seedRunEval(db, {
      runId: 'r1',
      rubricVersion: '1.0',
      humanInfluenced: 1,
      snapshotAt: '2026-07-01T09:00:00.000Z',
      overallScore: 60,
    });
    seedRunEval(db, {
      runId: 'r1',
      rubricVersion: '1.1',
      humanInfluenced: 0,
      snapshotAt: '2026-07-01T10:00:00.000Z',
      overallScore: 85,
    });

    const evalRow = getRunEval(dbAdapter(db), 'r1');
    expect(evalRow?.rubricVersion).toBe('1.1');
    expect(evalRow?.humanInfluenced).toBe(false);
    expect(evalRow?.overallScore).toBe(85);
  });

  it('falls back to the earliest influenced row when every row is human_influenced', () => {
    seedRunEval(db, {
      runId: 'r1',
      rubricVersion: '1.1',
      humanInfluenced: 1,
      snapshotAt: '2026-07-01T11:00:00.000Z',
      overallScore: 70,
    });
    seedRunEval(db, {
      runId: 'r1',
      rubricVersion: '1.0',
      humanInfluenced: 1,
      snapshotAt: '2026-07-01T09:00:00.000Z',
      overallScore: 55,
    });

    const evalRow = getRunEval(dbAdapter(db), 'r1');
    expect(evalRow?.rubricVersion).toBe('1.0');
    expect(evalRow?.humanInfluenced).toBe(true);
    expect(evalRow?.overallScore).toBe(55);
  });

  it('carries null score/band while pending', () => {
    seedRunEval(db, {
      runId: 'r1',
      evalStatus: 'pending',
      overallScore: null,
      band: null,
    });
    const evalRow = getRunEval(dbAdapter(db), 'r1');
    expect(evalRow?.evalStatus).toBe('pending');
    expect(evalRow?.overallScore).toBeNull();
    expect(evalRow?.band).toBeNull();
  });
});
