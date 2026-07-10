import type { AppServerNotification } from './client';
import { AppServerProtocolError } from './client';
import type {
  AppServerInitializeParams,
  AppServerInitializeResponse,
  AppServerJsonValue,
  AppServerThreadResumeParams,
  AppServerThreadStartParams,
  AppServerTurnInterruptParams,
  AppServerTurnInterruptResponse,
  AppServerTurnStartParams,
  AppServerUserInput,
  ThreadTokenUsage,
  ThreadTokenUsageUpdatedNotification,
  TokenUsageBreakdown,
} from './protocol';

export interface TurnSessionClient {
  initialize(params: AppServerInitializeParams): Promise<AppServerInitializeResponse>;
  sendRequest<TResult, TParams>(method: string, params: TParams): Promise<TResult>;
}

export type TurnSessionItem =
  | { type: 'agentMessage'; id: string; text: string }
  | { type: 'reasoning'; id: string; summary: string[]; content: string[] }
  | {
      type: 'commandExecution';
      id: string;
      command: string;
      status: 'inProgress' | 'completed' | 'failed' | 'declined';
      aggregatedOutput: string | null;
      exitCode: number | null;
    }
  | {
      type: 'fileChange';
      id: string;
      status: 'inProgress' | 'completed' | 'failed' | 'declined';
      changes: Array<{
        path: string;
        kind:
          | { type: 'add' }
          | { type: 'delete' }
          | { type: 'update'; move_path: string | null };
        diff: string;
      }>;
    }
  | {
      type: 'mcpToolCall';
      id: string;
      server: string;
      tool: string;
      status: 'inProgress' | 'completed' | 'failed';
      arguments: AppServerJsonValue;
      result: AppServerJsonValue | null;
      error: { message: string } | null;
    }
  | { type: 'webSearch'; id: string; query: string }
  | { type: 'plan'; id: string; text: string }
  | { type: 'raw'; itemType: string | null; item: AppServerJsonValue };

export interface TurnSessionError {
  message: string;
  codexErrorInfo: AppServerJsonValue | null;
  additionalDetails: string | null;
}

interface TurnSessionTurnEventBase {
  threadId: string;
  turnId: string;
}

export type TurnSessionEvent =
  | { type: 'thread.started'; threadId: string }
  | (TurnSessionTurnEventBase & { type: 'turn.started' })
  | (TurnSessionTurnEventBase & {
      type: 'thread.tokenUsage.updated';
      tokenUsage: ThreadTokenUsage;
    })
  | (TurnSessionTurnEventBase & {
      type: 'item.started';
      item: TurnSessionItem;
      startedAtMs: number;
    })
  | (TurnSessionTurnEventBase & {
      type: 'item.completed';
      item: TurnSessionItem;
      completedAtMs: number;
    })
  | (TurnSessionTurnEventBase & {
      type: 'turn.error';
      error: TurnSessionError;
      willRetry: boolean;
    })
  | (TurnSessionTurnEventBase & {
      type: 'turn.completed';
      status: 'completed' | 'interrupted';
    })
  | (TurnSessionTurnEventBase & {
      type: 'turn.failed';
      error: TurnSessionError;
    })
  | { type: 'raw'; notification: AppServerNotification };

export interface TurnSessionOptions {
  onEvent?: (event: TurnSessionEvent) => void;
}

export interface TurnSessionThread {
  threadId: string;
}

export interface TurnSessionTurn extends TurnSessionThread {
  turnId: string;
}

