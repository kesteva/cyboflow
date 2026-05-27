/**
 * Integration tests for the orchestrator tRPC runs procedures.
 *
 * Covers:
 *
 * runs.getStuckInspection (TASK-709):
 *  Tests exercise the live runsRouter.getStuckInspection procedure via
 *  createCaller, using an in-memory SQLite database (GATE_SCHEMA + migration 007
 *  stub), the dbAdapter fixture, and the real getStuckInspectionHandler.
 *  (a) Happy path: stuck run + pending approval + 15 raw events → returns
 *      correct shaped result with 10 most recent events.
 *  (b) Unknown runId → TRPCError NOT_FOUND.
 *  (d) Missing ctx.db → TRPCError PRECONDITION_FAILED.
 *
 * runs.list (TASK-710 — wrapper-layer guard coverage):
 *  Tests exercise the tRPC PRECONDITION_FAILED guard that sits around
 *  the listRunsHandler call. Handler-level behavior (ordering, scoping,
 *  policy_json exclusion) is covered in
 *  main/src/orchestrator/__tests__/listRunsHandler.test.ts.
 *  (a) Happy path: seeded runs return the correct list for the given projectId.
 *  (c) Missing ctx.db → TRPCError PRECONDITION_FAILED.
 *
 * runs.start (TASK-712 — procedure-level guard + delegation coverage):
 *  Tests use stub RunLauncherLike + SessionManagerLike injected via
 *  setStartRunDeps(). The underlying RunLauncher.launch is covered by
 *  main/src/orchestrator/__tests__/runLauncher.test.ts; these tests cover
 *  the procedure's own conditional branches.
 *  (a) Happy path: project found → launch called → { runId, worktreePath, branchName } returned.
 *  (b) Project not found → TRPCError NOT_FOUND.
 *  (d) Deps not wired → TRPCError METHOD_NOT_SUPPORTED (also covered in router.test.ts).
 *
 * runs.listMessages (TASK-759 — wrapper-layer guard coverage):
 *  (a) Empty raw_events returns [].
 *  (b) Missing ctx.db → TRPCError PRECONDITION_FAILED.
 *
 * runs.getPhaseState (TASK-766):
 *  (a) Returns correct WorkflowDefinition for known SoloFlowWorkflowName.
 *  (b) Throws NOT_FOUND for unknown workflow name.
 *  (c) Returns current_step_id verbatim (string and null cases).
 *  (d) Computes stepStates correctly across four cases:
 *        null currentStepId → all pending.
 *        first-step running → first running, rest pending.
 *        middle-step running → preceding done, matching running, trailing pending.
 *        orphan id → all pending.
 *  (e) Throws PRECONDITION_FAILED when ctx.db is missing.
 *  (f) Throws NOT_FOUND when runId does not exist.
 *
 * runs.onStepTransition (TASK-766):
 *  (a) Filters by runId server-side: emitting two events yields only the
 *      matching runId event to a subscriber.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isAsyncIterable, callProcedure } from '@trpc/server/unstable-core-do-not-import';
import type Database from 'better-sqlite3';
import { TRPCError } from '@trpc/server';
import { appRouter } from '../../router';
import { createContext } from '../../context';
import { dbAdapter } from '../../../__test_fixtures__/dbAdapter';
import { setStartRunDeps } from '../runs';
import { createTestDb, seedRun, seedApproval } from '../../../__test_fixtures__/orchestratorTestDb';
import { stepTransitionEvents } from '../events';
import type { WorkflowStepTransitionEvent } from '../../../../../../shared/types/workflows';
import { buildStepTransitionEvent, resolveTerminalStepId } from '../../../stepTransitionBridge';
import { SOLOFLOW_WORKFLOW_NAMES } from '../../../../../../shared/types/workflows';

// ---------------------------------------------------------------------------
// Seed helpers (inlined — small, out of scope to extract to shared fixture)
// ---------------------------------------------------------------------------

/** Seed a workflow + workflow_run row with status='stuck'. */
function seedStuckRun(
  db: Database.Database,
  runId: string,
  stuckReason: string,
): void {
  const workflowId = `workflow-${runId}`;
  db.prepare(
    `INSERT INTO workflows (id, project_id, name, spec_json)
     VALUES (?, 1, 'test-workflow', '{}')`,
  ).run(workflowId);

  db.prepare(
    `INSERT INTO workflow_runs
       (id, workflow_id, project_id, worktree_path, status, policy_json,
        stuck_reason, stuck_detected_at)
     VALUES (?, ?, 1, '/tmp/test', 'stuck', '{}', ?, unixepoch('now') * 1000)`,
  ).run(runId, workflowId, stuckReason);
}

