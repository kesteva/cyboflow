/**
 * fakeCodexAppServer — a shared, typed fake of the Codex app-server client for
 * CodexSdkManager tests that need MULTI-THREAD traffic (collab children and
 * grandchildren), which the root-only fakes local to older tests cannot emit.
 *
 *   1. `createFakeCodexAppServer()` returns a `CodexAppServerClientFactory` plus
 *      every client it built. Each client answers the handshake
 *      (account/read, thread/start|resume) and `turn/start` (minting
 *      `turn-<n>`), then runs the test's `onTurnStart` script on a macrotask —
 *      the same ordering the real app-server has (the response lands first).
 *   2. `codexNotification.*` builders — every params object is checked with
 *      `satisfies` against the reviewed protocol types, so a protocol edit that
 *      changes a shape fails typecheck here.
 *
 * A STOPPED client drops every notification (`notify` returns false), exactly
 * like a dead process: tests use that to prove nothing is counted after stop.
 */
import type { AppServerNotification, CodexAppServerClientOptions } from '../../services/panels/codex/appServer/client';
import type {
  AppServerInitializeParams,
  AppServerInitializeResponse,
  AppServerJsonValue,
  RawResponseCompletedNotification,
  ThreadTokenUsageUpdatedNotification,
  TokenUsageBreakdown,
} from '../../services/panels/codex/appServer/protocol';
import type {
  CodexAppServerClientFactory,
  CodexAppServerClientLike,
} from '../../services/panels/codex/codexSdkManager';

export interface FakeCodexTurn {
  client: FakeCodexAppServerClient;
  threadId: string;
  turnId: string;
  /** 0-based index of this turn on its client. */
  index: number;
}

export interface FakeCodexAppServerOptions {
  /** The root thread id thread/start and thread/resume answer with. */
  threadId?: string;
  /** Runs after each `turn/start` response; emit the turn's notifications here. */
  onTurnStart?: (turn: FakeCodexTurn) => void;
}

export class FakeCodexAppServerClient implements CodexAppServerClientLike {
  startCalls = 0;
  stopCalls = 0;
  stopped = false;
  readonly requests: Array<{ method: string; params: unknown }> = [];
  private turnCount = 0;

  constructor(
    readonly options: CodexAppServerClientOptions,
    private readonly fakeOptions: FakeCodexAppServerOptions,
  ) {}

  get threadId(): string {
    return this.fakeOptions.threadId ?? 'root-thread';
  }

  start(): void {
    this.startCalls += 1;
  }

  async stop(_signal?: NodeJS.Signals): Promise<void> {
    this.stopCalls += 1;
    this.stopped = true;
  }

  async initialize(_params: AppServerInitializeParams): Promise<AppServerInitializeResponse> {
    return {
      userAgent: 'codex-cli/0.159.2',
      codexHome: '/home/user/.codex',
      platformFamily: 'unix',
      platformOs: 'macos',
    };
  }

  async sendRequest<TResult, TParams>(method: string, params: TParams): Promise<TResult> {
    this.requests.push({ method, params });
    return this.answer(method) as TResult;
  }

  /** Delivers one notification; false (dropped) once the client is stopped. */
  notify(notification: AppServerNotification): boolean {
    if (this.stopped) return false;
    this.options.onNotification?.(notification);
    return true;
  }

  private answer(method: string): unknown {
    switch (method) {
      case 'account/read':
        return {
          account: { type: 'chatgpt', email: 'user@example.com', planType: 'pro' },
          requiresOpenaiAuth: true,
        };
      case 'thread/start':
      case 'thread/resume':
        return { thread: { id: this.threadId } };
      case 'turn/interrupt':
        return {};
      case 'turn/start': {
        const index = this.turnCount;
        this.turnCount += 1;
        const turnId = `turn-${index + 1}`;
        const onTurnStart = this.fakeOptions.onTurnStart;
        if (onTurnStart) {
          setTimeout(() => onTurnStart({ client: this, threadId: this.threadId, turnId, index }), 0);
        }
        return { turn: { id: turnId } };
      }
      default:
        throw new Error(`FakeCodexAppServerClient: unexpected request ${method}`);
    }
  }
}

export function createFakeCodexAppServer(options: FakeCodexAppServerOptions = {}): {
  factory: CodexAppServerClientFactory;
  clients: FakeCodexAppServerClient[];
} {
  const clients: FakeCodexAppServerClient[] = [];
  return {
    factory: (clientOptions) => {
      const client = new FakeCodexAppServerClient(clientOptions, options);
      clients.push(client);
      return client;
    },
    clients,
  };
}

