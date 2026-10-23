/**
 * Environments (M2-C1): the session-creation processor's TEMPORARY remote guard (until M2-C2 lands remote
 * worktrees) and the hostId pass-through to SessionManager.createSession. A remote job must fail with a clear
 * error BEFORE worktreeManager.createWorktree — never cut a LOCAL worktree for a remote session — while a local job
 * provisions exactly as before.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../panelManager', () => ({
  panelManager: {
    ensureDiffPanel: vi.fn().mockResolvedValue(undefined),
    getPanelsForSession: vi.fn().mockReturnValue([]),
  },
}));

import { REMOTE_SESSIONS_UNAVAILABLE_MESSAGE, TaskQueue } from '../taskQueue';

function harness() {
  const createWorktree = vi.fn().mockResolvedValue({
    worktreePath: '/proj/worktrees/q',
    baseCommit: 'abc',
    baseBranch: 'main',
  });
  const createSession = vi.fn().mockResolvedValue({ id: 's-1', worktreePath: '/proj/worktrees/q' });
  const sessionManager = {
    db: { checkSessionNameExists: () => false },
    getProjectById: () => ({ id: 7, path: '/nonexistent-proj-for-test', worktree_folder: null, build_script: null }),
    createSession,
    emitSessionCreated: vi.fn(),
  };
  const queue = new TaskQueue({
    sessionManager,
    worktreeManager: { createWorktree },
    claudeCodeManager: {},
    gitDiffManager: {},
    executionTracker: {},
  } as unknown as ConstructorParameters<typeof TaskQueue>[0]);
  return { queue, createWorktree, createSession, sessionManager };
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

describe('TaskQueue session-creation processor — remote host (M2-C1)', () => {
  it('a remote job fails with "Remote sessions are not available yet" before createWorktree', async () => {
    const { queue, createWorktree, createSession } = harness();
    const err = await settle(queue, { ...BASE, hostId: 'h-ssh' });
    expect(err?.message).toBe(REMOTE_SESSIONS_UNAVAILABLE_MESSAGE);
    expect(REMOTE_SESSIONS_UNAVAILABLE_MESSAGE).toBe('Remote sessions are not available yet');
    expect(createWorktree).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it('a local job (no hostId) provisions a worktree and passes no host options', async () => {
    const { queue, createWorktree, createSession, sessionManager } = harness();
    expect(await settle(queue, BASE)).toBeNull();
    expect(createWorktree).toHaveBeenCalledTimes(1);
    expect(createSession).toHaveBeenCalledTimes(1);
    const args = createSession.mock.calls[0];
    expect(args[1]).toBe('/proj/worktrees/q');
    expect(args[14]).toBeUndefined();
    expect(sessionManager.emitSessionCreated).toHaveBeenCalledTimes(1);
  });

  it("an explicit local hostId ('local' / null) provisions locally", async () => {
    for (const hostId of ['local', null]) {
      const { queue, createWorktree, createSession } = harness();
      expect(await settle(queue, { ...BASE, hostId })).toBeNull();
      expect(createWorktree).toHaveBeenCalledTimes(1);
      expect(createSession.mock.calls[0][14]).toEqual({ hostId });
    }
  });
});
