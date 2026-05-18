/**
 * Unit tests for registerCyboflowHandlers (main/src/ipc/cyboflow.ts).
 *
 * Behaviors covered (per TASK-354 acceptance criteria):
 *
 * AC1/2 (main-process side):
 *   - cyboflow:listWorkflows returns success + 5 seeded workflow rows when the
 *     project has no existing workflows (auto-seed path)
 *   - cyboflow:listWorkflows returns the cached rows on a second call (no
 *     duplicate seeding)
 *   - cyboflow:startRun returns { success: false } when the project is not found
 *   - cyboflow:startRun delegates to RunLauncher.launch and returns
 *     { success: true, data: { runId, worktreePath, branchName } }
 *
 * AC for approveRun stub:
 *   - cyboflow:approveRun always returns { success: false, error: /NOT_IMPLEMENTED/ }
 *
 * All tests use an in-memory better-sqlite3 database with the WorkflowRegistry
 * schema applied inline.  RunLauncher is replaced with a vi.fn() stub so no
 * actual worktree or filesystem operations are triggered.
 *
 * IMPORTANT: cyboflow.ts uses module-level lazy singletons (_workflowRegistry,
 * _runLauncher).  Each describe block resets the module via vi.resetModules()
 * to guarantee a clean singleton state per test suite.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { AppServices } from '../types';
import type { LoggerLike } from '../../orchestrator/types';
import { REGISTRY_SCHEMA } from '../../database/__test_fixtures__/registrySchema';
import { dbAdapter } from '../../orchestrator/__test_fixtures__/dbAdapter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(REGISTRY_SCHEMA);
  return db;
}

function makeSilentLogger(): LoggerLike {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/**
 * Capture handlers registered via ipcMain.handle so they can be invoked
 * directly in tests, bypassing the real Electron IPC stack.
 */