/** Seed N raw_events rows for a run. Returns inserted row ids. */
function seedRawEvents(
  db: Database.Database,
  runId: string,
  count: number,
): number[] {
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    const result = db.prepare(
      `INSERT INTO raw_events (run_id, event_type, payload_json)
       VALUES (?, 'sdk_message', ?)`,
    ).run(runId, JSON.stringify({ index: i })) as { lastInsertRowid: number | bigint };
    ids.push(Number(result.lastInsertRowid));
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cyboflow.runs.getStuckInspection', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb({ includeStuckDetectedAt: true });
  });

  // -------------------------------------------------------------------------
  // (a) Happy path
  // -------------------------------------------------------------------------
  it('(a) happy path: returns StuckInspectionResult with 10 most recent events', async () => {
    const runId = 'run-gsi-happy';
    seedStuckRun(db, runId, 'no_progress');
    seedApproval(db, { id: 'approval-gsi-1', runId, toolName: 'Bash', toolInputJson: JSON.stringify({ cmd: 'echo hi' }), toolUseId: 'use-approval-gsi-1' });
    const allIds = seedRawEvents(db, runId, 15);

    const adapter = dbAdapter(db);
    const caller = appRouter.createCaller(createContext({ db: adapter }));
    const result = await caller.cyboflow.runs.getStuckInspection({ runId });

    expect(result.runId).toBe(runId);
    expect(result.stuckReason).toBe('no_progress');
    expect(result.stuckDetectedAt).not.toBeNull();

    // Exactly 10 events returned.
    expect(result.recentEvents).toHaveLength(10);

    // Descending id order.
    const returnedIds = result.recentEvents.map((e) => e.id);
    const sortedDesc = [...returnedIds].sort((a, b) => b - a);
    expect(returnedIds).toEqual(sortedDesc);

    // Top 10 of 15 inserted ids.
    const top10Ids = [...allIds].sort((a, b) => b - a).slice(0, 10);
    expect(returnedIds).toEqual(top10Ids);

    // Pending approval is present.
    expect(result.pendingApproval).not.toBeNull();
    expect(result.pendingApproval?.toolName).toBe('Bash');
    expect(result.pendingApproval?.input).toEqual({ cmd: 'echo hi' });
  });

  // -------------------------------------------------------------------------
  // (b) Unknown runId → NOT_FOUND
  // -------------------------------------------------------------------------
  it('(b) unknown runId → TRPCError NOT_FOUND', async () => {
    const adapter = dbAdapter(db);
    const caller = appRouter.createCaller(createContext({ db: adapter }));

    await expect(
      caller.cyboflow.runs.getStuckInspection({ runId: 'nonexistent-run-id' }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof TRPCError && err.code === 'NOT_FOUND',
    );
  });

  // -------------------------------------------------------------------------
  // (d) Missing ctx.db → PRECONDITION_FAILED
  // -------------------------------------------------------------------------
  it('(d) missing ctx.db → TRPCError PRECONDITION_FAILED', async () => {
    // createContext without db — db will be undefined.
    const caller = appRouter.createCaller(createContext());

    await expect(
      caller.cyboflow.runs.getStuckInspection({ runId: 'any-run-id' }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof TRPCError && err.code === 'PRECONDITION_FAILED',
    );
  });
});

// ---------------------------------------------------------------------------
// runs.list wrapper-layer integration tests (TASK-710)
//
// These tests target the tRPC-layer guards (FORBIDDEN, PRECONDITION_FAILED)
// that wrap the listRunsHandler call. Handler-level contracts (ordering,
// projectId scoping, policy_json exclusion) are covered by the unit tests in
// main/src/orchestrator/__tests__/listRunsHandler.test.ts.
// ---------------------------------------------------------------------------

