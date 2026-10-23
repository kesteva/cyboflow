/**
 * Environments (M2-C1): which host a `sessions:create-quick` launch runs on, and the hostId threading into the
 * session-create job. Pins the precedence (explicit > project default while the feature runs > This Mac), every
 * refusal (readable, decided before any enqueue), and that a LOCAL launch threads nothing (job payload unchanged).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createQuickSessionCore,
  resolveQuickSessionHost,
  REMOTE_ENVIRONMENTS_OFF_MESSAGE,
  _resetClaimedQuickSessionIdsForTesting,
  type CreateQuickSessionCoreDeps,
  type QuickSessionHostInput,
  type QuickSessionHostsReader,
  type QuickSessionJobData,
} from '../createQuickSessionCore';
import type { HostsFeatureStatus, HostView, PreflightResult } from '../../../../shared/types/hosts';
import { setRemoteCheckout } from '../hosts/remoteCheckoutBridge';

const RUNNING: HostsFeatureStatus = { available: true, enabled: true, killed: false, scheduleKilled: false, running: true };

function preflight(runtimes: Partial<PreflightResult['runtimes']>): PreflightResult {
  return {
    hostId: 'h-ssh', mode: 'full', startedAt: '', finishedAt: '', results: [], reachable: true, probeComplete: true,
    detectedTier: 'full', arch: 'arm64', osVersion: '26', toolchainHash: 'abc', appVersion: '0.5.2',
    runtimes: { claudeSdk: false, codexSdk: false, claudeCli: false, codexCli: false, ...runtimes },
  };
}

function hostView(patch: Partial<HostView> = {}): HostView {
  return {
    id: 'h-ssh', label: 'Studio', kind: 'ssh', sshTarget: 'k@studio', remoteRoot: '~/cf-remote/h-ssh', arch: 'arm64',
    osVersion: '26', detectedTier: 'full', userCapTier: null, effectiveTier: 'full', tierSource: 'detected',
    lifecycleState: 'online', lastSeenAt: null, preflight: preflight({ claudeSdk: true, codexSdk: true }),
    preflightAt: null, lastAttempt: null, preflightRunning: false, remoteReady: true, linkState: 'idle',
    installRunning: false, runningSessions: 0, runningRuns: 0, archivedAt: null, createdAt: '',
    ...patch,
  };
}

function reader(opts: { status?: HostsFeatureStatus; hosts?: HostView[] } = {}): QuickSessionHostsReader {
  const hosts = opts.hosts ?? [hostView()];
  return {
    status: () => opts.status ?? RUNNING,
    get: (id) => {
      const found = hosts.find((h) => h.id === id);
      if (!found) throw new Error('HostNotFoundError');
      return found;
    },
  };
}

/** A remote-eligible launch: worktree-backed Claude SDK. */
function input(patch: Partial<QuickSessionHostInput> = {}): QuickSessionHostInput {
  return {
    requestedHostId: undefined,
    projectDefaultHostId: null,
    agentRuntime: 'claude-sdk',
    requestedSubstrate: 'sdk',
    inPlace: false,
    isDesignSession: false,
    ultracode: false,
    orchSocketAuthDisabled: false,
    ...patch,
  };
}

describe('resolveQuickSessionHost — precedence', () => {
  it('no request, no default, feature off → This Mac (null)', () => {
    expect(resolveQuickSessionHost(null, input())).toEqual({ ok: true, hostId: null });
  });

  it('an explicit remote host wins over the project default', () => {
    const r = reader({ hosts: [hostView(), hostView({ id: 'h-other', label: 'Other' })] });
    expect(resolveQuickSessionHost(r, input({ requestedHostId: 'h-ssh', projectDefaultHostId: 'h-other' })))
      .toEqual({ ok: true, hostId: 'h-ssh' });
  });

  it("explicit 'local' and explicit null both pick This Mac over a remote default", () => {
    const r = reader();
    expect(resolveQuickSessionHost(r, input({ requestedHostId: 'local', projectDefaultHostId: 'h-ssh' })))
      .toEqual({ ok: true, hostId: null });
    expect(resolveQuickSessionHost(r, input({ requestedHostId: null, projectDefaultHostId: 'h-ssh' })))
      .toEqual({ ok: true, hostId: null });
  });

  it('absent (or blank) request falls back to the project default while the feature runs', () => {
    const r = reader();
    expect(resolveQuickSessionHost(r, input({ projectDefaultHostId: 'h-ssh' }))).toEqual({ ok: true, hostId: 'h-ssh' });
    expect(resolveQuickSessionHost(r, input({ requestedHostId: '  ', projectDefaultHostId: 'h-ssh' })))
      .toEqual({ ok: true, hostId: 'h-ssh' });
  });

  it('the project default is ignored when the feature is off, killed, or unwired', () => {
    const def = input({ projectDefaultHostId: 'h-ssh' });
    expect(resolveQuickSessionHost(null, def)).toEqual({ ok: true, hostId: null });
    expect(resolveQuickSessionHost(reader({ status: { ...RUNNING, running: false, enabled: false } }), def))
      .toEqual({ ok: true, hostId: null });
    expect(resolveQuickSessionHost(reader({ status: { ...RUNNING, killed: true } }), def))
      .toEqual({ ok: true, hostId: null });
  });

  it("a 'local' project default resolves to null (canonical local)", () => {
    expect(resolveQuickSessionHost(reader(), input({ projectDefaultHostId: 'local' }))).toEqual({ ok: true, hostId: null });
  });

  it('a remote project default does not capture a terminal / design / in-place launch (stays on This Mac)', () => {
    const r = reader();
    for (const patch of [
      { requestedSubstrate: undefined, agentRuntime: undefined },
      { requestedSubstrate: 'interactive' as const },
      { isDesignSession: true },
      { inPlace: true },
      { ultracode: true },
    ]) {
      expect(resolveQuickSessionHost(r, input({ projectDefaultHostId: 'h-ssh', ...patch }))).toEqual({ ok: true, hostId: null });
    }
  });

  it('codex-sdk on a host with the Codex SDK resolves', () => {
    expect(resolveQuickSessionHost(reader(), input({ requestedHostId: 'h-ssh', agentRuntime: 'codex-sdk' })))
      .toEqual({ ok: true, hostId: 'h-ssh' });
  });
});

