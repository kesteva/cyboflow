/**
 * cyboflow.monitorReap: resolve stashes a server-minted manifest; execute runs only
 * a previously-resolved, unexpired, single-use, un-drifted one. Every rejection path
 * is asserted to perform ZERO destructive action (the executor is never called).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TRPCError } from '@trpc/server';
import { appRouter } from '../../router';
import { createContext } from '../../context';
import { MANIFEST_STALE, setMonitorReapProvider } from '../monitorReap';
import { MonitorReapService } from '../../../../services/monitor/monitorReapService';
import { ReapManifestStash } from '../../../../services/monitor/reapManifestStash';
import type { ReapSnapshot } from '../../../../services/monitor/reapManifest';
import type { ReapExecutor } from '../../../reapTypes';
import type { SystemOrphanProcess, SystemProcessEntry, SystemWorktreeEntry } from '../../../systemTypes';

const caller = () => appRouter.createCaller(createContext()).cyboflow.monitorReap;

const wtEntry = (path: string, tag: 'orphan' | 'session-owned' | 'in_place'): SystemWorktreeEntry =>
  tag === 'in_place'
    ? { path, branch: 'main', tag, prunable: false, usage: { status: 'queued' } }
    : { path, branch: `b-${path}`, tag, prunable: true, usage: { status: 'queued' } };

const orphanProc = (pid: number): SystemOrphanProcess => ({
  pid,
  ppid: 1,
  pcpu: 0,
  pmem: 0,
  etimeSeconds: 5,
  owner: null,
  processType: 'claude-cli',
  command: `cmd-${pid}`,
  worktreePath: null,
  bucket: 'orphan',
  sweepEligible: true,
  instanceId: 'dead',
});

function harness(
  initial: ReapSnapshot,
  opts: { now?: () => number; stash?: ReapManifestStash } = {},
) {
  let snapshot = initial;
  const execute = vi.fn<ReapExecutor['execute']>(async () => []);
  const executor: ReapExecutor = { execute };
  const now = opts.now ?? (() => 1000);
  const service = new MonitorReapService({
    loadSnapshot: async () => snapshot,
    manifestDeps: {
      measureFresh: async () => 100,
      peekGitStatus: () => null,
      countDescendants: async () => 0,
      now,
    },
    executor,
    stash: opts.stash ?? new ReapManifestStash(now),
  });
  setMonitorReapProvider(service);
  return { execute, setSnapshot: (s: ReapSnapshot) => (snapshot = s), service };
}

const base: ReapSnapshot = {
  generatedAt: 1,
  worktrees: [wtEntry('/wt/orphan', 'orphan'), wtEntry('/wt/live', 'session-owned'), wtEntry('/repo', 'in_place')],
  processes: [orphanProc(11)],
};

afterEach(() => setMonitorReapProvider(null));

describe('cyboflow.monitorReap wiring', () => {
  it('is registered next to the unrelated monitor router and fails soft before wiring', async () => {
    const root = appRouter.createCaller(createContext()).cyboflow;
    expect(root.monitor).toBeDefined();
    await expect(
      caller().resolve({ projectId: 1, selection: { kind: 'reap-all-stale' } }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });
});

describe('monitorReap.resolve', () => {
  it('returns the builder manifest for the selection, id minted server-side', async () => {
    harness(base);
    const { manifest } = await caller().resolve({ projectId: 1, selection: { kind: 'reap-all-stale' } });
    expect(manifest.id).toMatch(/^reap_/);
    expect(manifest.kind).toBe('reap-all-stale');
    expect(manifest.targets.map((t) => (t.kind === 'worktree' ? t.path : t.pid))).toEqual(['/wt/orphan', 11]);
    expect(manifest.reclaimableBytes).toBe(100);
    expect(manifest.alsoDeleteBranch).toBe(false);
  });

  it('maps an unprunable / missing selection to a typed error', async () => {
    harness(base);
    await expect(
      caller().resolve({ projectId: 1, selection: { kind: 'card', worktreePath: '/repo' } }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller().resolve({ projectId: 1, selection: { kind: 'row', pids: [999] } }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('monitorReap.execute', () => {
  it('runs exactly the resolved manifest targets and returns results', async () => {
    const h = harness(base);
    h.execute.mockResolvedValueOnce([
      { targetId: 'worktree:/wt/orphan', kind: 'pruned' },
      { targetId: 'process:11', kind: 'killed' },
    ]);
    const { manifest } = await caller().resolve({ projectId: 1, selection: { kind: 'reap-all-stale' } });
    const out = await caller().execute({ manifestId: manifest.id });
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.execute.mock.calls[0]).toEqual([manifest, { alsoDeleteBranch: false, projectId: 1 }]);
    expect(out.errors).toEqual([]);
    expect(out.results).toHaveLength(2);
  });

  it('rejects a never-returned / fabricated id with zero destructive action', async () => {
    const h = harness(base);
    await caller().resolve({ projectId: 1, selection: { kind: 'reap-all-stale' } });
    const err = await caller().execute({ manifestId: 'reap_forged' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe('NOT_FOUND');
    expect((err as TRPCError).message).toContain(MANIFEST_STALE);
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('is single-use: the second execute is rejected and nothing is torn down twice', async () => {
    const h = harness(base);
    const { manifest } = await caller().resolve({ projectId: 1, selection: { kind: 'reap-all-stale' } });
    await caller().execute({ manifestId: manifest.id });
    await expect(caller().execute({ manifestId: manifest.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(h.execute).toHaveBeenCalledTimes(1);
  });

  it('negative control: with a stash that fails to consume, the replay assertion would fail', async () => {
    // Proof the single-use test above can fail: a non-consuming stash lets the same id run twice.
    class LeakyStash extends ReapManifestStash {
      override take(id: string) {
        const hit = super.take(id);
        if (hit.ok) this.put({ manifest: hit.entry.manifest, projectId: hit.entry.projectId, selection: hit.entry.selection, fingerprint: hit.entry.fingerprint });
        return hit;
      }
    }
    const h = harness(base, { stash: new LeakyStash(() => 1000) });
    const { manifest } = await caller().resolve({ projectId: 1, selection: { kind: 'reap-all-stale' } });
    await caller().execute({ manifestId: manifest.id });
    await caller().execute({ manifestId: manifest.id });
    expect(h.execute).toHaveBeenCalledTimes(2);
  });

  it('rejects after TTL expiry instead of silently re-resolving', async () => {
    let t = 1000;
    const h = harness(base, { now: () => t });
    const { manifest } = await caller().resolve({ projectId: 1, selection: { kind: 'reap-all-stale' } });
    t += 61_000;
    const err = await caller().execute({ manifestId: manifest.id }).catch((e: unknown) => e);
    expect((err as TRPCError).code).toBe('CONFLICT');
    expect((err as TRPCError).message).toContain(MANIFEST_STALE);
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('rejects a manifest whose target set changed since resolve (target gone or new one appeared)', async () => {
    const h = harness(base);
    const a = await caller().resolve({ projectId: 1, selection: { kind: 'reap-all-stale' } });
    h.setSnapshot({ ...base, processes: [] }); // the orphan process died
    await expect(caller().execute({ manifestId: a.manifest.id })).rejects.toMatchObject({ code: 'CONFLICT' });

    h.setSnapshot(base);
    const b = await caller().resolve({ projectId: 1, selection: { kind: 'reap-all-stale' } });
    h.setSnapshot({ ...base, processes: [orphanProc(11), orphanProc(12)] }); // another orphan appeared
    await expect(caller().execute({ manifestId: b.manifest.id })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('rejects when a pid was reused by a different command', async () => {
    const h = harness(base);
    const { manifest } = await caller().resolve({ projectId: 1, selection: { kind: 'row', pids: [11] } });
    h.setSnapshot({ ...base, processes: [{ ...orphanProc(11), command: 'something-else' }] });
    await expect(caller().execute({ manifestId: manifest.id })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(h.execute).not.toHaveBeenCalled();
  });

  describe('identity drift since resolve is rejected with zero destructive calls', () => {
    const ownedWt = (over: Partial<SystemWorktreeEntry> = {}): SystemWorktreeEntry =>
      ({
        path: '/wt/orphan',
        branch: 'feat/a',
        tag: 'orphan',
        prunable: true,
        sessionId: 's1',
        usage: { status: 'queued' },
        ...over,
      }) as SystemWorktreeEntry;
    const wtSnap = (w: SystemWorktreeEntry): ReapSnapshot => ({ generatedAt: 1, worktrees: [w], processes: [] });
    const procSnap = (p: SystemProcessEntry, generatedAt = 1): ReapSnapshot => ({
      generatedAt,
      worktrees: [],
      processes: [p],
    });
    const cliOwner = (sessionId: string) => ({ kind: 'cli' as const, panelId: 'p1', sessionId });

    async function expectStale(
      before: ReapSnapshot,
      after: ReapSnapshot,
      selection: Parameters<ReturnType<typeof caller>['resolve']>[0]['selection'],
    ) {
      const h = harness(before);
      const { manifest } = await caller().resolve({ projectId: 1, selection });
      h.setSnapshot(after);
      const err = await caller().execute({ manifestId: manifest.id }).catch((e: unknown) => e);
      expect((err as TRPCError).code).toBe('CONFLICT');
      expect((err as TRPCError).message).toContain(MANIFEST_STALE);
      expect(h.execute).not.toHaveBeenCalled();
    }

    const sel = { kind: 'reap-all-stale' } as const;

    it('worktree branch changed', async () => {
      await expectStale(wtSnap(ownedWt()), wtSnap(ownedWt({ branch: 'feat/other' })), sel);
    });

    it('worktree session owner changed', async () => {
      await expectStale(wtSnap(ownedWt()), wtSnap(ownedWt({ sessionId: 's2' })), sel);
    });

    it('worktree run owner changed', async () => {
      await expectStale(
        wtSnap(ownedWt({ sessionId: undefined, runId: 'r1' })),
        wtSnap(ownedWt({ sessionId: undefined, runId: 'r2' })),
        sel,
      );
    });

    it('same pid and command but a different ppid', async () => {
      await expectStale(procSnap(orphanProc(11)), procSnap({ ...orphanProc(11), ppid: 42 }), sel);
    });

    it('same pid and command but a different start time (pid reuse)', async () => {
      await expectStale(procSnap(orphanProc(11)), procSnap({ ...orphanProc(11), etimeSeconds: 500 }), sel);
    });

    it('a null etime on either side is stale', async () => {
      await expectStale(procSnap(orphanProc(11)), procSnap({ ...orphanProc(11), etimeSeconds: null }), sel);
      await expectStale(procSnap({ ...orphanProc(11), etimeSeconds: null }), procSnap(orphanProc(11)), sel);
    });

    it('process owner changed', async () => {
      const a = { ...orphanProc(11), owner: cliOwner('s1') };
      const b = { ...orphanProc(11), owner: cliOwner('s2') };
      await expectStale(procSnap(a), procSnap(b), sel);
    });

    it('process worktree changed', async () => {
      await expectStale(
        procSnap({ ...orphanProc(11), worktreePath: '/wt/a' }),
        procSnap({ ...orphanProc(11), worktreePath: '/wt/b' }),
        sel,
      );
    });

    it('cli owner ids that differ only in where a colon sits are different owners', async () => {
      const a = { ...orphanProc(11), owner: { kind: 'cli' as const, panelId: 'a:b', sessionId: 'c' } };
      const b = { ...orphanProc(11), owner: { kind: 'cli' as const, panelId: 'a', sessionId: 'b:c' } };
      await expectStale(procSnap(a), procSnap(b), sel);
    });

    it('run-shell owner ids that differ only in where a colon sits are different owners', async () => {
      const a = { ...orphanProc(11), owner: { kind: 'run-shell' as const, runId: 'a:b', terminalId: 'c' } };
      const b = { ...orphanProc(11), owner: { kind: 'run-shell' as const, runId: 'a', terminalId: 'b:c' } };
      await expectStale(procSnap(a), procSnap(b), sel);
    });

    it('orphan instanceId changed', async () => {
      await expectStale(
        procSnap(orphanProc(11)),
        procSnap({ ...orphanProc(11), instanceId: 'another-dead' }),
        sel,
      );
    });

    it('a start-time drift inside the tolerance still executes', async () => {
      const h = harness(procSnap(orphanProc(11), 10_000));
      const { manifest } = await caller().resolve({ projectId: 1, selection: sel });
      // Later poll: ps rounds etime one second differently for the same process.
      h.setSnapshot(procSnap({ ...orphanProc(11), etimeSeconds: 6 }, 10_000));
      await caller().execute({ manifestId: manifest.id });
      expect(h.execute).toHaveBeenCalledTimes(1);
    });

    it('a snapshot taken later with grown etime (same process) still executes', async () => {
      const h = harness(procSnap(orphanProc(11), 10_000));
      const { manifest } = await caller().resolve({ projectId: 1, selection: sel });
      h.setSnapshot(procSnap({ ...orphanProc(11), etimeSeconds: 35 }, 40_000));
      await caller().execute({ manifestId: manifest.id });
      expect(h.execute).toHaveBeenCalledTimes(1);
    });
  });

  it('executes the branch-delete choice captured at resolve time; execute cannot change it', async () => {
    const h = harness(base);
    const off = await caller().resolve({ projectId: 1, selection: { kind: 'reap-all-stale' } });
    // A forged extra field on execute is stripped by the input schema and never honoured.
    await caller().execute({ manifestId: off.manifest.id, alsoDeleteBranch: true } as { manifestId: string });
    expect(h.execute.mock.calls[0][1]).toEqual({ alsoDeleteBranch: false, projectId: 1 });

    const on = await caller().resolve({
      projectId: 1,
      selection: { kind: 'reap-all-stale' },
      alsoDeleteBranch: true,
    });
    await caller().execute({ manifestId: on.manifest.id });
    expect(h.execute.mock.calls[1][1]).toEqual({ alsoDeleteBranch: true, projectId: 1 });
  });

  it('re-resolving identical content mints a new id and cannot revive an expired one', async () => {
    let t = 1000;
    const h = harness(base, { now: () => t });
    const a = await caller().resolve({ projectId: 1, selection: { kind: 'reap-all-stale' } });
    t += 61_000;
    const b = await caller().resolve({ projectId: 1, selection: { kind: 'reap-all-stale' } });
    expect(b.manifest.id).not.toBe(a.manifest.id);
    await expect(caller().execute({ manifestId: a.manifest.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await caller().execute({ manifestId: b.manifest.id });
    expect(h.execute).toHaveBeenCalledTimes(1);
  });

  it('surfaces survivors and failures in an explicit errors field, not bare success', async () => {
    const h = harness(base);
    h.execute.mockResolvedValueOnce([
      { targetId: 'process:11', kind: 'survived', survivorPids: [11, 12] },
      { targetId: 'worktree:/wt/orphan', kind: 'failed', error: 'EBUSY' },
      { targetId: 'process:13', kind: 'skipped' },
    ]);
    const { manifest } = await caller().resolve({ projectId: 1, selection: { kind: 'reap-all-stale' } });
    const out = await caller().execute({ manifestId: manifest.id });
    expect(out.errors).toEqual([
      { targetId: 'process:11', message: expect.stringContaining('11, 12'), survivorPids: [11, 12] },
      { targetId: 'worktree:/wt/orphan', message: 'EBUSY' },
    ]);
  });

  it('reports PRECONDITION_FAILED without consuming the manifest when no executor is wired', async () => {
    const h = harness(base);
    const { manifest } = await caller().resolve({ projectId: 1, selection: { kind: 'reap-all-stale' } });
    h.service.setExecutor(undefined);
    await expect(caller().execute({ manifestId: manifest.id })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    h.service.setExecutor({ execute: h.execute });
    await caller().execute({ manifestId: manifest.id });
    expect(h.execute).toHaveBeenCalledTimes(1);
  });
});

describe('monitorReap.ts standalone-typecheck invariant', () => {
  it('imports no electron, better-sqlite3, or main/src/services modules', () => {
    const src = readFileSync(join(__dirname, '..', 'monitorReap.ts'), 'utf8');
    const specs = [...src.matchAll(/^import[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) expect(spec).not.toMatch(/^electron$|better-sqlite3|services\//);
  });
});

describe('overlapping manifests serialize per target', () => {
  it('lets only one of two distinct manifests on the same target execute', async () => {
    const h = harness(base);
    const sel = { kind: 'reap-all-stale' } as const;
    const a = await h.service.resolve(1, sel);
    const b = await h.service.resolve(1, sel);
    if (!a.ok || !b.ok) throw new Error('resolve failed');
    expect(a.manifest.id).not.toBe(b.manifest.id);

    let release: () => void = () => {};
    h.execute.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve([]); }));
    const first = h.service.execute(a.manifest.id);
    const second = await h.service.execute(b.manifest.id);
    expect(second).toMatchObject({ ok: false, code: 'stale' });
    expect(h.execute).toHaveBeenCalledTimes(1);

    release();
    await expect(first).resolves.toMatchObject({ ok: true });
    // Released: a fresh manifest on the same targets is no longer blocked.
    const c = await h.service.resolve(1, sel);
    if (!c.ok) throw new Error('resolve failed');
    await expect(h.service.execute(c.manifest.id)).resolves.toMatchObject({ ok: true });
  });
});