describe('cyboflow.runs.list', () => {
  let db: Database.Database;

  beforeEach(() => {
    // createTestDb applies GATE_SCHEMA (migration 006 equivalent) + migration 007 (stuck_detected_at).
    db = createTestDb({ includeStuckDetectedAt: true });
  });

  // -------------------------------------------------------------------------
  // (a) Happy path — seeded runs for projectId=1 are returned
  // -------------------------------------------------------------------------
  it('(a) happy path: returns seeded runs for the given projectId', async () => {
    seedRun(db, { id: 'run-list-1', projectId: 1 });
    seedRun(db, { id: 'run-list-2', projectId: 1 });
    // A run for a different project — must NOT appear.
    seedRun(db, { id: 'run-other-proj', projectId: 2 });

    const adapter = dbAdapter(db);
    const caller = appRouter.createCaller(createContext({ db: adapter }));
    const result = await caller.cyboflow.runs.list({ projectId: 1 });

    expect(result).toHaveLength(2);
    const ids = result.map((r) => r.id);
    expect(ids).toContain('run-list-1');
    expect(ids).toContain('run-list-2');
    expect(ids).not.toContain('run-other-proj');

    // policy_json must not appear on any returned row.
    for (const row of result) {
      expect(Object.keys(row)).not.toContain('policy_json');
    }
  });

  // -------------------------------------------------------------------------
  // (c) Missing ctx.db → PRECONDITION_FAILED
  // -------------------------------------------------------------------------
  it('(c) missing ctx.db → TRPCError PRECONDITION_FAILED', async () => {
    // createContext without db — db will be undefined.
    const caller = appRouter.createCaller(createContext());

    await expect(
      caller.cyboflow.runs.list({ projectId: 1 }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof TRPCError && err.code === 'PRECONDITION_FAILED',
    );
  });
});

// ---------------------------------------------------------------------------
// runs.start procedure-level tests (TASK-712)
//
// These tests exercise the three conditional branches in the start procedure
// body directly — the underlying RunLauncher.launch is covered separately in
// main/src/orchestrator/__tests__/runLauncher.test.ts. Stub RunLauncherLike
// and SessionManagerLike objects are injected via setStartRunDeps() to keep
// the test free of Electron / better-sqlite3 imports.
//
// afterEach resets startRunDeps to null by re-calling setStartRunDeps with
// a stub that always throws, preventing cross-test module-level state leaks
// within this file. (Across files, Vitest's per-file module isolation means
// each test file loads its own module instance, so there is no cross-file
// pollution.)
// ---------------------------------------------------------------------------

describe('cyboflow.runs.start', () => {
  // -------------------------------------------------------------------------
  // (a) Happy path — project found, launch called, response shape matches AC1
  // -------------------------------------------------------------------------
  it('(a) happy path: project found → returns { runId, worktreePath, branchName }', async () => {
    const launchMock = vi.fn().mockResolvedValue({
      runId: 'run-start-abc',
      worktreePath: '/tmp/wt/abc',
      branchName: 'cyboflow/my-workflow/abc12345',
    });
    const sessionManagerStub = {
      getProjectById: (_id: number) => ({ path: '/projects/my-project' }),
    };

    setStartRunDeps({ runLauncher: { launch: launchMock }, sessionManager: sessionManagerStub });

    try {
      const caller = appRouter.createCaller(createContext());
      const result = await caller.cyboflow.runs.start({ workflowId: 'wf-abc', projectId: 1 });

      expect(result).toEqual({
        runId: 'run-start-abc',
        worktreePath: '/tmp/wt/abc',
        branchName: 'cyboflow/my-workflow/abc12345',
      });

      // launch must be called with workflowId and the project path resolved by the session manager.
      expect(launchMock).toHaveBeenCalledOnce();
      expect(launchMock).toHaveBeenCalledWith('wf-abc', '/projects/my-project');
    } finally {
      // Reset module state regardless of test outcome.
      setStartRunDeps({
        runLauncher: { launch: vi.fn().mockRejectedValue(new Error('not wired')) },
        sessionManager: { getProjectById: () => undefined },
      });
    }
  });

  // -------------------------------------------------------------------------
  // (b) Project not found → NOT_FOUND (AC7)
  // -------------------------------------------------------------------------
  it('(b) project not found → TRPCError NOT_FOUND', async () => {
    const launchMock = vi.fn();
    const sessionManagerStub = {
      // Simulates a projectId that does not exist in the session manager.
      getProjectById: (_id: number) => undefined,
    };

    setStartRunDeps({ runLauncher: { launch: launchMock }, sessionManager: sessionManagerStub });

    try {
      const caller = appRouter.createCaller(createContext());

      await expect(
        caller.cyboflow.runs.start({ workflowId: 'wf-missing', projectId: 999 }),
      ).rejects.toSatisfy(
        (err: unknown) => err instanceof TRPCError && err.code === 'NOT_FOUND',
      );

      // launch must NOT be called when the project lookup fails.
      expect(launchMock).not.toHaveBeenCalled();
    } finally {
      setStartRunDeps({
        runLauncher: { launch: vi.fn().mockRejectedValue(new Error('not wired')) },
        sessionManager: { getProjectById: () => undefined },
      });
    }
  });

  // (d) Deps not wired → METHOD_NOT_SUPPORTED is covered by the independently
  // loaded module instance in router.test.ts ("cyboflow.runs.start throws
  // METHOD_NOT_SUPPORTED when deps not wired"). Vitest's per-file module
  // isolation guarantees that test file starts with startRunDeps === null.
  // Repeating it here would require a __resetForTest escape hatch in source
  // code — not added because it would exist solely to support tests.
});

// ---------------------------------------------------------------------------
// runs.listMessages wrapper-layer tests (TASK-759)
//
// These tests exercise the two conditional branches in the listMessages
// procedure body at the tRPC layer. The underlying selectRunMessages logic
// is covered in main/src/orchestrator/__tests__/runMessagesListing.test.ts.
// ---------------------------------------------------------------------------

describe('cyboflow.runs.listMessages', () => {
  // -------------------------------------------------------------------------
  // (a) Empty raw_events returns []
  // -------------------------------------------------------------------------
  it('(a) empty raw_events returns []', async () => {
    // Use createTestDb with includeStuckDetectedAt because the raw_events table
    // is part of the GATE_SCHEMA already — no extra migration needed.
    const db = createTestDb({ includeStuckDetectedAt: true });
    const adapter = dbAdapter(db);
    const caller = appRouter.createCaller(createContext({ db: adapter }));

    const result = await caller.cyboflow.runs.listMessages({ runId: 'run-no-messages' });
    expect(result).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // (b) Missing ctx.db → PRECONDITION_FAILED
  // -------------------------------------------------------------------------
  it('(b) missing ctx.db → TRPCError PRECONDITION_FAILED', async () => {
    const caller = appRouter.createCaller(createContext());

    await expect(
      caller.cyboflow.runs.listMessages({ runId: 'any-run-id' }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof TRPCError && err.code === 'PRECONDITION_FAILED',
    );
  });
});

// ---------------------------------------------------------------------------
// runs.getPhaseState integration tests (TASK-766)
//
// Tests use createTestDb (GATE_SCHEMA + migration 007) plus migration 011
// (current_step_id column) applied inline. The procedure's workflow JOIN
// and WorkflowDefinition resolution logic are exercised against real SQLite.
// ---------------------------------------------------------------------------

/**
 * Create a test DB with GATE_SCHEMA + migrations 007 and 011.
 * Migration 011 adds current_step_id TEXT to workflow_runs.
 */
function createTestDbWithStepTracking(): Database.Database {
  const db = createTestDb({ includeStuckDetectedAt: true });
  // Apply migration 011 inline (single-source: 011_workflow_step_tracking.sql).
  db.exec('ALTER TABLE workflow_runs ADD COLUMN current_step_id TEXT');
  return db;
}

/**
 * Seeds a workflow row with the given name and a workflow_run row.
 * Returns { workflowId, runId }.
 */
function seedPhaseRun(
  db: Database.Database,
  runId: string,
  workflowName: string,
  currentStepId: string | null = null,
): { workflowId: string; runId: string } {
  const workflowId = `wf-${runId}`;
  db.prepare(
    `INSERT INTO workflows (id, project_id, name, spec_json) VALUES (?, 1, ?, '{}')`,
  ).run(workflowId, workflowName);

  db.prepare(
    `INSERT INTO workflow_runs
       (id, workflow_id, project_id, worktree_path, status, policy_json, current_step_id)
     VALUES (?, ?, 1, '/tmp/test', 'running', '{}', ?)`,
  ).run(runId, workflowId, currentStepId);

  return { workflowId, runId };
}

describe('cyboflow.runs.getPhaseState', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDbWithStepTracking();
  });

  // -------------------------------------------------------------------------
  // (a) Returns correct WorkflowDefinition for known SoloFlowWorkflowName
  // -------------------------------------------------------------------------
  it('(a) returns correct WorkflowDefinition for known workflow name (soloflow)', async () => {
    const runId = 'run-gps-soloflow';
    seedPhaseRun(db, runId, 'soloflow', null);

    const adapter = dbAdapter(db);
    const caller = appRouter.createCaller(createContext({ db: adapter }));
    const result = await caller.cyboflow.runs.getPhaseState({ runId });

    expect(result.definition.id).toBe('soloflow');
    expect(result.definition.phases.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // (b) Throws NOT_FOUND for unknown workflow name
  // -------------------------------------------------------------------------
  it('(b) throws NOT_FOUND for unknown workflow name', async () => {
    const runId = 'run-gps-unknown-wf';
    seedPhaseRun(db, runId, 'unknown-workflow-name', null);

    const adapter = dbAdapter(db);
    const caller = appRouter.createCaller(createContext({ db: adapter }));

    await expect(
      caller.cyboflow.runs.getPhaseState({ runId }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof TRPCError && err.code === 'NOT_FOUND',
    );
  });

  // -------------------------------------------------------------------------
  // (c) Returns current_step_id verbatim — string case
  // -------------------------------------------------------------------------
  it('(c) returns current_step_id verbatim when set to a string', async () => {
    const runId = 'run-gps-step-string';
    // 'context' is the id of the first step in the soloflow 'plan' phase.
    seedPhaseRun(db, runId, 'soloflow', 'context');

    const adapter = dbAdapter(db);
    const caller = appRouter.createCaller(createContext({ db: adapter }));
    const result = await caller.cyboflow.runs.getPhaseState({ runId });

    expect(result.currentStepId).toBe('context');
  });

  // -------------------------------------------------------------------------
  // (c) Returns current_step_id verbatim — null case
  // -------------------------------------------------------------------------
  it('(c) returns null for current_step_id when column is NULL', async () => {
    const runId = 'run-gps-step-null';
    seedPhaseRun(db, runId, 'soloflow', null);

    const adapter = dbAdapter(db);
    const caller = appRouter.createCaller(createContext({ db: adapter }));
    const result = await caller.cyboflow.runs.getPhaseState({ runId });

    expect(result.currentStepId).toBeNull();
  });

  // -------------------------------------------------------------------------
  // (d) stepStates — null currentStepId → all pending
  // -------------------------------------------------------------------------
  it('(d) null currentStepId → all stepStates pending', async () => {
    const runId = 'run-gps-allpending';
    seedPhaseRun(db, runId, 'soloflow', null);

    const adapter = dbAdapter(db);
    const caller = appRouter.createCaller(createContext({ db: adapter }));
    const result = await caller.cyboflow.runs.getPhaseState({ runId });

    expect(result.stepStates.length).toBeGreaterThan(0);
    for (const ss of result.stepStates) {
      expect(ss.status).toBe('pending');
    }
  });

  // -------------------------------------------------------------------------
  // (d) stepStates — first step running, rest pending
  // -------------------------------------------------------------------------
  it('(d) first-step currentStepId → first running, rest pending', async () => {
    const runId = 'run-gps-first-step';
    // 'context' is the first step of soloflow (plan.context).
    seedPhaseRun(db, runId, 'soloflow', 'context');

    const adapter = dbAdapter(db);
    const caller = appRouter.createCaller(createContext({ db: adapter }));
    const result = await caller.cyboflow.runs.getPhaseState({ runId });

    const states = result.stepStates;
    expect(states[0].status).toBe('running');
    expect(states[0].stepId).toBe('context');
    for (const ss of states.slice(1)) {
      expect(ss.status).toBe('pending');
    }
  });

  // -------------------------------------------------------------------------
  // (d) stepStates — middle step running (done/running/pending split)
  // -------------------------------------------------------------------------
  it('(d) middle-step currentStepId → preceding done, matching running, trailing pending', async () => {
    const runId = 'run-gps-middle-step';
    // 'approve-idea' is the 3rd step (index 2) in soloflow plan phase.
    // Steps in order: context(0), research(1), approve-idea(2), epics(3), tasks(4), ...
    seedPhaseRun(db, runId, 'soloflow', 'approve-idea');

    const adapter = dbAdapter(db);
    const caller = appRouter.createCaller(createContext({ db: adapter }));
    const result = await caller.cyboflow.runs.getPhaseState({ runId });

    const states = result.stepStates;
    const matchIdx = states.findIndex((s) => s.stepId === 'approve-idea');
    expect(matchIdx).toBeGreaterThan(0);
    expect(states[matchIdx].status).toBe('running');

    for (let i = 0; i < matchIdx; i++) {
      expect(states[i].status).toBe('done');
    }
    for (let i = matchIdx + 1; i < states.length; i++) {
      expect(states[i].status).toBe('pending');
    }
  });

  // -------------------------------------------------------------------------
  // (d) stepStates — orphan id → all pending, no throw
  // -------------------------------------------------------------------------
  it('(d) orphan currentStepId (not in definition) → all pending, no throw', async () => {
    const runId = 'run-gps-orphan';
    seedPhaseRun(db, runId, 'soloflow', 'nonexistent.orphan-step');

    const adapter = dbAdapter(db);
    const caller = appRouter.createCaller(createContext({ db: adapter }));
    const result = await caller.cyboflow.runs.getPhaseState({ runId });

    expect(result.currentStepId).toBe('nonexistent.orphan-step');
    expect(result.stepStates.length).toBeGreaterThan(0);
    for (const ss of result.stepStates) {
      expect(ss.status).toBe('pending');
    }
  });

  // -------------------------------------------------------------------------
  // (e) Missing ctx.db → PRECONDITION_FAILED
  // -------------------------------------------------------------------------
  it('(e) missing ctx.db → TRPCError PRECONDITION_FAILED', async () => {
    const caller = appRouter.createCaller(createContext());

    await expect(
      caller.cyboflow.runs.getPhaseState({ runId: 'any-run-id' }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof TRPCError && err.code === 'PRECONDITION_FAILED',
    );
  });

  // -------------------------------------------------------------------------
  // (f) Non-existent runId → NOT_FOUND
  // -------------------------------------------------------------------------
  it('(f) non-existent runId → TRPCError NOT_FOUND', async () => {
    const adapter = dbAdapter(db);
    const caller = appRouter.createCaller(createContext({ db: adapter }));

    await expect(
      caller.cyboflow.runs.getPhaseState({ runId: 'does-not-exist' }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof TRPCError && err.code === 'NOT_FOUND',
    );
  });

  // -------------------------------------------------------------------------
  // (g) Terminal run status: completed → current step is 'done' not 'running'
  //
  // This covers the race condition where both 'running' and 'done' subscription
  // events arrive before the getPhaseState query resolves and are silently
  // dropped by useWorkflowPhaseState's mergeTransition (definition is null at
  // that point). Without this fix the current step would appear as 'running'
  // forever even though the run has completed.
  // -------------------------------------------------------------------------
  it('(g) completed run: current step returns status=done not running', async () => {
    const runId = 'run-gps-completed';
    // Seed the run with status='completed' and current_step_id set.
    const workflowId = `wf-${runId}`;
    db.prepare(
      `INSERT INTO workflows (id, project_id, name, spec_json) VALUES (?, 1, ?, '{}')`,
    ).run(workflowId, 'soloflow');
    db.prepare(
      `INSERT INTO workflow_runs
         (id, workflow_id, project_id, worktree_path, status, policy_json, current_step_id)
       VALUES (?, ?, 1, '/tmp/test', 'completed', '{}', ?)`,
    ).run(runId, workflowId, 'context');

    const adapter = dbAdapter(db);
    const caller = appRouter.createCaller(createContext({ db: adapter }));
    const result = await caller.cyboflow.runs.getPhaseState({ runId });

    // The current step must be 'done' because the run is completed.
    const currentStep = result.stepStates.find((s) => s.stepId === 'context');
    expect(currentStep, 'context step not found in stepStates').toBeDefined();
    expect(currentStep!.status).toBe('done');

    // Steps before 'context' (none in this case) must be 'done'.
    // Steps after 'context' must be 'pending'.
    const currentIdx = result.stepStates.findIndex((s) => s.stepId === 'context');
    for (let i = 0; i < currentIdx; i++) {
      expect(result.stepStates[i].status).toBe('done');
    }
    for (let i = currentIdx + 1; i < result.stepStates.length; i++) {
      expect(result.stepStates[i].status).toBe('pending');
    }
  });

  it('(g) failed run: current step returns status=done not running', async () => {
    const runId = 'run-gps-failed';
    const workflowId = `wf-${runId}`;
    db.prepare(
      `INSERT INTO workflows (id, project_id, name, spec_json) VALUES (?, 1, ?, '{}')`,
    ).run(workflowId, 'sprint');
    db.prepare(
      `INSERT INTO workflow_runs
         (id, workflow_id, project_id, worktree_path, status, policy_json, current_step_id)
       VALUES (?, ?, 1, '/tmp/test', 'failed', '{}', ?)`,
    ).run(runId, workflowId, 'implement');

    const adapter = dbAdapter(db);
    const caller = appRouter.createCaller(createContext({ db: adapter }));
    const result = await caller.cyboflow.runs.getPhaseState({ runId });

    const implementStep = result.stepStates.find((s) => s.stepId === 'implement');
    expect(implementStep, 'implement step not found in stepStates').toBeDefined();
    expect(implementStep!.status).toBe('done');
  });

  it('(g) canceled run: current step returns status=done not running', async () => {
    const runId = 'run-gps-canceled';
    const workflowId = `wf-${runId}`;
    db.prepare(
      `INSERT INTO workflows (id, project_id, name, spec_json) VALUES (?, 1, ?, '{}')`,
    ).run(workflowId, 'planner');
    db.prepare(
      `INSERT INTO workflow_runs
         (id, workflow_id, project_id, worktree_path, status, policy_json, current_step_id)
       VALUES (?, ?, 1, '/tmp/test', 'canceled', '{}', ?)`,
    ).run(runId, workflowId, 'tasks');

    const adapter = dbAdapter(db);
    const caller = appRouter.createCaller(createContext({ db: adapter }));
    const result = await caller.cyboflow.runs.getPhaseState({ runId });

    const tasksStep = result.stepStates.find((s) => s.stepId === 'tasks');
    expect(tasksStep, 'tasks step not found in stepStates').toBeDefined();
    expect(tasksStep!.status).toBe('done');
  });

  it('(g) running status: current step remains status=running (not terminal)', async () => {
    // Verify the fix does not regress live runs.
    const runId = 'run-gps-still-running';
    seedPhaseRun(db, runId, 'soloflow', 'context');

    const adapter = dbAdapter(db);
    const caller = appRouter.createCaller(createContext({ db: adapter }));
    const result = await caller.cyboflow.runs.getPhaseState({ runId });

    const contextStep = result.stepStates.find((s) => s.stepId === 'context');
    expect(contextStep, 'context step not found in stepStates').toBeDefined();
    expect(contextStep!.status).toBe('running');
  });
});

// ---------------------------------------------------------------------------
// runs.onStepTransition integration tests (TASK-766)
//
// Tests emit directly on the stepTransitionEvents EventEmitter and assert
// that the subscription correctly filters by runId.
// ---------------------------------------------------------------------------

describe('cyboflow.runs.onStepTransition', () => {
  afterEach(() => {
    // Remove all 'transition' listeners to prevent cross-test leaks.
    stepTransitionEvents.removeAllListeners('transition');
  });

  // -------------------------------------------------------------------------
  // (a) RunId filter: two events emitted → only matching runId is yielded
  // -------------------------------------------------------------------------
  it('(a) filters events by runId: yields only the matching runId event', async () => {
    const targetRunId = 'run-A';
    const otherRunId = 'run-B';

    const controller = new AbortController();

    // Call the subscription procedure via callProcedure (createCaller doesn't
    // support subscriptions in tRPC v11).
    const result = await callProcedure({
      router: appRouter,
      ctx: createContext(),
      path: 'cyboflow.runs.onStepTransition',
      type: 'subscription',
      getRawInput: async () => ({ runId: targetRunId }),
      input: { runId: targetRunId },
      signal: controller.signal,
      batchIndex: 0,
    });

    expect(isAsyncIterable(result)).toBe(true);
    const iterable = result as AsyncIterable<WorkflowStepTransitionEvent>;

    const collected: WorkflowStepTransitionEvent[] = [];

    // Emit events on the next tick so that the EventEmitter listener
    // (registered inside eventToAsyncIterable's [Symbol.asyncIterator]) is
    // already set up by the time the events arrive. Using setImmediate/Promise
    // microtask: the for-await loop calls [Symbol.asyncIterator]() synchronously
    // before the first await, which registers the listener — so emitting on
    // queueMicrotask/Promise.resolve() is sufficient.
    const evB: WorkflowStepTransitionEvent = {
      runId: otherRunId,
      stepId: 'implement',
      status: 'running',
      timestamp: new Date().toISOString(),
    };
    const evA: WorkflowStepTransitionEvent = {
      runId: targetRunId,
      stepId: 'implement',
      status: 'running',
      timestamp: new Date().toISOString(),
    };

    // Schedule emission and abort on a macrotask so the for-await iterator
    // has time to register its listener and reach its awaiting state.
    setTimeout(() => {
      stepTransitionEvents.emit('transition', evB);
      stepTransitionEvents.emit('transition', evA);
    }, 0);

    // Collect events; abort after receiving the first matching one to prevent
    // the loop from hanging indefinitely.
    for await (const ev of iterable) {
      collected.push(ev);
      // Abort after collecting the first matching event so the loop exits.
      controller.abort();
    }

    expect(collected).toHaveLength(1);
    expect(collected[0].runId).toBe(targetRunId);
  }, 10000);
});

// ---------------------------------------------------------------------------
// end-to-end stepId contract parity (TERMINAL_STEP_IDS resolves into
// WORKFLOW_DEFINITIONS — fixes namespace mismatch, FIND-SPRINT-040-10/13)
//
// For every SOLOFLOW_WORKFLOW_NAMES entry, calls buildStepTransitionEvent with
// the resolveTerminalStepId output, then asserts getPhaseState returns a
// stepStates entry with status='running' for that stepId. This locks the
// contract against future namespace drift between the emitter and the consumer.
// ---------------------------------------------------------------------------

describe('end-to-end stepId contract parity (TERMINAL_STEP_IDS resolves into WORKFLOW_DEFINITIONS — fixes namespace mismatch)', () => {
  for (const name of SOLOFLOW_WORKFLOW_NAMES) {
    it(`${name}: buildStepTransitionEvent → getPhaseState yields status=running for the resolved terminal step`, async () => {
      const stepId = resolveTerminalStepId(name);
      expect(stepId).not.toBeNull();

      const db = createTestDbWithStepTracking();
      const adapter = dbAdapter(db);
      const caller = appRouter.createCaller(createContext({ db: adapter }));

      // Seed a run with currentStepId=null so no step is pre-marked.
      const runId = `run-contract-${name}`;
      seedPhaseRun(db, runId, name, null);

      // buildStepTransitionEvent writes current_step_id and emits on stepTransitionEvents.
      buildStepTransitionEvent(runId, stepId!, 'running', adapter);

      // getPhaseState reads current_step_id from DB and resolves stepStates.
      const result = await caller.cyboflow.runs.getPhaseState({ runId });

      const match = result.stepStates.find((s) => s.stepId === stepId);
      expect(match, `No stepState found for stepId '${stepId}' in ${name} workflow`).toBeDefined();
      expect(match!.status).toBe('running');
    });
  }

  afterEach(() => {
    stepTransitionEvents.removeAllListeners('transition');
  });
});
