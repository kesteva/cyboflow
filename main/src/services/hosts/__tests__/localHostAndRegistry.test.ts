import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PREFLIGHT_CHECK_IDS, type PreflightCheckResult } from '../../../../../shared/types/hosts';
import type { HostRow } from '../../../orchestrator/hosts/hostStore';
import { HostNotFoundError } from '../../../orchestrator/hosts/errors';
import type { ExecutionHost } from '../../../orchestrator/trpc/contracts/executionHost';
import { LocalHost, execErrorToResult, type LocalHostDeps } from '../localHost';
import { HostRegistry } from '../hostRegistry';
import { HostPathMismatchError, SshHost } from '../sshHost';
import type { ProcessRunner, SshTransportLike } from '../sshTransport';

const posix = process.platform !== 'win32';

function local(over: Partial<LocalHostDeps> = {}): LocalHost {
  return new LocalHost({
    appVersion: '2.0.0',
    gitVersion: async () => 'git version 2.50.0',
    detectClaudeBinary: async () => ({ found: true, path: '/c', version: '2.1.0' }),
    detectClaudeCredentials: async () => ({ found: true, source: 'keychain', account: null }),
    resolveCodex: () => ({ executablePath: '/codex', version: '0.159.2' }),
    codexAuthPresent: async () => true,
    now: () => new Date(Date.UTC(2026, 9, 9)),
    ...over,
  });
}

describe('LocalHost preflight', () => {
  it('reports git / claude-auth / codex-auth, everything else na, tier fixed full', async () => {
    const seen: PreflightCheckResult[] = [];
    const r = await local().preflight('full', (c) => seen.push(c));
    expect(r.results.map((c) => c.id)).toEqual([...PREFLIGHT_CHECK_IDS]);
    expect(seen.map((c) => c.id).sort()).toEqual([...PREFLIGHT_CHECK_IDS].sort());
    const status = Object.fromEntries(r.results.map((c) => [c.id, c.status]));
    expect(status).toMatchObject({ git: 'pass', 'claude-auth': 'pass', 'codex-auth': 'pass', arch: 'na', 'ssh-reachable': 'na' });
    expect(r.results.every((c) => c.tierImpact === 'none')).toBe(true);
    expect(r).toMatchObject({ hostId: 'local', reachable: true, detectedTier: 'full', appVersion: '2.0.0' });
    expect(r.runtimes).toEqual({ claudeSdk: true, codexSdk: true, claudeCli: true, codexCli: false });
  });

  it('missing pieces warn/fail without changing the fixed tier; codex is only RESOLVED', async () => {
    const resolveCodex = vi.fn(() => { throw new Error('missing'); });
    const r = await local({
      gitVersion: async () => null,
      detectClaudeCredentials: async () => ({ found: false, source: null, account: null }),
      resolveCodex,
    }).preflight('full');
    const byId = new Map(r.results.map((c) => [c.id, c]));
    expect(byId.get('git')?.status).toBe('fail');
    expect(byId.get('claude-auth')?.status).toBe('warn');
    expect(byId.get('codex-auth')?.status).toBe('warn');
    expect(resolveCodex).toHaveBeenCalledTimes(1);
    expect(r.detectedTier).toBe('full');
    expect(r.runtimes.codexSdk).toBe(false);
  });

  it('codex resolved but not signed in warns', async () => {
    const r = await local({ codexAuthPresent: async () => false }).preflight('full');
    expect(r.results.find((c) => c.id === 'codex-auth')?.status).toBe('warn');
  });

  it('a detector exception becomes a fail row + a redacted local seam report', async () => {
    const captureError = vi.fn();
    const r = await local({
      detectClaudeBinary: async () => { throw new Error('kaboom sk-ant-SECRET'); },
      captureError,
    }).preflight('full');
    const row = r.results.find((c) => c.id === 'claude-auth');
    expect(row?.status).toBe('fail');
    expect(row?.detail).not.toContain('SECRET');
    expect(captureError).toHaveBeenCalledWith('host-preflight', expect.any(Error), { hostKind: 'local' });
  });

  it('an aborted signal skips the checks', async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await local().preflight('full', undefined, ac.signal);
    expect(r.results.find((c) => c.id === 'git')?.status).toBe('skipped');
  });
});

