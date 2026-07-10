import { describe, expect, it } from 'vitest';
import type { AppServerNotification } from './client';
import { AppServerProtocolError } from './client';
import type {
  AppServerInitializeParams,
  AppServerInitializeResponse,
  AppServerJsonValue,
  ThreadTokenUsageUpdatedNotification,
} from './protocol';
import {
  CodexAppServerTurnSession,
  type TurnSessionClient,
  type TurnSessionEvent,
} from './turnSession';

const INITIALIZE_PARAMS: AppServerInitializeParams = {
  clientInfo: {
    name: 'cyboflow',
    title: 'Cyboflow',
    version: 'test',
  },
  capabilities: {
    experimentalApi: true,
    requestAttestation: false,
  },
};

const INITIALIZE_RESPONSE: AppServerInitializeResponse = {
  userAgent: 'codex-test',
  codexHome: '/tmp/codex',
  platformFamily: 'unix',
  platformOs: 'macos',
};

const TOKEN_USAGE_UPDATED_PARAMS = {
  threadId: 'thread-1',
  turnId: 'turn-1',
  tokenUsage: {
    total: {
      totalTokens: 1_200,
      inputTokens: 1_000,
      cachedInputTokens: 400,
      outputTokens: 200,
      reasoningOutputTokens: 50,
    },
    last: {
      totalTokens: 150,
      inputTokens: 120,
      cachedInputTokens: 20,
      outputTokens: 30,
      reasoningOutputTokens: 10,
    },
    modelContextWindow: 258_400,
  },
} satisfies ThreadTokenUsageUpdatedNotification;

interface RequestCall {
  method: string;
  params: unknown;
}

class FakeTurnSessionClient implements TurnSessionClient {
  readonly initializeCalls: AppServerInitializeParams[] = [];
  readonly requestCalls: RequestCall[] = [];
  private readonly responses = new Map<string, Array<unknown | Promise<unknown>>>();

  queueResponse(method: string, response: unknown | Promise<unknown>): void {
    const queued = this.responses.get(method) ?? [];
    queued.push(response);
    this.responses.set(method, queued);
  }

  async initialize(params: AppServerInitializeParams): Promise<AppServerInitializeResponse> {
    this.initializeCalls.push(params);
    return INITIALIZE_RESPONSE;
  }

  async sendRequest<TResult, TParams>(method: string, params: TParams): Promise<TResult> {
    this.requestCalls.push({ method, params });
    const response = this.responses.get(method)?.shift();
    if (response === undefined) throw new Error(`No fake response queued for ${method}`);
    return await response as TResult;
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => {
      if (!resolvePromise) throw new Error('Deferred promise was not initialized');
      resolvePromise(value);
    },
  };
}

async function initializedSession(
  client: FakeTurnSessionClient,
  events: TurnSessionEvent[] = [],
): Promise<CodexAppServerTurnSession> {
  const session = new CodexAppServerTurnSession(client, {
    onEvent: (event) => events.push(event),
  });
  await session.initialize(INITIALIZE_PARAMS);
  return session;
}

async function activeSession(
  client: FakeTurnSessionClient,
  events: TurnSessionEvent[] = [],
): Promise<CodexAppServerTurnSession> {
  const session = await initializedSession(client, events);
  client.queueResponse('thread/start', { thread: { id: 'thread-1' } });
  await session.startThread({ cwd: '/workspace', model: 'gpt-test' });
  client.queueResponse('turn/start', { turn: { id: 'turn-1' } });
  await session.startTurn('Inspect the repository');
  return session;
}