export type TurnSessionTurnOptions = Omit<AppServerTurnStartParams, 'threadId' | 'input'>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasString(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === 'string';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isJsonValue(value: unknown): value is AppServerJsonValue {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || isFiniteNumber(value)
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function extractResponseId(value: unknown, key: 'thread' | 'turn', method: string): string {
  if (!isRecord(value) || !isRecord(value[key]) || typeof value[key].id !== 'string') {
    throw new AppServerProtocolError(
      `Codex app-server returned a malformed ${method} result`,
    );
  }
  return value[key].id;
}

function parseTurnError(value: unknown): TurnSessionError | null {
  if (!isRecord(value) || typeof value.message !== 'string') return null;
  const codexErrorInfo = value.codexErrorInfo === undefined || value.codexErrorInfo === null
    ? null
    : isJsonValue(value.codexErrorInfo)
      ? value.codexErrorInfo
      : null;
  const additionalDetails = typeof value.additionalDetails === 'string'
    ? value.additionalDetails
    : null;
  return { message: value.message, codexErrorInfo, additionalDetails };
}

function rawItem(value: AppServerJsonValue): TurnSessionItem {
  const itemType = isRecord(value) && typeof value.type === 'string' ? value.type : null;
  return { type: 'raw', itemType, item: value };
}

function parseStringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? value
    : null;
}

function parsePatchChangeKind(
  value: unknown,
): Extract<TurnSessionItem, { type: 'fileChange' }>['changes'][number]['kind'] | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  if (value.type === 'add' || value.type === 'delete') return { type: value.type };
  if (
    value.type === 'update'
    && (typeof value.move_path === 'string' || value.move_path === null)
  ) {
    return { type: 'update', move_path: value.move_path };
  }
  return null;
}

function parseItem(value: unknown): TurnSessionItem | null {
  if (!isJsonValue(value)) return null;
  if (!isRecord(value) || typeof value.type !== 'string' || typeof value.id !== 'string') {
    return rawItem(value);
  }

  switch (value.type) {
    case 'agentMessage':
      return typeof value.text === 'string'
        ? { type: 'agentMessage', id: value.id, text: value.text }
        : rawItem(value);
    case 'reasoning': {
      const summary = parseStringArray(value.summary);
      const content = parseStringArray(value.content);
      return summary && content
        ? { type: 'reasoning', id: value.id, summary, content }
        : rawItem(value);
    }
    case 'commandExecution': {
      const status = value.status;
      if (
        typeof value.command !== 'string'
        || (status !== 'inProgress' && status !== 'completed' && status !== 'failed' && status !== 'declined')
        || (value.aggregatedOutput !== null && typeof value.aggregatedOutput !== 'string')
        || (value.exitCode !== null && !isFiniteNumber(value.exitCode))
      ) {
        return rawItem(value);
      }
      return {
        type: 'commandExecution',
        id: value.id,
        command: value.command,
        status,
        aggregatedOutput: value.aggregatedOutput,
        exitCode: value.exitCode,
      };
    }
    case 'fileChange': {
      const status = value.status;
      if (
        (status !== 'inProgress' && status !== 'completed' && status !== 'failed' && status !== 'declined')
        || !Array.isArray(value.changes)
      ) {
        return rawItem(value);
      }
      const changes: Extract<TurnSessionItem, { type: 'fileChange' }>['changes'] = [];
      for (const change of value.changes) {
        const kind = isRecord(change) ? parsePatchChangeKind(change.kind) : null;
        if (
          !isRecord(change)
          || typeof change.path !== 'string'
          || kind === null
          || typeof change.diff !== 'string'
        ) {
          return rawItem(value);
        }
        changes.push({ path: change.path, kind, diff: change.diff });
      }
      return { type: 'fileChange', id: value.id, status, changes };
    }
    case 'mcpToolCall': {
      const status = value.status;
      const error = value.error === null ? null : parseTurnError(value.error);
      if (
        typeof value.server !== 'string'
        || typeof value.tool !== 'string'
        || (status !== 'inProgress' && status !== 'completed' && status !== 'failed')
        || !isJsonValue(value.arguments)
        || !isJsonValue(value.result)
        || (value.error !== null && error === null)
      ) {
        return rawItem(value);
      }
      return {
        type: 'mcpToolCall',
        id: value.id,
        server: value.server,
        tool: value.tool,
        status,
        arguments: value.arguments,
        result: value.result,
        error: error ? { message: error.message } : null,
      };
    }
    case 'webSearch':
      return typeof value.query === 'string'
        ? { type: 'webSearch', id: value.id, query: value.query }
        : rawItem(value);
    case 'plan':
      return typeof value.text === 'string'
        ? { type: 'plan', id: value.id, text: value.text }
        : rawItem(value);
    default:
      return rawItem(value);
  }
}

