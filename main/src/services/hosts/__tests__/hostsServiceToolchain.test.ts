/**
 * HostsService M2 surfaces (spec A5/A6): the preflight extras (expected toolchain + link handle), the
 * "Install cyboflow tools" action (gates, coalescing, progress, telemetry, follow-up preflight) and the prelaunch
 * gate (reuse window, judges, never persisted). Real HostStore on in-memory SQLite; fake hosts / toolchain / link.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dbAdapter } from '../../../orchestrator/__test_fixtures__/dbAdapter';
import { HostStore } from '../../../orchestrator/hosts/hostStore';
import {
  HOSTS_CHANNEL,
  hostEvents,
  hostPreflightChannel,
  hostToolchainChannel,
} from '../../../orchestrator/hostsBridge';
import {
  HOSTS_ERROR_NAMES,
  PREFLIGHT_CHECK_IDS,
  type CheckStatus,
  type PreflightCheckId,
  type PreflightCheckResult,
  type PreflightRemoteFacts,
  type PreflightResult,
  type ToolchainProgressEvent,
} from '../../../../../shared/types/hosts';
import type { ExecutionHost } from '../../../orchestrator/trpc/contracts/executionHost';
import { CHECK_TIER_IMPACT } from '../preflight/checks';
import {
  HostsService,
  expectedFromManifest,
  judgeFullPreflight,
  judgePrelaunchPreflight,
  type HostLinksDeps,
  type HostsToolchainDeps,
  type HostTerminalsLike,
} from '../hostsService';
import type { ForwardHandle, ForwardSpec } from '../sshTransport';
import { ToolchainPushError, type PushToolchainInput } from '../toolchain/toolchainPusher';
import type { ResolvedToolchainSources } from '../toolchain/toolchainResolver';
import { ToolchainUnavailableError, type ToolchainArch, type ToolchainManifest } from '../toolchain/types';
import { REMOTE_HOSTS_KILL_SWITCH_ENV } from '../flags';
import type { LoggerLike } from '../../../orchestrator/types';

const SQL = readFileSync(join(__dirname, '..', '..', '..', 'database', 'migrations', '152_hosts.sql'), 'utf-8');
const HASH = '9'.repeat(64);
const FINISHED = '2026-10-09T12:00:05.000Z';
const REMOTE: PreflightRemoteFacts = {
  home: '/Users/k', remoteRoot: '/Users/k/cf-remote/h1', user: 'k', logname: 'k', shell: '/bin/zsh', tmpdir: '/tmp',
  lang: 'en_US.UTF-8', nodePath: '/opt/homebrew/bin/node', gitPath: '/usr/bin/git', codexPath: null, arch: 'arm64',
  socketPathOk: true,
};
const MANIFEST: ToolchainManifest = {
  layout: 1, hash: HASH, arch: 'arm64', claudeVersion: '2.1.0', codexVersion: '0.159.2', codexTarget: 'aarch64-apple-darwin',
  files: [
    { rel: 'claude', sha256: '1'.repeat(64), size: 10, mode: 0o755 },
    { rel: 'codex/aarch64-apple-darwin/bin/codex', sha256: '2'.repeat(64), size: 30, mode: 0o755 },
    { rel: 'codex/aarch64-apple-darwin/codex-path/rg', sha256: '3'.repeat(64), size: 5, mode: 0o755 },
    { rel: 'cyboflowMcpServer.js', sha256: '4'.repeat(64), size: 20, mode: 0o644 },
  ],
};

function check(id: PreflightCheckId, status: CheckStatus, detail = `${id} ${status}`): PreflightCheckResult {
  return { id, label: id, status, detail, tierImpact: CHECK_TIER_IMPACT[id], durationMs: 1 };
}

/** A complete full result; `fullTier` = every check passes with both SDK runtimes present. */
function result(hostId: string, over: Partial<PreflightResult> = {}, statuses: Partial<Record<PreflightCheckId, CheckStatus>> = {}): PreflightResult {
  return {
    hostId, mode: 'full', startedAt: '2026-10-09T12:00:00.000Z', finishedAt: FINISHED,
    results: PREFLIGHT_CHECK_IDS.map((id) => check(id, statuses[id] ?? 'pass')),
    reachable: true, probeComplete: true, detectedTier: 'full',
    runtimes: { claudeSdk: true, codexSdk: true, claudeCli: true, codexCli: false },
    arch: 'arm64', osVersion: 'macOS 15.1', toolchainHash: HASH, appVersion: '1.0.0', remote: REMOTE, ...over,
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakeHost(id: string) {
  const runs: Array<{ mode: PreflightResult['mode']; d: Deferred<PreflightResult>; signal?: AbortSignal }> = [];
  const host = {
    info: { id, kind: 'ssh', label: id },
    preflight: vi.fn((mode: PreflightResult['mode'], _onCheck?: (r: PreflightCheckResult) => void, signal?: AbortSignal) => {
      const d = deferred<PreflightResult>();
      runs.push({ mode, d, signal });
      return d.promise;
    }),
  } as unknown as ExecutionHost & { preflight: ReturnType<typeof vi.fn> };
  return { host, runs };
}

const terminals: HostTerminalsLike = {
  open: vi.fn(() => 't'), write: vi.fn(), resize: vi.fn(), getBacklog: vi.fn(() => ({ backlog: '', exited: true, exitCode: null })),
  closeOne: vi.fn(), closeForHost: vi.fn(), destroyAll: vi.fn(), listOwnedShells: vi.fn(() => []),
};

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

class ReadyForward implements ForwardHandle {
  readonly ready = Promise.resolve();
  exited = false;
  constructor(readonly spec: ForwardSpec) {}
  close(): void {
    this.exited = true;
  }
  on(): void {
    /* never exits on its own */
  }
}

let raw: Database.Database;
let store: HostStore;
let hosts: Map<string, ReturnType<typeof fakeHost>>;
let env: NodeJS.ProcessEnv;
let enabled: boolean;
let logger: LoggerLike;
let captureError: ReturnType<typeof vi.fn>;
let toolchain: HostsToolchainDeps & {
  resolveSources: ReturnType<typeof vi.fn>;
  buildManifest: ReturnType<typeof vi.fn>;
  push: ReturnType<typeof vi.fn>;
};
let forwards: ReadyForward[];
let service: HostsService;
let progress: ToolchainProgressEvent[];
let ids = 0;

function hostFor(id: string): ReturnType<typeof fakeHost> {
  let h = hosts.get(id);
  if (!h) {
    h = fakeHost(id);
    hosts.set(id, h);
  }
  return h;
}

function resolved(arch: ToolchainArch): ResolvedToolchainSources {
  return { arch, claudePath: '/x/claude', claudeVersion: null, mcpBundlePath: '/x/mcp.js', codex: null, codexUnavailableReason: null };
}

function makeService(over: { toolchain?: HostsToolchainDeps | null; links?: HostLinksDeps | null } = {}): HostsService {
  const links: HostLinksDeps = {
    transport: { openForward: (_t, spec) => { const f = new ReadyForward(spec); forwards.push(f); return f; } },
    getOrchSocketPath: () => '/Users/me/.cyboflow/sockets/orch.sock',
    timers: { setTimer: () => () => undefined },
  };
  return new HostsService({
    store,
    registry: { get: vi.fn((id: string) => hostFor(id).host), invalidate: vi.fn(), closeAllMasters: vi.fn() },
    terminals,
    appVersion: '1.0.0',
    isAvailable: () => true,
    isEnabled: () => enabled,
    env,
    logger,
    captureError,
    ...(over.links === null ? {} : { links: over.links ?? links }),
    ...(over.toolchain === null ? {} : { toolchain: over.toolchain ?? toolchain }),
  });
}

const onProgress = (e: ToolchainProgressEvent): void => { progress.push(e); };

beforeEach(() => {
  raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  raw.exec(`CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
            CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT);
            CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, status TEXT);`);
  raw.exec(SQL);
  store = new HostStore(dbAdapter(raw), { newId: () => `h${++ids}` });
  hosts = new Map();
  env = {};
  enabled = true;
  logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  captureError = vi.fn();
  forwards = [];
  progress = [];
  toolchain = {
    resolveSources: vi.fn((arch: ToolchainArch) => resolved(arch)),
    buildManifest: vi.fn(async (_r: ResolvedToolchainSources, opts?: { onHashProgress?: (d: number, t: number) => void }) => {
      opts?.onHashProgress?.(30, 65);
      return { manifest: MANIFEST, sources: [] };
    }),
    push: vi.fn(async (input: PushToolchainInput) => {
      input.onProgress?.({ hostId: input.hostId, phase: 'uploading', bytesSent: 40, bytesTotal: 65 });
      input.onProgress?.({ hostId: input.hostId, phase: 'done', bytesSent: 65, bytesTotal: 65 });
      return { hash: HASH, dir: '/d', alreadyInstalled: false, removed: [] };
    }),
    transport: { exec: vi.fn(), pushStream: vi.fn() },
  };
  service = makeService();
});

afterEach(() => {
  hostEvents.removeAllListeners();
  raw.close();
});

/** addSsh, then settle the kicked background preflight with `r`. */
async function addWith(r: (id: string) => PreflightResult): Promise<string> {
  const { id } = await service.addSsh({ label: `Box${ids}`, sshTarget: 'box' });
  await flush();
  hostFor(id).runs[0].d.resolve(r(id));
  await flush();
  await store._queue().onIdle();
  return id;
}

describe('pure judges', () => {
  it('judgeFullPreflight: reachable → installed → signed in → tier (link-down) → runtime', () => {
    expect(judgeFullPreflight(result('h'), null, 'claude-sdk')).toEqual({ ok: true });
    expect(judgeFullPreflight(result('h', { reachable: false }, { 'ssh-reachable': 'fail' }), null, 'claude-sdk'))
      .toMatchObject({ ok: false, code: 'unreachable' });
    expect(judgeFullPreflight(result('h', { probeComplete: false }), null, 'claude-sdk')).toMatchObject({ code: 'unreachable' });
    expect(judgeFullPreflight(result('h', {}, { 'sdk-binary-hash': 'warn' }), null, 'claude-sdk')).toMatchObject({ code: 'not-installed' });
    expect(judgeFullPreflight(result('h', {}, { 'claude-auth': 'fail' }), null, 'claude-sdk')).toMatchObject({ code: 'no-auth' });
    expect(judgeFullPreflight(result('h', {}, { 'claude-auth': 'fail' }), null, 'codex-sdk')).toEqual({ ok: true });
    expect(judgeFullPreflight(result('h', {}, { 'codex-auth': 'warn' }), null, 'codex-sdk')).toMatchObject({ code: 'no-auth' });
    expect(judgeFullPreflight(result('h', { detectedTier: 'cli' }, { 'mcp-roundtrip': 'fail' }), null, 'claude-sdk'))
      .toMatchObject({ code: 'link-down' });
    expect(judgeFullPreflight(result('h', { detectedTier: 'cli' }, { 'repo-root-tcc': 'fail' }), null, 'claude-sdk'))
      .toMatchObject({ code: 'tier' });
    expect(judgeFullPreflight(result('h'), 'cli', 'claude-sdk')).toMatchObject({ code: 'tier', reason: expect.stringMatching(/limited to terminals/) });
    expect(judgeFullPreflight(result('h', { runtimes: { claudeSdk: true, codexSdk: false, claudeCli: true, codexCli: false } }), null, 'codex-sdk'))
      .toMatchObject({ code: 'runtime-unavailable' });
  });

  it('judgePrelaunchPreflight: reach → in time → installed → node → sign-in (claude only) → link', () => {
    const pre = (statuses: Partial<Record<PreflightCheckId, CheckStatus>>, over: Partial<PreflightResult> = {}) =>
      result('h', { mode: 'prelaunch', detectedTier: null, ...over }, statuses);
    expect(judgePrelaunchPreflight(pre({}), 'claude-sdk')).toEqual({ ok: true });
    expect(judgePrelaunchPreflight(pre({ 'ssh-reachable': 'skipped' }, { reachable: false }), 'claude-sdk')).toMatchObject({ code: 'unreachable' });
    expect(judgePrelaunchPreflight(pre({}, { probeComplete: false }), 'claude-sdk')).toMatchObject({ code: 'unreachable' });
    expect(judgePrelaunchPreflight(pre({ 'sdk-binary-hash': 'warn' }), 'claude-sdk')).toMatchObject({ code: 'not-installed' });
    expect(judgePrelaunchPreflight(pre({ node22: 'fail' }), 'claude-sdk')).toMatchObject({ code: 'runtime-unavailable' });
    expect(judgePrelaunchPreflight(pre({ 'claude-auth': 'warn' }), 'claude-sdk')).toMatchObject({ code: 'no-auth' });
    expect(judgePrelaunchPreflight(pre({ 'claude-auth': 'warn' }), 'codex-sdk')).toEqual({ ok: true });
    expect(judgePrelaunchPreflight(pre({ 'mcp-roundtrip': 'fail' }), 'claude-sdk')).toMatchObject({ code: 'link-down' });
  });

  it('expectedFromManifest keeps the three sized files and flags codex', () => {
    expect(expectedFromManifest(MANIFEST)).toEqual({
      expectedHash: HASH,
      files: [
        { rel: 'claude', size: 10 }, { rel: 'codex/aarch64-apple-darwin/bin/codex', size: 30 }, { rel: 'cyboflowMcpServer.js', size: 20 },
      ],
      codexIncluded: true,
      unavailableReason: null,
    });
    expect(expectedFromManifest({ ...MANIFEST, codexTarget: null, files: MANIFEST.files.filter((f) => !f.rel.startsWith('codex')) }).codexIncluded)
      .toBe(false);
  });
});

describe('preflightExtras', () => {
  it('expected toolchain for the stored arch, a link handle, and the node path for prelaunch', async () => {
    const id = await addWith((h) => result(h));
    const full = await service.preflightExtras(id, 'full');
    expect(full.toolchain?.archHint).toBe('arm64');
    expect(full.orchLink).toBeDefined();
    expect(full.prelaunchNodePath).toBeUndefined();
    expect(await full.toolchain?.expectedFor('arm64')).toMatchObject({ expectedHash: HASH, codexIncluded: true });
    expect(toolchain.resolveSources).toHaveBeenCalledWith('arm64');
    const pre = await service.preflightExtras(id, 'prelaunch');
    expect(pre.prelaunchNodePath).toBe('/opt/homebrew/bin/node');
  });

  it('an unavailable build or an unsupported arch becomes unavailableReason (never a rejection)', async () => {
    const id = await addWith((h) => result(h));
    toolchain.resolveSources.mockImplementation((arch: ToolchainArch) => { throw new ToolchainUnavailableError('arch-missing', arch); });
    const extras = await service.preflightExtras(id, 'full');
    expect(await extras.toolchain?.expectedFor('x86_64'))
      .toMatchObject({ expectedHash: null, unavailableReason: 'This build of cyboflow has no x64 tools' });
    expect((await extras.toolchain?.expectedFor('ppc'))?.unavailableReason).toMatch(/no tools for ppc/);
    toolchain.resolveSources.mockImplementation(() => { throw new Error('disk on fire sk-ant-oat01-SECRETSECRET'); });
    const odd = await extras.toolchain?.expectedFor('arm64');
    expect(odd?.expectedHash).toBeNull();
    expect(odd?.unavailableReason).not.toContain('SECRETSECRET');
  });

  it('concurrent expectations for one arch share one manifest build', async () => {
    const id = await addWith((h) => result(h));
    const gate = deferred<{ manifest: ToolchainManifest; sources: [] }>();
    toolchain.buildManifest.mockImplementation(() => gate.promise);
    const extras = await service.preflightExtras(id, 'full');
    const a = extras.toolchain?.expectedFor('arm64');
    const b = extras.toolchain?.expectedFor('aarch64');
    gate.resolve({ manifest: MANIFEST, sources: [] });
    expect((await a)?.expectedHash).toBe(HASH);
    expect((await b)?.expectedHash).toBe(HASH);
    expect(toolchain.buildManifest).toHaveBeenCalledTimes(1);
  });

  it('without toolchain deps / links the extras are empty (M1 shape)', async () => {
    service = makeService({ toolchain: null, links: null });
    const id = await addWith((h) => result(h));
    expect(await service.preflightExtras(id, 'full')).toEqual({});
  });

  it('the link handle opens the forward for the PROBED root even before any facts were recorded', async () => {
    const id = await addWith((h) => result(h, { remote: undefined, probeComplete: false, reachable: true }));
    const extras = await service.preflightExtras(id, 'full');
    const lease = await extras.orchLink?.acquire('/Users/k/cf-remote/zz');
    expect(lease?.remoteSock).toBe('/Users/k/cf-remote/zz/s/o.sock');
    expect(forwards[0].spec.remoteSock).toBe('/Users/k/cf-remote/zz/s/o.sock');
    extras.orchLink?.release();
    expect(service.get(id).linkState).toBe('up'); // idle-close is a timer; the ref is gone
  });
});

describe('installToolchain', () => {
  it('gates: disabled, kill switch, This Mac, archived, unchecked', async () => {
    const id = await addWith((h) => result(h));
    const fresh = await addWith((h) => result(h, { remote: undefined }));
    await expect(service.installToolchain(fresh)).rejects.toMatchObject({ name: HOSTS_ERROR_NAMES.needsPreflight, message: 'Run a check first.' });
    await expect(service.installToolchain('local')).rejects.toMatchObject({ name: HOSTS_ERROR_NAMES.localImmutable });
    env[REMOTE_HOSTS_KILL_SWITCH_ENV] = '1';
    await expect(service.installToolchain(id)).rejects.toMatchObject({ name: HOSTS_ERROR_NAMES.killed });
    delete env[REMOTE_HOSTS_KILL_SWITCH_ENV];
    enabled = false;
    await expect(service.installToolchain(id)).rejects.toMatchObject({ name: HOSTS_ERROR_NAMES.disabled });
    enabled = true;
    await service.archive(id);
    await store._queue().onIdle();
    await expect(service.installToolchain(id)).rejects.toMatchObject({ name: HOSTS_ERROR_NAMES.notFound });
    expect(toolchain.push).not.toHaveBeenCalled();
  });

  it('hashes, pushes to the probed root with progress on the toolchain channel, then kicks a full preflight', async () => {
    const id = await addWith((h) => result(h));
    hostEvents.on(hostToolchainChannel(id), onProgress);
    const before = hostFor(id).runs.length;
    await service.installToolchain(id);
    const input = toolchain.push.mock.calls[0][0] as PushToolchainInput;
    expect(input).toMatchObject({ hostId: id, target: 'box', remoteRoot: '/Users/k/cf-remote/h1', manifest: MANIFEST });
    expect(input.transport).toBe(toolchain.transport);
    expect(progress.map((p) => p.phase)).toEqual(['hashing', 'hashing', 'uploading', 'done']);
    expect(progress[1]).toEqual({ hostId: id, phase: 'hashing', bytesSent: 30, bytesTotal: 65, message: null });
    expect(hostFor(id).runs.length).toBe(before + 1);
    expect(hostFor(id).runs[before].mode).toBe('full');
    expect(service.get(id).installRunning).toBe(false);
    expect(captureError).not.toHaveBeenCalled();
  });

  it('one install per host: a second call while running returns the running promise', async () => {
    const id = await addWith((h) => result(h));
    const gate = deferred<{ hash: string; dir: string; alreadyInstalled: boolean; removed: string[] }>();
    toolchain.push.mockImplementation(() => gate.promise);
    const changes: unknown[] = [];
    hostEvents.on(HOSTS_CHANNEL, (e) => changes.push(e));
    const a = service.installToolchain(id);
    const b = service.installToolchain(id);
    expect(b).toBe(a);
    expect(service.get(id).installRunning).toBe(true);
    expect(changes).toContainEqual({ kind: 'hosts', hostId: id });
    await flush();
    gate.resolve({ hash: HASH, dir: '/d', alreadyInstalled: true, removed: [] });
    await a;
    expect(toolchain.push).toHaveBeenCalledTimes(1);
    expect(service.get(id).installRunning).toBe(false);
  });

  it('a push failure rejects with the named error, emits failed (redacted) and reports host-toolchain with closed tags', async () => {
    const id = await addWith((h) => result(h));
    hostEvents.on(hostToolchainChannel(id), onProgress);
    toolchain.push.mockImplementation(async () => { throw new ToolchainPushError('upload', id, 'exit 92 sk-ant-oat01-SECRETSECRET'); });
    const before = hostFor(id).runs.length;
    await expect(service.installToolchain(id)).rejects.toMatchObject({ name: HOSTS_ERROR_NAMES.toolchainPushFailed });
    const failed = progress[progress.length - 1];
    expect(failed.phase).toBe('failed');
    expect(failed.message).toMatch(/upload/);
    expect(failed.message).not.toContain('SECRETSECRET');
    expect(captureError).toHaveBeenCalledTimes(1);
    const [seam, err, tags] = captureError.mock.calls[0] as [string, Error, Record<string, string>];
    expect(seam).toBe('host-toolchain');
    expect(err.message).not.toContain('SECRETSECRET');
    expect(tags).toEqual({ hostKind: 'ssh', errorClass: 'ToolchainPushError', step: 'upload' });
    expect(hostFor(id).runs.length).toBe(before); // no follow-up check after a failure
  });

  it('an unexpected error is wrapped (toolchain_push_failed) and tagged by where it surfaced', async () => {
    const id = await addWith((h) => result(h));
    toolchain.buildManifest.mockImplementation(async () => { throw new Error('EACCES'); });
    await expect(service.installToolchain(id)).rejects.toMatchObject({ name: HOSTS_ERROR_NAMES.toolchainPushFailed });
    expect(captureError.mock.calls[0][2]).toEqual({ hostKind: 'ssh', errorClass: 'other', step: 'hash' });
  });

  it('a build without tools for the arch rejects toolchain_unavailable without telemetry', async () => {
    const id = await addWith((h) => result(h));
    toolchain.resolveSources.mockImplementation((arch: ToolchainArch) => { throw new ToolchainUnavailableError('arch-missing', arch); });
    await expect(service.installToolchain(id)).rejects.toMatchObject({ name: HOSTS_ERROR_NAMES.toolchainUnavailable });
    expect(captureError).not.toHaveBeenCalled();
  });

  it('archive aborts a running install (no telemetry, no follow-up check)', async () => {
    const id = await addWith((h) => result(h));
    toolchain.push.mockImplementation((input: PushToolchainInput) => new Promise((_res, rej) => {
      input.signal?.addEventListener('abort', () => rej(new ToolchainPushError('aborted', id, 'cancelled')), { once: true });
    }));
    const p = service.installToolchain(id);
    await flush();
    const before = hostFor(id).runs.length;
    await service.archive(id);
    await expect(p).rejects.toMatchObject({ name: HOSTS_ERROR_NAMES.toolchainPushFailed });
    expect(captureError).not.toHaveBeenCalled();
    expect(hostFor(id).runs.length).toBe(before);
  });
});

describe('prelaunch', () => {
  it('This Mac passes; disabled / kill switch / unknown / archived are refused with their codes', async () => {
    expect(await service.prelaunch('local', 'claude-sdk')).toEqual({ ok: true });
    expect(await service.prelaunch('nope', 'claude-sdk')).toMatchObject({ ok: false, code: 'archived' });
    const id = await addWith((h) => result(h));
    env[REMOTE_HOSTS_KILL_SWITCH_ENV] = '1';
    expect(await service.prelaunch(id, 'claude-sdk')).toMatchObject({ ok: false, code: 'disabled' });
    delete env[REMOTE_HOSTS_KILL_SWITCH_ENV];
    enabled = false;
    expect(await service.prelaunch(id, 'claude-sdk')).toMatchObject({ ok: false, code: 'disabled' });
  });

  it('a fresh full check + a passing live prelaunch → ok; the live run is never recorded or emitted', async () => {
    const id = await addWith((h) => result(h));
    const stored = store.get(id)?.preflight;
    const lastAttempt = service.get(id).lastAttempt;
    const progressEvents: unknown[] = [];
    hostEvents.on(hostPreflightChannel(id), (e) => progressEvents.push(e));
    const p = service.prelaunch(id, 'claude-sdk');
    await flush();
    const run = hostFor(id).runs[hostFor(id).runs.length - 1];
    expect(run.mode).toBe('prelaunch');
    run.d.resolve(result(id, { mode: 'prelaunch', detectedTier: null, finishedAt: '2026-10-09T12:09:00.000Z', remote: undefined }));
    expect(await p).toEqual({ ok: true });
    await store._queue().onIdle();
    expect(store.get(id)?.preflight).toEqual(stored);
    expect(service.get(id).lastAttempt).toEqual(lastAttempt);
    expect(service.get(id).preflightRunning).toBe(false);
    expect(progressEvents).toEqual([]);
  });

  it('a failing live prelaunch maps to its code', async () => {
    const id = await addWith((h) => result(h));
    const p = service.prelaunch(id, 'claude-sdk');
    await flush();
    hostFor(id).runs[hostFor(id).runs.length - 1].d.resolve(result(id, { mode: 'prelaunch' }, { 'mcp-roundtrip': 'fail' }));
    expect(await p).toMatchObject({ ok: false, code: 'link-down' });
  });

  it('a recent full check that fails the gate refuses without any round trip', async () => {
    const id = await addWith((h) => result(h, { finishedAt: new Date().toISOString(), detectedTier: 'cli', runtimes: { claudeSdk: false, codexSdk: false, claudeCli: true, codexCli: false } }, { 'sdk-binary-hash': 'warn' }));
    const runs = hostFor(id).runs.length;
    expect(await service.prelaunch(id, 'claude-sdk')).toMatchObject({ ok: false, code: 'not-installed' });
    expect(hostFor(id).runs.length).toBe(runs);
  });

  it('an older failing full check is re-checked once (recorded); a passing re-check goes on to the live prelaunch', async () => {
    const id = await addWith((h) => result(h, {}, { 'claude-auth': 'fail' }));
    const p = service.prelaunch(id, 'claude-sdk');
    await flush();
    const recheck = hostFor(id).runs[hostFor(id).runs.length - 1];
    expect(recheck.mode).toBe('full');
    recheck.d.resolve(result(id, { finishedAt: '2026-10-09T12:30:00.000Z' }));
    await flush();
    const live = hostFor(id).runs[hostFor(id).runs.length - 1];
    expect(live.mode).toBe('prelaunch');
    live.d.resolve(result(id, { mode: 'prelaunch' }));
    expect(await p).toEqual({ ok: true });
    await store._queue().onIdle();
    expect(store.get(id)?.preflight?.finishedAt).toBe('2026-10-09T12:30:00.000Z');
  });

  it('an older failing full check whose re-check still fails refuses with the fresh verdict', async () => {
    const id = await addWith((h) => result(h, {}, { 'claude-auth': 'fail' }));
    const p = service.prelaunch(id, 'claude-sdk');
    await flush();
    const runs = hostFor(id).runs.length;
    hostFor(id).runs[runs - 1].d.resolve(result(id, {}, { 'sdk-binary-hash': 'fail' }));
    expect(await p).toMatchObject({ ok: false, code: 'not-installed' });
    expect(hostFor(id).runs.length).toBe(runs);
  });

  it('no completed full check refuses with needs-check and starts nothing', async () => {
    const id = await addWith((h) => result(h, { reachable: false }, { 'ssh-reachable': 'fail' }));
    const runs = hostFor(id).runs.length;
    expect(await service.prelaunch(id, 'claude-sdk')).toMatchObject({ ok: false, code: 'needs-check' });
    expect(hostFor(id).runs.length).toBe(runs);
  });

  it('an old full check is still judged; the launch only runs the cheap live prelaunch, never a full run', async () => {
    const id = await addWith((h) => result(h));
    const p = service.prelaunch(id, 'codex-sdk');
    await flush();
    const run = hostFor(id).runs[hostFor(id).runs.length - 1];
    expect(run.mode).toBe('prelaunch');
    run.d.resolve(result(id, { mode: 'prelaunch' }));
    expect(await p).toEqual({ ok: true });
  });
});