describe('CodexAppServerTurnSession', () => {
  it('initializes and starts or resumes one typed thread', async () => {
    const startClient = new FakeTurnSessionClient();
    const startSession = await initializedSession(startClient);
    startClient.queueResponse('thread/start', { thread: { id: 'thread-started' } });

    await expect(startSession.startThread({
      cwd: '/workspace',
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
    })).resolves.toEqual({ threadId: 'thread-started' });
    expect(startClient.initializeCalls).toEqual([INITIALIZE_PARAMS]);
    expect(startClient.requestCalls).toEqual([{
      method: 'thread/start',
      params: {
        cwd: '/workspace',
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
      },
    }]);
    expect(startSession.threadId).toBe('thread-started');

    const resumeClient = new FakeTurnSessionClient();
    const resumeSession = await initializedSession(resumeClient);
    resumeClient.queueResponse('thread/resume', { thread: { id: 'thread-resumed' } });

    await expect(resumeSession.resumeThread({
      threadId: 'thread-resumed',
      cwd: '/workspace',
      excludeTurns: true,
    })).resolves.toEqual({ threadId: 'thread-resumed' });
    expect(resumeClient.requestCalls).toEqual([{
      method: 'thread/resume',
      params: {
        threadId: 'thread-resumed',
        cwd: '/workspace',
        excludeTurns: true,
      },
    }]);
  });

  it('extracts and reconciles thread IDs from notifications and responses', async () => {
    const client = new FakeTurnSessionClient();
    const events: TurnSessionEvent[] = [];
    const session = await initializedSession(client, events);
    const response = deferred<unknown>();
    client.queueResponse('thread/start', response.promise);

    const pending = session.startThread();
    session.handleNotification({
      method: 'thread/started',
      params: { thread: { id: 'thread-1' } },
    });
    response.resolve({ thread: { id: 'thread-1' } });

    await expect(pending).resolves.toEqual({ threadId: 'thread-1' });
    expect(events).toEqual([{ type: 'thread.started', threadId: 'thread-1' }]);

    const mismatchClient = new FakeTurnSessionClient();
    const mismatchSession = await initializedSession(mismatchClient);
    const mismatchResponse = deferred<unknown>();
    mismatchClient.queueResponse('thread/start', mismatchResponse.promise);
    const mismatched = mismatchSession.startThread();
    mismatchSession.handleNotification({
      method: 'thread/started',
      params: { thread: { id: 'notification-thread' } },
    });
    mismatchResponse.resolve({ thread: { id: 'response-thread' } });

    await expect(mismatched).rejects.toMatchObject({
      name: 'AppServerProtocolError',
      message: expect.stringContaining('did not match notification'),
    });
  });

  it('starts and interrupts a turn with the bound IDs', async () => {
    const client = new FakeTurnSessionClient();
    const session = await initializedSession(client);
    client.queueResponse('thread/start', { thread: { id: 'thread-1' } });
    await session.startThread();
    client.queueResponse('turn/start', { turn: { id: 'turn-1' } });

    await expect(session.startTurn('Run focused tests', {
      model: 'gpt-test',
      effort: 'high',
    })).resolves.toEqual({ threadId: 'thread-1', turnId: 'turn-1' });
    expect(client.requestCalls[1]).toEqual({
      method: 'turn/start',
      params: {
        model: 'gpt-test',
        effort: 'high',
        threadId: 'thread-1',
        input: [{ type: 'text', text: 'Run focused tests', text_elements: [] }],
      },
    });
    expect(session.activeTurnId).toBe('turn-1');

    client.queueResponse('turn/interrupt', {});
    await session.interruptTurn();
    expect(client.requestCalls[2]).toEqual({
      method: 'turn/interrupt',
      params: { threadId: 'thread-1', turnId: 'turn-1' },
    });
    expect(session.activeTurnId).toBe('turn-1');
  });

  it('maps exact 0.143.0 token usage notifications for the active turn', async () => {
    const client = new FakeTurnSessionClient();
    const events: TurnSessionEvent[] = [];
    const session = await activeSession(client, events);

    session.handleNotification({
      method: 'thread/tokenUsage/updated',
      params: TOKEN_USAGE_UPDATED_PARAMS,
    });
    session.handleNotification({
      method: 'thread/tokenUsage/updated',
      params: {
        ...TOKEN_USAGE_UPDATED_PARAMS,
        tokenUsage: {
          ...TOKEN_USAGE_UPDATED_PARAMS.tokenUsage,
          modelContextWindow: null,
        },
      },
    });

    expect(events).toEqual([
      {
        type: 'thread.tokenUsage.updated',
        ...TOKEN_USAGE_UPDATED_PARAMS,
      },
      {
        type: 'thread.tokenUsage.updated',
        ...TOKEN_USAGE_UPDATED_PARAMS,
        tokenUsage: {
          ...TOKEN_USAGE_UPDATED_PARAMS.tokenUsage,
          modelContextWindow: null,
        },
      },
    ]);
  });

  it('preserves malformed and stale token usage notifications as raw', async () => {
    const client = new FakeTurnSessionClient();
    const events: TurnSessionEvent[] = [];
    const session = await activeSession(client, events);
    const malformedBreakdown: AppServerNotification = {
      method: 'thread/tokenUsage/updated',
      params: {
        ...TOKEN_USAGE_UPDATED_PARAMS,
        tokenUsage: {
          ...TOKEN_USAGE_UPDATED_PARAMS.tokenUsage,
          last: {
            totalTokens: 150,
            inputTokens: 120,
            cachedInputTokens: 20,
            outputTokens: 30,
          },
        },
      },
    };
    const malformedContextWindow: AppServerNotification = {
      method: 'thread/tokenUsage/updated',
      params: {
        ...TOKEN_USAGE_UPDATED_PARAMS,
        tokenUsage: {
          ...TOKEN_USAGE_UPDATED_PARAMS.tokenUsage,
          modelContextWindow: '258400',
        },
      },
    };
    const staleThread: AppServerNotification = {
      method: 'thread/tokenUsage/updated',
      params: { ...TOKEN_USAGE_UPDATED_PARAMS, threadId: 'thread-stale' },
    };
    const staleTurn: AppServerNotification = {
      method: 'thread/tokenUsage/updated',
      params: { ...TOKEN_USAGE_UPDATED_PARAMS, turnId: 'turn-stale' },
    };
    const notifications = [
      malformedBreakdown,
      malformedContextWindow,
      staleThread,
      staleTurn,
    ];

    for (const notification of notifications) session.handleNotification(notification);

    expect(events).toEqual(notifications.map((notification) => ({
      type: 'raw',
      notification,
    })));
  });

  it('maps the bounded item set used by a later manager adapter', async () => {
    const client = new FakeTurnSessionClient();
    const events: TurnSessionEvent[] = [];
    const session = await activeSession(client, events);
    const items: Array<{ type: string; [key: string]: AppServerJsonValue }> = [
      { type: 'agentMessage', id: 'agent', text: 'done' },
      { type: 'reasoning', id: 'reason', summary: ['summary'], content: ['detail'] },
      {
        type: 'commandExecution',
        id: 'command',
        command: 'pnpm test',
        status: 'completed',
        aggregatedOutput: 'ok',
        exitCode: 0,
      },
      {
        type: 'fileChange',
        id: 'file',
        status: 'completed',
        changes: [{ path: 'a.ts', kind: 'update', diff: '@@ change' }],
      },
      {
        type: 'mcpToolCall',
        id: 'mcp',
        server: 'cyboflow',
        tool: 'report',
        status: 'completed',
        arguments: { step: 'verify' },
        result: { content: [], structuredContent: null, _meta: null },
        error: null,
      },
      { type: 'webSearch', id: 'search', query: 'Codex protocol' },
      { type: 'plan', id: 'plan', text: '1. Verify' },
    ];

    session.handleNotification({
      method: 'turn/started',
      params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
    });
    for (const [index, item] of items.entries()) {
      session.handleNotification({
        method: index === 0 ? 'item/started' : 'item/completed',
        params: index === 0
          ? { threadId: 'thread-1', turnId: 'turn-1', item, startedAtMs: index + 1 }
          : { threadId: 'thread-1', turnId: 'turn-1', item, completedAtMs: index + 1 },
      });
    }

    expect(events[0]).toEqual({
      type: 'turn.started',
      threadId: 'thread-1',
      turnId: 'turn-1',
    });
    expect(events.slice(1).map((event) => event.type)).toEqual([
      'item.started',
      'item.completed',
      'item.completed',
      'item.completed',
      'item.completed',
      'item.completed',
      'item.completed',
    ]);
    expect(events.slice(1).map((event) => (
      'item' in event ? event.item.type : null
    ))).toEqual(items.map((item) => item.type));
  });

  it('maps retry errors and terminal completion, interruption, and failure', async () => {
    const client = new FakeTurnSessionClient();
    const events: TurnSessionEvent[] = [];
    const session = await activeSession(client, events);

    session.handleNotification({
      method: 'error',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        willRetry: true,
        error: {
          message: 'temporary failure',
          codexErrorInfo: null,
          additionalDetails: null,
        },
      },
    });
    session.handleNotification({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'completed', error: null },
      },
    });
    expect(session.activeTurnId).toBeNull();

    client.queueResponse('turn/start', { turn: { id: 'turn-2' } });
    await session.startTurn('Continue');
    session.handleNotification({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-2', status: 'interrupted', error: null },
      },
    });

    client.queueResponse('turn/start', { turn: { id: 'turn-3' } });
    await session.startTurn('Retry');
    session.handleNotification({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-3',
          status: 'failed',
          error: {
            message: 'terminal failure',
            codexErrorInfo: { type: 'other' },
            additionalDetails: 'details',
          },
        },
      },
    });

    expect(events).toEqual([
      {
        type: 'turn.error',
        threadId: 'thread-1',
        turnId: 'turn-1',
        willRetry: true,
        error: {
          message: 'temporary failure',
          codexErrorInfo: null,
          additionalDetails: null,
        },
      },
      {
        type: 'turn.completed',
        threadId: 'thread-1',
        turnId: 'turn-1',
        status: 'completed',
      },
      {
        type: 'turn.completed',
        threadId: 'thread-1',
        turnId: 'turn-2',
        status: 'interrupted',
      },
      {
        type: 'turn.failed',
        threadId: 'thread-1',
        turnId: 'turn-3',
        error: {
          message: 'terminal failure',
          codexErrorInfo: { type: 'other' },
          additionalDetails: 'details',
        },
      },
    ]);
    expect(session.activeTurnId).toBeNull();
  });

  it('preserves unsupported and malformed notifications without reinterpretation', async () => {
    const client = new FakeTurnSessionClient();
    const events: TurnSessionEvent[] = [];
    const session = await activeSession(client, events);
    const unsupported: AppServerNotification = {
      method: 'turn/plan/updated',
      params: { threadId: 'thread-1', turnId: 'turn-1', plan: [] },
    };
    const malformed: AppServerNotification = {
      method: 'item/completed',
      params: { threadId: 'thread-1', turnId: 'turn-1', completedAtMs: 'later' },
    };
    const unknownItem = { type: 'futureItem', id: 'future', payload: { answer: 42 } };

    session.handleNotification(unsupported);
    session.handleNotification(malformed);
    session.handleNotification({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: unknownItem,
        completedAtMs: 10,
      },
    });

    expect(events[0]).toEqual({ type: 'raw', notification: unsupported });
    expect(events[1]).toEqual({ type: 'raw', notification: malformed });
    expect(events[2]).toEqual({
      type: 'item.completed',
      threadId: 'thread-1',
      turnId: 'turn-1',
      completedAtMs: 10,
      item: {
        type: 'raw',
        itemType: 'futureItem',
        item: unknownItem,
      },
    });
  });

  it('rejects malformed IDs and invalid lifecycle calls', async () => {
    const client = new FakeTurnSessionClient();
    const session = new CodexAppServerTurnSession(client);

    await expect(session.startThread()).rejects.toBeInstanceOf(AppServerProtocolError);
    await session.initialize(INITIALIZE_PARAMS);
    await expect(session.initialize(INITIALIZE_PARAMS)).rejects.toBeInstanceOf(
      AppServerProtocolError,
    );

    client.queueResponse('thread/start', { thread: {} });
    await expect(session.startThread()).rejects.toMatchObject({
      name: 'AppServerProtocolError',
      message: 'Codex app-server returned a malformed thread/start result',
    });

    const turnClient = new FakeTurnSessionClient();
    const turnSession = await initializedSession(turnClient);
    turnClient.queueResponse('thread/start', { thread: { id: 'thread-1' } });
    await turnSession.startThread();
    turnClient.queueResponse('turn/start', { turn: {} });
    await expect(turnSession.startTurn('test')).rejects.toMatchObject({
      name: 'AppServerProtocolError',
      message: 'Codex app-server returned a malformed turn/start result',
    });
    await expect(turnSession.interruptTurn()).rejects.toBeInstanceOf(AppServerProtocolError);
  });
});
