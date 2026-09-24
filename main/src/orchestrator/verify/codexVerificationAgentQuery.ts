/**
 * codexVerificationAgentQuery — the CODEX runtime sibling of verificationAgentQuery
 * (docs/proposals/verification-agent-redesign.md, Codex-verifier follow-up). It is
 * the `VerificationAgentQueryFn` implementation the runner dispatches to when the
 * resolved `visual-verify` agent runs on the Codex provider (an explicit
 * `runtime: 'codex-sdk'` pin, or an unpinned agent inheriting a Codex-provider run).
 * Structurally it mirrors codexEvalJudgeQuery.ts: a ONE-SHOT Codex app-server
 * structured turn (executable resolution → account check → ephemeral thread → one
 * turn → strict outputSchema → JSON parse of the terminal agent message).
 *
 * Sandbox posture (config decision, do not revisit): the thread runs
 * `sandbox: 'danger-full-access'` / `approvalPolicy: 'never'` with a turn-level
 * `sandboxPolicy: { type: 'dangerFullAccess' }` — parity with the Claude verifier's
 * actual (OS-unsandboxed) posture, since the verifier must build/serve/drive a real
 * deliverable. It is nevertheless HERMETIC in config terms: NO `config` is attached
 * to the thread, so there is no cyboflow MCP server and no cyboflow-state write path.
 * The workflow persona + immutable harness contract ride as `developerInstructions`.
 *
 * Like verificationAgentQuery, on timeout/error this THROWS a
 * {@link VerificationAgentQueryError} carrying whatever transcript accumulated
 * before the failure, so the runner's catch writes the partial transcript fail-soft
 * before mapping the throw to the fail-open `skipped` bucket. If Codex is
 * unavailable (executable missing, logged out) that too surfaces as a
 * VerificationAgentQueryError — the runner maps it to `skipped` with an actionable
 * message; there is NO silent Claude fallback.
 *
 * ⚠️ NOT live-verifiable headlessly (it makes a real Codex app-server call).
 */
import type { LoggerLike } from '../types';
import {
  VERIFICATION_AGENT_TIMEOUT_MS,
  VERIFICATION_REPORT_JSON_SCHEMA,
} from './verificationAgentQuery';
import {
  VerificationAgentQueryError,
  type VerificationAgentQueryFn,
} from './verificationAgentRunner';
import {
  CODEX_EXECUTABLE_VERSION,
  prependCodexPathToEnvironment,
  resolveCodexExecutablePath,
  type ResolvedCodexExecutable,
} from '../../services/panels/codex/codexExecutablePath';
import {
  CodexChatGptAuthRequiredError,
  requireCodexChatGptAccount,
} from '../../services/panels/codex/appServer/account';
import {
  CodexAppServerClient,
  type CodexAppServerClientOptions,
} from '../../services/panels/codex/appServer/client';
import type {
  AppServerInitializeParams,
  AppServerJsonValue,
  AppServerModel,
  AppServerModelListParams,
} from '../../services/panels/codex/appServer/protocol';
import {
  CodexAppServerTurnSession,
  type TurnSessionClient,
  type TurnSessionEvent,
} from '../../services/panels/codex/appServer/turnSession';
import { toStrictOutputSchema } from '../../services/panels/codex/appServer/strictOutputSchema';
import { observeCodexNotification } from '../../services/providerUsage/codexUsageObserver';

/** The one-shot app-server client this query drives (mirrors CodexEvalAppServerClient). */
export interface CodexVerifyAppServerClient extends TurnSessionClient {
  start(): void;
  stop(signal?: NodeJS.Signals): Promise<void>;
}

export type CodexVerifyAppServerClientFactory = (
  options: CodexAppServerClientOptions,
) => CodexVerifyAppServerClient;

export interface CodexVerificationAgentQueryOptions {
  clientFactory?: CodexVerifyAppServerClientFactory;
  resolveExecutable?: () => ResolvedCodexExecutable;
}

// ---------------------------------------------------------------------------
// Transcript accumulator (verifier-transcript capture) — mirrors the caps + shape
// of createTranscriptAccumulator in verificationAgentQuery.ts, but reads Codex
// TurnSessionEvents instead of Claude SDK messages. Exported for unit tests.
// ---------------------------------------------------------------------------

/** Hard ceiling on the total accumulated transcript (chars). */
const TRANSCRIPT_TOTAL_CAP = 400_000;
/** Per-command excerpt cap (chars). */
const COMMAND_EXCERPT_CAP = 600;
/** Per-command-output excerpt cap (chars). */
const OUTPUT_EXCERPT_CAP = 1_500;

