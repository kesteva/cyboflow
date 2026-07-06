/**
 * fakeSdk — the ONE shared, typed fake for `@anthropic-ai/claude-agent-sdk`'s
 * `query()` used across the main-process test suite. It replaces three divergent,
 * hand-rolled `vi.mock('@anthropic-ai/claude-agent-sdk')` helpers (the
 * claudeCodeManager wiring test + the monitorQuery / evalJudgeQuery boundary tests)
 * with a single contract:
 *
 *   1. Typed event builders — every builder returns a value checked with
 *      `satisfies` against the REAL exported sub-union of `SDKMessage`, so an
 *      `@anthropic-ai/claude-agent-sdk` bump that changes a message shape fails
 *      `pnpm typecheck` for free (the cheapest possible drift signal).
 *   2. A fluent `scenario()` DSL that compiles to a `FakeQueryFn`
 *      (`(params) => AsyncGenerator<SDKMessage>`). Its `.requestPermission()` step
 *      invokes the REAL `options.canUseTool` the code-under-test passed and awaits
 *      it — reproducing the SDK's pause/resume so the real ApprovalRouter path runs.
 *      Each permission step exposes a `Deferred` a test resolves out-of-band, so the
 *      interleave is purely event/promise-driven — NO sleeps or timers anywhere.
 *   3. `makeFakeQuery` / `makeRejectingQuery` / `makeThenRejectQuery` /
 *      `makeBlockUntilAbortQuery` for the error / hang paths, plus a runId-keyed
 *      scenario registry so a single module-level mock can serve concurrent runs.
 *   4. `createModuleFakeSdk()` — an options-capture handle a `vi.mock` factory can
 *      delegate to, so a test can assert on the `buildSdkOptions` output the manager
 *      passed to `query()`.
 *
 * Only async iteration of the returned generator is exercised by production
 * (`claudeCodeManager.ts` `for await (const event of q)`) and by the two DI-clean
 * query wrappers — the SDK `Query` object's control methods (`interrupt`,
 * `setPermissionMode`, …) are never touched, so the fake returns a plain
 * `AsyncGenerator<SDKMessage, void>`, which is exactly the type `Query` extends.
 */
import { randomUUID } from 'node:crypto';
import type {
  SDKMessage,
  SDKSystemMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKResultSuccess,
  SDKResultError,
  SDKPermissionDeniedMessage,
  PermissionResult,
  Options,
  McpServerConfig,
} from '@anthropic-ai/claude-agent-sdk';

// ---------------------------------------------------------------------------
// Deferred — a promise a test resolves out-of-band (no sleeps).
// ---------------------------------------------------------------------------

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------
// Small nested-shape helpers (kept private; only builders reference them).
// ---------------------------------------------------------------------------

/** A non-null NonNullableUsage (result events) — every nested object is present. */
function nonNullableUsage(input = 0, output = 0): SDKResultSuccess['usage'] {
  return {
    cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    inference_geo: '',
    input_tokens: input,
    iterations: [],
    output_tokens: output,
    output_tokens_details: { thinking_tokens: 0 },
    server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
    service_tier: 'standard',
    speed: 'standard',
  };
}

/** A nullable BetaUsage (assistant `message.usage`). */
function betaUsage(input = 0, output = 0): SDKAssistantMessage['message']['usage'] {
  return {
    cache_creation: null,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    inference_geo: null,
    input_tokens: input,
    iterations: null,
    output_tokens: output,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: null,
    speed: null,
  };
}

/** Fresh UUID typed as the SDK's `UUID` (crypto template-literal type). */
function uuid(): SDKSystemMessage['uuid'] {
  return randomUUID();
}

const DEFAULT_MODEL = 'claude-opus-4-8';
const DEFAULT_SESSION_ID = 'fake-session';

// ---------------------------------------------------------------------------
// Typed event builders — the full catalog, each `satisfies` its sub-union.
// ---------------------------------------------------------------------------

