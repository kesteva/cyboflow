/**
 * LC-2 (M2 review): a REMOTE session-create job provisions the environment worktree (bare init, base push of possibly
 * the full history, worktree add) BEFORE session-created fires, so the create-quick waiter must not give up at the
 * local 30s default — and when it does give up, the late session must be retired instead of orphaned.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createQuickSessionCore,
  REMOTE_QUICK_SESSION_CREATE_TIMEOUT_MS,
  REMOTE_QUICK_SESSION_TIMEOUT_MESSAGE,
  _resetClaimedQuickSessionIdsForTesting,
  type CreateQuickSessionCoreDeps,
  type QuickSessionRow,
} from '../createQuickSessionCore';
import { setRemoteCheckout } from '../hosts/remoteCheckoutBridge';

// The sentinel's guarded running transition needs a real DB; the waiter is what is under test here.
vi.mock('../cyboflow/transitions', () => ({ transitionToRunning: () => undefined }));

const WT = '/home/me/cf-remote/h-ssh/wt/q';

interface Harness {
  deps: CreateQuickSessionCoreDeps;
  emitCreated(row: QuickSessionRow): void;
  failJob(jobId: string): void;
  listenerCount(): number;
  order: string[];
}

function harness(opts: { withDismiss?: boolean } = {}): Harness {
  const order: string[] = [];
  const created = new Set<(s: QuickSessionRow) => void>();
  const failed = new Set<(jobId: string, error: Error) => void>();
  setRemoteCheckout({
    worktreeExists: async () => false,
    resolveBase: async () => ({ baseCommit: 'a'.repeat(40), baseBranch: 'HEAD', baseRef: 'HEAD' }),
    plannedWorktreePath: () => WT,
    ensureSessionWorktree: async () => ({ remoteWorktreePath: WT, baseSha: 'a'.repeat(40), baseBranch: 'HEAD' }),
    removeSessionWorktree: async (sessionId) => {
      order.push(`remote:${sessionId}`);
      return true;
    },
  });
  const db = { prepare: () => ({ run: () => ({ changes: 1 }) }) };
  const deps: CreateQuickSessionCoreDeps = {
    taskQueue: {
      createSession: async () => ({ id: 'job-1' }),
      onSessionJobFailed: (l) => {
        failed.add(l);
        return () => failed.delete(l);
      },
    },
    sessionManager: {
      on: (_e, l) => {
        created.add(l);
      },
      removeListener: (_e, l) => {
        created.delete(l);
      },
      archiveSession: async (sessionId) => {
        order.push(`archive:${sessionId}`);
      },
    },
    workflowRegistry: {
      ensureQuickWorkflow: () => 'wf',
      createRun: () => ({ runId: 'r-1', substrate: 'sdk' }),
    },
    getDb: () => db as unknown as ReturnType<CreateQuickSessionCoreDeps['getDb']>,
    ...(opts.withDismiss
      ? {
          dismissHalfCreatedSession: async (sessionId: string) => {
            order.push(`dismiss:${sessionId}`);
          },
        }
      : {}),
  };
  return {
    deps,
    order,
    emitCreated: (row) => {
      for (const l of [...created]) l(row);
    },
    failJob: (jobId) => {
      for (const l of [...failed]) l(jobId, new Error('late failure'));
    },
    listenerCount: () => created.size,
  };
}

/** Settle the core's awaited createSession so the waiter (and its timer) is armed. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('createQuickSessionCore — remote create waiter (LC-2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetClaimedQuickSessionIdsForTesting();
  });
  afterEach(() => {
    vi.useRealTimers();
    setRemoteCheckout(null);
  });

  it('a remote create is still waiting past the local 30s default and resolves when provisioning lands', async () => {
    const h = harness();
    const p = createQuickSessionCore(h.deps, { projectId: 1, nameHint: 'q', hostId: 'h-ssh' });
    let settled = false;
    p.then(() => (settled = true), () => (settled = true));
    await flush();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(settled).toBe(false);
    h.emitCreated({ id: 's-1', worktreePath: WT });
    await expect(p).resolves.toMatchObject({ session: { id: 's-1' }, runId: 'r-1' });
    expect(h.order).toEqual([]);
  });

  it('the remote budget covers the checkout step budgets (push 30 min + worktree add 10 min)', () => {
    expect(REMOTE_QUICK_SESSION_CREATE_TIMEOUT_MS).toBeGreaterThanOrEqual(40 * 60_000);
  });

  it('a LOCAL create keeps the 30s default and its generic message', async () => {
    const h = harness();
    const p = createQuickSessionCore(h.deps, { projectId: 1, nameHint: 'q' });
    const assertion = expect(p).rejects.toThrow('Timed out waiting for quick session to be created');
    await flush();
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    // No late watch for a local session: a late emit is not compensated.
    expect(h.listenerCount()).toBe(0);
  });

  it('on a remote waiter timeout, a late session is retired (environment worktree removed, row archived)', async () => {
    const h = harness();
    const p = createQuickSessionCore(h.deps, { projectId: 1, nameHint: 'q', hostId: 'h-ssh' });
    const assertion = expect(p).rejects.toThrow(REMOTE_QUICK_SESSION_TIMEOUT_MESSAGE);
    await flush();
    await vi.advanceTimersByTimeAsync(REMOTE_QUICK_SESSION_CREATE_TIMEOUT_MS);
    await assertion;
    // An unrelated session is ignored.
    h.emitCreated({ id: 's-other', worktreePath: '/home/me/cf-remote/h-ssh/wt/other' });
    h.emitCreated({ id: 's-late', worktreePath: WT });
    await flush();
    expect(h.order).toEqual(['remote:s-late', 'archive:s-late']);
    expect(h.listenerCount()).toBe(0);
  });

  it('prefers the wired full dismiss over a bare archive', async () => {
    const h = harness({ withDismiss: true });
    const p = createQuickSessionCore(h.deps, { projectId: 1, nameHint: 'q', hostId: 'h-ssh' });
    const assertion = expect(p).rejects.toThrow(REMOTE_QUICK_SESSION_TIMEOUT_MESSAGE);
    await flush();
    await vi.advanceTimersByTimeAsync(REMOTE_QUICK_SESSION_CREATE_TIMEOUT_MS);
    await assertion;
    h.emitCreated({ id: 's-late', worktreePath: WT });
    await flush();
    expect(h.order).toEqual(['remote:s-late', 'dismiss:s-late']);
  });

  it('a job that fails late drops the watch (the task queue already compensated it)', async () => {
    const h = harness();
    const p = createQuickSessionCore(h.deps, { projectId: 1, nameHint: 'q', hostId: 'h-ssh' });
    const assertion = expect(p).rejects.toThrow(REMOTE_QUICK_SESSION_TIMEOUT_MESSAGE);
    await flush();
    await vi.advanceTimersByTimeAsync(REMOTE_QUICK_SESSION_CREATE_TIMEOUT_MS);
    await assertion;
    expect(h.listenerCount()).toBe(1);
    h.failJob('job-1');
    expect(h.listenerCount()).toBe(0);
  });

  it('the late watch expires so a job that never settles cannot leak the listener', async () => {
    const h = harness();
    const p = createQuickSessionCore(h.deps, { projectId: 1, nameHint: 'q', hostId: 'h-ssh' });
    const assertion = expect(p).rejects.toThrow(REMOTE_QUICK_SESSION_TIMEOUT_MESSAGE);
    await flush();
    await vi.advanceTimersByTimeAsync(REMOTE_QUICK_SESSION_CREATE_TIMEOUT_MS);
    await assertion;
    await vi.advanceTimersByTimeAsync(REMOTE_QUICK_SESSION_CREATE_TIMEOUT_MS);
    expect(h.listenerCount()).toBe(0);
  });
});
