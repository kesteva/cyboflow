import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionManager } from '../../../sessionManager';
import { SpawnStepRunner } from '../../../../orchestrator/programmatic/spawnStepRunner';
import { WorkflowController } from '../../../../orchestrator/programmatic/workflowController';
import type { ControllerHost } from '../../../../orchestrator/programmatic/types';
import type { WorkflowDefinition } from '../../../../../../shared/types/workflows';
import type {
  AppServerNotification,
  CodexAppServerClientOptions,
} from '../appServer/client';
import type { AppServerInitializeParams } from '../appServer/protocol';
import { CODEX_RAW_NOTIFICATION_EVENT_TYPE } from '../appServer/rawNotificationSink';
import {
  CodexSdkManager,
  type CodexAppServerClientFactory,
  type CodexAppServerClientLike,
} from '../codexSdkManager';

type RequestHandler = (method: string, params: unknown, client: FakeAppServerClient) => unknown;

class FakeAppServerClient implements CodexAppServerClientLike {
  readonly start = vi.fn(() => undefined);
  readonly stop = vi.fn(async (_signal?: NodeJS.Signals) => undefined);
  readonly initialize = vi.fn(async (_params: AppServerInitializeParams) => ({
    userAgent: 'codex-cli/0.144.3',
    codexHome: '/home/user/.codex',
    platformFamily: 'unix',
    platformOs: 'macos',
  }));
  readonly requests: Array<{ method: string; params: unknown }> = [];

  constructor(
    readonly options: CodexAppServerClientOptions,
    private readonly requestHandler: RequestHandler,
  ) {}

  async sendRequest<TResult, TParams>(method: string, params: TParams): Promise<TResult> {
    this.requests.push({ method, params });
    return this.requestHandler(method, params, this) as TResult;
  }

  notify(notification: AppServerNotification): void {
    this.options.onNotification?.(notification);
  }
}

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE workflow_runs (
      id TEXT PRIMARY KEY,
      claude_session_id TEXT,
      updated_at TEXT
    );
    CREATE TABLE agent_invocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_invocation_id TEXT NOT NULL UNIQUE,
      run_id TEXT NOT NULL,
      step_id TEXT,
      agent_provider TEXT NOT NULL,
      agent_runtime TEXT NOT NULL,
      model TEXT,
      external_session_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE raw_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO workflow_runs (id, updated_at) VALUES ('run-1', CURRENT_TIMESTAMP)").run();
  return db;
}

function makeManager(
  db: Database.Database,
  handler: RequestHandler,
): { manager: CodexSdkManager; getClient(): FakeAppServerClient } {
  let client: FakeAppServerClient | null = null;
  const factory: CodexAppServerClientFactory = (options) => {
    client = new FakeAppServerClient(options, handler);
    return client;
  };
  const manager = new CodexSdkManager(
    {} as SessionManager,
    undefined,
    undefined,
    db,
    factory,
    () => ({
      executablePath: '/app/codex/bin/codex',
      pathDir: '/app/codex/codex-path',
      version: '0.144.3',
      target: 'aarch64-apple-darwin',
    }),
    '0.1.test',
  );
  manager.setCyboflowMcpRuntimeConfig({
    orchSocketPath: '/tmp/cyboflow-orch.sock',
    bridgeScriptPath: '/app/cyboflowMcpServer.js',
    nodeExecutablePath: '/usr/local/bin/node',
  });
  manager.setApprovalRouterProvider(() => ({
    requestApproval: vi.fn(async () => ({ behavior: 'allow' as const })),
    clearPendingForSource: vi.fn(),
  }));
  manager.setQuestionRouterProvider(() => ({
    requestQuestion: vi.fn(async () => ({ answers: {} })),
    clearPendingForRun: vi.fn(),
  }));
  return {
    manager,
    getClient: () => {
      if (!client) throw new Error('client not created');
      return client;
    },
  };
}

