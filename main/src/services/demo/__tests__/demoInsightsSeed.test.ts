/**
 * seedDemoInsightsHistory — verifies the fabricated history satisfies the real
 * Insights read paths: terminal backdated runs under the built-in workflows,
 * consistent run_usage rollups, raw_events that the daily-usage scan can
 * bucket, and chokepoint-created findings (some pre-triaged).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { seedDemoInsightsHistory } from '../demoInsightsSeed';
import { WorkflowRegistry } from '../../../orchestrator/workflowRegistry';
import { ReviewItemRouter } from '../../../orchestrator/reviewItemRouter';
import type { DatabaseLike } from '../../../orchestrator/types';
import {
  selectDailyModelUsage,
  selectWorkflowRunStats,
} from '../../../orchestrator/insightsQueries';

/** Minimal real schema for every table the seeder + insights queries touch. */
function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE workflows (
      id TEXT PRIMARY KEY,
      project_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      workflow_path TEXT,
      permission_mode TEXT NOT NULL DEFAULT 'default',
      spec_json TEXT NOT NULL DEFAULT '{}',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE workflow_runs (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      project_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      permission_mode_snapshot TEXT NOT NULL DEFAULT 'default',
      substrate TEXT NOT NULL DEFAULT 'sdk',
      outcome TEXT,
      spec_hash TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
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
    CREATE TABLE entity_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      kind TEXT NOT NULL,
      actor TEXT NOT NULL,
      run_id TEXT,
      changes_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (entity_type, entity_id, seq)
    );
    CREATE TABLE workflow_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id TEXT NOT NULL,
      spec_hash TEXT NOT NULL,
      spec_json TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (workflow_id, spec_hash)
    );
  `);
  return db;
}

describe('seedDemoInsightsHistory', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb();
    ReviewItemRouter.initialize(db as unknown as DatabaseLike);
  });

  afterEach(() => {
    ReviewItemRouter._resetForTesting();
    db.close();
  });

  async function seed(): Promise<void> {
    const registry = new WorkflowRegistry(db as unknown as DatabaseLike, {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    });
    await seedDemoInsightsHistory({ db, projectId: 1, workflowRegistry: registry });
  }

  it('creates terminal backdated runs under the built-in planner/sprint workflows', async () => {
    await seed();

    const runs = db
      .prepare(
        `SELECT workflow_id AS workflowId, status, outcome, started_at AS startedAt, ended_at AS endedAt
         FROM workflow_runs`,
      )
      .all() as Array<{ workflowId: string; status: string; outcome: string | null; startedAt: string; endedAt: string }>;

    expect(runs.length).toBeGreaterThan(8);
    for (const run of runs) {
      expect(['wf-1-planner', 'wf-1-sprint']).toContain(run.workflowId);
      expect(['completed', 'canceled', 'failed']).toContain(run.status);
      expect(run.startedAt < run.endedAt).toBe(true);
    }
    // The stats query groups these by workflow — both flows must show up.
    const stats = selectWorkflowRunStats(db, 1);
    const names = stats.filter((s) => s.totalRuns > 0).map((s) => s.workflowName).sort();
    expect(names).toEqual(['planner', 'sprint']);
  });

  it('writes a run_usage rollup consistent with each run\'s assistant events', async () => {
    await seed();

    const usageRows = db
      .prepare('SELECT run_id AS runId, input_tokens AS input, output_tokens AS output, assistant_message_count AS count FROM run_usage')
      .all() as Array<{ runId: string; input: number; output: number; count: number }>;
    const runCount = (db.prepare('SELECT COUNT(*) AS n FROM workflow_runs').get() as { n: number }).n;
    expect(usageRows.length).toBe(runCount);

    // Spot-check the first rollup against its raw assistant payloads.
    const sample = usageRows[0];
    const events = db
      .prepare(`SELECT payload_json AS payloadJson FROM raw_events WHERE run_id = ? AND event_type = 'assistant'`)
      .all(sample.runId) as Array<{ payloadJson: string }>;
    let input = 0;
    let output = 0;
    for (const e of events) {
      const usage = (JSON.parse(e.payloadJson) as { message: { usage: { input_tokens: number; output_tokens: number } } }).message.usage;
      input += usage.input_tokens;
      output += usage.output_tokens;
    }
    expect(events.length).toBe(sample.count);
    expect(input).toBe(sample.input);
    expect(output).toBe(sample.output);
  });

  it('produces raw_events the daily-usage scan buckets by (day, model)', async () => {
    await seed();

    const points = selectDailyModelUsage(db, 1, 30);
    expect(points.length).toBeGreaterThan(5);
    const models = new Set(points.map((p) => p.model));
    expect(models.has('claude-sonnet-4-6')).toBe(true);
    for (const p of points) {
      expect(p.totalTokens).toBe(p.inputTokens + p.outputTokens);
      expect(p.assistantMessageCount).toBeGreaterThan(0);
    }
    // Step transitions ride along for the step-token drill-down.
    const transitions = (db
      .prepare(`SELECT COUNT(*) AS n FROM raw_events WHERE event_type = 'step_transition'`)
      .get() as { n: number }).n;
    expect(transitions).toBeGreaterThan(0);
  });

  it('files the findings through the chokepoint with a pending/triaged mix', async () => {
    await seed();

    const findings = db
      .prepare(`SELECT status, run_id AS runId FROM review_items WHERE kind = 'finding'`)
      .all() as Array<{ status: string; runId: string | null }>;
    expect(findings.length).toBe(5);
    expect(findings.filter((f) => f.status === 'pending').length).toBe(2);
    expect(findings.filter((f) => f.status === 'resolved').length).toBe(2);
    expect(findings.filter((f) => f.status === 'dismissed').length).toBe(1);
    // Every finding is bound to a seeded run (the Insights join needs it).
    for (const f of findings) expect(f.runId).not.toBeNull();
  });

  it('is deterministic across two fresh databases', async () => {
    await seed();
    const first = db.prepare('SELECT SUM(total_tokens) AS t, COUNT(*) AS n FROM run_usage').get() as { t: number; n: number };

    ReviewItemRouter._resetForTesting();
    db.close();
    db = createDb();
    ReviewItemRouter.initialize(db as unknown as DatabaseLike);
    await seed();
    const second = db.prepare('SELECT SUM(total_tokens) AS t, COUNT(*) AS n FROM run_usage').get() as { t: number; n: number };

    expect(second).toEqual(first);
  });
});