describe('resolveQuickSessionHost — refusals (explicit remote)', () => {
  const refuse = (r: QuickSessionHostsReader | null, patch: Partial<QuickSessionHostInput>): string => {
    const res = resolveQuickSessionHost(r, input({ requestedHostId: 'h-ssh', ...patch }));
    if (res.ok) throw new Error(`expected a refusal, got ${String(res.hostId)}`);
    return res.error;
  };

  it('feature off / killed / unwired → "Remote environments are turned off"', () => {
    expect(refuse(null, {})).toBe(REMOTE_ENVIRONMENTS_OFF_MESSAGE);
    expect(refuse(reader({ status: { ...RUNNING, running: false } }), {})).toBe(REMOTE_ENVIRONMENTS_OFF_MESSAGE);
    expect(refuse(reader({ status: { ...RUNNING, killed: true } }), {})).toBe(REMOTE_ENVIRONMENTS_OFF_MESSAGE);
  });

  it('orch socket auth disabled', () => {
    expect(refuse(reader(), { orchSocketAuthDisabled: true })).toMatch(/CYBOFLOW_DISABLE_ORCH_SOCK_AUTH/);
  });

  it('launch shapes M2 keeps local', () => {
    const r = reader();
    expect(refuse(r, { inPlace: true })).toMatch(/In-place sessions run on This Mac only/);
    expect(refuse(r, { isDesignSession: true })).toMatch(/Design sessions run on This Mac only/);
    expect(refuse(r, { ultracode: true })).toMatch(/Ultracode sessions run on This Mac only/);
    expect(refuse(r, { requestedSubstrate: 'interactive' })).toMatch(/Claude SDK or Codex SDK sessions only/);
    expect(refuse(r, { requestedSubstrate: undefined, agentRuntime: undefined })).toMatch(/SDK sessions only/);
    expect(refuse(r, { agentRuntime: 'codex-pty', requestedSubstrate: 'interactive' })).toMatch(/SDK sessions only/);
    expect(refuse(r, { agentRuntime: 'omp-sdk' })).toMatch(/SDK sessions only/);
    expect(refuse(r, { agentRuntime: 'omp-fleet' })).toMatch(/SDK sessions only/);
  });

  it('host state', () => {
    expect(refuse(reader({ hosts: [] }), {})).toMatch(/no longer exists/);
    expect(refuse(reader({ hosts: [hostView({ archivedAt: '2026-10-01' })] }), {})).toMatch(/"Studio" is archived/);
    expect(refuse(reader({ hosts: [hostView({ kind: 'local' })] }), {})).toMatch(/not a remote machine/);
    expect(refuse(reader({ hosts: [hostView({ effectiveTier: 'cli' })] }), {})).toMatch(/cannot run SDK sessions/);
    expect(refuse(reader({ hosts: [hostView({ effectiveTier: null })] }), {})).toMatch(/cannot run SDK sessions/);
    expect(refuse(reader({ hosts: [hostView({ remoteReady: false })] }), {})).toMatch(/Install cyboflow tools on "Studio"/);
  });

  it('the runtime SDK must be available on the host', () => {
    const claudeOnly = reader({ hosts: [hostView({ preflight: preflight({ claudeSdk: true }) })] });
    expect(refuse(claudeOnly, { agentRuntime: 'codex-sdk' })).toMatch(/Codex is not available on "Studio"/);
    const codexOnly = reader({ hosts: [hostView({ preflight: preflight({ codexSdk: true }) })] });
    expect(refuse(codexOnly, {})).toMatch(/Claude is not available on "Studio"/);
    expect(refuse(reader({ hosts: [hostView({ preflight: null })] }), {})).toMatch(/Claude is not available/);
  });

  it('a remote PROJECT DEFAULT whose host is unusable is refused, not silently local', () => {
    const res = resolveQuickSessionHost(
      reader({ hosts: [hostView({ remoteReady: false })] }),
      input({ projectDefaultHostId: 'h-ssh' }),
    );
    expect(res).toEqual({ ok: false, error: expect.stringMatching(/Install cyboflow tools/) });
  });
});

