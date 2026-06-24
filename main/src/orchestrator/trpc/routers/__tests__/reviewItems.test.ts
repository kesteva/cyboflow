/**
 * Integration tests for the orchestrator tRPC reviewItems router (P2).
 *
 * Exercises the live reviewItemsRouter procedures via createCaller, using an
 * in-memory SQLite DB built from projects + migrations 006/011/014/015/016/024 (so
 * boards/board_stages/task_ref_counters/tasks/entity_events/review_items all
 * exist), the dbAdapter fixture, and the real ReviewItemRouter + TaskChangeRouter
 * singletons (reset between tests).
 *
 * Focus: the promote->chokepoint seam — promoteToTask mints a real task through
 * TaskChangeRouter.applyChange AND resolves the review item through
 * ReviewItemRouter, recording 'promoted:<taskId>'.
 *
 * Tests:
 *  1. list returns shaped ReviewItem[] filtered by status, newest-first.
 *  2. get returns the single item / null.
 *  3. resolve + dismiss transition status via the chokepoint.
 *  4. resolve of an unknown item -> NOT_FOUND.
 *  5. promoteToTask mints a TASK-001 (via TaskChangeRouter) AND resolves the item
 *     with resolution='promoted:<taskId>'.
 *  6. promoteToTask is rejected (BAD_REQUEST) when entity_id is already set.
 *  7. promoteToTask is rejected (NOT_FOUND) for an unknown item.
 */
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { TRPCError } from '@trpc/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appRouter } from '../../router';
import { createContext } from '../../context';
import { dbAdapter } from '../../../__test_fixtures__/dbAdapter';
import { ReviewItemRouter } from '../../../reviewItemRouter';
import { TaskChangeRouter } from '../../../taskChangeRouter';
import { HumanStepManager } from '../../../humanStepManager';
import type { DatabaseLike } from '../../../types';

