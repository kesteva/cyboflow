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
 *  (a) Returns correct WorkflowDefinition for known CyboflowWorkflowName.
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
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { appRouter } from '../../router';
import { createContext } from '../../context';
import { dbAdapter } from '../../../__test_fixtures__/dbAdapter';
import { setStartRunDeps, setRunCloseoutDeps, setNudgeRunDeps, setRelayDeps, setCancelRunDeps, setPauseRunDeps, setResumeRunDeps, setSetPermissionModeDeps } from '../runs';
import type { RunWorktreeManagerLike, RelayDeps } from '../runs';
import type { SessionAgentPermissionModeDeps } from '../../../sessionPermissionMode';
import type { PermissionMode } from '../../../../../../shared/types/workflows';
import type { CancelRunDeps, CancelRunResult } from '../../../cancelRunHandler';
import type { PauseRunDeps, PauseRunResult } from '../../../pauseRunHandler';
import type { ResumeRunDeps, ResumeRunResult } from '../../../resumeRunHandler';
import { RunQueueRegistry } from '../../../RunQueueRegistry';
import { ApprovalRouter } from '../../../approvalRouter';
import { createTestDb, seedRun, seedApproval } from '../../../__test_fixtures__/orchestratorTestDb';
import { stepTransitionEvents } from '../events';
import type { WorkflowStepTransitionEvent, WorkflowDefinition } from '../../../../../../shared/types/workflows';
import { buildStepTransitionEvent, resolveInitialStepId } from '../../../stepTransitionBridge';
import { CYBOFLOW_WORKFLOW_NAMES } from '../../../../../../shared/types/workflows';

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

/**
 * A RelayDeps bag whose every method throws "not wired" — used to RESET the
 * module-level relayDeps after a test wires real spies, so a wired stub does
 * not leak into another describe block. `endSession` is async (IDEA-030 /
 * TASK-818) so its reject is a rejected promise, mirroring the unwired-guard
 * contract of the sync relay methods.
 */
