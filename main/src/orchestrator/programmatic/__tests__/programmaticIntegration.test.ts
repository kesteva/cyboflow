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
import { MonitorRegistry, type MonitorSession } from '../monitor';
import type { StepReporter } from '../programmaticRunHost';
import { HumanStepManager } from '../../humanStepManager';
import { reviewItemChangeEvents, reviewItemProjectChannel } from '../../reviewItemRouter';
import { buildStepTransitionEvent } from '../../stepTransitionBridge';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import type { ClaudeSpawnerLike, ClaudeSpawnerOptions, ProgrammaticRunContext } from '../../runExecutor';
import type { WorkflowDefinition, WorkflowRow, WorkflowRunRow } from '../../../../../shared/types/workflows';
import type { SprintBatchTaskStatus } from '../../../../../shared/types/sprintBatch';
import { SPRINT_BATCH_CAP } from '../../../../../shared/types/sprintBatch';
import type { FanOutDriver } from '../types';

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
    // Session-resolved mode (permission-mode redesign §3c#2).
    agentPermissionMode: 'auto',
    signal: new AbortController().signal,
    injectEvent: () => {},
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

// ── Fan-out integration fixtures ─────────────────────────────────────────────
// A 2-phase custom definition whose MIDDLE step ('execute-tasks') declares a
// fanOut over 'tasks'. The outer phase steps (plan → execute-tasks → verify) are
// plain agent steps; only 'execute-tasks' fans out. The inner ids form the lane
// step vocabulary the driver receives as `allowedStepIds` / `currentStepId`.
const FANOUT_INNER_IDS = ['implement', 'write-tests', 'task-verify'] as const;

function fanOutDef(): WorkflowDefinition {
  return {
    id: 'fanout-flow',
    phases: [
      {
        id: 'plan',
        label: 'Plan',
        color: '#3b6dd6',
        steps: [{ id: 'plan-step', name: 'Plan', agent: 'planner', mcps: [], retries: 0 }],
      },
      {
        id: 'execute',
        label: 'Execute',
        color: '#d68a3b',
        steps: [
          {
            id: 'execute-tasks',
            name: 'Execute tasks',
            agent: 'implement',
            mcps: [],
            retries: 0,
            fanOut: {
              over: 'tasks',
              inner: FANOUT_INNER_IDS.map((id) => ({ id, agent: id, name: id })),
            },
          },
          { id: 'verify', name: 'Verify', agent: 'verifier', mcps: [], retries: 0 },
        ],
      },
    ],
  };
}

/**
 * Seed a `workflows` row whose spec_json IS the custom fanOut definition (so the
 * stepTransitionBridge's stepId validation accepts the OUTER step ids) + a run
 * referencing it, optionally stamped with a batch_id (the seeded-sprint marker
 * the runner reads to build a FanOutDriver).
 */