function truncateExcerpt(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export interface CodexVerifyTranscriptAccumulator {
  /** Feed one turn-session event; an event it doesn't recognize is a no-op. */
  onEvent(event: TurnSessionEvent): void;
  /** The accumulated markdown transcript, or null when nothing was accumulated. */
  text(): string | null;
}

/**
 * Build a fresh markdown-transcript accumulator for one Codex verification turn.
 * Only `item.completed` events contribute: an agentMessage appends verbatim, a
 * commandExecution renders as a fenced shell block (+ a fenced output block when
 * present), and a fileChange logs one audit line per change (the verifier should
 * NOT be editing tracked sources, so a change here doubles as evidence). Every
 * other item type (reasoning, mcpToolCall, webSearch, plan, raw, userMessage) and
 * every non-`item.completed` event is a no-op. Once the running total would exceed
 * {@link TRANSCRIPT_TOTAL_CAP}, further content is dropped and a single truncation
 * marker line is appended.
 */
export function createCodexVerifyTranscriptAccumulator(): CodexVerifyTranscriptAccumulator {
  const lines: string[] = [];
  let total = 0;
  let truncated = false;

  function push(line: string): void {
    if (truncated) return;
    if (total + line.length > TRANSCRIPT_TOTAL_CAP) {
      lines.push(`\n[transcript truncated at ${TRANSCRIPT_TOTAL_CAP} chars]\n`);
      truncated = true;
      return;
    }
    lines.push(line);
    total += line.length;
  }

  return {
    onEvent(event: TurnSessionEvent): void {
      if (truncated) return;
      if (event.type !== 'item.completed') return;
      const item = event.item;
      if (item.type === 'agentMessage') {
        push(item.text);
      } else if (item.type === 'commandExecution') {
        const exit = item.exitCode === null ? '?' : String(item.exitCode);
        const command = truncateExcerpt(item.command, COMMAND_EXCERPT_CAP);
        push(`\n**Shell (exit ${exit}):**\n\`\`\`\n${command}\n\`\`\`\n`);
        if (item.aggregatedOutput !== null && item.aggregatedOutput.length > 0) {
          const output = truncateExcerpt(item.aggregatedOutput, OUTPUT_EXCERPT_CAP);
          push(`Output:\n\`\`\`\n${output}\n\`\`\`\n`);
        }
      } else if (item.type === 'fileChange') {
        for (const change of item.changes) {
          push(`\n**File change (${change.kind.type}):** ${change.path}\n`);
        }
      }
    },
    text(): string | null {
      return lines.length > 0 ? lines.join('') : null;
    },
  };
}

// ---------------------------------------------------------------------------
// One-shot app-server plumbing (copies of the codexEvalJudgeQuery helpers — the
// two boundaries share the same app-server shape but different error/return types).
// ---------------------------------------------------------------------------

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
      name: 'cyboflow-verify',
      title: 'Cyboflow Verify',
      version: CODEX_EXECUTABLE_VERSION,
    },
    capabilities: {
      experimentalApi: true,
      requestAttestation: false,
    },
  };
}

function defaultClientFactory(options: CodexAppServerClientOptions): CodexVerifyAppServerClient {
  return new CodexAppServerClient(options);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep-copy an arbitrary value into a JSON-serializable AppServerJsonValue (private in the juror). */
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
  throw new Error('Codex verification output schema is not JSON-serializable');
}

/**
 * Undo the strict-schema nullability promotion on the parsed report
 * (adversarial-review fix): `toStrictOutputSchema` makes every OPTIONAL
 * VerificationReportV1 property required-but-nullable, so a schema-compliant
 * Codex report carries `buildLogExcerpt: null` (on any non-build outcome),
 * `attestation: null`, `issues[].fileName: null`, `app.productGlob: null`, … —
 * which `normalizeVerificationReportV1` rejects ("expected string"/"expected an
 * object"), turning every valid Codex report into a blocking "invalid
 * structured report". Strip exactly those nulls back to ABSENT here so the
 * shared normalizer stays strict for both runtimes.
 *
 * The stripped set is DERIVED from VERIFICATION_REPORT_JSON_SCHEMA — every
 * property a node declares but does not list in its `required`, at any depth,
 * which is exactly the set the strict transform made nullable. It used to be a
 * hand-kept list, and that list missed `attestation` the moment the echo was
 * added (runbook-optional-verification.md F6); deriving it means a new optional
 * field needs no edit here. A null on a REQUIRED property, or on a key the
 * schema does not declare, is left as-is for the normalizer to judge. Exported
 * for unit tests.
 */