function makeUnwiredRelayDeps(): RelayDeps {
  return {
    relayInput: vi.fn(() => {
      throw new Error('not wired');
    }),
    relayResize: vi.fn(() => {
      throw new Error('not wired');
    }),
    endSession: vi.fn(async () => {
      throw new Error('not wired');
    }),
    killSession: vi.fn(async () => {
      throw new Error('not wired');
    }),
    getPtyBacklog: vi.fn(() => {
      throw new Error('not wired');
    }),
  };
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
    // createTestDb applies GATE_SCHEMA (migration 006 equivalent) + migration 007
    // (stuck_detected_at). listRunsHandler's SELECT also projects `substrate`
    // (migration 013), which GATE_SCHEMA omits — so opt in via includeSubstrate.
    db = createTestDb({ includeStuckDetectedAt: true, includeSubstrate: true });
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
      const result = await caller.cyboflow.runs.start({ workflowId: 'wf-abc', projectId: 1, sessionId: 'sess-1' });

      expect(result).toEqual({
        runId: 'run-start-abc',
        worktreePath: '/tmp/wt/abc',
        branchName: 'cyboflow/my-workflow/abc12345',
      });

      // The explicit launch projectId (migration 030 — global workflows) is now
      // ALWAYS threaded, and (permission-mode redesign slice 1a) sessionId is now
      // REQUIRED at the tRPC boundary: start calls the full-form launch with every
      // optional arg undefined EXCEPT sessionId (6th slot) and the trailing
      // projectId (10th slot), so createRun can stamp both workflow_runs.session_id
      // and project_id even for a GLOBAL flow (workflow.project_id NULL).
      expect(launchMock).toHaveBeenCalledOnce();
      expect(launchMock).toHaveBeenCalledWith('wf-abc', '/projects/my-project', undefined, undefined, undefined, 'sess-1', undefined, undefined, undefined, 1, undefined, undefined, undefined);
    } finally {
      // Reset module state regardless of test outcome.
      setStartRunDeps({
        runLauncher: { launch: vi.fn().mockRejectedValue(new Error('not wired')) },
        sessionManager: { getProjectById: () => undefined },
      });
    }
  });

  // -------------------------------------------------------------------------
  // (a2) ideaId supplied (migration 017) → full-form launch with the seed idea.
  // -------------------------------------------------------------------------
  it('(a2) ideaId supplied → forwards the full-form launch with the seed idea', async () => {
    const launchMock = vi.fn().mockResolvedValue({
      runId: 'run-start-idea',
      worktreePath: '/tmp/wt/idea',
      branchName: 'cyboflow/planner/idea1234',
    });
    const sessionManagerStub = {
      getProjectById: (_id: number) => ({ path: '/projects/my-project' }),
    };

    setStartRunDeps({ runLauncher: { launch: launchMock }, sessionManager: sessionManagerStub });

    try {
      const caller = appRouter.createCaller(createContext());
      await caller.cyboflow.runs.start({ workflowId: 'wf-planner', projectId: 1, sessionId: 'sess-1', ideaId: 'IDEA-7' });

      // With an ideaId present, start calls the full-form launch — substrate +
      // taskId undefined, ideaId in the 5th slot, the now-REQUIRED sessionId (6th)
      // 'sess-1', requestedPermissionMode (7th) + baseBranch (8th) + seedTaskIds
      // (9th) undefined, and the explicit launch projectId (migration 030) in the
      // 10th slot — so the launcher writes workflow_runs.seed_idea_id directly (no
      // stage derivation).
      expect(launchMock).toHaveBeenCalledOnce();
      expect(launchMock).toHaveBeenCalledWith('wf-planner', '/projects/my-project', undefined, undefined, 'IDEA-7', 'sess-1', undefined, undefined, undefined, 1, undefined, undefined, undefined);
    } finally {
      setStartRunDeps({
        runLauncher: { launch: vi.fn().mockRejectedValue(new Error('not wired')) },
        sessionManager: { getProjectById: () => undefined },
      });
    }
  });

  // -------------------------------------------------------------------------
  // (a3) sessionId supplied (Phase 1 / migration 019) → full-form launch hosting
  // the run inside the session worktree.
  // -------------------------------------------------------------------------
  it('(a3) sessionId supplied → forwards the full-form launch with the session host', async () => {
    const launchMock = vi.fn().mockResolvedValue({
      runId: 'run-start-sess',
      worktreePath: '/projects/my-project/.worktrees/sess',
      branchName: 'feature/sess',
    });
    const sessionManagerStub = {
      getProjectById: (_id: number) => ({ path: '/projects/my-project' }),
    };

    setStartRunDeps({ runLauncher: { launch: launchMock }, sessionManager: sessionManagerStub });

    try {
      const caller = appRouter.createCaller(createContext());
      await caller.cyboflow.runs.start({ workflowId: 'wf-sprint', projectId: 1, sessionId: 'sess-7' });

      // With a sessionId present, start calls the full-form launch — substrate +
      // taskId + ideaId undefined, sessionId in the 6th slot, requestedPermissionMode
      // (7th) + baseBranch (8th) + seedTaskIds (9th) undefined, and the explicit
      // launch projectId (migration 030) in the 10th slot — so the launcher hosts
      // the run inside the session's existing worktree.
      expect(launchMock).toHaveBeenCalledOnce();
      expect(launchMock).toHaveBeenCalledWith('wf-sprint', '/projects/my-project', undefined, undefined, undefined, 'sess-7', undefined, undefined, undefined, 1, undefined, undefined, undefined);
    } finally {
      setStartRunDeps({
        runLauncher: { launch: vi.fn().mockRejectedValue(new Error('not wired')) },
        sessionManager: { getProjectById: () => undefined },
      });
    }
  });

  // -------------------------------------------------------------------------
  // (a4) permissionMode supplied (WorkflowPicker) → full-form launch carrying the
  // per-run agent permission override into the 7th launch slot.
  // -------------------------------------------------------------------------
  it('(a4) permissionMode supplied → forwards the full-form launch with the per-run override', async () => {
    const launchMock = vi.fn().mockResolvedValue({
      runId: 'run-start-perm',
      worktreePath: '/tmp/wt/perm',
      branchName: 'cyboflow/sprint/perm1234',
    });
    const sessionManagerStub = {
      getProjectById: (_id: number) => ({ path: '/projects/my-project' }),
    };

    setStartRunDeps({ runLauncher: { launch: launchMock }, sessionManager: sessionManagerStub });

    try {
      const caller = appRouter.createCaller(createContext());
      await caller.cyboflow.runs.start({ workflowId: 'wf-sprint', projectId: 1, sessionId: 'sess-1', permissionMode: 'auto' });

      // With permissionMode present, start calls the full-form launch —
      // substrate/taskId/ideaId undefined, the now-REQUIRED sessionId (6th)
      // 'sess-1', permissionMode 'auto' in the 7th slot, baseBranch (8th) +
      // seedTaskIds (9th) undefined, and the explicit launch projectId (migration
      // 030) in the 10th slot.
      expect(launchMock).toHaveBeenCalledOnce();
      expect(launchMock).toHaveBeenCalledWith('wf-sprint', '/projects/my-project', undefined, undefined, undefined, 'sess-1', 'auto', undefined, undefined, 1, undefined, undefined, undefined);
    } finally {
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
        caller.cyboflow.runs.start({ workflowId: 'wf-missing', projectId: 999, sessionId: 'sess-1' }),
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

  // -------------------------------------------------------------------------
  // (a5) findingIds supplied (findings-triage / migration 034) → full-form launch
  // carrying the selected compound findings into the 12th (LAST) launch slot,
  // AFTER projectId and the requestedExecutionModel placeholder. The full
  // positional vector is asserted — including the baseBranch placeholder in slot
  // 8 and the requestedExecutionModel placeholder in slot 11, both undefined.
  // -------------------------------------------------------------------------
  it('(a5) findingIds supplied → forwards the full-form launch with the seed findings as the LAST positional arg', async () => {
    const launchMock = vi.fn().mockResolvedValue({
      runId: 'run-start-find',
      worktreePath: '/tmp/wt/find',
      branchName: 'cyboflow/compound/find1234',
    });
    const sessionManagerStub = {
      getProjectById: (_id: number) => ({ path: '/projects/my-project' }),
    };

    setStartRunDeps({ runLauncher: { launch: launchMock }, sessionManager: sessionManagerStub });

    try {
      const caller = appRouter.createCaller(createContext());
      await caller.cyboflow.runs.start({
        workflowId: 'wf-compound',
        projectId: 1,
        sessionId: 'sess-1',
        findingIds: ['rvw_a', 'rvw_b'],
      });

      // With findingIds present, start calls the full-form launch — every optional
      // arg undefined EXCEPT the now-REQUIRED sessionId (6th slot), the launch
      // projectId (10th slot) and findingIds (12th, LAST slot). Positions 8
      // (baseBranch) and 11 (requestedExecutionModel) stay undefined.
      expect(launchMock).toHaveBeenCalledOnce();
      expect(launchMock).toHaveBeenCalledWith(
        'wf-compound',
        '/projects/my-project',
        undefined, // substrate
        undefined, // taskId
        undefined, // ideaId
        'sess-1', // sessionId
        undefined, // permissionMode
        undefined, // baseBranch (position 8 placeholder)
        undefined, // taskIds
        1, // projectId (10th)
        undefined, // requestedExecutionModel (11th placeholder)
        ['rvw_a', 'rvw_b'], // findingIds (12th)
        undefined, // requestedModel (13th, LAST — not requested)
      );
    } finally {
      setStartRunDeps({
        runLauncher: { launch: vi.fn().mockRejectedValue(new Error('not wired')) },
        sessionManager: { getProjectById: () => undefined },
      });
    }
  });

  // -------------------------------------------------------------------------
  // (a6) findingIds omitted → back-compat: the 11th slot is undefined (the full
  // positional vector matches the (a) happy path with a trailing undefined).
  // -------------------------------------------------------------------------
  it('(a6) findingIds omitted → forwards undefined in the LAST (11th) positional slot', async () => {
    const launchMock = vi.fn().mockResolvedValue({
      runId: 'run-start-nofind',
      worktreePath: '/tmp/wt/nofind',
      branchName: 'cyboflow/sprint/nofind12',
    });
    const sessionManagerStub = {
      getProjectById: (_id: number) => ({ path: '/projects/my-project' }),
    };

    setStartRunDeps({ runLauncher: { launch: launchMock }, sessionManager: sessionManagerStub });

    try {
      const caller = appRouter.createCaller(createContext());
      await caller.cyboflow.runs.start({ workflowId: 'wf-sprint', projectId: 1, sessionId: 'sess-1' });

      expect(launchMock).toHaveBeenCalledOnce();
      expect(launchMock).toHaveBeenCalledWith(
        'wf-sprint',
        '/projects/my-project',
        undefined, // substrate
        undefined, // taskId
        undefined, // ideaId
        'sess-1', // sessionId
        undefined, // permissionMode
        undefined, // baseBranch (position 8 placeholder)
        undefined, // taskIds
        1, // projectId (10th)
        undefined, // requestedExecutionModel (11th placeholder)
        undefined, // findingIds (12th — omitted)
        undefined, // requestedModel (13th, LAST — omitted)
      );
    } finally {
      setStartRunDeps({
        runLauncher: { launch: vi.fn().mockRejectedValue(new Error('not wired')) },
        sessionManager: { getProjectById: () => undefined },
      });
    }
  });

  // -------------------------------------------------------------------------
  // (a7) model supplied (migration 037) → forwarded into the 13th (LAST) launch
  // slot as requestedModel, so createRun stamps workflow_runs.model.
  // -------------------------------------------------------------------------
  it('(a7) model supplied → forwards the per-run model into the LAST (13th) launch slot', async () => {
    const launchMock = vi.fn().mockResolvedValue({
      runId: 'run-start-model',
      worktreePath: '/tmp/wt/model',
      branchName: 'cyboflow/sprint/model12',
    });
    const sessionManagerStub = {
      getProjectById: (_id: number) => ({ path: '/projects/my-project' }),
    };

    setStartRunDeps({ runLauncher: { launch: launchMock }, sessionManager: sessionManagerStub });

    try {
      const caller = appRouter.createCaller(createContext());
      await caller.cyboflow.runs.start({ workflowId: 'wf-sprint', projectId: 1, model: 'opus' });

      expect(launchMock).toHaveBeenCalledOnce();
      expect(launchMock).toHaveBeenCalledWith(
        'wf-sprint',
        '/projects/my-project',
        undefined, // substrate
        undefined, // taskId
        undefined, // ideaId
        undefined, // sessionId
        undefined, // permissionMode
        undefined, // baseBranch (position 8 placeholder)
        undefined, // taskIds
        1, // projectId (10th)
        undefined, // requestedExecutionModel (11th placeholder)
        undefined, // findingIds (12th)
        'opus', // requestedModel (13th, LAST)
      );
    } finally {
      setStartRunDeps({
        runLauncher: { launch: vi.fn().mockRejectedValue(new Error('not wired')) },
        sessionManager: { getProjectById: () => undefined },
      });
    }
  });

  // -------------------------------------------------------------------------
  // (a7) findingIds = [] → Zod rejects the empty array (the array elements are
  // non-empty strings but the schema does not constrain length; an EMPTY array is
  // a valid Zod value, so it reaches launch as []). The launcher enforces the
  // non-empty guard (covered in runLauncher.test.ts); here we assert the router
  // forwards [] verbatim in the LAST slot (now the 12th, after the
  // requestedExecutionModel placeholder) rather than coercing it away.
  // -------------------------------------------------------------------------
  it('(a7) findingIds = [] → forwarded verbatim as the LAST positional arg (launcher enforces non-empty)', async () => {
    const launchMock = vi.fn().mockResolvedValue({
      runId: 'run-start-emptyfind',
      worktreePath: '/tmp/wt/emptyfind',
      branchName: 'cyboflow/compound/empty123',
    });
    const sessionManagerStub = {
      getProjectById: (_id: number) => ({ path: '/projects/my-project' }),
    };

    setStartRunDeps({ runLauncher: { launch: launchMock }, sessionManager: sessionManagerStub });

    try {
      const caller = appRouter.createCaller(createContext());
      await caller.cyboflow.runs.start({ workflowId: 'wf-compound', projectId: 1, sessionId: 'sess-1', findingIds: [] });

      expect(launchMock).toHaveBeenCalledOnce();
      const lastArg = launchMock.mock.calls[0][11] as string[] | undefined;
      expect(lastArg).toEqual([]);
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
// cyboflow.runs.nudge — Piece C idle-chat nudge (router delegation)
//
// The handler's full guard matrix is covered in nudgeRunHandler.test.ts; here we
// verify the router forwards { runId, text } to the wired handler and returns
// its result verbatim. METHOD_NOT_SUPPORTED-when-unwired follows the same
// per-file-module-isolation rationale documented for runs.start above.
// ---------------------------------------------------------------------------

describe('cyboflow.runs.nudge', () => {
  it('forwards a delivered nudge: flips the run to running and returns { delivered: true }', async () => {
    const db = createTestDb({ disableForeignKeys: true });
    db.exec('ALTER TABLE workflow_runs ADD COLUMN claude_session_id TEXT');
    const { runId } = seedRun(db, { status: 'awaiting_review' });
    db.prepare('UPDATE workflow_runs SET claude_session_id = ? WHERE id = ?').run('sess-1', runId);

    const execute = vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined);
    const setPendingNudge = vi.fn<(id: string, text: string) => void>();
    setNudgeRunDeps({
      db: dbAdapter(db),
      runQueues: new RunQueueRegistry(),
      runExecutor: { setPendingNudge, execute },
    });

    try {
      const caller = appRouter.createCaller(createContext());
      const result = await caller.cyboflow.runs.nudge({ runId, text: 'keep going' });

      expect(result).toEqual({ delivered: true });
      expect(setPendingNudge).toHaveBeenCalledWith(runId, 'keep going');
      expect(execute).toHaveBeenCalledWith(runId);
      const row = db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as { status: string };
      expect(row.status).toBe('running');
    } finally {
      db.close();
    }
  });

  it('forwards a noOp result verbatim (idle guard: not_idle)', async () => {
    const db = createTestDb({ disableForeignKeys: true });
    db.exec('ALTER TABLE workflow_runs ADD COLUMN claude_session_id TEXT');
    const { runId } = seedRun(db, { status: 'running' });

    const execute = vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined);
    setNudgeRunDeps({
      db: dbAdapter(db),
      runQueues: new RunQueueRegistry(),
      runExecutor: { setPendingNudge: vi.fn(), execute },
    });

    try {
      const caller = appRouter.createCaller(createContext());
      const result = await caller.cyboflow.runs.nudge({ runId, text: 'hi' });

      expect(result).toEqual({ noOp: true, reason: 'not_idle' });
      expect(execute).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// cyboflow.runs.cancel — git-neutral run Cancel (Phase 4a, router delegation).
//
// The handler's full guard matrix is covered in cancelRunHandler.test.ts; here we
// verify that once wired the router forwards { runId } to the injected handler deps
// and returns the result verbatim. A fake CancelRunDeps is injected via
// setCancelRunDeps() so the test stays free of the SubstrateDispatchFacade /
// services-*. The METHOD_NOT_SUPPORTED-when-unwired path is covered by the
// separately-loaded module instance in router.test.ts (per-file module isolation
// guarantees cancelRunDeps === null there) — same rationale documented for
// runs.start above, so this block deliberately sets deps and does not reset them.
// ---------------------------------------------------------------------------

describe('cyboflow.runs.cancel (Phase 4a)', () => {
  /** A CancelRunDeps whose collaborators are vi.fn() spies over a real in-memory DB. */
  function makeFakeCancelDeps(
    db: Database.Database,
    overrides?: Partial<CancelRunDeps>,
  ): CancelRunDeps {
    return {
      db: dbAdapter(db),
      runQueues: new RunQueueRegistry(),
      stopLiveRun: vi.fn<CancelRunDeps['stopLiveRun']>().mockResolvedValue(undefined),
      clearPendingApprovalsForRun: vi.fn<CancelRunDeps['clearPendingApprovalsForRun']>(),
      clearPendingQuestionsForRun: vi.fn<NonNullable<CancelRunDeps['clearPendingQuestionsForRun']>>(),
      emitRunStatusChanged: vi.fn<CancelRunDeps['emitRunStatusChanged']>(),
      ...overrides,
    };
  }

  // (b) WIRED — delegates to the handler and returns its { success: true } result.
  it('(b) delegates to the handler and returns { success: true } for a running run', async () => {
    const db = createTestDb({ includeWorkflowRunTaskColumns: true });
    const { runId } = seedRun(db, { status: 'running' });
    const stopLiveRun = vi.fn<CancelRunDeps['stopLiveRun']>().mockResolvedValue(undefined);
    const emitRunStatusChanged = vi.fn<CancelRunDeps['emitRunStatusChanged']>();
    setCancelRunDeps(makeFakeCancelDeps(db, { stopLiveRun, emitRunStatusChanged }));

    try {
      const caller = appRouter.createCaller(createContext());
      const result: CancelRunResult = await caller.cyboflow.runs.cancel({ runId });

      expect(result).toEqual({ success: true });
      expect(stopLiveRun).toHaveBeenCalledWith(runId);
      expect(emitRunStatusChanged).toHaveBeenCalledWith(runId, 'canceled');
      const row = db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as { status: string };
      expect(row.status).toBe('canceled');
    } finally {
      db.close();
    }
  });

  // (b2) WIRED — forwards a noOp result verbatim (already-terminal idempotent path).
  it('(b2) forwards a noOp { reason: already_terminal } result verbatim', async () => {
    const db = createTestDb({ includeWorkflowRunTaskColumns: true });
    const { runId } = seedRun(db, { status: 'completed' });
    const stopLiveRun = vi.fn<CancelRunDeps['stopLiveRun']>().mockResolvedValue(undefined);
    setCancelRunDeps(makeFakeCancelDeps(db, { stopLiveRun }));

    try {
      const caller = appRouter.createCaller(createContext());
      const result: CancelRunResult = await caller.cyboflow.runs.cancel({ runId });

      expect(result).toEqual({ noOp: true, reason: 'already_terminal' });
      expect(stopLiveRun).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// cyboflow.runs.setPermissionMode — session-mode write chokepoint (permission-
// mode redesign §3d / Slice 5).
//
// The mutation no longer writes workflow_runs.permission_mode_snapshot (demoted
// to a launch-time audit value). It resolves the OWNING session from the run via
// ctx.db (createContext({ db }), the includeSubstrate schema carries session_id)
// and re-routes through the SHARED updateSessionAgentPermissionMode chokepoint,
// injected here via setSetPermissionModeDeps as a fake whose DatabaseService /
// SessionManager / InteractiveSettingsWriter are spies. We verify: the session is
// persisted, 'session-updated' fires, the interactive .claude/settings.json is
// re-primed, a TERMINAL flow run STILL writes the session (bug #4), and a NULL
// session_id returns 'not_found' (never 'already_terminal').
// ---------------------------------------------------------------------------

/**
 * Build a fake SessionAgentPermissionModeDeps whose collaborators are spies, so
 * tests can assert the four chokepoint side effects without a real sessions table.
 * The interactive re-prime calls the REAL fs.existsSync(worktreePath), so
 * `worktreePath` defaults to an existing dir (os.tmpdir()).
 */
function makeFakePermDeps(opts: {
  substrate?: string;
  worktreePath?: string;
  isDemoMode?: boolean;
  updateReturns?: boolean;
} = {}) {
  const runtimeSession: { id: string; agentPermissionMode: PermissionMode } = {
    id: 'sess-runtime',
    agentPermissionMode: 'default',
  };
  const updateSession = vi.fn(() => (opts.updateReturns === false ? undefined : { id: 'sess-runtime' }));
  const dbGetSession = vi.fn(() => ({
    substrate: opts.substrate,
    worktree_path: opts.worktreePath ?? os.tmpdir(),
  }));
  const getSession = vi.fn(() => runtimeSession);
  const emit = vi.fn();
  const write = vi.fn();
  const remove = vi.fn();
  const deps: SessionAgentPermissionModeDeps = {
    databaseService: { updateSession, getSession: dbGetSession },
    sessionManager: { getSession, emit },
    configManager: { isDemoMode: () => opts.isDemoMode ?? false },
    settingsWriter: { write, remove },
  };
  return { deps, updateSession, dbGetSession, getSession, emit, write, remove, runtimeSession };
}

describe('cyboflow.runs.setPermissionMode (Slice 5 — session chokepoint)', () => {
  let db: Database.Database;

  beforeEach(() => {
    // includeSubstrate layers migration 019's session_id column onto workflow_runs.
    db = createTestDb({ includeSubstrate: true });
  });

  afterEach(() => {
    db.close();
    // Reset the module-level dep-bag so a wired fake never leaks into another block.
    setSetPermissionModeDeps(null as unknown as SessionAgentPermissionModeDeps);
  });

  /** Seed a run and stamp its session_id (migration 019 column). */
  function seedRunWithSession(
    status: 'running' | 'paused' | 'completed' | 'failed' | 'canceled',
    sessionId: string | null,
  ): string {
    const { runId } = seedRun(db, { status });
    db.prepare('UPDATE workflow_runs SET session_id = ? WHERE id = ?').run(sessionId, runId);
    return runId;
  }

  it('(a) running run → { updated: true }: persists the session mode + fires session-updated', async () => {
    const runId = seedRunWithSession('running', 'sess-runtime');
    const fake = makeFakePermDeps({ substrate: 'sdk' });
    setSetPermissionModeDeps(fake.deps);

    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    const result = await caller.cyboflow.runs.setPermissionMode({ runId, permissionMode: 'auto' });

    expect(result).toEqual({ updated: true });
    expect(fake.updateSession).toHaveBeenCalledWith('sess-runtime', { agent_permission_mode: 'auto' });
    expect(fake.emit).toHaveBeenCalledWith('session-updated', expect.anything());
    expect(fake.runtimeSession.agentPermissionMode).toBe('auto');
    // The SDK substrate never touches the interactive settings file.
    expect(fake.write).not.toHaveBeenCalled();
    expect(fake.remove).not.toHaveBeenCalled();
  });

  it('(a2) interactive session → re-primes .claude/settings.json (writer.write for acceptEdits)', async () => {
    const worktree = os.tmpdir();
    const runId = seedRunWithSession('running', 'sess-runtime');
    const fake = makeFakePermDeps({ substrate: 'interactive', worktreePath: worktree });
    setSetPermissionModeDeps(fake.deps);

    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    const result = await caller.cyboflow.runs.setPermissionMode({ runId, permissionMode: 'acceptEdits' });

    expect(result).toEqual({ updated: true });
    expect(fake.write).toHaveBeenCalledWith(worktree, { permissionMode: 'acceptEdits' });
    expect(fake.remove).not.toHaveBeenCalled();
  });

  it('(a3) interactive session → strips the hook (writer.remove) for dontAsk', async () => {
    const worktree = os.tmpdir();
    const runId = seedRunWithSession('running', 'sess-runtime');
    const fake = makeFakePermDeps({ substrate: 'interactive', worktreePath: worktree });
    setSetPermissionModeDeps(fake.deps);

    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    await caller.cyboflow.runs.setPermissionMode({ runId, permissionMode: 'dontAsk' });

    expect(fake.remove).toHaveBeenCalledWith(worktree);
    expect(fake.write).not.toHaveBeenCalled();
  });

  it('(b) TERMINAL flow run STILL writes the session (bug #4 — no terminal guard)', async () => {
    const runId = seedRunWithSession('completed', 'sess-runtime');
    const fake = makeFakePermDeps({ substrate: 'sdk' });
    setSetPermissionModeDeps(fake.deps);

    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    const result = await caller.cyboflow.runs.setPermissionMode({ runId, permissionMode: 'dontAsk' });

    expect(result).toEqual({ updated: true });
    expect(fake.updateSession).toHaveBeenCalledWith('sess-runtime', { agent_permission_mode: 'dontAsk' });
  });

  it('(c) unknown run → { noOp: true, reason: not_found }', async () => {
    const fake = makeFakePermDeps({ substrate: 'sdk' });
    setSetPermissionModeDeps(fake.deps);
    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    const result = await caller.cyboflow.runs.setPermissionMode({
      runId: 'no-such-run',
      permissionMode: 'acceptEdits',
    });
    expect(result).toEqual({ noOp: true, reason: 'not_found' });
    expect(fake.updateSession).not.toHaveBeenCalled();
  });

  it('(c2) run with NULL session_id → not_found (NOT already_terminal)', async () => {
    const runId = seedRunWithSession('running', null);
    const fake = makeFakePermDeps({ substrate: 'sdk' });
    setSetPermissionModeDeps(fake.deps);
    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    const result = await caller.cyboflow.runs.setPermissionMode({ runId, permissionMode: 'acceptEdits' });
    expect(result).toEqual({ noOp: true, reason: 'not_found' });
    expect(fake.updateSession).not.toHaveBeenCalled();
  });

  it('(c3) resolved session was deleted before the persist → not_found', async () => {
    const runId = seedRunWithSession('running', 'sess-runtime');
    const fake = makeFakePermDeps({ substrate: 'sdk', updateReturns: false });
    setSetPermissionModeDeps(fake.deps);
    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    const result = await caller.cyboflow.runs.setPermissionMode({ runId, permissionMode: 'acceptEdits' });
    expect(result).toEqual({ noOp: true, reason: 'not_found' });
  });

  it('(d) invalid permissionMode → zod BAD_REQUEST', async () => {
    const runId = seedRunWithSession('running', 'sess-runtime');
    setSetPermissionModeDeps(makeFakePermDeps().deps);
    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    await expect(
      // @ts-expect-error — deliberately passing an invalid enum value to assert zod rejects it.
      caller.cyboflow.runs.setPermissionMode({ runId, permissionMode: 'bogus' }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST',
    );
  });

  it('(e) accepts a paused run (gate is non-terminal)', async () => {
    const runId = seedRunWithSession('paused', 'sess-runtime');
    const fake = makeFakePermDeps({ substrate: 'sdk' });
    setSetPermissionModeDeps(fake.deps);
    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    const result = await caller.cyboflow.runs.setPermissionMode({ runId, permissionMode: 'acceptEdits' });
    expect(result).toEqual({ updated: true });
    expect(fake.updateSession).toHaveBeenCalledWith('sess-runtime', { agent_permission_mode: 'acceptEdits' });
  });

  it('(f) throws PRECONDITION_FAILED when ctx.db is missing', async () => {
    setSetPermissionModeDeps(makeFakePermDeps().deps);
    const caller = appRouter.createCaller(createContext());
    await expect(
      caller.cyboflow.runs.setPermissionMode({ runId: 'any-run', permissionMode: 'auto' }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof TRPCError && err.code === 'PRECONDITION_FAILED',
    );
  });

  it('(g) throws METHOD_NOT_SUPPORTED when the chokepoint deps are not wired', async () => {
    const runId = seedRunWithSession('running', 'sess-runtime');
    setSetPermissionModeDeps(null as unknown as SessionAgentPermissionModeDeps);
    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    await expect(
      caller.cyboflow.runs.setPermissionMode({ runId, permissionMode: 'auto' }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof TRPCError && err.code === 'METHOD_NOT_SUPPORTED',
    );
  });
});

// ---------------------------------------------------------------------------
// cyboflow.runs.pause / cyboflow.runs.resume — SDK-only Pause/Resume (Phase 4b,
// router delegation).
//
// The handlers' full guard matrices are covered in pauseRunHandler.test.ts /
// resumeRunHandler.test.ts; here we verify that once wired the router forwards
// { runId } to the injected handler deps and returns the result verbatim. Fake
// dep bags are injected via setPauseRunDeps() / setResumeRunDeps() so the test
// stays free of the SubstrateDispatchFacade / services-*. The
// METHOD_NOT_SUPPORTED-when-unwired path is covered by the separately-loaded
// module instance in router.test.ts (per-file module isolation guarantees the
// deps are null there) — same rationale documented for runs.start above.
// ---------------------------------------------------------------------------

describe('cyboflow.runs.pause (Phase 4b)', () => {
  /** A PauseRunDeps whose collaborators are vi.fn() spies over a real in-memory DB. */
  function makeFakePauseDeps(
    db: Database.Database,
    overrides?: Partial<PauseRunDeps>,
  ): PauseRunDeps {
    return {
      db: dbAdapter(db),
      runQueues: new RunQueueRegistry(),
      stopLiveRun: vi.fn<PauseRunDeps['stopLiveRun']>().mockResolvedValue(undefined),
      clearPendingApprovalsForRun: vi.fn<PauseRunDeps['clearPendingApprovalsForRun']>(),
      clearPendingQuestionsForRun: vi.fn<NonNullable<PauseRunDeps['clearPendingQuestionsForRun']>>(),
      emitRunStatusChanged: vi.fn<PauseRunDeps['emitRunStatusChanged']>(),
      ...overrides,
    };
  }

  function makePauseDb(): Database.Database {
    return createTestDb({ includeSubstrate: true, includeWorkflowRunTaskColumns: true });
  }

  it('(b) delegates to the handler and returns { success: true } for a running SDK run', async () => {
    const db = makePauseDb();
    const { runId } = seedRun(db, { status: 'running' });
    db.prepare("UPDATE workflow_runs SET substrate = 'sdk', claude_session_id = 'sess-1' WHERE id = ?").run(runId);
    const stopLiveRun = vi.fn<PauseRunDeps['stopLiveRun']>().mockResolvedValue(undefined);
    const emitRunStatusChanged = vi.fn<PauseRunDeps['emitRunStatusChanged']>();
    setPauseRunDeps(makeFakePauseDeps(db, { stopLiveRun, emitRunStatusChanged }));

    try {
      const caller = appRouter.createCaller(createContext());
      const result: PauseRunResult = await caller.cyboflow.runs.pause({ runId });

      expect(result).toEqual({ success: true });
      expect(stopLiveRun).toHaveBeenCalledWith(runId);
      expect(emitRunStatusChanged).toHaveBeenCalledWith(runId, 'paused');
      const row = db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as { status: string };
      expect(row.status).toBe('paused');
    } finally {
      db.close();
    }
  });

  it('(b2) forwards a noOp { reason: interactive_unsupported } result verbatim', async () => {
    const db = makePauseDb();
    const { runId } = seedRun(db, { status: 'running' });
    db.prepare("UPDATE workflow_runs SET substrate = 'interactive', claude_session_id = 'sess-1' WHERE id = ?").run(runId);
    const stopLiveRun = vi.fn<PauseRunDeps['stopLiveRun']>().mockResolvedValue(undefined);
    setPauseRunDeps(makeFakePauseDeps(db, { stopLiveRun }));

    try {
      const caller = appRouter.createCaller(createContext());
      const result: PauseRunResult = await caller.cyboflow.runs.pause({ runId });

      expect(result).toEqual({ noOp: true, reason: 'interactive_unsupported' });
      expect(stopLiveRun).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });
});

describe('cyboflow.runs.resume (Phase 4b)', () => {
  function makeResumeDb(): Database.Database {
    return createTestDb({ includeSubstrate: true, includeWorkflowRunTaskColumns: true });
  }

  it('forwards a delivered resume: flips the run to running and returns { delivered: true }', async () => {
    const db = makeResumeDb();
    const { runId } = seedRun(db, { status: 'paused' });
    db.prepare("UPDATE workflow_runs SET substrate = 'sdk', claude_session_id = 'sess-1' WHERE id = ?").run(runId);

    const execute = vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined);
    const setPendingResume = vi.fn<(id: string) => void>();
    const emitRunStatusChanged = vi.fn<ResumeRunDeps['emitRunStatusChanged']>();
    setResumeRunDeps({
      db: dbAdapter(db),
      runQueues: new RunQueueRegistry(),
      runExecutor: { setPendingResume, execute },
      emitRunStatusChanged,
    });

    try {
      const caller = appRouter.createCaller(createContext());
      const result: ResumeRunResult = await caller.cyboflow.runs.resume({ runId });

      expect(result).toEqual({ delivered: true });
      expect(setPendingResume).toHaveBeenCalledWith(runId);
      expect(execute).toHaveBeenCalledWith(runId);
      expect(emitRunStatusChanged).toHaveBeenCalledWith(runId, 'running');
      const row = db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as { status: string };
      expect(row.status).toBe('running');
    } finally {
      db.close();
    }
  });

  it('forwards a noOp result verbatim (guard: not_paused)', async () => {
    const db = makeResumeDb();
    const { runId } = seedRun(db, { status: 'running' });
    db.prepare("UPDATE workflow_runs SET substrate = 'sdk', claude_session_id = 'sess-1' WHERE id = ?").run(runId);

    const execute = vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined);
    setResumeRunDeps({
      db: dbAdapter(db),
      runQueues: new RunQueueRegistry(),
      runExecutor: { setPendingResume: vi.fn(), execute },
      emitRunStatusChanged: vi.fn<ResumeRunDeps['emitRunStatusChanged']>(),
    });

    try {
      const caller = appRouter.createCaller(createContext());
      const result: ResumeRunResult = await caller.cyboflow.runs.resume({ runId });

      expect(result).toEqual({ noOp: true, reason: 'not_paused' });
      expect(execute).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// cyboflow.runs.get — single workflow run lookup (Phase 4a).
//
// Reads the workflow_runs row directly from ctx.db. Verifies the happy-path row
// shape, NOT_FOUND for an unknown id, and PRECONDITION_FAILED when ctx.db is
// missing.
// ---------------------------------------------------------------------------

describe('cyboflow.runs.get (Phase 4a)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb({ includeStuckDetectedAt: true });
  });

  afterEach(() => {
    db.close();
  });

  it('returns the workflow run row for a known id', async () => {
    seedRun(db, { id: 'run-get-1', status: 'running', worktreePath: '/tmp/wt/run-get-1' });

    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    const row = await caller.cyboflow.runs.get({ runId: 'run-get-1' });

    expect(row.id).toBe('run-get-1');
    expect(row.status).toBe('running');
    expect(row.worktree_path).toBe('/tmp/wt/run-get-1');
    expect(row.project_id).toBe(1);
  });

  it('throws NOT_FOUND for an unknown run id', async () => {
    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    await expect(
      caller.cyboflow.runs.get({ runId: 'no-such-run' }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof TRPCError && err.code === 'NOT_FOUND',
    );
  });

  it('throws PRECONDITION_FAILED when ctx.db is missing', async () => {
    const caller = appRouter.createCaller(createContext());
    await expect(
      caller.cyboflow.runs.get({ runId: 'any-run' }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof TRPCError && err.code === 'PRECONDITION_FAILED',
    );
  });
});

// ---------------------------------------------------------------------------
// cyboflow.runs.relayInput / cyboflow.runs.relayResize — live-input relay
// (IDEA-030 / TASK-817).
//
// The relay dep-bag (RelayDeps) is injected via setRelayDeps() with vi.fn()
// spies so the test stays free of the SubstrateDispatchFacade / services-*. The
// UNWIRED cases run FIRST (declaration order) so module-level relayDeps is still
// null at that point — this is the only setRelayDeps() caller in the file, and
// vitest runs tests in declaration order, so the guard branch is exercised
// before any wiring. The wired cases then assert runId→panelId fan-out into the
// dep-bag function refs.
// ---------------------------------------------------------------------------

describe('cyboflow.runs.relayInput / relayResize (IDEA-030 / TASK-817)', () => {
  // (a) UNWIRED — both mutations throw METHOD_NOT_SUPPORTED before setRelayDeps().
  it('(a) relayInput throws METHOD_NOT_SUPPORTED before setRelayDeps() is wired', async () => {
    const caller = appRouter.createCaller(createContext());
    await expect(
      caller.cyboflow.runs.relayInput({ runId: 'run-unwired', text: 'hi' }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof TRPCError && err.code === 'METHOD_NOT_SUPPORTED',
    );
  });

  it('(a) relayResize throws METHOD_NOT_SUPPORTED before setRelayDeps() is wired', async () => {
    const caller = appRouter.createCaller(createContext());
    await expect(
      caller.cyboflow.runs.relayResize({ runId: 'run-unwired', cols: 80, rows: 24 }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof TRPCError && err.code === 'METHOD_NOT_SUPPORTED',
    );
  });

  // (b) WIRED — the mutations forward runId/text and runId/cols/rows to the
  //     injected dep-bag function refs (runId === panelId orchestrator invariant).
  it('(b) relayInput routes to deps.relayInput(runId, text) once wired', async () => {
    const relayInput = vi.fn<RelayDeps['relayInput']>();
    const relayResize = vi.fn<RelayDeps['relayResize']>();
    const endSession = vi.fn<RelayDeps['endSession']>().mockResolvedValue(undefined);
    setRelayDeps({ relayInput, relayResize, endSession, killSession: vi.fn<RelayDeps['killSession']>().mockResolvedValue(undefined), getPtyBacklog: vi.fn<RelayDeps['getPtyBacklog']>(() => '') });

    try {
      const caller = appRouter.createCaller(createContext());
      const result = await caller.cyboflow.runs.relayInput({ runId: 'run-relay', text: 'go\n' });

      expect(result).toEqual({ success: true });
      expect(relayInput).toHaveBeenCalledOnce();
      expect(relayInput).toHaveBeenCalledWith('run-relay', 'go\n');
      expect(relayResize).not.toHaveBeenCalled();
    } finally {
      setRelayDeps(makeUnwiredRelayDeps());
    }
  });

  it('(b) relayResize routes to deps.relayResize(runId, cols, rows) once wired', async () => {
    const relayInput = vi.fn<RelayDeps['relayInput']>();
    const relayResize = vi.fn<RelayDeps['relayResize']>();
    const endSession = vi.fn<RelayDeps['endSession']>().mockResolvedValue(undefined);
    setRelayDeps({ relayInput, relayResize, endSession, killSession: vi.fn<RelayDeps['killSession']>().mockResolvedValue(undefined), getPtyBacklog: vi.fn<RelayDeps['getPtyBacklog']>(() => '') });

    try {
      const caller = appRouter.createCaller(createContext());
      const result = await caller.cyboflow.runs.relayResize({ runId: 'run-relay', cols: 120, rows: 40 });

      expect(result).toEqual({ success: true });
      expect(relayResize).toHaveBeenCalledOnce();
      expect(relayResize).toHaveBeenCalledWith('run-relay', 120, 40);
      expect(relayInput).not.toHaveBeenCalled();
    } finally {
      setRelayDeps(makeUnwiredRelayDeps());
    }
  });

  it('(c) getPtyBacklog returns deps.getPtyBacklog(runId) once wired', async () => {
    const getPtyBacklog = vi.fn<RelayDeps['getPtyBacklog']>(() => '\x1b[32mclaude paint\x1b[0m');
    setRelayDeps({
      relayInput: vi.fn<RelayDeps['relayInput']>(),
      relayResize: vi.fn<RelayDeps['relayResize']>(),
      endSession: vi.fn<RelayDeps['endSession']>().mockResolvedValue(undefined),
      killSession: vi.fn<RelayDeps['killSession']>().mockResolvedValue(undefined),
      getPtyBacklog,
    });

    try {
      const caller = appRouter.createCaller(createContext());
      const result = await caller.cyboflow.runs.getPtyBacklog({ runId: 'run-backlog' });

      expect(result).toEqual({ backlog: '\x1b[32mclaude paint\x1b[0m' });
      expect(getPtyBacklog).toHaveBeenCalledWith('run-backlog');
    } finally {
      setRelayDeps(makeUnwiredRelayDeps());
    }
  });
});

// ---------------------------------------------------------------------------
// cyboflow.runs.merge / cyboflow.runs.dismiss — GAP-B run close-out
//
// Deps (WorktreeManagerLike + SessionManagerLike) are injected via
// setRunCloseoutDeps() with vi.fn() stubs so the test stays free of git /
// Electron. Each test seeds a run with a worktree_path and asserts the right
// WorktreeManager calls + the run's terminal status transition.
// ---------------------------------------------------------------------------

describe('cyboflow.runs.merge / dismiss (GAP-B)', () => {
  let db: Database.Database;
  let clearApprovals: ReturnType<typeof vi.fn>;

  function makeWmStub(): { [K in keyof RunWorktreeManagerLike]: ReturnType<typeof vi.fn> } {
    return {
      getProjectMainBranch: vi.fn().mockResolvedValue('main'),
      squashAndMergeWorktreeToMain: vi.fn().mockResolvedValue(undefined),
      mergeWorktreeToMain: vi.fn().mockResolvedValue(undefined),
      removeWorktreeByPath: vi.fn().mockResolvedValue(undefined),
      deleteBranch: vi.fn().mockResolvedValue(undefined),
      gitPush: vi.fn().mockResolvedValue({ output: 'pushed' }),
      getRemoteUrlAndBranch: vi.fn().mockResolvedValue({
        remoteUrl: 'https://github.com/acme/repo.git',
        branchName: 'cyboflow/sprint/abcd1234',
      }),
    };
  }

  function wire(wm: RunWorktreeManagerLike) {
    setRunCloseoutDeps({
      worktreeManager: wm,
      sessionManager: { getProjectById: (_id: number) => ({ path: '/projects/p' }) },
      clearPendingApprovalsForRun: clearApprovals,
      disposeMonitorResources: vi.fn(),
    });
  }

  function getStatus(runId: string): string {
    return (db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as { status: string }).status;
  }

  beforeEach(() => {
    db = createTestDb({ includeStuckDetectedAt: true });
    // resolveRunForCloseout now SELECTs session_id (Phase 1 / migration 019);
    // GATE_SCHEMA omits it, so layer the additive ALTER on top.
    db.exec('ALTER TABLE workflow_runs ADD COLUMN session_id TEXT');
    clearApprovals = vi.fn();
  });

  afterEach(() => {
    db.close();
    // Reset module-level deps so a wired stub doesn't leak into other describe blocks.
    setRunCloseoutDeps({
      worktreeManager: makeWmStub(),
      sessionManager: { getProjectById: () => undefined },
      clearPendingApprovalsForRun: vi.fn(),
      disposeMonitorResources: vi.fn(),
    });
  });

  it('merge(squash) from awaiting_review squash-merges, removes the worktree, and marks the run completed', async () => {
    // The executor rests a finished run in awaiting_review; the user accept
    // (Merge) is what completes it — verify the awaiting_review → completed path.
    seedRun(db, { id: 'run-merge-1', status: 'awaiting_review', worktreePath: '/tmp/wt/run-merge-1' });
    const wm = makeWmStub();
    wire(wm);

    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    const result = await caller.cyboflow.runs.merge({
      runId: 'run-merge-1',
      strategy: 'squash',
      commitMessage: 'combined commit',
    });

    expect(result).toEqual({ success: true });
    expect(wm.squashAndMergeWorktreeToMain).toHaveBeenCalledWith('/projects/p', '/tmp/wt/run-merge-1', 'main', 'combined commit');
    expect(wm.mergeWorktreeToMain).not.toHaveBeenCalled();
    expect(wm.removeWorktreeByPath).toHaveBeenCalledWith('/projects/p', '/tmp/wt/run-merge-1');
    expect(getStatus('run-merge-1')).toBe('completed');
  });

  it('merge disposes the run on-demand monitor at close-out (monitor-unify at-rest lifetime)', async () => {
    // The monitor outlives the walk so the user can chat with it at rest; close-out
    // (worktree removed) is where it is finally torn down.
    seedRun(db, { id: 'run-mon-dispose', status: 'awaiting_review', worktreePath: '/tmp/wt/run-mon-dispose' });
    const disposeMonitorResources = vi.fn();
    setRunCloseoutDeps({
      worktreeManager: makeWmStub(),
      sessionManager: { getProjectById: (_id: number) => ({ path: '/projects/p' }) },
      clearPendingApprovalsForRun: vi.fn(),
      disposeMonitorResources,
    });

    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    await caller.cyboflow.runs.merge({ runId: 'run-mon-dispose', strategy: 'preserve' });

    expect(disposeMonitorResources).toHaveBeenCalledWith('run-mon-dispose');
  });

  it('merge(preserve) from stuck replays commits without a squash message', async () => {
    seedRun(db, { id: 'run-merge-2', status: 'stuck', worktreePath: '/tmp/wt/run-merge-2' });
    const wm = makeWmStub();
    wire(wm);

    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    await caller.cyboflow.runs.merge({ runId: 'run-merge-2', strategy: 'preserve' });

    expect(wm.mergeWorktreeToMain).toHaveBeenCalledWith('/projects/p', '/tmp/wt/run-merge-2', 'main');
    expect(wm.squashAndMergeWorktreeToMain).not.toHaveBeenCalled();
    expect(wm.removeWorktreeByPath).toHaveBeenCalledWith('/projects/p', '/tmp/wt/run-merge-2');
    expect(getStatus('run-merge-2')).toBe('completed');
  });

  it('merge(preserve) treats a commit-less run (WorktreeManager "No commits to merge") as benign success', async () => {
    // A Planner run persists its output to the DB via MCP and makes ZERO git
    // commits, so WorktreeManager throws its wrapped "No commits to merge"
    // sentinel. The merge mutation must swallow that specific case and still
    // close the run out cleanly (worktree removed, run completed) instead of
    // surfacing a failure.
    seedRun(db, {
      id: 'run-nocommits-1',
      status: 'awaiting_review',
      worktreePath: '/tmp/wt/run-nocommits-1',
      branchName: 'cyboflow/planner/nocommits',
    });
    const wm = makeWmStub();
    // Mirror WorktreeManager's real re-wrap: generic message + preserved original.
    const wrapped = new Error('Failed to merge worktree to main') as Error & {
      originalError?: Error;
      gitOutput?: string;
    };
    wrapped.originalError = new Error('No commits to merge. The branch is already up to date with main.');
    wrapped.gitOutput = 'No commits to merge. The branch is already up to date with main.';
    wm.mergeWorktreeToMain.mockRejectedValue(wrapped);
    wire(wm);

    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    const result = await caller.cyboflow.runs.merge({ runId: 'run-nocommits-1', strategy: 'preserve' });

    expect(result).toEqual({ success: true });
    // Close-out still runs even though the merge was a no-op.
    expect(wm.removeWorktreeByPath).toHaveBeenCalledWith('/projects/p', '/tmp/wt/run-nocommits-1');
    expect(wm.deleteBranch).toHaveBeenCalledWith('/projects/p', 'cyboflow/planner/nocommits', { force: true });
    expect(clearApprovals).toHaveBeenCalledWith('run-nocommits-1');
    expect(getStatus('run-nocommits-1')).toBe('completed');
  });

  it('merge(squash) treats a commit-less run ("No commits to squash") as benign success', async () => {
    seedRun(db, {
      id: 'run-nocommits-2',
      status: 'awaiting_review',
      worktreePath: '/tmp/wt/run-nocommits-2',
    });
    const wm = makeWmStub();
    wm.squashAndMergeWorktreeToMain.mockRejectedValue(
      new Error('No commits to squash. The branch is already up to date with main.'),
    );
    wire(wm);

    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    const result = await caller.cyboflow.runs.merge({
      runId: 'run-nocommits-2',
      strategy: 'squash',
      commitMessage: 'planner output (no commits)',
    });

    expect(result).toEqual({ success: true });
    expect(wm.removeWorktreeByPath).toHaveBeenCalledWith('/projects/p', '/tmp/wt/run-nocommits-2');
    expect(getStatus('run-nocommits-2')).toBe('completed');
  });

  it('merge still propagates a REAL merge failure (rebase conflict) — run NOT closed out', async () => {
    // A Sprint run with real commits must still merge normally; a genuine git
    // failure (not the no-commits sentinel) must surface, not be swallowed, and
    // the run must NOT be marked completed.
    seedRun(db, {
      id: 'run-realfail-1',
      status: 'awaiting_review',
      worktreePath: '/tmp/wt/run-realfail-1',
    });
    const wm = makeWmStub();
    const conflict = new Error('Failed to merge worktree to main') as Error & {
      originalError?: Error;
      gitOutput?: string;
    };
    conflict.originalError = new Error('Failed to rebase worktree onto main. Conflicts must be resolved first.');
    conflict.gitOutput = 'CONFLICT (content): Merge conflict in foo.ts';
    wm.mergeWorktreeToMain.mockRejectedValue(conflict);
    wire(wm);

    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    await expect(
      caller.cyboflow.runs.merge({ runId: 'run-realfail-1', strategy: 'preserve' }),
    ).rejects.toThrow('Failed to merge worktree to main');

    // Real failure → close-out must NOT run; the run stays in its pre-merge state.
    expect(wm.removeWorktreeByPath).not.toHaveBeenCalled();
    expect(getStatus('run-realfail-1')).toBe('awaiting_review');
  });

  it('merge(squash) without a commit message → BAD_REQUEST and no worktree mutation', async () => {
    seedRun(db, { id: 'run-merge-3', status: 'completed', worktreePath: '/tmp/wt/run-merge-3' });
    const wm = makeWmStub();
    wire(wm);

    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    await expect(
      caller.cyboflow.runs.merge({ runId: 'run-merge-3', strategy: 'squash', commitMessage: '   ' }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST');

    expect(wm.squashAndMergeWorktreeToMain).not.toHaveBeenCalled();
    expect(wm.removeWorktreeByPath).not.toHaveBeenCalled();
  });

  it('dismiss removes the worktree and marks a non-terminal run canceled', async () => {
    seedRun(db, { id: 'run-dismiss-1', status: 'stuck', worktreePath: '/tmp/wt/run-dismiss-1' });
    const wm = makeWmStub();
    wire(wm);

    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    const result = await caller.cyboflow.runs.dismiss({ runId: 'run-dismiss-1' });

    expect(result).toEqual({ success: true });
    expect(wm.removeWorktreeByPath).toHaveBeenCalledWith('/projects/p', '/tmp/wt/run-dismiss-1');
    // This run has no branch_name → branch deletion must be skipped (no throw).
    expect(wm.deleteBranch).not.toHaveBeenCalled();
    expect(getStatus('run-dismiss-1')).toBe('canceled');
  });

  it('dismiss force-deletes the run branch after removing the worktree', async () => {
    seedRun(db, {
      id: 'run-dismiss-br',
      status: 'stuck',
      worktreePath: '/tmp/wt/run-dismiss-br',
      branchName: 'cyboflow/sprint/dismissbr',
    });
    const wm = makeWmStub();
    wire(wm);

    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    await caller.cyboflow.runs.dismiss({ runId: 'run-dismiss-br' });

    expect(wm.removeWorktreeByPath).toHaveBeenCalledWith('/projects/p', '/tmp/wt/run-dismiss-br');
    expect(wm.deleteBranch).toHaveBeenCalledWith('/projects/p', 'cyboflow/sprint/dismissbr', { force: true });
    expect(clearApprovals).toHaveBeenCalledWith('run-dismiss-br');
    expect(getStatus('run-dismiss-br')).toBe('canceled');
  });

  it('merge force-deletes the run branch (squash-safe) after removing the worktree', async () => {
    seedRun(db, {
      id: 'run-merge-br',
      status: 'awaiting_review',
      worktreePath: '/tmp/wt/run-merge-br',
      branchName: 'cyboflow/sprint/mergebr',
    });
    const wm = makeWmStub();
    wire(wm);

    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    await caller.cyboflow.runs.merge({ runId: 'run-merge-br', strategy: 'preserve' });

    expect(wm.removeWorktreeByPath).toHaveBeenCalledWith('/projects/p', '/tmp/wt/run-merge-br');
    expect(wm.deleteBranch).toHaveBeenCalledWith('/projects/p', 'cyboflow/sprint/mergebr', { force: true });
    expect(clearApprovals).toHaveBeenCalledWith('run-merge-br');
    expect(getStatus('run-merge-br')).toBe('completed');
  });

  it('createPr preserves the local branch (no deleteBranch — it lives on origin)', async () => {
    seedRun(db, {
      id: 'run-pr-br',
      status: 'awaiting_review',
      worktreePath: '/tmp/wt/run-pr-br',
      branchName: 'cyboflow/sprint/prbr',
    });
    const wm = makeWmStub();
    wire(wm);

    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    await caller.cyboflow.runs.createPr({ runId: 'run-pr-br' });

    expect(wm.removeWorktreeByPath).toHaveBeenCalledWith('/projects/p', '/tmp/wt/run-pr-br');
    expect(wm.deleteBranch).not.toHaveBeenCalled();
    expect(clearApprovals).toHaveBeenCalledWith('run-pr-br');
    expect(getStatus('run-pr-br')).toBe('completed');
  });

  it('merge on a missing run → NOT_FOUND', async () => {
    wire(makeWmStub());
    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    await expect(
      caller.cyboflow.runs.merge({ runId: 'no-such-run', strategy: 'preserve' }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'NOT_FOUND');
  });

  it('dismiss on a run with no worktree → PRECONDITION_FAILED', async () => {
    // seedRun then null out the worktree_path to simulate a run that never got a worktree.
    seedRun(db, { id: 'run-no-wt', status: 'queued' });
    db.prepare('UPDATE workflow_runs SET worktree_path = NULL WHERE id = ?').run('run-no-wt');
    wire(makeWmStub());
    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    await expect(
      caller.cyboflow.runs.dismiss({ runId: 'run-no-wt' }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'PRECONDITION_FAILED');
  });

  it('createPr from awaiting_review pushes, removes the worktree, returns remote+branch, and completes the run', async () => {
    seedRun(db, { id: 'run-pr-1', status: 'awaiting_review', worktreePath: '/tmp/wt/run-pr-1' });
    const wm = makeWmStub();
    wire(wm);

    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    const result = await caller.cyboflow.runs.createPr({ runId: 'run-pr-1' });

    expect(wm.gitPush).toHaveBeenCalledWith('/tmp/wt/run-pr-1');
    expect(wm.getRemoteUrlAndBranch).toHaveBeenCalledWith('/tmp/wt/run-pr-1');
    expect(wm.removeWorktreeByPath).toHaveBeenCalledWith('/projects/p', '/tmp/wt/run-pr-1');
    expect(result).toEqual({
      remoteUrl: 'https://github.com/acme/repo.git',
      branchName: 'cyboflow/sprint/abcd1234',
    });
    expect(getStatus('run-pr-1')).toBe('completed');
  });

  it('createPr on a run with no worktree → PRECONDITION_FAILED and no push', async () => {
    seedRun(db, { id: 'run-pr-nowt', status: 'awaiting_review' });
    db.prepare('UPDATE workflow_runs SET worktree_path = NULL WHERE id = ?').run('run-pr-nowt');
    const wm = makeWmStub();
    wire(wm);
    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    await expect(
      caller.cyboflow.runs.createPr({ runId: 'run-pr-nowt' }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'PRECONDITION_FAILED');
    expect(wm.gitPush).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Close-out safety guard (session<->run restructure, Phase 1).
  //
  // A SESSION-HOSTED run (session_id != null) executes inside the SHARED session
  // worktree. The run-level close-out path must NEVER touch git: merge / createPr
  // / dismiss MUST throw PRECONDITION_FAILED and NEVER call removeWorktreeByPath,
  // deleteBranch, or any merge/push helper — that work belongs to the session
  // (wired in Phase 3). Legacy runs (session_id == null) keep today's behavior.
  // -------------------------------------------------------------------------

  /** Seed a run, then stamp its session_id so it is treated as session-hosted. */
  function seedSessionHostedRun(id: string, worktreePath: string, branchName?: string): void {
    seedRun(db, { id, status: 'awaiting_review', worktreePath, branchName });
    db.prepare('UPDATE workflow_runs SET session_id = ? WHERE id = ?').run('sess-host', id);
  }

  it('merge on a session-hosted run → PRECONDITION_FAILED and NEVER touches the worktree/branch', async () => {
    seedSessionHostedRun('run-sh-merge', '/tmp/wt/run-sh-merge', 'feature/sh');
    const wm = makeWmStub();
    wire(wm);

    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    await expect(
      caller.cyboflow.runs.merge({ runId: 'run-sh-merge', strategy: 'preserve' }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof TRPCError &&
        err.code === 'PRECONDITION_FAILED' &&
        err.message.includes('session-hosted'),
    );

    // The shared session worktree/branch must be untouched.
    expect(wm.mergeWorktreeToMain).not.toHaveBeenCalled();
    expect(wm.squashAndMergeWorktreeToMain).not.toHaveBeenCalled();
    expect(wm.removeWorktreeByPath).not.toHaveBeenCalled();
    expect(wm.deleteBranch).not.toHaveBeenCalled();
    expect(clearApprovals).not.toHaveBeenCalled();
    // The run is NOT marked terminal by a rejected close-out.
    expect(getStatus('run-sh-merge')).toBe('awaiting_review');
  });

  it('createPr on a session-hosted run → PRECONDITION_FAILED and NEVER pushes or removes the worktree', async () => {
    seedSessionHostedRun('run-sh-pr', '/tmp/wt/run-sh-pr', 'feature/sh');
    const wm = makeWmStub();
    wire(wm);

    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    await expect(
      caller.cyboflow.runs.createPr({ runId: 'run-sh-pr' }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof TRPCError && err.code === 'PRECONDITION_FAILED',
    );

    expect(wm.gitPush).not.toHaveBeenCalled();
    expect(wm.removeWorktreeByPath).not.toHaveBeenCalled();
    expect(wm.deleteBranch).not.toHaveBeenCalled();
    expect(getStatus('run-sh-pr')).toBe('awaiting_review');
  });

  it('dismiss on a session-hosted run → PRECONDITION_FAILED and NEVER removes the worktree/branch', async () => {
    seedSessionHostedRun('run-sh-dismiss', '/tmp/wt/run-sh-dismiss', 'feature/sh');
    const wm = makeWmStub();
    wire(wm);

    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    await expect(
      caller.cyboflow.runs.dismiss({ runId: 'run-sh-dismiss' }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof TRPCError && err.code === 'PRECONDITION_FAILED',
    );

    expect(wm.removeWorktreeByPath).not.toHaveBeenCalled();
    expect(wm.deleteBranch).not.toHaveBeenCalled();
    expect(getStatus('run-sh-dismiss')).toBe('awaiting_review');
  });

  it('legacy run (session_id NULL) still removes its worktree on dismiss (guard is a no-op)', async () => {
    // Contrast with the session-hosted cases above: a legacy run keeps EXACTLY
    // today's close-out behavior — the guard must not regress it.
    seedRun(db, { id: 'run-legacy-dismiss', status: 'stuck', worktreePath: '/tmp/wt/run-legacy-dismiss' });
    const wm = makeWmStub();
    wire(wm);

    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    const result = await caller.cyboflow.runs.dismiss({ runId: 'run-legacy-dismiss' });

    expect(result).toEqual({ success: true });
    expect(wm.removeWorktreeByPath).toHaveBeenCalledWith('/projects/p', '/tmp/wt/run-legacy-dismiss');
    expect(getStatus('run-legacy-dismiss')).toBe('canceled');
  });
});

// ---------------------------------------------------------------------------
// cyboflow.runs.merge / dismiss — explicit interactive end-session (IDEA-030 /
// TASK-818).
//
// For a LIVE interactive run, close-out (Merge / Dismiss / Create-PR) must call
// the RelayDeps `endSession` seam BEFORE worktree removal so the live REPL's
// spawn promise resolves as part of close-out. This is the ONLY non-kill
// spawn-promise resolver for a persistent interactive run. We inject a spy
// endSession via setRelayDeps() and assert it is called with the runId before
// the run is marked terminal.
// ---------------------------------------------------------------------------

describe('cyboflow.runs.merge / dismiss — interactive endSession close-out (IDEA-030 / TASK-818)', () => {
  let db: Database.Database;

  function makeWmStub(): { [K in keyof RunWorktreeManagerLike]: ReturnType<typeof vi.fn> } {
    return {
      getProjectMainBranch: vi.fn().mockResolvedValue('main'),
      squashAndMergeWorktreeToMain: vi.fn().mockResolvedValue(undefined),
      mergeWorktreeToMain: vi.fn().mockResolvedValue(undefined),
      removeWorktreeByPath: vi.fn().mockResolvedValue(undefined),
      deleteBranch: vi.fn().mockResolvedValue(undefined),
      gitPush: vi.fn().mockResolvedValue({ output: 'pushed' }),
      getRemoteUrlAndBranch: vi.fn().mockResolvedValue({
        remoteUrl: 'https://github.com/acme/repo.git',
        branchName: 'cyboflow/sprint/abcd1234',
      }),
    };
  }

  function getStatus(runId: string): string {
    return (db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as { status: string }).status;
  }

  beforeEach(() => {
    db = createTestDb({ includeStuckDetectedAt: true });
    // resolveRunForCloseout now SELECTs session_id (Phase 1 / migration 019).
    db.exec('ALTER TABLE workflow_runs ADD COLUMN session_id TEXT');
    setRunCloseoutDeps({
      worktreeManager: makeWmStub(),
      sessionManager: { getProjectById: (_id: number) => ({ path: '/projects/p' }) },
      clearPendingApprovalsForRun: vi.fn(),
      disposeMonitorResources: vi.fn(),
    });
  });

  afterEach(() => {
    db.close();
    setRunCloseoutDeps({
      worktreeManager: makeWmStub(),
      sessionManager: { getProjectById: () => undefined },
      clearPendingApprovalsForRun: vi.fn(),
      disposeMonitorResources: vi.fn(),
    });
    // Reset the relay bag so the wired spy does not leak into other describe blocks.
    setRelayDeps(makeUnwiredRelayDeps());
  });

  it('merge calls endSession(runId) before close-out and the spawn promise resolves only via this path', async () => {
    seedRun(db, { id: 'run-iz-merge', status: 'awaiting_review', worktreePath: '/tmp/wt/run-iz-merge' });

    // endSession resolves only when invoked — it stands in for the live PTY
    // teardown that settles the spawn promise. The relay spies are the ONLY
    // path that triggers it.
    const endSession = vi.fn<RelayDeps['endSession']>().mockResolvedValue(undefined);
    setRelayDeps({
      relayInput: vi.fn<RelayDeps['relayInput']>(),
      relayResize: vi.fn<RelayDeps['relayResize']>(),
      endSession,
      killSession: vi.fn<RelayDeps['killSession']>().mockResolvedValue(undefined),
      getPtyBacklog: vi.fn<RelayDeps['getPtyBacklog']>(() => ''),
    });

    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    const result = await caller.cyboflow.runs.merge({
      runId: 'run-iz-merge',
      strategy: 'preserve',
    });

    expect(result).toEqual({ success: true });
    // The live interactive REPL was terminated as part of close-out.
    expect(endSession).toHaveBeenCalledOnce();
    expect(endSession).toHaveBeenCalledWith('run-iz-merge');
    expect(getStatus('run-iz-merge')).toBe('completed');
  });

  it('dismiss HARD-kills via killSession(runId) (not the graceful endSession) before removing the worktree', async () => {
    seedRun(db, { id: 'run-iz-dismiss', status: 'awaiting_review', worktreePath: '/tmp/wt/run-iz-dismiss' });

    const removeWorktreeByPath = vi.fn().mockResolvedValue(undefined);
    const endSession = vi.fn<RelayDeps['endSession']>().mockResolvedValue(undefined);
    const killSession = vi.fn<RelayDeps['killSession']>().mockResolvedValue(undefined);
    setRunCloseoutDeps({
      worktreeManager: { ...makeWmStub(), removeWorktreeByPath },
      sessionManager: { getProjectById: (_id: number) => ({ path: '/projects/p' }) },
      clearPendingApprovalsForRun: vi.fn(),
      disposeMonitorResources: vi.fn(),
    });
    setRelayDeps({
      relayInput: vi.fn<RelayDeps['relayInput']>(),
      relayResize: vi.fn<RelayDeps['relayResize']>(),
      endSession,
      killSession,
      getPtyBacklog: vi.fn<RelayDeps['getPtyBacklog']>(() => ''),
    });

    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    await caller.cyboflow.runs.dismiss({ runId: 'run-iz-dismiss' });

    // Dismiss is a discard — it must HARD-kill the live REPL (a RUNNING claude
    // never reads a graceful EOF/exit), so killSession fires (NOT endSession) and
    // it ran BEFORE the worktree removal.
    expect(killSession).toHaveBeenCalledWith('run-iz-dismiss');
    expect(endSession).not.toHaveBeenCalled();
    expect(removeWorktreeByPath).toHaveBeenCalledWith('/projects/p', '/tmp/wt/run-iz-dismiss');
    const killOrder = killSession.mock.invocationCallOrder[0];
    const removeOrder = removeWorktreeByPath.mock.invocationCallOrder[0];
    expect(killOrder).toBeLessThan(removeOrder);
    expect(getStatus('run-iz-dismiss')).toBe('canceled');
  });

  it('close-out without a wired relay bag is a no-op — the run still completes (spawn-promise resolution is the relay path only)', async () => {
    seedRun(db, { id: 'run-iz-norelay', status: 'awaiting_review', worktreePath: '/tmp/wt/run-iz-norelay' });
    // Relay bag explicitly unwired (every method throws) — endLiveInteractiveSession
    // must short-circuit BEFORE invoking it (no relayDeps when null; here we
    // assert it doesn't even call a throwing endSession by leaving it unwired).
    setRelayDeps(makeUnwiredRelayDeps());

    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    // The unwired endSession throws; the close-out swallows it (fail-soft) and the
    // guarded UPDATE still marks the run terminal.
    const result = await caller.cyboflow.runs.merge({ runId: 'run-iz-norelay', strategy: 'preserve' });
    expect(result).toEqual({ success: true });
    expect(getStatus('run-iz-norelay')).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// Boot-recovery live-state skip (IDEA-030 / TASK-818).
//
// recoverStaleAwaitingReview (approvalRouter.ts, READONLY) fails ONLY
// awaiting_review runs that still hold a PENDING approval row. A persistent
// interactive run resting in awaiting_review BETWEEN turns (turn-end rest)
// creates NO approval row, so the existing recovery already skips it — the
// live-state guard lives in the run's state (no pending approval), not in a
// rewrite of the readonly sweep. This test asserts that scoping holds for a
// persistent live/awaiting-input interactive run within a session.
// ---------------------------------------------------------------------------

describe('boot-recovery live-state skip for persistent interactive runs (IDEA-030 / TASK-818)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb({ includeSubstrate: true });
    ApprovalRouter.initialize(dbAdapter(db));
  });

  afterEach(() => {
    ApprovalRouter._resetForTesting();
    db.close();
  });

  function getStatus(runId: string): string {
    return (db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as { status: string }).status;
  }

  it('does NOT fail a persistent interactive run resting in awaiting_review with NO pending approval (turn-end rest)', () => {
    // A persistent interactive run that rests between turns: awaiting_review, no
    // pending approval row.
    seedRun(db, { id: 'run-live-rest', status: 'awaiting_review' });
    db.prepare("UPDATE workflow_runs SET substrate = 'interactive' WHERE id = ?").run('run-live-rest');

    const count = ApprovalRouter.getInstance().recoverStaleAwaitingReview();

    // No pending approval → not recovered. The live-state skip holds: the run
    // stays awaiting_review (a finished/between-turns run awaiting close-out),
    // it is NOT failed.
    expect(count).toBe(0);
    expect(getStatus('run-live-rest')).toBe('awaiting_review');
  });

  it('still fails an awaiting_review run that DOES hold a pending approval (contrast — true mid-approval stale run)', () => {
    seedRun(db, { id: 'run-gate-stale', status: 'awaiting_review' });
    db.prepare("UPDATE workflow_runs SET substrate = 'interactive' WHERE id = ?").run('run-gate-stale');
    seedApproval(db, { runId: 'run-gate-stale', status: 'pending' });

    const count = ApprovalRouter.getInstance().recoverStaleAwaitingReview();

    expect(count).toBe(1);
    expect(getStatus('run-gate-stale')).toBe('failed');
  });
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
  // (a) Returns correct WorkflowDefinition for known CyboflowWorkflowName
  // -------------------------------------------------------------------------
  it('(a) returns correct WorkflowDefinition for known workflow name (planner)', async () => {
    const runId = 'run-gps-planner';
    seedPhaseRun(db, runId, 'planner', null);

    const adapter = dbAdapter(db);
    const caller = appRouter.createCaller(createContext({ db: adapter }));
    const result = await caller.cyboflow.runs.getPhaseState({ runId });

    expect(result.definition.id).toBe('planner');
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
    // 'context' is the id of the first step in the planner 'plan' phase.
    seedPhaseRun(db, runId, 'planner', 'context');

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
    seedPhaseRun(db, runId, 'planner', null);

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
    seedPhaseRun(db, runId, 'planner', null);

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
    // 'context' is the first step of planner (plan.context).
    seedPhaseRun(db, runId, 'planner', 'context');

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
    // 'approve-idea' is the 3rd step (index 2) in planner plan phase.
    // Steps in order: context(0), research(1), approve-idea(2), epics(3), tasks(4), ...
    seedPhaseRun(db, runId, 'planner', 'approve-idea');

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
    seedPhaseRun(db, runId, 'planner', 'nonexistent.orphan-step');

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
    ).run(workflowId, 'planner');
    db.prepare(
      `INSERT INTO workflow_runs
         (id, workflow_id, project_id, worktree_path, status, policy_json, current_step_id)
       VALUES (?, ?, 1, '/tmp/test', 'completed', '{}', ?)`,
    ).run(runId, workflowId, 'context');

    const adapter = dbAdapter(db);
    const caller = appRouter.createCaller(createContext({ db: adapter }));
    const result = await caller.cyboflow.runs.getPhaseState({ runId });

    // ALL steps must be 'done' because the run is terminal.
    for (const s of result.stepStates) {
      expect(s.status, `step ${s.stepId} should be done`).toBe('done');
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
    ).run(runId, workflowId, 'execute-tasks');

    const adapter = dbAdapter(db);
    const caller = appRouter.createCaller(createContext({ db: adapter }));
    const result = await caller.cyboflow.runs.getPhaseState({ runId });

    const executeStep = result.stepStates.find((s) => s.stepId === 'execute-tasks');
    expect(executeStep, 'execute-tasks step not found in stepStates').toBeDefined();
    expect(executeStep!.status).toBe('done');
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
    seedPhaseRun(db, runId, 'planner', 'context');

    const adapter = dbAdapter(db);
    const caller = appRouter.createCaller(createContext({ db: adapter }));
    const result = await caller.cyboflow.runs.getPhaseState({ runId });

    const contextStep = result.stepStates.find((s) => s.stepId === 'context');
    expect(contextStep, 'context step not found in stepStates').toBeDefined();
    expect(contextStep!.status).toBe('running');
  });
});

// ---------------------------------------------------------------------------
// runs.getPhaseState — spec_json resolution (blueprint editor)
//
// getPhaseState now resolves the effective WorkflowDefinition via
// resolveWorkflowDefinition(name, spec_json): a valid spec_json override wins
// over the built-in fallback, a custom (non-built-in) name resolves purely from
// its spec_json, and a custom row whose spec_json='{}' has no fallback so it
// throws NOT_FOUND.
// ---------------------------------------------------------------------------

/** Seed a workflow + run with an explicit spec_json (defaults vary per test). */
function seedPhaseRunWithSpec(
  db: Database.Database,
  runId: string,
  workflowName: string,
  specJson: string,
  currentStepId: string | null = null,
  status = 'running',
): { workflowId: string; runId: string } {
  const workflowId = `wf-${runId}`;
  db.prepare(
    `INSERT INTO workflows (id, project_id, name, spec_json) VALUES (?, 1, ?, ?)`,
  ).run(workflowId, workflowName, specJson);

  db.prepare(
    `INSERT INTO workflow_runs
       (id, workflow_id, project_id, worktree_path, status, policy_json, current_step_id)
     VALUES (?, ?, 1, '/tmp/test', ?, '{}', ?)`,
  ).run(runId, workflowId, status, currentStepId);

  return { workflowId, runId };
}

/** A minimal one-phase one-step definition used for spec_json overrides. */
function makeSpecDefinition(id: string): WorkflowDefinition {
  return {
    id,
    phases: [
      {
        id: 'only',
        label: 'Only Phase',
        color: '#c96442',
        steps: [
          { id: 'edited-step', name: 'Edited step', agent: 'executor', mcps: ['filesystem'], retries: 0 },
        ],
      },
    ],
  };
}

describe('cyboflow.runs.getPhaseState — spec_json resolution', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDbWithStepTracking();
  });

  it('resolves a built-in workflow normally when spec_json is "{}"', async () => {
    const runId = 'run-gps-spec-builtin';
    seedPhaseRunWithSpec(db, runId, 'planner', '{}', null);

    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    const result = await caller.cyboflow.runs.getPhaseState({ runId });

    expect(result.definition.id).toBe('planner');
    expect(result.definition.phases.length).toBeGreaterThan(0);
  });

  it('prefers a valid spec_json override over the built-in definition', async () => {
    const runId = 'run-gps-spec-override';
    const override = makeSpecDefinition('planner');
    seedPhaseRunWithSpec(db, runId, 'planner', JSON.stringify(override), null);

    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    const result = await caller.cyboflow.runs.getPhaseState({ runId });

    // The override (single 'only' phase / 'edited-step') replaces the built-in graph.
    expect(result.definition).toEqual(override);
    expect(result.definition.phases).toHaveLength(1);
    expect(result.definition.phases[0].id).toBe('only');
    expect(result.stepStates.map((s) => s.stepId)).toEqual(['edited-step']);
  });

  it('marks the override step running when current_step_id points into the override graph', async () => {
    const runId = 'run-gps-spec-override-step';
    const override = makeSpecDefinition('planner');
    seedPhaseRunWithSpec(db, runId, 'planner', JSON.stringify(override), 'edited-step');

    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    const result = await caller.cyboflow.runs.getPhaseState({ runId });

    const edited = result.stepStates.find((s) => s.stepId === 'edited-step');
    expect(edited).toBeDefined();
    expect(edited!.status).toBe('running');
  });

  it('resolves a CUSTOM workflow (non-built-in name + valid spec_json) without throwing', async () => {
    const runId = 'run-gps-spec-custom';
    const custom = makeSpecDefinition('my-custom-flow');
    seedPhaseRunWithSpec(db, runId, 'My Custom Flow', JSON.stringify(custom), null);

    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    const result = await caller.cyboflow.runs.getPhaseState({ runId });

    expect(result.definition).toEqual(custom);
    expect(result.definition.id).toBe('my-custom-flow');
  });

  it('throws NOT_FOUND when a CUSTOM row has spec_json="{}" (no built-in fallback)', async () => {
    const runId = 'run-gps-spec-custom-empty';
    // Non-built-in name + empty spec → resolveWorkflowDefinition returns null.
    seedPhaseRunWithSpec(db, runId, 'Broken Custom Flow', '{}', null);

    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    await expect(
      caller.cyboflow.runs.getPhaseState({ runId }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'NOT_FOUND');
  });

  it('falls back to the built-in when spec_json is malformed JSON for a built-in name', async () => {
    const runId = 'run-gps-spec-malformed';
    // Lenient READ path: invalid JSON parses to null → built-in fallback for 'sprint'.
    seedPhaseRunWithSpec(db, runId, 'sprint', '{not valid json', null);

    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    const result = await caller.cyboflow.runs.getPhaseState({ runId });

    expect(result.definition.id).toBe('sprint');
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
// For every CYBOFLOW_WORKFLOW_NAMES entry, calls buildStepTransitionEvent with
// the resolveInitialStepId output, then asserts getPhaseState returns a
// stepStates entry with status='running' for that stepId. This locks the
// contract against future namespace drift between the emitter and the consumer.
// ---------------------------------------------------------------------------

describe('end-to-end stepId contract parity (INITIAL_STEP_IDS resolves into WORKFLOW_DEFINITIONS — fixes namespace mismatch)', () => {
  for (const name of CYBOFLOW_WORKFLOW_NAMES) {
    it(`${name}: buildStepTransitionEvent → getPhaseState yields status=running for the resolved initial step`, async () => {
      const stepId = resolveInitialStepId(name);
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

// ---------------------------------------------------------------------------
// runs.listFiles / runs.readFile — File Explorer wrapper-layer integration
//
// Handler-level behavior (path safety, binary detection, sorting, symlink
// containment) is covered by
// main/src/orchestrator/__tests__/runFileExplorer.test.ts. These tests target
// the tRPC layer: the ctx.db guard and the RunFileError -> TRPCError code map
// (NOT_FOUND / PRECONDITION_FAILED / BAD_REQUEST) wired in runs.ts.
// ---------------------------------------------------------------------------

describe('cyboflow.runs.listFiles / readFile', () => {
  let db: Database.Database;
  let worktree: string;
  const RUN = 'run-files-1';

  beforeEach(() => {
    db = createTestDb();
    worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboflow-files-'));
    seedRun(db, { id: RUN, projectId: 1, worktreePath: worktree });
  });

  afterEach(() => {
    fs.rmSync(worktree, { recursive: true, force: true });
  });

  function caller() {
    return appRouter.createCaller(createContext({ db: dbAdapter(db) }));
  }

  it('listFiles returns the worktree entries', async () => {
    fs.writeFileSync(path.join(worktree, 'a.txt'), 'hi');
    fs.mkdirSync(path.join(worktree, 'dir'));
    const entries = await caller().cyboflow.runs.listFiles({ runId: RUN });
    expect(entries.map((e) => e.name).sort()).toEqual(['a.txt', 'dir']);
  });

  it('readFile returns file content', async () => {
    fs.writeFileSync(path.join(worktree, 'note.md'), 'body');
    const result = await caller().cyboflow.runs.readFile({ runId: RUN, path: 'note.md' });
    expect(result).toMatchObject({ path: 'note.md', content: 'body', unviewableReason: null });
  });

  it('listFiles: missing ctx.db → PRECONDITION_FAILED', async () => {
    const c = appRouter.createCaller(createContext());
    await expect(c.cyboflow.runs.listFiles({ runId: RUN })).rejects.toSatisfy(
      (err: unknown) => err instanceof TRPCError && err.code === 'PRECONDITION_FAILED',
    );
  });

  it('listFiles: unknown runId → NOT_FOUND (run-not-found mapping)', async () => {
    await expect(caller().cyboflow.runs.listFiles({ runId: 'nope' })).rejects.toSatisfy(
      (err: unknown) => err instanceof TRPCError && err.code === 'NOT_FOUND',
    );
  });

  it('listFiles: run with no worktree → PRECONDITION_FAILED (no-worktree mapping)', async () => {
    seedRun(db, { id: 'run-nowt', projectId: 1 });
    db.prepare('UPDATE workflow_runs SET worktree_path = NULL WHERE id = ?').run('run-nowt');
    await expect(caller().cyboflow.runs.listFiles({ runId: 'run-nowt' })).rejects.toSatisfy(
      (err: unknown) => err instanceof TRPCError && err.code === 'PRECONDITION_FAILED',
    );
  });

  it('listFiles: traversal path → BAD_REQUEST (invalid-path mapping)', async () => {
    await expect(caller().cyboflow.runs.listFiles({ runId: RUN, path: '../..' })).rejects.toSatisfy(
      (err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST',
    );
  });

  it('readFile: directory target → BAD_REQUEST (not-a-file mapping)', async () => {
    fs.mkdirSync(path.join(worktree, 'sub'));
    await expect(caller().cyboflow.runs.readFile({ runId: RUN, path: 'sub' })).rejects.toSatisfy(
      (err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST',
    );
  });

  it('readFile: missing file → NOT_FOUND (not-found mapping)', async () => {
    await expect(caller().cyboflow.runs.readFile({ runId: RUN, path: 'gone.txt' })).rejects.toSatisfy(
      (err: unknown) => err instanceof TRPCError && err.code === 'NOT_FOUND',
    );
  });
});

// ---------------------------------------------------------------------------
// cyboflow.runs.gitDiff — run-scoped working-directory Diff tab.
//
// The diff capture is performed via the injected ctx.gitDiff closure (backed by
// GitDiffManager in index.ts), so the tests stub it and assert the router:
//   (a) resolves workflow_runs.worktree_path and forwards it to ctx.gitDiff,
//       returning the dep's payload verbatim;
//   (b) returns null when the run has no worktree_path (without calling the dep);
//   (c) throws NOT_FOUND for an unknown run;
//   (d) throws PRECONDITION_FAILED when ctx.db is missing;
//   (e) throws PRECONDITION_FAILED when ctx.gitDiff is not wired.
// ---------------------------------------------------------------------------

describe('cyboflow.runs.gitDiff (run-scoped Diff tab)', () => {
  let db: Database.Database;

  beforeEach(() => {
    // base_sha is a migration-014 column (run->task link); the handler SELECTs it.
    db = createTestDb({ includeWorkflowRunTaskColumns: true });
  });

  afterEach(() => {
    db.close();
  });

  it('(a) resolves worktree_path → forwards to ctx.gitDiff (base_sha undefined) and returns its payload', async () => {
    const { runId } = seedRun(db, { worktreePath: '/tmp/run-worktree' });
    const payload = {
      diff: 'diff --git a/x.ts b/x.ts\n@@ -0,0 +1 @@\n+hi\n',
      stats: { additions: 1, deletions: 0, filesChanged: 1 },
      changedFiles: ['x.ts'],
    };
    const gitDiff = vi.fn().mockResolvedValue(payload);

    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db), gitDiff }));
    const result = await caller.cyboflow.runs.gitDiff({ runId });

    // No base_sha seeded → forwarded as undefined (working-directory fallback).
    expect(gitDiff).toHaveBeenCalledWith('/tmp/run-worktree', undefined);
    expect(result).toEqual(payload);
  });

  it('(a2) forwards the run base_sha so committed work is diffed against launch', async () => {
    const { runId } = seedRun(db, { worktreePath: '/tmp/run-worktree', baseSha: 'base123' });
    const payload = {
      diff: 'diff --git a/y.ts b/y.ts\n@@ -0,0 +1 @@\n+yo\n',
      stats: { additions: 1, deletions: 0, filesChanged: 1 },
      changedFiles: ['y.ts'],
    };
    const gitDiff = vi.fn().mockResolvedValue(payload);

    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db), gitDiff }));
    const result = await caller.cyboflow.runs.gitDiff({ runId });

    expect(gitDiff).toHaveBeenCalledWith('/tmp/run-worktree', 'base123');
    expect(result).toEqual(payload);
  });

  it('(b) no worktree_path → returns null without calling ctx.gitDiff', async () => {
    const { runId } = seedRun(db);
    // Clear the worktree path directly (seedRun always sets a default) to model a
    // not-yet-materialized run.
    db.prepare('UPDATE workflow_runs SET worktree_path = NULL WHERE id = ?').run(runId);
    const gitDiff = vi.fn().mockResolvedValue({
      diff: '',
      stats: { additions: 0, deletions: 0, filesChanged: 0 },
      changedFiles: [],
    });

    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db), gitDiff }));
    const result = await caller.cyboflow.runs.gitDiff({ runId });

    expect(result).toBeNull();
    expect(gitDiff).not.toHaveBeenCalled();
  });

  it('(c) unknown run → NOT_FOUND', async () => {
    const gitDiff = vi.fn();
    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db), gitDiff }));
    await expect(caller.cyboflow.runs.gitDiff({ runId: 'no-such-run' })).rejects.toSatisfy(
      (err: unknown) => err instanceof TRPCError && err.code === 'NOT_FOUND',
    );
    expect(gitDiff).not.toHaveBeenCalled();
  });

  it('(d) missing ctx.db → PRECONDITION_FAILED', async () => {
    const caller = appRouter.createCaller(createContext({ gitDiff: vi.fn() }));
    await expect(caller.cyboflow.runs.gitDiff({ runId: 'any-run' })).rejects.toSatisfy(
      (err: unknown) => err instanceof TRPCError && err.code === 'PRECONDITION_FAILED',
    );
  });

  it('(e) gitDiff dep not wired → PRECONDITION_FAILED', async () => {
    const { runId } = seedRun(db);
    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    await expect(caller.cyboflow.runs.gitDiff({ runId })).rejects.toSatisfy(
      (err: unknown) => err instanceof TRPCError && err.code === 'PRECONDITION_FAILED',
    );
  });
});
