/**
 * codexVerificationAgentQuery unit tests. The module under test drives a ONE-SHOT
 * Codex app-server turn through an injected fake clientFactory (mirrors
 * codexEvalJudgeQuery.test.ts) — no real codex subprocess. Coverage: the happy path
 * (thread/turn params + strict outputSchema + transcript), env merge, model
 * passthrough vs account-default fallback, timeout→interrupt, malformed JSON,
 * executable-missing + logged-out unavailability, and the transcript accumulator.
 */
import { describe, expect, it, vi } from 'vitest';
import { delimiter } from 'node:path';
import type {
  AppServerNotification,
  CodexAppServerClientOptions,
} from '../../../services/panels/codex/appServer/client';
import type { AppServerInitializeParams } from '../../../services/panels/codex/appServer/protocol';
import type { TurnSessionEvent } from '../../../services/panels/codex/appServer/turnSession';
import { normalizeVerificationReportV1 } from '../../../../../shared/types/visualVerification';
import { VerificationAgentQueryError } from '../verificationAgentRunner';
import {
  makeCodexVerificationAgentQuery,
  createCodexVerifyTranscriptAccumulator,
  stripStrictSchemaNulls,
  type CodexVerifyAppServerClient,
} from '../codexVerificationAgentQuery';

type RequestHandler = (method: string, params: unknown, client: FakeClient) => unknown;