function parseThreadStarted(params: unknown): string | null {
  if (!isRecord(params) || !isRecord(params.thread) || !hasString(params.thread, 'id')) {
    return null;
  }
  return params.thread.id as string;
}

function parseTurnEnvelope(params: unknown): { threadId: string; turnId: string } | null {
  if (
    !isRecord(params)
    || !hasString(params, 'threadId')
    || !isRecord(params.turn)
    || !hasString(params.turn, 'id')
  ) {
    return null;
  }
  return { threadId: params.threadId as string, turnId: params.turn.id as string };
}

function parseTokenUsageBreakdown(value: unknown): TokenUsageBreakdown | null {
  if (
    !isRecord(value)
    || !isFiniteNumber(value.totalTokens)
    || !isFiniteNumber(value.inputTokens)
    || !isFiniteNumber(value.cachedInputTokens)
    || !isFiniteNumber(value.outputTokens)
    || !isFiniteNumber(value.reasoningOutputTokens)
  ) {
    return null;
  }
  return {
    totalTokens: value.totalTokens,
    inputTokens: value.inputTokens,
    cachedInputTokens: value.cachedInputTokens,
    outputTokens: value.outputTokens,
    reasoningOutputTokens: value.reasoningOutputTokens,
  };
}

function parseThreadTokenUsageUpdated(
  params: unknown,
): ThreadTokenUsageUpdatedNotification | null {
  if (
    !isRecord(params)
    || !hasString(params, 'threadId')
    || !hasString(params, 'turnId')
    || !isRecord(params.tokenUsage)
    || (
      params.tokenUsage.modelContextWindow !== null
      && !isFiniteNumber(params.tokenUsage.modelContextWindow)
    )
  ) {
    return null;
  }
  const total = parseTokenUsageBreakdown(params.tokenUsage.total);
  const last = parseTokenUsageBreakdown(params.tokenUsage.last);
  if (!total || !last) return null;
  return {
    threadId: params.threadId as string,
    turnId: params.turnId as string,
    tokenUsage: {
      total,
      last,
      modelContextWindow: params.tokenUsage.modelContextWindow,
    },
  };
}

function parseItemEnvelope(
  params: unknown,
  timestampKey: 'startedAtMs' | 'completedAtMs',
): { threadId: string; turnId: string; item: TurnSessionItem; timestamp: number } | null {
  if (
    !isRecord(params)
    || !hasString(params, 'threadId')
    || !hasString(params, 'turnId')
    || !isFiniteNumber(params[timestampKey])
  ) {
    return null;
  }
  const item = parseItem(params.item);
  if (!item) return null;
  return {
    threadId: params.threadId as string,
    turnId: params.turnId as string,
    item,
    timestamp: params[timestampKey],
  };
}

export class CodexAppServerTurnSession {
  private initializing = false;
  private initialized = false;
  private openingThread = false;
  private startingTurn = false;
  private interruptingTurn = false;
  private currentThreadId: string | null = null;
  private currentTurnId: string | null = null;
  private lastTerminalTurnId: string | null = null;

  constructor(
    private readonly client: TurnSessionClient,
    private readonly options: TurnSessionOptions = {},
  ) {}

  get isInitialized(): boolean {
    return this.initialized;
  }

  get threadId(): string | null {
    return this.currentThreadId;
  }

  get activeTurnId(): string | null {
    return this.currentTurnId;
  }

  async initialize(params: AppServerInitializeParams): Promise<AppServerInitializeResponse> {
    if (this.initializing || this.initialized) {
      throw new AppServerProtocolError(
        'Codex app-server turn session initialize may only be sent once',
      );
    }
    this.initializing = true;
    try {
      const response = await this.client.initialize(params);
      this.initialized = true;
      return response;
    } finally {
      this.initializing = false;
    }
  }

