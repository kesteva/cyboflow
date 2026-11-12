/**
 * Mocked-SDK integration coverage for the M2 remote Claude spawn (spec §3 B2), driven through the real
 * spawnClaudeCode / spawnCliProcess → buildSdkOptions → query() seam:
 *  - a session stamped on an SSH environment reaches query() with spawnClaudeCodeProcess, the remote binary, the
 *    remote cwd and a remote-only cyboflow MCP entry; nothing is written into a same-named LOCAL worktree; the
 *    runtime session (orch-link lease) is released when the process ends;
 *  - a warm follow-up turn pushes into the live process and gives back the lease it prepared, while the live
 *    process keeps its own until it closes;
 *  - an environment outage fails the spawn with `host-unreachable:` and never reaches query();
 *  - a This Mac session is unchanged: no spawner, the local node + bundle, the token in the MCP env;
 *  - M2 Phase D: the workflow bundle + agent overlay land in the REMOTE worktree through the environment's fs BEFORE
 *    query() runs, and the teardown strips them there (user files untouched).
 * The remote runtime is a fake on the real bridge (no ssh).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import type Database from 'better-sqlite3';
import type { WorkflowBundle } from '../../../../orchestrator/workflows/workflowBundle';
import { createFakeMachineFs, cyboflowFilesUnder } from '../../../hosts/__tests__/fakeMachineFs';
import { _resetRemoteClaudeSpawnForTesting } from '../../../hosts/remoteClaudeSpawn';
import {
  createModuleFakeSdk,
  scenario,
  type FakeQueryParams,
} from '../../../../test/fakes/fakeSdk';
import { ApprovalRouter } from '../../../../orchestrator/approvalRouter';
import { QuestionRouter } from '../../../../orchestrator/questionRouter';
import { dbAdapter } from '../../../../orchestrator/__test_fixtures__/dbAdapter';
import { createTestDb } from '../../../../orchestrator/__test_fixtures__/orchestratorTestDb';
import { ClaudeCodeManager } from '../claudeCodeManager';
import type { SessionManager } from '../../../sessionManager';
import { RemoteRuntimeError } from '../../../hosts/remoteRuntime';
import { setRemoteRuntime, type RemoteRuntimeLike } from '../../../hosts/remoteRuntimeBridge';
import {
  createFakeRemoteSession,
  FAKE_REMOTE_NODE,
  FAKE_REMOTE_ROOT,
  FAKE_REMOTE_SOCK,
  FAKE_TOOLCHAIN,
  type FakeRemoteSession,
} from '../../../hosts/__tests__/fakeRemoteRuntimeSession';

const fakeSdk = createModuleFakeSdk();
const hooks = vi.hoisted(() => ({
  onQuery: null as (() => void) | null,
  bundle: null as WorkflowBundle | null,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: FakeQueryParams) => {
    hooks.onQuery?.();
    return fakeSdk.query(params);
  },
}));
// A fixed flow bundle for the Phase D case only (null = the real resolver: these sessions have no run row → empty).
vi.mock('../../../../orchestrator/workflows/workflowBundle', async (orig) => {
  const actual = await orig<typeof import('../../../../orchestrator/workflows/workflowBundle')>();
  return { ...actual, resolveWorkflowBundle: (p: string | null) => hooks.bundle ?? actual.resolveWorkflowBundle(p) };
});
vi.mock('../../../../orchestrator/mcpServer/scriptPath', () => ({
  resolveMcpServerScriptPath: vi.fn(() => '/mock/mcp-server.js'),
}));
vi.mock('../../../../utils/nodeFinder', () => ({
  findNodeExecutable: vi.fn(async () => 'node'),
}));

const REMOTE_WT = `${FAKE_REMOTE_ROOT}/worktrees/itest-wt`;
const SDK_SESSION = 'sdk-session-remote';

function makeSessionManager(hostId: string | null): SessionManager {
  return {
    getDbSession: vi.fn((id: string) => ({
      id,
      substrate: 'sdk',
      permission_mode: 'ignore',
      run_id: null,
      chat_run_id: null,
      skip_continue_next: false,
      host_id: hostId,
    })),
    getPanelClaudeSessionId: vi.fn(() => SDK_SESSION),
    getProjectById: vi.fn(() => undefined),
    updateSession: vi.fn(),
    addPanelOutput: vi.fn(),
  } as unknown as SessionManager;
}

interface FakeRuntime extends RemoteRuntimeLike {
  readonly sessions: FakeRemoteSession[];
  prepare: ReturnType<typeof vi.fn<RemoteRuntimeLike['prepare']>>;
}

function fakeRuntime(failWith?: Error, fsOverride?: ReturnType<typeof createFakeMachineFs>): FakeRuntime {
  const sessions: FakeRemoteSession[] = [];
  return {
    sessions,
    resolveHostId: vi.fn(() => null),
    prepare: vi.fn<RemoteRuntimeLike['prepare']>(async (_hostId, opts) => {
      if (failWith) throw failWith;
      const s = createFakeRemoteSession({ runId: opts.runId, spawnKey: opts.spawnKey, fs: fsOverride });
      sessions.push(s);
      return s;
    }),
    removeRunToken: vi.fn(async () => undefined),
  };
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('remote Claude spawn (mocked-SDK integration)', () => {
  let db: Database.Database;

  beforeEach(() => {
    fakeSdk.reset();
    db = createTestDb();
    const adapter = dbAdapter(db);
    ApprovalRouter.initialize(adapter);
    QuestionRouter.initialize(adapter);
  });

  afterEach(() => {
    setRemoteRuntime(null);
    hooks.onQuery = null;
    hooks.bundle = null;
    _resetRemoteClaudeSpawnForTesting();
    ApprovalRouter._resetForTesting();
    QuestionRouter._resetForTesting();
    delete process.env.CYBOFLOW_DISABLE_WARM_SDK;
    db.close();
    vi.clearAllMocks();
  });

  it('runs a remote session through spawnClaudeCodeProcess on the remote binary and releases the lease', async () => {
    process.env.CYBOFLOW_DISABLE_WARM_SDK = '1';
    fakeSdk.setScenario(scenario().systemInit({ sessionId: SDK_SESSION }).assistantText('ok').resultSuccess());
    const rt = fakeRuntime();
    setRemoteRuntime(rt);
    const mgr = new ClaudeCodeManager(makeSessionManager('host-1'), undefined, undefined, db);
    mgr.setOrchSocketPath('/tmp/remote-itest.sock');

    await mgr.spawnClaudeCode('panel-remote', 'session-remote', REMOTE_WT, 'hello');

    expect(rt.prepare).toHaveBeenCalledTimes(1);
    expect(rt.prepare.mock.calls[0]).toEqual(['host-1', { runId: 'panel-remote', spawnKey: 'panel-remote' }]);
    expect(fakeSdk.calls).toHaveLength(1);
    const opts = fakeSdk.calls[0];
    expect(typeof opts.spawnClaudeCodeProcess).toBe('function');
    expect(opts.pathToClaudeCodeExecutable).toBe(`${FAKE_TOOLCHAIN}/claude`);
    expect(opts.cwd).toBe(REMOTE_WT);
    expect(Object.keys(opts.mcpServers ?? {})).toEqual(['cyboflow']);
    const cyboflow = opts.mcpServers?.['cyboflow'] as { command: string; args: string[]; env: Record<string, string> };
    expect(cyboflow.command).toBe(FAKE_REMOTE_NODE);
    expect(cyboflow.env.CYBOFLOW_ORCH_SOCKET).toBe(FAKE_REMOTE_SOCK);
    expect(cyboflow.env.CYBOFLOW_ORCH_TOKEN).toBeUndefined();
    expect(opts.env?.CYBOFLOW_ORCH_TOKEN).toBeUndefined();
    expect(opts.env?.CYBOFLOW_ORCH_TOKEN_FILE).toBe(`${FAKE_REMOTE_ROOT}/run/panel-remote.token`);

    // The spawner the SDK would call: the remote binary, never the SDK's local command.
    const session = rt.sessions[0];
    expect(session.mkdirs).toEqual([`${FAKE_REMOTE_ROOT}/artifacts/runs/panel-remote`]);
    // Single-shot (warm off): the process is gone, so its lease was released...
    expect(session.released).toBe(true);
    expect(session.releaseCalls).toBe(1);
    // ...and the released session refuses a late spawn.
    expect(() => opts.spawnClaudeCodeProcess?.({
      command: '/local/claude', args: [], cwd: REMOTE_WT, env: {}, signal: new AbortController().signal,
    })).toThrow();

    // Nothing (bundle / overlay) was written into a same-named LOCAL directory.
    expect(fs.existsSync(REMOTE_WT)).toBe(false);
  });

  it('a warm remote process keeps its lease across turns; a warm push gives its prepared lease back', async () => {
    const builder = scenario()
      .systemInit({ sessionId: SDK_SESSION })
      .assistantText('turn one')
      .resultSuccess()
      .assistantText('turn two')
      .resultSuccess()
      // A third scripted turn keeps the process alive (warm-idle) after turn two.
      .assistantText('turn three')
      .resultSuccess();
    fakeSdk.setScenario(builder);
    const rt = fakeRuntime();
    setRemoteRuntime(rt);
    const mgr = new ClaudeCodeManager(makeSessionManager(null), undefined, undefined, db);
    mgr.setOrchSocketPath('/tmp/remote-itest.sock');
    const base = {
      panelId: 'p-warm-remote',
      sessionId: 'p-warm-remote',
      worktreePath: REMOTE_WT,
      permissionMode: 'ignore' as const,
      hostId: 'host-1',
    };

    // Turn 1 — cold spawn adopts session #1 (still warm afterwards: not released).
    await mgr.spawnCliProcess({ ...base, prompt: 'first' });
    expect(rt.sessions).toHaveLength(1);
    expect(rt.sessions[0].released).toBe(false);
    expect(rt.sessions[0].fenceCalls).toBe(1); // F1: the cold spawn fenced its spawnKey first
    const spawner = fakeSdk.calls[0].spawnClaudeCodeProcess;
    expect(spawner).toBeTypeOf('function');
    const proc = spawner?.({
      command: '/local/sdk/claude',
      args: ['--output-format', 'stream-json'],
      cwd: REMOTE_WT,
      env: { ...(fakeSdk.calls[0].env ?? {}) },
      signal: new AbortController().signal,
    });
    expect(rt.sessions[0].spawned[0].spec.command).toBe(`${FAKE_TOOLCHAIN}/claude`);
    rt.sessions[0].spawned[0].child.exit(0);
    expect(proc?.exitCode).toBe(0);

    // Turn 2 — warm push into the live process: session #2 was prepared for the fingerprint, then given back.
    await mgr.spawnCliProcess({ ...base, prompt: 'second', isResume: true });
    expect(fakeSdk.calls).toHaveLength(1);
    expect(builder.pushed).toEqual(['second']);
    expect(rt.sessions).toHaveLength(2);
    expect(rt.sessions[1].released).toBe(true);
    expect(rt.sessions[0].released).toBe(false);
    expect(rt.sessions[1].fenceCalls).toBe(0); // a warm push never fences the live process

    // Closing the warm process releases the lease it owns.
    await mgr.killProcess('p-warm-remote').catch(() => {});
    for (let i = 0; i < 6; i++) await flush();
    expect(rt.sessions[0].released).toBe(true);
  });

  it('fails an unreachable environment readably and never reaches query()', async () => {
    process.env.CYBOFLOW_DISABLE_WARM_SDK = '1';
    setRemoteRuntime(fakeRuntime(new RemoteRuntimeError('link-down', 'The orchestrator link to this environment is not available: refused')));
    const mgr = new ClaudeCodeManager(makeSessionManager('host-1'), undefined, undefined, db);
    mgr.setOrchSocketPath('/tmp/remote-itest.sock');

    await expect(mgr.spawnClaudeCode('panel-down', 'session-down', REMOTE_WT, 'hello')).rejects.toThrow(/^host-unreachable: /);
    expect(fakeSdk.calls).toHaveLength(0);
  });

  it('fails (never runs locally) when a remote session has no runtime wired', async () => {
    process.env.CYBOFLOW_DISABLE_WARM_SDK = '1';
    const mgr = new ClaudeCodeManager(makeSessionManager('host-1'), undefined, undefined, db);
    mgr.setOrchSocketPath('/tmp/remote-itest.sock');

    await expect(mgr.spawnClaudeCode('panel-x', 'session-x', REMOTE_WT, 'hello')).rejects.toThrow(/Remote environments are not available/);
    expect(fakeSdk.calls).toHaveLength(0);
  });

  it('installs the workflow bundle on the environment before query() and strips it at teardown', async () => {
    process.env.CYBOFLOW_DISABLE_WARM_SDK = '1';
    fakeSdk.setScenario(scenario().systemInit({ sessionId: SDK_SESSION }).assistantText('ok').resultSuccess());
    hooks.bundle = {
      commands: [{ name: 'plan', content: '# plan' }],
      agents: [{ name: 'implement', content: '# implement' }],
      scripts: [],
    };
    const remoteFs = createFakeMachineFs({ [`${REMOTE_WT}/.claude/commands/mine.md`]: 'user command' });
    let atQuery: Record<string, string> | null = null;
    hooks.onQuery = () => {
      atQuery = cyboflowFilesUnder(remoteFs, REMOTE_WT);
    };
    setRemoteRuntime(fakeRuntime(undefined, remoteFs));
    const mgr = new ClaudeCodeManager(makeSessionManager('host-1'), undefined, undefined, db);
    mgr.setOrchSocketPath('/tmp/remote-itest.sock');

    await mgr.spawnClaudeCode('panel-bundle', 'session-bundle', REMOTE_WT, 'hello');

    expect(atQuery).toEqual({
      '.claude/commands/cyboflow-plan.md': '# plan',
      '.claude/agents/cyboflow-implement.md': '# implement',
    });
    expect([...remoteFs.hostIds]).toEqual(['host-1']);
    // The project permission files were read on the environment, not on this Mac.
    expect(remoteFs.ops).toContain(`stat:${REMOTE_WT}/.claude/settings.json`);
    // Single-shot: the process ended, so the (queued) teardown strips the bundle on the environment.
    for (let i = 0; i < 6; i++) await flush();
    expect(cyboflowFilesUnder(remoteFs, REMOTE_WT)).toEqual({});
    expect(remoteFs.files.get(`${REMOTE_WT}/.claude/commands/mine.md`)?.data).toBe('user command');
    expect(fs.existsSync(REMOTE_WT)).toBe(false);
  });

  it('B3: a stop while the environment is still preparing never reaches query(), settles the turn, and spares the next spawn', async () => {
    process.env.CYBOFLOW_DISABLE_WARM_SDK = '1';
    fakeSdk.setScenario(scenario().systemInit({ sessionId: SDK_SESSION }).assistantText('ok').resultSuccess());
    const first = createFakeRemoteSession({ runId: 'panel-stop', spawnKey: 'panel-stop' });
    const second = createFakeRemoteSession({ runId: 'panel-stop', spawnKey: 'panel-stop' });
    let resolvePrep: (s: FakeRemoteSession) => void = () => undefined;
    const prepare = vi.fn<RemoteRuntimeLike['prepare']>()
      .mockImplementationOnce(() => new Promise((r) => { resolvePrep = r; }))
      .mockImplementationOnce(async () => second);
    setRemoteRuntime({ resolveHostId: vi.fn(() => null), prepare, removeRunToken: vi.fn(async () => undefined) });
    const mgr = new ClaudeCodeManager(makeSessionManager('host-1'), undefined, undefined, db);
    mgr.setOrchSocketPath('/tmp/remote-itest.sock');
    const exits: Array<{ panelId?: string; exitCode: number | null }> = [];
    mgr.on('exit', (e: { panelId?: string; exitCode: number | null }) => exits.push(e));

    const pending = mgr.spawnCliProcess({ panelId: 'panel-stop', sessionId: 'session-stop', worktreePath: REMOTE_WT, prompt: 'hello' });
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
    await mgr.killProcess('panel-stop');
    resolvePrep(first);

    await expect(pending).resolves.toEqual({ resultText: null });
    expect(fakeSdk.calls).toHaveLength(0);
    expect(first.fenceCalls).toBe(0);
    expect(first.released).toBe(true);
    expect(exits).toEqual([expect.objectContaining({ panelId: 'panel-stop', exitCode: 0 })]);

    // The cancelled spawn's token is gone: the next spawn under the same key runs normally.
    await expect(mgr.spawnCliProcess({ panelId: 'panel-stop', sessionId: 'session-stop', worktreePath: REMOTE_WT, prompt: 'again' }))
      .resolves.toEqual({ resultText: 'ok' });
    expect(fakeSdk.calls).toHaveLength(1);
    expect(second.released).toBe(true);
  });

  it('B3: a stop by the chat run id (Merge / Dismiss on a quick session) cancels a spawn that is still preparing', async () => {
    process.env.CYBOFLOW_DISABLE_WARM_SDK = '1';
    fakeSdk.setScenario(scenario().systemInit({ sessionId: SDK_SESSION }).assistantText('ok').resultSuccess());
    const session = createFakeRemoteSession({ runId: 'chat-run-1', spawnKey: 'panel-chat' });
    let resolvePrep: (s: FakeRemoteSession) => void = () => undefined;
    const prepare = vi.fn<RemoteRuntimeLike['prepare']>().mockImplementationOnce(() => new Promise((r) => { resolvePrep = r; }));
    setRemoteRuntime({ resolveHostId: vi.fn(() => null), prepare, removeRunToken: vi.fn(async () => undefined) });
    const mgr = new ClaudeCodeManager(makeSessionManager('host-1'), undefined, undefined, db);
    mgr.setOrchSocketPath('/tmp/remote-itest.sock');
    // A quick session: the gate run is the chat sentinel, not the panel id.
    mgr.setChatSentinelProvider(() => 'chat-run-1');

    const pending = mgr.spawnCliProcess({ panelId: 'panel-chat', sessionId: 'session-chat', worktreePath: REMOTE_WT, prompt: 'hello' });
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
    expect(prepare.mock.calls[0]).toEqual(['host-1', { runId: 'chat-run-1', spawnKey: 'panel-chat' }]);
    await mgr.killProcess('chat-run-1'); // SubstrateDispatchFacade.endSession / killSession
    resolvePrep(session);

    await expect(pending).resolves.toEqual({ resultText: null });
    expect(fakeSdk.calls).toHaveLength(0);
    expect(session.released).toBe(true);
  });

  it('leaves a This Mac session unchanged (no spawner, local MCP entry, token in env)', async () => {
    process.env.CYBOFLOW_DISABLE_WARM_SDK = '1';
    fakeSdk.setScenario(scenario().systemInit({ sessionId: SDK_SESSION }).assistantText('ok').resultSuccess());
    const rt = fakeRuntime();
    setRemoteRuntime(rt);
    const mgr = new ClaudeCodeManager(makeSessionManager(null), undefined, undefined, db);
    mgr.setOrchSocketPath('/tmp/local-itest.sock');

    await mgr.spawnClaudeCode('panel-local', 'session-local', '/tmp/local-itest-wt', 'hello');

    expect(rt.prepare).not.toHaveBeenCalled();
    expect(rt.resolveHostId).toHaveBeenCalledWith({ runId: 'panel-local', sessionId: 'session-local' });
    expect(fakeSdk.calls).toHaveLength(1);
    const opts = fakeSdk.calls[0];
    expect(opts.spawnClaudeCodeProcess).toBeUndefined();
    expect(opts.cwd).toBe('/tmp/local-itest-wt');
    const cyboflow = opts.mcpServers?.['cyboflow'] as { command: string; args: string[]; env: Record<string, string> };
    expect(cyboflow.command).toBe('node');
    expect(cyboflow.args).toEqual(['/mock/mcp-server.js']);
    expect(cyboflow.env.CYBOFLOW_ORCH_SOCKET).toBe('/tmp/local-itest.sock');
    expect(typeof cyboflow.env.CYBOFLOW_ORCH_TOKEN).toBe('string');
    expect(cyboflow.env.CYBOFLOW_ORCH_TOKEN_FILE).toBeUndefined();
  });
});
