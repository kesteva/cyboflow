import { describe, expect, it, vi } from 'vitest';
import { CodexJurorUnavailableError } from '../../../../orchestrator/eval/codexJudge';
import type {
  AppServerNotification,
  CodexAppServerClientOptions,
} from '../appServer/client';
import type { AppServerInitializeParams } from '../appServer/protocol';
import {
  makeCodexEvalJudgeQuery,
  type CodexEvalAppServerClient,
} from '../codexEvalJudgeQuery';

type RequestHandler = (method: string, params: unknown, client: FakeClient) => unknown;

class FakeClient implements CodexEvalAppServerClient {
  readonly start = vi.fn(() => undefined);
  readonly stop = vi.fn(async (_signal?: NodeJS.Signals) => undefined);
  readonly initialize = vi.fn(async (_params: AppServerInitializeParams) => ({
    userAgent: 'codex-cli/0.144.3',
    codexHome: '/tmp/codex',
    platformFamily: 'unix',
    platformOs: 'macos',
  }));
  readonly requests: Array<{ method: string; params: unknown }> = [];

  constructor(
    readonly options: CodexAppServerClientOptions,
    private readonly handler: RequestHandler,
  ) {}

  async sendRequest<TResult, TParams>(method: string, params: TParams): Promise<TResult> {
    this.requests.push({ method, params });
    return this.handler(method, params, this) as TResult;
  }

  notify(notification: AppServerNotification): void {
    this.options.onNotification?.(notification);
  }
}

const executable = () => ({
  executablePath: '/app/codex/bin/codex',
  pathDir: '/app/codex/codex-path',
  version: '0.144.3' as const,
  target: 'aarch64-apple-darwin' as const,
});

const schema = {
  type: 'object',
  properties: { verdicts: { type: 'array' } },
};

function accountResponse(): unknown {
  return {
    account: { type: 'chatgpt', email: 'user@example.com', planType: 'pro' },
    requiresOpenaiAuth: false,
  };
}

function modelResponse(): unknown {
  return {
    data: [{
      id: 'gpt-5.4',
      model: 'gpt-5.4',
      displayName: 'GPT-5.4',
      description: 'Test model',
      hidden: false,
      isDefault: true,
    }],
    nextCursor: null,
  };
}

describe('makeCodexEvalJudgeQuery', () => {
  it('uses native outputSchema with read-only/never and always stops after success', async () => {
    const clients: FakeClient[] = [];
    const factory = (options: CodexAppServerClientOptions): FakeClient => {
      const client = new FakeClient(options, (method, _params, current) => {
        if (method === 'account/read') return accountResponse();
        if (method === 'model/list') return modelResponse();
        if (method === 'thread/start') return { thread: { id: 'thread-1' } };
        if (method === 'turn/start') {
          queueMicrotask(() => {
            current.notify({
              method: 'item/completed',
              params: {
                threadId: 'thread-1',
                turnId: 'turn-1',
                completedAtMs: 1,
                item: {
                  type: 'agentMessage',
                  id: 'message-1',
                  text: JSON.stringify({
                    verdicts: [{ id: 'COR-1', verdict: 'PASS', evidence: 'x.ts:1' }],
                    findings: [],
                  }),
                },
              },
            });
            current.notify({
              method: 'turn/completed',
              params: {
                threadId: 'thread-1',
                turn: { id: 'turn-1', status: 'completed' },
              },
            });
          });
          return { turn: { id: 'turn-1' } };
        }
        if (method === 'turn/interrupt') return {};
        throw new Error(`unexpected method ${method}`);
      });
      clients.push(client);
      return client;
    };
    const query = makeCodexEvalJudgeQuery(undefined, {
      clientFactory: factory,
      resolveExecutable: executable,
    });

    await expect(query({ prompt: 'grade', schema, cwd: '/workspace' })).resolves.toMatchObject({
      verdicts: [{ id: 'COR-1', verdict: 'PASS' }],
    });
    const client = clients[0];
    if (!client) throw new Error('fake client was not created');
    const turn = client.requests.find((request) => request.method === 'turn/start');
    expect(turn?.params).toMatchObject({
      model: 'gpt-5.4',
      // The schema is strict-ified for Codex/OpenAI structured output: every
      // property is promoted to `required` and originally-optional ones become
      // nullable (see strictOutputSchema). `verdicts` was optional here.
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['verdicts'],
        properties: { verdicts: { type: ['array', 'null'] } },
      },
      sandboxPolicy: { type: 'readOnly' },
      approvalPolicy: 'never',
    });
    expect(query.getResolvedModel()).toBe('gpt-5.4');
    expect(client.stop).toHaveBeenCalledTimes(1);
  });

  it('interrupts a timed-out active turn and stops in finally', async () => {
    const clients: FakeClient[] = [];
    const factory = (options: CodexAppServerClientOptions): FakeClient => {
      const client = new FakeClient(options, (method) => {
        if (method === 'account/read') return accountResponse();
        if (method === 'model/list') return modelResponse();
        if (method === 'thread/start') return { thread: { id: 'thread-1' } };
        if (method === 'turn/start') return { turn: { id: 'turn-1' } };
        if (method === 'turn/interrupt') return {};
        throw new Error(`unexpected method ${method}`);
      });
      clients.push(client);
      return client;
    };
    const query = makeCodexEvalJudgeQuery(undefined, {
      timeoutMs: 5,
      clientFactory: factory,
      resolveExecutable: executable,
    });

    await expect(query({ prompt: 'grade', schema })).rejects.toThrow(/timed out/i);
    const client = clients[0];
    if (!client) throw new Error('fake client was not created');
    expect(client.requests.some((request) => request.method === 'turn/interrupt')).toBe(true);
    expect(client.stop).toHaveBeenCalledTimes(1);
  });

  it('maps an invalid account response to deterministic logged-out unavailability', async () => {
    const clients: FakeClient[] = [];
    const factory = (options: CodexAppServerClientOptions): FakeClient => {
      const client = new FakeClient(options, (method) => {
        if (method === 'account/read') return { account: null, requiresOpenaiAuth: true };
        throw new Error(`unexpected method ${method}`);
      });
      clients.push(client);
      return client;
    };
    const query = makeCodexEvalJudgeQuery(undefined, {
      clientFactory: factory,
      resolveExecutable: executable,
    });

    const error = await query({ prompt: 'grade', schema }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CodexJurorUnavailableError);
    expect((error as CodexJurorUnavailableError).code).toBe('logged-out');
    const client = clients[0];
    if (!client) throw new Error('fake client was not created');
    expect(client.stop).toHaveBeenCalledTimes(1);
  });
});
