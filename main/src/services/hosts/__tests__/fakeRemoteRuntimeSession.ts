/**
 * Test fixture: an in-memory RemoteRuntimeSession (no ssh). `env()` is the REAL allowlist
 * (remoteLaunch.composeRemoteEnv) over fixed remote facts, so tests of the Claude remote spawn see exactly the env
 * a real session would hand the remote process. `spawn()` records each spec and returns a RemoteHostProcess over a
 * fake ssh child (or whatever `spawnImpl` returns).
 */
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import type {
  GitExecutor,
  HostProcess,
  HostSpawnSpec,
  MachineFs,
} from '../../../orchestrator/trpc/contracts/executionHost';
import { RemoteHostProcess, type HostProcessTimers } from '../hostProcess';
import { composeRemoteEnv, composeRemotePath, type RemoteHostFacts } from '../remoteLaunch';
import { remoteArtifactsDir, remoteRunTokenFile, type RemoteRuntimeSession } from '../remoteRuntime';

export const FAKE_REMOTE_ROOT = '/Users/remote/cf-remote/host-1';
export const FAKE_TOOLCHAIN = `${FAKE_REMOTE_ROOT}/toolchain/${'a'.repeat(64)}`;
export const FAKE_REMOTE_SOCK = `${FAKE_REMOTE_ROOT}/s/o.sock`;
export const FAKE_REMOTE_NODE = '/opt/homebrew/bin/node';

export const FAKE_FACTS: RemoteHostFacts = {
  remoteRoot: FAKE_REMOTE_ROOT,
  home: '/Users/remote',
  user: 'remote',
  logname: 'remote',
  shell: '/bin/zsh',
  tmpdir: '/var/folders/xy/T/',
  lang: 'en_US.UTF-8',
};

export class FakeSshChild extends EventEmitter {
  readonly written: string[] = [];
  readonly signals: NodeJS.Signals[] = [];
  readonly stdin = new Writable({
    write: (chunk: Buffer, _enc, cb) => {
      this.written.push(chunk.toString('utf8'));
      cb();
    },
  });
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal);
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }
}

/** setTimeout that only runs on fire(). */
export function manualTimers(): HostProcessTimers & { fire(): void } {
  const queue: Array<{ fn: () => void; cancelled: boolean }> = [];
  return {
    setTimeout: (fn) => {
      const entry = { fn, cancelled: false };
      queue.push(entry);
      return entry;
    },
    clearTimeout: (h) => {
      (h as { cancelled: boolean }).cancelled = true;
    },
    fire: () => {
      for (const e of queue.splice(0)) if (!e.cancelled) e.fn();
    },
  };
}

export interface FakeSpawned {
  spec: HostSpawnSpec;
  child: FakeSshChild;
  proc: HostProcess;
  remoteKills: Array<'TERM' | 'KILL'>;
}

export interface FakeRemoteSession extends RemoteRuntimeSession {
  readonly spawned: FakeSpawned[];
  readonly mkdirs: string[];
  readonly releaseCalls: number;
}

export function createFakeRemoteSession(opts: {
  hostId?: string;
  runId?: string;
  spawnKey?: string;
  timers?: HostProcessTimers;
  mkdirpError?: Error;
  generation?: number;
  /** Replace the default no-op MachineFs (e.g. an in-memory one); `mkdirs` then records nothing. */
  fs?: MachineFs;
} = {}): FakeRemoteSession {
  const hostId = opts.hostId ?? 'host-1';
  const runId = opts.runId ?? 'run-1';
  const spawned: FakeSpawned[] = [];
  const mkdirs: string[] = [];
  let released = false;
  let releaseCalls = 0;
  const paths = {
    claude: `${FAKE_TOOLCHAIN}/claude`,
    mcpBundle: `${FAKE_TOOLCHAIN}/cyboflowMcpServer.js`,
    codexBin: null,
    codexPathDir: null,
    nodePath: FAKE_REMOTE_NODE,
    gitPath: '/usr/bin/git',
  };
  const tokenFile = remoteRunTokenFile(FAKE_REMOTE_ROOT, runId);
  const remotePath = (): string => composeRemotePath({ nodeDir: '/opt/homebrew/bin' });
  const notUsed = (): never => {
    throw new Error('not used by this fixture');
  };
  const fs: MachineFs = {
    exists: async () => false,
    readFile: async () => notUsed(),
    writeFile: async () => undefined,
    mkdirp: async (p) => {
      if (opts.mkdirpError) throw opts.mkdirpError;
      mkdirs.push(p.path);
    },
    readdir: async () => [],
    unlink: async () => undefined,
    rmrf: async () => undefined,
    stat: async () => null,
  };
  const git: GitExecutor = { run: async () => notUsed(), capture: async () => notUsed() };
  return {
    hostId,
    generation: opts.generation ?? 0,
    facts: FAKE_FACTS,
    remoteRoot: FAKE_REMOTE_ROOT,
    paths,
    remoteSock: FAKE_REMOTE_SOCK,
    tokenFile,
    runId,
    spawnKey: opts.spawnKey ?? runId,
    codexAvailable: false,
    artifactsDir: (runKey: string) => remoteArtifactsDir(FAKE_REMOTE_ROOT, runKey),
    remotePath,
    env: (localEnv, envOpts = {}) => composeRemoteEnv(localEnv, {
      facts: FAKE_FACTS,
      path: remotePath(),
      orchSocket: FAKE_REMOTE_SOCK,
      orchTokenFile: tokenFile,
      artifactsDir: envOpts.artifactsDir ?? null,
      codexHome: envOpts.codexHome ?? null,
      extraKeys: envOpts.extraKeys,
      pathMap: envOpts.pathMap,
    }),
    spawn: (spec) => {
      if (released) throw new Error('released');
      const child = new FakeSshChild();
      const remoteKills: Array<'TERM' | 'KILL'> = [];
      const fullSpec: HostSpawnSpec = { ...spec, spawnKey: spec.spawnKey ?? opts.spawnKey ?? runId };
      const proc = new RemoteHostProcess({
        child: child as unknown as ChildProcess,
        prelude: '\n',
        signal: spec.signal,
        timers: opts.timers,
        remoteKill: async (signal) => {
          remoteKills.push(signal);
        },
      });
      spawned.push({ spec: fullSpec, child, proc, remoteKills });
      return proc;
    },
    fs: opts.fs ?? fs,
    git,
    release: () => {
      releaseCalls++;
      released = true;
    },
    get released() {
      return released;
    },
    get spawned() {
      return spawned;
    },
    get mkdirs() {
      return mkdirs;
    },
    get releaseCalls() {
      return releaseCalls;
    },
  };
}
