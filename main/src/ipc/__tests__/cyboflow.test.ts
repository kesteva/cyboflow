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
 * schema applied inline.  No vi.resetModules() is needed because WorkflowRegistry
 * and RunLauncher are no longer module-level singletons — each test gets its own
 * instances via makeServices().
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { AppServices } from '../types';
import { RunLauncher } from '../../orchestrator/runLauncher';
import type { OrchSocketProvider, BridgeScriptResolver, NodeResolver } from '../../orchestrator/runLauncher';
import type { McpConfigWriter } from '../../orchestrator/mcpConfigWriter';
import { WorkflowRegistry } from '../../orchestrator/workflowRegistry';
import { REGISTRY_SCHEMA } from '../../database/__test_fixtures__/registrySchema';
import { dbAdapter } from '../../orchestrator/__test_fixtures__/dbAdapter';
import { makeSpyLogger } from '../../orchestrator/__test_fixtures__/loggerLikeSpy';
import { withTempDir } from '../../__test_fixtures__/tmp';
import { registerCyboflowHandlers, setCyboflowHealth } from '../cyboflow';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(REGISTRY_SCHEMA);
  return db;
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
// Stub collaborators for RunLauncher (used in makeServices)
// ---------------------------------------------------------------------------

const stubOrchSocketProvider: OrchSocketProvider = {
  getSocketPath: () => '/tmp/test-orch.sock',
};

const stubBridgeScriptResolver: BridgeScriptResolver = {
  getScriptPath: () => '/tmp/test-bridge.js',
};

const stubNodeResolver: NodeResolver = {
  getNodePath: async () => process.execPath,
};

// ---------------------------------------------------------------------------
// Build a minimal AppServices stub, wiring the real in-memory DB and
// WorkflowRegistry/RunLauncher while stubbing everything else.
// Each call returns fresh instances so tests don't share singleton state.
// ---------------------------------------------------------------------------

