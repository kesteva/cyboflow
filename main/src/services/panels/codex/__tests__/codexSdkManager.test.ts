import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import type { SessionManager } from '../../../sessionManager';
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
    userAgent: 'codex-cli/0.143.0',
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
      version: '0.143.0',
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

  it('pins auto for the configured thread and turn and persists provider-neutral events', async () => {
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
          model: 'gpt-5.5',
          developerInstructions: 'Report through Cyboflow.',
        },
      });
      expect(client.requests[2]).toEqual({
        method: 'turn/start',
        params: {
          threadId: 'codex-thread-1',
          input: [{ type: 'text', text: 'ship it', text_elements: [] }],
          model: 'gpt-5.5',
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
        model: 'gpt-5.5',
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
        sdk_version: 'codex-cli/0.143.0',
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
