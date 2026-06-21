/**
 * INTEGRATION smoke for the programmatic execution model — the seams the unit
 * tests fake out, exercised against REAL collaborators on a migration-backed
 * in-memory DB:
 *
 *   DefaultProgrammaticRunner → WorkflowController (real planner DAG via
 *   resolveWorkflowDefinition) → ProgrammaticRunHost → ReviewQueueHumanGate over
 *   the REAL HumanStepManager + REAL reviewItemChangeEvents, with the live
 *   timeline written by the REAL buildStepTransitionEvent.
 *
 * Only the SDK boundary is faked: the spawner resolves each step cleanly (no
 * Claude / Electron). A background subscriber plays the human, resolving each
 * blocking decision review_item as it is opened — so the full open→await→resolve
 * gate round-trip runs end to end. This is the headless stand-in for a live
 * `pnpm dev` programmatic run; it validates:
 *   - the planner's `context` step (agent + human:true) runs its AGENT then opens
 *     a gate (the agent-then-gate fix), and pure gates open without a spawn;
 *   - the gate's free-text resolution round-trips into approve/reject/revise;
 *   - cancellation mid-gate settles the walk to 'canceled' and removes the
 *     reviewItemChangeEvents listener (no hang, no leak).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DefaultProgrammaticRunner } from '../defaultProgrammaticRunner';
import { ReviewQueueHumanGate } from '../humanGate';
import { ReviewQueueSupervisor } from '../supervisor';
import { SdkSupervisorSession } from '../sdkSupervisor';
import type { StepReporter } from '../programmaticRunHost';
import { HumanStepManager } from '../../humanStepManager';
import { reviewItemChangeEvents, reviewItemProjectChannel } from '../../reviewItemRouter';
import { buildStepTransitionEvent } from '../../stepTransitionBridge';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import type { ClaudeSpawnerLike, ClaudeSpawnerOptions, ProgrammaticRunContext } from '../../runExecutor';
import type { WorkflowRow, WorkflowRunRow } from '../../../../../shared/types/workflows';

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
  const migDir = join(__dirname, '..', '..', '..', 'database', 'migrations');
  db.exec(readFileSync(join(migDir, '006_cyboflow_schema.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '011_workflow_step_tracking.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '014_native_tasks.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '015_entity_model_rebuild.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '016_review_items.sql'), 'utf-8'));
  // Built-in planner workflow row (spec_json '{}' → resolves to the built-in DAG).
  db.prepare(
    `INSERT INTO workflows (id, project_id, name, spec_json) VALUES ('wf-planner', 1, 'planner', '{}')`,
  ).run();
  return db;
}

function seedRun(db: Database.Database, runId: string): void {
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, worktree_path, permission_mode_snapshot)
     VALUES (?, 'wf-planner', 1, 'running', '/wt', 'auto')`,
  ).run(runId);
}

function ctxFor(runId: string): ProgrammaticRunContext {
  const workflow: WorkflowRow = {
    id: 'wf-planner',
    project_id: 1,
    name: 'planner',
    workflow_path: null,
    permission_mode: 'default',
    spec_json: '{}',
    created_at: 'now',
  };
  const run: WorkflowRunRow = {
    id: runId,
    workflow_id: 'wf-planner',
    project_id: 1,
    status: 'running',
    permission_mode_snapshot: 'auto',
    worktree_path: '/wt',
    branch_name: null,
    created_at: 'now',
    updated_at: 'now',
  };
  return {
    runId,
    panelId: runId,
    sessionId: runId,
    worktreePath: '/wt',
    run,
    workflow,
    signal: new AbortController().signal,
  };
}

function makeSpawner(): ClaudeSpawnerLike & { calls: ClaudeSpawnerOptions[] } {
  const calls: ClaudeSpawnerOptions[] = [];
  return {
    calls,
    spawnCliProcess: vi.fn(async (o: ClaudeSpawnerOptions) => {
      calls.push(o);
    }),
    abort: vi.fn().mockResolvedValue(undefined),
  };
}

function reviewRows(db: Database.Database, runId: string): Array<{ status: string; source: string; resolution: string | null }> {
  return db
    .prepare('SELECT status, source, resolution FROM review_items WHERE run_id = ? ORDER BY created_at ASC, id ASC')
    .all(runId) as Array<{ status: string; source: string; resolution: string | null }>;
}

afterEach(() => {
  HumanStepManager._resetForTesting();
  reviewItemChangeEvents.removeAllListeners();
});

describe('programmatic integration — real runner + controller + gate + DB', () => {
  it('walks the full planner DAG to completed, auto-approving every human gate', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    const mgr = HumanStepManager.initialize(adapter);
    seedRun(db, 'run-int');

    const spawner = makeSpawner();
    const reporter: StepReporter = {
      report: (rid, sid, status) => void buildStepTransitionEvent(rid, sid, status, adapter),
    };
    const gate = new ReviewQueueHumanGate(mgr, reviewItemChangeEvents, reviewItemProjectChannel);

    // Background "human": approve each blocking decision item as it is opened.
    // Deferred to a later macrotask (as a real human always is — the item must be
    // created + rendered before anyone can click), so the resolver's targetId is
    // set before the 'resolved' event fires.
    const approver = (payload: unknown): void => {
      const p = payload as { reviewItemId?: string; action?: string };
      if (p?.action === 'created' && p.reviewItemId) {
        const id = p.reviewItemId;
        setTimeout(() => void mgr.resolveHumanGate('run-int', id, 'user', 'approve'), 0);
      }
    };
    reviewItemChangeEvents.on(reviewItemProjectChannel(1), approver);

    const runner = new DefaultProgrammaticRunner({ spawner, reporter, gate });
    await expect(runner.run(ctxFor('run-int'))).resolves.toBeUndefined();

    // Every AGENT step ran exactly once via the spawn surface (context, research,
    // epics, tasks) — pure gates (approve-idea/approve-plan/decompose) did NOT spawn.
    const stepPrompts = spawner.calls.map((c) => c.prompt);
    expect(spawner.calls).toHaveLength(4);
    expect(stepPrompts.some((p) => p.includes('`context`'))).toBe(true); // agent-then-gate: agent DID run
    expect(stepPrompts.some((p) => p.includes('`epics`'))).toBe(true);
    expect(stepPrompts.some((p) => p.includes('`tasks`'))).toBe(true);

    // All four human gates were opened AND resolved (context's trailing gate +
    // approve-idea + approve-plan + decompose).
    const rows = reviewRows(db, 'run-int');
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.status === 'resolved')).toBe(true);
    expect(rows.every((r) => r.source.startsWith('gate:human-step:'))).toBe(true);

    // current_step_id advanced to the terminal step (the live timeline was written).
    const finalStep = db.prepare('SELECT current_step_id FROM workflow_runs WHERE id = ?').get('run-int') as {
      current_step_id: string | null;
    };
    expect(finalStep.current_step_id).toBe('decompose');
  });

  it('ends the run rejected when the human rejects a gate (resolution carries "reject")', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    const mgr = HumanStepManager.initialize(adapter);
    seedRun(db, 'run-rej');

    const spawner = makeSpawner();
    const reporter: StepReporter = { report: (rid, sid, s) => void buildStepTransitionEvent(rid, sid, s, adapter) };
    const gate = new ReviewQueueHumanGate(mgr, reviewItemChangeEvents, reviewItemProjectChannel);

    // The human approves the context gate but REJECTS the next (approve-idea).
    let seen = 0;
    const responder = (payload: unknown): void => {
      const p = payload as { reviewItemId?: string; action?: string };
      if (p?.action === 'created' && p.reviewItemId) {
        seen += 1;
        const verdict = seen === 1 ? 'approve' : 'reject — out of scope';
        const id = p.reviewItemId;
        setTimeout(() => void mgr.resolveHumanGate('run-rej', id, 'user', verdict), 0);
      }
    };
    reviewItemChangeEvents.on(reviewItemProjectChannel(1), responder);

    const runner = new DefaultProgrammaticRunner({ spawner, reporter, gate });
    // A rejected gate is a terminal HUMAN decision — the runner RESOLVES (does not throw).
    await expect(runner.run(ctxFor('run-rej'))).resolves.toBeUndefined();

    // The run did not reach the refine phase (epics never spawned).
    expect(spawner.calls.some((c) => c.prompt.includes('`epics`'))).toBe(false);
  });

  it('Stage 3: a failed step is escalated to the human review queue, approved (skipped), and the run continues', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    const mgr = HumanStepManager.initialize(adapter);
    seedRun(db, 'run-esc');

    // The 'context' agent FAILS; every other spawn succeeds.
    let contextFailed = false;
    const spawner: ClaudeSpawnerLike & { calls: ClaudeSpawnerOptions[] } = {
      calls: [],
      spawnCliProcess: vi.fn(async (o: ClaudeSpawnerOptions) => {
        spawner.calls.push(o);
        if (o.prompt.includes('`context`') && !contextFailed) {
          contextFailed = true;
          throw new Error('context step blew up');
        }
      }),
      abort: vi.fn().mockResolvedValue(undefined),
    };
    const reporter: StepReporter = { report: (rid, sid, s) => void buildStepTransitionEvent(rid, sid, s, adapter) };
    const gate = new ReviewQueueHumanGate(mgr, reviewItemChangeEvents, reviewItemProjectChannel);

    // The human approves every gate, INCLUDING the escalation gate for the failed
    // context step (approve = accept the failure, skip the step, advance).
    const approver = (payload: unknown): void => {
      const p = payload as { reviewItemId?: string; action?: string };
      if (p?.action === 'created' && p.reviewItemId) {
        const id = p.reviewItemId;
        setTimeout(() => void mgr.resolveHumanGate('run-esc', id, 'user', 'approve'), 0);
      }
    };
    reviewItemChangeEvents.on(reviewItemProjectChannel(1), approver);

    const runner = new DefaultProgrammaticRunner({
      spawner,
      reporter,
      gate,
      supervisorFactory: () => new ReviewQueueSupervisor(),
    });
    await expect(runner.run(ctxFor('run-esc'))).resolves.toBeUndefined();

    // The context agent was attempted and failed; the run still completed (the
    // failure was escalated to the human queue and approved → skipped → advanced).
    expect(contextFailed).toBe(true);
    expect(spawner.calls.some((c) => c.prompt.includes('`epics`'))).toBe(true); // reached refine phase
    const finalStep = db.prepare('SELECT current_step_id FROM workflow_runs WHERE id = ?').get('run-esc') as {
      current_step_id: string | null;
    };
    expect(finalStep.current_step_id).toBe('decompose');
  });

  it("Stage 3 SDK supervisor: a 'retry' triage verdict recovers a transiently-failing step", async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    const mgr = HumanStepManager.initialize(adapter);
    seedRun(db, 'run-sdk');

    // The 'epics' agent fails ONCE then succeeds; everything else succeeds.
    let epicsFails = 0;
    const spawner: ClaudeSpawnerLike & { calls: ClaudeSpawnerOptions[] } = {
      calls: [],
      spawnCliProcess: vi.fn(async (o: ClaudeSpawnerOptions) => {
        spawner.calls.push(o);
        if (o.prompt.includes('`epics`') && epicsFails === 0) {
          epicsFails += 1;
          throw new Error('epics transient blip');
        }
      }),
      abort: vi.fn().mockResolvedValue(undefined),
    };
    const reporter: StepReporter = { report: (rid, sid, s) => void buildStepTransitionEvent(rid, sid, s, adapter) };
    const gate = new ReviewQueueHumanGate(mgr, reviewItemChangeEvents, reviewItemProjectChannel);
    const approver = (payload: unknown): void => {
      const p = payload as { reviewItemId?: string; action?: string };
      if (p?.action === 'created' && p.reviewItemId) {
        const id = p.reviewItemId;
        setTimeout(() => void mgr.resolveHumanGate('run-sdk', id, 'user', 'approve'), 0);
      }
    };
    reviewItemChangeEvents.on(reviewItemProjectChannel(1), approver);

    // SDK supervisor with a FAKE advisor (the SDK boundary) → triages 'retry'.
    const advisor = { advise: vi.fn().mockResolvedValue({ decision: 'retry', rationale: 'transient' }) };
    const runner = new DefaultProgrammaticRunner({
      spawner,
      reporter,
      gate,
      supervisorFactory: () => new SdkSupervisorSession(advisor),
    });
    await expect(runner.run(ctxFor('run-sdk'))).resolves.toBeUndefined();

    // The supervisor was consulted for the epics failure and chose retry → the run
    // completed (epics ran twice) rather than failing or escalating.
    expect(advisor.advise).toHaveBeenCalledTimes(1);
    expect(spawner.calls.filter((c) => c.prompt.includes('`epics`')).length).toBe(2);
    const finalStep = db.prepare('SELECT current_step_id FROM workflow_runs WHERE id = ?').get('run-sdk') as {
      current_step_id: string | null;
    };
    expect(finalStep.current_step_id).toBe('decompose');
  });

  it('crash-safe resume: resumeFromStepId fast-forwards the walk past completed steps', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    const mgr = HumanStepManager.initialize(adapter);
    seedRun(db, 'run-res');

    const spawner = makeSpawner();
    const reporter: StepReporter = { report: (rid, sid, s) => void buildStepTransitionEvent(rid, sid, s, adapter) };
    const gate = new ReviewQueueHumanGate(mgr, reviewItemChangeEvents, reviewItemProjectChannel);
    const approver = (payload: unknown): void => {
      const p = payload as { reviewItemId?: string; action?: string };
      if (p?.action === 'created' && p.reviewItemId) {
        const id = p.reviewItemId;
        setTimeout(() => void mgr.resolveHumanGate('run-res', id, 'user', 'approve'), 0);
      }
    };
    reviewItemChangeEvents.on(reviewItemProjectChannel(1), approver);

    const runner = new DefaultProgrammaticRunner({ spawner, reporter, gate });
    // Resume at the refine phase 'epics' step → plan-phase agents (context/research)
    // must NOT re-run; the walk completes from 'epics' onward.
    await expect(runner.run({ ...ctxFor('run-res'), resumeFromStepId: 'epics' })).resolves.toBeUndefined();

    expect(spawner.calls.some((c) => c.prompt.includes('`context`'))).toBe(false); // skipped
    expect(spawner.calls.some((c) => c.prompt.includes('`research`'))).toBe(false); // skipped
    expect(spawner.calls.some((c) => c.prompt.includes('`epics`'))).toBe(true); // resumed here
    const finalStep = db.prepare('SELECT current_step_id FROM workflow_runs WHERE id = ?').get('run-res') as {
      current_step_id: string | null;
    };
    expect(finalStep.current_step_id).toBe('decompose');
  });

  it('cancellation mid-gate settles the walk and leaves no reviewItemChangeEvents listener', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    const mgr = HumanStepManager.initialize(adapter);
    seedRun(db, 'run-cancel');

    const spawner = makeSpawner();
    const reporter: StepReporter = { report: (rid, sid, s) => void buildStepTransitionEvent(rid, sid, s, adapter) };
    const gate = new ReviewQueueHumanGate(mgr, reviewItemChangeEvents, reviewItemProjectChannel);
    const ac = new AbortController();

    // When the FIRST gate opens, cancel the run instead of resolving it.
    const canceller = (payload: unknown): void => {
      const p = payload as { action?: string };
      if (p?.action === 'created') ac.abort();
    };
    reviewItemChangeEvents.on(reviewItemProjectChannel(1), canceller);

    const ctx = { ...ctxFor('run-cancel'), signal: ac.signal };
    const runner = new DefaultProgrammaticRunner({ spawner, reporter, gate });

    // Canceled is NOT a failure — the runner resolves (the cancel path owns the
    // terminal DB transition). Crucially it does not hang.
    await expect(runner.run(ctx)).resolves.toBeUndefined();

    reviewItemChangeEvents.off(reviewItemProjectChannel(1), canceller);
    // The gate's own listener was removed on abort (only our canceller remains,
    // which we just removed) → zero leaked listeners.
    expect(reviewItemChangeEvents.listenerCount(reviewItemProjectChannel(1))).toBe(0);
    // The run never advanced past the plan phase into refine.
    expect(spawner.calls.some((c) => c.prompt.includes('`epics`'))).toBe(false);
  });
});
