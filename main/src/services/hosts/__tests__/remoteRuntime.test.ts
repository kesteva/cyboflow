/**
 * RemoteRuntime (spec M2 B1): host resolution precedence, prepare()'s gates, the orch link lease, the 0600 per-run
 * token file (written once per run, only ever on stdin — never on an ssh argv), the remote env allowlist, and the
 * module bridge. The ExecutionHost is a REAL SshHost over a recording SshTransportLike: nothing spawns ssh.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import Database from 'better-sqlite3';
import type { HostView, PreflightRemoteFacts, PreflightResult } from '../../../../../shared/types/hosts';
import { dbAdapter } from '../../../orchestrator/__test_fixtures__/dbAdapter';
import { HostNotFoundError, HostsDisabledError, RemoteHostsDisabledError } from '../../../orchestrator/hosts/errors';
import type { ExecResult } from '../../../orchestrator/trpc/contracts/executionHost';
import type { LoggerLike } from '../../../orchestrator/types';
import type { HostLinkHandle } from '../hostsService';
import { SPAWN_WRAPPER } from '../remoteLaunch';
import {
  normalizeHostId,
  remoteRunTokenFile,
  remoteSpawnKey,
  RemoteRuntime,
  RemoteRuntimeError,
  resolveHostIdFromDb,
  type RemoteRuntimeDeps,
  type RemoteRuntimeHostsLike,
} from '../remoteRuntime';
import { fenceArgv, FENCE_PROGRAM, RUN_DIR_GC_PROGRAM, RUN_REAP_PROGRAM, TOKEN_REMOVE_PROGRAM } from '../remoteFencing';
import {
  getRemoteRuntime,
  requireRemoteRuntime,
  RemoteRuntimeNotComposedError,
  setRemoteRuntime,
} from '../remoteRuntimeBridge';
import { SshHost } from '../sshHost';
import type { SshExecOptions, SshTransportLike } from '../sshTransport';

const HASH = 'a'.repeat(64);
const ROOT = '/Users/me/cf-remote/h1';
const TOKEN = 'f'.repeat(64);
const MANIFEST = JSON.stringify({ layout: 1, hash: HASH, arch: 'arm64', codexTarget: 'aarch64-apple-darwin', files: [] });

const REMOTE: PreflightRemoteFacts = {
  home: '/Users/me', remoteRoot: ROOT, user: 'me', logname: 'me', shell: '/bin/zsh', tmpdir: '/tmp/x', lang: 'en_US.UTF-8',
  nodePath: '/opt/homebrew/bin/node', gitPath: '/usr/bin/git', codexPath: null, arch: 'arm64', socketPathOk: true,
};

function preflight(over: Partial<PreflightResult> = {}): PreflightResult {
  return {
    hostId: 'h1', mode: 'full', startedAt: '2026-10-22T10:00:00.000Z', finishedAt: '2026-10-22T10:00:01.000Z',
    results: [], reachable: true, probeComplete: true, detectedTier: 'full',
    runtimes: { claudeSdk: true, codexSdk: true, claudeCli: true, codexCli: false },
    arch: 'arm64', osVersion: 'macOS 15', toolchainHash: HASH, appVersion: '1.0.0', remote: REMOTE, ...over,
  };
}

type View = Pick<HostView, 'id' | 'kind' | 'archivedAt' | 'remoteReady' | 'preflight'>;

interface ExecCall {
  argv: readonly string[];
  opts?: SshExecOptions;
}

function recordingTransport(answer: (argv: readonly string[]) => Partial<ExecResult> = () => ({})): {
  transport: SshTransportLike;
  calls: ExecCall[];
  streams: string[];
} {
  const calls: ExecCall[] = [];
  const streams: string[] = [];
  const transport: SshTransportLike = {
    exec: async (_target, argv, opts) => {
      calls.push({ argv, opts });
      return { code: 0, stdout: '', stderr: '', timedOut: false, ...answer(argv) };
    },
    runScript: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
    closeMaster: () => undefined,
    controlArgs: () => [],
    spawnStreaming: (_target, command) => {
      streams.push(command);
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true,
      });
      return child as unknown as ChildProcess;
    },
    openForward: () => { throw new Error('not used'); },
    pushStream: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
  };
  return { transport, calls, streams };
}

const manifestAnswer = (argv: readonly string[]): Partial<ExecResult> =>
  (argv.some((a) => a.endsWith('/manifest.json')) ? { stdout: MANIFEST } : {});

const logger: LoggerLike = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

interface Harness {
  rt: RemoteRuntime;
  calls: ExecCall[];
  streams: string[];
  link: { acquires: number; releases: number; fail: Error | null };
  hostsState: { running: boolean; killed: boolean; view: View | null; linkForThrows: Error | null; generation: number };
  mint: ReturnType<typeof vi.fn>;
  env: NodeJS.ProcessEnv;
}

function harness(opts: {
  answer?: (argv: readonly string[]) => Partial<ExecResult>;
  db?: Database.Database;
  rtDeps?: Partial<RemoteRuntimeDeps>;
} = {}): Harness {
  const { transport, calls, streams } = recordingTransport(opts.answer ?? manifestAnswer);
  const ssh = new SshHost({
    id: 'h1', label: 'Box', sshTarget: 'box', remoteRoot: '~/cf-remote/h1', appVersion: '1.0.0', transport,
    localExists: () => false,
    remoteFacts: () => ({ remoteRoot: ROOT, home: '/Users/me', user: 'me' }),
  });
  const link = { acquires: 0, releases: 0, fail: null as Error | null };
  const hostsState = {
    running: true,
    killed: false,
    view: { id: 'h1', kind: 'ssh', archivedAt: null, remoteReady: true, preflight: preflight() } as View | null,
    linkForThrows: null as Error | null,
    generation: 0,
  };
  const hosts: RemoteRuntimeHostsLike = {
    status: () => ({ running: hostsState.running, killed: hostsState.killed }),
    generation: () => hostsState.generation,
    get: (id) => {
      if (id !== 'h1' || hostsState.view === null) throw new HostNotFoundError();
      return hostsState.view;
    },
    linkFor: (): HostLinkHandle => {
      if (hostsState.linkForThrows) throw hostsState.linkForThrows;
      return {
        acquire: async () => {
          if (link.fail) throw link.fail;
          link.acquires++;
          return { remoteSock: `${ROOT}/s/o.sock` };
        },
        release: () => { link.releases++; },
      };
    },
  };
  const raw = opts.db ?? new Database(':memory:');
  const mint = vi.fn((_runId: string) => TOKEN);
  const env: NodeJS.ProcessEnv = {};
  const rt = new RemoteRuntime({
    db: dbAdapter(raw),
    hosts,
    getHost: (id) => {
      if (id !== 'h1') throw new HostNotFoundError();
      return ssh;
    },
    logger,
    mintToken: mint,
    env,
    runTerminalEvents: null,
    ...opts.rtDeps,
  });
  return { rt, calls, streams, link, hostsState, mint, env };
}

function allArgv(calls: ExecCall[]): string {
  return calls.map((c) => c.argv.join('\u0001')).join('\u0002');
}

// ---------------------------------------------------------------------------------------------------------------

describe('resolveHostIdFromDb', () => {
  let raw: Database.Database;
  beforeEach(() => {
    raw = new Database(':memory:');
    raw.exec(`CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, host_id TEXT);
              CREATE TABLE sessions (id TEXT PRIMARY KEY, host_id TEXT);
              INSERT INTO workflow_runs VALUES ('run-remote', 'h1'), ('run-local', NULL), ('run-lit', 'local'), ('run-other', 'h2');
              INSERT INTO sessions VALUES ('s-remote', 'h1'), ('s-local', NULL), ('s-other', 'h3');`);
  });
  afterEach(() => raw.close());

  it('normalizes local / null / undefined / empty to null', () => {
    expect(normalizeHostId('local')).toBeNull();
    expect(normalizeHostId(null)).toBeNull();
    expect(normalizeHostId(undefined)).toBeNull();
    expect(normalizeHostId('')).toBeNull();
    expect(normalizeHostId('h1')).toBe('h1');
  });

  it('an explicit string wins outright (no lookup)', () => {
    const db = dbAdapter(raw);
    expect(resolveHostIdFromDb(db, { hostId: 'h9', runId: 'run-remote', sessionId: 's-remote' })).toBe('h9');
    expect(resolveHostIdFromDb(db, { hostId: 'local', runId: 'run-remote', sessionId: 's-remote' })).toBeNull();
  });

  it('then the run stamp, then the session stamp; a NULL stamp never masks a remote one', () => {
    const db = dbAdapter(raw);
    expect(resolveHostIdFromDb(db, { runId: 'run-remote', sessionId: 's-other' })).toBe('h1');
    expect(resolveHostIdFromDb(db, { runId: 'run-other', sessionId: 's-remote' })).toBe('h2');
    expect(resolveHostIdFromDb(db, { runId: 'run-local', sessionId: 's-remote' })).toBe('h1');
    expect(resolveHostIdFromDb(db, { runId: 'run-lit', sessionId: 's-remote' })).toBe('h1');
    expect(resolveHostIdFromDb(db, { hostId: null, runId: 'run-remote' })).toBe('h1');
    expect(resolveHostIdFromDb(db, { runId: 'missing', sessionId: 's-other' })).toBe('h3');
    expect(resolveHostIdFromDb(db, { sessionId: 's-remote' })).toBe('h1');
  });

  it('local everywhere → null', () => {
    const db = dbAdapter(raw);
    expect(resolveHostIdFromDb(db, { runId: 'run-local', sessionId: 's-local' })).toBeNull();
    expect(resolveHostIdFromDb(db, { runId: 'run-lit' })).toBeNull();
    expect(resolveHostIdFromDb(db, { runId: 'nope', sessionId: 'nope' })).toBeNull();
    expect(resolveHostIdFromDb(db, {})).toBeNull();
  });

  it('RemoteRuntime.resolveHostId delegates to the injected db', () => {
    const h = harness({ db: raw });
    expect(h.rt.resolveHostId({ sessionId: 's-remote' })).toBe('h1');
    expect(h.rt.resolveHostId({ runId: 'run-local' })).toBeNull();
  });
});

describe('remoteSpawnKey / names', () => {
  it('keeps a safe key and digests an unsafe one (distinct keys stay distinct)', () => {
    expect(remoteSpawnKey('run-1')).toBe('run-1');
    const a = remoteSpawnKey('run-1:task-1');
    const b = remoteSpawnKey('run-1_task-1');
    expect(a).toMatch(/^run-1_task-1-[0-9a-f]{8}$/);
    expect(b).toBe('run-1_task-1');
    expect(a).not.toBe(b);
    expect(remoteSpawnKey('x'.repeat(300))).toMatch(/^[A-Za-z0-9._-]{1,128}$/);
    expect(() => remoteSpawnKey('')).toThrow(RemoteRuntimeError);
  });

  it('token file under <root>/run; a run id that cannot name a file is refused', () => {
    expect(remoteRunTokenFile(`${ROOT}/`, 'r1')).toBe(`${ROOT}/run/r1.token`);
    expect(() => remoteRunTokenFile(ROOT, '../x')).toThrow(RemoteRuntimeError);
    expect(() => remoteRunTokenFile(ROOT, 'a/b')).toThrow(RemoteRuntimeError);
  });
});

describe('RemoteRuntime.prepare gates', () => {
  const expectCode = async (p: Promise<unknown>, code: string): Promise<void> => {
    const err = await p.then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteRuntimeError);
    expect((err as RemoteRuntimeError).code).toBe(code);
    expect((err as Error).message.length).toBeGreaterThan(10);
  };

  it('Environments off → HostsDisabledError; remote kill switch → RemoteHostsDisabledError', async () => {
    const h = harness();
    h.hostsState.running = false;
    await expect(h.rt.prepare('h1', { runId: 'r1', spawnKey: 'r1' })).rejects.toBeInstanceOf(HostsDisabledError);
    h.hostsState.running = true;
    h.hostsState.killed = true;
    await expect(h.rt.prepare('h1', { runId: 'r1', spawnKey: 'r1' })).rejects.toBeInstanceOf(RemoteHostsDisabledError);
    expect(h.calls).toEqual([]);
    expect(h.link.acquires).toBe(0);
  });

  it('orch socket auth turned off → orch-auth-disabled', async () => {
    const h = harness();
    h.env.CYBOFLOW_DISABLE_ORCH_SOCK_AUTH = '1';
    await expectCode(h.rt.prepare('h1', { runId: 'r1', spawnKey: 'r1' }), 'orch-auth-disabled');
  });

  it('This Mac / unknown / archived / not ssh', async () => {
    const h = harness();
    await expectCode(h.rt.prepare('local', { runId: 'r1', spawnKey: 'r1' }), 'not-remote');
    await expect(h.rt.prepare('h2', { runId: 'r1', spawnKey: 'r1' })).rejects.toBeInstanceOf(HostNotFoundError);
    h.hostsState.view = { id: 'h1', kind: 'ssh', archivedAt: '2026-10-22T00:00:00Z', remoteReady: true, preflight: preflight() };
    await expectCode(h.rt.prepare('h1', { runId: 'r1', spawnKey: 'r1' }), 'archived');
    h.hostsState.view = { id: 'h1', kind: 'local', archivedAt: null, remoteReady: false, preflight: null };
    await expectCode(h.rt.prepare('h1', { runId: 'r1', spawnKey: 'r1' }), 'not-remote');
  });

  it('no complete check / no facts → needs-check', async () => {
    const h = harness();
    h.hostsState.view = { id: 'h1', kind: 'ssh', archivedAt: null, remoteReady: false, preflight: null };
    await expectCode(h.rt.prepare('h1', { runId: 'r1', spawnKey: 'r1' }), 'needs-check');
    h.hostsState.view = { id: 'h1', kind: 'ssh', archivedAt: null, remoteReady: false, preflight: preflight({ remote: undefined }) };
    await expectCode(h.rt.prepare('h1', { runId: 'r1', spawnKey: 'r1' }), 'needs-check');
    h.hostsState.view = { id: 'h1', kind: 'ssh', archivedAt: null, remoteReady: false, preflight: preflight({ probeComplete: false }) };
    await expectCode(h.rt.prepare('h1', { runId: 'r1', spawnKey: 'r1' }), 'needs-check');
  });

  it('tools not installed (remoteReady false, no hash) → not-installed', async () => {
    const h = harness();
    h.hostsState.view = { id: 'h1', kind: 'ssh', archivedAt: null, remoteReady: false, preflight: preflight() };
    await expectCode(h.rt.prepare('h1', { runId: 'r1', spawnKey: 'r1' }), 'not-installed');
    h.hostsState.view = { id: 'h1', kind: 'ssh', archivedAt: null, remoteReady: true, preflight: preflight({ toolchainHash: null }) };
    await expectCode(h.rt.prepare('h1', { runId: 'r1', spawnKey: 'r1' }), 'not-installed');
  });

  it('no node → no-node', async () => {
    const h = harness();
    h.hostsState.view = {
      id: 'h1', kind: 'ssh', archivedAt: null, remoteReady: true, preflight: preflight({ remote: { ...REMOTE, nodePath: null } }),
    };
    await expectCode(h.rt.prepare('h1', { runId: 'r1', spawnKey: 'r1' }), 'no-node');
  });

  it('a missing or mismatched remote manifest → not-installed (and is re-read on the next try)', async () => {
    let manifest: string | null = null;
    const h = harness({ answer: (argv) => (argv.some((a) => a.endsWith('/manifest.json'))
      ? (manifest === null ? { code: 1, stderr: 'No such file' } : { stdout: manifest })
      : {}) });
    await expectCode(h.rt.prepare('h1', { runId: 'r1', spawnKey: 'r1' }), 'not-installed');
    manifest = JSON.stringify({ hash: 'b'.repeat(64), codexTarget: null });
    await expectCode(h.rt.prepare('h1', { runId: 'r1', spawnKey: 'r1' }), 'not-installed');
    manifest = JSON.stringify({ hash: HASH, codexTarget: '../evil' });
    await expectCode(h.rt.prepare('h1', { runId: 'r1', spawnKey: 'r1' }), 'not-installed');
    manifest = JSON.stringify({ hash: HASH, codexTarget: null });
    const s = await h.rt.prepare('h1', { runId: 'r1', spawnKey: 'r1' });
    expect(s.paths.codexBin).toBeNull();
    expect(s.codexAvailable).toBe(false);
    expect(h.link.acquires).toBe(1);
  });

  it('link unavailable → link-down, no token written; linkFor gate errors propagate', async () => {
    const h = harness();
    h.link.fail = new Error('The link to this environment is down.');
    await expectCode(h.rt.prepare('h1', { runId: 'r1', spawnKey: 'r1' }), 'link-down');
    expect(h.mint).not.toHaveBeenCalled();
    expect(h.link.releases).toBe(0);
    h.link.fail = null;
    h.hostsState.linkForThrows = new RemoteHostsDisabledError();
    await expect(h.rt.prepare('h1', { runId: 'r1', spawnKey: 'r1' })).rejects.toBeInstanceOf(RemoteHostsDisabledError);
  });

  it('a failed token write releases the link and reports token-write; a retry writes again', async () => {
    let failWrite = true;
    const h = harness({ answer: (argv) => {
      if (argv.some((a) => a.endsWith('/manifest.json'))) return { stdout: MANIFEST };
      if (failWrite && argv.some((a) => a.endsWith('.token'))) return { code: 1, stderr: 'disk full' };
      return {};
    } });
    await expectCode(h.rt.prepare('h1', { runId: 'r1', spawnKey: 'r1' }), 'token-write');
    expect(h.link.acquires).toBe(1);
    expect(h.link.releases).toBe(1);
    failWrite = false;
    await h.rt.prepare('h1', { runId: 'r1', spawnKey: 'r1' });
    expect(h.calls.filter((c) => c.argv.some((a) => a.endsWith('/r1.token')))).toHaveLength(2);
  });
});

describe('RemoteRuntime.prepare success', () => {
  it('acquires the link, writes the 0600 token once per run over stdin (never argv), returns a complete session', async () => {
    const h = harness();
    const s = await h.rt.prepare('h1', { runId: 'run-1', spawnKey: 'run-1:task-2' });

    expect(h.link.acquires).toBe(1);
    expect(s.hostId).toBe('h1');
    expect(s.remoteRoot).toBe(ROOT);
    expect(s.remoteSock).toBe(`${ROOT}/s/o.sock`);
    expect(s.tokenFile).toBe(`${ROOT}/run/run-1.token`);
    expect(s.spawnKey).toBe(remoteSpawnKey('run-1:task-2'));
    expect(s.codexAvailable).toBe(true);
    expect(s.paths).toEqual({
      claude: `${ROOT}/toolchain/${HASH}/claude`,
      mcpBundle: `${ROOT}/toolchain/${HASH}/cyboflowMcpServer.js`,
      codexBin: `${ROOT}/toolchain/${HASH}/codex/aarch64-apple-darwin/bin/codex`,
      codexPathDir: `${ROOT}/toolchain/${HASH}/codex/aarch64-apple-darwin/codex-path`,
      nodePath: '/opt/homebrew/bin/node',
      gitPath: '/usr/bin/git',
    });
    expect(s.artifactsDir('run-1')).toBe(`${ROOT}/artifacts/runs/run-1`);
    expect(s.remotePath()).toBe(`${ROOT}/toolchain/${HASH}/codex/aarch64-apple-darwin/codex-path:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`);

    // run dir created, chmod 700 (no `--`), then the token via writeFile with mode 600 and the token on stdin only.
    const mkdir = h.calls.find((c) => c.argv[2]?.includes('mkdir -p'));
    expect(mkdir?.argv).toContain(`${ROOT}/run`);
    const chmod = h.calls.find((c) => c.argv[0] === 'chmod');
    expect(chmod?.argv).toEqual(['chmod', '700', `${ROOT}/run`]);
    const write = h.calls.find((c) => c.argv.includes(`${ROOT}/run/run-1.token`));
    expect(write?.argv).toContain('600');
    expect(write?.opts?.stdin).toBe(`${TOKEN}\n`);
    expect(h.mint).toHaveBeenCalledWith('run-1');
    expect(allArgv(h.calls)).not.toContain(TOKEN);

    // A second prepare for the same run (another lane) re-acquires the link but does not rewrite the token.
    const writesBefore = h.calls.filter((c) => c.argv.includes(`${ROOT}/run/run-1.token`)).length;
    const manifestReadsBefore = h.calls.filter((c) => c.argv.some((a) => a.endsWith('/manifest.json'))).length;
    const s2 = await h.rt.prepare('h1', { runId: 'run-1', spawnKey: 'run-1:task-3' });
    expect(h.link.acquires).toBe(2);
    expect(h.calls.filter((c) => c.argv.includes(`${ROOT}/run/run-1.token`))).toHaveLength(writesBefore);
    expect(h.calls.filter((c) => c.argv.some((a) => a.endsWith('/manifest.json')))).toHaveLength(manifestReadsBefore);
    // A different run writes its own file.
    await h.rt.prepare('h1', { runId: 'run-2', spawnKey: 'run-2' });
    expect(h.calls.filter((c) => c.argv.includes(`${ROOT}/run/run-2.token`))).toHaveLength(1);

    s.release();
    s.release();
    expect(h.link.releases).toBe(1);
    expect(s.released).toBe(true);
    s2.release();
    expect(h.link.releases).toBe(2);
  });

  it('env() is the remote allowlist: drops CYBOFLOW_ORCH_TOKEN and local noise, sets the token FILE + remote socket', async () => {
    const h = harness();
    const s = await h.rt.prepare('h1', { runId: 'run-1', spawnKey: 'run-1' });
    const env = s.env({
      CYBOFLOW_ORCH_TOKEN: TOKEN,
      CYBOFLOW_ORCH_SOCKET: '/Users/local/.cyboflow/sockets/orch.sock',
      CYBOFLOW_RUN_ID: 'run-1',
      CYBOFLOW_WORKTREE: '/Users/local/wt/run-1/src',
      LANE_SLOT: '/Users/local/wt/run-1/.slot',
      ELECTRON_RUN_AS_NODE: '1',
      AWS_SECRET_ACCESS_KEY: 'nope',
      PATH: '/local/bin',
      HOME: '/Users/local',
    }, {
      extraKeys: ['LANE_SLOT'],
      pathMap: [{ from: '/Users/local/wt/run-1', to: '/Users/me/cf-remote/h1/wt/run-1' }],
      artifactsDir: s.artifactsDir('run-1'),
    });
    expect(env).toEqual({
      HOME: '/Users/me',
      USER: 'me',
      LOGNAME: 'me',
      SHELL: '/bin/zsh',
      TMPDIR: '/tmp/x',
      LANG: 'en_US.UTF-8',
      TERM: 'dumb',
      PATH: s.remotePath(),
      CYBOFLOW_RUN_ID: 'run-1',
      CYBOFLOW_WORKTREE: '/Users/me/cf-remote/h1/wt/run-1/src',
      LANE_SLOT: '/Users/me/cf-remote/h1/wt/run-1/.slot',
      CYBOFLOW_ORCH_SOCKET: `${ROOT}/s/o.sock`,
      CYBOFLOW_ORCH_TOKEN_FILE: `${ROOT}/run/run-1.token`,
      CYBOFLOW_RUN_ARTIFACTS_DIR: `${ROOT}/artifacts/runs/run-1`,
    });
    expect(JSON.stringify(env)).not.toContain(TOKEN);
  });

  it('spawn() runs on the host with a filename-safe key, keeps the token off the command, and refuses after release', async () => {
    const h = harness();
    const s = await h.rt.prepare('h1', { runId: 'run-1', spawnKey: 'run-1:lane' });
    const proc = s.spawn(
      { command: s.paths.claude, args: ['--print'], cwd: '/Users/me/cf-remote/h1/wt/run-1', env: s.env({ CYBOFLOW_ORCH_TOKEN: TOKEN }), withTokenEnvFile: true },
      { releaseOnExit: true },
    );
    expect(proc.pid).toBeUndefined();
    expect(h.streams).toHaveLength(1);
    expect(h.streams[0]).toContain(SPAWN_WRAPPER.slice(0, 20));
    expect(h.streams[0]).toMatch(new RegExp(`${ROOT}/run/${s.spawnKey}\\.[0-9a-f]{16}\\.pid`));
    expect(h.streams[0]).not.toContain(TOKEN);
    expect(h.streams[0]).not.toContain('CYBOFLOW_ORCH_TOKEN_FILE');
    proc.emit('exit', 0, null);
    expect(s.released).toBe(true);
    expect(h.link.releases).toBe(1);
    expect(() => s.spawn({ command: 'x', args: [] })).toThrow(RemoteRuntimeError);
    expect(s.fs).toBeDefined();
    expect(s.git).toBeDefined();
  });
});

describe('RemoteRuntime.removeRunToken', () => {
  it('a host generation bump (target change / archive) forgets the token write and the manifest read', async () => {
    const h = harness();
    const tokenWrites = () => h.calls.filter((c) => c.argv.includes(`${ROOT}/run/run-1.token`) && c.opts?.stdin === `${TOKEN}\n`).length;
    const manifestReads = () => h.calls.filter((c) => c.argv.some((a) => a.endsWith('/manifest.json'))).length;
    const s1 = await h.rt.prepare('h1', { runId: 'run-1', spawnKey: 'run-1' });
    expect(s1.generation).toBe(0);
    await h.rt.prepare('h1', { runId: 'run-1', spawnKey: 'run-1' });
    expect(tokenWrites()).toBe(1);
    expect(manifestReads()).toBe(1);
    h.hostsState.generation = 1;
    const s2 = await h.rt.prepare('h1', { runId: 'run-1', spawnKey: 'run-1' });
    expect(s2.generation).toBe(1);
    expect(tokenWrites()).toBe(2);
    expect(manifestReads()).toBe(2);
  });

  it('unlinks the token file, forgets it (next prepare rewrites), and never throws', async () => {
    const h = harness();
    await h.rt.prepare('h1', { runId: 'run-1', spawnKey: 'run-1' });
    await h.rt.removeRunToken('h1', 'run-1');
    const unlink = h.calls.find((c) => c.argv[2]?.includes('rm -f') && c.argv.includes(`${ROOT}/run/run-1.token`));
    expect(unlink).toBeDefined();
    await h.rt.prepare('h1', { runId: 'run-1', spawnKey: 'run-1' });
    expect(h.calls.filter((c) => c.argv.includes(`${ROOT}/run/run-1.token`) && c.opts?.stdin === `${TOKEN}\n`)).toHaveLength(2);

    await expect(h.rt.removeRunToken('h2', 'run-1')).resolves.toBeUndefined();
    await expect(h.rt.removeRunToken('local', 'run-1')).resolves.toBeUndefined();
    await expect(h.rt.removeRunToken('h1', '../x')).resolves.toBeUndefined();
  });
});

describe('remoteRuntimeBridge', () => {
  afterEach(() => setRemoteRuntime(null));

  it('get/set/require', () => {
    expect(getRemoteRuntime()).toBeNull();
    expect(() => requireRemoteRuntime()).toThrow(RemoteRuntimeNotComposedError);
    const h = harness();
    setRemoteRuntime(h.rt);
    expect(getRemoteRuntime()).toBe(h.rt);
    expect(requireRemoteRuntime()).toBe(h.rt);
    setRemoteRuntime(null);
    expect(getRemoteRuntime()).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Phase F: fence (F1), run teardown (F2), run dir GC (F3)
// ---------------------------------------------------------------------------------------------------------------

function runsDb(rows: Array<{ id: string; host_id: string | null; status: string }>): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, host_id TEXT, status TEXT); CREATE TABLE sessions (id TEXT PRIMARY KEY, host_id TEXT)');
  const ins = db.prepare('INSERT INTO workflow_runs (id, host_id, status) VALUES (?, ?, ?)');
  for (const r of rows) ins.run(r.id, r.host_id, r.status);
  return db;
}

describe('RemoteRuntime.onSessionEnded', () => {
  function sessionRunsDb(): Database.Database {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, host_id TEXT, status TEXT, session_id TEXT)');
    const ins = db.prepare('INSERT INTO workflow_runs (id, host_id, status, session_id) VALUES (?, ?, ?, ?)');
    ins.run('run-done', 'h1', 'completed', 's1');
    ins.run('run-cxl', 'h1', 'canceled', 's1');
    ins.run('run-live', 'h1', 'running', 's1');
    ins.run('run-other', 'h1', 'completed', 's2');
    return db;
  }
  const tokenRemoved = (h: ReturnType<typeof harness>, runId: string): boolean =>
    h.calls.some((c) => c.argv[2]?.includes('rm -f') && c.argv.includes(`${ROOT}/run/${runId}.token`));

  it("cleans the token of each of the session's finished runs, never an active run or another session's", async () => {
    const h = harness({ db: sessionRunsDb() });
    await h.rt.onSessionEnded('s1', 'h1');
    expect(tokenRemoved(h, 'run-done')).toBe(true);
    expect(tokenRemoved(h, 'run-cxl')).toBe(true);
    expect(tokenRemoved(h, 'run-live')).toBe(false);
    expect(tokenRemoved(h, 'run-other')).toBe(false);
  });

  it('a local host id or a broken db touches nothing and never rejects', async () => {
    const h = harness({ db: sessionRunsDb() });
    await h.rt.onSessionEnded('s1', 'local');
    expect(h.calls).toHaveLength(0);
    const broken = harness({ db: new Database(':memory:') });
    await expect(broken.rt.onSessionEnded('s1', 'h1')).resolves.toBeUndefined();
  });
});

describe('RemoteRuntimeSession.fence (F1)', () => {
  it("runs the fixed fence program for the session's filename-safe key over the host exec, bounded", async () => {
    const h = harness({
      answer: (argv) => (argv[2] === FENCE_PROGRAM ? { stdout: '1 0 2\n' } : manifestAnswer(argv)),
    });
    const s = await h.rt.prepare('h1', { runId: 'run-1', spawnKey: 'run-1:lane-a' });
    const out = await s.fence?.();
    expect(out).toEqual({ termed: 1, killed: 0, stale: 2 });
    const call = h.calls.find((c) => c.argv[2] === FENCE_PROGRAM);
    expect(call?.argv).toEqual(fenceArgv(ROOT, remoteSpawnKey('run-1:lane-a')));
    expect(call?.opts?.timeoutMs).toBe(4_500);
    // The fence never carries the token or touches the link.
    expect(allArgv(h.calls)).not.toContain(TOKEN);
    expect(h.link.releases).toBe(0);
  });

  it('never rejects: an ssh failure resolves null and the session still spawns', async () => {
    const h = harness({
      answer: (argv) => (argv[2] === FENCE_PROGRAM ? { code: 255, stderr: 'Connection closed' } : manifestAnswer(argv)),
    });
    const s = await h.rt.prepare('h1', { runId: 'run-1', spawnKey: 'run-1' });
    await expect(s.fence?.()).resolves.toBeNull();
    await expect(s.fence?.('')).resolves.toBeNull();
    expect(() => s.spawn({ command: '/x/claude', args: [] })).not.toThrow();
  });
});

describe('RemoteRuntime.onRunTerminal (F2)', () => {
  it('a remote run: removes the token (and forgets it) and reaps the run\'s dead pidfiles', async () => {
    const h = harness({ db: runsDb([{ id: 'run-1', host_id: 'h1', status: 'completed' }]) });
    await h.rt.prepare('h1', { runId: 'run-1', spawnKey: 'run-1' });
    await h.rt.onRunTerminal('run-1');
    expect(h.calls.some((c) => c.argv[2]?.includes('rm -f') && c.argv.includes(`${ROOT}/run/run-1.token`))).toBe(true);
    const reap = h.calls.find((c) => c.argv[2] === RUN_REAP_PROGRAM);
    expect(reap?.argv.slice(4)).toEqual([`${ROOT}/run`, 'run-1.*.pid', 'run-1-*.pid', 'run-1_*.pid']);
    // Forgotten: a reopened run's next prepare writes the token again.
    await h.rt.prepare('h1', { runId: 'run-1', spawnKey: 'run-1' });
    expect(h.calls.filter((c) => c.argv.includes(`${ROOT}/run/run-1.token`) && c.opts?.stdin === `${TOKEN}\n`)).toHaveLength(2);
  });

  it('a local / unknown run touches nothing; failures never reject', async () => {
    const h = harness({ db: runsDb([{ id: 'loc', host_id: null, status: 'failed' }, { id: 'lc', host_id: 'local', status: 'failed' }]) });
    await h.rt.onRunTerminal('loc');
    await h.rt.onRunTerminal('lc');
    await h.rt.onRunTerminal('missing');
    await h.rt.onRunTerminal('run-1', 'local');
    expect(h.calls).toHaveLength(0);
    await expect(h.rt.onRunTerminal('run-1', 'h2')).resolves.toBeUndefined();
    const broken = harness({ db: new Database(':memory:') }); // no tables: the lookup throws
    await expect(broken.rt.onRunTerminal('run-1')).resolves.toBeUndefined();
  });

  it('subscribes to run-terminal events and acts only while published and Environments run', async () => {
    let listener: ((runId: string) => void) | null = null;
    const unsubscribe = vi.fn();
    let published = false;
    const h = harness({
      db: runsDb([{ id: 'run-1', host_id: 'h1', status: 'canceled' }, { id: 'loc', host_id: null, status: 'canceled' }]),
      rtDeps: {
        runTerminalEvents: (l) => {
          listener = l;
          return unsubscribe;
        },
        isPublished: () => published,
      },
    });
    const fire = async (runId: string): Promise<void> => {
      (listener as unknown as (id: string) => void)(runId);
      await new Promise((r) => setTimeout(r, 0));
    };
    await fire('run-1');
    expect(h.calls).toHaveLength(0); // not published
    published = true;
    h.hostsState.running = false;
    await fire('run-1');
    expect(h.calls).toHaveLength(0); // Environments off
    h.hostsState.running = true;
    await fire('loc');
    expect(h.calls).toHaveLength(0); // local run
    await fire('run-1');
    expect(h.calls.some((c) => c.argv[2] === RUN_REAP_PROGRAM)).toBe(true);
    h.rt.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('by default it acts only while it is the runtime published on the bridge', async () => {
    let listener: ((runId: string) => void) | null = null;
    const h = harness({
      db: runsDb([{ id: 'run-1', host_id: 'h1', status: 'completed' }]),
      rtDeps: { runTerminalEvents: (l) => { listener = l; return () => undefined; } },
    });
    const fire = async (): Promise<void> => {
      (listener as unknown as (id: string) => void)('run-1');
      await new Promise((r) => setTimeout(r, 0));
    };
    try {
      await fire();
      expect(h.calls).toHaveLength(0);
      setRemoteRuntime(h.rt);
      await fire();
      expect(h.calls.some((c) => c.argv[2] === RUN_REAP_PROGRAM)).toBe(true);
    } finally {
      setRemoteRuntime(null);
    }
  });
});

describe('RemoteRuntime.gcRunDir (F3)', () => {
  it('removes only tokens of runs that are not active, forgetting their writes first', async () => {
    const h = harness({
      db: runsDb([
        { id: 'done', host_id: 'h1', status: 'completed' },
        { id: 'live', host_id: 'h1', status: 'running' },
        { id: 'paused', host_id: 'h1', status: 'paused' },
      ]),
      answer: (argv) => {
        if (argv[2] === RUN_DIR_GC_PROGRAM) return { stdout: 'done.token\nlive.token\npaused.token\ngone.token\n#2\n' };
        if (argv[2] === TOKEN_REMOVE_PROGRAM) return { stdout: '2\n' };
        return manifestAnswer(argv);
      },
    });
    await h.rt.prepare('h1', { runId: 'done', spawnKey: 'done' });
    const out = await h.rt.gcRunDir('h1', ROOT);
    expect(out).toEqual({ removed: 2, tokensRemoved: 2, tokensKept: 2 });
    const remove = h.calls.find((c) => c.argv[2] === TOKEN_REMOVE_PROGRAM);
    expect(remove?.argv.slice(4)).toEqual([`${ROOT}/run`, 'done.token', 'gone.token']);
    await h.rt.prepare('h1', { runId: 'done', spawnKey: 'done' });
    expect(h.calls.filter((c) => c.argv.includes(`${ROOT}/run/done.token`) && c.opts?.stdin === `${TOKEN}\n`)).toHaveLength(2);
    expect(await h.rt.gcRunDir('local')).toBeNull();
    expect(await h.rt.gcRunDir('h2')).toBeNull();
  });

  it('fails closed: a db that cannot answer keeps every token', async () => {
    const h = harness({
      db: new Database(':memory:'),
      answer: (argv) => (argv[2] === RUN_DIR_GC_PROGRAM ? { stdout: 'x.token\n#0\n' } : {}),
    });
    expect(await h.rt.gcRunDir('h1')).toEqual({ removed: 0, tokensRemoved: 0, tokensKept: 1 });
    expect(h.calls.some((c) => c.argv[2] === TOKEN_REMOVE_PROGRAM)).toBe(false);
  });
});
