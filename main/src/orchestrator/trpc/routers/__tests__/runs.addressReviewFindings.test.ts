/**
 * Tests for `cyboflow.runs.addressReviewFindings` and
 * `cyboflow.runs.canAddressReviewFindings` (TASK-277 — the review queue's
 * "Address review findings" CTA on an eval-sourced finding).
 *
 * Covers:
 *   - `addressReviewFindings` delivers a rewind to the 'address-review' step
 *     (delegating to rewindRunHandler — see rewindRunHandler.test.ts for the
 *     handler's own exhaustive coverage of the purge/abort/fan-out machinery).
 *   - `addressReviewFindings`'s `not_rewindable` fallback for a terminal run,
 *     and its own `in_progress` refusal when address-review is ALREADY the live
 *     current step (once-per-run across sibling finding cards: two concurrent
 *     requests yield one delivered rewind + one executor re-drive).
 *   - `canAddressReviewFindings` eligibility: eligible for a rewindable
 *     programmatic run whose frozen spec carries an 'address-review' step;
 *     `{eligible:false, reason:'completed'}` for a completed/missing run;
 *     `{eligible:false, reason:'no_step'}` for a flow with no such step
 *     (e.g. a quick session); `{eligible:false, reason:'in_progress'}` while
 *     address-review is running. The FROZEN spec (workflow_runs.spec_hash →
 *     workflow_revisions) controls, not the live workflows.spec_json.
 *
 * Style mirrors runs.retryEval.test.ts: an in-memory createTestDb + the
 * dbAdapter, driven through appRouter.createCaller.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { appRouter } from '../../router';
import { createContext } from '../../context';
import { dbAdapter } from '../../../__test_fixtures__/dbAdapter';
import { createTestDb, seedRun, type SeedRunOverrides } from '../../../__test_fixtures__/orchestratorTestDb';
import { RunQueueRegistry } from '../../../RunQueueRegistry';
import { setRewindRunDeps } from '../runs';
import type { RewindRunExecutorLike, RewindRunDeps } from '../../../rewindRunHandler';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A sprint-shaped spec: sprint-verify -> sprint-review -> address-review -> human-review. */
const SPRINT_SPEC = JSON.stringify({
  id: 'test-sprint',
  phases: [
    {
      id: 'verify',
      label: 'Sprint review',
      color: '#a87a2c',
      steps: [
        { id: 'sprint-verify', name: 'Sprint verification', agent: 'sprint-verify' },
        { id: 'sprint-review', name: 'Code review', agent: 'sprint-review' },
        { id: 'address-review', name: 'Address review findings', agent: 'address-review' },
        { id: 'human-review', name: 'Human review', agent: 'human', human: true },
      ],
    },
  ],
});

/** A quick-session-shaped spec with no address-review step at all. */
const NO_ADDRESS_REVIEW_SPEC = JSON.stringify({
  id: 'test-quick',
  phases: [
    {
      id: 'quick',
      label: 'Quick',
      color: '#111111',
      steps: [{ id: 'chat', name: 'Chat', agent: 'quick' }],
    },
  ],
});

function makeDb(): Database.Database {
  return createTestDb({ includeSubstrate: true, includeWorkflowRunTaskColumns: true });
}

function setExecutionModel(db: Database.Database, runId: string, model: 'orchestrated' | 'programmatic'): void {
  db.prepare('UPDATE workflow_runs SET execution_model = ? WHERE id = ?').run(model, runId);
}
function setCurrentStepId(db: Database.Database, runId: string, stepId: string | null): void {
  db.prepare('UPDATE workflow_runs SET current_step_id = ? WHERE id = ?').run(stepId, runId);
}
function setWorkflowSpec(db: Database.Database, workflowId: string, specJson: string): void {
  db.prepare('UPDATE workflows SET spec_json = ? WHERE id = ?').run(specJson, workflowId);
}

/** Seed a rewindable programmatic sprint run parked at human-review by default. */
function seedSprintRun(
  db: Database.Database,
  overrides?: { status?: SeedRunOverrides['status']; specJson?: string; currentStepId?: string | null },
): { runId: string; workflowId: string } {
  const { runId, workflowId } = seedRun(db, {
    status: overrides?.status ?? 'awaiting_review',
    workflowName: 'sprint',
  });
  setExecutionModel(db, runId, 'programmatic');
  setWorkflowSpec(db, workflowId, overrides?.specJson ?? SPRINT_SPEC);
  setCurrentStepId(db, runId, overrides?.currentStepId ?? 'human-review');
  return { runId, workflowId };
}

function makeFakeExecutor(): RewindRunExecutorLike & { executeCalls: string[] } {
  const executeCalls: string[] = [];
  return {
    executeCalls,
    setPendingResumeStep: () => {},
    setPendingCompletedSteps: () => {},
    hasActiveExecution: () => false,
    requestProgrammaticCancel: () => false,
    execute: async (runId: string) => {
      executeCalls.push(runId);
    },
  };
}

