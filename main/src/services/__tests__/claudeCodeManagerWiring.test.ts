/**
 * Integration tests for ClaudeCodeManager pipeline wiring.
 *
 * Verifies that a spawned Claude run:
 *   1. Instantiates ClaudeStreamParser + EventRouter + RawEventsSink + CompletionDetector.
 *   2. PTY data chunks fed through parseCliOutput land in raw_events via RawEventsSink.
 *   3. CompletionDetector emits 'complete' after all three signals arrive.
 *   4. killProcess disposes the pipeline (no watchdog timer leak).
 *
 * Uses an in-memory better-sqlite3 database and a mock PTY instead of spawning
 * a real Claude process.
 *
 * Note: ClaudeCodeManager.spawnCliProcess performs several async operations
 * (availability check, env setup, PTY spawn) that require deep mocking. To
 * exercise the wiring logic in isolation, this test hooks into
 * setupProcessHandlers (via a thin TestableManager subclass) and parseCliOutput
 * directly, bypassing the full spawn path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import { ClaudeCodeManager } from '../panels/claude/claudeCodeManager';
import type { SessionManager } from '../sessionManager';
import type { ConfigManager } from '../configManager';

// Mock ApprovalRouter so cleanupCliResources does not throw when the singleton
// is not initialized (this is a unit test — no real Electron/IPC lifecycle).
vi.mock('../../orchestrator/approvalRouter', () => ({
  ApprovalRouter: {
    getInstance: vi.fn().mockReturnValue({
      clearPendingForRun: vi.fn(),
    }),
  },
}));

// ---------------------------------------------------------------------------
// Schema DDL (matches 006_cyboflow_schema.sql, FK-free for in-memory tests)
// ---------------------------------------------------------------------------

const RAW_EVENTS_DDL = `
  CREATE TABLE IF NOT EXISTS raw_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )
`;

// ---------------------------------------------------------------------------
// Mock PTY — mimics the subset of IPty used by AbstractCliManager
// ---------------------------------------------------------------------------

interface MockPtyHandle {
  pty: MockPty;
  triggerData(data: string): void;
  triggerExit(exitCode: number, signal?: number): void;
}

class MockPty extends EventEmitter {
  public readonly pid = 9999;
  private readonly dataHandlers: Array<(data: string) => void> = [];
  private readonly exitHandlers: Array<(info: { exitCode: number; signal: number | undefined }) => void> = [];

  onData(handler: (data: string) => void): void {
    this.dataHandlers.push(handler);
  }

  onExit(handler: (info: { exitCode: number; signal: number | undefined }) => void): void {
    this.exitHandlers.push(handler);
  }

  // Kill is a no-op in the mock
  kill(): void {}

  fireData(data: string): void {
    for (const h of this.dataHandlers) h(data);
  }

  fireExit(exitCode: number, signal?: number): void {
    for (const h of this.exitHandlers) h({ exitCode, signal });
  }
}

function makeMockPty(): MockPtyHandle {
  const pty = new MockPty();
  return {
    pty,
    triggerData: (data) => pty.fireData(data),
    triggerExit: (exitCode, signal?) => pty.fireExit(exitCode, signal),
  };
}

// ---------------------------------------------------------------------------
// Testable subclass: exposes protected setupProcessHandlers and parseCliOutput
// ---------------------------------------------------------------------------

class TestableClaudeCodeManager extends ClaudeCodeManager {
  /**
   * Drive the pipeline wiring by calling setupProcessHandlers with a mock PTY,
   * bypassing the full spawn path.
   */
  public callSetupProcessHandlers(
    pty: MockPty,
    panelId: string,
    sessionId: string,
  ): void {
    // Cast needed because the base class parameter type references the node-pty IPty interface.
    this.setupProcessHandlers(pty as unknown as import('@homebridge/node-pty-prebuilt-multiarch').IPty, panelId, sessionId);
  }

  /**
   * Drive the line-parsing → pipeline feed path directly.
   */
  public callParseCliOutput(data: string, panelId: string, sessionId: string): void {
    this.parseCliOutput(data, panelId, sessionId);
  }

  /**
   * Expose the private pipelines map for assertion.
   */
  public hasPipeline(panelId: string): boolean {
    return (this as unknown as { pipelines: Map<string, unknown> }).pipelines.has(panelId);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMinimalSessionManager(): SessionManager {
  return {
    getDbSession: vi.fn().mockReturnValue(undefined),
    getPanelClaudeSessionId: vi.fn().mockReturnValue(undefined),
    getProjectById: vi.fn().mockReturnValue(undefined),
    addSessionError: vi.fn(),
  } as unknown as SessionManager;
}

function makeConfigManager(): ConfigManager {
  return {
    getConfig: vi.fn().mockReturnValue({ defaultPermissionMode: 'approve', verbose: false }),
    getSystemPromptAppend: vi.fn().mockReturnValue(undefined),
  } as unknown as ConfigManager;
}

/** A stream-json system/init line Claude would emit. */
const SYSTEM_INIT_LINE =
  '{"type":"system","subtype":"init","session_id":"sess-1","cwd":"/tmp","model":"claude-opus","tools":[],"mcp_servers":[],"permissionMode":"default"}\n';

/** A stream-json result line Claude would emit. */
const RESULT_LINE =
  '{"type":"result","subtype":"success","session_id":"sess-1","result":"done","total_cost_usd":0.01,"is_error":false,"num_turns":1,"duration_ms":1000,"usage":{"input_tokens":10,"output_tokens":5}}\n';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClaudeCodeManager pipeline wiring', () => {
  let db: Database.Database;
  let manager: TestableClaudeCodeManager;
  const PANEL_ID = 'panel-wiring-test';
  const SESSION_ID = 'session-wiring-test';

  beforeEach(() => {
    // Fresh in-memory DB per test
    db = new Database(':memory:');
    db.exec(RAW_EVENTS_DDL);

    // Wire the shared DB
    ClaudeCodeManager.setSharedDb(db);

    manager = new TestableClaudeCodeManager(
      makeMinimalSessionManager(),
      undefined, // logger — undefined in tests
      makeConfigManager(),
      '/tmp/test.sock',
    );
  });

  afterEach(() => {
    // Reset the shared DB to avoid polluting other tests
    ClaudeCodeManager.setSharedDb(null as unknown as Database.Database);
    db.close();
  });

  // -------------------------------------------------------------------------
  // AC-1: setupProcessHandlers creates the pipeline and feeds parseCliOutput
  // -------------------------------------------------------------------------

  it('setupProcessHandlers creates a pipeline tuple for the panel', () => {
    const { pty } = makeMockPty();
    manager.callSetupProcessHandlers(pty, PANEL_ID, SESSION_ID);

    expect(manager.hasPipeline(PANEL_ID)).toBe(true);
  });

  it('parseCliOutput feeds stream-json lines into raw_events via RawEventsSink', () => {
    const { pty } = makeMockPty();
    manager.callSetupProcessHandlers(pty, PANEL_ID, SESSION_ID);

    // Feed two lines through the parser path
    manager.callParseCliOutput(SYSTEM_INIT_LINE, PANEL_ID, SESSION_ID);
    manager.callParseCliOutput(RESULT_LINE, PANEL_ID, SESSION_ID);

    const rows = db.prepare('SELECT event_type FROM raw_events WHERE run_id = ?').all(PANEL_ID) as Array<{ event_type: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.event_type).sort()).toEqual(['result', 'system'].sort());
  });

  // -------------------------------------------------------------------------
  // AC-2: CompletionDetector emits 'complete' after all three signals
  // -------------------------------------------------------------------------

  it('CompletionDetector emits complete after PTY exit (all three gates)', async () => {
    const { pty, triggerData, triggerExit } = makeMockPty();
    manager.callSetupProcessHandlers(pty, PANEL_ID, SESSION_ID);

    // Feed a line to populate the parser
    triggerData(SYSTEM_INIT_LINE);

    // Trigger PTY exit — fires the base-class onExit AND our secondary handler
    // that signals all three gates (signalStdoutEof, signalParserDrained, signalChildExited).
    const completePromise = new Promise<void>((resolve) => {
      // Peek at the detector via the private pipelines map
      const pipelines = (manager as unknown as { pipelines: Map<string, { detector: import('../streamParser').CompletionDetector }> }).pipelines;
      const pl = pipelines.get(PANEL_ID);
      pl?.detector.once('complete', () => resolve());
    });

    triggerExit(0);

    await expect(completePromise).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // AC-3: killProcess disposes the pipeline
  // -------------------------------------------------------------------------

  it('killProcess removes the pipeline tuple (no watchdog leak)', async () => {
    const { pty } = makeMockPty();
    manager.callSetupProcessHandlers(pty, PANEL_ID, SESSION_ID);

    expect(manager.hasPipeline(PANEL_ID)).toBe(true);

    // killProcess calls cleanupPipeline then super.killProcess.
    // super.killProcess calls this.processes.get(panelId) — process was never
    // added to this.processes in this unit test, so the super returns early.
    await manager.killProcess(PANEL_ID);

    expect(manager.hasPipeline(PANEL_ID)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // AC-4: Feeding malformed (non-JSON) data does NOT throw
  // -------------------------------------------------------------------------

  it('feeding non-JSON output does not throw and does not write raw_events rows', () => {
    const { pty } = makeMockPty();
    manager.callSetupProcessHandlers(pty, PANEL_ID, SESSION_ID);

    expect(() => {
      manager.callParseCliOutput('This is not JSON\n', PANEL_ID, SESSION_ID);
    }).not.toThrow();

    const count = (db.prepare('SELECT count(*) as n FROM raw_events WHERE run_id = ?').get(PANEL_ID) as { n: number }).n;
    // Malformed lines produce null from JSONParser → no row written
    expect(count).toBe(0);
  });

  // -------------------------------------------------------------------------
  // AC-5: Degraded-mode — sharedDb is null, no RawEventsSink, no throw
  // -------------------------------------------------------------------------

  it('degraded mode (sharedDb=null): feeding data does not throw and writes zero raw_events rows', () => {
    // Override the shared DB to null before this test's manager is used.
    // The beforeEach already called setSharedDb(db), so we reset to null here.
    ClaudeCodeManager.setSharedDb(null as unknown as Database.Database);

    const { pty } = makeMockPty();
    manager.callSetupProcessHandlers(pty, PANEL_ID, SESSION_ID);

    // The pipeline is still created (parser + router + detector), sink is null.
    expect(manager.hasPipeline(PANEL_ID)).toBe(true);

    // Feeding JSON data must not throw even though there is no sink.
    expect(() => {
      manager.callParseCliOutput(SYSTEM_INIT_LINE, PANEL_ID, SESSION_ID);
    }).not.toThrow();

    // No raw_events rows because RawEventsSink was not attached.
    const count = (db.prepare('SELECT count(*) as n FROM raw_events WHERE run_id = ?').get(PANEL_ID) as { n: number }).n;
    expect(count).toBe(0);

    // Restore the shared DB so afterEach cleanup succeeds.
    ClaudeCodeManager.setSharedDb(db);
  });

  // -------------------------------------------------------------------------
  // AC-6: Multi-panel pipeline isolation — two panels are independent
  // -------------------------------------------------------------------------

  it('two panels each get independent pipelines and events do not cross-contaminate', () => {
    const PANEL_A = 'panel-a-isolation';
    const PANEL_B = 'panel-b-isolation';
    const SESSION_A = 'session-a-isolation';
    const SESSION_B = 'session-b-isolation';

    const { pty: ptyA } = makeMockPty();
    const { pty: ptyB } = makeMockPty();

    manager.callSetupProcessHandlers(ptyA, PANEL_A, SESSION_A);
    manager.callSetupProcessHandlers(ptyB, PANEL_B, SESSION_B);

    // Both panels should have independent pipeline entries.
    expect(manager.hasPipeline(PANEL_A)).toBe(true);
    expect(manager.hasPipeline(PANEL_B)).toBe(true);

    // Feed one event through Panel A only.
    manager.callParseCliOutput(SYSTEM_INIT_LINE, PANEL_A, SESSION_A);

    // Panel A should have 1 raw_events row keyed by its runId (= panelId).
    const rowsA = db.prepare('SELECT event_type FROM raw_events WHERE run_id = ?').all(PANEL_A) as Array<{ event_type: string }>;
    expect(rowsA).toHaveLength(1);

    // Panel B must have 0 rows — events do not leak across pipelines.
    const countB = (db.prepare('SELECT count(*) as n FROM raw_events WHERE run_id = ?').get(PANEL_B) as { n: number }).n;
    expect(countB).toBe(0);

    // Clean up both panels so the afterEach does not leave dangling pipelines.
    void manager.killProcess(PANEL_A);
    void manager.killProcess(PANEL_B);
  });

  // -------------------------------------------------------------------------
  // AC-7: cleanupPipeline is idempotent — killProcess called twice is safe
  // -------------------------------------------------------------------------

  it('calling killProcess twice does not throw (cleanupPipeline is idempotent)', async () => {
    const { pty } = makeMockPty();
    manager.callSetupProcessHandlers(pty, PANEL_ID, SESSION_ID);

    expect(manager.hasPipeline(PANEL_ID)).toBe(true);

    await manager.killProcess(PANEL_ID);
    expect(manager.hasPipeline(PANEL_ID)).toBe(false);

    // Second killProcess: pipeline is already gone, must not throw.
    await expect(manager.killProcess(PANEL_ID)).resolves.toBeUndefined();
    expect(manager.hasPipeline(PANEL_ID)).toBe(false);
  });
});
