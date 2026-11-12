/**
 * remoteCodexSpawn (spec M2 B3): the Codex client's spawn seam on an SSH environment, the per-host MCP runtime
 * config, and the teardown path — a HostProcess has no pid, so the REAL CodexAppServerClient never signals a local
 * process group and the remote kill sequence runs instead.
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../utils/platformProcess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/platformProcess')>();
  return { ...actual, signalTree: vi.fn(() => 'signalled') };
});

import { signalTree } from '../../../utils/platformProcess';
import { CodexAppServerClient, type AppServerProcess } from '../../panels/codex/appServer/client';
import { CODEX_EXECUTABLE_VERSION } from '../../panels/codex/codexExecutablePath';
import type { HostProcess, HostSpawnSpec } from '../../../orchestrator/trpc/contracts/executionHost';
import { RemoteHostProcess } from '../hostProcess';
import type { RemoteRuntimeSession } from '../remoteRuntime';
import {
  createRemoteCodexSpawn,
  prepareRemoteCodexLaunch,
  RemoteCodexUnavailableError,
  remoteCodexMcpRuntimeConfig,
} from '../remoteCodexSpawn';

// Type-level: a HostProcess is an AppServerProcess.
const _hostProcessIsAppServerProcess = (p: HostProcess): AppServerProcess => p;
void _hostProcessIsAppServerProcess;

const ROOT = '/Users/me/cf-remote/h1';
const CODEX_BIN = `${ROOT}/toolchain/abc/codex/aarch64-apple-darwin/bin/codex`;

class FakeHostProcess extends EventEmitter implements HostProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = undefined;
  readonly exitCode = null;
  readonly signalCode = null;
  killed = false;
  readonly kill = vi.fn((_signal?: NodeJS.Signals | number) => {
    this.killed = true;
    queueMicrotask(() => this.emit('exit', null, 'SIGTERM'));
    return true;
  });
}

function session(over: { codexBin?: string | null; spawn?: (spec: Omit<HostSpawnSpec, 'spawnKey'>) => HostProcess } = {}) {
  const release = vi.fn();
  const spawn = vi.fn(over.spawn ?? (() => new FakeHostProcess()));
  const s = {
    hostId: 'h1',
    remoteRoot: ROOT,
    remoteSock: `${ROOT}/s/o.sock`,
    tokenFile: `${ROOT}/run/run-1.token`,
    paths: {
      claude: `${ROOT}/toolchain/abc/claude`,
      mcpBundle: `${ROOT}/toolchain/abc/cyboflowMcpServer.js`,
      codexBin: over.codexBin === undefined ? CODEX_BIN : over.codexBin,
      codexPathDir: null,
      nodePath: '/opt/homebrew/bin/node',
      gitPath: null,
    },
    spawn,
    release,
  } as unknown as RemoteRuntimeSession;
  return { s, release, spawn };
}

afterEach(() => {
  vi.mocked(signalTree).mockClear();
});

describe('remoteCodexSpawn', () => {
  it('builds the per-host MCP runtime config with the token FILE, never the token', () => {
    const { s } = session();
    expect(remoteCodexMcpRuntimeConfig(s)).toEqual({
      orchSocketPath: `${ROOT}/s/o.sock`,
      bridgeScriptPath: `${ROOT}/toolchain/abc/cyboflowMcpServer.js`,
      nodeExecutablePath: '/opt/homebrew/bin/node',
      orchTokenFile: `${ROOT}/run/run-1.token`,
    });
  });

  it('spawns the pushed codex on the host whatever command the client passes, releasing on exit', () => {
    const { s, spawn } = session();
    const proc = createRemoteCodexSpawn(s)('/Applications/cyboflow.app/codex', ['app-server'], { cwd: `${ROOT}/wt`, env: { K: 'v' } });
    expect(proc.pid).toBeUndefined();
    expect(spawn).toHaveBeenCalledWith(
      { command: CODEX_BIN, args: ['app-server'], cwd: `${ROOT}/wt`, env: { K: 'v' } },
      { releaseOnExit: true },
    );
  });

  it('prepareRemoteCodexLaunch returns the launch, and releases + refuses readably without codex', async () => {
    const ok = session();
    const launch = await prepareRemoteCodexLaunch({ prepare: vi.fn(async () => ok.s) }, 'h1', { runId: 'run-1', spawnKey: 'k' });
    expect(launch.command).toBe(CODEX_BIN);
    expect(launch.version).toBe(CODEX_EXECUTABLE_VERSION);
    expect(launch.runtimeConfig.orchTokenFile).toBe(`${ROOT}/run/run-1.token`);
    expect(ok.release).not.toHaveBeenCalled();

    const none = session({ codexBin: null });
    await expect(prepareRemoteCodexLaunch({ prepare: vi.fn(async () => none.s) }, 'h1', { runId: 'run-1', spawnKey: 'k' }))
      .rejects.toBeInstanceOf(RemoteCodexUnavailableError);
    expect(none.release).toHaveBeenCalledOnce();
  });

  it('the real client tears a pid-less HostProcess down with kill(), never a local group signal', async () => {
    const proc = new FakeHostProcess();
    const { s } = session({ spawn: () => proc });
    const client = new CodexAppServerClient({ command: CODEX_BIN, cwd: `${ROOT}/wt`, env: {}, spawn: createRemoteCodexSpawn(s) });
    client.start();
    await client.stop();
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(signalTree).not.toHaveBeenCalled();
  });

  it('through a RemoteHostProcess, a stuck app-server gets the remote group KILL (no local group signal)', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      pid: 4242,
      kill: vi.fn(() => true),
    }) as unknown as ChildProcess;
    const remoteKill = vi.fn(async (_signal: 'TERM' | 'KILL') => undefined);
    const hostProc = new RemoteHostProcess({ child, prelude: '\n', remoteKill, killGraceMs: 60_000 });
    const { s } = session({ spawn: () => hostProc });
    const client = new CodexAppServerClient({
      command: CODEX_BIN, cwd: `${ROOT}/wt`, env: {}, spawn: createRemoteCodexSpawn(s), stopTimeoutMs: 0, forceKillTimeoutMs: 0,
    });
    client.start();
    await client.stop();
    expect(remoteKill).toHaveBeenCalledWith('KILL');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(signalTree).not.toHaveBeenCalled();
  });
});
