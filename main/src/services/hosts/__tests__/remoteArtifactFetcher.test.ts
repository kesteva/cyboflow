/**
 * RemoteArtifactFetcher (spec M2 §5 D4) — the fixed remote read program runs under the REAL local /bin/sh, reached
 * exactly as ssh would hand it to a remote login shell (quoteRemoteArgv → `/bin/sh -c`), so these cases prove the
 * program itself: binary-safe base64 chunks (a multi-chunk random file and a PNG), the size cap, a missing file,
 * symlink / escape refusals, and the gates.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecResult, ExecutionHost, ExecOptions } from '../../../orchestrator/trpc/contracts/executionHost';
import type { HostsFeatureStatus } from '../../../../../shared/types/hosts';
import { RemoteArtifactFetchError } from '../../../orchestrator/hosts/remoteArtifactPull';
import { decodeBase64Chunk, RemoteArtifactFetcher, remoteArtifactReadArgv } from '../remoteArtifactFetcher';
import { quoteRemoteArgv } from '../sshTransport';

const posix = process.platform !== 'win32';
const RUNNING: HostsFeatureStatus = { available: true, enabled: true, killed: false, scheduleKilled: false, running: true };
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMEAYHwPzYAAAAASUVORK5CYII=',
  'base64',
);

/** exec = what an ssh host does: the argv quoted for a login shell, run by /bin/sh here. Binary-free output only. */
function shExec(argv: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile('/bin/sh', ['-c', quoteRemoteArgv(argv)], { timeout: opts.timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? Number((err as { code: number }).code) : 1) : 0;
      resolve({ code, stdout, stderr, timedOut: false });
    });
  });
}

let root: string;
let local: string;
let calls: string[][];

function makeHost(remoteRoot: string | null): ExecutionHost {
  return {
    info: { id: 'h1', kind: 'ssh', label: 'box', remoteRoot },
    exec: {
      exec: (argv: string[], opts?: ExecOptions) => {
        calls.push(argv);
        return shExec(argv, opts);
      },
    },
  } as unknown as ExecutionHost;
}

function fetcher(host: ExecutionHost | null = makeHost(root), status: HostsFeatureStatus = RUNNING): RemoteArtifactFetcher {
  return new RemoteArtifactFetcher({
    getResolver: () => (host ? () => host : null),
    getHosts: () => ({ status: () => status }),
  });
}

const runDir = () => join(root, 'artifacts', 'runs', 'run-1');

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cf-remote-art-')));
  local = mkdtempSync(join(tmpdir(), 'cf-local-art-'));
  mkdirSync(join(runDir(), 'prototype'), { recursive: true });
  calls = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(local, { recursive: true, force: true });
});

