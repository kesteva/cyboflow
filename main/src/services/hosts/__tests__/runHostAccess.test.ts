/**
 * createRunHostAccess — a remote run's worktree through its ExecutionHost (spec M2 §5 D3): gates read per call
 * (never a local fallback), HostPaths carry the host id, execIn runs with cwd + the environment's tool PATH and
 * rejects execFile-shaped with redacted output, gitExit resolves any exit code and rejects on a timeout.
 */
import { describe, expect, it, vi } from 'vitest';
import type { HostView, HostsFeatureStatus } from '../../../../../shared/types/hosts';
import type { ExecResult, ExecutionHost, ExecOptions, HostPath } from '../../../orchestrator/trpc/contracts/executionHost';
import { createRunHostAccess, RemoteHostAccessUnavailableError } from '../runHostAccess';

/** Minimal in-memory MachineFs recording the host ids it was handed. */
function memoryFs(seedFiles: string[]) {
  const files = new Set(seedFiles);
  const dirs = new Set<string>();
  const hostIds = new Set<string>();
  const seen = (p: HostPath): string => {
    hostIds.add(p.hostId);
    return p.path;
  };
  return {
    dirs,
    hostIds,
    exists: async (p: HostPath) => {
      const path = seen(p);
      return files.has(path) || dirs.has(path);
    },
    mkdirp: async (p: HostPath) => {
      dirs.add(seen(p));
    },
  };
}

const RUNNING: HostsFeatureStatus = { available: true, enabled: true, killed: false, scheduleKilled: false, running: true };
const WT = '/home/k/cf-remote/h1/wt/s1';
const TOKEN = 'sk-ant-oat01-' + 'a'.repeat(40);

function harness(opts: { status?: HostsFeatureStatus; exec?: (argv: string[], o?: ExecOptions) => ExecResult; git?: ExecResult } = {}) {
  const fs = memoryFs([`${WT}/pnpm-lock.yaml`]);
  const exec = vi.fn(async (argv: string[], o?: ExecOptions): Promise<ExecResult> =>
    opts.exec ? opts.exec(argv, o) : { code: 0, stdout: 'done', stderr: '', timedOut: false });
  const gitRun = vi.fn(async (_cwd: HostPath, _args: string[], _o?: ExecOptions): Promise<ExecResult> =>
    opts.git ?? { code: 0, stdout: 'out', stderr: '', timedOut: false });
  const gitCapture = vi.fn(async () => ({ stdout: 'abc\n', stderr: '' }));
  const host = { fs, exec: { exec }, git: { run: gitRun, capture: gitCapture } } as unknown as ExecutionHost;
  const resolver = vi.fn((_id: string) => host);
  const view = {
    preflight: { remote: { nodePath: '/home/k/.nvm/versions/node/v22/bin/node', gitPath: '/usr/bin/git' } },
  } as unknown as HostView;
  let status = opts.status ?? RUNNING;
  const hosts = { status: () => status, get: vi.fn(() => view) };
  let wired = true;
  const access = createRunHostAccess({ getResolver: () => (wired ? resolver : null), getHosts: () => hosts });
  return {
    access, fs, exec, gitRun, gitCapture, resolver,
    setStatus: (s: HostsFeatureStatus) => { status = s; },
    unwire: () => { wired = false; },
  };
}

describe('createRunHostAccess', () => {
  it('refuses a local host id (local runs keep their local path)', () => {
    const { access } = harness();
    expect(() => access.forHost('local')).toThrow(/remote host id/);
    expect(() => access.forHost('')).toThrow(/remote host id/);
  });

  it('routes fs and git to the host with HostPaths on that host', async () => {
    const h = harness();
    const wt = h.access.forHost('h1');
    expect(await wt.exists(`${WT}/pnpm-lock.yaml`)).toBe(true);
    await wt.mkdirp(`${WT}/.cyboflow/build-slots/slot-0`);
    expect(h.fs.dirs.has(`${WT}/.cyboflow/build-slots/slot-0`)).toBe(true);
    expect([...h.fs.hostIds]).toEqual(['h1']);
    expect(await wt.gitCapture(WT, ['rev-parse', 'HEAD'])).toBe('abc\n');
    expect(h.gitCapture).toHaveBeenCalledWith({ hostId: 'h1', path: WT }, ['rev-parse', 'HEAD'], {});
    expect(h.resolver).toHaveBeenCalledWith('h1');
  });

  it('gitExit resolves any exit code (redacted stderr) and rejects when git did not finish', async () => {
    const one = harness({ git: { code: 1, stdout: '', stderr: `token ${TOKEN}`, timedOut: false } });
    const r = await one.access.forHost('h1').gitExit(WT, ['check-ignore', '-q', '--', 'x/'], { timeoutMs: 15_000 });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).not.toContain(TOKEN);
    expect(one.gitRun).toHaveBeenCalledWith({ hostId: 'h1', path: WT }, ['check-ignore', '-q', '--', 'x/'], { timeoutMs: 15_000 });

    const slow = harness({ git: { code: null, stdout: '', stderr: '', timedOut: true } });
    await expect(slow.access.forHost('h1').gitExit(WT, ['status'])).rejects.toThrow(/timed out/);
  });

  it('execIn runs in the remote cwd with the environment tool PATH, and rejects execFile-shaped with redacted output', async () => {
    const ok = harness();
    expect(await ok.access.forHost('h1').execIn(WT, 'pnpm', ['install', '--frozen-lockfile'], { timeoutMs: 900_000 })).toEqual({
      stdout: 'done',
      stderr: '',
    });
    expect(ok.exec).toHaveBeenCalledWith(['pnpm', 'install', '--frozen-lockfile'], {
      cwd: WT,
      env: { PATH: '/home/k/.nvm/versions/node/v22/bin:/usr/bin:/bin:/usr/sbin:/sbin' },
      timeoutMs: 900_000,
    });

    const bad = harness({ exec: () => ({ code: 1, stdout: `out ${TOKEN}`, stderr: `ERR ${TOKEN}`, timedOut: false }) });
    const err = await bad.access.forHost('h1').execIn(WT, 'pnpm', ['install'], { timeoutMs: 1000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const e = err as Error & { code: number; stdout: string; stderr: string };
    expect(e.code).toBe(1);
    expect(e.message).toMatch(/^Command failed: pnpm install/);
    expect(`${e.message}${e.stdout}${e.stderr}`).not.toContain(TOKEN);
  });

  it('rejects (never runs anywhere) when Environments are off, kill-switched or not wired', async () => {
    const h = harness();
    const wt = h.access.forHost('h1');
    h.setStatus({ ...RUNNING, running: false });
    await expect(wt.exists(WT)).rejects.toThrow('Environments are turned off.');
    h.setStatus({ ...RUNNING, killed: true });
    await expect(wt.gitExit(WT, ['status'])).rejects.toThrow('Remote environments are turned off.');
    h.setStatus(RUNNING);
    h.unwire();
    await expect(wt.execIn(WT, 'pnpm', [], { timeoutMs: 1 })).rejects.toBeInstanceOf(RemoteHostAccessUnavailableError);
    expect(h.exec).not.toHaveBeenCalled();
    expect(h.resolver).not.toHaveBeenCalled();
  });

  it('rejects when no hosts facade is published', async () => {
    const access = createRunHostAccess({ getResolver: () => null, getHosts: () => null });
    await expect(access.forHost('h1').mkdirp(WT)).rejects.toBeInstanceOf(RemoteHostAccessUnavailableError);
  });
});