  async startThread(params: AppServerThreadStartParams = {}): Promise<TurnSessionThread> {
    return this.openThread('thread/start', params);
  }

  async resumeThread(params: AppServerThreadResumeParams): Promise<TurnSessionThread> {
    return this.openThread('thread/resume', params);
  }

  async startTurn(
    input: string | readonly AppServerUserInput[],
    options: TurnSessionTurnOptions = {},
  ): Promise<TurnSessionTurn> {
    this.assertInitialized();
    if (!this.currentThreadId) {
      throw new AppServerProtocolError('Cannot start a turn before starting or resuming a thread');
    }
    if (this.startingTurn || this.currentTurnId) {
      throw new AppServerProtocolError('Codex app-server turn session already has an active turn');
    }

    const threadId = this.currentThreadId;
    const turnInput: AppServerUserInput[] = typeof input === 'string'
      ? [{ type: 'text', text: input, text_elements: [] }]
      : input.map((entry) => ({ ...entry }));
    const params: AppServerTurnStartParams = { ...options, threadId, input: turnInput };
    this.startingTurn = true;
    try {
      const response: unknown = await this.client.sendRequest('turn/start', params);
      const turnId = extractResponseId(response, 'turn', 'turn/start');
      this.bindResponseTurnId(turnId);
      return { threadId, turnId };
    } finally {
      this.startingTurn = false;
    }
  }

  async interruptTurn(): Promise<void> {
    this.assertInitialized();
    if (!this.currentThreadId || !this.currentTurnId) {
      throw new AppServerProtocolError('Cannot interrupt without an active Codex app-server turn');
    }
    if (this.interruptingTurn) {
      throw new AppServerProtocolError('Codex app-server turn interruption is already pending');
    }

    const params: AppServerTurnInterruptParams = {
      threadId: this.currentThreadId,
      turnId: this.currentTurnId,
    };
    this.interruptingTurn = true;
    try {
      await this.client.sendRequest<AppServerTurnInterruptResponse, AppServerTurnInterruptParams>(
        'turn/interrupt',
        params,
      );
    } finally {
      this.interruptingTurn = false;
    }
  }

  readonly handleNotification = (notification: AppServerNotification): void => {
    const event = this.mapNotification(notification);
    this.options.onEvent?.(event);
  };