export function stripStrictSchemaNulls(structured: unknown): unknown {
  return stripNullOptionals(structured, VERIFICATION_REPORT_JSON_SCHEMA);
}

/** Walk `value` alongside its JSON-schema node, dropping `null` on the node's non-required declared properties. */
function stripNullOptionals(value: unknown, schema: unknown): unknown {
  if (!isRecord(schema)) return value;
  if (Array.isArray(value)) {
    const items = schema.items;
    return isRecord(items) ? value.map((item) => stripNullOptionals(item, items)) : value;
  }
  const properties = schema.properties;
  if (!isRecord(value) || !isRecord(properties)) return value;
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((k): k is string => typeof k === 'string') : [],
  );
  const out: Array<[string, unknown]> = [];
  for (const [key, entry] of Object.entries(value)) {
    // Own-property lookup: a model-authored key like "constructor" must not
    // resolve to Object.prototype and read as a declared optional.
    if (!Object.prototype.hasOwnProperty.call(properties, key)) {
      out.push([key, entry]);
      continue;
    }
    if (entry === null && !required.has(key)) continue;
    out.push([key, stripNullOptionals(entry, properties[key])]);
  }
  // fromEntries defines OWN keys, so a model-authored "__proto__" stays data.
  return Object.fromEntries(out);
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
    rejectDeadline(new Error(`Codex verification agent query timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    (timer as { unref: () => void }).unref();
  }
  const onAbort = (): void => {
    aborted = true;
    rejectDeadline(new Error('Codex verification agent query aborted'));
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

/**
 * Build the production Codex `VerificationAgentQueryFn`. Deploys ONE structured
 * app-server turn under the danger-full-access sandbox (no MCP), feeds every
 * turn-session event to a fresh {@link createCodexVerifyTranscriptAccumulator}, and
 * returns the parsed terminal agent message as `structured` PLUS the accumulated
 * transcript. On timeout/error/logged-out/malformed-JSON it throws a
 * {@link VerificationAgentQueryError} carrying the partial transcript.
 */
export function makeCodexVerificationAgentQuery(
  logger?: LoggerLike,
  timeoutMs: number = VERIFICATION_AGENT_TIMEOUT_MS,
  opts: CodexVerificationAgentQueryOptions = {},
): VerificationAgentQueryFn {
  const createClient = opts.clientFactory ?? defaultClientFactory;
  const resolveExecutable = opts.resolveExecutable ?? resolveCodexExecutablePath;

  return async (args) => {
    // args.allowedTools has NO Codex equivalent — the danger-full-access sandbox
    // plus the harness-contract system prompt (developerInstructions) are the only
    // enforcement on this runtime, so the Claude tool-ceiling is intentionally
    // ignored here.
    void args.allowedTools;

    let executable: ResolvedCodexExecutable;
    try {
      executable = resolveExecutable();
    } catch (error) {
      throw new VerificationAgentQueryError(
        `Codex runtime missing: ${error instanceof Error ? error.message : String(error)}`,
        null,
      );
    }

    // The scheduler's effective per-request deadline wins over the module default
    // (adversarial-review fix) — else a task deadline above 10 min is silently cut.
    const effectiveTimeoutMs = args.timeoutMs ?? timeoutMs;

    const acc = createCodexVerifyTranscriptAccumulator();
    const terminal = createDeferred<string>();
    void terminal.promise.catch(() => undefined);
    let terminalAgentMessage = '';
    let turnSession: CodexAppServerTurnSession | null = null;
    const client = createClient({
      command: executable.executablePath,
      ...(args.cwd ? { cwd: args.cwd } : {}),
      // The harness env from args.env MUST win over what this process inherited,
      // so the agent's shell gets VERIFY_ARTIFACTS_DIR / VERIFY_DRIVER /
      // VERIFY_DRIVER_PORT / VERIFY_PORT / VERIFY_DATA_DIR /
      // VERIFY_DRIVER_ATTACH_ONLY — hence the merge FIRST.
      //
      // THE PREPEND MUST RUN OVER THAT MERGE, NOT UNDER IT (F3 / RC4 round-2
      // review, blocker). args.env now also carries PATH — the runner exports
      // the real login-shell PATH there, which is the whole point of F3 — and
      // `prependCodexPathToEnvironment` writes the SAME key, so spreading
      // args.env last silently DROPPED `executable.pathDir` and with it the
      // bundled Codex helper binaries (ripgrep) the codex binary resolves from
      // there. Composing this way keeps both properties: the harness PATH still
      // beats the GUI PATH, and pathDir is still in front of it.
      env: prependCodexPathToEnvironment(
        { ...process.env, ...args.env },
        executable.pathDir,
      ),
      onNotification: (notification) => {
        turnSession?.handleNotification(notification);
        // Never allowed to throw: an exception escaping this handler reaches
        // CodexAppServerClient.fail(), which SIGTERMs the app-server's whole
        // process group mid-turn.
        observeCodexNotification(notification.method, notification.params);
      },
      onStderr: (chunk) => logger?.warn('[codexVerificationAgentQuery] app-server stderr', {
        stderr: chunk.trimEnd(),
      }),
      onError: (error) => terminal.reject(error),
      onExit: ({ code, signal: exitSignal }) => {
        if (!terminal.settled) {
          terminal.reject(new Error(
            `Codex app-server exited before verification turn completion (code=${String(code)}, signal=${String(exitSignal)})`,
          ));
        }
      },
    });

    const handleTurnEvent = (event: TurnSessionEvent): void => {
      acc.onEvent(event);
      if (event.type === 'item.completed' && event.item.type === 'agentMessage') {
        terminalAgentMessage = event.item.text;
      } else if (event.type === 'turn.failed') {
        terminal.reject(new Error(event.error.message));
      } else if (event.type === 'turn.error' && !event.willRetry) {
        terminal.reject(new Error(event.error.message));
      } else if (event.type === 'turn.completed') {
        if (event.status === 'interrupted') {
          terminal.reject(new Error('Codex verification agent turn was interrupted'));
        } else if (terminalAgentMessage.trim().length === 0) {
          terminal.reject(new Error('Codex verification agent returned no terminal agent message'));
        } else {
          terminal.resolve(terminalAgentMessage);
        }
      }
    };
    turnSession = new CodexAppServerTurnSession(client, { onEvent: handleTurnEvent });
    const deadline = makeDeadline(effectiveTimeoutMs, args.signal);

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
          throw new VerificationAgentQueryError('Codex ChatGPT account is logged out', acc.text());
        }
        throw error;
      }

      let resolvedModel: string;
      if (args.model) {
        resolvedModel = args.model;
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
          ...(args.cwd ? { cwd: args.cwd } : {}),
          // Parity with the Claude verifier's OS-unsandboxed posture; hermetic in
          // config terms — NO `config` attached, so no cyboflow MCP server.
          sandbox: 'danger-full-access',
          approvalPolicy: 'never',
          // The workflow persona + immutable harness contract ride here.
          developerInstructions: args.systemPrompt,
          ephemeral: true,
        }),
        deadline.promise,
      );
      await raceDeadline(
        turnSession.startTurn(args.prompt, {
          model: resolvedModel,
          // Codex → OpenAI strict structured output rejects any object whose
          // `required` omits a property (see strictOutputSchema); strict-ify the
          // lenient VerificationReportV1 schema at the Codex boundary or every turn
          // 400s. The runner still re-validates via normalizeVerificationReportV1.
          outputSchema: toJsonValue(toStrictOutputSchema(VERIFICATION_REPORT_JSON_SCHEMA)),
          sandboxPolicy: { type: 'dangerFullAccess' },
          approvalPolicy: 'never',
        }),
        deadline.promise,
      );

      const text = await raceDeadline(terminal.promise, deadline.promise);
      let structured: unknown;
      try {
        structured = JSON.parse(text) as unknown;
      } catch (error) {
        throw new VerificationAgentQueryError(
          `Codex verification agent returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
          acc.text(),
        );
      }
      return { structured: stripStrictSchemaNulls(structured), transcript: acc.text() };
    } catch (error) {
      if ((deadline.didTimeOut() || deadline.didAbort()) && turnSession.activeTurnId) {
        try {
          await withTimeout(turnSession.interruptTurn(), 2_000);
        } catch (interruptError) {
          logger?.warn('[codexVerificationAgentQuery] turn interrupt failed', {
            error: interruptError instanceof Error ? interruptError.message : String(interruptError),
          });
        }
      }
      if (error instanceof VerificationAgentQueryError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      logger?.warn('[codexVerificationAgentQuery] structured query failed', { error: message });
      // Flag a deadline expiry so the runner classifies it as `timeout`, not an
      // infra `skipped` (adversarial-review fix).
      throw new VerificationAgentQueryError(message, acc.text(), deadline.didTimeOut());
    } finally {
      deadline.cleanup();
      await client.stop();
    }
  };
}
