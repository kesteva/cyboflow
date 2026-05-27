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
import PQueue from 'p-queue';
import { ApprovalRouter } from '../../../../orchestrator/approvalRouter';
import { createTestDb } from '../../../../orchestrator/__test_fixtures__/orchestratorTestDb';
import { dbAdapter } from '../../../../orchestrator/__test_fixtures__/dbAdapter';
import { ClaudeCodeManager } from '../claudeCodeManager';
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
// Database / ApprovalRouter helpers
// ---------------------------------------------------------------------------

function makeQueueFactory(): { getOrCreate: (runId: string) => PQueue } {
  const queues = new Map<string, PQueue>();
  return {
    getOrCreate(runId: string): PQueue {
      let q = queues.get(runId);
      if (!q) {
        q = new PQueue({ concurrency: 1 });
        queues.set(runId, q);
      }
      return q;
    },
  };
}

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
  async publicComposeMcpServers(sessionId: string): Promise<Record<string, McpServerConfig>> {
    // composeMcpServers is private on the parent; cast via index signature
    return (this as unknown as {
      composeMcpServers(opts: { sessionId: string }): Promise<Record<string, McpServerConfig>>;
    }).composeMcpServers({ sessionId } as Parameters<ClaudeCodeManager['composeMcpServers' & keyof ClaudeCodeManager]>[0]);
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
    const qf = makeQueueFactory();
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
});