function successfulHandler(method: string, _params: unknown, client: FakeAppServerClient): unknown {
  if (method === 'account/read') {
    return {
      account: { type: 'chatgpt', email: 'user@example.com', planType: 'pro' },
      requiresOpenaiAuth: true,
    };
  }
  if (method === 'thread/start') return { thread: { id: 'codex-thread-1' } };
  if (method === 'thread/resume') return { thread: { id: 'codex-thread-1' } };
  if (method === 'turn/interrupt') return {};
  if (method === 'turn/start') {
    setTimeout(() => {
      client.notify({
        method: 'item/completed',
        params: {
          threadId: 'codex-thread-1',
          turnId: 'turn-1',
          completedAtMs: 20,
          item: { type: 'agentMessage', id: 'message-1', text: 'Done from Codex.' },
        },
      });
      client.notify({
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: 'codex-thread-1',
          turnId: 'turn-1',
          tokenUsage: {
            total: {
              totalTokens: 17,
              inputTokens: 10,
              cachedInputTokens: 3,
              outputTokens: 7,
              reasoningOutputTokens: 2,
            },
            last: {
              totalTokens: 17,
              inputTokens: 10,
              cachedInputTokens: 3,
              outputTokens: 7,
              reasoningOutputTokens: 2,
            },
            modelContextWindow: 258_400,
          },
        },
      });
      client.notify({
        method: 'turn/completed',
        params: {
          threadId: 'codex-thread-1',
          turn: { id: 'turn-1', status: 'completed' },
        },
      });
    }, 0);
    return { turn: { id: 'turn-1' } };
  }
  throw new Error(`Unexpected request: ${method}`);
}

