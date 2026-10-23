/**
 * CodexSdkManager on an SSH environment (spec M2 B3): only the cold-entry app-server is host-routed; the client
 * gets the remote spawn seam, the pushed codex, the remote worktree and an allowlisted env carrying the orch token
 * FILE (never the token); role files are written on the machine before thread/start; probes stay local; the
 * orch-link lease is released at teardown. A fake RemoteRuntime stands in for the hosts service (no ssh).
 */
import Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionManager } from '../../../sessionManager';
import type { AppServerNotification, CodexAppServerClientOptions } from '../appServer/client';
import type { AppServerInitializeParams } from '../appServer/protocol';
import { materializeForLevel } from '../../../../../../shared/tuning/workflowTuning';
import { CodexSdkManager, type CodexAppServerClientFactory, type CodexAppServerClientLike } from '../codexSdkManager';
import { setRemoteRuntime, type RemoteRuntimeLike } from '../../../hosts/remoteRuntimeBridge';
import type { RemoteRuntimeSession } from '../../../hosts/remoteRuntime';
import { composeRemoteEnv, composeRemotePath } from '../../../hosts/remoteLaunch';
import type { HostProcess, HostSpawnSpec } from '../../../../orchestrator/trpc/contracts/executionHost';

const ROOT = '/Users/me/cf-remote/h1';
const TC = `${ROOT}/toolchain/abc`;
const CODEX_BIN = `${TC}/codex/aarch64-apple-darwin/bin/codex`;
const CODEX_PATH_DIR = `${TC}/codex/aarch64-apple-darwin/codex-path`;
const NODE = '/opt/homebrew/bin/node';
const REMOTE_SOCK = `${ROOT}/s/o.sock`;
const TOKEN_FILE = `${ROOT}/run/run-1.token`;
const REMOTE_WT = `${ROOT}/wt/session-1`;

type RequestHandler = (method: string, params: unknown, client: FakeClient) => unknown;

class FakeClient implements CodexAppServerClientLike {
  readonly start = vi.fn(() => undefined);
  readonly stop = vi.fn(async () => undefined);
  readonly initialize = vi.fn(async (_p: AppServerInitializeParams) => ({
    userAgent: 'codex-cli/0.159.2',
    codexHome: '/Users/me/.codex',
    platformFamily: 'unix',
    platformOs: 'macos',
  }));
  readonly requests: Array<{ method: string; params: unknown }> = [];
  constructor(readonly options: CodexAppServerClientOptions, private readonly handler: RequestHandler) {}
  async sendRequest<TResult, TParams>(method: string, params: TParams): Promise<TResult> {
    this.requests.push({ method, params });
    return this.handler(method, params, this) as TResult;
  }
  notify(n: AppServerNotification): void {
    this.options.onNotification?.(n);
  }
}

function turnHandler(events: string[]): RequestHandler {
  let n = 0;
  return (method, _params, client) => {
    events.push(method);
    if (method === 'account/read') {
      return { account: { type: 'chatgpt', email: 'u@example.com', planType: 'pro' }, requiresOpenaiAuth: true };
    }
    if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'codex-thread-1' } };
    if (method === 'turn/start') {
      n += 1;
      const turnId = `turn-${n}`;
      setTimeout(() => {
        client.notify({
          method: 'item/completed',
          params: { threadId: 'codex-thread-1', turnId, completedAtMs: 1, item: { type: 'agentMessage', id: `m${n}`, text: `Done ${n}.` } },
        });
        client.notify({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: turnId, status: 'completed' } } });
      }, 0);
      return { turn: { id: turnId } };
    }
    if (method === 'model/list') {
      return { data: [{ id: 'm', model: 'gpt-x', displayName: 'X', description: 'x', hidden: false, isDefault: true }], nextCursor: null };
    }
    throw new Error(`Unexpected request: ${method}`);
  };
}