class FakeClient implements CodexVerifyAppServerClient {
  readonly start = vi.fn(() => undefined);
  readonly stop = vi.fn(async (_signal?: NodeJS.Signals) => undefined);
  readonly initialize = vi.fn(async (_params: AppServerInitializeParams) => ({
    userAgent: 'codex-cli/0.153.3',
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
  version: '0.153.3' as const,
  target: 'aarch64-apple-darwin' as const,
});

const SYSTEM_PROMPT = 'AGENT PERSONA + VERIFICATION HARNESS CONTRACT';

const baseArgs = {
  prompt: 'verify the widget',
  systemPrompt: SYSTEM_PROMPT,
  cwd: '/workspace',
  allowedTools: ['Bash', 'Read', 'Grep', 'Glob'],
  env: {
    VERIFY_ARTIFACTS_DIR: '/artifacts',
    VERIFY_DRIVER: '/artifacts/.driver/verify-driver.sh',
    VERIFY_DRIVER_PORT: '29261',
    VERIFY_PORT: '29260',
  },
};

function validReport(): unknown {
  return {
    version: 1,
    behaviors: [{ id: 'b1', result: 'pass', evidence: { screenshots: ['s.png'], notes: 'ok' } }],
    screenshots: [{ fileName: 's.png', caption: 'the widget' }],
    outcome: 'pass',
    confidence: 0.9,
    feedback: 'looks right',
    issues: [],
  };
}

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

/** Emit a commandExecution + agentMessage item, then complete the turn. */
function emitSuccessTurn(client: FakeClient, agentText: string): void {
  queueMicrotask(() => {
    client.notify({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        completedAtMs: 1,
        item: {
          type: 'commandExecution',
          id: 'cmd-1',
          command: 'npm run build',
          cwd: '/workspace',
          processId: null,
          source: 'agent',
          commandActions: [],
          status: 'completed',
          aggregatedOutput: 'build ok',
          exitCode: 0,
          durationMs: 100,
        },
      },
    });
    client.notify({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        completedAtMs: 2,
        item: { type: 'agentMessage', id: 'msg-1', text: agentText },
      },
    });
    client.notify({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
    });
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new Error('expected a record');
  return value as Record<string, unknown>;
}

describe('makeCodexVerificationAgentQuery', () => {
  it('runs a danger-full-access ephemeral turn (no MCP config) with a strict outputSchema and returns structured + transcript', async () => {
    const clients: FakeClient[] = [];
    const factory = (options: CodexAppServerClientOptions): FakeClient => {
      const client = new FakeClient(options, (method, _params, current) => {
        if (method === 'account/read') return accountResponse();
        if (method === 'model/list') return modelResponse();
        if (method === 'thread/start') return { thread: { id: 'thread-1' } };
        if (method === 'turn/start') {
          emitSuccessTurn(current, JSON.stringify(validReport()));
          return { turn: { id: 'turn-1' } };
        }
        if (method === 'turn/interrupt') return {};
        throw new Error(`unexpected method ${method}`);
      });
      clients.push(client);
      return client;
    };
    const query = makeCodexVerificationAgentQuery(undefined, undefined, {
      clientFactory: factory,
      resolveExecutable: executable,
    });

    const outcome = await query(baseArgs);
    expect(outcome.structured).toMatchObject({ outcome: 'pass', version: 1 });
    expect(outcome.transcript).toContain('npm run build');
    expect(outcome.transcript).toContain('Shell (exit 0)');
    expect(outcome.transcript).toContain('build ok');

    const client = clients[0];
    if (!client) throw new Error('fake client was not created');
    expect(client.stop).toHaveBeenCalledTimes(1);

    const thread = asRecord(client.requests.find((r) => r.method === 'thread/start')?.params);
    expect(thread.sandbox).toBe('danger-full-access');
    expect(thread.approvalPolicy).toBe('never');
    expect(thread.ephemeral).toBe(true);
    expect(thread.developerInstructions).toBe(SYSTEM_PROMPT);
    // Hermetic in config terms — NO cyboflow MCP server attached.
    expect('config' in thread).toBe(false);

    const turn = asRecord(client.requests.find((r) => r.method === 'turn/start')?.params);
    expect(turn.sandboxPolicy).toEqual({ type: 'dangerFullAccess' });
    expect(turn.approvalPolicy).toBe('never');
    // Proof toStrictOutputSchema ran: buildLogExcerpt (optional in the source schema)
    // is promoted to required AND made nullable.
    const outputSchema = asRecord(turn.outputSchema);
    expect(outputSchema.required).toContain('buildLogExcerpt');
    const props = asRecord(outputSchema.properties);
    const buildLog = asRecord(props.buildLogExcerpt);
    expect(buildLog.type).toContain('null');
  });

  it('strips strict-schema nulls so a schema-compliant Codex pass survives report normalization', async () => {
    // A STRICT-schema-compliant report: the model is FORCED to emit the
    // optional-made-nullable keys, so a normal pass carries these nulls.
    const strictReport = {
      ...(validReport() as Record<string, unknown>),
      buildLogExcerpt: null,
      issues: [
        { severity: 'low', description: 'nit', fileName: null },
        { severity: 'high', description: 'real', fileName: 's.png' },
      ],
    };
    const factory = (options: CodexAppServerClientOptions): FakeClient =>
      new FakeClient(options, (method, _params, current) => {
        if (method === 'account/read') return accountResponse();
        if (method === 'model/list') return modelResponse();
        if (method === 'thread/start') return { thread: { id: 'thread-1' } };
        if (method === 'turn/start') {
          emitSuccessTurn(current, JSON.stringify(strictReport));
          return { turn: { id: 'turn-1' } };
        }
        throw new Error(`unexpected method ${method}`);
      });
    const query = makeCodexVerificationAgentQuery(undefined, undefined, {
      clientFactory: factory,
      resolveExecutable: executable,
    });

    const outcome = await query(baseArgs);
    const structured = asRecord(outcome.structured);
    expect('buildLogExcerpt' in structured).toBe(false);
    const issues = structured.issues as Array<Record<string, unknown>>;
    expect('fileName' in issues[0]!).toBe(false);
    expect(issues[1]!.fileName).toBe('s.png');
    // The boundary-to-runner round trip: the stripped report passes the SAME
    // strict normalizer the runner applies (this was the fail-open-skip bug).
    const normalized = normalizeVerificationReportV1(outcome.structured, ['b1']);
    expect(normalized.ok).toBe(true);
  });

  it('merges the VERIFY_* env from args and prepends the codex PATH dir', async () => {
    const clients: FakeClient[] = [];
    const factory = (options: CodexAppServerClientOptions): FakeClient => {
      const client = new FakeClient(options, (method, _params, current) => {
        if (method === 'account/read') return accountResponse();
        if (method === 'model/list') return modelResponse();
        if (method === 'thread/start') return { thread: { id: 'thread-1' } };
        if (method === 'turn/start') {
          emitSuccessTurn(current, JSON.stringify(validReport()));
          return { turn: { id: 'turn-1' } };
        }
        throw new Error(`unexpected method ${method}`);
      });
      clients.push(client);
      return client;
    };
    const query = makeCodexVerificationAgentQuery(undefined, undefined, {
      clientFactory: factory,
      resolveExecutable: executable,
    });

    await query(baseArgs);
    const client = clients[0];
    if (!client) throw new Error('fake client was not created');
    const env = client.options.env ?? {};
    expect(env.VERIFY_ARTIFACTS_DIR).toBe('/artifacts');
    expect(env.VERIFY_DRIVER_PORT).toBe('29261');
    expect(env.VERIFY_PORT).toBe('29260');
    expect(env.PATH ?? '').toContain('/app/codex/codex-path');
    expect(client.options.cwd).toBe('/workspace');
  });

  // F3 / RC4 round-2 review (blocker). The runner now exports the real
  // login-shell PATH in args.env; `prependCodexPathToEnvironment` writes the
  // SAME key, so an args.env spread AFTER the prepend silently dropped
  // `executable.pathDir` — and with it the bundled Codex helper binaries
  // (ripgrep) the codex binary resolves from there. Both properties are pinned:
  // the harness PATH beats what this process inherited, AND pathDir is in front.
  it('keeps the codex PATH dir in front of the harness PATH from args.env', async () => {
    const clients: FakeClient[] = [];
    const factory = (options: CodexAppServerClientOptions): FakeClient => {
      const client = new FakeClient(options, (method, _params, current) => {
        if (method === 'account/read') return accountResponse();
        if (method === 'model/list') return modelResponse();
        if (method === 'thread/start') return { thread: { id: 'thread-1' } };
        if (method === 'turn/start') {
          emitSuccessTurn(current, JSON.stringify(validReport()));
          return { turn: { id: 'turn-1' } };
        }
        throw new Error(`unexpected method ${method}`);
      });
      clients.push(client);
      return client;
    };
    const query = makeCodexVerificationAgentQuery(undefined, undefined, {
      clientFactory: factory,
      resolveExecutable: executable,
    });

    await query({
      ...baseArgs,
      env: { ...baseArgs.env, PATH: '/opt/homebrew/bin:/usr/bin:/bin' },
    });
    const client = clients[0];
    if (!client) throw new Error('fake client was not created');
    const path = client.options.env?.PATH ?? '';
    // prependCodexPathToEnvironment joins with the HOST delimiter (';' on
    // Windows); the tail is the caller's PATH verbatim, whatever it contained.
    expect(path).toBe(['/app/codex/codex-path', '/opt/homebrew/bin:/usr/bin:/bin'].join(delimiter));
  });

  it('passes args.model through and skips model/list', async () => {
    const clients: FakeClient[] = [];
    const factory = (options: CodexAppServerClientOptions): FakeClient => {
      const client = new FakeClient(options, (method, _params, current) => {
        if (method === 'account/read') return accountResponse();
        if (method === 'model/list') throw new Error('model/list should not be called');
        if (method === 'thread/start') return { thread: { id: 'thread-1' } };
        if (method === 'turn/start') {
          emitSuccessTurn(current, JSON.stringify(validReport()));
          return { turn: { id: 'turn-1' } };
        }
        throw new Error(`unexpected method ${method}`);
      });
      clients.push(client);
      return client;
    };
    const query = makeCodexVerificationAgentQuery(undefined, undefined, {
      clientFactory: factory,
      resolveExecutable: executable,
    });

    await query({ ...baseArgs, model: 'gpt-custom' });
    const client = clients[0];
    if (!client) throw new Error('fake client was not created');
    expect(client.requests.some((r) => r.method === 'model/list')).toBe(false);
    const turn = asRecord(client.requests.find((r) => r.method === 'turn/start')?.params);
    expect(turn.model).toBe('gpt-custom');
  });

  it('resolves the account-default model when args.model is absent', async () => {
    const clients: FakeClient[] = [];
    const factory = (options: CodexAppServerClientOptions): FakeClient => {
      const client = new FakeClient(options, (method, _params, current) => {
        if (method === 'account/read') return accountResponse();
        if (method === 'model/list') return modelResponse();
        if (method === 'thread/start') return { thread: { id: 'thread-1' } };
        if (method === 'turn/start') {
          emitSuccessTurn(current, JSON.stringify(validReport()));
          return { turn: { id: 'turn-1' } };
        }
        throw new Error(`unexpected method ${method}`);
      });
      clients.push(client);
      return client;
    };
    const query = makeCodexVerificationAgentQuery(undefined, undefined, {
      clientFactory: factory,
      resolveExecutable: executable,
    });

    await query(baseArgs);
    const client = clients[0];
    if (!client) throw new Error('fake client was not created');
    const turn = asRecord(client.requests.find((r) => r.method === 'turn/start')?.params);
    expect(turn.model).toBe('gpt-5.4');
  });

  it('throws VerificationAgentQueryError on timeout, carrying the partial transcript, and interrupts the turn', async () => {
    const clients: FakeClient[] = [];
    const factory = (options: CodexAppServerClientOptions): FakeClient => {
      const client = new FakeClient(options, (method, _params, current) => {
        if (method === 'account/read') return accountResponse();
        if (method === 'model/list') return modelResponse();
        if (method === 'thread/start') return { thread: { id: 'thread-1' } };
        if (method === 'turn/start') {
          // Emit a command item (transcript content) but NEVER complete the turn.
          queueMicrotask(() => {
            current.notify({
              method: 'item/completed',
              params: {
                threadId: 'thread-1',
                turnId: 'turn-1',
                completedAtMs: 1,
                item: {
                  type: 'commandExecution',
                  id: 'cmd-1',
                  command: 'npm run build',
                  cwd: '/workspace',
                  processId: null,
                  source: 'agent',
                  commandActions: [],
                  status: 'completed',
                  aggregatedOutput: null,
                  exitCode: 0,
                  durationMs: 1,
                },
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
    const query = makeCodexVerificationAgentQuery(undefined, 5, {
      clientFactory: factory,
      resolveExecutable: executable,
    });

    const error = await query(baseArgs).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VerificationAgentQueryError);
    expect((error as VerificationAgentQueryError).message).toMatch(/timed out/i);
    // Classified as a real deadline expiry so the runner reports `timeout`, not `skipped`.
    expect((error as VerificationAgentQueryError).timedOut).toBe(true);
    expect((error as VerificationAgentQueryError).transcript).toContain('npm run build');
    const client = clients[0];
    if (!client) throw new Error('fake client was not created');
    expect(client.requests.some((r) => r.method === 'turn/interrupt')).toBe(true);
    expect(client.stop).toHaveBeenCalledTimes(1);
  });

  it("honors args.timeoutMs over the constructor default for the internal deadline", async () => {
    const factory = (options: CodexAppServerClientOptions): FakeClient =>
      new FakeClient(options, (method) => {
        if (method === 'account/read') return accountResponse();
        if (method === 'model/list') return modelResponse();
        if (method === 'thread/start') return { thread: { id: 'thread-1' } };
        // turn/start returns but the turn NEVER completes — only the deadline ends it.
        if (method === 'turn/start') return { turn: { id: 'turn-1' } };
        if (method === 'turn/interrupt') return {};
        throw new Error(`unexpected method ${method}`);
      });
    // Constructor default is a minute; the request's 5ms deadline must win.
    const query = makeCodexVerificationAgentQuery(undefined, 60_000, {
      clientFactory: factory,
      resolveExecutable: executable,
    });

    const error = await query({ ...baseArgs, timeoutMs: 5 }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VerificationAgentQueryError);
    expect((error as VerificationAgentQueryError).message).toContain('timed out after 5ms');
    expect((error as VerificationAgentQueryError).timedOut).toBe(true);
  });

  it('throws VerificationAgentQueryError on a malformed terminal agent message', async () => {
    const factory = (options: CodexAppServerClientOptions): FakeClient =>
      new FakeClient(options, (method, _params, current) => {
        if (method === 'account/read') return accountResponse();
        if (method === 'model/list') return modelResponse();
        if (method === 'thread/start') return { thread: { id: 'thread-1' } };
        if (method === 'turn/start') {
          emitSuccessTurn(current, 'not json {');
          return { turn: { id: 'turn-1' } };
        }
        throw new Error(`unexpected method ${method}`);
      });
    const query = makeCodexVerificationAgentQuery(undefined, undefined, {
      clientFactory: factory,
      resolveExecutable: executable,
    });

    const error = await query(baseArgs).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VerificationAgentQueryError);
    expect((error as VerificationAgentQueryError).message).toMatch(/malformed JSON/i);
  });

  it('maps a missing executable to VerificationAgentQueryError with an actionable message', async () => {
    const query = makeCodexVerificationAgentQuery(undefined, undefined, {
      resolveExecutable: () => {
        throw new Error('codex native package not found');
      },
    });
    const error = await query(baseArgs).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VerificationAgentQueryError);
    expect((error as VerificationAgentQueryError).message).toContain('Codex runtime missing');
  });

  it('maps a logged-out account to VerificationAgentQueryError', async () => {
    const factory = (options: CodexAppServerClientOptions): FakeClient =>
      new FakeClient(options, (method) => {
        if (method === 'account/read') return { account: null, requiresOpenaiAuth: true };
        throw new Error(`unexpected method ${method}`);
      });
    const query = makeCodexVerificationAgentQuery(undefined, undefined, {
      clientFactory: factory,
      resolveExecutable: executable,
    });

    const error = await query(baseArgs).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VerificationAgentQueryError);
    expect((error as VerificationAgentQueryError).message).toContain('Codex ChatGPT account is logged out');
  });
});

describe('stripStrictSchemaNulls', () => {
  it('preserves a real buildLogExcerpt string and non-null fileNames', () => {
    const report = {
      outcome: 'build_failed',
      buildLogExcerpt: 'tsc exploded',
      issues: [{ severity: 'high', description: 'broken', fileName: 'log.png' }],
    };
    expect(stripStrictSchemaNulls(report)).toEqual(report);
  });

  it('passes a non-record value through untouched', () => {
    expect(stripStrictSchemaNulls(null)).toBeNull();
    expect(stripStrictSchemaNulls('not a report')).toBe('not a report');
  });
});

describe('createCodexVerifyTranscriptAccumulator', () => {
  type CompletedItem = Extract<TurnSessionEvent, { type: 'item.completed' }>['item'];
  function completed(item: CompletedItem): TurnSessionEvent {
    return { type: 'item.completed', threadId: 't', turnId: 'u', item, completedAtMs: 1 };
  }

  it('caps the command excerpt at 600 and the output excerpt at 1500', () => {
    const acc = createCodexVerifyTranscriptAccumulator();
    acc.onEvent(completed({
      type: 'commandExecution',
      id: 'c',
      command: 'x'.repeat(700),
      cwd: '/w',
      processId: null,
      source: 'agent',
      commandActions: [],
      status: 'completed',
      aggregatedOutput: 'y'.repeat(2000),
      exitCode: 0,
      durationMs: 1,
    }));
    const text = acc.text() ?? '';
    expect(text).toContain(`${'x'.repeat(600)}…`);
    expect(text).not.toContain('x'.repeat(601));
    expect(text).toContain(`${'y'.repeat(1500)}…`);
    expect(text).not.toContain('y'.repeat(1501));
  });

  it('appends the total-cap truncation marker exactly once', () => {
    const acc = createCodexVerifyTranscriptAccumulator();
    for (let i = 0; i < 6; i++) {
      acc.onEvent(completed({
        type: 'agentMessage',
        id: `m${i}`,
        text: 'z'.repeat(100_000),
        questions: null,
      }));
    }
    const text = acc.text() ?? '';
    const marker = '[transcript truncated at 400000 chars]';
    const occurrences = text.split(marker).length - 1;
    expect(occurrences).toBe(1);
  });

  it('logs one audit line per fileChange', () => {
    const acc = createCodexVerifyTranscriptAccumulator();
    acc.onEvent(completed({
      type: 'fileChange',
      id: 'f',
      status: 'completed',
      changes: [{ path: 'src/a.ts', kind: { type: 'update', move_path: null }, diff: '' }],
    }));
    expect(acc.text()).toContain('**File change (update):** src/a.ts');
  });

  it('is a no-op for unhandled item types and non-item.completed events', () => {
    const acc = createCodexVerifyTranscriptAccumulator();
    acc.onEvent(completed({ type: 'reasoning', id: 'r', summary: [], content: ['thinking'] }));
    acc.onEvent({ type: 'turn.started', threadId: 't', turnId: 'u' });
    expect(acc.text()).toBeNull();
  });
});