describe('CodexSdkManager app-server runtime', () => {
  it('probes ChatGPT auth without starting a thread and stops the temporary app-server', async () => {
    const db = createDb();
    try {
      const { manager, getClient } = makeManager(db, successfulHandler);

      await expect(manager.detectChatGptAccount()).resolves.toEqual({
        runtime: {
          found: true,
          path: '/app/codex/bin/codex',
          version: '0.144.3',
        },
        account: {
          found: true,
          email: 'user@example.com',
          planType: 'pro',
        },
        state: 'detected',
      });

      const client = getClient();
      expect(client.start).toHaveBeenCalledOnce();
      expect(client.stop).toHaveBeenCalledOnce();
      expect(client.requests).toEqual([{
        method: 'account/read',
        params: { refreshToken: false },
      }]);
    } finally {
      db.close();
    }
  });

  it('reports a bundled Codex runtime as logged out when account/read is not ChatGPT auth', async () => {
    const db = createDb();
    try {
      const { manager, getClient } = makeManager(db, (method) => {
        if (method === 'account/read') {
          return { account: null, requiresOpenaiAuth: true };
        }
        throw new Error(`Unexpected request: ${method}`);
      });

      await expect(manager.detectChatGptAccount()).resolves.toMatchObject({
        runtime: { found: true },
        account: { found: false },
        state: 'loggedOut',
      });
      expect(getClient().stop).toHaveBeenCalledOnce();
    } finally {
      db.close();
    }
  });

  it('discovers, paginates, projects, and caches the visible Codex model catalog', async () => {
    const db = createDb();
    try {
      const { manager, getClient } = makeManager(db, (method, params) => {
        if (method !== 'model/list') throw new Error(`Unexpected request: ${method}`);
        const cursor = (params as { cursor?: string }).cursor;
        if (!cursor) {
          return {
            data: [
              {
                id: 'opaque-sol',
                model: 'gpt-5.6-sol',
                displayName: 'GPT-5.6 Sol',
                description: 'Frontier coding model',
                hidden: false,
                isDefault: true,
              },
              {
                id: 'opaque-hidden',
                model: 'internal-model',
                displayName: 'Internal',
                description: 'Hidden model',
                hidden: true,
                isDefault: false,
              },
            ],
            nextCursor: 'page-2',
          };
        }
        return {
          data: [{
            id: 'opaque-terra',
            model: 'gpt-5.6-terra',
            displayName: 'GPT-5.6 Terra',
            description: 'Balanced coding model',
            hidden: false,
            isDefault: false,
          }],
          nextCursor: null,
        };
      });

      const [first, concurrent] = await Promise.all([
        manager.getCodexModelCatalog(),
        manager.getCodexModelCatalog(),
      ]);
      const cached = await manager.getCodexModelCatalog();

      expect(first).toEqual({
        models: [
          {
            id: 'gpt-5.6-sol',
            label: 'GPT-5.6 Sol',
            description: 'Frontier coding model',
            isDefault: true,
          },
          {
            id: 'gpt-5.6-terra',
            label: 'GPT-5.6 Terra',
            description: 'Balanced coding model',
            isDefault: false,
          },
        ],
        defaultModel: 'gpt-5.6-sol',
      });
      expect(concurrent).toEqual(first);
      expect(cached).toEqual(first);
      const client = getClient();
      expect(client.start).toHaveBeenCalledOnce();
      expect(client.stop).toHaveBeenCalledOnce();
      expect(client.requests).toEqual([
        { method: 'model/list', params: { includeHidden: false } },
        { method: 'model/list', params: { includeHidden: false, cursor: 'page-2' } },
      ]);
    } finally {
      db.close();
    }
  });

  it('routes a projected usage-limit failure through the programmatic systemic pause', async () => {
    const db = createDb();
    try {
      const { manager } = makeManager(db, (method, _params, client) => {
        if (method === 'account/read') {
          return {
            account: { type: 'chatgpt', email: null, planType: 'plus' },
            requiresOpenaiAuth: true,
          };
        }
        if (method === 'thread/start') return { thread: { id: 'codex-thread-1' } };
        if (method === 'turn/start') {
          setTimeout(() => client.notify({
            method: 'turn/completed',
            params: {
              threadId: 'codex-thread-1',
              turn: {
                id: 'turn-1',
                status: 'failed',
                error: {
                  message: 'Unhandled error. (usageLimitExceeded)',
                  codexErrorInfo: {
                    code: 'usageLimitExceeded',
                    message: 'You have reached your usage limit.',
                  },
                  additionalDetails: 'Resets at 2026-07-12T00:00:00Z',
                },
              },
            },
          }), 0);
          return { turn: { id: 'turn-1' } };
        }
        throw new Error(`Unexpected request: ${method}`);
      });
      manager.on('error', () => undefined);

      const runner = new SpawnStepRunner({
        spawnCliProcess: manager.spawnCliProcess.bind(manager),
        abort: manager.killProcess.bind(manager),
      }, {
        panelId: 'run-1',
        sessionId: 'run-1',
        runId: 'run-1',
        worktreePath: '/tmp/worktree',
        workflowName: 'planner',
      });
      const awaitSystemicPause = vi.fn<NonNullable<ControllerHost['awaitSystemicPause']>>(async () => 'canceled');
      const host: ControllerHost = {
        reportStep: vi.fn(),
        requestHumanGate: async () => 'approve',
        awaitSystemicPause,
      };
      const definition: WorkflowDefinition = {
        id: 'codex-systemic',
        phases: [{
          id: 'run',
          label: 'Run',
          color: '#3b6dd6',
          steps: [{ id: 'codex-step', name: 'Codex step', agent: 'executor', mcps: [], retries: 0 }],
        }],
      };

      const result = await new WorkflowController(runner, host).run('run-1', definition);

      expect(result).toMatchObject({ outcome: 'canceled', failedStepId: 'codex-step' });
      expect(awaitSystemicPause).toHaveBeenCalledTimes(1);
      const [pausedStep, pausedContext, pausedError] = awaitSystemicPause.mock.calls[0];
      expect(pausedStep.id).toBe('codex-step');
      expect(pausedContext.attempt).toBe(1);
      expect(pausedError).toContain('usageLimitExceeded');
      expect(pausedError).toContain('You have reached your usage limit.');
    } finally {
      db.close();
    }
  });

  it('releases the spawn reservation after an early preflight failure', async () => {
    const db = createDb();
    try {
      const manager = new CodexSdkManager(
        {} as SessionManager,
        undefined,
        undefined,
        db,
        () => { throw new Error('client should not be created'); },
        () => { throw new Error('broken executable resolution'); },
      );
      manager.setCyboflowMcpRuntimeConfig({
        orchSocketPath: '/tmp/cyboflow-orch.sock',
        bridgeScriptPath: '/app/cyboflowMcpServer.js',
        nodeExecutablePath: '/usr/local/bin/node',
      });
      manager.setApprovalRouterProvider(() => ({
        requestApproval: vi.fn(async () => ({ behavior: 'allow' as const })),
        clearPendingForSource: vi.fn(),
      }));
      manager.setQuestionRouterProvider(() => ({
        requestQuestion: vi.fn(async () => ({ answers: {} })),
        clearPendingForRun: vi.fn(),
      }));
      const options = {
        panelId: 'run-1',
        sessionId: 'run-1',
        runId: 'run-1',
        worktreePath: '/tmp/worktree',
        prompt: 'ship it',
      };

      await expect(manager.spawnCliProcess(options)).rejects.toThrow('broken executable resolution');
      await expect(manager.spawnCliProcess(options)).rejects.toThrow('broken executable resolution');
    } finally {
      db.close();
    }
  });

  it('lets the runtime resolve auto and persists provider-neutral events', async () => {
    const db = createDb();
    try {
      const { manager, getClient } = makeManager(db, successfulHandler);
      const outputs: Array<{ data: unknown }> = [];
      manager.on('output', (payload: unknown) => {
        if (typeof payload === 'object' && payload !== null && 'data' in payload) {
          outputs.push(payload as { data: unknown });
        }
      });

      await manager.spawnCliProcess({
        panelId: 'run-1',
        sessionId: 'run-1',
        runId: 'run-1',
        worktreePath: '/tmp/worktree',
        prompt: 'ship it',
        systemPromptAppend: 'Report through Cyboflow.',
        agentPermissionMode: 'acceptEdits',
        model: 'auto',
        agentInvocationStepId: 'verify-step',
      } as Parameters<CodexSdkManager['spawnCliProcess']>[0] & { agentInvocationStepId: string });

      const client = getClient();
      expect(client.initialize).toHaveBeenCalledWith(expect.objectContaining({
        clientInfo: {
          name: 'cyboflow',
          title: 'Cyboflow',
          version: '0.1.test',
        },
      }));
      expect(client.start).toHaveBeenCalledOnce();
      // A clean, non-lane, no-resume turn parks the app-server WARM (not stopped
      // per turn now). Shutdown sweeps the parked entry — asserting it closes once.
      expect(client.stop).not.toHaveBeenCalled();
      await manager.killAllProcesses();
      expect(client.stop).toHaveBeenCalledOnce();
      expect(client.options).toMatchObject({
        command: '/app/codex/bin/codex',
        cwd: '/tmp/worktree',
        env: {
          PATH: expect.stringContaining('/app/codex/codex-path'),
          CYBOFLOW_RUN_ID: 'run-1',
          CYBOFLOW_ORCH_SOCKET: '/tmp/cyboflow-orch.sock',
        },
      });
      expect(client.requests[0]).toEqual({
        method: 'account/read',
        params: { refreshToken: false },
      });
      expect(client.requests[1]).toMatchObject({
        method: 'thread/start',
        params: {
          cwd: '/tmp/worktree',
          sandbox: 'workspace-write',
          approvalPolicy: 'on-request',
          approvalsReviewer: 'user',
          developerInstructions: 'Report through Cyboflow.',
        },
      });
      expect(client.requests[2]).toEqual({
        method: 'turn/start',
        params: {
          threadId: 'codex-thread-1',
          input: [{ type: 'text', text: 'ship it', text_elements: [] }],
        },
      });

      const workflowRunRow = db
        .prepare('SELECT claude_session_id AS claudeSessionId FROM workflow_runs WHERE id = ?')
        .get('run-1') as { claudeSessionId: string | null };
      expect(workflowRunRow.claudeSessionId).toBeNull();
      const invocationRow = db
        .prepare(
          `SELECT agent_provider AS provider,
                  agent_runtime AS runtime,
                  model,
                  external_session_id AS externalSessionId,
                  step_id AS stepId
             FROM agent_invocations
            WHERE run_id = ?`,
        )
        .get('run-1') as {
          provider: string;
          runtime: string;
          model: string | null;
          externalSessionId: string | null;
          stepId: string | null;
        };
      expect(invocationRow).toEqual({
        provider: 'codex',
        runtime: 'codex-sdk',
        model: null,
        externalSessionId: 'codex-thread-1',
        stepId: 'verify-step',
      });

      const rows = db
        .prepare(`SELECT event_type AS eventType, payload_json AS payloadJson
                    FROM raw_events
                   WHERE event_type != ?
                   ORDER BY id`)
        .all(CODEX_RAW_NOTIFICATION_EVENT_TYPE) as Array<{ eventType: string; payloadJson: string }>;
      expect(rows.map((row) => row.eventType)).toEqual([
        'agent_session_info',
        'agent_system',
        'agent_assistant',
        'agent_result',
      ]);
      expect(JSON.parse(rows[1].payloadJson)).toMatchObject({
        type: 'agent_init',
        provider: 'codex',
        runtime: 'codex-sdk',
        external_session_id: 'codex-thread-1',
        sdk_version: 'codex-cli/0.144.3',
        mcp_servers: [{ name: 'cyboflow', status: 'configured' }],
      });
      expect(JSON.parse(rows[2].payloadJson)).toMatchObject({
        type: 'agent_message',
        provider: 'codex',
        runtime: 'codex-sdk',
        content: [{ type: 'text', text: 'Done from Codex.' }],
      });
      expect(JSON.parse(rows[3].payloadJson)).toMatchObject({
        type: 'agent_result',
        subtype: 'success',
        is_error: false,
        usage: {
          input_tokens: 7,
          cache_read_input_tokens: 3,
          output_tokens: 7,
          reasoning_output_tokens: 2,
        },
      });
      expect(outputs.some((output) => {
        return typeof output.data === 'object'
          && output.data !== null
          && (output.data as { type?: unknown }).type === 'assistant';
      })).toBe(true);
      const rawNotifications = db
        .prepare(`SELECT payload_json AS payloadJson
                    FROM raw_events
                   WHERE event_type = ?
                   ORDER BY id`)
        .all(CODEX_RAW_NOTIFICATION_EVENT_TYPE) as Array<{ payloadJson: string }>;
      expect(rawNotifications.map((row) => JSON.parse(row.payloadJson).method)).toEqual([
        'item/completed',
        'thread/tokenUsage/updated',
        'turn/completed',
      ]);
    } finally {
      db.close();
    }
  });

  it('resumes an external Codex thread', async () => {
    const db = createDb();
    try {
      const { manager, getClient } = makeManager(db, successfulHandler);
      await manager.spawnCliProcess({
        panelId: 'run-1',
        sessionId: 'run-1',
        runId: 'run-1',
        worktreePath: '/tmp/worktree',
        prompt: 'continue',
        resumeSessionId: 'codex-thread-1',
      });

      expect(getClient().requests[1]).toMatchObject({
        method: 'thread/resume',
        params: { threadId: 'codex-thread-1', excludeTurns: true },
      });
      const invocationRow = db
        .prepare(
          `SELECT external_session_id AS externalSessionId
             FROM agent_invocations
            WHERE run_id = ?`,
        )
        .get('run-1') as { externalSessionId: string | null };
      expect(invocationRow.externalSessionId).toBe('codex-thread-1');
    } finally {
      db.close();
    }
  });

  it('emits one failure result and rejects when the turn fails', async () => {
    const db = createDb();
    try {
      const { manager } = makeManager(db, (method, _params, client) => {
        if (method === 'account/read') {
          return {
            account: { type: 'chatgpt', email: null, planType: 'plus' },
            requiresOpenaiAuth: true,
          };
        }
        if (method === 'thread/start') return { thread: { id: 'codex-thread-1' } };
        if (method === 'turn/start') {
          setTimeout(() => client.notify({
            method: 'turn/completed',
            params: {
              threadId: 'codex-thread-1',
              turn: {
                id: 'turn-1',
                status: 'failed',
                error: {
                  message: 'Unhandled error. (usageLimitExceeded)',
                  codexErrorInfo: {
                    code: 'usageLimitExceeded',
                    message: 'You have reached your usage limit.',
                  },
                  additionalDetails: 'Resets at 2026-07-12T00:00:00Z',
                },
              },
            },
          }), 0);
          return { turn: { id: 'turn-1' } };
        }
        throw new Error(`Unexpected request: ${method}`);
      });
      manager.on('error', () => undefined);

      await expect(manager.spawnCliProcess({
        panelId: 'run-1',
        sessionId: 'run-1',
        runId: 'run-1',
        worktreePath: '/tmp/worktree',
        prompt: 'fail it',
      })).rejects.toThrow('usageLimitExceeded');

      const resultRows = db
        .prepare("SELECT payload_json AS payloadJson FROM raw_events WHERE event_type = 'agent_result'")
        .all() as Array<{ payloadJson: string }>;
      expect(resultRows).toHaveLength(1);
      expect(JSON.parse(resultRows[0].payloadJson)).toMatchObject({
        subtype: 'error_during_execution',
        is_error: true,
        result: expect.stringContaining('usageLimitExceeded'),
      });
      expect(JSON.parse(resultRows[0].payloadJson).result).toContain('You have reached your usage limit.');
    } finally {
      db.close();
    }
  });

  it('interrupts an active quick turn by run id when panel and run ids differ', async () => {
    const db = createDb();
    try {
      let markTurnStarted!: () => void;
      const turnStarted = new Promise<void>((resolve) => {
        markTurnStarted = resolve;
      });
      const { manager, getClient } = makeManager(db, (method) => {
        if (method === 'account/read') {
          return {
            account: { type: 'chatgpt', email: null, planType: 'plus' },
            requiresOpenaiAuth: true,
          };
        }
        if (method === 'thread/start') return { thread: { id: 'codex-thread-1' } };
        if (method === 'turn/start') {
          setTimeout(markTurnStarted, 0);
          return { turn: { id: 'turn-1' } };
        }
        if (method === 'turn/interrupt') return {};
        throw new Error(`Unexpected request: ${method}`);
      });

      const spawn = manager.spawnCliProcess({
        panelId: 'panel-quick-1',
        sessionId: 'session-quick-1',
        runId: 'run-1',
        worktreePath: '/tmp/worktree',
        prompt: 'wait',
      });
      await turnStarted;
      await manager.killProcess('run-1');
      await spawn;

      const client = getClient();
      expect(client.requests).toContainEqual({
        method: 'turn/interrupt',
        params: { threadId: 'codex-thread-1', turnId: 'turn-1' },
      });
      expect(client.stop).toHaveBeenCalledOnce();
    } finally {
      db.close();
    }
  });

  it('rejects API-key auth before creating a thread', async () => {
    const db = createDb();
    try {
      const { manager, getClient } = makeManager(db, (method) => {
        if (method === 'account/read') {
          return { account: { type: 'apiKey' }, requiresOpenaiAuth: true };
        }
        throw new Error(`Unexpected request: ${method}`);
      });
      manager.on('error', () => undefined);

      await expect(manager.spawnCliProcess({
        panelId: 'run-1',
        sessionId: 'run-1',
        runId: 'run-1',
        worktreePath: '/tmp/worktree',
        prompt: 'do not start',
      })).rejects.toThrow('Codex requires a ChatGPT login');

      expect(getClient().requests).toEqual([{
        method: 'account/read',
        params: { refreshToken: false },
      }]);
    } finally {
      db.close();
    }
  });

  it('does not shadow a resumable thread when startup auth fails transiently', async () => {
    const db = createDb();
    try {
      db.prepare(
        `INSERT INTO agent_invocations
           (agent_invocation_id, run_id, step_id, agent_provider, agent_runtime, model, external_session_id)
         VALUES ('prior', 'run-1', NULL, 'codex', 'codex-sdk', NULL, 'codex-thread-prior')`,
      ).run();
      const { manager } = makeManager(db, (method) => {
        if (method === 'account/read') {
          throw new Error('temporary auth service failure');
        }
        throw new Error(`Unexpected request: ${method}`);
      });
      manager.on('error', () => undefined);

      await expect(manager.spawnCliProcess({
        panelId: 'run-1',
        sessionId: 'run-1',
        runId: 'run-1',
        worktreePath: '/tmp/worktree',
        prompt: 'continue',
        resumeSessionId: 'codex-thread-prior',
      })).rejects.toThrow('temporary auth service failure');

      const rows = db.prepare(
        'SELECT agent_invocation_id AS id, external_session_id AS externalSessionId FROM agent_invocations',
      ).all() as Array<{ id: string; externalSessionId: string | null }>;
      expect(rows).toEqual([{ id: 'prior', externalSessionId: 'codex-thread-prior' }]);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Warm (persistent) app-server reuse
// ---------------------------------------------------------------------------

/** A handler that mints a fresh turn id per turn/start so a reused turnSession
 *  accepts a second turn's notifications (lastTerminalTurnId gates repeats). */
function warmTurnHandler(): RequestHandler {
  let turnCounter = 0;
  return (method, _params, client) => {
    if (method === 'account/read') {
      return {
        account: { type: 'chatgpt', email: 'user@example.com', planType: 'pro' },
        requiresOpenaiAuth: true,
      };
    }
    if (method === 'thread/start') return { thread: { id: 'codex-thread-1' } };
    if (method === 'thread/resume') return { thread: { id: 'codex-thread-1' } };
    if (method === 'turn/interrupt') return {};
    if (method === 'turn/start') {
      turnCounter += 1;
      const turnId = `turn-${turnCounter}`;
      setTimeout(() => {
        client.notify({
          method: 'item/completed',
          params: {
            threadId: 'codex-thread-1',
            turnId,
            completedAtMs: 20,
            item: { type: 'agentMessage', id: `message-${turnCounter}`, text: `Done ${turnCounter}.` },
          },
        });
        client.notify({
          method: 'turn/completed',
          params: { threadId: 'codex-thread-1', turn: { id: turnId, status: 'completed' } },
        });
      }, 0);
      return { turn: { id: turnId } };
    }
    throw new Error(`Unexpected request: ${method}`);
  };
}

/** Like makeManager but COLLECTS every client the factory creates, so a test can
 *  assert cold-spawn count (1 factory call per cold spawn; 0 on warm reuse). */
function makeWarmManager(
  db: Database.Database,
  handler: RequestHandler = warmTurnHandler(),
): { manager: CodexSdkManager; clients: FakeAppServerClient[] } {
  const clients: FakeAppServerClient[] = [];
  const factory: CodexAppServerClientFactory = (options) => {
    const client = new FakeAppServerClient(options, handler);
    clients.push(client);
    return client;
  };
  const manager = new CodexSdkManager(
    {} as SessionManager,
    undefined,
    undefined,
    db,
    factory,
    () => ({
      executablePath: '/app/codex/bin/codex',
      pathDir: '/app/codex/codex-path',
      version: '0.144.3',
      target: 'aarch64-apple-darwin',
    }),
    '0.1.test',
  );
  manager.setCyboflowMcpRuntimeConfig({
    orchSocketPath: '/tmp/cyboflow-orch.sock',
    bridgeScriptPath: '/app/cyboflowMcpServer.js',
    nodeExecutablePath: '/usr/local/bin/node',
  });
  manager.setApprovalRouterProvider(() => ({
    requestApproval: vi.fn(async () => ({ behavior: 'allow' as const })),
    clearPendingForSource: vi.fn(),
  }));
  manager.setQuestionRouterProvider(() => ({
    requestQuestion: vi.fn(async () => ({ answers: {} })),
    clearPendingForRun: vi.fn(),
  }));
  manager.on('error', () => undefined);
  return { manager, clients };
}

function baseTurn(overrides: Record<string, unknown>): Parameters<CodexSdkManager['spawnCliProcess']>[0] {
  return {
    panelId: 'panel-1',
    sessionId: 'session-1',
    runId: 'run-1',
    worktreePath: '/tmp/worktree',
    prompt: 'go',
    ...overrides,
  } as Parameters<CodexSdkManager['spawnCliProcess']>[0];
}

describe('CodexSdkManager warm app-server reuse', () => {
  const WARM_ENV = 'CYBOFLOW_DISABLE_CODEX_WARM';
  afterEach(() => {
    delete process.env[WARM_ENV];
  });

  it('reuses the parked app-server for a matching resume-continuation (no cold respawn, 2 invocation rows)', async () => {
    const db = createDb();
    try {
      const { manager, clients } = makeWarmManager(db);

      await manager.spawnCliProcess(baseTurn({ prompt: 'first' }));
      expect(clients).toHaveLength(1);

      // Resume-continuation of the SAME conversation: reuses the live thread.
      await manager.spawnCliProcess(baseTurn({ prompt: 'second', resumeSessionId: 'codex-thread-1' }));

      expect(clients).toHaveLength(1);               // NO cold respawn
      expect(clients[0].start).toHaveBeenCalledOnce(); // cold-only
      expect(clients[0].initialize).toHaveBeenCalledOnce(); // cold-only handshake
      // Handshake requests happen once; turn/start happens per turn.
      const methods = clients[0].requests.map((r) => r.method);
      expect(methods.filter((m) => m === 'account/read')).toHaveLength(1);
      expect(methods.filter((m) => m === 'thread/start')).toHaveLength(1);
      expect(methods.filter((m) => m === 'turn/start')).toHaveLength(2);
      // C4: a fresh invocation row per logical turn.
      const invCount = db.prepare('SELECT COUNT(*) AS c FROM agent_invocations WHERE run_id = ?').get('run-1') as { c: number };
      expect(invCount.c).toBe(2);

      await manager.killAllProcesses();
      expect(clients[0].stop).toHaveBeenCalledOnce();
    } finally {
      db.close();
    }
  });

  it('cold-respawns a same-key turn that is NOT a resume (fresh conversation)', async () => {
    const db = createDb();
    try {
      const { manager, clients } = makeWarmManager(db);
      await manager.spawnCliProcess(baseTurn({ prompt: 'first' }));
      await manager.spawnCliProcess(baseTurn({ prompt: 'second' })); // no resumeSessionId
      expect(clients).toHaveLength(2);
      await manager.killAllProcesses();
    } finally {
      db.close();
    }
  });

  it('cold-respawns when the spawn-baked config fingerprint changes (developerInstructions)', async () => {
    const db = createDb();
    try {
      const { manager, clients } = makeWarmManager(db);
      await manager.spawnCliProcess(baseTurn({ prompt: 'first', systemPromptAppend: 'Persona A' }));
      await manager.spawnCliProcess(baseTurn({
        prompt: 'second',
        resumeSessionId: 'codex-thread-1',
        systemPromptAppend: 'Persona B', // → different developerInstructions → different fingerprint
      }));
      expect(clients).toHaveLength(2);
      await manager.killAllProcesses();
    } finally {
      db.close();
    }
  });

  it('closes (never parks) when the kill-switch is set — cold every turn', async () => {
    process.env[WARM_ENV] = '1';
    const db = createDb();
    try {
      const { manager, clients } = makeWarmManager(db);
      await manager.spawnCliProcess(baseTurn({ prompt: 'first' }));
      expect(clients).toHaveLength(1);
      expect(clients[0].stop).toHaveBeenCalledOnce(); // closed, not parked
      await manager.spawnCliProcess(baseTurn({ prompt: 'second', resumeSessionId: 'codex-thread-1' }));
      expect(clients).toHaveLength(2);
      expect(clients[1].stop).toHaveBeenCalledOnce();
    } finally {
      db.close();
    }
  });

  it('never warms a fan-out lane spawn (spawnKey !== panelId)', async () => {
    const db = createDb();
    try {
      const { manager, clients } = makeWarmManager(db);
      await manager.spawnCliProcess(baseTurn({ prompt: 'lane', spawnKey: 'lane-key-1' }));
      expect(clients[0].stop).toHaveBeenCalledOnce(); // closed, not parked
      // A second lane turn cold-respawns (nothing was parked).
      await manager.spawnCliProcess(baseTurn({ prompt: 'lane2', spawnKey: 'lane-key-2', resumeSessionId: 'codex-thread-1' }));
      expect(clients).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it('closes (never parks) a failed turn', async () => {
    const db = createDb();
    try {
      const { manager, clients } = makeWarmManager(db, (method, _params, client) => {
        if (method === 'account/read') {
          return { account: { type: 'chatgpt', email: null, planType: 'plus' }, requiresOpenaiAuth: true };
        }
        if (method === 'thread/start') return { thread: { id: 'codex-thread-1' } };
        if (method === 'turn/start') {
          setTimeout(() => client.notify({
            method: 'turn/completed',
            params: {
              threadId: 'codex-thread-1',
              turn: { id: 'turn-1', status: 'failed', error: { message: 'boom (usageLimitExceeded)', codexErrorInfo: null, additionalDetails: null } },
            },
          }), 0);
          return { turn: { id: 'turn-1' } };
        }
        throw new Error(`Unexpected request: ${method}`);
      });
      await expect(manager.spawnCliProcess(baseTurn({ prompt: 'fail' }))).rejects.toThrow('usageLimitExceeded');
      expect(clients[0].stop).toHaveBeenCalledOnce(); // closed, not parked
      // Nothing parked → a follow-up resume cold-respawns.
      await manager.spawnCliProcess(baseTurn({ prompt: 'retry', resumeSessionId: 'codex-thread-1' })).catch(() => undefined);
      expect(clients.length).toBeGreaterThanOrEqual(2);
      await manager.killAllProcesses();
    } finally {
      db.close();
    }
  });

  it('closes a parked entry when killed by run id (panel id != run id)', async () => {
    const db = createDb();
    try {
      const { manager, clients } = makeWarmManager(db);
      await manager.spawnCliProcess(baseTurn({ panelId: 'panel-x', sessionId: 'session-x', runId: 'run-x', prompt: 'x' }));
      expect(clients[0].stop).not.toHaveBeenCalled(); // parked
      await manager.killProcess('run-x'); // reachable by run id via the defensive sweep
      expect(clients[0].stop).toHaveBeenCalledOnce();
    } finally {
      db.close();
    }
  });

  it('closes a parked entry when killed by panel id', async () => {
    const db = createDb();
    try {
      const { manager, clients } = makeWarmManager(db);
      await manager.spawnCliProcess(baseTurn({ panelId: 'panel-y', sessionId: 'session-y', runId: 'run-y', prompt: 'y' }));
      await manager.killProcess('panel-y');
      expect(clients[0].stop).toHaveBeenCalledOnce();
    } finally {
      db.close();
    }
  });
});