describe('createQuickSessionCore — hostId threading into the session-create job', () => {
  beforeEach(() => {
    _resetClaimedQuickSessionIdsForTesting();
  });

  async function enqueued(hostId: string | null | undefined): Promise<QuickSessionJobData> {
    let captured: QuickSessionJobData | null = null;
    const deps: CreateQuickSessionCoreDeps = {
      taskQueue: {
        createSession: async (data) => {
          captured = data;
          return { id: 'job-1' };
        },
        onSessionJobFailed: (l) => {
          queueMicrotask(() => l('job-1', new Error('stop here')));
          return () => {};
        },
      },
      sessionManager: { on: () => {}, removeListener: () => {} },
      workflowRegistry: {
        ensureQuickWorkflow: () => 'wf',
        createRun: () => ({ runId: 'r', substrate: 'sdk' }),
      },
      getDb: () => {
        throw new Error('unused');
      },
    };
    await expect(
      createQuickSessionCore(deps, { projectId: 1, nameHint: 'q', ...(hostId !== undefined ? { hostId } : {}) }),
    ).rejects.toThrow('stop here');
    if (captured === null) throw new Error('job not enqueued');
    return captured;
  }

  it('a remote hostId rides the job', async () => {
    expect((await enqueued('h-ssh')).hostId).toBe('h-ssh');
  });

  it("a local launch (absent / null / 'local') enqueues the unchanged payload — no hostId key", async () => {
    for (const hostId of [undefined, null, 'local']) {
      expect(Object.keys(await enqueued(hostId))).not.toContain('hostId');
    }
  });
});

describe('createQuickSessionCore — half-created compensation of a remote session (M2-C2)', () => {
  beforeEach(() => {
    _resetClaimedQuickSessionIdsForTesting();
  });
  afterEach(() => {
    setRemoteCheckout(null);
  });

  async function failAfterCreate(hostId: string | null): Promise<string[]> {
    const order: string[] = [];
    setRemoteCheckout({
      worktreeExists: async () => false,
      resolveBase: async () => ({ baseCommit: 'a'.repeat(40), baseBranch: 'HEAD', baseRef: 'HEAD' }),
      plannedWorktreePath: () => '/home/me/cf-remote/h-ssh/wt/q',
      ensureSessionWorktree: async () => ({ remoteWorktreePath: '/home/me/cf-remote/h-ssh/wt/q', baseSha: 'a'.repeat(40), baseBranch: 'HEAD' }),
      removeSessionWorktree: async (sessionId) => {
        order.push(`remote:${sessionId}`);
        return true;
      },
    });
    let listener: ((s: { id: string; worktreePath: string }) => void) | null = null;
    const deps: CreateQuickSessionCoreDeps = {
      taskQueue: {
        createSession: async () => {
          setTimeout(() => listener?.({ id: 's-9', worktreePath: '/home/me/cf-remote/h-ssh/wt/q' }), 0);
          return { id: 'job-1' };
        },
        onSessionJobFailed: () => () => {},
      },
      sessionManager: {
        on: (_e, l) => {
          listener = l;
        },
        removeListener: () => {
          listener = null;
        },
      },
      workflowRegistry: {
        ensureQuickWorkflow: () => 'wf',
        createRun: () => {
          throw new Error('bad combo');
        },
      },
      getDb: () => {
        throw new Error('unused');
      },
      dismissHalfCreatedSession: async (sessionId) => {
        order.push(`dismiss:${sessionId}`);
      },
    };
    await expect(
      createQuickSessionCore(deps, { projectId: 1, nameHint: 'q', ...(hostId !== null ? { hostId } : {}) }),
    ).rejects.toThrow('bad combo');
    return order;
  }

  it('removes the remote worktree before the local dismiss', async () => {
    expect(await failAfterCreate('h-ssh')).toEqual(['remote:s-9', 'dismiss:s-9']);
  });

  it('a local session never touches the remote checkout', async () => {
    expect(await failAfterCreate(null)).toEqual(['dismiss:s-9']);
  });
});
