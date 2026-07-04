/**
 * Tier-2 chokepoint integration — sprint-batch fan-out through the REAL
 * TaskChangeRouter + SprintLaneStore chokepoints over a full-migration-chain DB.
 *
 * Scenario 4 (create sprint batch → DAG fan-out): three tasks are minted through
 * cyboflow_create_task, a blocking edge is recorded through
 * cyboflow_add_task_dependency, then cyboflow_create_sprint_batch materializes the
 * batch. Asserts the three surfaces the fan-out spans:
 *   - task rows        (tasks — written by TaskChangeRouter on create)
 *   - task_dependencies (the DAG edge — written by TaskChangeRouter on add-dep)
 *   - sprint-lane rows  (sprint_batches + sprint_batch_tasks — written by
 *                        SprintLaneStore.createForRun via the batch handler)
 * plus the CAS batch_id stamp on the run.
 *
 * The run is a non-plan-gated 'sprint' run, so created tasks are auto-approved +
 * land at "Ready for development" (board pos 6) — sprint-eligible for createForRun.
 * Everything below the MCP handler is real; the content-driven artifact mint hook
 * is stubbed (fire-and-forget side effect, not under test).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { McpQueryHandler } from '../../mcpServer/mcpQueryHandler';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import { TaskChangeRouter, taskChangeEvents } from '../../taskChangeRouter';
import { SprintLaneStore, sprintLaneEvents } from '../../sprintLaneStore';
import { runStatusEvents } from '../../trpc/routers/events';
import {
  createIntegrationDb,
  seedWorkflowRun,
  stageId,
  makeSocketDouble,
  parseLastWrite,
  type IntegrationDb,
} from './integrationHarness';

vi.mock('../../autoMintArtifacts', () => ({
  handleEntityWrite: vi.fn(() => Promise.resolve()),
  handleRunStart: vi.fn(() => Promise.resolve()),
  handleStepCompletion: vi.fn(() => Promise.resolve()),
}));

describe('Tier-2 chokepoint — create sprint batch fans out a DAG (TaskChangeRouter + SprintLaneStore)', () => {
  let fixture: IntegrationDb;
  let handler: McpQueryHandler;

  beforeEach(() => {
    fixture = createIntegrationDb();
    TaskChangeRouter.initialize(dbAdapter(fixture.db));
    SprintLaneStore.initialize(dbAdapter(fixture.db));
    handler = new McpQueryHandler(dbAdapter(fixture.db));
  });

  afterEach(() => {
    TaskChangeRouter._resetForTesting();
    SprintLaneStore._resetForTesting();
    taskChangeEvents.removeAllListeners();
    sprintLaneEvents.removeAllListeners();
    runStatusEvents.removeAllListeners();
    fixture.cleanup();
  });

  /** Mint a TASK through the chokepoint and return its opaque id. */
  async function createTask(runId: string, title: string): Promise<string> {
    const s = makeSocketDouble();
    await handler.handleMessage(
      { type: 'mcp-create-task', requestId: `ct-${title}`, runId, taskType: 'task', title },
      s.socket,
    );
    const res = parseLastWrite(s.writes);
    expect(res.ok).toBe(true);
    return (res.data as { task_id: string }).task_id;
  }

  it('materializes a batch + one lane per created task, records the dependency edge, and CAS-stamps batch_id', async () => {
    const { db } = fixture;
    seedWorkflowRun(db, {
      runId: 'run-sprint',
      workflowName: 'sprint', // NOT plan-gated → created tasks are approved + sprint-eligible
      currentStepId: 'plan',
      stepsSnapshot: { plan: 'planner' },
    });

    // ── three tasks through the chokepoint ──────────────────────────────────
    const tA = await createTask('run-sprint', 'Task A');
    const tB = await createTask('run-sprint', 'Task B');
    const tC = await createTask('run-sprint', 'Task C');

    // All three tasks landed in `tasks`, approved, at "Ready for development".
    const taskRows = db
      .prepare('SELECT id, stage_id, approved_at FROM tasks ORDER BY ref')
      .all() as Array<{ id: string; stage_id: string; approved_at: string | null }>;
    expect(taskRows.map((r) => r.id)).toEqual([tA, tB, tC]);
    for (const r of taskRows) {
      expect(r.stage_id).toBe(stageId(6));
      expect(r.approved_at).not.toBeNull();
    }

    // ── a blocking DAG edge: C depends on A ─────────────────────────────────
    const dep = makeSocketDouble();
    await handler.handleMessage(
      { type: 'mcp-add-task-dependency', requestId: 'dep-1', runId: 'run-sprint', taskId: tC, dependsOnTaskId: tA },
      dep.socket,
    );
    const depRes = parseLastWrite(dep.writes);
    expect(depRes.ok).toBe(true);
    expect(depRes.data).toMatchObject({ task_id: tC, depends_on_task_id: tA, kind: 'blocking' });

    // The edge is persisted in task_dependencies (the DAG the lane store reads).
    const edges = db
      .prepare('SELECT task_id, depends_on_task_id, kind FROM task_dependencies')
      .all() as Array<{ task_id: string; depends_on_task_id: string; kind: string }>;
    expect(edges).toEqual([{ task_id: tC, depends_on_task_id: tA, kind: 'blocking' }]);

    // ── materialize the sprint batch (fan-out) ──────────────────────────────
    const emitted: Array<{ runId: string; status: string }> = [];
    runStatusEvents.on('changed', (e: { runId: string; status: string }) => emitted.push(e));

    const batch = makeSocketDouble();
    await handler.handleMessage(
      { type: 'mcp-create-sprint-batch', requestId: 'sb-1', runId: 'run-sprint' },
      batch.socket,
    );
    const batchRes = parseLastWrite(batch.writes);
    expect(batchRes.ok).toBe(true);
    const batchData = batchRes.data as { batch_id: string; created: boolean };
    expect(batchData.created).toBe(true);
    const batchId = batchData.batch_id;

    // Exactly one sprint_batches row was minted for project 1.
    const batchCount = db.prepare('SELECT COUNT(*) AS n FROM sprint_batches').get() as { n: number };
    expect(batchCount.n).toBe(1);

    // One lane (sprint_batch_tasks) per created task, all queued.
    const lanes = db
      .prepare('SELECT task_id, status FROM sprint_batch_tasks WHERE batch_id = ? ORDER BY task_id')
      .all(batchId) as Array<{ task_id: string; status: string }>;
    expect(lanes.map((l) => l.task_id).sort()).toEqual([tA, tB, tC].sort());
    expect(lanes.every((l) => l.status === 'queued')).toBe(true);

    // The CAS stamp landed on the run row (drives the swimlane-canvas mount).
    const runRow = db.prepare('SELECT batch_id FROM workflow_runs WHERE id = ?').get('run-sprint') as {
      batch_id: string | null;
    };
    expect(runRow.batch_id).toBe(batchId);

    // The dependency edge survives materialization (fan-out does not reap the DAG).
    const edgesAfter = db.prepare('SELECT COUNT(*) AS n FROM task_dependencies').get() as { n: number };
    expect(edgesAfter.n).toBe(1);

    // The swimlane-mount signal fired once, re-asserting 'running'.
    expect(emitted).toEqual([{ runId: 'run-sprint', status: 'running' }]);
  });
});