function toJson(value: object): AppServerJsonValue {
  return JSON.parse(JSON.stringify(value)) as AppServerJsonValue;
}

/** A Codex usage breakdown; `input` is the WHOLE prompt (cached included). */
export function codexUsage(
  input: number,
  output: number,
  cached = 0,
  cacheWrite = 0,
  reasoning = 0,
): TokenUsageBreakdown {
  return {
    totalTokens: input + output,
    inputTokens: input,
    cachedInputTokens: cached,
    cacheWriteInputTokens: cacheWrite,
    outputTokens: output,
    reasoningOutputTokens: reasoning,
  };
}

export const codexNotification = {
  rawResponse(
    threadId: string,
    turnId: string,
    responseId: string,
    usage: TokenUsageBreakdown | null,
  ): AppServerNotification {
    const params = { threadId, turnId, responseId, usage, usageMetadata: null } satisfies RawResponseCompletedNotification;
    return { method: 'rawResponse/completed', params: toJson(params) };
  },

  tokenUsage(
    threadId: string,
    turnId: string,
    total: TokenUsageBreakdown,
    last: TokenUsageBreakdown,
  ): AppServerNotification {
    const params = {
      threadId,
      turnId,
      tokenUsage: { total, last, modelContextWindow: 258_400 },
    } satisfies ThreadTokenUsageUpdatedNotification;
    return { method: 'thread/tokenUsage/updated', params: toJson(params) };
  },

  /** A `collabAgentToolCall` spawnAgent item (senderThreadId = the emitting thread). */
  spawnAgent(
    senderThreadId: string,
    turnId: string,
    receiverThreadIds: string[],
    model: string | null,
    phase: 'item/started' | 'item/completed' = 'item/completed',
  ): AppServerNotification {
    return {
      method: phase,
      params: toJson({
        threadId: senderThreadId,
        turnId,
        [phase === 'item/started' ? 'startedAtMs' : 'completedAtMs']: 1,
        item: {
          type: 'collabAgentToolCall',
          id: `spawn-${receiverThreadIds.join('-')}`,
          tool: 'spawnAgent',
          status: phase === 'item/started' ? 'inProgress' : 'completed',
          senderThreadId,
          receiverThreadIds,
          prompt: 'do the child work',
          model,
          reasoningEffort: null,
          agentsStates: {},
        },
      }),
    };
  },

  /**
   * A 0.156.1 `spawn_agent` function call, as its `rawResponseItem/completed`
   * notification carries it. Its `callId` is the id of the child's
   * `subAgentActivity` started item (see `subAgentStarted`).
   */
  spawnAgentCall(
    senderThreadId: string,
    turnId: string,
    callId: string,
    args: { agent_type?: string; model?: string; task_name?: string },
  ): AppServerNotification {
    return {
      method: 'rawResponseItem/completed',
      params: toJson({
        threadId: senderThreadId,
        turnId,
        item: {
          type: 'function_call',
          id: `fc-${callId}`,
          name: 'spawn_agent',
          namespace: 'collaboration',
          arguments: JSON.stringify({ task_name: 'child', ...args }),
          call_id: callId,
        },
      }),
    };
  },

  /** A 0.156.1 `subAgentActivity` started item — the child announcement, which names no model. */
  subAgentStarted(senderThreadId: string, turnId: string, agentThreadId: string, callId: string): AppServerNotification {
    return {
      method: 'item/started',
      params: toJson({
        threadId: senderThreadId,
        turnId,
        startedAtMs: 1,
        item: { type: 'subAgentActivity', id: callId, kind: 'started', agentThreadId, agentPath: '/root/child' },
      }),
    };
  },

  turnStarted(threadId: string, turnId: string): AppServerNotification {
    return { method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress' } } };
  },

  turnCompleted(
    threadId: string,
    turnId: string,
    status: 'completed' | 'interrupted' = 'completed',
  ): AppServerNotification {
    return { method: 'turn/completed', params: { threadId, turn: { id: turnId, status } } };
  },

  agentMessage(threadId: string, turnId: string, text: string): AppServerNotification {
    return {
      method: 'item/completed',
      params: {
        threadId,
        turnId,
        completedAtMs: 1,
        item: { type: 'agentMessage', id: `message-${turnId}`, text },
      },
    };
  },
};