describe('LocalHost machine surface', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('refuses a HostPath for another host', async () => {
    const h = local();
    await expect(h.fs.exists({ hostId: 'h1', path: '/tmp' })).rejects.toBeInstanceOf(HostPathMismatchError);
    await expect(h.git.run({ hostId: 'h1', path: '/tmp' }, ['status'])).rejects.toBeInstanceOf(HostPathMismatchError);
  });

  it('fs round-trip with mode', async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'cf-local-')));
    const h = local();
    const sub = { hostId: 'local', path: join(dir, 'a', 'b') };
    const file = { hostId: 'local', path: join(dir, 'a', 'b', 'f') };
    await h.fs.mkdirp(sub);
    expect(await h.fs.exists(file)).toBe(false);
    await h.fs.writeFile(file, 'hello world', 0o600);
    expect(await h.fs.exists(file)).toBe(true);
    expect(await h.fs.readFile(file, 5)).toBe('hello');
    if (posix) expect(statSync(file.path).mode & 0o777).toBe(0o600);
  });

  it.skipIf(!posix)('exec maps success, non-zero exit and missing binaries without throwing', async () => {
    const h = local();
    expect(await h.exec.exec(['/bin/echo', 'hi'])).toEqual({ code: 0, stdout: 'hi\n', stderr: '', timedOut: false });
    const fail = await h.exec.exec(['/bin/sh', '-c', 'echo e >&2; exit 4']);
    expect(fail).toMatchObject({ code: 4, stderr: 'e\n', timedOut: false });
    expect((await h.exec.exec(['/nonexistent/bin'])).code).toBeNull();
  });

  it('exec with stdin goes through the stdin runner', async () => {
    const stdinRunner = vi.fn<ProcessRunner>(async () => ({ code: 0, stdout: 'x', stderr: '', timedOut: false }));
    await local({ stdinRunner }).exec.exec(['cat'], { stdin: 'data' });
    expect(stdinRunner).toHaveBeenCalledWith('cat', [], expect.objectContaining({ stdin: 'data' }));
  });

  it('execErrorToResult classifies timeouts and redacts', () => {
    expect(execErrorToResult(Object.assign(new Error('t'), { killed: true, signal: 'SIGTERM', stderr: '' }))).toMatchObject({ code: null, timedOut: true });
    expect(execErrorToResult(Object.assign(new Error('x'), { code: 2, stderr: 'sk-ant-abc' }))).toMatchObject({ code: 2, stderr: 'sk-ant-[REDACTED]' });
  });
});

function row(over: Partial<HostRow> = {}): HostRow {
  return {
    id: 'h1', label: 'Box', kind: 'ssh', sshTarget: 'box', remoteRoot: '~/cf-remote/h1', arch: null, osVersion: null,
    toolchainHash: null, detectedTier: null, userCapTier: null, preflight: null, preflightAt: null,
    preflightAppVersion: null, lifecycleState: null, lastSeenAt: null, archivedAt: null,
    createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z', ...over,
  };
}

describe('HostRegistry', () => {
  const transport: SshTransportLike = {
    exec: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
    runScript: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
    closeMaster: vi.fn(),
  };

  function registry(rows: Map<string, HostRow>) {
    const localHost = { info: { id: 'local', kind: 'local', label: 'This Mac' } } as unknown as ExecutionHost;
    return { reg: new HostRegistry({ store: { get: (id) => rows.get(id) ?? null }, transport, local: localHost, appVersion: '1' }), localHost };
  }

  it('returns the LocalHost for local and caches SshHosts by id', () => {
    const rows = new Map([['h1', row()]]);
    const { reg, localHost } = registry(rows);
    expect(reg.get('local')).toBe(localHost);
    const a = reg.get('h1');
    expect(a).toBeInstanceOf(SshHost);
    expect(reg.get('h1')).toBe(a);
    expect(a.info).toEqual({ id: 'h1', kind: 'ssh', label: 'Box' });
  });

  it('rebuilds when the target changes and on invalidate (closing the old master)', () => {
    const rows = new Map([['h1', row()]]);
    const { reg } = registry(rows);
    const a = reg.get('h1');
    rows.set('h1', row({ sshTarget: 'box2' }));
    const b = reg.get('h1');
    expect(b).not.toBe(a);
    reg.invalidate('h1');
    expect(transport.closeMaster).toHaveBeenCalledWith('box2');
    expect(reg.get('h1')).not.toBe(b);
    reg.closeAllMasters();
    expect(transport.closeMaster).toHaveBeenLastCalledWith('box2');
  });

  it('unknown or archived hosts throw HostNotFoundError', () => {
    const rows = new Map([['h1', row({ archivedAt: '2026-10-09T00:00:00.000Z' })]]);
    const { reg } = registry(rows);
    expect(() => reg.get('h1')).toThrow(HostNotFoundError);
    expect(() => reg.get('nope')).toThrow(HostNotFoundError);
  });
});
