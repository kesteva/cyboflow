/**
 * F13 — permission-rule settings files are read ONCE per SDK spawn.
 *
 * During a spawn, `loadMergedPermissionRules` (which reads ~/.claude/settings.json
 * + the project's .claude/settings.json[.local]) used to run TWICE: once for the
 * options fingerprint (computeOptionsFingerprint) and once for the PreToolUse hook
 * / canUseTool construction (composeHookOptions). spawnCliProcess now loads it ONCE
 * into a deep-frozen snapshot shared by both, so a spawn reads those files once.
 *
 * REVIEWED NO-SHIP: there is NO cross-turn / mtime cache — a stale cache could keep
 * a revoked auto-approval rule active. The dedup is WITHIN a single spawn only, so
 * every turn still re-reads disk (asserted below across two turns).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { ApprovalRouter } from '../../../../orchestrator/approvalRouter';
import { QuestionRouter } from '../../../../orchestrator/questionRouter';
import { loadMergedPermissionRules } from '../../../../orchestrator/permissionRules';
import { dbAdapter } from '../../../../orchestrator/__test_fixtures__/dbAdapter';
import { createTestDb } from '../../../../orchestrator/__test_fixtures__/orchestratorTestDb';
import {
  createModuleFakeSdk,
  scenario,
  ScenarioBuilder,
  type FakeQueryParams,
} from '../../../../test/fakes/fakeSdk';
import { ClaudeCodeManager } from '../claudeCodeManager';
import { ModelAvailabilityService } from '../../../modelAvailabilityService';
import type { SessionManager } from '../../../sessionManager';

const SESSION_UUID = 'sess-f13-uuid';

const fakeSdk = createModuleFakeSdk();

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: FakeQueryParams) => fakeSdk.query(params),
}));
vi.mock('../../../../orchestrator/mcpServer/scriptPath', () => ({
  resolveMcpServerScriptPath: vi.fn(() => '/mock/mcp-server.js'),
}));
vi.mock('../../../../utils/nodeFinder', () => ({
  findNodeExecutable: vi.fn(async () => 'node'),
}));
vi.mock('../../../../utils/promptEnhancer', () => ({
  enhancePromptForStructuredCommit: vi.fn((prompt: string) => prompt),
}));
// Count the merged-rules loads while returning an empty rule set (no auto-allow),
// so the spawn proceeds normally and the call count is the assertion surface.
vi.mock('../../../../orchestrator/permissionRules', async (orig) => {
  const actual = await orig<typeof import('../../../../orchestrator/permissionRules')>();
  return {
    ...actual,
    loadMergedPermissionRules: vi.fn(() => ({ allow: [] as string[], deny: [] as string[] })),
  };
});

function createMockSessionManager(): SessionManager {
  return {
    getDbSession: vi.fn(() => undefined),
    getPanelClaudeSessionId: vi.fn(() => SESSION_UUID),
    getProjectById: vi.fn(() => undefined),
    updateSession: vi.fn(),
  } as unknown as SessionManager;
}

function getSdkRuns(mgr: ClaudeCodeManager): Map<string, unknown> {
  return (mgr as unknown as { sdkRuns: Map<string, unknown> }).sdkRuns;
}

/** A two-turn scenario so the warm session parks between turns (a second turn re-reads). */
function twoTurnScenario(): ScenarioBuilder {
  return scenario()
    .systemInit({ sessionId: SESSION_UUID })
    .assistantText('one')
    .resultSuccess()
    .assistantText('two')
    .resultSuccess();
}

describe('ClaudeCodeManager — F13 permission-rule read dedup', () => {
  let db: Database.Database;
  let mgr: ClaudeCodeManager;

  beforeEach(() => {
    fakeSdk.reset();
    vi.mocked(loadMergedPermissionRules).mockClear();
    ModelAvailabilityService._resetForTesting();
    ModelAvailabilityService.initialize();
    db = createTestDb();
    const adapter = dbAdapter(db);
    ApprovalRouter.initialize(adapter);
    QuestionRouter.initialize(adapter);
    mgr = new ClaudeCodeManager(createMockSessionManager(), undefined, undefined, db);
  });

  afterEach(async () => {
    for (const key of Array.from(getSdkRuns(mgr).keys())) {
      await mgr.killProcess(key).catch(() => {});
    }
    ApprovalRouter._resetForTesting();
    QuestionRouter._resetForTesting();
    ModelAvailabilityService._resetForTesting();
    db.close();
    vi.clearAllMocks();
  });

  it('reads the merged permission rules exactly ONCE per cold spawn', async () => {
    const panelId = 'p-f13-cold';
    fakeSdk.setScenario(twoTurnScenario());

    await mgr.spawnCliProcess({
      panelId,
      sessionId: panelId,
      worktreePath: '/tmp/wt',
      prompt: 'first',
      permissionMode: 'ignore',
    });

    // One load for the whole spawn — shared by the fingerprint AND the hook/canUseTool
    // (it was two before F13).
    expect(vi.mocked(loadMergedPermissionRules)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(loadMergedPermissionRules)).toHaveBeenCalledWith('/tmp/wt');
  });

  it('re-reads once on the NEXT turn (no cross-turn cache) — a warm push loads afresh', async () => {
    const panelId = 'p-f13-warm';
    fakeSdk.setScenario(twoTurnScenario());

    // Turn 1 (cold) → 1 load.
    await mgr.spawnCliProcess({
      panelId,
      sessionId: panelId,
      worktreePath: '/tmp/wt',
      prompt: 'first',
      permissionMode: 'ignore',
    });
    expect(vi.mocked(loadMergedPermissionRules)).toHaveBeenCalledTimes(1);

    // Turn 2 (warm push) — spawnCliProcess still fingerprints the spawn options, so
    // it re-reads disk ONCE. Proves the dedup is per-spawn, not a stale cross-turn cache.
    await mgr.spawnCliProcess({
      panelId,
      sessionId: panelId,
      worktreePath: '/tmp/wt',
      prompt: 'second',
      permissionMode: 'ignore',
      isResume: true,
    });
    expect(fakeSdk.calls).toHaveLength(1); // warm push, no respawn
    expect(vi.mocked(loadMergedPermissionRules)).toHaveBeenCalledTimes(2); // 1 per turn
  });
});
