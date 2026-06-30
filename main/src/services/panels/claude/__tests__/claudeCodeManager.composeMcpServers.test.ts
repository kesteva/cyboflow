/**
 * Hermetic unit tests for ClaudeCodeManager.composeMcpServers() eager-populate
 * behavior introduced in TASK-619.
 *
 * Design:
 *   - vi.mock stubs out nodeFinder and scriptPath — no real subprocess or FS access.
 *   - TestableClaudeCodeManager subclass exposes composeMcpServers() publicly so
 *     tests can call it directly without going through a full spawnCliProcess().
 *   - SessionManager stub returns a session WITHOUT project_id so
 *     getBaseProjectMcpServers() always returns {} (no FS reads needed).
 *
 * Four acceptance tests:
 *   1. eager-population: setOrchSocketPath → composeMcpServers → cyboflow.command
 *      equals the resolved path (never bare 'node').
 *   2. single-invocation: findNodeExecutable is called exactly once after
 *      setOrchSocketPath, regardless of how many composeMcpServers calls follow.
 *   3. reject→omit: when findNodeExecutable rejects, composeMcpServers logs
 *      logger.warn and omits the cyboflow key entirely.
 *   4. never-called: when orchSocketPath is never set, composeMcpServers returns
 *      no cyboflow entry and findNodeExecutable is never invoked.
 */

import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import type Database from 'better-sqlite3';
import { ApprovalRouter } from '../../../../orchestrator/approvalRouter';
import { createTestDb } from '../../../../orchestrator/__test_fixtures__/orchestratorTestDb';
import { dbAdapter } from '../../../../orchestrator/__test_fixtures__/dbAdapter';
import { ClaudeCodeManager, mcpDenyListSdkGuards } from '../claudeCodeManager';
import type { SessionManager } from '../../../sessionManager';
import type { Logger } from '../../../../utils/logger';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';

// ---------------------------------------------------------------------------
// Hoisted mock controls — must be declared before vi.mock() calls
// ---------------------------------------------------------------------------

const { findNodeExecutableMock } = vi.hoisted(() => {
  const findNodeExecutableMock = vi.fn<() => Promise<string>>(async () => '/mock/path/node');
  return { findNodeExecutableMock };
});

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../../../utils/nodeFinder', () => ({
  findNodeExecutable: findNodeExecutableMock,
}));

vi.mock('../../../../orchestrator/mcpServer/scriptPath', () => ({
  resolveMcpServerScriptPath: vi.fn(() => '/mock/mcp-server.js'),
}));

// SDK is mocked so spawnCliProcess tests in sibling files don't conflict
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(async function* () {
    yield { type: 'result', subtype: 'success' } as unknown;
  }),
}));

vi.mock('../../../../utils/promptEnhancer', () => ({
  enhancePromptForStructuredCommit: vi.fn((prompt: string) => prompt),
}));