/**
 * Add migration 026's frozen-definition address (`workflow_runs.spec_hash` +
 * `workflow_revisions`) to the minimal test DB, so a test can pin a run to a
 * FROZEN spec that disagrees with the live `workflows.spec_json`.
 */
function addFrozenSpecSchema(db: Database.Database): void {
  db.exec('ALTER TABLE workflow_runs ADD COLUMN spec_hash TEXT');
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_revisions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id TEXT NOT NULL,
      spec_hash   TEXT NOT NULL,
      spec_json   TEXT NOT NULL,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (workflow_id, spec_hash)
    )
  `);
}

function freezeRunSpec(db: Database.Database, runId: string, workflowId: string, specJson: string): void {
  const specHash = `hash-${runId}`;
  db.prepare('INSERT INTO workflow_revisions (workflow_id, spec_hash, spec_json) VALUES (?, ?, ?)').run(
    workflowId,
    specHash,
    specJson,
  );
  db.prepare('UPDATE workflow_runs SET spec_hash = ? WHERE id = ?').run(specHash, runId);
}

describe('cyboflow.runs.addressReviewFindings / canAddressReviewFindings', () => {
  let db: Database.Database;

  afterEach(() => {
    db.close();
  });

  // -- addressReviewFindings (mutation) --------------------------------------

  describe('addressReviewFindings', () => {
    beforeAll(() => {
      // Wired ONCE for this describe block (module-level singleton, mirrors
      // setRetryRunDeps's boot-time contract) — every test below reuses it.
    });

    it('rewinds a run parked at human-review to the address-review step exactly once', async () => {
      db = makeDb();
      const { runId } = seedSprintRun(db);
      const deps: RewindRunDeps = {
        db: dbAdapter(db),
        runQueues: new RunQueueRegistry(),
        runExecutor: makeFakeExecutor(),
        emitRunStatusChanged: () => {},
        listStepResults: () => [],
        deleteStepResults: () => 0,
      };
      setRewindRunDeps(deps);
      const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));

      const result = await caller.cyboflow.runs.addressReviewFindings({ runId });

      expect(result).toMatchObject({ delivered: true, stepId: 'address-review' });
      const row = db
        .prepare('SELECT status, current_step_id FROM workflow_runs WHERE id = ?')
        .get(runId) as { status: string; current_step_id: string | null };
      expect(row.status).toBe('starting');
      expect(row.current_step_id).toBe('address-review');
    });

    it('refuses (in_progress) when address-review is ALREADY the live current step — no abort/restart of in-flight repair', async () => {
      db = makeDb();
      const { runId } = seedSprintRun(db, { status: 'running', currentStepId: 'address-review' });
      const executor = makeFakeExecutor();
      const deps: RewindRunDeps = {
        db: dbAdapter(db),
        runQueues: new RunQueueRegistry(),
        runExecutor: executor,
        emitRunStatusChanged: () => {},
        listStepResults: () => [],
        deleteStepResults: () => 0,
      };
      setRewindRunDeps(deps);
      const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));

      const result = await caller.cyboflow.runs.addressReviewFindings({ runId });

      expect(result).toEqual({ noOp: true, reason: 'in_progress' });
      expect(executor.executeCalls).toEqual([]);
      const row = db
        .prepare('SELECT status, current_step_id FROM workflow_runs WHERE id = ?')
        .get(runId) as { status: string; current_step_id: string | null };
      expect(row).toEqual({ status: 'running', current_step_id: 'address-review' });
    });

    it('still re-drives a run that FAILED at address-review (a dead step is exactly what the action is for)', async () => {
      db = makeDb();
      const { runId } = seedSprintRun(db, { status: 'failed', currentStepId: 'address-review' });
      const executor = makeFakeExecutor();
      setRewindRunDeps({
        db: dbAdapter(db),
        runQueues: new RunQueueRegistry(),
        runExecutor: executor,
        emitRunStatusChanged: () => {},
        listStepResults: () => [],
        deleteStepResults: () => 0,
      });
      const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));

      const result = await caller.cyboflow.runs.addressReviewFindings({ runId });

      expect(result).toMatchObject({ delivered: true, stepId: 'address-review' });
    });

    it('two sibling finding cards requesting the same run yield ONE delivered rewind and ONE executor re-drive', async () => {
      db = makeDb();
      const { runId } = seedSprintRun(db);
      const executor = makeFakeExecutor();
      setRewindRunDeps({
        db: dbAdapter(db),
        runQueues: new RunQueueRegistry(),
        runExecutor: executor,
        emitRunStatusChanged: () => {},
        listStepResults: () => [],
        deleteStepResults: () => 0,
      });
      const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));

      // Concurrent: both cards click before either request settles.
      const [first, second] = await Promise.all([
        caller.cyboflow.runs.addressReviewFindings({ runId }),
        caller.cyboflow.runs.addressReviewFindings({ runId }),
      ]);
      const delivered = [first, second].filter((r) => 'delivered' in r);
      const refused = [first, second].filter((r) => 'noOp' in r);
      expect(delivered).toHaveLength(1);
      expect(refused).toHaveLength(1);
      expect(executor.executeCalls).toEqual([runId]);

      // Sequential: a third click once the rewound step is live is refused too.
      db.prepare(`UPDATE workflow_runs SET status = 'running' WHERE id = ?`).run(runId);
      const third = await caller.cyboflow.runs.addressReviewFindings({ runId });
      expect(third).toEqual({ noOp: true, reason: 'in_progress' });
      expect(executor.executeCalls).toEqual([runId]);
    });

    it('returns not_rewindable for a run that already completed', async () => {
      db = makeDb();
      const { runId } = seedSprintRun(db, { status: 'completed' });
      const deps: RewindRunDeps = {
        db: dbAdapter(db),
        runQueues: new RunQueueRegistry(),
        runExecutor: makeFakeExecutor(),
        emitRunStatusChanged: () => {},
        listStepResults: () => [],
        deleteStepResults: () => 0,
      };
      setRewindRunDeps(deps);
      const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));

      const result = await caller.cyboflow.runs.addressReviewFindings({ runId });

      expect(result).toEqual({ noOp: true, reason: 'not_rewindable' });
      // Nothing mutated — the run is left exactly as it was.
      const row = db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as { status: string };
      expect(row.status).toBe('completed');
    });
  });

  // -- canAddressReviewFindings (query) --------------------------------------

  describe('canAddressReviewFindings', () => {
    it('is eligible for a rewindable programmatic run whose frozen spec has an address-review step', async () => {
      db = makeDb();
      const { runId } = seedSprintRun(db);
      const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));

      const result = await caller.cyboflow.runs.canAddressReviewFindings({ runId });

      expect(result).toEqual({ eligible: true });
    });

    it("is ineligible ('completed') for a run that already completed", async () => {
      db = makeDb();
      const { runId } = seedSprintRun(db, { status: 'completed' });
      const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));

      const result = await caller.cyboflow.runs.canAddressReviewFindings({ runId });

      expect(result).toEqual({ eligible: false, reason: 'completed' });
    });

    it("is ineligible ('completed') for an unknown run id", async () => {
      db = makeDb();
      const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));

      const result = await caller.cyboflow.runs.canAddressReviewFindings({ runId: 'missing-run' });

      expect(result).toEqual({ eligible: false, reason: 'completed' });
    });

    it("is ineligible ('no_step') for a flow whose frozen spec has no address-review step", async () => {
      db = makeDb();
      const { runId } = seedRun(db, { status: 'awaiting_review', workflowName: 'quick' });
      setExecutionModel(db, runId, 'programmatic');
      const workflow = db.prepare('SELECT workflow_id FROM workflow_runs WHERE id = ?').get(runId) as {
        workflow_id: string;
      };
      setWorkflowSpec(db, workflow.workflow_id, NO_ADDRESS_REVIEW_SPEC);
      const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));

      const result = await caller.cyboflow.runs.canAddressReviewFindings({ runId });

      expect(result).toEqual({ eligible: false, reason: 'no_step' });
    });

    it("is ineligible ('in_progress') while address-review is the live current step", async () => {
      db = makeDb();
      const { runId } = seedSprintRun(db, { status: 'running', currentStepId: 'address-review' });
      const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));

      const result = await caller.cyboflow.runs.canAddressReviewFindings({ runId });

      expect(result).toEqual({ eligible: false, reason: 'in_progress' });
    });

    it('reads the FROZEN spec, not the live workflows.spec_json: frozen has address-review, live does not → eligible', async () => {
      db = makeDb();
      addFrozenSpecSchema(db);
      // Live spec has NO address-review step; the run's frozen revision does.
      const { runId, workflowId } = seedSprintRun(db, { specJson: NO_ADDRESS_REVIEW_SPEC });
      freezeRunSpec(db, runId, workflowId, SPRINT_SPEC);
      const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));

      expect(await caller.cyboflow.runs.canAddressReviewFindings({ runId })).toEqual({ eligible: true });
    });

    it("reads the FROZEN spec, not the live workflows.spec_json: live has address-review, frozen does not → 'no_step'", async () => {
      db = makeDb();
      addFrozenSpecSchema(db);
      const { runId, workflowId } = seedSprintRun(db, { specJson: SPRINT_SPEC });
      freezeRunSpec(db, runId, workflowId, NO_ADDRESS_REVIEW_SPEC);
      const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));

      expect(await caller.cyboflow.runs.canAddressReviewFindings({ runId })).toEqual({
        eligible: false,
        reason: 'no_step',
      });
    });

    it("is ineligible ('completed') for a non-programmatic (orchestrated) run", async () => {
      db = makeDb();
      const { runId } = seedSprintRun(db);
      setExecutionModel(db, runId, 'orchestrated');
      const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));

      const result = await caller.cyboflow.runs.canAddressReviewFindings({ runId });

      expect(result).toEqual({ eligible: false, reason: 'completed' });
    });
  });
});