function makeServices(
  db: Database.Database,
  overrides: Partial<AppServices> = {},
): AppServices {
  const dbLike = dbAdapter(db);
  const logger = makeSpyLogger();
  const workflowRegistry = new WorkflowRegistry(dbLike, logger);

  const stubMcpConfigWriter: McpConfigWriter = {
    writeForRun: vi.fn().mockResolvedValue('/dev/null/.mcp.json'),
  } as unknown as McpConfigWriter;

  const stubWorktreeManager = {
    createDeterministicWorktree: vi.fn(),
  } as unknown as AppServices['worktreeManager'];

  const runLauncher = new RunLauncher(
    dbLike,
    workflowRegistry,
    stubWorktreeManager,
    logger,
    stubMcpConfigWriter,
    stubOrchSocketProvider,
    stubBridgeScriptResolver,
    stubNodeResolver,
  );

  return {
    databaseService: {
      getDb: () => db,
    } as unknown as AppServices['databaseService'],
    sessionManager: {
      getProjectById: vi.fn(),
    } as unknown as AppServices['sessionManager'],
    worktreeManager: stubWorktreeManager,
    cyboflow: { workflowRegistry, runLauncher },
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
// ---------------------------------------------------------------------------

describe('registerCyboflowHandlers — cyboflow:listWorkflows', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('registers a handler for the channel', () => {
    const { ipcMain, handlers } = makeHandlerCapture();
    registerCyboflowHandlers(
      ipcMain as unknown as Parameters<typeof registerCyboflowHandlers>[0],
      makeServices(db),
    );
    expect(handlers.has('cyboflow:listWorkflows')).toBe(true);
  });

  it('auto-seeds 5 workflows when the project has none and returns them', async () => {
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
    // Pass a databaseService whose getDb() returns an object that throws on
    // prepare() — simulates a closed or corrupt DB.
    const brokenDb = {
      prepare: () => { throw new Error('DB is closed'); },
      transaction: () => { throw new Error('DB is closed'); },
    } as unknown as Database.Database;

    const { ipcMain, handlers } = makeHandlerCapture();
    registerCyboflowHandlers(
      ipcMain as unknown as Parameters<typeof registerCyboflowHandlers>[0],
      makeServices(brokenDb),
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

  beforeEach(() => {
    db = createTestDb();
  });

  it('registers a handler for the channel', () => {
    const { ipcMain, handlers } = makeHandlerCapture();
    registerCyboflowHandlers(
      ipcMain as unknown as Parameters<typeof registerCyboflowHandlers>[0],
      makeServices(db),
    );
    expect(handlers.has('cyboflow:startRun')).toBe(true);
  });

  it('returns success: false when the project is not found', async () => {
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
    await withTempDir('cyboflow-ipc-test-', async (tmpDir) => {
      const logger = makeSpyLogger();
      const dbLike = dbAdapter(db);
      const workflowRegistry = new WorkflowRegistry(dbLike, logger);

      // Stub worktreeManager so no real FS work is done.
      const stubWorktreeManager = {
        createDeterministicWorktree: vi.fn().mockResolvedValue({
          worktreePath: `${tmpDir}/worktree`,
          branchName: 'cyboflow/test-run',
        }),
      } as unknown as AppServices['worktreeManager'];

      const stubMcpConfigWriter: McpConfigWriter = {
        writeForRun: vi.fn().mockResolvedValue(`${tmpDir}/.mcp.json`),
      } as unknown as McpConfigWriter;

      const customRunLauncher = new RunLauncher(
        dbLike,
        workflowRegistry,
        stubWorktreeManager,
        logger,
        stubMcpConfigWriter,
        stubOrchSocketProvider,
        stubBridgeScriptResolver,
        stubNodeResolver,
      );

      const services = makeServices(db, {
        worktreeManager: stubWorktreeManager,
        cyboflow: { workflowRegistry, runLauncher: customRunLauncher },
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
});

describe('registerCyboflowHandlers — cyboflow:mcp-health', () => {
  it('registers a handler for the channel', () => {
    const db = createTestDb();
    const { ipcMain, handlers } = makeHandlerCapture();
    registerCyboflowHandlers(
      ipcMain as unknown as Parameters<typeof registerCyboflowHandlers>[0],
      makeServices(db),
    );
    expect(handlers.has('cyboflow:mcp-health')).toBe(true);
  });

  it('returns { status: starting, restartAttempts: 0 } when health singleton has not been injected', async () => {
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

describe('registerCyboflowHandlers — runtime input validation', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  // cyboflow:listRuns
  it('listRuns: undefined args → success: false, error mentions projectId', async () => {
    const { ipcMain, handlers } = makeHandlerCapture();
    registerCyboflowHandlers(
      ipcMain as unknown as Parameters<typeof registerCyboflowHandlers>[0],
      makeServices(db),
    );

    const result = await invoke(handlers, 'cyboflow:listRuns', undefined) as {
      success: boolean;
      error?: string;
    };

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/projectId/);
  });

  it('listRuns: string projectId → success: false, error mentions projectId', async () => {
    const { ipcMain, handlers } = makeHandlerCapture();
    registerCyboflowHandlers(
      ipcMain as unknown as Parameters<typeof registerCyboflowHandlers>[0],
      makeServices(db),
    );

    const result = await invoke(handlers, 'cyboflow:listRuns', { projectId: 'not-a-number' }) as {
      success: boolean;
      error?: string;
    };

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/projectId/);
  });

  // cyboflow:listWorkflows
  it('listWorkflows: missing args.projectId → success: false', async () => {
    const { ipcMain, handlers } = makeHandlerCapture();
    registerCyboflowHandlers(
      ipcMain as unknown as Parameters<typeof registerCyboflowHandlers>[0],
      makeServices(db),
    );

    const result = await invoke(handlers, 'cyboflow:listWorkflows', {}) as {
      success: boolean;
      error?: string;
    };

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/projectId/);
  });

  // cyboflow:startRun
  it('startRun: missing workflowId → success: false, error mentions workflowId', async () => {
    const { ipcMain, handlers } = makeHandlerCapture();
    registerCyboflowHandlers(
      ipcMain as unknown as Parameters<typeof registerCyboflowHandlers>[0],
      makeServices(db),
    );

    const result = await invoke(handlers, 'cyboflow:startRun', { projectId: 1 }) as {
      success: boolean;
      error?: string;
    };

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/workflowId/);
  });

  it('startRun: string projectId → success: false, error mentions projectId', async () => {
    const { ipcMain, handlers } = makeHandlerCapture();
    registerCyboflowHandlers(
      ipcMain as unknown as Parameters<typeof registerCyboflowHandlers>[0],
      makeServices(db),
    );

    const result = await invoke(handlers, 'cyboflow:startRun', {
      workflowId: 'some-id',
      projectId: 'bad',
    }) as {
      success: boolean;
      error?: string;
    };

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/projectId/);
  });

  // validateInput — z.number().finite() rejects NaN/Infinity
  it('listRuns: NaN projectId → success: false, error mentions projectId', async () => {
    const { ipcMain, handlers } = makeHandlerCapture();
    registerCyboflowHandlers(
      ipcMain as unknown as Parameters<typeof registerCyboflowHandlers>[0],
      makeServices(db),
    );

    const result = await invoke(handlers, 'cyboflow:listRuns', { projectId: NaN }) as {
      success: boolean;
      error?: string;
    };

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/projectId/);
  });

  // validateInput — z.string().min(1) rejects empty string
  it('startRun: empty string workflowId → success: false, error mentions workflowId', async () => {
    const { ipcMain, handlers } = makeHandlerCapture();
    registerCyboflowHandlers(
      ipcMain as unknown as Parameters<typeof registerCyboflowHandlers>[0],
      makeServices(db),
    );

    const result = await invoke(handlers, 'cyboflow:startRun', {
      workflowId: '',
      projectId: 1,
    }) as {
      success: boolean;
      error?: string;
    };

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/workflowId/);
  });

  // listRuns happy path: valid projectId, no rows → success: true, data: []
  it('listRuns: valid number projectId → success: true, data is an array', async () => {
    const { ipcMain, handlers } = makeHandlerCapture();
    registerCyboflowHandlers(
      ipcMain as unknown as Parameters<typeof registerCyboflowHandlers>[0],
      makeServices(db),
    );

    const result = await invoke(handlers, 'cyboflow:listRuns', { projectId: 42 }) as {
      success: boolean;
      data?: unknown[];
      error?: string;
    };

    expect(result.success).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
    // No runs seeded — expect empty list.
    expect(result.data).toHaveLength(0);
  });
});

describe('registerCyboflowHandlers — cyboflow:approveRun', () => {
  it('registers a handler for the channel', () => {
    const db = createTestDb();
    const { ipcMain, handlers } = makeHandlerCapture();
    registerCyboflowHandlers(
      ipcMain as unknown as Parameters<typeof registerCyboflowHandlers>[0],
      makeServices(db),
    );
    expect(handlers.has('cyboflow:approveRun')).toBe(true);
  });

  it('returns success: false with a NOT_IMPLEMENTED error message', async () => {
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
