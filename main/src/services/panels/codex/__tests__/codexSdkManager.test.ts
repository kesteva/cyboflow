import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import type { CodexOptions, ThreadEvent, ThreadOptions } from '@openai/codex-sdk';
import type { SessionManager } from '../../../sessionManager';
import { CodexSdkManager, type CodexClientFactory, type CodexClientLike, type CodexThreadLike } from '../codexSdkManager';

async function* streamEvents(events: ThreadEvent[]): AsyncGenerator<ThreadEvent> {
  for (const event of events) {
    yield event;
  }
}

class FakeThread implements CodexThreadLike {
  readonly id: string | null = null;
  readonly runStreamed = vi.fn<
    (input: string, turnOptions?: { signal?: AbortSignal }) => Promise<{ events: AsyncGenerator<ThreadEvent> }>
  >();

  constructor(events: ThreadEvent[]) {
    this.runStreamed.mockResolvedValue({ events: streamEvents(events) });
  }
}

class FakeCodexClient implements CodexClientLike {
  readonly startThread = vi.fn<(options?: ThreadOptions) => CodexThreadLike>();
  readonly resumeThread = vi.fn<(id: string, options?: ThreadOptions) => CodexThreadLike>();

  constructor(private readonly thread: CodexThreadLike) {
    this.startThread.mockReturnValue(thread);
    this.resumeThread.mockReturnValue(thread);
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

function makeManager(db: Database.Database, client: CodexClientLike): CodexSdkManager {
  const manager = new CodexSdkManager(
    {} as SessionManager,
    undefined,
    undefined,
    db,
    () => client,
  );
  manager.setCyboflowMcpRuntimeConfig({
    orchSocketPath: '/tmp/cyboflow-orch.sock',
    bridgeScriptPath: '/app/cyboflowMcpServer.js',
    nodeExecutablePath: '/usr/local/bin/node',
  });
  return manager;
}

function makeManagerWithFactory(db: Database.Database, factory: CodexClientFactory): CodexSdkManager {
  const manager = new CodexSdkManager(
    {} as SessionManager,
    undefined,
    undefined,
    db,
    factory,
  );
  manager.setCyboflowMcpRuntimeConfig({
    orchSocketPath: '/tmp/cyboflow-orch.sock',
    bridgeScriptPath: '/app/cyboflowMcpServer.js',
    nodeExecutablePath: '/usr/local/bin/node',
  });
  return manager;
}

describe('CodexSdkManager', () => {
  it('starts a Codex thread with workflow options and projects assistant/result events', async () => {
    const db = createDb();
    try {
      const thread = new FakeThread([
        { type: 'thread.started', thread_id: 'codex-thread-1' },
        {
          type: 'item.completed',
          item: { id: 'msg-1', type: 'agent_message', text: 'Done from Codex.' },
        },
        {
          type: 'turn.completed',
          usage: {
            input_tokens: 10,
            cached_input_tokens: 3,
            output_tokens: 7,
            reasoning_output_tokens: 2,
          },
        },
      ]);
      const client = new FakeCodexClient(thread);
      const createClient = vi.fn<(options?: CodexOptions) => CodexClientLike>(() => client);
      const manager = makeManagerWithFactory(db, createClient);
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
        agentPermissionMode: 'acceptEdits',
        model: 'gpt-5.5',
      });

      expect(createClient).toHaveBeenCalledWith({
        config: {
          mcp_servers: {
            cyboflow: {
              command: '/usr/local/bin/node',
              args: ['/app/cyboflowMcpServer.js'],
              env: {
                CYBOFLOW_RUN_ID: 'run-1',
                CYBOFLOW_ORCH_SOCKET: '/tmp/cyboflow-orch.sock',
              },
              required: true,
              default_tools_approval_mode: 'approve',
            },
          },
        },
      });
      expect(client.startThread).toHaveBeenCalledWith({
        workingDirectory: '/tmp/worktree',
        sandboxMode: 'workspace-write',
        approvalPolicy: 'on-request',
        model: 'gpt-5.5',
      });
      expect(thread.runStreamed).toHaveBeenCalledWith('ship it', {
        signal: expect.any(AbortSignal) as AbortSignal,
      });

      const threadRow = db
        .prepare('SELECT claude_session_id AS threadId FROM workflow_runs WHERE id = ?')
        .get('run-1') as { threadId: string | null };
      expect(threadRow.threadId).toBe('codex-thread-1');

      const rows = db
        .prepare('SELECT event_type AS eventType, payload_json AS payloadJson FROM raw_events ORDER BY id')
        .all() as Array<{ eventType: string; payloadJson: string }>;
      expect(rows.map((row) => row.eventType)).toEqual(['session_info', 'system', 'assistant', 'result']);

      const systemInit = JSON.parse(rows[1].payloadJson) as {
        type: string;
        mcp_servers: Array<{ name: string; status: string }>;
      };
      expect(systemInit.mcp_servers).toEqual([{ name: 'cyboflow', status: 'connected' }]);

      const assistant = outputs.map((output) => output.data).find((data) => {
        return typeof data === 'object' && data !== null && (data as { type?: unknown }).type === 'assistant';
      }) as { message: { content: Array<{ type: string; text?: string }> } };
      expect(assistant.message.content[0]).toEqual({ type: 'text', text: 'Done from Codex.' });

      const result = JSON.parse(rows[3].payloadJson) as {
        type: string;
        subtype: string;
        usage: { input_tokens: number; output_tokens: number };
      };
      expect(result).toMatchObject({
        type: 'result',
        subtype: 'success',
        usage: { input_tokens: 13, output_tokens: 9 },
      });
    } finally {
      db.close();
    }
  });

  it('omits the model when a stale Claude model value reaches Codex SDK', async () => {
    const db = createDb();
    try {
      const thread = new FakeThread([]);
      const client = new FakeCodexClient(thread);
      const manager = makeManager(db, client);

      await manager.spawnCliProcess({
        panelId: 'run-1',
        sessionId: 'run-1',
        runId: 'run-1',
        worktreePath: '/tmp/worktree',
        prompt: 'ship it',
        agentPermissionMode: 'acceptEdits',
        model: 'sonnet',
      });

      expect(client.startThread).toHaveBeenCalledWith({
        workingDirectory: '/tmp/worktree',
        sandboxMode: 'workspace-write',
        approvalPolicy: 'on-request',
      });
      expect(thread.runStreamed).toHaveBeenCalledWith('ship it', {
        signal: expect.any(AbortSignal) as AbortSignal,
      });

      const sessionInfoRow = db
        .prepare("SELECT payload_json AS payloadJson FROM raw_events WHERE event_type = 'session_info'")
        .get() as { payloadJson: string };
      expect(JSON.parse(sessionInfoRow.payloadJson)).toMatchObject({ model: 'codex-default' });
    } finally {
      db.close();
    }
  });

  it('projects one failure result and rejects the spawn when a turn fails', async () => {
    const db = createDb();
    try {
      const thread = new FakeThread([
        { type: 'thread.started', thread_id: 'codex-thread-err' },
        { type: 'turn.failed', error: { message: 'Codex failed' } },
      ]);
      const client = new FakeCodexClient(thread);
      const manager = makeManager(db, client);
      const outputs: Array<{ data: unknown }> = [];
      manager.on('error', () => undefined);
      manager.on('output', (payload: unknown) => {
        if (typeof payload === 'object' && payload !== null && 'data' in payload) {
          outputs.push(payload as { data: unknown });
        }
      });

      await expect(manager.spawnCliProcess({
        panelId: 'run-1',
        sessionId: 'run-1',
        runId: 'run-1',
        worktreePath: '/tmp/worktree',
        prompt: 'fail it',
      })).rejects.toThrow('Codex failed');

      const resultRows = db
        .prepare("SELECT payload_json AS payloadJson FROM raw_events WHERE event_type = 'result'")
        .all() as Array<{ payloadJson: string }>;
      expect(resultRows).toHaveLength(1);
      expect(JSON.parse(resultRows[0].payloadJson)).toMatchObject({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result: 'Codex failed',
      });

      const outputResults = outputs.filter((output) => {
        return typeof output.data === 'object' && output.data !== null && (output.data as { type?: unknown }).type === 'result';
      });
      expect(outputResults).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});
