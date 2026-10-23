import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Readable } from 'node:stream';
import type { ExecResult } from '../../../../orchestrator/trpc/contracts/executionHost';
import type { PushStreamOptions, SshExecOptions, SshTransportLike } from '../../sshTransport';
import { buildToolchainManifest, serializeToolchainManifest, ToolchainHasher } from '../toolchainHash';
import {
  InvalidToolchainRootError,
  ToolchainPushError,
  parseGcListing,
  parseVerifyListing,
  pushToolchain,
  remoteToolchainPaths,
  selectToolchainGc,
  verifyAgainstManifest,
  type PushToolchainInput,
} from '../toolchainPusher';
import type { ToolchainManifest, ToolchainProgress } from '../types';
import { makeFakeToolchain, makeTempDir } from './fixtures';

type Transport = Pick<SshTransportLike, 'pushStream' | 'exec'>;

function run(file: string, args: readonly string[], stdin: string | Readable | undefined): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(file, [...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => err.push(b));
    child.stdin.on('error', () => undefined);
    child.on('close', (code) => resolve({
      code,
      stdout: Buffer.concat(out).toString('utf8'),
      stderr: Buffer.concat(err).toString('utf8'),
      timedOut: false,
    }));
    if (stdin === undefined) child.stdin.end();
    else if (typeof stdin === 'string') child.stdin.end(stdin);
    else stdin.pipe(child.stdin);
  });
}

/** A "remote" that is this machine: runs each program with /bin/sh locally (the real tar / shasum / mv). */
class LocalShellTransport implements Transport {
  readonly calls: string[] = [];
  exec(_target: string, argv: readonly string[], opts?: SshExecOptions): Promise<ExecResult> {
    this.calls.push(`exec:${argv[2]?.slice(0, 12) ?? ''}`);
    return run(argv[0], argv.slice(1), opts?.stdin);
  }
  pushStream(_target: string, script: string, source: Readable, opts: PushStreamOptions): Promise<ExecResult> {
    void opts;
    this.calls.push('push');
    return run('/bin/sh', ['-c', script], source);
  }
}

async function fixture(opts: { withCodex?: boolean } = {}) {
  const tc = makeFakeToolchain(opts);
  const built = await buildToolchainManifest(tc.resolved, { hasher: new ToolchainHasher() });
  const remoteRoot = path.join(makeTempDir('cf-remote-'), 'cf-remote', 'host-1');
  return { ...tc, ...built, remoteRoot };
}

function input(f: Awaited<ReturnType<typeof fixture>>, transport: Transport, extra: Partial<PushToolchainInput> = {}): PushToolchainInput {
  return {
    hostId: 'host-1',
    transport,
    target: 'me@box',
    remoteRoot: f.remoteRoot,
    manifest: f.manifest,
    sources: f.sources,
    ...extra,
  };
}

const posix = process.platform !== 'win32';

