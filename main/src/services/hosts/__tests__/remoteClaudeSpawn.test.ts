import { describe, it, expect, vi, afterEach, type Mock } from 'vitest';
import Database from 'better-sqlite3';
import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import type { LoggerLike } from '../../../orchestrator/types';
import {
  _resetRemoteClaudeSpawnForTesting,
  createRemoteClaudeSpawn,
  emptyPermissionRules,
  prepareRemoteClaudeSpawn,
  releaseUnadoptedLease,
  remoteClaudeEnvKeys,
  remoteClaudeMcpServers,
  remoteClaudeRunEnv,
  remoteClaudeSdkOptions,
  remoteSpawnFailureMessage,
  resolveClaudeSpawnHostId,
  sanitizeRemoteClaudeArgs,
} from '../remoteClaudeSpawn';
import { RemoteRuntimeError } from '../remoteRuntime';
import { setRemoteRuntime, type RemoteRuntimeLike } from '../remoteRuntimeBridge';
import {
  createFakeRemoteSession,
  FAKE_REMOTE_ROOT,
  FAKE_REMOTE_SOCK,
  FAKE_REMOTE_NODE,
  FAKE_TOOLCHAIN,
  manualTimers,
} from './fakeRemoteRuntimeSession';

afterEach(() => {
  setRemoteRuntime(null);
  _resetRemoteClaudeSpawnForTesting();
});

function fakeRuntime(impl: Partial<RemoteRuntimeLike> = {}): RemoteRuntimeLike {
  return {
    resolveHostId: vi.fn(() => null),
    prepare: vi.fn(async () => createFakeRemoteSession()),
    removeRunToken: vi.fn(async () => undefined),
    ...impl,
  };
}

function hostDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, host_id TEXT); CREATE TABLE sessions (id TEXT PRIMARY KEY, host_id TEXT);');
  return db;
}

