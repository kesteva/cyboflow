import type { EvalStructuredQueryFn } from '../../../orchestrator/eval/evalJudgeQuery';
import { CodexJurorUnavailableError } from '../../../orchestrator/eval/codexJudge';
import type { LoggerLike } from '../../../orchestrator/types';
import {
  CODEX_EXECUTABLE_VERSION,
  prependCodexPathToEnvironment,
  resolveCodexExecutablePath,
  type ResolvedCodexExecutable,
} from './codexExecutablePath';
import {
  CodexChatGptAuthRequiredError,
  requireCodexChatGptAccount,
} from './appServer/account';
import {
  CodexAppServerClient,
  type CodexAppServerClientOptions,
} from './appServer/client';
import type {
  AppServerInitializeParams,
  AppServerJsonValue,
  AppServerModel,
  AppServerModelListParams,
} from './appServer/protocol';
import {
  CodexAppServerTurnSession,
  type TurnSessionClient,
  type TurnSessionEvent,
} from './appServer/turnSession';
import { toStrictOutputSchema } from './appServer/strictOutputSchema';

export const CODEX_EVAL_JUDGE_TIMEOUT_MS = 180_000;

export interface CodexEvalAppServerClient extends TurnSessionClient {
  start(): void;
  stop(signal?: NodeJS.Signals): Promise<void>;
}

export type CodexEvalAppServerClientFactory = (
  options: CodexAppServerClientOptions,
) => CodexEvalAppServerClient;

export interface CodexEvalJudgeQueryOptions {
  timeoutMs?: number;
  clientFactory?: CodexEvalAppServerClientFactory;
  resolveExecutable?: () => ResolvedCodexExecutable;
}

export interface CodexEvalStructuredQueryFn extends EvalStructuredQueryFn {
  getResolvedModel(): string | null;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
  readonly settled: boolean;
}

function createDeferred<T>(): Deferred<T> {
  let settled = false;
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    },
    reject: (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    },
    get settled() {
      return settled;
    },
  };
}

function initializeParams(): AppServerInitializeParams {
  return {
    clientInfo: {
      name: 'cyboflow-eval',
      title: 'Cyboflow Eval',
      version: CODEX_EXECUTABLE_VERSION,
    },
    capabilities: {
      experimentalApi: true,
      requestAttestation: false,
    },
  };
}