vi.mock('../../../../utils/sessionValidation', () => ({
  validatePanelSessionOwnership: vi.fn(() => ({ valid: true })),
  logValidationFailure: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Minimal SessionManager stub — always returns a session WITHOUT project_id
// so getBaseProjectMcpServers() short-circuits to {} with no FS access.
// ---------------------------------------------------------------------------

function createMockSessionManager(): SessionManager {
  return {
    getDbSession: vi.fn(() => ({ id: 'stub-session' })), // no project_id
    getPanelClaudeSessionId: vi.fn(() => undefined),
    getProjectById: vi.fn(() => undefined),
    updateSession: vi.fn(),
  } as unknown as SessionManager;
}

// ---------------------------------------------------------------------------
// Minimal logger spy
// ---------------------------------------------------------------------------

function createLoggerSpy(): { warn: MockInstance; info: MockInstance; error: MockInstance; verbose: MockInstance } {
  return {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    verbose: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// TestableClaudeCodeManager — exposes composeMcpServers() publicly for testing
// ---------------------------------------------------------------------------

/**
 * Thin subclass that promotes the private composeMcpServers() method to public
 * so tests can call it directly without going through a full spawnCliProcess()
 * lifecycle (which would need a running SDK query, etc.).
 */
class TestableClaudeCodeManager extends ClaudeCodeManager {
  async publicComposeMcpServers(sessionId: string, runId?: string): Promise<Record<string, McpServerConfig>> {
    // composeMcpServers is private on the parent; cast via index signature
    return (this as unknown as {
      composeMcpServers(opts: { sessionId: string; runId?: string }): Promise<Record<string, McpServerConfig>>;
    }).composeMcpServers({ sessionId, runId } as Parameters<ClaudeCodeManager['composeMcpServers' & keyof ClaudeCodeManager]>[0]);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClaudeCodeManager.composeMcpServers — eager node path resolution', () => {
  let db: Database.Database;
  let mgr: TestableClaudeCodeManager;
  let loggerSpy: ReturnType<typeof createLoggerSpy>;

  beforeEach(() => {
    db = createTestDb();
    loggerSpy = createLoggerSpy();
    findNodeExecutableMock.mockReset();
    findNodeExecutableMock.mockResolvedValue('/mock/path/node');

    const adapter = dbAdapter(db);
    ApprovalRouter.initialize(adapter);

    mgr = new TestableClaudeCodeManager(
      createMockSessionManager(),
      loggerSpy as unknown as Logger,
      {
        getSystemPromptAppend: vi.fn(() => undefined),
        getConfig: vi.fn(() => ({ verbose: false })),
      } as unknown as import('../../../configManager').ConfigManager,
      db,
    );
  });

  afterEach(() => {
    ApprovalRouter._resetForTesting();
    db.close();
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Test 1: eager-population
  // ---------------------------------------------------------------------------
  it('eager-populates node path before first composeMcpServers call — cyboflow.command is never bare "node"', async () => {
    // setOrchSocketPath() kicks off findNodeExecutable eagerly.
    mgr.setOrchSocketPath('/tmp/test.sock');

    // Allow the eager promise to resolve (microtask tick).
    await Promise.resolve();

    const result = await mgr.publicComposeMcpServers('test-session');

    expect(result).toHaveProperty('cyboflow');
    const cyboflow = result['cyboflow'] as { command: string; args: string[] };
    // Must use the resolved path, never the bare 'node' fallback.
    expect(cyboflow.command).toBe('/mock/path/node');
    expect(cyboflow.args).toContain('/mock/mcp-server.js');
  });

  // ---------------------------------------------------------------------------
  // Test 2: single invocation across N composeMcpServers calls
  // ---------------------------------------------------------------------------
  it('invokes findNodeExecutable exactly once per setOrchSocketPath regardless of session count', async () => {
    mgr.setOrchSocketPath('/tmp/test.sock');

    // Three consecutive composeMcpServers calls (simulating 3 sessions).
    await mgr.publicComposeMcpServers('session-1');
    await mgr.publicComposeMcpServers('session-2');
    await mgr.publicComposeMcpServers('session-3');

    // findNodeExecutable must have been called exactly once — at setOrchSocketPath time.
    expect(findNodeExecutableMock).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // Test 3: reject → omit cyboflow entry
  // ---------------------------------------------------------------------------
  it('omits cyboflow entry and calls logger.warn when findNodeExecutable rejects', async () => {
    findNodeExecutableMock.mockRejectedValueOnce(new Error('node not found'));

    mgr.setOrchSocketPath('/tmp/test.sock');

    const result = await mgr.publicComposeMcpServers('test-session');

    // cyboflow key must NOT be present — no broken command:'node' fallback.
    expect(result).not.toHaveProperty('cyboflow');

    // logger.warn must have been called describing the omission.
    expect(loggerSpy.warn).toHaveBeenCalledWith(
      expect.stringContaining('omitting cyboflow MCP entry'),
    );
  });

  // ---------------------------------------------------------------------------
  // Test 4: never called when orchSocketPath is unset
  // ---------------------------------------------------------------------------
  it('does not invoke findNodeExecutable and returns no cyboflow entry when orchSocketPath is never set', async () => {
    // setOrchSocketPath() is deliberately NOT called.
    const result = await mgr.publicComposeMcpServers('test-session');

    // cyboflow must be absent.
    expect(result).not.toHaveProperty('cyboflow');

    // findNodeExecutable must never have been touched.
    expect(findNodeExecutableMock).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Test 5: CYBOFLOW_RUN_ID prefers the real runId over sessionId (workflow run)
  // ---------------------------------------------------------------------------
  it('sets CYBOFLOW_RUN_ID to the real runId when runId is a non-empty string distinct from sessionId', async () => {
    mgr.setOrchSocketPath('/tmp/test.sock');
    await Promise.resolve();

    const result = await mgr.publicComposeMcpServers('sess-uuid', 'run-real-id');

    expect(result).toHaveProperty('cyboflow');
    const cyboflow = result['cyboflow'] as { env: Record<string, string> };
    // The real workflow_runs.id wins over the Claude session UUID.
    expect(cyboflow.env.CYBOFLOW_RUN_ID).toBe('run-real-id');
  });

  // ---------------------------------------------------------------------------
  // Test 6: CYBOFLOW_RUN_ID falls back to sessionId when runId is absent
  // ---------------------------------------------------------------------------
  it('falls back to sessionId for CYBOFLOW_RUN_ID when runId is undefined (quick-session path)', async () => {
    mgr.setOrchSocketPath('/tmp/test.sock');
    await Promise.resolve();

    const result = await mgr.publicComposeMcpServers('sess-uuid');

    expect(result).toHaveProperty('cyboflow');
    const cyboflow = result['cyboflow'] as { env: Record<string, string> };
    // No runId supplied → legacy fallback to the session id.
    expect(cyboflow.env.CYBOFLOW_RUN_ID).toBe('sess-uuid');
  });
});

// ---------------------------------------------------------------------------
// Per-session MCP deny-list (migration 036 / Slice 4 — read-at-spawn).
// composeMcpServers deletes each name in sessions.disabled_mcp_servers_json from
// the composed record, NEVER the 'cyboflow' entry; an empty/missing/malformed
// list is byte-identical to the prior behavior.
// ---------------------------------------------------------------------------

describe('ClaudeCodeManager.composeMcpServers — per-session MCP deny-list', () => {
  let db: Database.Database;
  let loggerSpy: ReturnType<typeof createLoggerSpy>;

  beforeEach(() => {
    db = createTestDb();
    loggerSpy = createLoggerSpy();
    findNodeExecutableMock.mockReset();
    findNodeExecutableMock.mockResolvedValue('/mock/path/node');
    const adapter = dbAdapter(db);
    ApprovalRouter.initialize(adapter);
  });

  afterEach(() => {
    ApprovalRouter._resetForTesting();
    db.close();
    vi.clearAllMocks();
  });

  // Build a manager whose getDbSession returns the given row, so the deny-list
  // column can be controlled per test.
  function makeManagerWithSession(dbRow: Record<string, unknown>): TestableClaudeCodeManager {
    const sessionManager = {
      getDbSession: vi.fn(() => dbRow),
      getPanelClaudeSessionId: vi.fn(() => undefined),
      getProjectById: vi.fn(() => undefined),
      updateSession: vi.fn(),
    } as unknown as SessionManager;
    return new TestableClaudeCodeManager(
      sessionManager,
      loggerSpy as unknown as Logger,
      {
        getSystemPromptAppend: vi.fn(() => undefined),
        getConfig: vi.fn(() => ({ verbose: false })),
      } as unknown as import('../../../configManager').ConfigManager,
      db,
    );
  }

  // Inject base project MCP servers (getBaseProjectMcpServers normally reads the
  // FS; stub it so the deny-list filter has something to remove without FS).
  function stubBaseServers(mgr: TestableClaudeCodeManager, servers: Record<string, unknown>): void {
    vi.spyOn(
      mgr as unknown as {
        getBaseProjectMcpServers(sessionId: string): { mcpServers: Record<string, unknown> };
      },
      'getBaseProjectMcpServers',
    ).mockReturnValue({ mcpServers: { ...servers } });
  }

  it('removes a disabled MCP server from the composed record (leaves others)', async () => {
    const mgr = makeManagerWithSession({ id: 's1', disabled_mcp_servers_json: JSON.stringify(['peekaboo']) });
    stubBaseServers(mgr, { peekaboo: { command: 'peekaboo' }, ripgrep: { command: 'rg' } });

    const result = await mgr.publicComposeMcpServers('s1');

    expect(result).not.toHaveProperty('peekaboo');
    expect(result).toHaveProperty('ripgrep');
    expect(loggerSpy.info).toHaveBeenCalledWith(expect.stringContaining('Removed disabled MCP server'));
  });

  it("never removes the 'cyboflow' server even when it is in the deny-list", async () => {
    // orchSocket is deliberately NOT set, so no injection happens — the filter
    // itself must skip 'cyboflow'.
    const mgr = makeManagerWithSession({ id: 's1', disabled_mcp_servers_json: JSON.stringify(['cyboflow', 'peekaboo']) });
    stubBaseServers(mgr, { cyboflow: { command: 'pre-existing' }, peekaboo: { command: 'p' }, ripgrep: { command: 'rg' } });

    const result = await mgr.publicComposeMcpServers('s1');

    expect(result).toHaveProperty('cyboflow'); // skipped by the guard, never deleted
    expect(result).toHaveProperty('ripgrep');
    expect(result).not.toHaveProperty('peekaboo'); // a non-cyboflow deny still applies
  });

  it('empty [] deny-list leaves the composed record byte-identical', async () => {
    const mgr = makeManagerWithSession({ id: 's1', disabled_mcp_servers_json: '[]' });
    stubBaseServers(mgr, { peekaboo: { command: 'p' }, ripgrep: { command: 'rg' } });

    const result = await mgr.publicComposeMcpServers('s1');

    expect(result).toEqual({ peekaboo: { command: 'p' }, ripgrep: { command: 'rg' } });
    expect(loggerSpy.info).not.toHaveBeenCalledWith(expect.stringContaining('Removed disabled MCP server'));
  });

  it('missing column → no removal (byte-identical legacy path)', async () => {
    const mgr = makeManagerWithSession({ id: 's1' }); // no disabled_mcp_servers_json
    stubBaseServers(mgr, { peekaboo: { command: 'p' } });

    const result = await mgr.publicComposeMcpServers('s1');

    expect(result).toEqual({ peekaboo: { command: 'p' } });
  });

  it('malformed JSON in the deny-list column → no removal', async () => {
    const mgr = makeManagerWithSession({ id: 's1', disabled_mcp_servers_json: 'not-json' });
    stubBaseServers(mgr, { peekaboo: { command: 'p' } });

    const result = await mgr.publicComposeMcpServers('s1');

    expect(result).toEqual({ peekaboo: { command: 'p' } });
  });
});

// ---------------------------------------------------------------------------
// mcpDenyListSdkGuards — the spawn-time ENFORCEMENT guards. composeMcpServers'
// deletion alone is defeated by settingSources re-loading the server from
// ~/.claude.json; these guards (strictMcpConfig + disallowedTools) close the gap.
// ---------------------------------------------------------------------------

describe('mcpDenyListSdkGuards — deny-list spawn enforcement', () => {
  it('empty deny-list → no guards (deny-free spawn stays byte-identical)', () => {
    expect(mcpDenyListSdkGuards([])).toEqual({});
  });

  it('a disabled server → strictMcpConfig + disallow its mcp__ tools', () => {
    expect(mcpDenyListSdkGuards(['fal-ai'])).toEqual({
      strictMcpConfig: true,
      disallowedTools: ['mcp__fal-ai'],
    });
  });

  it('multiple disabled servers → one disallow entry each', () => {
    expect(mcpDenyListSdkGuards(['fal-ai', 'peekaboo'])).toEqual({
      strictMcpConfig: true,
      disallowedTools: ['mcp__fal-ai', 'mcp__peekaboo'],
    });
  });

  it("never enforces against 'cyboflow' (orchestrator socket); a cyboflow-only list is a no-op", () => {
    expect(mcpDenyListSdkGuards(['cyboflow'])).toEqual({});
    expect(mcpDenyListSdkGuards(['cyboflow', 'fal-ai'])).toEqual({
      strictMcpConfig: true,
      disallowedTools: ['mcp__fal-ai'],
    });
  });
});
