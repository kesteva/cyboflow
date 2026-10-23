/**
 * Environments (M2-C2): the session-creation processor's REMOTE branch. A remote job resolves its base locally,
 * writes the session row with the planned remote path, sets the worktree up on the environment through the
 * RemoteCheckout service (remoteCheckoutBridge), and never touches worktreeManager.createWorktree, the local
 * worktree-folder probe or the build script. A failure compensates (remote cleanup + archive the hidden row) and
 * never falls back to This Mac. A local job provisions exactly as before.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../panelManager', () => ({
  panelManager: {
    ensureDiffPanel: vi.fn().mockResolvedValue(undefined),
    getPanelsForSession: vi.fn().mockReturnValue([]),
  },
}));

import { TaskQueue } from '../taskQueue';
import { setRemoteCheckout } from '../hosts/remoteCheckoutBridge';
import type { RemoteCheckoutLike } from '../hosts/remoteCheckout';

function harness(opts: { buildScript?: string | null; takenRemote?: string[] } = {}) {
  const createWorktree = vi.fn().mockResolvedValue({
    worktreePath: '/proj/worktrees/q',
    baseCommit: 'abc',
    baseBranch: 'main',
  });
  const createSession = vi.fn().mockImplementation(async (_n: string, worktreePath: string) => ({ id: 's-1', worktreePath }));
  const sessionManager = {
    db: { checkSessionNameExists: () => false },
    getProjectById: () => ({ id: 7, path: '/nonexistent-proj-for-test', worktree_folder: null, build_script: opts.buildScript ?? null }),
    createSession,
    emitSessionCreated: vi.fn(),
    archiveSession: vi.fn().mockResolvedValue(undefined),
    updateSessionStatus: vi.fn(),
    addSessionOutput: vi.fn().mockResolvedValue(undefined),
    runBuildScript: vi.fn().mockResolvedValue({ success: true }),
  };
  const taken = new Set(opts.takenRemote ?? []);
  const checkout = {
    worktreeExists: vi.fn(async (_h: string, name: string) => taken.has(name)),
    resolveBase: vi.fn(async () => ({ baseCommit: 'b'.repeat(40), baseBranch: 'HEAD', baseRef: 'HEAD' })),
    plannedWorktreePath: vi.fn((_h: string, key: string) => `/home/me/cf-remote/h-ssh/wt/${key}`),
    ensureSessionWorktree: vi.fn(async (input: { sessionKey: string }) => ({
      remoteWorktreePath: `/home/me/cf-remote/h-ssh/wt/${input.sessionKey}`,
      baseSha: 'b'.repeat(40),
      baseBranch: 'HEAD',
    })),
    removeSessionWorktree: vi.fn(async () => true),
  } satisfies RemoteCheckoutLike;
  const queue = new TaskQueue({
    sessionManager,
    worktreeManager: { createWorktree },
    claudeCodeManager: {},
    gitDiffManager: {},
    executionTracker: {},
  } as unknown as ConstructorParameters<typeof TaskQueue>[0]);
  return { queue, createWorktree, createSession, sessionManager, checkout };
}

function settle(queue: TaskQueue, data: Parameters<TaskQueue['createSession']>[0]): Promise<Error | null> {
  return new Promise((resolve) => {
    const off = queue.onSessionJobFailed((_id, err) => {
      off();
      resolve(err);
    });
    void queue.createSession(data).then(() => {
      // Let the processor run to completion before declaring success.
      setTimeout(() => {
        off();
        resolve(null);
      }, 20);
    });
  });
}

const BASE = { prompt: '', worktreeTemplate: 'q', projectId: 7 };

afterEach(() => {
  setRemoteCheckout(null);
});

describe('TaskQueue session-creation processor — remote host (M2-C2)', () => {
  it('a remote job sets the worktree up on the environment and never provisions locally', async () => {
    const h = harness({ buildScript: 'pnpm i' });
    setRemoteCheckout(h.checkout);
    expect(await settle(h.queue, { ...BASE, hostId: 'h-ssh', baseBranch: 'main' })).toBeNull();
    expect(h.createWorktree).not.toHaveBeenCalled();
    expect(h.checkout.worktreeExists).toHaveBeenCalledWith('h-ssh', 'q');
    expect(h.checkout.resolveBase).toHaveBeenCalledWith('/nonexistent-proj-for-test', { baseBranch: 'main', baseCommittish: undefined });
    const args = h.createSession.mock.calls[0];
    expect(args[1]).toBe('/home/me/cf-remote/h-ssh/wt/q');
    expect(args[3]).toBe('q');
    expect(args[8]).toBe('b'.repeat(40));
    expect(args[9]).toBe('HEAD');
    expect(args[14]).toEqual({ hostId: 'h-ssh' });
    expect(h.checkout.ensureSessionWorktree).toHaveBeenCalledWith({
      sessionId: 's-1', hostId: 'h-ssh', projectId: 7, projectPath: '/nonexistent-proj-for-test',
      sessionKey: 'q', branch: 'q', baseBranch: 'main', baseCommittish: undefined, baseSha: 'b'.repeat(40),
    });
    // The row lands before the environment work; session-created fires only after it.
    expect(h.createSession.mock.invocationCallOrder[0]).toBeLessThan(h.checkout.ensureSessionWorktree.mock.invocationCallOrder[0]);
    expect(h.checkout.ensureSessionWorktree.mock.invocationCallOrder[0]).toBeLessThan(h.sessionManager.emitSessionCreated.mock.invocationCallOrder[0]);
    expect(h.sessionManager.runBuildScript).not.toHaveBeenCalled();
    expect(h.checkout.removeSessionWorktree).not.toHaveBeenCalled();
  });

  it('a name taken on the environment gets the next suffix', async () => {
    const h = harness({ takenRemote: ['q', 'q-1'] });
    setRemoteCheckout(h.checkout);
    expect(await settle(h.queue, { ...BASE, hostId: 'h-ssh' })).toBeNull();
    expect(h.createSession.mock.calls[0][3]).toBe('q-2');
    expect(h.checkout.ensureSessionWorktree.mock.calls[0][0]).toMatchObject({ sessionKey: 'q-2', branch: 'q-2' });
  });

  it('an environment failure compensates (remote cleanup + archive) and surfaces the readable error', async () => {
    const h = harness();
    h.checkout.ensureSessionWorktree.mockRejectedValueOnce(new Error('Could not send the project to "Studio": denied'));
    setRemoteCheckout(h.checkout);
    const err = await settle(h.queue, { ...BASE, hostId: 'h-ssh' });
    expect(err?.message).toBe('Could not send the project to "Studio": denied');
    expect(h.checkout.removeSessionWorktree).toHaveBeenCalledWith('s-1');
    expect(h.sessionManager.archiveSession).toHaveBeenCalledWith('s-1');
    expect(h.sessionManager.emitSessionCreated).not.toHaveBeenCalled();
    expect(h.createWorktree).not.toHaveBeenCalled();
  });

  it('a base that cannot be resolved fails before any row is written', async () => {
    const h = harness();
    h.checkout.resolveBase.mockRejectedValueOnce(new Error("Base branch 'nope' does not exist"));
    setRemoteCheckout(h.checkout);
    const err = await settle(h.queue, { ...BASE, hostId: 'h-ssh', baseBranch: 'nope' });
    expect(err?.message).toBe("Could not resolve the session's base commit: Base branch 'nope' does not exist");
    expect(h.createSession).not.toHaveBeenCalled();
    expect(h.checkout.ensureSessionWorktree).not.toHaveBeenCalled();
  });

  it('with no checkout service wired, a remote job fails before anything is provisioned', async () => {
    const h = harness();
    const err = await settle(h.queue, { ...BASE, hostId: 'h-ssh' });
    expect(err?.message).toMatch(/Remote environments are not available right now/);
    expect(h.createWorktree).not.toHaveBeenCalled();
    expect(h.createSession).not.toHaveBeenCalled();
  });

  it('an in-place remote job is refused', async () => {
    const h = harness();
    setRemoteCheckout(h.checkout);
    const err = await settle(h.queue, { ...BASE, hostId: 'h-ssh', inPlace: true });
    expect(err?.message).toMatch(/In-place sessions run on This Mac only/);
    expect(h.createSession).not.toHaveBeenCalled();
  });

  it('a local job (no hostId) provisions a worktree, passes no host options and never asks the checkout', async () => {
    const h = harness();
    setRemoteCheckout(h.checkout);
    expect(await settle(h.queue, BASE)).toBeNull();
    expect(h.createWorktree).toHaveBeenCalledTimes(1);
    expect(h.createSession).toHaveBeenCalledTimes(1);
    const args = h.createSession.mock.calls[0];
    expect(args[1]).toBe('/proj/worktrees/q');
    expect(args[14]).toBeUndefined();
    expect(h.sessionManager.emitSessionCreated).toHaveBeenCalledTimes(1);
    expect(h.checkout.worktreeExists).not.toHaveBeenCalled();
    expect(h.checkout.ensureSessionWorktree).not.toHaveBeenCalled();
  });

  it("an explicit local hostId ('local' / null) provisions locally", async () => {
    for (const hostId of ['local', null]) {
      const h = harness();
      expect(await settle(h.queue, { ...BASE, hostId })).toBeNull();
      expect(h.createWorktree).toHaveBeenCalledTimes(1);
      expect(h.createSession.mock.calls[0][14]).toEqual({ hostId });
    }
  });
});