// ---------------------------------------------------------------------------
// Test DB: projects + 006 + 011 + 014 + 015 + 016 + 024.
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

  const migDir = join(__dirname, '..', '..', '..', '..', 'database', 'migrations');
  db.exec(readFileSync(join(migDir, '006_cyboflow_schema.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '011_workflow_step_tracking.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '014_native_tasks.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '015_entity_model_rebuild.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '016_review_items.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '024_archive_in_place.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '028_idea_attachments.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '032_findings_triage.sql'), 'utf-8'));
  // workflow_runs.session_id (migration 019) — added directly here: 019's backfill
  // UPDATE reads a `sessions` table this minimal fixture doesn't create, so we add
  // just the column the requireMergedSession merge-gate join needs (mirrors the
  // workflowRegistry fixture's seed_finding_ids ALTER).
  db.exec(`ALTER TABLE workflow_runs ADD COLUMN session_id TEXT`);
  return db;
}

/**
 * Build a caller wired to a fresh DB with both chokepoint singletons initialized.
 * Returns the caller + the raw db so tests can assert DB state directly.
 */
function buildCaller(): {
  caller: ReturnType<typeof appRouter.createCaller>;
  db: Database.Database;
  adapter: DatabaseLike;
} {
  const db = buildDb();
  const adapter = dbAdapter(db);
  ReviewItemRouter.initialize(adapter);
  TaskChangeRouter.initialize(adapter);
  HumanStepManager.initialize(adapter);
  const caller = appRouter.createCaller(createContext({ db: adapter }));
  return { caller, db, adapter };
}

afterEach(() => {
  ReviewItemRouter._resetForTesting();
  TaskChangeRouter._resetForTesting();
  HumanStepManager._resetForTesting();
});

describe('cyboflow.reviewItems.list / get', () => {
  it('list returns shaped ReviewItem[] filtered by status, newest-first', async () => {
    const { caller } = buildCaller();

    const older = await caller.cyboflow.reviewItems.list({ projectId: 1 }); // empty
    expect(older).toEqual([]);

    // Create two pending findings + one resolved.
    const a = await ReviewItemRouter.getInstance().applyReviewItem(1, {
      op: 'create',
      actor: 'agent:executor',
      kind: 'finding',
      title: 'first',
    });
    const b = await ReviewItemRouter.getInstance().applyReviewItem(1, {
      op: 'create',
      actor: 'agent:executor',
      kind: 'permission',
      title: 'second',
      blocking: true,
    });
    await ReviewItemRouter.getInstance().applyReviewItem(1, { op: 'resolve', actor: 'user', reviewItemId: a.reviewItemId });

    const pending = await caller.cyboflow.reviewItems.list({ projectId: 1, status: 'pending' });
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(b.reviewItemId);
    expect(pending[0].kind).toBe('permission');
    expect(pending[0].blocking).toBe(true); // BOOLEAN normalized

    const all = await caller.cyboflow.reviewItems.list({ projectId: 1 });
    expect(all).toHaveLength(2);

    const blocking = await caller.cyboflow.reviewItems.list({ projectId: 1, blocking: true });
    expect(blocking.map((i) => i.id)).toEqual([b.reviewItemId]);
  });

  it('excludes pending items whose bound run is terminal; keeps live-run and unbound items', async () => {
    const { caller, db } = buildCaller();

    // Parent workflow row (FK: workflow_runs.workflow_id → workflows.id).
    db.prepare(`INSERT INTO workflows (id, project_id, name) VALUES ('wf-1-planner', 1, 'planner')`).run();

    // Two runs: one terminal (canceled), one live (running).
    const insertRun = db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, worktree_path, branch_name, status, policy_json)
       VALUES (?, ?, 1, ?, ?, ?, '{}')`,
    );
    insertRun.run('run-dead', 'wf-1-planner', '/w/dead', 'b/dead', 'canceled');
    insertRun.run('run-live', 'wf-1-planner', '/w/live', 'b/live', 'running');

    // Pending blocking gates: one on the dead run (orphaned), one on the live run.
    const dead = await ReviewItemRouter.getInstance().applyReviewItem(1, {
      op: 'create', actor: 'agent:planner', kind: 'permission', title: 'gate on dead run', blocking: true, runId: 'run-dead',
    });
    const live = await ReviewItemRouter.getInstance().applyReviewItem(1, {
      op: 'create', actor: 'agent:planner', kind: 'permission', title: 'gate on live run', blocking: true, runId: 'run-live',
    });
    const unbound = await ReviewItemRouter.getInstance().applyReviewItem(1, {
      op: 'create', actor: 'agent:executor', kind: 'finding', title: 'no run binding',
    });

    const pending = await caller.cyboflow.reviewItems.list({ projectId: 1, status: 'pending' });
    const ids = pending.map((i) => i.id);
    expect(ids).toContain(live.reviewItemId);
    expect(ids).toContain(unbound.reviewItemId);
    expect(ids).not.toContain(dead.reviewItemId); // orphaned on a terminal run → hidden

    // The blocking filter must also drop the dead-run item (drives blockingCount).
    const blocking = await caller.cyboflow.reviewItems.list({ projectId: 1, blocking: true });
    expect(blocking.map((i) => i.id)).toEqual([live.reviewItemId]);
  });

  it('surfaces finding-scoped priority/staged_at/selected on shaped items', async () => {
    const { caller, db } = buildCaller();

    const created = await ReviewItemRouter.getInstance().applyReviewItem(1, {
      op: 'create',
      actor: 'agent:executor',
      kind: 'finding',
      title: 'has triage columns',
    });

    // Fresh finding: priority NULL, staged_at NULL (untriaged), selected false.
    const fresh = await caller.cyboflow.reviewItems.list({ projectId: 1, kind: 'finding', status: 'pending' });
    expect(fresh).toHaveLength(1);
    expect(fresh[0].priority).toBeNull();
    expect(fresh[0].staged_at).toBeNull();
    expect(fresh[0].selected).toBe(false);

    // Drive the columns directly (set-priority + stage + select) and re-read.
    await caller.cyboflow.reviewItems.setPriority({ projectId: 1, reviewItemId: created.reviewItemId, priority: 'P0' });
    await caller.cyboflow.reviewItems.approve({ projectId: 1, reviewItemId: created.reviewItemId });

    const staged = await caller.cyboflow.reviewItems.list({ projectId: 1, kind: 'finding', status: 'pending' });
    expect(staged).toHaveLength(1);
    expect(staged[0].priority).toBe('P0');
    expect(staged[0].staged_at).not.toBeNull(); // approve set CURRENT_TIMESTAMP
    expect(staged[0].selected).toBe(true); // approve pre-selects

    // shapeRow normalizes the raw 0/1 INTEGER to a boolean.
    const raw = db.prepare('SELECT selected FROM review_items WHERE id = ?').get(created.reviewItemId) as {
      selected: number;
    };
    expect(raw.selected).toBe(1);
  });

  it('keeps a STAGED finding after its run goes terminal, hides an UNTRIAGED one', async () => {
    const { caller, db } = buildCaller();

    db.prepare(`INSERT INTO workflows (id, project_id, name) VALUES ('wf-1-compound', 1, 'compound')`).run();
    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, worktree_path, branch_name, status, policy_json)
       VALUES ('run-done', 'wf-1-compound', 1, '/w/done', 'b/done', 'completed', '{}')`,
    ).run();

    // Two findings on the SAME terminal run: one staged (kept), one untriaged (hidden).
    const staged = await ReviewItemRouter.getInstance().applyReviewItem(1, {
      op: 'create', actor: 'agent:executor', kind: 'finding', title: 'staged on done run', runId: 'run-done',
    });
    const untriaged = await ReviewItemRouter.getInstance().applyReviewItem(1, {
      op: 'create', actor: 'agent:executor', kind: 'finding', title: 'untriaged on done run', runId: 'run-done',
    });

    // Stage one of them (untriaged-only approve before the run is read again).
    await caller.cyboflow.reviewItems.approve({ projectId: 1, reviewItemId: staged.reviewItemId });

    const pending = await caller.cyboflow.reviewItems.list({ projectId: 1, kind: 'finding', status: 'pending' });
    const ids = pending.map((i) => i.id);
    expect(ids).toContain(staged.reviewItemId); // staged_at set => human keep signal survives terminal run
    expect(ids).not.toContain(untriaged.reviewItemId); // untriaged on a dead run stays hidden
  });

  it('requireMergedSession surfaces a finding from a MERGED session, hides an unmerged one', async () => {
    const { caller, db } = buildCaller();

    db.prepare(`INSERT INTO workflows (id, project_id, name) VALUES ('wf-1-sprint', 1, 'sprint')`).run();
    // A MERGED session: its run carries outcome='merged' even though its status reads
    // 'canceled' after worktree teardown (the real-world shape). And an unmerged one.
    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, worktree_path, branch_name, status, outcome, session_id, policy_json)
       VALUES ('run-merged', 'wf-1-sprint', 1, '/w/m', 'b/m', 'canceled', 'merged', 'sess-merged', '{}')`,
    ).run();
    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, worktree_path, branch_name, status, outcome, session_id, policy_json)
       VALUES ('run-failed', 'wf-1-sprint', 1, '/w/f', 'b/f', 'failed', 'failed', 'sess-failed', '{}')`,
    ).run();

    const merged = await ReviewItemRouter.getInstance().applyReviewItem(1, {
      op: 'create', actor: 'agent:executor', kind: 'finding', title: 'from merged session', runId: 'run-merged',
    });
    const unmerged = await ReviewItemRouter.getInstance().applyReviewItem(1, {
      op: 'create', actor: 'agent:executor', kind: 'finding', title: 'from failed session', runId: 'run-failed',
    });

    // Default (no flag): BOTH hidden — their runs are terminal (orphan-hide).
    const orphan = await caller.cyboflow.reviewItems.list({ projectId: 1, kind: 'finding', status: 'pending' });
    const orphanIds = orphan.map((i) => i.id);
    expect(orphanIds).not.toContain(merged.reviewItemId);
    expect(orphanIds).not.toContain(unmerged.reviewItemId);

    // requireMergedSession: the merged-session finding surfaces; the unmerged stays hidden.
    const mergedOnly = await caller.cyboflow.reviewItems.list({
      projectId: 1, kind: 'finding', status: 'pending', requireMergedSession: true,
    });
    const ids = mergedOnly.map((i) => i.id);
    expect(ids).toContain(merged.reviewItemId);
    expect(ids).not.toContain(unmerged.reviewItemId);
  });

  it('requireMergedSession keeps the gate orphan-hide intact (a gate on a terminal run stays hidden)', async () => {
    const { caller, db } = buildCaller();

    db.prepare(`INSERT INTO workflows (id, project_id, name) VALUES ('wf-1-sprint', 1, 'sprint')`).run();
    // A MERGED run hosting BOTH a finding (surfaces) and a decision gate (a gate
    // needs a live run to resume, so it stays hidden even on a merged session).
    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, worktree_path, branch_name, status, outcome, session_id, policy_json)
       VALUES ('run-merged', 'wf-1-sprint', 1, '/w/m', 'b/m', 'canceled', 'merged', 'sess-merged', '{}')`,
    ).run();

    const finding = await ReviewItemRouter.getInstance().applyReviewItem(1, {
      op: 'create', actor: 'agent:executor', kind: 'finding', title: 'finding on merged run', runId: 'run-merged',
    });
    const gate = await ReviewItemRouter.getInstance().applyReviewItem(1, {
      op: 'create', actor: 'agent:executor', kind: 'decision', title: 'decision on merged run', runId: 'run-merged',
    });

    const items = await caller.cyboflow.reviewItems.list({
      projectId: 1, status: 'pending', requireMergedSession: true,
    });
    const ids = items.map((i) => i.id);
    expect(ids).toContain(finding.reviewItemId); // finding from merged session surfaces
    expect(ids).not.toContain(gate.reviewItemId); // gate on a terminal run stays orphan-hidden
  });

  it('get returns the single item, or null when absent', async () => {
    const { caller } = buildCaller();
    const created = await ReviewItemRouter.getInstance().applyReviewItem(1, {
      op: 'create',
      actor: 'user',
      kind: 'human_task',
      title: 'do the thing',
    });
    const got = await caller.cyboflow.reviewItems.get({ reviewItemId: created.reviewItemId });
    expect(got?.id).toBe(created.reviewItemId);
    expect(got?.kind).toBe('human_task');

    const missing = await caller.cyboflow.reviewItems.get({ reviewItemId: 'rvw_missing' });
    expect(missing).toBeNull();
  });
});

describe('cyboflow.reviewItems.resolve / dismiss', () => {
  it('resolve transitions status to resolved via the chokepoint', async () => {
    const { caller, db } = buildCaller();
    const created = await ReviewItemRouter.getInstance().applyReviewItem(1, {
      op: 'create',
      actor: 'agent:executor',
      kind: 'finding',
      title: 'T',
    });
    const res = await caller.cyboflow.reviewItems.resolve({
      projectId: 1,
      reviewItemId: created.reviewItemId,
      resolution: 'done',
    });
    // P4: resolve now returns a `resumed` flag (false for a non-blocking,
    // non-run-bound finding — there is no run to auto-resume).
    expect(res).toEqual({ reviewItemId: created.reviewItemId, resumed: false });
    const row = db.prepare('SELECT status, resolution FROM review_items WHERE id = ?').get(created.reviewItemId) as {
      status: string;
      resolution: string;
    };
    expect(row.status).toBe('resolved');
    expect(row.resolution).toBe('done');
  });

  it('dismiss transitions status to dismissed', async () => {
    const { caller, db } = buildCaller();
    const created = await ReviewItemRouter.getInstance().applyReviewItem(1, {
      op: 'create',
      actor: 'user',
      kind: 'finding',
      title: 'cruft',
    });
    await caller.cyboflow.reviewItems.dismiss({ projectId: 1, reviewItemId: created.reviewItemId });
    const row = db.prepare('SELECT status FROM review_items WHERE id = ?').get(created.reviewItemId) as { status: string };
    expect(row.status).toBe('dismissed');
  });

  it('resolve of an unknown item throws TRPCError NOT_FOUND', async () => {
    const { caller } = buildCaller();
    await expect(
      caller.cyboflow.reviewItems.resolve({ projectId: 1, reviewItemId: 'rvw_nope' }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'NOT_FOUND');
  });

  it('re-resolving a terminal item throws TRPCError CONFLICT (invalid_status)', async () => {
    const { caller } = buildCaller();
    const created = await ReviewItemRouter.getInstance().applyReviewItem(1, {
      op: 'create',
      actor: 'user',
      kind: 'finding',
      title: 'T',
    });
    await caller.cyboflow.reviewItems.resolve({ projectId: 1, reviewItemId: created.reviewItemId });
    await expect(
      caller.cyboflow.reviewItems.resolve({ projectId: 1, reviewItemId: created.reviewItemId }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'CONFLICT');
  });
});

describe('cyboflow.reviewItems findings-triage mutations', () => {
  it('setTag forwards op=mutate / actor=user and re-tags the finding payload', async () => {
    const { caller, db } = buildCaller();
    const created = await ReviewItemRouter.getInstance().applyReviewItem(1, {
      op: 'create', actor: 'agent:executor', kind: 'finding', title: 'tag me',
    });

    const res = await caller.cyboflow.reviewItems.setTag({
      projectId: 1, reviewItemId: created.reviewItemId, proposedTarget: 'fix',
    });
    expect(res).toEqual({ reviewItemId: created.reviewItemId });

    const row = db.prepare('SELECT payload_json FROM review_items WHERE id = ?').get(created.reviewItemId) as {
      payload_json: string | null;
    };
    const payload = JSON.parse(row.payload_json ?? '{}') as { proposedTarget?: string };
    expect(payload.proposedTarget).toBe('fix');

    // entity_events records the mutate as actor='user' on the chokepoint.
    const actor = db
      .prepare(
        `SELECT actor FROM entity_events WHERE entity_type = 'review_item' AND entity_id = ?
          ORDER BY seq DESC LIMIT 1`,
      )
      .get(created.reviewItemId) as { actor: string };
    expect(actor.actor).toBe('user');
  });

  it('setPriority forwards op=mutate / actor=user and sets the priority column', async () => {
    const { caller, db } = buildCaller();
    const created = await ReviewItemRouter.getInstance().applyReviewItem(1, {
      op: 'create', actor: 'agent:executor', kind: 'finding', title: 'prioritize me',
    });

    const res = await caller.cyboflow.reviewItems.setPriority({
      projectId: 1, reviewItemId: created.reviewItemId, priority: 'P1',
    });
    expect(res).toEqual({ reviewItemId: created.reviewItemId });

    const row = db.prepare('SELECT priority FROM review_items WHERE id = ?').get(created.reviewItemId) as {
      priority: string | null;
    };
    expect(row.priority).toBe('P1');
  });

  it('approve returns {reviewItemId, staged:true} and stages + pre-selects the finding', async () => {
    const { caller, db } = buildCaller();
    const created = await ReviewItemRouter.getInstance().applyReviewItem(1, {
      op: 'create', actor: 'agent:executor', kind: 'finding', title: 'approve me',
    });

    const res = await caller.cyboflow.reviewItems.approve({ projectId: 1, reviewItemId: created.reviewItemId });
    expect(res).toEqual({ reviewItemId: created.reviewItemId, staged: true });

    const row = db.prepare('SELECT status, staged_at, selected FROM review_items WHERE id = ?').get(
      created.reviewItemId,
    ) as { status: string; staged_at: string | null; selected: number };
    expect(row.status).toBe('pending'); // status NOT overloaded
    expect(row.staged_at).not.toBeNull();
    expect(row.selected).toBe(1);
  });

  it('approve on an already-staged finding throws CONFLICT (invalid_status)', async () => {
    const { caller } = buildCaller();
    const created = await ReviewItemRouter.getInstance().applyReviewItem(1, {
      op: 'create', actor: 'agent:executor', kind: 'finding', title: 'approve twice',
    });
    await caller.cyboflow.reviewItems.approve({ projectId: 1, reviewItemId: created.reviewItemId });
    await expect(
      caller.cyboflow.reviewItems.approve({ projectId: 1, reviewItemId: created.reviewItemId }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'CONFLICT');
  });

  it('setTag on an unknown item maps to NOT_FOUND', async () => {
    const { caller } = buildCaller();
    await expect(
      caller.cyboflow.reviewItems.setTag({ projectId: 1, reviewItemId: 'rvw_nope', proposedTarget: 'docs' }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'NOT_FOUND');
  });

  it('setSelected batch-toggles selected over staged findings and returns the count', async () => {
    const { caller, db } = buildCaller();
    const a = await ReviewItemRouter.getInstance().applyReviewItem(1, {
      op: 'create', actor: 'agent:executor', kind: 'finding', title: 'a',
    });
    const b = await ReviewItemRouter.getInstance().applyReviewItem(1, {
      op: 'create', actor: 'agent:executor', kind: 'finding', title: 'b',
    });
    // Stage both (approve pre-selects selected=1).
    await caller.cyboflow.reviewItems.approve({ projectId: 1, reviewItemId: a.reviewItemId });
    await caller.cyboflow.reviewItems.approve({ projectId: 1, reviewItemId: b.reviewItemId });

    // Deselect both in one batch.
    const res = await caller.cyboflow.reviewItems.setSelected({
      projectId: 1, reviewItemIds: [a.reviewItemId, b.reviewItemId], selected: false,
    });
    expect(res).toEqual({ count: 2 });

    const rows = db
      .prepare('SELECT id, selected, staged_at FROM review_items WHERE id IN (?, ?)')
      .all(a.reviewItemId, b.reviewItemId) as Array<{ id: string; selected: number; staged_at: string | null }>;
    for (const r of rows) {
      expect(r.selected).toBe(0); // cleared
      expect(r.staged_at).not.toBeNull(); // stays in READY
    }
  });

  it('setSelected rejects an empty id array at the Zod boundary (.min(1))', async () => {
    const { caller } = buildCaller();
    await expect(
      caller.cyboflow.reviewItems.setSelected({ projectId: 1, reviewItemIds: [], selected: true }),
    ).rejects.toThrow();
  });
});

describe('cyboflow.reviewItems open-question guard (regression)', () => {
  it('still blocks resolving a decision item with an open question (CONFLICT)', async () => {
    const { caller, db } = buildCaller();

    // The guard reads the `questions` table (migration 010); create a minimal one
    // here so the regression path is exercised without perturbing the shared chain.
    db.exec(`
      CREATE TABLE IF NOT EXISTS questions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
      );
    `);
    db.prepare(`INSERT INTO workflows (id, project_id, name) VALUES ('wf-1-planner', 1, 'planner')`).run();
    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, worktree_path, branch_name, status, policy_json)
       VALUES ('run-q', 'wf-1-planner', 1, '/w/q', 'b/q', 'awaiting_review', '{}')`,
    ).run();
    db.prepare(`INSERT INTO questions (id, run_id, status) VALUES ('q1', 'run-q', 'pending')`).run();

    // A question-sourced decision item bound to that run.
    const created = await ReviewItemRouter.getInstance().applyReviewItem(1, {
      op: 'create', actor: 'agent:planner', kind: 'decision', title: 'pick a path', source: 'question', runId: 'run-q',
    });

    await expect(
      caller.cyboflow.reviewItems.resolve({ projectId: 1, reviewItemId: created.reviewItemId }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'CONFLICT');
  });
});