describe.runIf(posix)('pushToolchain against a local shell', () => {
  it('installs every file, writes manifest.json last and leaves no temp dir', async () => {
    const f = await fixture();
    const progress: ToolchainProgress[] = [];
    const result = await pushToolchain(input(f, new LocalShellTransport(), { onProgress: (p) => progress.push(p), progressStepBytes: 1000 }));
    const dir = path.join(f.remoteRoot, 'toolchain', f.manifest.hash);
    expect(result).toEqual({ hash: f.manifest.hash, dir, alreadyInstalled: false, removed: [] });
    for (const src of f.sources) {
      expect(fs.readFileSync(path.join(dir, ...src.rel.split('/'))).equals(fs.readFileSync(src.path))).toBe(true);
    }
    expect(fs.statSync(path.join(dir, 'claude')).mode & 0o100).toBe(0o100);
    expect(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).toBe(serializeToolchainManifest(f.manifest));
    expect(fs.readdirSync(path.join(f.remoteRoot, 'toolchain'))).toEqual([f.manifest.hash]);

    const total = f.manifest.files.reduce((n, x) => n + x.size, 0);
    expect(progress.every((p) => p.hostId === 'host-1' && p.bytesTotal === total)).toBe(true);
    const phases = progress.map((p) => p.phase);
    expect(phases[0]).toBe('uploading');
    expect(phases.slice(-2)).toEqual(['verifying', 'done']);
    const uploads = progress.filter((p) => p.phase === 'uploading').map((p) => p.bytesSent);
    expect(uploads[0]).toBe(0);
    expect(uploads[uploads.length - 1]).toBe(total);
    expect(uploads.length).toBeGreaterThan(2); // step 1000 bytes over a ~3.4 KB bundle
    expect(uploads.every((b, i) => i === 0 || b > uploads[i - 1])).toBe(true);
  });

  it('returns early without uploading when the same manifest is already installed', async () => {
    const f = await fixture();
    await pushToolchain(input(f, new LocalShellTransport()));
    const t = new LocalShellTransport();
    const progress: ToolchainProgress[] = [];
    const again = await pushToolchain(input(f, t, { onProgress: (p) => progress.push(p) }));
    expect(again.alreadyInstalled).toBe(true);
    expect(t.calls).toEqual(['exec:f="$1/toolch']);
    expect(progress.map((p) => p.phase)).toEqual(['done']);
  });

  it('reinstalls over a hash dir whose manifest does not match', async () => {
    const f = await fixture();
    await pushToolchain(input(f, new LocalShellTransport()));
    const dir = path.join(f.remoteRoot, 'toolchain', f.manifest.hash);
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{"tampered":true}');
    fs.writeFileSync(path.join(dir, 'claude'), 'corrupt');
    const r = await pushToolchain(input(f, new LocalShellTransport()));
    expect(r.alreadyInstalled).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'claude')).equals(fs.readFileSync(f.resolved.claudePath))).toBe(true);
    expect(fs.readdirSync(path.join(f.remoteRoot, 'toolchain'))).toEqual([f.manifest.hash]);
  });

  it('a verification mismatch fails, removes the upload and renames nothing', async () => {
    const f = await fixture();
    const bad: ToolchainManifest = {
      ...f.manifest,
      files: f.manifest.files.map((x) => (x.rel === 'claude' ? { ...x, sha256: '0'.repeat(64) } : x)),
    };
    const err = await pushToolchain(input(f, new LocalShellTransport(), { manifest: bad })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolchainPushError);
    expect((err as ToolchainPushError).step).toBe('verify');
    expect((err as Error).message).toMatch(/claude does not match/);
    expect(fs.readdirSync(path.join(f.remoteRoot, 'toolchain'))).toEqual([]);
  });

  it('GC keeps the new hash and the newest previous one, removes stale temp dirs, ignores other names', async () => {
    const f = await fixture();
    const tcDir = path.join(f.remoteRoot, 'toolchain');
    const now = Date.now() / 1000;
    const mk = (name: string, ageS: number): void => {
      fs.mkdirSync(path.join(tcDir, name), { recursive: true });
      fs.writeFileSync(path.join(tcDir, name, 'x'), 'x');
      fs.utimesSync(path.join(tcDir, name), now - ageS, now - ageS);
    };
    const [h1, h2, h3] = ['1', '2', '3'].map((c) => c.repeat(64));
    mk(h1, 3000);
    mk(h2, 2000);
    mk(h3, 1000);
    mk('keepme', 99_999);
    mk(`${'a'.repeat(63)}`, 99_999); // 63 chars: not a hash
    mk(`.${h1}.tmp.123`, 7200);
    mk(`.${h2}.tmp.456`, 10);
    fs.writeFileSync(path.join(tcDir, 'b'.repeat(64)), 'a file, not a dir');

    const r = await pushToolchain(input(f, new LocalShellTransport()));
    expect(r.removed).toEqual([`.${h1}.tmp.123`, h1, h2].sort());
    expect(fs.readdirSync(tcDir).sort()).toEqual(
      [f.manifest.hash, h3, 'keepme', 'a'.repeat(63), `.${h2}.tmp.456`, 'b'.repeat(64)].sort(),
    );
  });

  it('serialises concurrent pushes to the same host (the second returns early)', async () => {
    const f = await fixture();
    const t = new LocalShellTransport();
    const [a, b] = await Promise.all([pushToolchain(input(f, t)), pushToolchain(input(f, t))]);
    expect([a.alreadyInstalled, b.alreadyInstalled]).toEqual([false, true]);
    expect(t.calls.filter((c) => c === 'push')).toHaveLength(1);
  });
});

/** In-memory remote for ordering / failure tests. */
class ScriptedTransport implements Transport {
  readonly log: string[] = [];
  installed = new Map<string, string>(); // root -> manifest text
  gate: Promise<void> | null = null;
  pushResult: Partial<ExecResult> | null = null;
  checkResult: Partial<ExecResult> | null = null;

  constructor(private readonly hostTag: string, private readonly manifest: ToolchainManifest) {}