/** `system`/`init` — the run's opening handshake. */
export function sdkSystemInit(
  opts: {
    sessionId?: string;
    model?: string;
    cwd?: string;
    tools?: string[];
    permissionMode?: SDKSystemMessage['permissionMode'];
  } = {},
): SDKSystemMessage {
  return {
    type: 'system',
    subtype: 'init',
    apiKeySource: 'user',
    claude_code_version: '0.3.201',
    cwd: opts.cwd ?? '/tmp/fake-worktree',
    tools: opts.tools ?? ['Read', 'Grep', 'Glob'],
    mcp_servers: [],
    model: opts.model ?? DEFAULT_MODEL,
    permissionMode: opts.permissionMode ?? 'default',
    slash_commands: [],
    output_style: 'default',
    skills: [],
    plugins: [],
    uuid: uuid(),
    session_id: opts.sessionId ?? DEFAULT_SESSION_ID,
  } satisfies SDKSystemMessage;
}

/**
 * `assistant` text turn. Pass a single string for one text block, or an array of
 * strings for several concatenated text blocks (mirrors a real multi-block turn).
 */
export function sdkAssistantText(
  text: string | readonly string[],
  opts: { sessionId?: string; model?: string; parentToolUseId?: string | null } = {},
): SDKAssistantMessage {
  const texts = typeof text === 'string' ? [text] : text;
  return {
    type: 'assistant',
    message: {
      id: `msg_${randomUUID()}`,
      container: null,
      content: texts.map((t) => ({ type: 'text', text: t, citations: null })),
      context_management: null,
      diagnostics: null,
      model: opts.model ?? DEFAULT_MODEL,
      role: 'assistant',
      stop_details: null,
      stop_reason: 'end_turn',
      stop_sequence: null,
      type: 'message',
      usage: betaUsage(),
    },
    parent_tool_use_id: opts.parentToolUseId ?? null,
    uuid: uuid(),
    session_id: opts.sessionId ?? DEFAULT_SESSION_ID,
  } satisfies SDKAssistantMessage;
}

/** `assistant` turn whose content is a single `tool_use` block. */
export function sdkAssistantToolUse(
  name: string,
  input: Record<string, unknown>,
  opts: { toolUseId?: string; sessionId?: string; model?: string; parentToolUseId?: string | null } = {},
): SDKAssistantMessage {
  return {
    type: 'assistant',
    message: {
      id: `msg_${randomUUID()}`,
      container: null,
      content: [
        {
          type: 'tool_use',
          id: opts.toolUseId ?? `toolu_${randomUUID()}`,
          name,
          input,
        },
      ],
      context_management: null,
      diagnostics: null,
      model: opts.model ?? DEFAULT_MODEL,
      role: 'assistant',
      stop_details: null,
      stop_reason: 'tool_use',
      stop_sequence: null,
      type: 'message',
      usage: betaUsage(),
    },
    parent_tool_use_id: opts.parentToolUseId ?? null,
    uuid: uuid(),
    session_id: opts.sessionId ?? DEFAULT_SESSION_ID,
  } satisfies SDKAssistantMessage;
}

/** `user` turn carrying a single `tool_result` block (the tool's output). */
export function sdkUserToolResult(
  toolUseId: string,
  content: string,
  opts: { isError?: boolean; sessionId?: string; parentToolUseId?: string | null } = {},
): SDKUserMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content,
          is_error: opts.isError ?? false,
        },
      ],
    },
    parent_tool_use_id: opts.parentToolUseId ?? null,
    session_id: opts.sessionId ?? DEFAULT_SESSION_ID,
    uuid: uuid(),
  } satisfies SDKUserMessage;
}

/**
 * `system`/`permission_denied` — the auto-classifier / dontAsk / deny-rule
 * short-circuit the manager folds into the review inbox as a non-blocking row.
 */
export function sdkPermissionDenied(
  opts: {
    toolName: string;
    toolUseId?: string;
    message?: string;
    decisionReasonType?: string;
    decisionReason?: string;
    sessionId?: string;
  },
): SDKPermissionDeniedMessage {
  return {
    type: 'system',
    subtype: 'permission_denied',
    tool_name: opts.toolName,
    tool_use_id: opts.toolUseId ?? `toolu_${randomUUID()}`,
    decision_reason_type: opts.decisionReasonType,
    decision_reason: opts.decisionReason,
    message: opts.message ?? `Auto-denied ${opts.toolName}`,
    uuid: uuid(),
    session_id: opts.sessionId ?? DEFAULT_SESSION_ID,
  } satisfies SDKPermissionDeniedMessage;
}

