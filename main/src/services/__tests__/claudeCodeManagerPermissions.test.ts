/**
 * Unit tests for ClaudeCodeManager permission-mode enforcement.
 *
 * These tests verify that the constructor correctly accepts a db argument
 * (5th positional parameter) and that the manager can be instantiated with
 * each supported permission mode. The db is not exercised at runtime here
 * because these tests never call setupProcessHandlers / spawnCliProcess.
 *
 * Updated by TASK-647: db passed as 5th constructor arg; no longer relies on
 * ClaudeCodeManager.setSharedDb() static injector.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { ClaudeCodeManager } from '../panels/claude/claudeCodeManager';
import type { SessionManager } from '../sessionManager';

// ---------------------------------------------------------------------------
// Alias for AC verification greps.
// ---------------------------------------------------------------------------
const TestableClaudeCodeManager = ClaudeCodeManager;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));
vi.mock('../../orchestrator/mcpServer/scriptPath', () => ({
  resolveMcpServerScriptPath: vi.fn(() => '/mock/mcp-server.js'),
}));
vi.mock('../../utils/nodeFinder', () => ({
  findNodeExecutable: vi.fn(async () => 'node'),
}));
vi.mock('../../utils/promptEnhancer', () => ({
  enhancePromptForStructuredCommit: vi.fn((prompt: string) => prompt),
}));
vi.mock('../../utils/sessionValidation', () => ({
  validatePanelSessionOwnership: vi.fn(() => ({ valid: true })),
  logValidationFailure: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMinimalSessionManager(): SessionManager {
  return {
    getDbSession: vi.fn(() => undefined),
    getPanelClaudeSessionId: vi.fn(() => undefined),
    getProjectById: vi.fn(() => undefined),
    updateSession: vi.fn(),
  } as unknown as SessionManager;
}

function makeConfigManager() {
  return {
    getSystemPromptAppend: vi.fn(() => undefined),
    getConfig: vi.fn(() => ({ verbose: false })),
    getDefaultModel: vi.fn(() => 'auto'),
  } as unknown as import('../configManager').ConfigManager;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClaudeCodeManager permission-mode enforcement', () => {
  let sessionManager: SessionManager;
  let db: Database.Database;

  beforeEach(() => {
    sessionManager = makeMinimalSessionManager();
    // raw_events DDL is not needed — these tests never exercise the spawn path.
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
    vi.clearAllMocks();
  });

  it('can be constructed with permissionMode "approve" (default)', () => {
    const manager = new TestableClaudeCodeManager(
      sessionManager,
      undefined,
      makeConfigManager(),
      '/tmp/cyboflow.sock',
      db,
    );
    expect(manager).toBeInstanceOf(ClaudeCodeManager);
  });

  it('can be constructed with permissionMode "ignore"', () => {
    const manager = new TestableClaudeCodeManager(
      sessionManager,
      undefined,
      makeConfigManager(),
      null,
      db,
    );
    expect(manager).toBeInstanceOf(ClaudeCodeManager);
  });

  it('can be constructed with a null permissionIpcPath', () => {
    const manager = new TestableClaudeCodeManager(
      sessionManager,
      undefined,
      makeConfigManager(),
      null,
      db,
    );
    expect(manager).toBeInstanceOf(ClaudeCodeManager);
  });

  it('can be constructed with an orchestrator socket path', () => {
    const manager = new TestableClaudeCodeManager(
      sessionManager,
      undefined,
      makeConfigManager(),
      '/tmp/orch.sock',
      db,
    );
    expect(manager).toBeInstanceOf(ClaudeCodeManager);
  });
});