  async exec(_target: string, argv: readonly string[], opts?: SshExecOptions): Promise<ExecResult> {
    const program = argv[2] ?? '';
    const root = argv[4];
    if (program.startsWith('f="$1/toolchain')) {
      this.log.push(`${this.hostTag}:check`);
      if (this.checkResult) return { code: 0, stdout: '', stderr: '', timedOut: false, ...this.checkResult };
      const text = this.installed.get(root);
      return text ? { code: 0, stdout: text, stderr: '', timedOut: false } : { code: 1, stdout: '', stderr: '', timedOut: false };
    }
    if (program.includes('cat > "$t/manifest.json"')) {
      this.log.push(`${this.hostTag}:install`);
      this.installed.set(root, opts?.stdin ?? '');
      return { code: 0, stdout: '', stderr: '', timedOut: false };
    }
    this.log.push(`${this.hostTag}:other`);
    return { code: 0, stdout: '', stderr: '', timedOut: false };
  }

  async pushStream(_target: string, script: string, source: Readable): Promise<ExecResult> {
    this.log.push(`${this.hostTag}:push-start`);
    for await (const chunk of source) void chunk;
    if (this.gate) await this.gate;
    this.log.push(`${this.hostTag}:push-end`);
    if (this.pushResult) return { code: 0, stdout: '', stderr: '', timedOut: false, ...this.pushResult };
    const root = /^set -- '([^']*)'/.exec(script)?.[1] ?? '';
    const tmp = `${root}/toolchain/.${this.manifest.hash}.tmp.42`;
    const lines = [`TMP\t${tmp}`, ...this.manifest.files.map((x) => `${x.rel}\t${x.sha256}`)];
    return { code: 0, stdout: `${lines.join('\n')}\n`, stderr: '', timedOut: false };
  }
}

describe('pushToolchain ordering and failures (scripted transport)', () => {
  it('serialises pushes per host but lets different hosts run in parallel', async () => {
    const f = await fixture();
    const log: string[] = [];
    let open!: () => void;
    const gate = new Promise<void>((r) => {
      open = r;
    });
    const a = new ScriptedTransport('A', f.manifest);
    const b = new ScriptedTransport('B', f.manifest);
    a.gate = gate;
    for (const t of [a, b]) t.log.push = (...items: string[]): number => log.push(...items);

    const first = pushToolchain(input(f, a, { hostId: 'host-a' }));
    const second = pushToolchain(input(f, a, { hostId: 'host-a' }));
    const other = pushToolchain(input(f, b, { hostId: 'host-b' }));
    await other;
    expect(log).toContain('B:install');
    expect(log.filter((l) => l === 'A:check')).toHaveLength(1); // the second A push is still queued
    open();
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.alreadyInstalled).toBe(false);
    expect(r2.alreadyInstalled).toBe(true);
    const aLog = log.filter((l) => l.startsWith('A:'));
    expect(aLog.indexOf('A:install')).toBeLessThan(aLog.lastIndexOf('A:check'));
  });

  it('a failed push does not wedge the host lock', async () => {
    const f = await fixture();
    const t = new ScriptedTransport('A', f.manifest);
    t.pushResult = { code: 92, stderr: 'tar: Error opening archive' };
    await expect(pushToolchain(input(f, t, { hostId: 'host-w' }))).rejects.toMatchObject({ step: 'upload' });
    t.pushResult = null;
    await expect(pushToolchain(input(f, t, { hostId: 'host-w' }))).resolves.toMatchObject({ alreadyInstalled: false });
  });

  it('upload failure → ToolchainPushError with the known reason and a redacted stderr tail', async () => {
    const f = await fixture();
    const t = new ScriptedTransport('A', f.manifest);
    t.pushResult = { code: 92, stderr: 'noise\ntar: bad header near sk-ant-abcdefghijklmnop\n' };
    const err = (await pushToolchain(input(f, t)).catch((e: unknown) => e)) as ToolchainPushError;
    expect(err).toBeInstanceOf(ToolchainPushError);
    expect(err.name).toBe('ToolchainPushError');
    expect(err.step).toBe('upload');
    expect(err.hostId).toBe('host-1');
    expect(err.message).toContain('could not unpack the upload');
    expect(err.message).toContain('sk-ant-[REDACTED]');
    expect(err.message).not.toContain('abcdefghijklmnop');
  });

  it('an ssh failure on the check step → step "check"', async () => {
    const f = await fixture();
    const t = new ScriptedTransport('A', f.manifest);
    t.checkResult = { code: 255, stderr: 'ssh: connect to host box port 22: Connection refused' };
    await expect(pushToolchain(input(f, t))).rejects.toMatchObject({ step: 'check', message: expect.stringContaining('Connection refused') });
    expect(t.log).toEqual(['A:check']);
  });

  it('an unreported temp dir is a verify failure', async () => {
    const f = await fixture();
    const t = new ScriptedTransport('A', f.manifest);
    t.pushResult = { code: 0, stdout: f.manifest.files.map((x) => `${x.rel}\t${x.sha256}`).join('\n') };
    await expect(pushToolchain(input(f, t))).rejects.toMatchObject({ step: 'verify' });
    expect(t.log).not.toContain('A:install');
  });

  it('an aborted signal stops before anything runs', async () => {
    const f = await fixture();
    const t = new ScriptedTransport('A', f.manifest);
    const ac = new AbortController();
    ac.abort();
    await expect(pushToolchain(input(f, t, { signal: ac.signal }))).rejects.toMatchObject({ step: 'aborted' });
    expect(t.log).toEqual([]);
  });

  it('rejects a relative remote root', async () => {
    const f = await fixture();
    const t = new ScriptedTransport('A', f.manifest);
    await expect(pushToolchain(input(f, t, { remoteRoot: '~/cf-remote' }))).rejects.toMatchObject({ step: 'check' });
    expect(t.log).toEqual([]);
  });
});