/** `result`/`success` — the terminal happy-path event carrying usage + cost. */
export function sdkResultSuccess(
  opts: {
    result?: string;
    structuredOutput?: unknown;
    usage?: SDKResultSuccess['usage'];
    totalCostUsd?: number;
    numTurns?: number;
    durationMs?: number;
    sessionId?: string;
  } = {},
): SDKResultSuccess {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: opts.durationMs ?? 100,
    duration_api_ms: opts.durationMs ?? 90,
    is_error: false,
    num_turns: opts.numTurns ?? 1,
    result: opts.result ?? 'ok',
    stop_reason: 'end_turn',
    total_cost_usd: opts.totalCostUsd ?? 0,
    usage: opts.usage ?? nonNullableUsage(),
    modelUsage: {},
    permission_denials: [],
    structured_output: opts.structuredOutput,
    uuid: uuid(),
    session_id: opts.sessionId ?? DEFAULT_SESSION_ID,
  } satisfies SDKResultSuccess;
}

/** `result`/`error_*` — a terminal error result (the CLI surfaces these, not throws). */
export function sdkResultError(
  opts: {
    subtype?: SDKResultError['subtype'];
    errors?: string[];
    numTurns?: number;
    totalCostUsd?: number;
    sessionId?: string;
  } = {},
): SDKResultError {
  return {
    type: 'result',
    subtype: opts.subtype ?? 'error_during_execution',
    duration_ms: 100,
    duration_api_ms: 90,
    is_error: true,
    num_turns: opts.numTurns ?? 1,
    stop_reason: null,
    total_cost_usd: opts.totalCostUsd ?? 0,
    usage: nonNullableUsage(),
    modelUsage: {},
    permission_denials: [],
    errors: opts.errors ?? ['error during execution'],
    uuid: uuid(),
    session_id: opts.sessionId ?? DEFAULT_SESSION_ID,
  } satisfies SDKResultError;
}

// ---------------------------------------------------------------------------
// Query fn shape + runId resolution.
// ---------------------------------------------------------------------------

/** The `options` object the code-under-test passes to `query()`. */
export type FakeQueryOptions = Options;

/** The `{ prompt, options }` params `query()` is called with. */
export interface FakeQueryParams {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options: FakeQueryOptions;
}

/**
 * The fake `query()`: a plain async generator of `SDKMessage`. This is exactly the
 * type the SDK `Query` interface extends; production only async-iterates it.
 */
export type FakeQueryFn = (params: FakeQueryParams) => AsyncGenerator<SDKMessage, void>;

/**
 * Read the initial prompt text `query()` was driven with, tolerating BOTH shapes:
 * a bare string (the legacy single-shot path — monitor/eval queries) or the
 * streaming-input `AsyncIterable<SDKUserMessage>` production now uses for flow
 * turns (`createStreamingPromptInput`), whose FIRST yielded message carries the
 * prompt. Pulls exactly one message and returns — it does NOT drain the iterable,
 * so the generator's post-yield gate stays parked (production closes it at turn
 * end). Throws if the stream is empty or the first message is not a plain-text
 * user message. Test-only helper for asserting the prompt reached `query()`.
 */
export async function readInitialPromptText(
  prompt: string | AsyncIterable<SDKUserMessage>,
): Promise<string> {
  if (typeof prompt === 'string') return prompt;
  const iterator = prompt[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) throw new Error('fakeSdk.readInitialPromptText: streamed prompt yielded no message');
  const content = first.value.message.content;
  if (typeof content !== 'string') {
    throw new Error('fakeSdk.readInitialPromptText: first streamed message content is not plain text');
  }
  return content;
}

/**
 * Resolve the run id `ClaudeCodeManager` stamped into the SDK options. NOTE
 * (deviation from the plan): the manager does NOT put `CYBOFLOW_RUN_ID` on the
 * top-level `options.env` — it stamps it into the `cyboflow` MCP-server entry's
 * `env` (`claudeCodeManager.ts:1389-1395`). We check both so the registry keys
 * off whichever is present.
 */
