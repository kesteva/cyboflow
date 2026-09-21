/**
 * Tests for `composeMonitorReviewQueueActions` (main/src/monitorReviewQueueComposition.ts)
 * — the monitor's `resolve_review_item` adapter, driven through the REAL
 * `ReviewItemRouter` over an in-memory DB (the reviewItems.test.ts fixture
 * shape), not a mocked chokepoint.
 *
 * TASK-222 (address-review): the inline index.ts adapter this module was
 * extracted from built its `applyReviewItemResolve` WITHOUT forwarding
 * `resolutionMeta`, and passed no `surface` — so a gate answered from the
 * monitor chat persisted no `resolvedOutcome` / `resolvedSurface` in
 * payload_json even though the tRPC path (buildResolveDeps) did. These pin:
 *
 *   1. an explicit outcome from the monitor lands in payload_json with the
 *      stable `monitor` surface id — for 'revise' AND 'approve';
 *   2. 'revise' is stored as the gate's resolution verbatim (the verdict the
 *      WorkflowController's parseGateVerdict turns into the expand-spec
 *      loopback), never downgraded to 'reject';
 *   3. a reject on a loopback gate still fires the attributable warn naming
 *      the monitor surface;
 *   4. an unknown run → `{ ok: false }` without touching the router.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { composeMonitorReviewQueueActions } from '../monitorReviewQueueComposition';
import { parseGateResolution } from '../../../shared/types/reviews';
import { dbAdapter } from '../orchestrator/__test_fixtures__/dbAdapter';
import { makeSpyLogger } from '../orchestrator/__test_fixtures__/loggerLikeSpy';
import { ReviewItemRouter } from '../orchestrator/reviewItemRouter';
import { TaskChangeRouter } from '../orchestrator/taskChangeRouter';
import { HumanStepManager } from '../orchestrator/humanStepManager';
import { QuestionRouter } from '../orchestrator/questionRouter';
import type { DatabaseLike } from '../orchestrator/types';

// ---------------------------------------------------------------------------
// Test DB — mirrors reviewItems.test.ts's buildDb (projects + the review-item
// migrations), enough for a gate-carrying run + review_items row.
// ---------------------------------------------------------------------------

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Proj', '/tmp/p1');

  const migDir = join(__dirname, '..', 'database', 'migrations');
  for (const file of [
    '006_cyboflow_schema.sql',
    '011_workflow_step_tracking.sql',
    '014_native_tasks.sql',
    '015_entity_model_rebuild.sql',
    '016_review_items.sql',
    '024_archive_in_place.sql',
    '028_idea_attachments.sql',
    '034_findings_triage.sql',
    '046_notification_kind.sql',
  ]) {
    db.exec(readFileSync(join(migDir, file), 'utf-8'));
  }
  db.exec(`ALTER TABLE workflow_runs ADD COLUMN session_id TEXT`);
  db.exec(readFileSync(join(migDir, '059_entity_category.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '085_review_item_audience.sql'), 'utf-8'));
  return db;
}

function buildHarness(): { db: Database.Database; adapter: DatabaseLike } {
  const db = buildDb();
  const adapter = dbAdapter(db);
  ReviewItemRouter.initialize(adapter);
  TaskChangeRouter.initialize(adapter);
  HumanStepManager.initialize(adapter);
  QuestionRouter.initialize(adapter);
  return { db, adapter };
}

afterEach(() => {
  vi.restoreAllMocks();
  ReviewItemRouter._resetForTesting();
  TaskChangeRouter._resetForTesting();
  HumanStepManager._resetForTesting();
  QuestionRouter._resetForTesting();
});

/**
 * Seed a parked run whose spec declares the planner's approve-design shape —
 * an OPTIONAL human step with an intra-phase `loopback` to expand-spec — plus
 * its pending blocking gate item (source `gate:human-step:approve-design`).
 */