function defaultClientFactory(options: CodexAppServerClientOptions): CodexEvalAppServerClient {
  return new CodexAppServerClient(options);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toJsonValue(value: unknown): AppServerJsonValue {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (isRecord(value)) {
    const out: Record<string, AppServerJsonValue> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = toJsonValue(entry);
    return out;
  }
  throw new Error('Codex eval output schema is not JSON-serializable');
}

function parseModels(value: unknown): AppServerModel[] {
  if (!isRecord(value) || !Array.isArray(value.data)) return [];
  const models: AppServerModel[] = [];
  for (const entry of value.data) {
    if (
      !isRecord(entry)
      || typeof entry.id !== 'string'
      || typeof entry.model !== 'string'
      || typeof entry.displayName !== 'string'
      || typeof entry.description !== 'string'
      || typeof entry.hidden !== 'boolean'
      || typeof entry.isDefault !== 'boolean'
    ) {
      continue;
    }
    models.push({
      id: entry.id,
      model: entry.model,
      displayName: entry.displayName,
      description: entry.description,
      hidden: entry.hidden,
      isDefault: entry.isDefault,
    });
  }
  return models;
}

function makeDeadline(timeoutMs: number, signal?: AbortSignal): {
  promise: Promise<never>;
  didTimeOut(): boolean;
  didAbort(): boolean;
  cleanup(): void;
} {
  let timedOut = false;
  let aborted = signal?.aborted === true;
  let rejectDeadline!: (error: Error) => void;
  const promise = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  void promise.catch(() => undefined);
  const timer = setTimeout(() => {
    timedOut = true;
    rejectDeadline(new Error(`Codex eval judge query timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  const onAbort = (): void => {
    aborted = true;
    rejectDeadline(new Error('Codex eval judge query aborted'));
  };
  if (signal) {
    if (signal.aborted) queueMicrotask(onAbort);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    promise,
    didTimeOut: () => timedOut,
    didAbort: () => aborted,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

async function raceDeadline<T>(operation: Promise<T>, deadline: Promise<never>): Promise<T> {
  return Promise.race([operation, deadline]);
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`operation timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** One-shot Codex app-server structured query used only by the eval juror. */
export function makeCodexEvalJudgeQuery(
  logger?: LoggerLike,
  opts: CodexEvalJudgeQueryOptions = {},
): CodexEvalStructuredQueryFn {
  const timeoutMs = opts.timeoutMs ?? CODEX_EVAL_JUDGE_TIMEOUT_MS;
  const createClient = opts.clientFactory ?? defaultClientFactory;
  const resolveExecutable = opts.resolveExecutable ?? resolveCodexExecutablePath;
  let resolvedModel: string | null = null;

  const execute: EvalStructuredQueryFn = async ({ prompt, schema, cwd, model, signal }) => {
    let executable: ResolvedCodexExecutable;
    try {
      executable = resolveExecutable();
    } catch (error) {
      throw new CodexJurorUnavailableError(
        `Codex runtime missing: ${error instanceof Error ? error.message : String(error)}`,
        'runtime-missing',
      );
    }

    const terminal = createDeferred<string>();
    void terminal.promise.catch(() => undefined);
    let terminalAgentMessage = '';
    let turnSession: CodexAppServerTurnSession | null = null;
    const client = createClient({
      command: executable.executablePath,
      ...(cwd ? { cwd } : {}),
      env: prependCodexPathToEnvironment(process.env, executable.pathDir),
      onNotification: (notification) => turnSession?.handleNotification(notification),
      onStderr: (chunk) => logger?.warn('[codexEvalJudgeQuery] app-server stderr', {
        stderr: chunk.trimEnd(),
      }),
      onError: (error) => terminal.reject(error),
      onExit: ({ code, signal: exitSignal }) => {
        if (!terminal.settled) {
          terminal.reject(new Error(
            `Codex app-server exited before eval turn completion (code=${String(code)}, signal=${String(exitSignal)})`,
          ));
        }
      },
    });
    const handleTurnEvent = (event: TurnSessionEvent): void => {
      if (event.type === 'item.completed' && event.item.type === 'agentMessage') {
        terminalAgentMessage = event.item.text;
      } else if (event.type === 'turn.failed') {
        terminal.reject(new Error(event.error.message));
      } else if (event.type === 'turn.error' && !event.willRetry) {
        terminal.reject(new Error(event.error.message));
      } else if (event.type === 'turn.completed') {
        if (event.status === 'interrupted') {
          terminal.reject(new Error('Codex eval judge turn was interrupted'));
        } else if (terminalAgentMessage.trim().length === 0) {
          terminal.reject(new Error('Codex eval judge returned no terminal agent message'));
        } else {
          terminal.resolve(terminalAgentMessage);
        }
      }
    };
    turnSession = new CodexAppServerTurnSession(client, { onEvent: handleTurnEvent });
    const deadline = makeDeadline(timeoutMs, signal);

    try {
      client.start();
      const initialized = await raceDeadline(
        turnSession.initialize(initializeParams()),
        deadline.promise,
      );
      if (!initialized.userAgent.includes(CODEX_EXECUTABLE_VERSION)) {
        throw new Error(
          `Codex app-server protocol mismatch: expected ${CODEX_EXECUTABLE_VERSION}, got ${initialized.userAgent}`,
        );
      }

      try {
        const account = await raceDeadline(
          client.sendRequest<unknown, { refreshToken: false }>(
            'account/read',
            { refreshToken: false },
          ),
          deadline.promise,
        );
        requireCodexChatGptAccount(account);
      } catch (error) {
        if (error instanceof CodexChatGptAuthRequiredError) {
          throw new CodexJurorUnavailableError('Codex ChatGPT account is logged out', 'logged-out');
        }
        throw error;
      }

      if (model) {
        resolvedModel = model;
      } else {
        const params: AppServerModelListParams = { includeHidden: false };
        const response = await raceDeadline(
          client.sendRequest<unknown, AppServerModelListParams>('model/list', params),
          deadline.promise,
        );
        const models = parseModels(response).filter((entry) => !entry.hidden);
        resolvedModel = models.find((entry) => entry.isDefault)?.model
          ?? models[0]?.model
          ?? 'codex-default';
      }

      await raceDeadline(
        turnSession.startThread({
          ...(cwd ? { cwd } : {}),
          ephemeral: true,
        }),
        deadline.promise,
      );
      await raceDeadline(
        turnSession.startTurn(prompt, {
          model: resolvedModel,
          // Codex → OpenAI strict structured output rejects any object whose
          // `required` omits a property. The shared JUDGE_OUTPUT_SCHEMA marks
          // several finding fields optional (fine for the lenient Claude path),
          // so strict-ify it HERE — else every Codex juror sample 400s with
          // "Missing 'subCheckId'" and the juror fails 100% of evals.
          outputSchema: toJsonValue(toStrictOutputSchema(schema)),
          sandboxPolicy: { type: 'readOnly' },
          approvalPolicy: 'never',
        }),
        deadline.promise,
      );
      const text = await raceDeadline(terminal.promise, deadline.promise);
      try {
        return JSON.parse(text) as unknown;
      } catch (error) {
        throw new Error(
          `Codex eval judge returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } catch (error) {
      if ((deadline.didTimeOut() || deadline.didAbort()) && turnSession.activeTurnId) {
        try {
          await withTimeout(turnSession.interruptTurn(), 2_000);
        } catch (interruptError) {
          logger?.warn('[codexEvalJudgeQuery] turn interrupt failed', {
            error: interruptError instanceof Error ? interruptError.message : String(interruptError),
          });
        }
      }
      throw error;
    } finally {
      deadline.cleanup();
      await client.stop();
    }
  };
  return Object.assign(execute, {
    getResolvedModel: () => resolvedModel,
  });
}