describe('cyboflow.reviewItems.promoteToTask (two-chokepoint seam)', () => {
  it('mints a real task via TaskChangeRouter AND resolves the item with promoted:<taskId>', async () => {
    const { caller, db } = buildCaller();

    // A human_task finding (no entity link) is a promotion candidate.
    const created = await ReviewItemRouter.getInstance().applyReviewItem(1, {
      op: 'create',
      actor: 'agent:executor',
      kind: 'human_task',
      title: 'Refactor the parser',
      body: '## Notes\nsplit the lexer',
    });

    const result = await caller.cyboflow.reviewItems.promoteToTask({
      projectId: 1,
      reviewItemId: created.reviewItemId,
    });

    expect(result.reviewItemId).toBe(created.reviewItemId);
    expect(result.taskId.startsWith('tsk_')).toBe(true);

    // The task was minted through the chokepoint (real TASK ref + body carried over).
    const task = db.prepare('SELECT ref, title, body FROM tasks WHERE id = ?').get(result.taskId) as {
      ref: string;
      title: string;
      body: string | null;
    };
    expect(task.ref).toBe('TASK-001');
    expect(task.title).toBe('Refactor the parser');
    expect(task.body).toBe('## Notes\nsplit the lexer');

    // The review item is resolved with the audit-trail link.
    const item = db.prepare('SELECT status, resolution FROM review_items WHERE id = ?').get(created.reviewItemId) as {
      status: string;
      resolution: string;
    };
    expect(item.status).toBe('resolved');
    expect(item.resolution).toBe(`promoted:${result.taskId}`);

    // The task carries a 'created' entity_events row from the TaskChangeRouter chokepoint.
    const taskEvents = (
      db
        .prepare("SELECT COUNT(*) AS n FROM entity_events WHERE entity_type = 'task' AND entity_id = ?")
        .get(result.taskId) as { n: number }
    ).n;
    expect(taskEvents).toBe(1);
  });

  it('honors title/body/priority overrides on the minted task', async () => {
    const { caller, db } = buildCaller();
    const created = await ReviewItemRouter.getInstance().applyReviewItem(1, {
      op: 'create',
      actor: 'user',
      kind: 'finding',
      title: 'orig title',
    });
    const { taskId } = await caller.cyboflow.reviewItems.promoteToTask({
      projectId: 1,
      reviewItemId: created.reviewItemId,
      title: 'override title',
      body: 'override body',
      priority: 'P0',
    });
    const task = db.prepare('SELECT title, body, priority FROM tasks WHERE id = ?').get(taskId) as {
      title: string;
      body: string | null;
      priority: string;
    };
    expect(task.title).toBe('override title');
    expect(task.body).toBe('override body');
    expect(task.priority).toBe('P0');
  });

  it('rejects promotion (BAD_REQUEST) when the item is already linked to an entity', async () => {
    const { caller, db } = buildCaller();
    const created = await ReviewItemRouter.getInstance().applyReviewItem(1, {
      op: 'create',
      actor: 'user',
      kind: 'finding',
      title: 'About a task',
      entityType: 'task',
      entityId: 'tsk_existing',
    });
    await expect(
      caller.cyboflow.reviewItems.promoteToTask({ projectId: 1, reviewItemId: created.reviewItemId }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST');

    // No task was minted and the item is still pending.
    const taskCount = (db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n;
    expect(taskCount).toBe(0);
    const item = db.prepare('SELECT status FROM review_items WHERE id = ?').get(created.reviewItemId) as {
      status: string;
    };
    expect(item.status).toBe('pending');
  });

  it('rejects promotion (NOT_FOUND) for an unknown item', async () => {
    const { caller } = buildCaller();
    await expect(
      caller.cyboflow.reviewItems.promoteToTask({ projectId: 1, reviewItemId: 'rvw_nope' }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'NOT_FOUND');
  });

  it('rejects promotion (CONFLICT) when the item is already terminal', async () => {
    const { caller } = buildCaller();
    const created = await ReviewItemRouter.getInstance().applyReviewItem(1, {
      op: 'create',
      actor: 'user',
      kind: 'finding',
      title: 'T',
    });
    await caller.cyboflow.reviewItems.dismiss({ projectId: 1, reviewItemId: created.reviewItemId });
    await expect(
      caller.cyboflow.reviewItems.promoteToTask({ projectId: 1, reviewItemId: created.reviewItemId }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'CONFLICT');
  });
});