  private async openThread(
    method: 'thread/start' | 'thread/resume',
    params: AppServerThreadStartParams | AppServerThreadResumeParams,
  ): Promise<TurnSessionThread> {
    this.assertInitialized();
    if (this.openingThread || this.currentThreadId) {
      throw new AppServerProtocolError('Codex app-server turn session is already bound to a thread');
    }

    this.openingThread = true;
    try {
      const response: unknown = await this.client.sendRequest(method, params);
      const threadId = extractResponseId(response, 'thread', method);
      this.bindResponseThreadId(threadId);
      return { threadId };
    } finally {
      this.openingThread = false;
    }
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new AppServerProtocolError('Codex app-server turn session must be initialized first');
    }
  }

  private bindResponseThreadId(threadId: string): void {
    if (this.currentThreadId && this.currentThreadId !== threadId) {
      throw new AppServerProtocolError(
        `Codex app-server thread response ${threadId} did not match notification ${this.currentThreadId}`,
      );
    }
    this.currentThreadId = threadId;
  }

  private bindResponseTurnId(turnId: string): void {
    if (this.currentTurnId && this.currentTurnId !== turnId) {
      throw new AppServerProtocolError(
        `Codex app-server turn response ${turnId} did not match notification ${this.currentTurnId}`,
      );
    }
    if (this.lastTerminalTurnId !== turnId) this.currentTurnId = turnId;
  }

  private acceptsThread(threadId: string): boolean {
    if (this.currentThreadId === threadId) return true;
    if (!this.currentThreadId && this.openingThread) {
      this.currentThreadId = threadId;
      return true;
    }
    return false;
  }

  private acceptsTurn(threadId: string, turnId: string): boolean {
    if (!this.acceptsThread(threadId)) return false;
    if (this.lastTerminalTurnId === turnId) return false;
    if (this.currentTurnId === turnId) return true;
    if (!this.currentTurnId && this.startingTurn) {
      this.currentTurnId = turnId;
      return true;
    }
    return false;
  }

  private mapNotification(notification: AppServerNotification): TurnSessionEvent {
    switch (notification.method) {
      case 'thread/started': {
        const threadId = parseThreadStarted(notification.params);
        if (!threadId || !this.acceptsThread(threadId)) return { type: 'raw', notification };
        return { type: 'thread.started', threadId };
      }
      case 'turn/started': {
        const envelope = parseTurnEnvelope(notification.params);
        if (!envelope || !this.acceptsTurn(envelope.threadId, envelope.turnId)) {
          return { type: 'raw', notification };
        }
        return { type: 'turn.started', ...envelope };
      }
      case 'thread/tokenUsage/updated': {
        const params = parseThreadTokenUsageUpdated(notification.params);
        if (!params || !this.acceptsTurn(params.threadId, params.turnId)) {
          return { type: 'raw', notification };
        }
        return {
          type: 'thread.tokenUsage.updated',
          threadId: params.threadId,
          turnId: params.turnId,
          tokenUsage: params.tokenUsage,
        };
      }
      case 'item/started': {
        const envelope = parseItemEnvelope(notification.params, 'startedAtMs');
        if (!envelope || !this.acceptsTurn(envelope.threadId, envelope.turnId)) {
          return { type: 'raw', notification };
        }
        return {
          type: 'item.started',
          threadId: envelope.threadId,
          turnId: envelope.turnId,
          item: envelope.item,
          startedAtMs: envelope.timestamp,
        };
      }
      case 'item/completed': {
        const envelope = parseItemEnvelope(notification.params, 'completedAtMs');
        if (!envelope || !this.acceptsTurn(envelope.threadId, envelope.turnId)) {
          return { type: 'raw', notification };
        }
        return {
          type: 'item.completed',
          threadId: envelope.threadId,
          turnId: envelope.turnId,
          item: envelope.item,
          completedAtMs: envelope.timestamp,
        };
      }
      case 'error':
        return this.mapTurnError(notification);
      case 'turn/completed':
        return this.mapTurnCompleted(notification);
      default:
        return { type: 'raw', notification };
    }
  }

  private mapTurnError(notification: AppServerNotification): TurnSessionEvent {
    const params = notification.params;
    if (
      !isRecord(params)
      || !hasString(params, 'threadId')
      || !hasString(params, 'turnId')
      || typeof params.willRetry !== 'boolean'
    ) {
      return { type: 'raw', notification };
    }
    const error = parseTurnError(params.error);
    const threadId = params.threadId as string;
    const turnId = params.turnId as string;
    if (!error || !this.acceptsTurn(threadId, turnId)) return { type: 'raw', notification };
    return { type: 'turn.error', threadId, turnId, error, willRetry: params.willRetry };
  }

  private mapTurnCompleted(notification: AppServerNotification): TurnSessionEvent {
    const envelope = parseTurnEnvelope(notification.params);
    const params = notification.params;
    if (!envelope || !isRecord(params) || !isRecord(params.turn)) {
      return { type: 'raw', notification };
    }
    if (!this.acceptsTurn(envelope.threadId, envelope.turnId)) {
      return { type: 'raw', notification };
    }

    const status = params.turn.status;
    if (status !== 'completed' && status !== 'interrupted' && status !== 'failed') {
      return { type: 'raw', notification };
    }
    if (status === 'failed') {
      const error = parseTurnError(params.turn.error);
      if (!error) return { type: 'raw', notification };
      this.finishTurn(envelope.turnId);
      return { type: 'turn.failed', ...envelope, error };
    }

    this.finishTurn(envelope.turnId);
    return { type: 'turn.completed', ...envelope, status };
  }

  private finishTurn(turnId: string): void {
    this.lastTerminalTurnId = turnId;
    if (this.currentTurnId === turnId) this.currentTurnId = null;
  }
}
