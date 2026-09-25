/**
 * cyboflow_request_verification on the MCP path — the lane RUNBOOK BOOTSTRAP
 * deferral. The controller seam (`enqueueTaskVerification`) always ran the
 * bootstrap before writing a row; the MCP path (the orchestrated plane, and any
 * run handed over from programmatic mid-flight) went straight to the §3.2
 * "no proven runbook" skip. Observed live 2026-09-22 (noble-badger, TASK-274): a
 * project with only an unproven draft could never earn a runbook from an
 * orchestrated sprint.
 *
 * These pin the seam: an eligible lane request is ACKED as deferred and enqueued
 * after the bootstrap settles, keyed to the attempt that fired it; everything
 * else enqueues immediately, exactly as before.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type * as net from 'net';

vi.mock('../../verify/enqueueFromTask', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../verify/enqueueFromTask')>();
  return {
    ...actual,
    prepareVerificationEnqueue: vi.fn(async (args: { task?: unknown }) => ({
      ok: true,
      task: args.task,
      modality: 'cdp-app',
    })),
    resolveEnqueueModality: vi.fn(async (args: { task: unknown }) => ({ modality: 'cdp-app', task: args.task })),
  };
});
vi.mock('../../verify/snapshotProvisioner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../verify/snapshotProvisioner')>();
  return { ...actual, captureSnapshotSha: vi.fn(async () => 'sha-after-bootstrap'), isWorktreeDirty: vi.fn(async () => false) };
});

import { VerifyToolHandlers, type VerifyToolContext } from '../handlers/verifyToolHandlers';
import type { McpQueryMessage, McpQueryResponse } from '../mcpQueryMessages';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import { VerificationScheduler } from '../../verify/verificationScheduler';
import { SprintLaneStore } from '../../sprintLaneStore';
import { prepareVerificationEnqueue, resolveEnqueueModality } from '../../verify/enqueueFromTask';

const client = {} as net.Socket;
const WORKTREE = '/tmp/wt-run-ok';

const TASK = {
  version: 1,
  summary: 'the canvas shows each step model',
  taskRef: 'TASK-1',
  build: ['pnpm run build:main'],
  serve: { cmd: 'pnpm run electron-dev', attach: 'cdp', readyWhen: { urlPath: '/', timeoutMs: 180000 } },
  behaviors: [{ id: 'b1', description: 'model shows', expected: 'the model label is visible' }],
};

type Decision = { proceed: true; mode: 'derive'; adopt: boolean } | { proceed: false; reason: string };

interface FakeScheduler {
  evaluateRunbookBootstrap: ReturnType<typeof vi.fn>;
  maybeBootstrapRunbook: ReturnType<typeof vi.fn>;
  enqueue: ReturnType<typeof vi.fn>;
  nudge: ReturnType<typeof vi.fn>;
}

function setup(opts: { batchId?: string | null; decision?: Decision; bootstrap?: () => Promise<unknown> } = {}) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, batch_id TEXT, verify_enabled INTEGER,
    verify_type TEXT, verify_chain TEXT)`);
  db.prepare(
    `INSERT INTO workflow_runs (id, batch_id, verify_enabled, verify_type, verify_chain)
     VALUES ('run-ok', ?, 1, 'interactive-web-behavior', '[]')`,
  ).run(opts.batchId === undefined ? 'batch-1' : opts.batchId);

  const scheduler: FakeScheduler = {
    evaluateRunbookBootstrap: vi.fn(async () => opts.decision ?? { proceed: true, mode: 'derive', adopt: false }),
    maybeBootstrapRunbook: vi.fn(opts.bootstrap ?? (async () => ({ kind: 'proven' }))),
    enqueue: vi.fn(() => 'vr-1'),
    nudge: vi.fn(),
  };
  vi.spyOn(VerificationScheduler, 'getInstance').mockReturnValue(scheduler as unknown as VerificationScheduler);
  vi.spyOn(VerificationScheduler, 'tryGetInstance').mockReturnValue(scheduler as unknown as VerificationScheduler);
  vi.spyOn(SprintLaneStore, 'getInstance').mockReturnValue({
    listLanes: () => [{ taskId: 'tsk_1', ref: 'TASK-1', attempts: 2 }],
  } as unknown as SprintLaneStore);

  const writes: McpQueryResponse[] = [];
  const ctx: VerifyToolContext = {
    db: dbAdapter(db),
    deps: {},
    writeResponse: (_c, response) => {
      writes.push(response);
    },
    resolveReviewItemRunContext: () => ({ ok: true, projectId: 6, actor: 'agent:test' }),
    resolveRunWorktree: () => WORKTREE,
    resolveProjectPath: () => null,
    readExecutionModel: () => 'orchestrated',
  };
  return { tools: new VerifyToolHandlers(ctx), scheduler, writes };
}

function request(requestId: string): Extract<McpQueryMessage, { type: 'mcp-request-verification' }> {
  return { type: 'mcp-request-verification', requestId, runId: 'run-ok', intent: TASK.summary, task: TASK, taskRef: 'TASK-1' };
}

/** Let the fire-and-forget bootstrap → enqueue chain run to completion. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
}

describe('VerifyToolHandlers — runbook bootstrap on the MCP path', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('acks a lane request as deferred, bootstraps, then enqueues keyed to the attempt that fired', async () => {
    let finishBootstrap: (v: unknown) => void = () => undefined;
    const { tools, scheduler, writes } = setup({
      bootstrap: () => new Promise((r) => (finishBootstrap = r)),
    });

    await tools.handleRequestVerification(request('r1'), client);

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ ok: true, data: { requestId: null, deferred: 'runbook-bootstrap' } });
    expect(writes[0].ok && (writes[0].data as { skipped?: unknown }).skipped).toBeFalsy();
    expect(scheduler.evaluateRunbookBootstrap).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 6, runId: 'run-ok', laneTaskRef: 'tsk_1', modality: 'cdp-app', probePath: WORKTREE }),
    );
    await settle();
    expect(scheduler.maybeBootstrapRunbook).toHaveBeenCalledTimes(1);
    expect(scheduler.enqueue).not.toHaveBeenCalled();

    finishBootstrap({ kind: 'proven' });
    await settle();

    expect(scheduler.enqueue).toHaveBeenCalledTimes(1);
    expect(scheduler.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-ok', enqueueKey: 'run-ok:TASK-1:2', snapshotSha: 'sha-after-bootstrap' }),
    );
    // The preparation sees the SAME modality + tree the bootstrap ran on.
    expect(vi.mocked(prepareVerificationEnqueue)).toHaveBeenCalledWith(
      expect.objectContaining({ modality: 'cdp-app', probePath: WORKTREE }),
    );
    expect(scheduler.nudge).toHaveBeenCalled();
    expect(writes).toHaveLength(1); // the deferred path never writes a second reply
  });

  it('a re-fire while the bootstrap is in flight gets the same deferred ack and starts no second bootstrap', async () => {
    let finishBootstrap: (v: unknown) => void = () => undefined;
    const { tools, scheduler, writes } = setup({
      bootstrap: () => new Promise((r) => (finishBootstrap = r)),
    });

    await tools.handleRequestVerification(request('r1'), client);
    await tools.handleRequestVerification(request('r2'), client);

    expect(writes.map((w) => w.ok && (w.data as { deferred?: string }).deferred)).toEqual([
      'runbook-bootstrap',
      'runbook-bootstrap',
    ]);
    await settle();
    expect(scheduler.maybeBootstrapRunbook).toHaveBeenCalledTimes(1);

    finishBootstrap({ kind: 'declined' });
    await settle();
    expect(scheduler.enqueue).toHaveBeenCalledTimes(1);
  });

  it('still enqueues when the bootstrap throws, so the parked lane is never stranded', async () => {
    const { tools, scheduler } = setup({
      bootstrap: async () => {
        throw new Error('boom');
      },
    });

    await tools.handleRequestVerification(request('r1'), client);
    await settle();

    expect(scheduler.enqueue).toHaveBeenCalledTimes(1);
    expect(scheduler.enqueue).toHaveBeenCalledWith(expect.objectContaining({ enqueueKey: 'run-ok:TASK-1:2' }));
  });

  it('a declined preflight enqueues immediately and replies with the request id, as before', async () => {
    const { tools, scheduler, writes } = setup({ decision: { proceed: false, reason: 'already-proven' } });

    await tools.handleRequestVerification(request('r1'), client);

    expect(scheduler.maybeBootstrapRunbook).not.toHaveBeenCalled();
    expect(scheduler.enqueue).toHaveBeenCalledTimes(1);
    expect(writes[0]).toMatchObject({ ok: true, data: { requestId: 'vr-1', snapshotSha: 'sha-after-bootstrap' } });
  });

  // §A2 — resolution can hand back a DIFFERENT task (a project-surface hit adds
  // an inferred `app` block). The bootstrap decision and the deferred
  // preparation must both see THAT task, or the row would persist the composed
  // one and re-derive to `web`.
  it('threads the task resolution returned (an inferred app) to the bootstrap AND the deferred preparation', async () => {
    const inferred = {
      ...TASK,
      serve: undefined,
      modality: 'mobile',
      app: { platform: 'ios-simulator', bundleId: 'com.example.app', scheme: 'App', _inferred: true },
    };
    vi.mocked(resolveEnqueueModality).mockResolvedValueOnce({
      modality: 'mobile',
      task: inferred as unknown as Parameters<typeof resolveEnqueueModality>[0]['task'],
    });
    const { tools, scheduler } = setup();

    await tools.handleRequestVerification(request('r1'), client);
    await settle();

    expect(scheduler.evaluateRunbookBootstrap).toHaveBeenCalledWith(
      expect.objectContaining({ modality: 'mobile', task: inferred }),
    );
    expect(scheduler.maybeBootstrapRunbook).toHaveBeenCalledWith(expect.objectContaining({ task: inferred }));
    expect(vi.mocked(prepareVerificationEnqueue)).toHaveBeenCalledWith(
      expect.objectContaining({ modality: 'mobile', task: inferred }),
    );
  });

  it('the immediate path hands the preparation the run worktree as the surface-probe root', async () => {
    const { tools } = setup({ decision: { proceed: false, reason: 'already-proven' } });

    await tools.handleRequestVerification(request('r1'), client);

    expect(vi.mocked(prepareVerificationEnqueue)).toHaveBeenCalledWith(
      expect.objectContaining({ surfaceRoot: WORKTREE }),
    );
    expect(vi.mocked(prepareVerificationEnqueue)).toHaveBeenCalledWith(
      expect.not.objectContaining({ probePath: expect.anything() }),
    );
  });

  it('a run with no sprint batch is not lane traffic: no preflight, immediate unkeyed enqueue', async () => {
    const { tools, scheduler, writes } = setup({ batchId: null });

    await tools.handleRequestVerification(request('r1'), client);

    expect(scheduler.evaluateRunbookBootstrap).not.toHaveBeenCalled();
    expect(scheduler.enqueue).toHaveBeenCalledWith(expect.not.objectContaining({ enqueueKey: expect.anything() }));
    expect(writes[0]).toMatchObject({ ok: true, data: { requestId: 'vr-1' } });
  });
});