function seedFanOutRun(db: Database.Database, runId: string): string {
  const specJson = JSON.stringify(fanOutDef());
  db.prepare(
    `INSERT INTO workflows (id, project_id, name, spec_json) VALUES ('wf-fanout', 1, 'fanout-flow', ?)`,
  ).run(specJson);
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, worktree_path, permission_mode_snapshot)
     VALUES (?, 'wf-fanout', 1, 'running', '/wt', 'auto')`,
  ).run(runId);
  return specJson;
}

function fanOutCtx(runId: string, specJson: string, batchId: string | null): ProgrammaticRunContext {
  const workflow: WorkflowRow = {
    id: 'wf-fanout',
    project_id: 1,
    name: 'fanout-flow',
    workflow_path: null,
    permission_mode: 'default',
    spec_json: specJson,
    created_at: 'now',
  };
  const run: WorkflowRunRow = {
    id: runId,
    workflow_id: 'wf-fanout',
    project_id: 1,
    status: 'running',
    permission_mode_snapshot: 'auto',
    worktree_path: '/wt',
    branch_name: null,
    batch_id: batchId,
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
    // Session-resolved mode (permission-mode redesign §3c#2).
    agentPermissionMode: 'auto',
    signal: new AbortController().signal,
    injectEvent: () => {},
  };
}

/** One lane's accumulated state in the in-memory fake. */
interface FakeLane {
  status: SprintBatchTaskStatus;
  /** Ordered currentStepId values seen (running seeds inner[0], then each inner id). */
  stepTrail: string[];
}

/**
 * In-memory, lane-backed FakeFanOutDriver — the headless stand-in for the
 * production `SprintLaneStore`-backed driver. `resolveItems('tasks')` returns the
 * seeded item ids; `driveLane` records each status/currentStepId transition into a
 * per-item lane map. It also tracks max in-flight concurrency so the test can
 * assert the wave cap. Fail-soft like the real driver (it never throws).
 */
function makeFakeFanOutDriver(itemIds: string[]): FanOutDriver & {
  lanes: Map<string, FakeLane>;
  resolveCalls: Array<{ runId: string; over: string }>;
  maxConcurrent: number;
} {
  const lanes = new Map<string, FakeLane>();
  const resolveCalls: Array<{ runId: string; over: string }> = [];
  const inFlight = new Set<string>();
  const tracker = { maxConcurrent: 0 };
  return {
    lanes,
    resolveCalls,
    get maxConcurrent(): number {
      return tracker.maxConcurrent;
    },
    resolveItems(runId: string, over: string): string[] {
      resolveCalls.push({ runId, over });
      return over === 'tasks' ? [...itemIds] : [];
    },
    driveLane(args): void {
      const lane = lanes.get(args.itemId) ?? { status: 'queued', stepTrail: [] };
      if (args.status !== undefined) {
        lane.status = args.status;
        // 'running' opens an in-flight slot; a terminal status closes it. This
        // mirrors the real lane's per-item lifecycle so the wave-cap assertion
        // observes the controller's concurrency, not the fake's bookkeeping.
        if (args.status === 'running') {
          inFlight.add(args.itemId);
          if (inFlight.size > tracker.maxConcurrent) tracker.maxConcurrent = inFlight.size;
        } else if (args.status === 'integrated' || args.status === 'failed') {
          inFlight.delete(args.itemId);
        }
      }
      if (args.currentStepId !== undefined && args.currentStepId !== null) {
        lane.stepTrail.push(args.currentStepId);
      }
      lanes.set(args.itemId, lane);
    },
  };
}

afterEach(() => {
  HumanStepManager._resetForTesting();
  reviewItemChangeEvents.removeAllListeners();
  MonitorRegistry._resetForTesting();
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
    // ui-prototype, architecture, epics, tasks) — pure gates (approve-idea/
    // approve-design/approve-plan/decompose) did NOT spawn.
    const stepPrompts = spawner.calls.map((c) => c.prompt);
    expect(spawner.calls).toHaveLength(6);
    expect(stepPrompts.some((p) => p.includes('`context`'))).toBe(true);
    expect(stepPrompts.some((p) => p.includes('`epics`'))).toBe(true);
    expect(stepPrompts.some((p) => p.includes('`tasks`'))).toBe(true);

    // All four human gates were opened AND resolved (approve-idea +
    // approve-design + approve-plan + decompose). context no longer carries a
    // bogus `human: true` (it soft-blocked runs at step 1 on both planes).
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

  it('default (no monitor): a failed step is escalated to the human review queue, approved (skipped), and the run continues', async () => {
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

    // No monitorFactory ⇒ the host's default triage routes exhausted required
    // failures to the human review queue ('escalate'), exactly as the old
    // ReviewQueueSupervisor did.
    const runner = new DefaultProgrammaticRunner({ spawner, reporter, gate });
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

  it("monitor: a 'retry' triage verdict recovers a transiently-failing step", async () => {
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

    // ON-DEMAND monitor with a FAKE brain (the SDK boundary is faked) → triages 'retry'.
    const monitor: MonitorSession = {
      triage: vi.fn().mockResolvedValue({ decision: 'retry', rationale: 'transient blip' }),
      answer: vi.fn().mockResolvedValue(''),
    };
    const runner = new DefaultProgrammaticRunner({
      spawner,
      reporter,
      gate,
      monitorFactory: () => monitor,
    });
    await expect(runner.run(ctxFor('run-sdk'))).resolves.toBeUndefined();

    // The monitor was consulted for the epics failure and chose retry → the run
    // completed (epics ran twice) rather than failing or escalating.
    expect(monitor.triage).toHaveBeenCalledTimes(1);
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

describe('programmatic integration — host-driven fanOut walk drives lanes to integrated', () => {
  it('drives every lane running → each inner → integrated and rests the run completed (concurrency cap respected)', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    const mgr = HumanStepManager.initialize(adapter);
    const specJson = seedFanOutRun(db, 'run-fan');

    const spawner = makeSpawner();
    const reporter: StepReporter = { report: (rid, sid, s) => void buildStepTransitionEvent(rid, sid, s, adapter) };
    const gate = new ReviewQueueHumanGate(mgr, reviewItemChangeEvents, reviewItemProjectChannel);

    // 3 items fan out over 'tasks'; the fake driver is lane-backed (in-memory).
    const itemIds = ['t-1', 't-2', 't-3'];
    const driver = makeFakeFanOutDriver(itemIds);

    const runner = new DefaultProgrammaticRunner({
      spawner,
      reporter,
      gate,
      // Only invoked for a seeded sprint (the run carries batch_id); returns our
      // fake lane-backed driver bound to the run's batch.
      fanOutDriverFactory: ({ runId, batchId }) => {
        expect(runId).toBe('run-fan');
        expect(batchId).toBe('batch-fan');
        return driver;
      },
    });

    // The custom def has NO human steps → no gate round-trip; the walk resolves
    // (completed) once every lane integrates.
    await expect(runner.run(fanOutCtx('run-fan', specJson, 'batch-fan'))).resolves.toBeUndefined();

    // resolveItems was consulted once for the fanOut step, keyed 'tasks'.
    expect(driver.resolveCalls).toEqual([{ runId: 'run-fan', over: 'tasks' }]);

    // EVERY lane reached 'integrated' and walked the full inner chain in order:
    // 'running' seeds inner[0], then one currentStepId update per inner step ⇒
    // the trail is [inner[0], inner[0], inner[1], inner[2]] (the duplicate first id
    // is the seed-on-running followed by the explicit first inner drive).
    expect([...driver.lanes.keys()].sort()).toEqual(itemIds);
    for (const id of itemIds) {
      const lane = driver.lanes.get(id);
      expect(lane?.status).toBe('integrated');
      expect(lane?.stepTrail).toEqual([
        FANOUT_INNER_IDS[0], // seeded with the running status
        FANOUT_INNER_IDS[0],
        FANOUT_INNER_IDS[1],
        FANOUT_INNER_IDS[2],
      ]);
    }

    // The outer phase steps ran via the spawn surface (plan-step + verify) AND
    // each (item × inner) inner step spawned a scoped agent turn (3 items × 3
    // inner = 9), scoped to its item via the fan-out prompt block.
    const innerSpawns = spawner.calls.filter((c) => c.prompt.includes('PARALLEL fan-out'));
    expect(innerSpawns).toHaveLength(itemIds.length * FANOUT_INNER_IDS.length);
    for (const id of itemIds) {
      expect(innerSpawns.some((c) => c.prompt.includes(`item **${id}**`))).toBe(true);
    }
    // Every inner (lane) spawn carries the additive per-lane spawnKey
    // (`${runId}:${itemId}`) so the spawner keys its lock / dup-guard / per-spawn
    // maps per lane instead of serializing all lanes on the shared run panelId.
    // panelId stays the run id on every spawn (it is NEVER overloaded by the key).
    for (const c of innerSpawns) {
      expect(c.panelId).toBe('run-fan');
      expect(itemIds.map((id) => `run-fan:${id}`)).toContain(c.spawnKey);
    }
    // Each of the 3 lanes used a DISTINCT spawnKey (one per item).
    expect(new Set(innerSpawns.map((c) => c.spawnKey))).toEqual(
      new Set(itemIds.map((id) => `run-fan:${id}`)),
    );
    // The OUTER (non-fan-out) steps spawn WITHOUT a spawnKey — byte-identical to a
    // normal single-step turn (the spawner then defaults spawnKey to panelId).
    const outerSpawns = spawner.calls.filter((c) => !c.prompt.includes('PARALLEL fan-out'));
    expect(outerSpawns.length).toBeGreaterThan(0);
    expect(outerSpawns.every((c) => c.spawnKey === undefined)).toBe(true);
    // The outer 'execute-tasks' agent step itself did NOT spawn (it fanned out).
    expect(spawner.calls.some((c) => c.prompt.includes('`execute-tasks`'))).toBe(false);
    expect(spawner.calls.some((c) => c.prompt.includes('`plan-step`'))).toBe(true);
    expect(spawner.calls.some((c) => c.prompt.includes('`verify`'))).toBe(true);

    // Concurrency cap: at most SPRINT_BATCH_CAP lanes are ever in-flight at once
    // (3 items ≤ the cap here, so all 3 run in a single wave).
    expect(driver.maxConcurrent).toBeLessThanOrEqual(SPRINT_BATCH_CAP);
    expect(driver.maxConcurrent).toBe(itemIds.length);

    // The live timeline advanced to the terminal OUTER step ('verify'); the
    // fanOut step's reporter boundary used the OUTER id, not an inner id.
    const finalStep = db.prepare('SELECT current_step_id FROM workflow_runs WHERE id = ?').get('run-fan') as {
      current_step_id: string | null;
    };
    expect(finalStep.current_step_id).toBe('verify');
    // sanity: the resolved def is the custom fanOut def (not a built-in).
    expect((JSON.parse(specJson) as WorkflowDefinition).id).toBe('fanout-flow');
  });

  it('control: the SAME def with NO fanOut driver (no batch_id) runs the outer step ONCE — byte-identical', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    const mgr = HumanStepManager.initialize(adapter);
    // No batch_id ⇒ the runner never invokes the factory ⇒ host.fanOut is
    // undefined ⇒ the controller treats 'execute-tasks' as a normal agent step.
    const specJson = seedFanOutRun(db, 'run-nofan');

    const spawner = makeSpawner();
    const reporter: StepReporter = { report: (rid, sid, s) => void buildStepTransitionEvent(rid, sid, s, adapter) };
    const gate = new ReviewQueueHumanGate(mgr, reviewItemChangeEvents, reviewItemProjectChannel);

    let factoryCalls = 0;
    const runner = new DefaultProgrammaticRunner({
      spawner,
      reporter,
      gate,
      fanOutDriverFactory: () => {
        factoryCalls += 1;
        return makeFakeFanOutDriver(['t-1']);
      },
    });

    await expect(runner.run(fanOutCtx('run-nofan', specJson, null))).resolves.toBeUndefined();

    // The factory was NEVER consulted (the run carries no batch_id).
    expect(factoryCalls).toBe(0);
    // No item-scoped inner spawns occurred — the def's fanOut field is inert.
    expect(spawner.calls.some((c) => c.prompt.includes('PARALLEL fan-out'))).toBe(false);
    // The outer 'execute-tasks' agent step ran exactly ONCE as a normal step.
    expect(spawner.calls.filter((c) => c.prompt.includes('`execute-tasks`'))).toHaveLength(1);
    // All three outer steps ran once each in order; the walk completed.
    expect(spawner.calls.map((c) => c.prompt).filter((p) => p.includes('`plan-step`'))).toHaveLength(1);
    expect(spawner.calls.map((c) => c.prompt).filter((p) => p.includes('`verify`'))).toHaveLength(1);
    const finalStep = db.prepare('SELECT current_step_id FROM workflow_runs WHERE id = ?').get('run-nofan') as {
      current_step_id: string | null;
    };
    expect(finalStep.current_step_id).toBe('verify');
  });
});