function makeHandlerCapture() {
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const ipcMain = {
    handle: vi.fn(
      (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => {
        handlers.set(channel, fn);
      },
    ),
  };
  return { ipcMain, handlers };
}

/** Invoke a captured handler with a fake IpcMainInvokeEvent + args. */
async function invoke(
  handlers: Map<string, (...args: unknown[]) => Promise<unknown>>,
  channel: string,
  args: unknown,
): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler registered for channel: ${channel}`);
  // ipcMain.handle callbacks receive (event, ...args) — we pass a stub event.
  return fn({} as unknown, args);
}

// ---------------------------------------------------------------------------
// Build a minimal AppServices stub, wiring the real in-memory DB and
// WorkflowRegistry while stubbing everything else.
// ---------------------------------------------------------------------------

function makeServices(
  db: Database.Database,
  overrides: Partial<AppServices> = {},
): AppServices {
  return {
    databaseService: {
      getDb: () => db,
    } as unknown as AppServices['databaseService'],
    sessionManager: {
      getProjectById: vi.fn(),
    } as unknown as AppServices['sessionManager'],
    worktreeManager: {
      createDeterministicWorktree: vi.fn(),
    } as unknown as AppServices['worktreeManager'],
    // Remaining fields are stubs — cyboflow.ts does not touch them.
    app: {} as unknown as AppServices['app'],
    configManager: {} as unknown as AppServices['configManager'],
    cliManagerFactory: {} as unknown as AppServices['cliManagerFactory'],
    claudeCodeManager: {} as unknown as AppServices['claudeCodeManager'],
    gitDiffManager: {} as unknown as AppServices['gitDiffManager'],
    gitStatusManager: {} as unknown as AppServices['gitStatusManager'],
    executionTracker: {} as unknown as AppServices['executionTracker'],
    runCommandManager: {} as unknown as AppServices['runCommandManager'],
    versionChecker: {} as unknown as AppServices['versionChecker'],
    stravuAuthManager: {} as unknown as AppServices['stravuAuthManager'],
    stravuNotebookService: {} as unknown as AppServices['stravuNotebookService'],
    taskQueue: null,
    getMainWindow: () => null,
    logger: undefined,
    ...overrides,
  } as unknown as AppServices;
}

// ---------------------------------------------------------------------------
// Tests
//
// cyboflow.ts uses module-level lazy singletons (_workflowRegistry,
// _runLauncher) that are initialised on the first handler call and cached
// for the lifetime of the module.  To give each test suite a clean slate we
// use vi.resetModules() + a dynamic import so each describe block gets a
// fresh module instance with null singletons.
// ---------------------------------------------------------------------------

describe('registerCyboflowHandlers — cyboflow:listWorkflows', () => {
  let db: Database.Database;

  beforeEach(() => {
    vi.resetModules();
    db = createTestDb();
  });

  it('registers a handler for the channel', async () => {
    const { registerCyboflowHandlers } = await import('../cyboflow');
    const { ipcMain, handlers } = makeHandlerCapture();
    registerCyboflowHandlers(
      ipcMain as unknown as Parameters<typeof registerCyboflowHandlers>[0],
      makeServices(db),
    );
    expect(handlers.has('cyboflow:listWorkflows')).toBe(true);
  });

  it('auto-seeds 5 workflows when the project has none and returns them', async () => {
    const { registerCyboflowHandlers } = await import('../cyboflow');
    const { ipcMain, handlers } = makeHandlerCapture();
    registerCyboflowHandlers(
      ipcMain as unknown as Parameters<typeof registerCyboflowHandlers>[0],
      makeServices(db),
    );

    // The default seed paths point at non-existent $HOME paths.
    // WorkflowRegistry.seed falls back to permission_mode "default" for
    // missing files — the rows are still inserted (no throw).
    const result = await invoke(handlers, 'cyboflow:listWorkflows', { projectId: 42 }) as {
      success: boolean;
      data?: Array<{ name: string }>;
      error?: string;
    };

    expect(result.success).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data).toHaveLength(5);

    const names = result.data!.map((r) => r.name).sort();
    expect(names).toEqual(['compound', 'planner', 'prune', 'soloflow', 'sprint']);
  });

  it('returns the same 5 rows on a second call (idempotent seed)', async () => {
    const { registerCyboflowHandlers } = await import('../cyboflow');
    const { ipcMain, handlers } = makeHandlerCapture();
    registerCyboflowHandlers(
      ipcMain as unknown as Parameters<typeof registerCyboflowHandlers>[0],
      makeServices(db),
    );

    await invoke(handlers, 'cyboflow:listWorkflows', { projectId: 42 });
    const second = await invoke(handlers, 'cyboflow:listWorkflows', { projectId: 42 }) as {
      success: boolean;
      data?: Array<{ name: string }>;
    };

    expect(second.success).toBe(true);
    expect(second.data).toHaveLength(5);
  });

  it('returns success: false when args cause the registry to throw', async () => {
    const { registerCyboflowHandlers } = await import('../cyboflow');
    // Pass a databaseService whose getDb() returns an object that throws on
    // prepare() — simulates a closed or corrupt DB.
    const brokenDb = {
      prepare: () => { throw new Error('DB is closed'); },
      transaction: () => { throw new Error('DB is closed'); },
    } as unknown as Database.Database;
    const services = makeServices(brokenDb);

    const { ipcMain, handlers } = makeHandlerCapture();
    registerCyboflowHandlers(
      ipcMain as unknown as Parameters<typeof registerCyboflowHandlers>[0],
      services,
    );

    const result = await invoke(handlers, 'cyboflow:listWorkflows', { projectId: 1 }) as {
      success: boolean;
      error?: string;
    };

    expect(result.success).toBe(false);
    expect(typeof result.error).toBe('string');
  });
});

describe('registerCyboflowHandlers — cyboflow:startRun', () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    vi.resetModules();
    db = createTestDb();
    tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-ipc-test-'));
  });

  it('registers a handler for the channel', async () => {
    const { registerCyboflowHandlers } = await import('../cyboflow');
    const { ipcMain, handlers } = makeHandlerCapture();
    registerCyboflowHandlers(
      ipcMain as unknown as Parameters<typeof registerCyboflowHandlers>[0],
      makeServices(db),
    );
    expect(handlers.has('cyboflow:startRun')).toBe(true);
  });

  it('returns success: false when the project is not found', async () => {
    const { registerCyboflowHandlers } = await import('../cyboflow');
    const services = makeServices(db);
    const getProjectById = services.sessionManager.getProjectById as ReturnType<typeof vi.fn>;
    getProjectById.mockReturnValue(undefined);

    const { ipcMain, handlers } = makeHandlerCapture();
    registerCyboflowHandlers(
      ipcMain as unknown as Parameters<typeof registerCyboflowHandlers>[0],
      services,
    );

    const result = await invoke(handlers, 'cyboflow:startRun', {
      workflowId: 'some-workflow-id',
      projectId: 999,
    }) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('returns { success: true, data: { runId, worktreePath, branchName } } on happy path', async () => {
    const { registerCyboflowHandlers } = await import('../cyboflow');
    const services = makeServices(db);

    // Stub worktreeManager so no real FS work is done.
    const wm = services.worktreeManager as unknown as {
      createDeterministicWorktree: ReturnType<typeof vi.fn>;
    };
    wm.createDeterministicWorktree.mockResolvedValue({
      worktreePath: `${tmpDir}/worktree`,
      branchName: 'cyboflow/test-run',
    });

    const getProjectById = services.sessionManager.getProjectById as ReturnType<typeof vi.fn>;
    getProjectById.mockReturnValue({ id: 1, path: tmpDir, name: 'test-project' });

    const { ipcMain, handlers } = makeHandlerCapture();
    registerCyboflowHandlers(
      ipcMain as unknown as Parameters<typeof registerCyboflowHandlers>[0],
      services,
    );

    // First, seed workflows for projectId 1 so the registry has a workflow row
    await invoke(handlers, 'cyboflow:listWorkflows', { projectId: 1 });

    // Retrieve the workflowId that was just seeded
    interface IdRow { id: string }
    const row = db
      .prepare('SELECT id FROM workflows WHERE project_id = 1 LIMIT 1')
      .get() as IdRow | undefined;
    expect(row).toBeDefined();
    const workflowId = row!.id;

    const result = await invoke(handlers, 'cyboflow:startRun', {
      workflowId,
      projectId: 1,
    }) as {
      success: boolean;
      data?: { runId: string; worktreePath: string; branchName: string };
      error?: string;
    };

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(typeof result.data!.runId).toBe('string');
    expect(result.data!.runId.length).toBeGreaterThan(0);
    expect(result.data!.worktreePath).toBeTruthy();
    expect(result.data!.branchName).toBeTruthy();
  });
});

describe('registerCyboflowHandlers — cyboflow:mcp-health', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('registers a handler for the channel', async () => {
    const { registerCyboflowHandlers } = await import('../cyboflow');
    const db = createTestDb();
    const { ipcMain, handlers } = makeHandlerCapture();
    registerCyboflowHandlers(
      ipcMain as unknown as Parameters<typeof registerCyboflowHandlers>[0],
      makeServices(db),
    );
    expect(handlers.has('cyboflow:mcp-health')).toBe(true);
  });

  it('returns { status: starting, restartAttempts: 0 } when health singleton has not been injected', async () => {
    const { registerCyboflowHandlers } = await import('../cyboflow');
    const db = createTestDb();
    const { ipcMain, handlers } = makeHandlerCapture();
    registerCyboflowHandlers(
      ipcMain as unknown as Parameters<typeof registerCyboflowHandlers>[0],
      makeServices(db),
    );

    // No setCyboflowHealth() call — singleton is null
    const result = await invoke(handlers, 'cyboflow:mcp-health', undefined) as {
      status: string;
      restartAttempts: number;
      lastError?: string;
    };

    expect(result.status).toBe('starting');
    expect(result.restartAttempts).toBe(0);
    expect(result.lastError).toBeUndefined();
  });

  it('delegates to OrchestratorHealth.getMcpServerStatus() after setCyboflowHealth()', async () => {
    const { registerCyboflowHandlers, setCyboflowHealth } = await import('../cyboflow');
    const db = createTestDb();
    const { ipcMain, handlers } = makeHandlerCapture();
    registerCyboflowHandlers(
      ipcMain as unknown as Parameters<typeof registerCyboflowHandlers>[0],
      makeServices(db),
    );

    // Inject a mock OrchestratorHealth
    const mockStatus = { status: 'running' as const, restartAttempts: 1, lastError: undefined };
    const mockHealth = {
      getMcpServerStatus: vi.fn(() => mockStatus),
      setMcpError: vi.fn(),
    };
    setCyboflowHealth(mockHealth as unknown as Parameters<typeof setCyboflowHealth>[0]);

    const result = await invoke(handlers, 'cyboflow:mcp-health', undefined) as {
      status: string;
      restartAttempts: number;
    };

    expect(result.status).toBe('running');
    expect(result.restartAttempts).toBe(1);
    expect(mockHealth.getMcpServerStatus).toHaveBeenCalledOnce();
  });

  it('returns lastError from the health snapshot when the MCP server has failed', async () => {
    const { registerCyboflowHandlers, setCyboflowHealth } = await import('../cyboflow');
    const db = createTestDb();
    const { ipcMain, handlers } = makeHandlerCapture();
    registerCyboflowHandlers(
      ipcMain as unknown as Parameters<typeof registerCyboflowHandlers>[0],
      makeServices(db),
    );

    const mockHealth = {
      getMcpServerStatus: vi.fn(() => ({
        status: 'failed' as const,
        restartAttempts: 2,
        lastError: 'subprocess exited with code 1',
      })),
      setMcpError: vi.fn(),
    };
    setCyboflowHealth(mockHealth as unknown as Parameters<typeof setCyboflowHealth>[0]);

    const result = await invoke(handlers, 'cyboflow:mcp-health', undefined) as {
      status: string;
      restartAttempts: number;
      lastError?: string;
    };

    expect(result.status).toBe('failed');
    expect(result.lastError).toBe('subprocess exited with code 1');
    expect(result.restartAttempts).toBe(2);
  });
});

describe('registerCyboflowHandlers — cyboflow:approveRun', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('registers a handler for the channel', async () => {
    const { registerCyboflowHandlers } = await import('../cyboflow');
    const db = createTestDb();
    const { ipcMain, handlers } = makeHandlerCapture();
    registerCyboflowHandlers(
      ipcMain as unknown as Parameters<typeof registerCyboflowHandlers>[0],
      makeServices(db),
    );
    expect(handlers.has('cyboflow:approveRun')).toBe(true);
  });

  it('returns success: false with a NOT_IMPLEMENTED error message', async () => {
    const { registerCyboflowHandlers } = await import('../cyboflow');
    const db = createTestDb();
    const { ipcMain, handlers } = makeHandlerCapture();
    registerCyboflowHandlers(
      ipcMain as unknown as Parameters<typeof registerCyboflowHandlers>[0],
      makeServices(db),
    );

    const result = await invoke(handlers, 'cyboflow:approveRun', {
      runId: 'any-run',
      approvalId: 'any-approval',
      decision: 'allow',
    }) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/NOT_IMPLEMENTED/i);
  });

  it('returns NOT_IMPLEMENTED for deny decision as well', async () => {
    const { registerCyboflowHandlers } = await import('../cyboflow');
    const db = createTestDb();
    const { ipcMain, handlers } = makeHandlerCapture();
    registerCyboflowHandlers(
      ipcMain as unknown as Parameters<typeof registerCyboflowHandlers>[0],
      makeServices(db),
    );

    const result = await invoke(handlers, 'cyboflow:approveRun', {
      runId: 'any-run',
      approvalId: 'any-approval',
      decision: 'deny',
    }) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/NOT_IMPLEMENTED/i);
  });
});