export function resolveRunIdFromOptions(options: FakeQueryOptions): string | undefined {
  const topLevel = options.env?.['CYBOFLOW_RUN_ID'];
  if (typeof topLevel === 'string' && topLevel.length > 0) return topLevel;
  const cyboflow: McpServerConfig | undefined = options.mcpServers?.['cyboflow'];
  if (cyboflow && typeof cyboflow === 'object' && 'env' in cyboflow) {
    const fromMcp = cyboflow.env?.['CYBOFLOW_RUN_ID'];
    if (typeof fromMcp === 'string' && fromMcp.length > 0) return fromMcp;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// scenario() DSL — a fluent script compiling to a FakeQueryFn.
// ---------------------------------------------------------------------------

type ScenarioStep =
  | { readonly kind: 'emit'; readonly message: SDKMessage }
  | {
      readonly kind: 'permission';
      readonly toolName: string;
      readonly input: Record<string, unknown>;
      readonly requested: Deferred<void>;
      readonly onResult?: (result: PermissionResult) => readonly SDKMessage[];
    };

export class ScenarioBuilder {
  private readonly steps: ScenarioStep[] = [];
  private readonly permissionDeferreds: Deferred<void>[] = [];

  /** Emit any pre-built `SDKMessage`. */
  emit(message: SDKMessage): this {
    this.steps.push({ kind: 'emit', message });
    return this;
  }

  systemInit(opts?: Parameters<typeof sdkSystemInit>[0]): this {
    return this.emit(sdkSystemInit(opts));
  }

  assistantText(text: string | readonly string[], opts?: Parameters<typeof sdkAssistantText>[1]): this {
    return this.emit(sdkAssistantText(text, opts));
  }

  toolUse(name: string, input: Record<string, unknown>, opts?: Parameters<typeof sdkAssistantToolUse>[2]): this {
    return this.emit(sdkAssistantToolUse(name, input, opts));
  }

  userToolResult(toolUseId: string, content: string, opts?: Parameters<typeof sdkUserToolResult>[2]): this {
    return this.emit(sdkUserToolResult(toolUseId, content, opts));
  }

  permissionDenied(opts: Parameters<typeof sdkPermissionDenied>[0]): this {
    return this.emit(sdkPermissionDenied(opts));
  }

  resultSuccess(opts?: Parameters<typeof sdkResultSuccess>[0]): this {
    return this.emit(sdkResultSuccess(opts));
  }

  resultError(opts?: Parameters<typeof sdkResultError>[0]): this {
    return this.emit(sdkResultError(opts));
  }

  /**
   * A permission step: when the generator reaches it, it invokes the REAL
   * `options.canUseTool` the code-under-test passed and awaits the verdict. The
   * returned `Deferred` resolves the moment `canUseTool` has been invoked, giving a
   * test a deterministic point to drive the approval out-of-band (e.g. via
   * `ApprovalRouter.respond`) before the awaited verdict settles. An optional
   * `onResult` maps the verdict to follow-up messages the generator then yields.
   */
  requestPermission(
    toolName: string,
    input: Record<string, unknown>,
    opts?: { onResult?: (result: PermissionResult) => readonly SDKMessage[] },
  ): this {
    const requested = createDeferred<void>();
    this.permissionDeferreds.push(requested);
    this.steps.push({ kind: 'permission', toolName, input, requested, onResult: opts?.onResult });
    return this;
  }

  /**
   * The `Deferred`s (one per `requestPermission`, in call order) that resolve as
   * each permission step invokes `canUseTool`.
   */
  get permissions(): readonly Deferred<void>[] {
    return this.permissionDeferreds;
  }

  /** Compile this scenario to a `FakeQueryFn`. */
  toQueryFn(): FakeQueryFn {
    const steps = this.steps;
    return function fakeQuery(params: FakeQueryParams): AsyncGenerator<SDKMessage, void> {
      return (async function* run() {
        const { options } = params;
        for (const step of steps) {
          if (step.kind === 'emit') {
            yield step.message;
            continue;
          }
          const canUseTool = options.canUseTool;
          if (!canUseTool) {
            throw new Error(
              'fakeSdk scenario.requestPermission requires the code-under-test to pass options.canUseTool',
            );
          }
          const controller = options.abortController ?? new AbortController();
          const pending = canUseTool(step.toolName, step.input, {
            signal: controller.signal,
            toolUseID: `toolu_${randomUUID()}`,
            requestId: `req_${randomUUID()}`,
          });
          // Signal "canUseTool has been invoked" so a test can respond out-of-band.
          step.requested.resolve();
          const result = await pending;
          // SDK 0.3.201 widened canUseTool to `PermissionResult | null` (null =
          // suppress the control response); cyboflow's permission chain always
          // decides, so a null here means the code-under-test regressed.
          if (result === null) {
            throw new Error('fakeSdk: canUseTool returned null (the permission chain must always decide)');
          }
          for (const message of step.onResult?.(result) ?? []) {
            yield message;
          }
        }
      })();
    };
  }
}

/** Start a new fluent scenario. */
export function scenario(): ScenarioBuilder {
  return new ScenarioBuilder();
}

// ---------------------------------------------------------------------------
// Query-fn factories (single source + error / hang paths + registry).
// ---------------------------------------------------------------------------

/** A single scenario source: a builder, a ready `FakeQueryFn`, or a message list. */
export type ScenarioSource = ScenarioBuilder | FakeQueryFn | readonly SDKMessage[];

/** Turn a plain message list into a `FakeQueryFn`. */
function messagesToQueryFn(messages: readonly SDKMessage[]): FakeQueryFn {
  return function fakeQuery(): AsyncGenerator<SDKMessage, void> {
    return (async function* run() {
      for (const message of messages) yield message;
    })();
  };
}

function toFakeQueryFn(source: ScenarioSource): FakeQueryFn {
  if (source instanceof ScenarioBuilder) return source.toQueryFn();
  if (typeof source === 'function') return source;
  return messagesToQueryFn(source);
}

/** A `FakeQueryFn` from a single scenario / message list / query fn. */
export function makeFakeQuery(source: ScenarioSource): FakeQueryFn {
  return toFakeQueryFn(source);
}

/** A `FakeQueryFn` whose iterator rejects on its FIRST `next()` (SDK threw). */
export function makeRejectingQuery(error: Error): FakeQueryFn {
  return function rejectingQuery(): AsyncGenerator<SDKMessage, void> {
    // A hand-built iterator (not a generator) so there is no empty-generator
    // `require-yield` lint error and the first pull rejects.
    const iterator: AsyncGenerator<SDKMessage, void> = {
      next: () => Promise.reject(error),
      return: () => Promise.resolve({ value: undefined, done: true }),
      throw: (e?: unknown) => Promise.reject(e),
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    return iterator;
  };
}

/**
 * A `FakeQueryFn` that yields `messages`, then rejects mid-stream once they are
 * drained (models the SDK producing output and THEN throwing, e.g.
 * `error_max_turns` after the agent has already spoken). `afterN` (default: all
 * messages) rejects earlier — after the first `afterN` messages.
 */
export function makeThenRejectQuery(
  messages: readonly SDKMessage[],
  error: Error,
  afterN: number = messages.length,
): FakeQueryFn {
  return function thenRejectQuery(): AsyncGenerator<SDKMessage, void> {
    let i = 0;
    const limit = Math.min(afterN, messages.length);
    const iterator: AsyncGenerator<SDKMessage, void> = {
      next: () =>
        i < limit
          ? Promise.resolve({ value: messages[i++], done: false })
          : Promise.reject(error),
      return: () => Promise.resolve({ value: undefined, done: true }),
      throw: (e?: unknown) => Promise.reject(e),
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    return iterator;
  };
}

/**
 * A `FakeQueryFn` that BLOCKS (yielding nothing) until its run's
 * `options.abortController` fires, then completes cleanly — models a hung binary
 * unblocked only by the caller's deadline timer or abort signal. `onAbort` observes
 * the abort firing. Purely event-driven: NO timers.
 */
export function makeBlockUntilAbortQuery(onAbort?: () => void): FakeQueryFn {
  return function blockUntilAbortQuery(params: FakeQueryParams): AsyncGenerator<SDKMessage, void> {
    return (async function* run() {
      const controller = params.options.abortController;
      const signal = controller?.signal;
      if (signal?.aborted) {
        onAbort?.();
        return;
      }
      if (signal) {
        await new Promise<void>((resolve) =>
          signal.addEventListener(
            'abort',
            () => {
              onAbort?.();
              resolve();
            },
            { once: true },
          ),
        );
      }
      // Unreachable — satisfies the async-generator `require-yield` lint rule.
      if (false as boolean) yield undefined as never;
    })();
  };
}

/** A runId → scenario map so one module mock serves concurrent runs. */
export type ScenarioRegistry = ReadonlyMap<string, ScenarioSource> | Readonly<Record<string, ScenarioSource>>;

function registryLookup(registry: ScenarioRegistry, runId: string): ScenarioSource | undefined {
  if (registry instanceof Map) return registry.get(runId);
  return (registry as Record<string, ScenarioSource>)[runId];
}

/**
 * A `FakeQueryFn` backed by a runId-keyed registry: it resolves the run id from the
 * options `ClaudeCodeManager` stamped and dispatches to that run's scenario. An
 * unknown run id throws LOUDLY (never a silent empty stream) so a mis-keyed test
 * fails fast.
 */
export function makeFakeQueryFromRegistry(registry: ScenarioRegistry): FakeQueryFn {
  return function registryQuery(params: FakeQueryParams): AsyncGenerator<SDKMessage, void> {
    const runId = resolveRunIdFromOptions(params.options);
    if (runId === undefined) {
      throw new Error(
        'fakeSdk registry: no CYBOFLOW_RUN_ID found on query options (checked options.env and the cyboflow MCP entry)',
      );
    }
    const source = registryLookup(registry, runId);
    if (source === undefined) {
      throw new Error(`fakeSdk registry: no scenario registered for run id "${runId}"`);
    }
    return toFakeQueryFn(source)(params);
  };
}

// ---------------------------------------------------------------------------
// Module-mock handle — options capture + swappable implementation.
// ---------------------------------------------------------------------------

/**
 * A handle a `vi.mock('@anthropic-ai/claude-agent-sdk')` factory can delegate to:
 * `handle.query` is the mocked `query()` (it records each call's options), while
 * `setImplementation` / `setMessages` / `setScenario` swap the yielded behavior per
 * test and `lastOptions` / `calls` expose the captured `buildSdkOptions` output.
 */
export interface ModuleFakeSdk {
  readonly query: FakeQueryFn;
  readonly lastOptions: FakeQueryOptions | undefined;
  readonly calls: readonly FakeQueryOptions[];
  /**
   * The `prompt` argument of the latest `query()` call — a bare string (legacy
   * single-shot path) or the streaming-input `AsyncIterable<SDKUserMessage>`
   * production now passes for flow turns. Captured passively (the iterable is NOT
   * drained), so a test can assert the prompt reached `query()` via
   * {@link readInitialPromptText}.
   */
  readonly lastPrompt: string | AsyncIterable<SDKUserMessage> | undefined;
  readonly prompts: readonly (string | AsyncIterable<SDKUserMessage>)[];
  setImplementation(fn: FakeQueryFn): void;
  setScenario(source: ScenarioSource): void;
  setMessages(messages: readonly SDKMessage[]): void;
  reset(): void;
}

export function createModuleFakeSdk(defaultSource?: ScenarioSource): ModuleFakeSdk {
  const emptyImpl: FakeQueryFn = messagesToQueryFn([]);
  const initialImpl = defaultSource ? toFakeQueryFn(defaultSource) : emptyImpl;
  let impl = initialImpl;
  let last: FakeQueryOptions | undefined;
  let lastPromptValue: string | AsyncIterable<SDKUserMessage> | undefined;
  const calls: FakeQueryOptions[] = [];
  const prompts: (string | AsyncIterable<SDKUserMessage>)[] = [];

  const query: FakeQueryFn = (params) => {
    last = params.options;
    lastPromptValue = params.prompt;
    calls.push(params.options);
    prompts.push(params.prompt);
    return impl(params);
  };

  return {
    query,
    get lastOptions() {
      return last;
    },
    get calls() {
      return calls;
    },
    get lastPrompt() {
      return lastPromptValue;
    },
    get prompts() {
      return prompts;
    },
    setImplementation(fn: FakeQueryFn) {
      impl = fn;
    },
    setScenario(source: ScenarioSource) {
      impl = toFakeQueryFn(source);
    },
    setMessages(messages: readonly SDKMessage[]) {
      impl = messagesToQueryFn(messages);
    },
    reset() {
      impl = initialImpl;
      last = undefined;
      lastPromptValue = undefined;
      calls.length = 0;
      prompts.length = 0;
    },
  };
}