function logger(): LoggerLike & { warn: Mock; debug: Mock } {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

const LOCAL_ENV = {
  // What the SDK hands a spawner: the composed (remote) env plus its own protocol flags. A local-only leak is
  // simulated too, to prove the spawner re-filters.
  HOME: '/Users/local',
  PATH: '/opt/local/bin:/usr/bin',
  SECRET_LOCAL_THING: 'nope',
  CYBOFLOW_ORCH_TOKEN: 'tok-should-never-travel',
  CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-local-should-never-travel',
  ELECTRON_RUN_AS_NODE: '1',
  CYBOFLOW_RUN_ARTIFACTS_DIR: '/Users/local/.cyboflow/artifacts/runs/run-1',
  CYBOFLOW_MANAGED_TEST_CONCURRENCY: '1',
  CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
  CLAUDE_AGENT_SDK_VERSION: '0.3.284',
  CLAUDE_CODE_SDK_READS_SESSION_STATE: '1',
  LANE_SLOT: 'slot-2',
};

function sdkSpawnOptions(over: Partial<SpawnOptions> = {}): SpawnOptions {
  return {
    command: '/Applications/cyboflow.app/Contents/Resources/app.asar.unpacked/claude',
    args: ['--output-format', 'stream-json', '--mcp-config', '{"mcpServers":{}}'],
    cwd: '/Users/remote/cf-remote/host-1/worktrees/wt-1',
    env: { ...LOCAL_ENV },
    signal: new AbortController().signal,
    ...over,
  };
}

describe('sanitizeRemoteClaudeArgs', () => {
  it('drops every flag that carries a local path, keeping everything else in order', () => {
    const { args, dropped } = sanitizeRemoteClaudeArgs([
      '--verbose',
      '--add-dir', '/Users/local/x',
      '--plugin-dir', '/Users/local/p',
      '--plugin-dir-no-mcp', '/Users/local/q',
      '--debug-file', '/tmp/dbg',
      '--managed-settings', '/Library/x.json',
      '--project-config-root=/Users/local/proj',
      '--resume=abc',
      '--mcp-config', '{"mcpServers":{}}',
    ]);
    expect(args).toEqual(['--verbose', '--resume=abc', '--mcp-config', '{"mcpServers":{}}']);
    expect(dropped).toEqual([
      '--add-dir', '--plugin-dir', '--plugin-dir-no-mcp', '--debug-file', '--managed-settings', '--project-config-root',
    ]);
  });

  it('passes ordinary SDK args through untouched', () => {
    const input = ['--output-format', 'stream-json', '--setting-sources', 'user,project', '--permission-prompt-tool', 'stdio'];
    expect(sanitizeRemoteClaudeArgs(input)).toEqual({ args: input, dropped: [] });
  });
});

describe('remoteClaudeEnvKeys', () => {
  it('adds the SDK protocol flags to the caller keys, never other CLAUDE_* keys', () => {
    const keys = remoteClaudeEnvKeys({ CLAUDE_CODE_SDK_READS_SESSION_STATE: '1', CLAUDE_FOO: 'x', OTHER: 'y' }, ['LANE_SLOT']);
    expect(keys.sort()).toEqual(['CLAUDE_CODE_SDK_READS_SESSION_STATE', 'LANE_SLOT']);
  });
});

describe('createRemoteClaudeSpawn', () => {
  it('ignores the local command, runs the remote binary in the remote cwd with the token env file', () => {
    const session = createFakeRemoteSession();
    const spawn = createRemoteClaudeSpawn(session, { cwd: '/fallback', extraKeys: ['LANE_SLOT'] });
    const opts = sdkSpawnOptions();
    const proc = spawn(opts);

    expect(session.spawned).toHaveLength(1);
    const { spec } = session.spawned[0];
    expect(spec.command).toBe(`${FAKE_TOOLCHAIN}/claude`);
    expect(spec.command).not.toBe(opts.command);
    expect(spec.args).toEqual(opts.args);
    expect(spec.cwd).toBe(opts.cwd);
    expect(spec.withTokenEnvFile).toBe(true);
    expect(session.spawned[0].proc.pid).toBeUndefined();
    expect(proc).toBe(session.spawned[0].proc);
  });

  it('falls back to the configured cwd when the SDK passes none', () => {
    const session = createFakeRemoteSession();
    createRemoteClaudeSpawn(session, { cwd: '/Users/remote/wt' })(sdkSpawnOptions({ cwd: undefined }));
    expect(session.spawned[0].spec.cwd).toBe('/Users/remote/wt');
  });

  it('allowlists the env: remote facts + PATH, CYBOFLOW_* remapped, extra + SDK keys; no local secret or noise', () => {
    const session = createFakeRemoteSession();
    const artifactsDir = `${FAKE_REMOTE_ROOT}/artifacts/runs/run-1`;
    createRemoteClaudeSpawn(session, { cwd: '/x', extraKeys: ['LANE_SLOT'], artifactsDir })(sdkSpawnOptions());
    const env = session.spawned[0].spec.env ?? {};

    expect(env.HOME).toBe('/Users/remote');
    expect(env.PATH).toBe('/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin');
    expect(env.TERM).toBe('dumb');
    expect(env.CYBOFLOW_ORCH_SOCKET).toBe(FAKE_REMOTE_SOCK);
    expect(env.CYBOFLOW_ORCH_TOKEN_FILE).toBe(`${FAKE_REMOTE_ROOT}/run/run-1.token`);
    expect(env.CYBOFLOW_RUN_ARTIFACTS_DIR).toBe(artifactsDir);
    expect(env.CYBOFLOW_MANAGED_TEST_CONCURRENCY).toBe('1');
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBe('sdk-ts');
    expect(env.CLAUDE_AGENT_SDK_VERSION).toBe('0.3.284');
    expect(env.CLAUDE_CODE_SDK_READS_SESSION_STATE).toBe('1');
    expect(env.LANE_SLOT).toBe('slot-2');

    expect(env).not.toHaveProperty('SECRET_LOCAL_THING');
    expect(env).not.toHaveProperty('CYBOFLOW_ORCH_TOKEN');
    expect(env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    expect(env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
    expect(JSON.stringify(env)).not.toContain('/Users/local');
  });

  it('strips local-path flags and logs only the flag names', () => {
    const session = createFakeRemoteSession();
    const log = logger();
    createRemoteClaudeSpawn(session, { cwd: '/x', logger: log })(
      sdkSpawnOptions({ args: ['--add-dir', '/Users/local/secret-dir', '--verbose'] }),
    );
    expect(session.spawned[0].spec.args).toEqual(['--verbose']);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.warn.mock.calls[0])).not.toContain('/Users/local/secret-dir');
  });

  it('forwards the SDK abort signal: abort runs the HostProcess kill sequence', async () => {
    const timers = manualTimers();
    const session = createFakeRemoteSession({ timers });
    const ac = new AbortController();
    const proc = createRemoteClaudeSpawn(session, { cwd: '/x' })(sdkSpawnOptions({ signal: ac.signal }));
    const { child, remoteKills } = session.spawned[0];

    expect(session.spawned[0].spec.signal).toBe(ac.signal);
    ac.abort();
    expect(proc.killed).toBe(true);
    timers.fire(); // grace elapsed, still alive → remote TERM then local SIGTERM
    await new Promise((r) => setImmediate(r));
    expect(remoteKills).toEqual(['TERM']);
    expect(child.signals).toEqual(['SIGTERM']);
  });

  it('drains stderr and logs the redacted tail on a failed exit (ssh 255 → host-unreachable)', async () => {
    const session = createFakeRemoteSession();
    const log = logger();
    createRemoteClaudeSpawn(session, { cwd: '/x', logger: log })(sdkSpawnOptions());
    const { child } = session.spawned[0];
    // More than a pipe buffer, so an undrained stderr would stall.
    child.stderr.write(`${'x'.repeat(70_000)}\n`);
    child.stderr.write('ssh: connect to host h port 22: Connection refused\n');
    await new Promise((r) => setImmediate(r));
    child.exit(255);

    expect(log.warn).toHaveBeenCalledTimes(1);
    const [msg, ctx] = log.warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(msg).toContain('[ssh]');
    expect(ctx.reason).toBe('host-unreachable');
    expect(String(ctx.stderrTail)).toContain('Connection refused');
    expect(String(ctx.stderrTail).length).toBeLessThanOrEqual(1024);
  });

  it('does not log a clean exit or a requested kill', () => {
    const session = createFakeRemoteSession();
    const log = logger();
    const spawn = createRemoteClaudeSpawn(session, { cwd: '/x', logger: log });
    spawn(sdkSpawnOptions());
    session.spawned[0].child.exit(0);
    const second = spawn(sdkSpawnOptions());
    second.kill('SIGKILL');
    session.spawned[1].child.exit(null, 'SIGKILL');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('refuses to spawn on a released session', () => {
    const session = createFakeRemoteSession();
    session.release();
    expect(() => createRemoteClaudeSpawn(session, { cwd: '/x' })(sdkSpawnOptions())).toThrow();
  });
});

describe('resolveClaudeSpawnHostId', () => {
  it('an explicit host wins; "local" means This Mac without any lookup', () => {
    const resolveHostId = vi.fn(() => 'host-9');
    setRemoteRuntime(fakeRuntime({ resolveHostId }));
    const db = hostDb();
    expect(resolveClaudeSpawnHostId(db, { hostId: 'host-1', runId: 'r', sessionId: 's' })).toBe('host-1');
    expect(resolveClaudeSpawnHostId(db, { hostId: 'local', sessionHostId: 'host-2', runId: 'r', sessionId: 's' })).toBeNull();
    expect(resolveHostId).not.toHaveBeenCalled();
    db.close();
  });

  it('then the session row in hand, then the runtime lookup by run + session', () => {
    const resolveHostId = vi.fn(() => 'host-9');
    setRemoteRuntime(fakeRuntime({ resolveHostId }));
    const db = hostDb();
    expect(resolveClaudeSpawnHostId(db, { sessionHostId: 'host-2', runId: 'r', sessionId: 's' })).toBe('host-2');
    expect(resolveClaudeSpawnHostId(db, { hostId: null, sessionHostId: 'local', runId: 'run-x', sessionId: 'sess' })).toBe('host-9');
    expect(resolveHostId).toHaveBeenCalledWith({ runId: 'run-x', sessionId: 'sess' });
    db.close();
  });

  it('without a runtime, a remote-stamped run is still found (the spawn then fails instead of running locally)', () => {
    const db = hostDb();
    db.prepare('INSERT INTO workflow_runs (id, host_id) VALUES (?, ?)').run('run-remote', 'host-7');
    db.prepare('INSERT INTO sessions (id, host_id) VALUES (?, ?)').run('sess-remote', 'host-8');
    expect(resolveClaudeSpawnHostId(db, { runId: 'run-remote', sessionId: 's' })).toBe('host-7');
    expect(resolveClaudeSpawnHostId(db, { runId: 'run-local', sessionId: 'sess-remote' })).toBe('host-8');
    expect(resolveClaudeSpawnHostId(db, { runId: 'run-local', sessionId: 'nope' })).toBeNull();
    db.close();
  });

  it('without a runtime, a db that cannot answer reads as This Mac', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE workflow_runs (id TEXT PRIMARY KEY)');
    const log = logger();
    expect(resolveClaudeSpawnHostId(db, { runId: 'r', sessionId: 's' }, log)).toBeNull();
    expect(log.debug).toHaveBeenCalledTimes(1);
    db.close();
  });

  it('with a runtime, a db error propagates (fail closed)', () => {
    setRemoteRuntime(fakeRuntime({ resolveHostId: vi.fn(() => { throw new Error('db down'); }) }));
    const db = hostDb();
    expect(() => resolveClaudeSpawnHostId(db, { runId: 'r', sessionId: 's' })).toThrow('db down');
    db.close();
  });
});

describe('prepareRemoteClaudeSpawn', () => {
  it('fails readably when remote runs are not wired', async () => {
    await expect(prepareRemoteClaudeSpawn('host-1', { runId: 'run-1', spawnKey: 'run-1' })).rejects.toThrow(/Remote environments are not available/);
  });

  it('classifies an orch-link outage as host-unreachable, keeping the cause', async () => {
    const cause = new RemoteRuntimeError('link-down', 'The orchestrator link to this environment is not available: refused');
    setRemoteRuntime(fakeRuntime({ prepare: vi.fn(async () => { throw cause; }) }));
    const err = await prepareRemoteClaudeSpawn('host-1', { runId: 'run-1', spawnKey: 'k' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/^host-unreachable: The orchestrator link/);
    expect((err as Error).cause).toBe(cause);
  });

  it('does not prefix a configuration refusal', async () => {
    setRemoteRuntime(fakeRuntime({
      prepare: vi.fn(async () => { throw new RemoteRuntimeError('not-installed', 'cyboflow tools are not installed on this environment (Install cyboflow tools).'); }),
    }));
    await expect(prepareRemoteClaudeSpawn('host-1', { runId: 'run-1', spawnKey: 'k' })).rejects.toThrow(/^cyboflow tools are not installed/);
  });

  it('passes the run + spawn key, and creates the artifacts dir on the environment once', async () => {
    const session = createFakeRemoteSession({ runId: 'run-1' });
    const prepare = vi.fn(async () => session);
    setRemoteRuntime(fakeRuntime({ prepare }));
    await expect(prepareRemoteClaudeSpawn('host-1', { runId: 'run-1', spawnKey: 'run-1:item' })).resolves.toBe(session);
    await prepareRemoteClaudeSpawn('host-1', { runId: 'run-1', spawnKey: 'run-1:item' });
    expect(prepare).toHaveBeenCalledWith('host-1', { runId: 'run-1', spawnKey: 'run-1:item' });
    expect(session.mkdirs).toEqual([`${FAKE_REMOTE_ROOT}/artifacts/runs/run-1`]);
  });

  it('a new host generation (target change / archive) creates the artifacts dir again', async () => {
    const before = createFakeRemoteSession({ runId: 'run-1', generation: 0 });
    const after = createFakeRemoteSession({ runId: 'run-1', generation: 1 });
    const prepare = vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    setRemoteRuntime(fakeRuntime({ prepare }));
    await prepareRemoteClaudeSpawn('host-1', { runId: 'run-1', spawnKey: 'k' });
    await prepareRemoteClaudeSpawn('host-1', { runId: 'run-1', spawnKey: 'k' });
    expect(before.mkdirs).toEqual([`${FAKE_REMOTE_ROOT}/artifacts/runs/run-1`]);
    expect(after.mkdirs).toEqual([`${FAKE_REMOTE_ROOT}/artifacts/runs/run-1`]);
  });

  it('a failed remote mkdir is not fatal (and is retried next time)', async () => {
    const failing = createFakeRemoteSession({ runId: 'run-1', mkdirpError: new Error('Permission denied') });
    setRemoteRuntime(fakeRuntime({ prepare: vi.fn(async () => failing) }));
    const log = logger();
    await expect(prepareRemoteClaudeSpawn('host-1', { runId: 'run-1', spawnKey: 'k' }, log)).resolves.toBe(failing);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});

describe('small helpers', () => {
  it('remoteSpawnFailureMessage redacts and classifies', () => {
    expect(remoteSpawnFailureMessage(new RemoteRuntimeError('link-down', 'down'))).toBe('host-unreachable: down');
    expect(remoteSpawnFailureMessage(new Error('plain'))).toBe('plain');
    expect(remoteSpawnFailureMessage(new Error('key sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAAAAA leaked'))).not.toContain('sk-ant-oat01-AAAA');
  });

  it('releaseUnadoptedLease releases only an unadopted session', () => {
    const a = createFakeRemoteSession();
    releaseUnadoptedLease({ session: a, adopted: true });
    expect(a.released).toBe(false);
    releaseUnadoptedLease({ session: a, adopted: false });
    expect(a.released).toBe(true);
    expect(() => releaseUnadoptedLease({ session: null, adopted: false })).not.toThrow();
  });

  it('emptyPermissionRules is empty and frozen', () => {
    const rules = emptyPermissionRules();
    expect(rules).toEqual({ allow: [], deny: [], ask: [] });
    expect(Object.isFrozen(rules)).toBe(true);
    expect(Object.isFrozen(rules.allow)).toBe(true);
  });

  it('remote MCP map, env and SDK options agree on run key, token file and artifacts dir', () => {
    const session = createFakeRemoteSession({ runId: 'run-1' });
    const inputs = { runKey: 'run-1', cwd: '/Users/remote/wt', laneEnv: { LANE_SLOT: 's' }, verbose: true };
    const mcp = remoteClaudeMcpServers(session, inputs).cyboflow as { command: string; env: Record<string, string> };
    expect(mcp.command).toBe(FAKE_REMOTE_NODE);
    expect(mcp.env).not.toHaveProperty('CYBOFLOW_ORCH_TOKEN');
    const env = remoteClaudeRunEnv(session, inputs);
    expect(env.CYBOFLOW_ORCH_TOKEN_FILE).toBe(mcp.env.CYBOFLOW_ORCH_TOKEN_FILE);
    expect(env.MCP_DEBUG).toBe('1');
    expect(env.LANE_SLOT).toBe('s');
    const sdk = remoteClaudeSdkOptions(session, inputs);
    expect(sdk.pathToClaudeCodeExecutable).toBe(`${FAKE_TOOLCHAIN}/claude`);
    sdk.spawnClaudeCodeProcess?.({ command: '/local', args: [], env: { ...env }, signal: new AbortController().signal });
    expect(session.spawned[0].spec.cwd).toBe('/Users/remote/wt');
    expect(session.spawned[0].spec.env?.CYBOFLOW_RUN_ARTIFACTS_DIR).toBe(env.CYBOFLOW_RUN_ARTIFACTS_DIR);
    expect(session.spawned[0].spec.env?.MCP_DEBUG).toBe('1');
  });
});