describe.runIf(posix)('RemoteArtifactFetcher under /bin/sh', () => {
  it('copies a PNG and an HTML document byte for byte into the local run dir', async () => {
    writeFileSync(join(runDir(), 'shot.png'), PNG);
    writeFileSync(join(runDir(), 'prototype', 'index.html'), '<!doctype html><p>héllo</p>');
    await fetcher().fetch({ hostId: 'h1', runKey: 'run-1', relPaths: ['shot.png', 'prototype/index.html'], localDir: local, maxBytes: 10 * 1024 * 1024 });
    expect(readFileSync(join(local, 'shot.png')).equals(PNG)).toBe(true);
    expect(readFileSync(join(local, 'prototype', 'index.html'), 'utf8')).toBe('<!doctype html><p>héllo</p>');
  });

  it('reads a multi-chunk binary file in base64 chunks and reassembles it exactly', async () => {
    const big = randomBytes(5 * 1024 * 1024 + 123);
    writeFileSync(join(runDir(), 'big.png'), big);
    await fetcher().fetch({ hostId: 'h1', runKey: 'run-1', relPaths: ['big.png'], localDir: local, maxBytes: 10 * 1024 * 1024 });
    expect(readFileSync(join(local, 'big.png')).equals(big)).toBe(true);
    // size + ceil(5 MiB / 2 MiB) = 3 chunks.
    expect(calls.length).toBe(4);
  });

  it('copies an empty file', async () => {
    writeFileSync(join(runDir(), 'empty.png'), '');
    await fetcher().fetch({ hostId: 'h1', runKey: 'run-1', relPaths: ['empty.png'], localDir: local, maxBytes: 100 });
    expect(readFileSync(join(local, 'empty.png')).length).toBe(0);
  });

  it('fails readably when the file is missing on the environment', async () => {
    await expect(
      fetcher().fetch({ hostId: 'h1', runKey: 'run-1', relPaths: ['prototype/index.html'], localDir: local, maxBytes: 100 }),
    ).rejects.toThrow("prototype/index.html was not found in this run's artifacts folder on the environment");
    expect(existsSync(join(local, 'prototype', 'index.html'))).toBe(false);
  });

  it('refuses a file over the size cap before reading it', async () => {
    writeFileSync(join(runDir(), 'shot.png'), Buffer.alloc(2048));
    await expect(
      fetcher().fetch({ hostId: 'h1', runKey: 'run-1', relPaths: ['shot.png'], localDir: local, maxBytes: 1024 }),
    ).rejects.toThrow('shot.png is 2048 bytes, over the 1024-byte limit');
    expect(calls.length).toBe(1);
  });

  it('refuses a symlinked file and a symlinked directory that leaves the run dir', async () => {
    const outside = join(root, 'secret.txt');
    writeFileSync(outside, 'secret');
    symlinkSync(outside, join(runDir(), 'link.png'));
    symlinkSync(root, join(runDir(), 'up'));
    const f = fetcher();
    await expect(f.fetch({ hostId: 'h1', runKey: 'run-1', relPaths: ['link.png'], localDir: local, maxBytes: 100 }))
      .rejects.toThrow('is a link or lies outside');
    await expect(f.fetch({ hostId: 'h1', runKey: 'run-1', relPaths: ['up/secret.txt'], localDir: local, maxBytes: 100 }))
      .rejects.toThrow('is a link or lies outside');
  });

  it('a path with spaces and quotes stays one positional argument', async () => {
    const name = `it's a "shot".png`;
    writeFileSync(join(runDir(), name), PNG);
    await fetcher().fetch({ hostId: 'h1', runKey: 'run-1', relPaths: [name], localDir: local, maxBytes: 1024 });
    expect(readFileSync(join(local, name)).equals(PNG)).toBe(true);
  });

  it('the program reports the size and a chunk directly', async () => {
    writeFileSync(join(runDir(), 'shot.png'), PNG);
    const file = join(runDir(), 'shot.png');
    const size = await shExec(remoteArtifactReadArgv(file, runDir(), 'size'));
    expect(Number(size.stdout.trim())).toBe(PNG.length);
    const chunk = await shExec(remoteArtifactReadArgv(file, runDir(), 0));
    expect(decodeBase64Chunk(chunk.stdout)?.equals(PNG)).toBe(true);
  });
});

describe('RemoteArtifactFetcher gates and validation', () => {
  it('refuses when Environments are off, kill-switched or unwired, and for an unchecked host', async () => {
    const req = { hostId: 'h1', runKey: 'run-1', relPaths: ['a.png'], localDir: '/nonexistent', maxBytes: 10 };
    await expect(fetcher(makeHost(root), { ...RUNNING, running: false }).fetch(req)).rejects.toThrow('Environments are turned off');
    await expect(fetcher(makeHost(root), { ...RUNNING, killed: true }).fetch(req)).rejects.toThrow('remote environments are turned off');
    await expect(fetcher(null).fetch(req)).rejects.toThrow('not available right now');
    await expect(fetcher(makeHost(null)).fetch(req)).rejects.toBeInstanceOf(RemoteArtifactFetchError);
    expect(calls.length).toBe(0);
  });

  // The fixture's remote root is a local temp dir, which is not a POSIX absolute path on Windows.
  it.skipIf(!posix)('refuses an unsafe relative path before any remote call', async () => {
    for (const rel of ['../x.png', '/etc/passwd', 'a//b.png', 'a\\b.png']) {
      await expect(
        fetcher().fetch({ hostId: 'h1', runKey: 'run-1', relPaths: [rel], localDir: local, maxBytes: 10 }),
      ).rejects.toThrow('is not a file name inside the run artifacts folder');
    }
    expect(calls.length).toBe(0);
  });

  it('decodeBase64Chunk rejects non-base64 text and tolerates line wrapping', () => {
    expect(decodeBase64Chunk('aGVs\nbG8=\n')?.toString()).toBe('hello');
    expect(decodeBase64Chunk('not base64!')).toBeNull();
  });
});