describe('pure helpers', () => {
  const manifest = {
    hash: 'f'.repeat(64),
    codexTarget: 'aarch64-apple-darwin',
  };

  it('remoteToolchainPaths', () => {
    expect(remoteToolchainPaths('/Users/me/cf-remote/h1/', manifest)).toEqual({
      dir: `/Users/me/cf-remote/h1/toolchain/${'f'.repeat(64)}`,
      claude: `/Users/me/cf-remote/h1/toolchain/${'f'.repeat(64)}/claude`,
      mcpBundle: `/Users/me/cf-remote/h1/toolchain/${'f'.repeat(64)}/cyboflowMcpServer.js`,
      codexBin: `/Users/me/cf-remote/h1/toolchain/${'f'.repeat(64)}/codex/aarch64-apple-darwin/bin/codex`,
      codexPathDir: `/Users/me/cf-remote/h1/toolchain/${'f'.repeat(64)}/codex/aarch64-apple-darwin/codex-path`,
    });
    const noCodex = remoteToolchainPaths('/r', { ...manifest, codexTarget: null });
    expect(noCodex.codexBin).toBeNull();
    expect(noCodex.codexPathDir).toBeNull();
    expect(() => remoteToolchainPaths('relative', manifest)).toThrow(InvalidToolchainRootError);
    expect(() => remoteToolchainPaths('/', manifest)).toThrow(InvalidToolchainRootError);
  });

  it('selectToolchainGc keeps the current + newest other hash and only removes GC-shaped names', () => {
    const h = (c: string): string => c.repeat(64);
    const entries = [
      { name: h('a'), mtimeS: 100 },
      { name: h('b'), mtimeS: 300 },
      { name: h('c'), mtimeS: 200 },
      { name: h('d'), mtimeS: 50 }, // current, oldest mtime: still kept
      { name: 'keepme', mtimeS: 1 },
      { name: h('A'), mtimeS: 1 }, // uppercase: not a hash
      { name: `.${h('a')}.tmp.1`, mtimeS: 10 },
      { name: `.${h('a')}.old.2`, mtimeS: 10_000 },
      { name: `.${h('a')}.tmp.x`, mtimeS: 1 },
    ];
    expect(selectToolchainGc(entries, h('d'), 10_000)).toEqual([`.${h('a')}.tmp.1`, h('a'), h('c')].sort());
  });

  it('parses listings', () => {
    expect(parseGcListing('NOW\t500\n12\tabc\nbad\n7\t\n')).toEqual({ nowS: 500, entries: [{ name: 'abc', mtimeS: 12 }] });
    const v = parseVerifyListing('TMP\t/r/toolchain/.x.tmp.1\nclaude\tabc\n');
    expect(v.tmpDir).toBe('/r/toolchain/.x.tmp.1');
    expect([...v.hashes]).toEqual([['claude', 'abc']]);
  });

  it('verifyAgainstManifest detects missing, mismatched and extra files', () => {
    const m = { files: [{ rel: 'claude', sha256: 'a', size: 1, mode: 0o755 }] } as ToolchainManifest;
    expect(verifyAgainstManifest(m, new Map([['claude', 'a']]))).toBeNull();
    expect(verifyAgainstManifest(m, new Map())).toMatch(/missing/);
    expect(verifyAgainstManifest(m, new Map([['claude', 'b']]))).toMatch(/does not match/);
    expect(verifyAgainstManifest(m, new Map([['claude', 'a'], ['evil', 'x']]))).toMatch(/unexpected file on the host: evil/);
  });
});