function createDb(withSprint = false): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, claude_session_id TEXT, updated_at TEXT, host_id TEXT,
      workflow_id TEXT, project_id INTEGER);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, host_id TEXT);
    CREATE TABLE agent_invocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, agent_invocation_id TEXT NOT NULL UNIQUE, run_id TEXT NOT NULL,
      step_id TEXT, agent_provider TEXT NOT NULL, agent_runtime TEXT NOT NULL, model TEXT, external_session_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, panel_id TEXT);
    CREATE TABLE raw_events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL, created_at TEXT NOT NULL, dedup_key TEXT);
    CREATE UNIQUE INDEX idx_raw_events_dedup ON raw_events(dedup_key) WHERE dedup_key IS NOT NULL;
    CREATE TABLE codex_invocation_turns (agent_invocation_id TEXT NOT NULL, run_id TEXT NOT NULL,
      thread_id TEXT NOT NULL, codex_turn_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (agent_invocation_id, codex_turn_id));
    CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, spec_json TEXT);
  `);
  db.prepare("INSERT INTO workflow_runs (id, updated_at) VALUES ('run-1', CURRENT_TIMESTAMP)").run();
  if (withSprint) {
    db.prepare("INSERT INTO workflows (id, name, spec_json) VALUES ('wf-sprint', 'sprint', ?)")
      .run(materializeForLevel('sprint', '', 'standard'));
    db.prepare("UPDATE workflow_runs SET workflow_id = 'wf-sprint', project_id = 1 WHERE id = 'run-1'").run();
  }
  return db;
}

class FakeHostProcess extends EventEmitter implements HostProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = undefined;
  readonly exitCode = null;
  readonly signalCode = null;
  readonly killed = false;
  readonly kill = vi.fn(() => true);
}

interface FakeSession {
  session: RemoteRuntimeSession;
  release: ReturnType<typeof vi.fn>;
  spawn: ReturnType<typeof vi.fn>;
  writeFile: ReturnType<typeof vi.fn>;
  mkdirp: ReturnType<typeof vi.fn>;
  fence: ReturnType<typeof vi.fn>;
}

function fakeSession(events: string[], codexBin: string | null = CODEX_BIN, generation = 0): FakeSession {
  let released = false;
  const release = vi.fn(() => {
    released = true;
  });
  const spawn = vi.fn((_spec: Omit<HostSpawnSpec, 'spawnKey'>) => new FakeHostProcess());
  const writeFile = vi.fn(async (p: { path: string }) => {
    events.push(`write:${p.path}`);
  });
  const mkdirp = vi.fn(async () => undefined);
  const fence = vi.fn(async () => {
    events.push('fence');
    return null;
  });
  const facts = { remoteRoot: ROOT, home: '/Users/me', user: 'me', shell: '/bin/zsh', lang: 'en_US.UTF-8' };
  const path = composeRemotePath({ codexPathDir: codexBin ? CODEX_PATH_DIR : null, nodeDir: '/opt/homebrew/bin' });
  const session: RemoteRuntimeSession = {
    hostId: 'h1',
    generation,
    facts,
    remoteRoot: ROOT,
    paths: { claude: `${TC}/claude`, mcpBundle: `${TC}/cyboflowMcpServer.js`, codexBin, codexPathDir: codexBin ? CODEX_PATH_DIR : null, nodePath: NODE, gitPath: '/usr/bin/git' },
    remoteSock: REMOTE_SOCK,
    tokenFile: TOKEN_FILE,
    runId: 'run-1',
    spawnKey: 'panel-1',
    codexAvailable: codexBin !== null,
    artifactsDir: (k) => `${ROOT}/artifacts/runs/${k}`,
    remotePath: () => path,
    env: (localEnv) => composeRemoteEnv(localEnv, { facts, path, orchSocket: REMOTE_SOCK, orchTokenFile: TOKEN_FILE }),
    spawn: spawn as unknown as RemoteRuntimeSession['spawn'],
    fs: {
      exists: vi.fn(async () => true),
      readFile: vi.fn(async () => ''),
      writeFile,
      mkdirp,
      readdir: vi.fn(async () => []),
      unlink: vi.fn(async () => undefined),
      rmrf: vi.fn(async () => undefined),
      stat: vi.fn(async () => null),
    },
    git: { run: vi.fn(), capture: vi.fn() } as unknown as RemoteRuntimeSession['git'],
    release,
    get released() {
      return released;
    },
    fence,
  };
  return { session, release, spawn, writeFile, mkdirp, fence };
}

function fakeRuntime(sessions: FakeSession[], hostFor: (lookup: { hostId?: string | null }) => string | null) {
  const prepare = vi.fn(async (_hostId: string, _opts: { runId: string; spawnKey: string }) => {
    const next = sessions.shift();
    if (!next) throw new Error('no more fake sessions');
    return next.session;
  });
  const rt: RemoteRuntimeLike = {
    resolveHostId: vi.fn((lookup) => hostFor(lookup)),
    prepare,
    removeRunToken: vi.fn(async () => undefined),
  };
  return { rt, prepare };
}

function makeManager(db: Database.Database, events: string[]) {
  const clients: FakeClient[] = [];
  const factory: CodexAppServerClientFactory = (options) => {
    const c = new FakeClient(options, turnHandler(events));
    clients.push(c);
    return c;
  };
  const manager = new CodexSdkManager(
    {} as SessionManager,
    undefined,
    undefined,
    db,
    factory,
    () => ({ executablePath: '/app/codex/bin/codex', pathDir: '/app/codex/codex-path', version: '0.159.2', target: 'aarch64-apple-darwin' }),
    '0.1.test',
    () => '/tmp/never-used-local-roles',
  );
  manager.setCyboflowMcpRuntimeConfig({
    orchSocketPath: '/local/orch.sock',
    bridgeScriptPath: '/app/cyboflowMcpServer.js',
    nodeExecutablePath: '/usr/local/bin/node',
  });
  manager.setApprovalRouterProvider(() => ({
    requestApproval: vi.fn(async () => ({ behavior: 'allow' as const })),
    clearPendingForSource: vi.fn(),
  }));
  manager.setQuestionRouterProvider(() => ({
    requestQuestion: vi.fn(async () => ({ answers: {} })),
    clearPendingForRun: vi.fn(),
  }));
  manager.on('error', () => undefined);
  return { manager, clients };
}

function turn(overrides: Record<string, unknown> = {}): Parameters<CodexSdkManager['spawnCliProcess']>[0] {
  return {
    panelId: 'panel-1',
    sessionId: 'session-1',
    runId: 'run-1',
    worktreePath: REMOTE_WT,
    prompt: 'go',
    hostId: 'h1',
    ...overrides,
  } as Parameters<CodexSdkManager['spawnCliProcess']>[0];
}

function mcpEnv(client: FakeClient): { command: string; args: string[]; env: Record<string, string> } {
  const req = client.requests.find((r) => r.method === 'thread/start' || r.method === 'thread/resume');
  if (!req) throw new Error('no thread request');
  return (req.params as { config: { mcp_servers: { cyboflow: { command: string; args: string[]; env: Record<string, string> } } } })
    .config.mcp_servers.cyboflow;
}

describe('CodexSdkManager on an SSH environment', () => {
  afterEach(() => {
    setRemoteRuntime(null);
    delete process.env.CYBOFLOW_DISABLE_CODEX_WARM;
  });

  it('hands the client the remote spawn seam, the pushed codex, the remote worktree and an allowlisted env', async () => {
    const db = createDb();
    const events: string[] = [];
    const fs1 = fakeSession(events);
    const { rt, prepare } = fakeRuntime([fs1], (l) => l.hostId ?? null);
    setRemoteRuntime(rt);
    try {
      const { manager, clients } = makeManager(db, events);
      await expect(manager.spawnCliProcess(turn())).resolves.toEqual({ resultText: 'Done 1.' });

      expect(prepare).toHaveBeenCalledWith('h1', { runId: 'run-1', spawnKey: 'panel-1' });
      expect(clients).toHaveLength(1);
      const opts = clients[0].options;
      expect(typeof opts.spawn).toBe('function');
      expect(opts.command).toBe(CODEX_BIN);
      expect(opts.cwd).toBe(REMOTE_WT);
      const env = opts.env ?? {};
      expect(env.CYBOFLOW_ORCH_TOKEN).toBeUndefined();
      expect(env.CYBOFLOW_ORCH_TOKEN_FILE).toBe(TOKEN_FILE);
      expect(env.CYBOFLOW_ORCH_SOCKET).toBe(REMOTE_SOCK);
      expect(env.CYBOFLOW_RUN_ID).toBe('run-1');
      expect(env.CYBOFLOW_WORKTREE).toBe(REMOTE_WT);
      expect(env.CYBOFLOW_MANAGED_TEST_CONCURRENCY).toBe('1');
      expect(env.HOME).toBe('/Users/me');
      expect(env.TERM).toBe('dumb');
      expect(env.PATH?.split(':')[0]).toBe(CODEX_PATH_DIR);
      expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
      // Nothing from this Mac's process.env beyond the allowlist.
      const allowed = new Set(['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'PATH',
        'CLAUDE_AGENT_SDK_VERSION', 'CLAUDE_CODE_ENTRYPOINT']);
      for (const key of Object.keys(env)) expect(allowed.has(key) || key.startsWith('CYBOFLOW_')).toBe(true);

      // The MCP bridge runs on the remote node with the pushed bundle and the token FILE.
      const mcp = mcpEnv(clients[0]);
      expect(mcp.command).toBe(NODE);
      expect(mcp.args).toEqual([`${TC}/cyboflowMcpServer.js`]);
      expect(mcp.env.CYBOFLOW_ORCH_SOCKET).toBe(REMOTE_SOCK);
      expect(mcp.env.CYBOFLOW_ORCH_TOKEN_FILE).toBe(TOKEN_FILE);
      expect(mcp.env.CYBOFLOW_ORCH_TOKEN).toBeUndefined();
      expect(mcp.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
      const threadCwd = (clients[0].requests.find((r) => r.method === 'thread/start')?.params as { cwd: string }).cwd;
      expect(threadCwd).toBe(REMOTE_WT);

      await manager.killAllProcesses();
      expect(fs1.release).toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it('the spawn seam runs the pushed codex on the host (ignoring the local command) and releases on exit', async () => {
    const db = createDb();
    const events: string[] = [];
    const fs1 = fakeSession(events);
    setRemoteRuntime(fakeRuntime([fs1], (l) => l.hostId ?? null).rt);
    try {
      const { manager, clients } = makeManager(db, events);
      await manager.spawnCliProcess(turn());
      const spawnFn = clients[0].options.spawn;
      if (!spawnFn) throw new Error('no spawn seam');
      const proc = spawnFn('/app/codex/bin/codex', ['app-server', '--listen', 'stdio://'], { cwd: REMOTE_WT, env: { A: '1' } });
      expect(proc.pid).toBeUndefined();
      expect(fs1.spawn).toHaveBeenCalledWith(
        { command: CODEX_BIN, args: ['app-server', '--listen', 'stdio://'], cwd: REMOTE_WT, env: { A: '1' } },
        { releaseOnExit: true },
      );
      await manager.killAllProcesses();
    } finally {
      db.close();
    }
  });

  it('writes the run\'s role files on the environment BEFORE thread/start and registers their remote paths', async () => {
    const db = createDb(true);
    const events: string[] = [];
    const fs1 = fakeSession(events);
    setRemoteRuntime(fakeRuntime([fs1], (l) => l.hostId ?? null).rt);
    try {
      const { manager, clients } = makeManager(db, events);
      await manager.spawnCliProcess(turn());

      const start = clients[0].requests.find((r) => r.method === 'thread/start');
      const agents = (start?.params as { config: { agents?: Record<string, { config_file: string }> } }).config.agents ?? {};
      expect(Object.keys(agents)).toContain('cyboflow-implement');
      const file = agents['cyboflow-implement'].config_file;
      expect(file.startsWith(`${ROOT}/codex/agent-roles/cyboflow-implement-`)).toBe(true);
      expect(fs1.mkdirp).toHaveBeenCalledWith({ hostId: 'h1', path: `${ROOT}/codex/agent-roles` });
      const write = fs1.writeFile.mock.calls.find((c) => (c[0] as { path: string }).path === file);
      expect(write?.[2]).toBe(0o600);
      expect(String(write?.[1])).toMatch(/^developer_instructions = "/);
      expect(events.indexOf(`write:${file}`)).toBeLessThan(events.indexOf('thread/start'));
      await manager.killAllProcesses();
    } finally {
      db.close();
    }
  });

  it('role files written once per host generation: a target change / archive (new generation) writes them again', async () => {
    const db = createDb(true);
    const events: string[] = [];
    const first = fakeSession(events, CODEX_BIN, 0);
    const sameGen = fakeSession(events, CODEX_BIN, 0);
    const nextGen = fakeSession(events, CODEX_BIN, 1);
    setRemoteRuntime(fakeRuntime([first, sameGen, nextGen], (l) => l.hostId ?? null).rt);
    try {
      const { manager } = makeManager(db, events);
      await manager.spawnCliProcess(turn());
      await manager.killAllProcesses();
      expect(first.writeFile).toHaveBeenCalled();
      await manager.spawnCliProcess(turn());
      await manager.killAllProcesses();
      expect(sameGen.writeFile).not.toHaveBeenCalled();
      await manager.spawnCliProcess(turn());
      await manager.killAllProcesses();
      expect(nextGen.writeFile.mock.calls.length).toBe(first.writeFile.mock.calls.length);
    } finally {
      db.close();
    }
  });

  it('keeps probes (account detection, model catalog) local even with a remote runtime wired', async () => {
    const db = createDb();
    const events: string[] = [];
    const { rt, prepare } = fakeRuntime([], () => 'h1');
    setRemoteRuntime(rt);
    try {
      const { manager, clients } = makeManager(db, events);
      await manager.detectChatGptAccount();
      for (const c of clients) {
        expect(c.options.spawn).toBeUndefined();
        expect(c.options.command).toBe('/app/codex/bin/codex');
      }
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it('a local host resolution leaves the spawn exactly local (no spawn seam, local codex, no prepare)', async () => {
    const db = createDb();
    const events: string[] = [];
    const { rt, prepare } = fakeRuntime([], () => null);
    setRemoteRuntime(rt);
    try {
      const { manager, clients } = makeManager(db, events);
      await manager.spawnCliProcess(turn({ hostId: undefined, worktreePath: '/tmp/wt' }));
      expect(prepare).not.toHaveBeenCalled();
      expect(clients[0].options.spawn).toBeUndefined();
      expect(clients[0].options.command).toBe('/app/codex/bin/codex');
      expect(clients[0].options.env?.CYBOFLOW_ORCH_TOKEN).toEqual(expect.any(String));
      expect(mcpEnv(clients[0]).env.CYBOFLOW_ORCH_TOKEN_FILE).toBeUndefined();
      await manager.killAllProcesses();
    } finally {
      db.close();
    }
  });

  it('never routes the hermetic assistant (isolation) remote', async () => {
    const db = createDb();
    const { rt, prepare } = fakeRuntime([], () => 'h1');
    setRemoteRuntime(rt);
    try {
      const { manager } = makeManager(db, []);
      // Fails later for unrelated reasons (no events sink fixture) — only routing matters here.
      await manager.spawnCliProcess(turn({ isolation: 'agent', runId: 'agent:t1' })).catch(() => undefined);
      expect(rt.resolveHostId).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
      await manager.killAllProcesses();
    } finally {
      db.close();
    }
  });

  it('fails readably and releases the lease when the environment has no Codex tools', async () => {
    const db = createDb();
    const fs1 = fakeSession([], null);
    setRemoteRuntime(fakeRuntime([fs1], () => 'h1').rt);
    try {
      const { manager, clients } = makeManager(db, []);
      await expect(manager.spawnCliProcess(turn())).rejects.toThrow('This environment has no Codex tools');
      expect(fs1.release).toHaveBeenCalled();
      expect(clients).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('fails instead of running locally when a remote host resolves but no runtime is wired', async () => {
    const db = createDb();
    db.prepare("UPDATE workflow_runs SET host_id = 'h1' WHERE id = 'run-1'").run();
    try {
      const { manager, clients } = makeManager(db, []);
      await expect(manager.spawnCliProcess(turn({ hostId: undefined }))).rejects.toThrow(/Remote environments are not available/);
      expect(clients).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('a warm resume on the same host reuses the parked app-server and releases the extra lease', async () => {
    const db = createDb();
    const events: string[] = [];
    const s1 = fakeSession(events);
    const s2 = fakeSession(events);
    setRemoteRuntime(fakeRuntime([s1, s2], () => 'h1').rt);
    try {
      const { manager, clients } = makeManager(db, events);
      await manager.spawnCliProcess(turn());
      await manager.spawnCliProcess(turn({ prompt: 'again', resumeSessionId: 'codex-thread-1' }));
      expect(clients).toHaveLength(1);
      expect(s2.release).toHaveBeenCalled();
      expect(s1.release).not.toHaveBeenCalled();
      // F1: the cold entry fenced its spawnKey; the warm push into the live app-server never does.
      expect(s1.fence).toHaveBeenCalledTimes(1);
      expect(s2.fence).not.toHaveBeenCalled();
      await manager.killAllProcesses();
      expect(s1.release).toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it('refuses image attachments on a remote spawn before preparing the host', async () => {
    const db = createDb();
    const { rt, prepare } = fakeRuntime([], () => 'h1');
    setRemoteRuntime(rt);
    try {
      const { manager } = makeManager(db, []);
      await expect(manager.spawnCliProcess(turn({ images: [{ mediaType: 'image/png', data: 'AA==' }] })))
        .rejects.toThrow(/not supported for runs on a remote environment/);
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });
});
