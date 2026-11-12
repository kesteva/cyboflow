/**
 * LC-3 (M2 review): two REMOTE lanes share one session's workflow bundle on the environment. The second lane's
 * install is awaited over ssh; if the session refcount were bumped only AFTER that await, a sibling lane finishing
 * meanwhile would see the old count, drop it to 0 and queue a removal behind the new install — deleting the bundle
 * the new lane just placed. The claim must land before the await (and be released if the install throws).
 *
 * Harness mirrors claudeCodeManager.parallelSpawn.test.ts (the mock query parks on the AbortController); the remote
 * spawn seams (remoteClaudeSpawn.ts) are stubbed so the spawn runs the remote branch without any environment.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { ApprovalRouter } from '../../../../orchestrator/approvalRouter';
import { QuestionRouter } from '../../../../orchestrator/questionRouter';
import { dbAdapter } from '../../../../orchestrator/__test_fixtures__/dbAdapter';
import { createTestDb } from '../../../../orchestrator/__test_fixtures__/orchestratorTestDb';
import type { SessionManager } from '../../../sessionManager';

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  const queryFn = vi.fn((params: { prompt: string; options?: { abortController?: AbortController } }) => {
    return (async function* () {
      yield { type: 'system', subtype: 'init' } as unknown;
      const abortController = params.options?.abortController;
      if (abortController) {
        await new Promise<void>((resolve) => {
          if (abortController.signal.aborted) {
            resolve();
            return;
          }
          abortController.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      }
    })();
  });
  return { query: queryFn };
});
vi.mock('../../../orchestrator/mcpServer/scriptPath', () => ({
  resolveMcpServerScriptPath: vi.fn(() => '/mock/mcp-server.js'),
}));
vi.mock('../../../utils/nodeFinder', () => ({
  findNodeExecutable: vi.fn(async () => 'node'),
}));
vi.mock('../../../utils/sessionValidation', () => ({
  validatePanelSessionOwnership: vi.fn(() => ({ valid: true })),
  logValidationFailure: vi.fn(),
}));

const remoteSeams = vi.hoisted(() => ({
  install: vi.fn<() => Promise<void>>(),
  remove: vi.fn<() => Promise<void>>(),
}));
vi.mock('../../../hosts/remoteClaudeSpawn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../hosts/remoteClaudeSpawn')>();
  const fakeSession = { hostId: 'h-ssh', release: () => undefined, fence: async () => undefined };
  return {
    ...actual,
    resolveClaudeSpawnHostId: () => 'h-ssh',
    prepareRemoteClaudeSpawn: async () => fakeSession,
    loadRemoteSpawnPermissionRules: async () => actual.emptyPermissionRules(),
    remoteBundleTarget: (_s: unknown, worktreePath: string) => ({ hostId: 'h-ssh', port: {}, worktreePath }),
    remoteClaudeMcpServers: () => ({}),
    remoteClaudeRunEnv: () => ({}),
    remoteClaudeSdkOptions: () => ({}),
    installRemoteWorkflowBundle: remoteSeams.install,
    removeRemoteWorkflowBundle: remoteSeams.remove,
  };
});

import { ClaudeCodeManager } from '../claudeCodeManager';

function createMockSessionManager(): SessionManager {
  return {
    getDbSession: vi.fn(() => undefined),
    getPanelClaudeSessionId: vi.fn(() => undefined),
    getProjectById: vi.fn(() => undefined),
    updateSession: vi.fn(),
  } as unknown as SessionManager;
}

function bundleRefcount(m: ClaudeCodeManager): Map<string, number> {
  return (m as unknown as { bundleRefcountBySession: Map<string, number> }).bundleRefcountBySession;
}
function isLive(m: ClaudeCodeManager, spawnKey: string): boolean {
  const priv = m as unknown as { sdkRuns: Map<string, unknown>; processes: Map<string, unknown>; pipelines: Map<string, unknown> };
  return priv.sdkRuns.has(spawnKey) && priv.processes.has(spawnKey) && priv.pipelines.has(spawnKey);
}
async function until(cond: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await Promise.resolve();
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe('ClaudeCodeManager — remote shared-bundle refcount (LC-3)', () => {
  let db: Database.Database;
  let mgr: ClaudeCodeManager;
  const runId = 'run-remote-bundle';
  const keyA = `${runId}:t1`;
  const keyB = `${runId}:t2`;
  const spawn = (spawnKey: string) =>
    mgr.spawnCliProcess({
      panelId: runId, sessionId: runId, runId, worktreePath: '/remote/wt/q',
      prompt: spawnKey, permissionMode: 'ignore', spawnKey,
    });

  beforeEach(() => {
    db = createTestDb();
    const adapter = dbAdapter(db);
    ApprovalRouter.initialize(adapter);
    QuestionRouter.initialize(adapter);
    mgr = new ClaudeCodeManager(createMockSessionManager(), undefined, undefined, db);
    remoteSeams.install.mockReset();
    remoteSeams.remove.mockReset();
    remoteSeams.remove.mockResolvedValue(undefined);
  });

  afterEach(() => {
    ApprovalRouter._resetForTesting();
    QuestionRouter._resetForTesting();
    db.close();
    vi.clearAllMocks();
  });

  it('a sibling lane finishing during the second lane\'s awaited install does not strip the bundle', async () => {
    // Lane A installs and parks (refcount 1).
    remoteSeams.install.mockResolvedValueOnce(undefined);
    const spawnA = spawn(keyA);
    await until(() => isLive(mgr, keyA), 'lane A');
    expect(bundleRefcount(mgr).get(runId)).toBe(1);

    // Lane B's install is in flight over ssh.
    let finishInstall: () => void = () => undefined;
    remoteSeams.install.mockImplementationOnce(() => new Promise<void>((resolve) => (finishInstall = resolve)));
    const spawnB = spawn(keyB);
    await until(() => remoteSeams.install.mock.calls.length === 2, 'lane B install');

    // Lane A finishes WHILE B's install is pending: B is already counted, so nothing is removed.
    await mgr.killProcess(keyA);
    await spawnA;
    expect(remoteSeams.remove).not.toHaveBeenCalled();
    expect(bundleRefcount(mgr).get(runId)).toBe(1);

    // B's install lands and B runs; the bundle goes only when B (the genuinely last lane) finishes.
    finishInstall();
    await until(() => isLive(mgr, keyB), 'lane B');
    await mgr.killProcess(keyB);
    await spawnB;
    expect(remoteSeams.remove).toHaveBeenCalledTimes(1);
    expect(bundleRefcount(mgr).has(runId)).toBe(false);
  });

  it('a throwing install releases its claim (the last sibling can still strip the bundle)', async () => {
    remoteSeams.install.mockResolvedValueOnce(undefined);
    const spawnA = spawn(keyA);
    await until(() => isLive(mgr, keyA), 'lane A');

    remoteSeams.install.mockRejectedValueOnce(new Error('install boom'));
    await expect(spawn(keyB)).rejects.toThrow('install boom');
    expect(bundleRefcount(mgr).get(runId)).toBe(1);
    expect(remoteSeams.remove).not.toHaveBeenCalled();

    await mgr.killProcess(keyA);
    await spawnA;
    expect(remoteSeams.remove).toHaveBeenCalledTimes(1);
    expect(bundleRefcount(mgr).has(runId)).toBe(false);
  });
});