function seedApproveDesignGate(db: Database.Database, runId: string): string {
  const specJson = JSON.stringify({
    id: 'planner',
    phases: [
      {
        id: 'refine',
        label: 'Refine',
        color: '#5a4ad6',
        steps: [
          { id: 'expand-spec', name: 'Expand spec', agent: 'context', mcps: [], retries: 0 },
          {
            id: 'approve-design',
            name: 'Approve design',
            agent: 'human',
            mcps: [],
            retries: 0,
            optional: true,
            human: true,
            loopback: 'expand-spec',
          },
        ],
      },
    ],
  });
  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-planner', 1, 'planner', ?)`,
  ).run(specJson);
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, worktree_path, branch_name, status, policy_json)
     VALUES (?, 'wf-planner', 1, '/w/lb', 'b/lb', 'awaiting_review', '{}')`,
  ).run(runId);
  const reviewItemId = `rvw_gate_${runId}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO review_items
       (id, project_id, run_id, entity_type, entity_id, kind, status, blocking,
        title, body, severity, source, payload_json, created_at, updated_at, resolved_by, resolution)
     VALUES (?, 1, ?, NULL, NULL, 'decision', 'pending', 1, 'Human gate: approve-design', NULL, NULL,
             'gate:human-step:approve-design', NULL, ?, ?, NULL, NULL)`,
  ).run(reviewItemId, runId, now, now);
  return reviewItemId;
}

function readItem(db: Database.Database, reviewItemId: string): {
  status: string;
  resolution: string | null;
  payload: { kind?: string; resolvedOutcome?: string; resolvedSurface?: string } | null;
} {
  const row = db
    .prepare('SELECT status, resolution, payload_json AS payloadJson FROM review_items WHERE id = ?')
    .get(reviewItemId) as { status: string; resolution: string | null; payloadJson: string | null };
  return {
    status: row.status,
    resolution: row.resolution,
    payload: row.payloadJson === null ? null : (JSON.parse(row.payloadJson) as Record<string, string>),
  };
}

describe('composeMonitorReviewQueueActions.resolveReviewItem (TASK-222 provenance through the real adapter)', () => {
  it("'revise' on approve-design is stored verbatim and stamps resolvedOutcome + resolvedSurface='monitor'", async () => {
    const { db, adapter } = buildHarness();
    const reviewItemId = seedApproveDesignGate(db, 'run-rev');
    const actions = composeMonitorReviewQueueActions({
      db: adapter,
      runProjectId: (runId) => (runId === 'run-rev' ? 1 : undefined),
      loggerLike: makeSpyLogger(),
    });

    const result = await actions.resolveReviewItem('run-rev', {
      reviewItemId,
      outcome: 'revise',
      resolution: 'the spend screen has no way back to Home',
    });

    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/^Sent back for revision on the review item/);
    const item = readItem(db, reviewItemId);
    expect(item.status).toBe('resolved');
    // The stored resolution is the anchored `<verdict>: <note>` grammar: the
    // verdict the controller reads is the prefix — a loopback, never a terminal
    // reject — and the human's note rides behind it for the re-run's
    // readGateResolutionNote instead of being discarded.
    expect(item.resolution).toBe('revise: the spend screen has no way back to Home');
    expect(parseGateResolution(item.resolution)).toEqual({
      verdict: 'revise',
      note: 'the spend screen has no way back to Home',
    });
    expect(item.payload).toMatchObject({
      kind: 'decision',
      resolvedOutcome: 'revise',
      resolvedSurface: 'monitor',
    });
  });

  it("'approve' stamps the same provenance (outcome + monitor surface)", async () => {
    const { db, adapter } = buildHarness();
    const reviewItemId = seedApproveDesignGate(db, 'run-ok');
    const actions = composeMonitorReviewQueueActions({
      db: adapter,
      runProjectId: () => 1,
      loggerLike: makeSpyLogger(),
    });

    const result = await actions.resolveReviewItem('run-ok', { reviewItemId, outcome: 'approve' });

    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/^Approved the review item/);
    const item = readItem(db, reviewItemId);
    expect(item.resolution).toBe('approve');
    expect(item.payload).toMatchObject({ resolvedOutcome: 'approve', resolvedSurface: 'monitor' });
  });

  it('a free-text resolve (no outcome) leaves payload_json untouched — provenance is stamped only for explicit verdicts', async () => {
    const { db, adapter } = buildHarness();
    const reviewItemId = seedApproveDesignGate(db, 'run-txt');
    const actions = composeMonitorReviewQueueActions({
      db: adapter,
      runProjectId: () => 1,
      loggerLike: makeSpyLogger(),
    });

    const result = await actions.resolveReviewItem('run-txt', { reviewItemId, resolution: 'looks fine' });

    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/^Resolved the review item/);
    const item = readItem(db, reviewItemId);
    expect(item.resolution).toBe('looks fine');
    expect(item.payload).toBeNull();
  });

  it("a 'reject' on the loopback gate is honored but fires the attributable warn naming surface=monitor", async () => {
    const { db, adapter } = buildHarness();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reviewItemId = seedApproveDesignGate(db, 'run-rej');
    const actions = composeMonitorReviewQueueActions({
      db: adapter,
      runProjectId: () => 1,
      loggerLike: makeSpyLogger(),
    });

    const result = await actions.resolveReviewItem('run-rej', { reviewItemId, outcome: 'reject' });

    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/^Rejected the review item/);
    const loopbackWarn = warn.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.includes("gate 'approve-design'") && m.includes('declares an optional loopback'));
    expect(loopbackWarn).toBeDefined();
    expect(loopbackWarn).toContain('surface=monitor');
    expect(readItem(db, reviewItemId).payload).toMatchObject({
      resolvedOutcome: 'reject',
      resolvedSurface: 'monitor',
    });
  });

  it('an unknown run refuses without reaching the router', async () => {
    const { db, adapter } = buildHarness();
    const reviewItemId = seedApproveDesignGate(db, 'run-x');
    const apply = vi.spyOn(ReviewItemRouter.prototype, 'applyReviewItem');
    const actions = composeMonitorReviewQueueActions({
      db: adapter,
      runProjectId: () => undefined,
      loggerLike: makeSpyLogger(),
    });

    const result = await actions.resolveReviewItem('run-x', { reviewItemId, outcome: 'approve' });

    expect(result).toEqual({ ok: false, message: 'Run not found.' });
    expect(apply).not.toHaveBeenCalled();
    expect(readItem(db, reviewItemId).status).toBe('pending');
  });
});
