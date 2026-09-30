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
import type { SystemProcessEntry, SystemWorktreeEntry } from '../../../systemTypes';

const caller = () => appRouter.createCaller(createContext()).cyboflow.monitorReap;

const wtEntry = (path: string, tag: 'orphan' | 'session-owned' | 'in_place'): SystemWorktreeEntry =>
  tag === 'in_place'
    ? { path, branch: 'main', tag, prunable: false, usage: { status: 'queued' } }
    : { path, branch: `b-${path}`, tag, prunable: true, usage: { status: 'queued' } };

const orphanProc = (pid: number): SystemProcessEntry => ({
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
    expect(h.execute.mock.calls[0]).toEqual([manifest, { alsoDeleteBranch: false }]);
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
        if (hit.ok) this.put({ manifest: hit.entry.manifest, projectId: hit.entry.projectId, selection: hit.entry.selection });
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

  it('executes the branch-delete choice captured at resolve time; execute cannot change it', async () => {
    const h = harness(base);
    const off = await caller().resolve({ projectId: 1, selection: { kind: 'reap-all-stale' } });
    // A forged extra field on execute is stripped by the input schema and never honoured.
    await caller().execute({ manifestId: off.manifest.id, alsoDeleteBranch: true } as { manifestId: string });
    expect(h.execute.mock.calls[0][1]).toEqual({ alsoDeleteBranch: false });

    const on = await caller().resolve({
      projectId: 1,
      selection: { kind: 'reap-all-stale' },
      alsoDeleteBranch: true,
    });
    await caller().execute({ manifestId: on.manifest.id });
    expect(h.execute.mock.calls[1][1]).toEqual({ alsoDeleteBranch: true });
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
