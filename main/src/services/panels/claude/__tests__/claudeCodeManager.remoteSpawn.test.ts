/**
 * M2 B2 — the Claude SDK remote-spawn branch of ClaudeCodeManager, unit level:
 *  - buildSdkOptions(remote): an EXCLUSIVE cyboflow-only mcpServers map with remote node/bundle/socket and the orch
 *    token only as a FILE path (that JSON lands on the claude argv), no base-project merge; remote cwd/executable +
 *    spawnClaudeCodeProcess; an allowlisted env with no process.env spread; no local path anywhere in the options
 *    the SDK turns into args. The local options stay unchanged;
 *  - computeOptionsFingerprint: `host` + `cwd` fields, stable for the same remote inputs.
 * Host resolution / prepare / the spawn factory are unit-tested in services/hosts/__tests__/remoteClaudeSpawn.test.ts;
 * the full spawn path (SDK invoked with the spawner, lease release) is claudeCodeManager.remoteSpawn.itest.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { Options, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { ApprovalRouter } from '../../../../orchestrator/approvalRouter';
import { QuestionRouter } from '../../../../orchestrator/questionRouter';
import { dbAdapter } from '../../../../orchestrator/__test_fixtures__/dbAdapter';
import { createTestDb } from '../../../../orchestrator/__test_fixtures__/orchestratorTestDb';
import { mintOrchToken } from '../../../../orchestrator/orchAuthToken';
import type { MergedPermissionRules } from '../../../../orchestrator/permissionRules';
import { ClaudeCodeManager, type ClaudeSpawnOptions } from '../claudeCodeManager';
import type { RemoteRuntimeSession } from '../../../hosts/remoteRuntime';
import {
  createFakeRemoteSession,
  FAKE_REMOTE_NODE,
  FAKE_REMOTE_ROOT,
  FAKE_REMOTE_SOCK,
  FAKE_TOOLCHAIN,
  type FakeRemoteSession,
} from '../../../hosts/__tests__/fakeRemoteRuntimeSession';
import type { SessionManager } from '../../../sessionManager';
import type { Logger } from '../../../../utils/logger';

const LOCAL_NODE = '/Users/local/.nvm/versions/node/v22.15.1/bin/node';
const LOCAL_MCP = '/mock/local/mcp-server.js';
const LOCAL_SOCK = '/tmp/remote-spawn-test.sock';
const REMOTE_WT = `${FAKE_REMOTE_ROOT}/worktrees/wt-1`;

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(async function* () {
    yield { type: 'result', subtype: 'success' } as unknown;
  }),
}));
vi.mock('../../../../orchestrator/mcpServer/scriptPath', () => ({
  resolveMcpServerScriptPath: vi.fn(() => LOCAL_MCP),
}));
vi.mock('../../../../utils/nodeFinder', () => ({
  findNodeExecutable: vi.fn(async () => LOCAL_NODE),
}));
vi.mock('../../../../utils/shellPath', () => ({
  getShellPath: vi.fn(() => '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'),
}));
vi.mock('../../../../utils/sessionValidation', () => ({
  validatePanelSessionOwnership: vi.fn(() => ({ valid: true })),
  logValidationFailure: vi.fn(),
}));
vi.mock('../../../../orchestrator/permissionRules', async (orig) => {
  const actual = await orig<typeof import('../../../../orchestrator/permissionRules')>();
  return { ...actual, loadMergedPermissionRules: vi.fn(() => ({ allow: [], deny: [], ask: [] })) };
});

function createMockSessionManager(): SessionManager {
  return {
    getDbSession: vi.fn(() => ({ id: 'stub-session' })),
    getPanelClaudeSessionId: vi.fn(() => undefined),
    getProjectById: vi.fn(() => undefined),
    updateSession: vi.fn(),
  } as unknown as SessionManager;
}

function makeConfigManager(): import('../../../configManager').ConfigManager {
  return {
    getSystemPromptAppend: vi.fn(() => undefined),
    getConfig: vi.fn(() => ({ verbose: false })),
    getDefaultAgentPermissionMode: vi.fn(() => 'default'),
  } as unknown as import('../../../configManager').ConfigManager;
}

interface Privates {
  buildSdkOptions(o: ClaudeSpawnOptions, rules?: MergedPermissionRules, remote?: RemoteRuntimeSession | null): Promise<Options>;
  computeOptionsFingerprint(
    sdkOptions: Options,
    worktreePath: string,
    runId: string,
    rules?: MergedPermissionRules,
    hostId?: string | null,
  ): { combined: string; fields: Record<string, string> };
  getBaseProjectMcpServers(sessionId: string): { mcpServers: Record<string, unknown> };
}

class TestableClaudeCodeManager extends ClaudeCodeManager {
  protected override getInstalledPluginIds(): string[] {
    return [];
  }
  get p(): Privates {
    return this as unknown as Privates;
  }
}

const NO_RULES: MergedPermissionRules = { allow: [], deny: [], ask: [] };

function spawnOpts(over: Partial<ClaudeSpawnOptions> = {}): ClaudeSpawnOptions {
  return {
    panelId: 'run-r1',
    sessionId: 'session-1',
    runId: 'run-r1',
    worktreePath: REMOTE_WT,
    prompt: 'hi',
    ...over,
  };
}

describe('ClaudeCodeManager — remote spawn branch (M2 B2)', () => {
  let db: Database.Database;
  let mgr: TestableClaudeCodeManager;
  let session: FakeRemoteSession;

  beforeEach(() => {
    db = createTestDb({ includeSubstrate: true });
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_permission_mode TEXT)');
    const adapter = dbAdapter(db);
    ApprovalRouter.initialize(adapter);
    QuestionRouter.initialize(adapter);
    mgr = new TestableClaudeCodeManager(
      createMockSessionManager(),
      { warn: vi.fn(), info: vi.fn(), verbose: vi.fn(), error: vi.fn() } as unknown as Logger,
      makeConfigManager(),
      db,
    );
    mgr.setOrchSocketPath(LOCAL_SOCK);
    session = createFakeRemoteSession({ runId: 'run-r1' });
    process.env.CYBOFLOW_TEST_LOCAL_ONLY_MARKER = '/Users/local/secret';
    process.env.SOME_LOCAL_NOISE = 'noise';
  });

  afterEach(() => {
    delete process.env.CYBOFLOW_TEST_LOCAL_ONLY_MARKER;
    delete process.env.SOME_LOCAL_NOISE;
    ApprovalRouter._resetForTesting();
    QuestionRouter._resetForTesting();
    db.close();
    vi.restoreAllMocks();
  });

  describe('mcpServers (remote)', () => {
    it('is EXCLUSIVE and cyboflow-only, with remote node/bundle/socket and the token as a FILE', async () => {
      const baseSpy = vi.spyOn(mgr.p, 'getBaseProjectMcpServers');
      const servers = (await mgr.p.buildSdkOptions(spawnOpts(), NO_RULES, session)).mcpServers ?? {};

      expect(Object.keys(servers)).toEqual(['cyboflow']);
      expect(baseSpy).not.toHaveBeenCalled();
      expect(servers.cyboflow).toEqual({
        command: FAKE_REMOTE_NODE,
        args: [`${FAKE_TOOLCHAIN}/cyboflowMcpServer.js`],
        env: {
          CYBOFLOW_RUN_ID: 'run-r1',
          CYBOFLOW_ORCH_SOCKET: FAKE_REMOTE_SOCK,
          CYBOFLOW_ORCH_TOKEN_FILE: `${FAKE_REMOTE_ROOT}/run/run-r1.token`,
        },
        alwaysLoad: true,
      });
      const json = JSON.stringify(servers);
      expect(json).not.toContain(mintOrchToken('run-r1'));
      expect(json).not.toContain('"CYBOFLOW_ORCH_TOKEN"');
      expect(json).not.toContain('ELECTRON_RUN_AS_NODE');
      expect(json).not.toContain(LOCAL_NODE);
      expect(json).not.toContain(LOCAL_MCP);
      expect(json).not.toContain(LOCAL_SOCK);
    });

    it('carries the MCP scope tag, and a legacy quick session keys the run by its session id', async () => {
      const servers = (await mgr.p.buildSdkOptions(spawnOpts({ mcpScope: 'design', runId: '' }), NO_RULES, session)).mcpServers ?? {};
      const env = (servers.cyboflow as { env: Record<string, string> }).env;
      expect(env.CYBOFLOW_MCP_SCOPE).toBe('design');
      expect(env.CYBOFLOW_RUN_ID).toBe('session-1');
    });

    it('leaves the LOCAL entry unchanged (local node, local bundle, token in env)', async () => {
      const servers = (await mgr.p.buildSdkOptions(spawnOpts({ worktreePath: '/tmp/wt' }), NO_RULES)).mcpServers ?? {};
      const entry = servers.cyboflow as { command: string; args: string[]; env: Record<string, string> };
      expect(entry.command).toBe(LOCAL_NODE);
      expect(entry.args).toEqual([LOCAL_MCP]);
      expect(entry.env.CYBOFLOW_ORCH_SOCKET).toBe(LOCAL_SOCK);
      expect(entry.env.CYBOFLOW_ORCH_TOKEN).toBe(mintOrchToken('run-r1'));
      expect(entry.env.CYBOFLOW_ORCH_TOKEN_FILE).toBeUndefined();
    });
  });

  describe('buildSdkOptions (remote)', () => {
    it('sets the remote cwd + executable + spawner and an allowlisted env', async () => {
      const opts = await mgr.p.buildSdkOptions(spawnOpts({ laneEnv: { LANE_SLOT: 's1' } }), NO_RULES, session);

      expect(opts.cwd).toBe(REMOTE_WT);
      expect(opts.pathToClaudeCodeExecutable).toBe(`${FAKE_TOOLCHAIN}/claude`);
      expect(typeof opts.spawnClaudeCodeProcess).toBe('function');

      const env = opts.env ?? {};
      expect(env.PATH).toBe('/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin');
      expect(env.HOME).toBe('/Users/remote');
      expect(env.CYBOFLOW_RUN_ARTIFACTS_DIR).toBe(`${FAKE_REMOTE_ROOT}/artifacts/runs/run-r1`);
      expect(env.CYBOFLOW_ORCH_SOCKET).toBe(FAKE_REMOTE_SOCK);
      expect(env.CYBOFLOW_ORCH_TOKEN_FILE).toBe(`${FAKE_REMOTE_ROOT}/run/run-r1.token`);
      expect(env.CYBOFLOW_MANAGED_TEST_CONCURRENCY).toBe('1');
      expect(env.LANE_SLOT).toBe('s1');
      expect(env).not.toHaveProperty('CYBOFLOW_ORCH_TOKEN');
      expect(env).not.toHaveProperty('SOME_LOCAL_NOISE');
      expect(env).not.toHaveProperty('CYBOFLOW_TEST_LOCAL_ONLY_MARKER');
    });

    it('produces nothing the SDK would turn into a LOCAL-path arg', async () => {
      const opts = await mgr.p.buildSdkOptions(spawnOpts(), NO_RULES, session);
      expect(opts.additionalDirectories).toBeUndefined();
      expect(opts.plugins).toBeUndefined();
      expect(opts.debugFile).toBeUndefined();
      expect(opts.executableArgs).toBeUndefined();
      expect(opts.extraArgs).toBeUndefined();
      const json = JSON.stringify(opts);
      for (const local of [LOCAL_NODE, LOCAL_MCP, LOCAL_SOCK, '/Users/local', '/opt/homebrew/bin:/usr/local/bin']) {
        expect(json).not.toContain(local);
      }
    });

    it('the installed spawner runs the remote binary and ignores the SDK command', async () => {
      const opts = await mgr.p.buildSdkOptions(spawnOpts(), NO_RULES, session);
      const sdkSpawn: SpawnOptions = {
        command: '/local/sdk/claude',
        args: ['--output-format', 'stream-json'],
        cwd: REMOTE_WT,
        env: { ...(opts.env ?? {}), CLAUDE_CODE_SDK_READS_SESSION_STATE: '1' },
        signal: new AbortController().signal,
      };
      opts.spawnClaudeCodeProcess?.(sdkSpawn);
      expect(session.spawned).toHaveLength(1);
      const { spec } = session.spawned[0];
      expect(spec.command).toBe(`${FAKE_TOOLCHAIN}/claude`);
      expect(spec.cwd).toBe(REMOTE_WT);
      expect(spec.withTokenEnvFile).toBe(true);
      expect(spec.env?.CLAUDE_CODE_SDK_READS_SESSION_STATE).toBe('1');
      expect(spec.env?.CYBOFLOW_RUN_ARTIFACTS_DIR).toBe(`${FAKE_REMOTE_ROOT}/artifacts/runs/run-r1`);
    });

    it('keeps the LOCAL options unchanged: no spawner, no remote executable, process env inherited', async () => {
      const opts = await mgr.p.buildSdkOptions(spawnOpts({ worktreePath: '/tmp/wt' }), NO_RULES);
      expect(opts.spawnClaudeCodeProcess).toBeUndefined();
      expect(opts.pathToClaudeCodeExecutable).toBeUndefined();
      expect(opts.cwd).toBe('/tmp/wt');
      expect(opts.env?.SOME_LOCAL_NOISE).toBe('noise');
    });
  });

  describe('computeOptionsFingerprint', () => {
    it('folds the host and the cwd in, and is stable for the same remote inputs', async () => {
      const a = await mgr.p.buildSdkOptions(spawnOpts(), NO_RULES, session);
      const b = await mgr.p.buildSdkOptions(spawnOpts(), NO_RULES, session);
      const fpA = mgr.p.computeOptionsFingerprint(a, REMOTE_WT, 'run-r1', NO_RULES, 'host-1');
      const fpB = mgr.p.computeOptionsFingerprint(b, REMOTE_WT, 'run-r1', NO_RULES, 'host-1');
      expect(fpA.combined).toBe(fpB.combined);
      expect(fpA.fields.host).toBeDefined();
      expect(fpA.fields.cwd).toBeDefined();

      const otherHost = mgr.p.computeOptionsFingerprint(a, REMOTE_WT, 'run-r1', NO_RULES, 'host-2');
      expect(otherHost.fields.host).not.toBe(fpA.fields.host);
      expect(otherHost.combined).not.toBe(fpA.combined);

      const local = mgr.p.computeOptionsFingerprint(a, REMOTE_WT, 'run-r1', NO_RULES);
      const localExplicit = mgr.p.computeOptionsFingerprint(a, REMOTE_WT, 'run-r1', NO_RULES, null);
      expect(local.fields.host).toBe(localExplicit.fields.host);
      expect(local.fields.host).not.toBe(fpA.fields.host);

      const otherCwd = mgr.p.computeOptionsFingerprint({ ...a, cwd: `${REMOTE_WT}-2` }, REMOTE_WT, 'run-r1', NO_RULES, 'host-1');
      expect(otherCwd.fields.cwd).not.toBe(fpA.fields.cwd);
      expect(otherCwd.fields.host).toBe(fpA.fields.host);
    });
  });
});
