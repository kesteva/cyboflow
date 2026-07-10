import { spawn as nodeSpawn } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type {
  AppServerInitializeParams,
  AppServerInitializeResponse,
  AppServerJsonValue,
  AppServerRequestId,
  AppServerRpcErrorObject,
  AppServerServerRequest,
  CommandExecutionRequestApprovalParams,
  CommandExecutionRequestApprovalResponse,
  FileChangeRequestApprovalParams,
  FileChangeRequestApprovalResponse,
  McpServerElicitationRequestParams,
  McpServerElicitationRequestResponse,
  PermissionsRequestApprovalParams,
  PermissionsRequestApprovalResponse,
  ToolRequestUserInputParams,
  ToolRequestUserInputResponse,
} from './protocol';

export const CODEX_APP_SERVER_ARGS = ['app-server', '--listen', 'stdio://'] as const;

const DEFAULT_MAX_FRAME_BYTES = 4 * 1024 * 1024;
const METHOD_NOT_FOUND = -32601;
const DEFAULT_STOP_TIMEOUT_MS = 2_000;
const DEFAULT_FORCE_KILL_TIMEOUT_MS = 1_000;

export interface AppServerProcess extends EventEmitter {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface AppServerSpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export type SpawnAppServerProcess = (
  command: string,
  args: readonly string[],
  options: AppServerSpawnOptions,
) => AppServerProcess;

export interface AppServerNotification {
  method: string;
  params?: AppServerJsonValue;
}

interface ServerRequestDispatchBase {
  id: AppServerRequestId;
  reject(error: AppServerRpcErrorObject): void;
}

export type AppServerServerRequestDispatch =
  | (ServerRequestDispatchBase & {
      method: 'item/commandExecution/requestApproval';
      params: CommandExecutionRequestApprovalParams;
      respond(response: CommandExecutionRequestApprovalResponse): void;
    })
  | (ServerRequestDispatchBase & {
      method: 'item/fileChange/requestApproval';
      params: FileChangeRequestApprovalParams;
      respond(response: FileChangeRequestApprovalResponse): void;
    })
  | (ServerRequestDispatchBase & {
      method: 'item/tool/requestUserInput';
      params: ToolRequestUserInputParams;
      respond(response: ToolRequestUserInputResponse): void;
    })
  | (ServerRequestDispatchBase & {
      method: 'item/permissions/requestApproval';
      params: PermissionsRequestApprovalParams;
      respond(response: PermissionsRequestApprovalResponse): void;
    })
  | (ServerRequestDispatchBase & {
      method: 'mcpServer/elicitation/request';
      params: McpServerElicitationRequestParams;
      respond(response: McpServerElicitationRequestResponse): void;
    });

export interface AppServerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface CodexAppServerClientOptions extends AppServerSpawnOptions {
  command?: string;
  spawn?: SpawnAppServerProcess;
  maxFrameBytes?: number;
  stopTimeoutMs?: number;
  forceKillTimeoutMs?: number;
  onServerRequest?: (
    request: AppServerServerRequestDispatch,
  ) => void | Promise<void>;
  onNotification?: (notification: AppServerNotification) => void;
  onUnhandledServerRequest?: (request: {
    id: AppServerRequestId;
    method: string;
    params?: AppServerJsonValue;
  }) => void;
  onStderr?: (chunk: string) => void;
  onExit?: (exit: AppServerExit) => void;
  onError?: (error: Error) => void;
}

export type AppServerClientState = 'idle' | 'running' | 'stopping' | 'failed' | 'exited';

interface PendingClientRequest {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface PendingServerRequest {
  method: AppServerServerRequest['method'];
}

export class AppServerTransportError extends Error {
  override readonly name: string = 'AppServerTransportError';
}

export class AppServerProtocolError extends AppServerTransportError {
  override readonly name: string = 'AppServerProtocolError';
}

export class AppServerRpcError extends AppServerTransportError {
  override readonly name: string = 'AppServerRpcError';

  constructor(
    readonly code: number,
    message: string,
    readonly data?: AppServerJsonValue,
  ) {
    super(message);
  }
}

export class AppServerExitedError extends AppServerTransportError {
  override readonly name: string = 'AppServerExitedError';

  constructor(
    readonly code: number | null,
    readonly signal: NodeJS.Signals | null,
  ) {
    super(`Codex app-server exited (code=${String(code)}, signal=${String(signal)})`);
  }
}

const defaultSpawn: SpawnAppServerProcess = (command, args, options) => {
  return nodeSpawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRequestId(value: unknown): value is AppServerRequestId {
  return typeof value === 'string'
    || (typeof value === 'number' && Number.isFinite(value));
}

function isStringOrNull(value: unknown): value is string | null {
  return typeof value === 'string' || value === null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function hasOptionalString(value: Record<string, unknown>, key: string): boolean {
  return !hasOwn(value, key) || typeof value[key] === 'string';
}

function hasOptionalStringOrNull(value: Record<string, unknown>, key: string): boolean {
  return !hasOwn(value, key) || isStringOrNull(value[key]);
}

function hasOptionalFiniteNumber(value: Record<string, unknown>, key: string): boolean {
  return !hasOwn(value, key) || isFiniteNumber(value[key]);
}

function hasOptionalNullable(
  value: Record<string, unknown>,
  key: string,
  predicate: (candidate: unknown) => boolean,
): boolean {
  return !hasOwn(value, key) || value[key] === null || predicate(value[key]);
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

function isCommandAction(value: unknown): boolean {
  if (!isRecord(value) || typeof value.command !== 'string') return false;
  switch (value.type) {
    case 'read':
      return typeof value.name === 'string' && typeof value.path === 'string';
    case 'listFiles':
      return isStringOrNull(value.path);
    case 'search':
      return isStringOrNull(value.query) && isStringOrNull(value.path);
    case 'unknown':
      return true;
    default:
      return false;
  }
}

function isFileSystemSpecialPath(value: unknown): boolean {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case 'root':
    case 'minimal':
    case 'tmpdir':
    case 'slash_tmp':
      return true;
    case 'project_roots':
      return isStringOrNull(value.subpath);
    case 'unknown':
      return typeof value.path === 'string' && isStringOrNull(value.subpath);
    default:
      return false;
  }
}

function isFileSystemPath(value: unknown): boolean {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case 'path':
      return typeof value.path === 'string';
    case 'glob_pattern':
      return typeof value.pattern === 'string';
    case 'special':
      return isFileSystemSpecialPath(value.value);
    default:
      return false;
  }
}

function isFileSystemSandboxEntry(value: unknown): boolean {
  return isRecord(value)
    && isFileSystemPath(value.path)
    && (value.access === 'read' || value.access === 'write' || value.access === 'deny');
}

function isAdditionalFileSystemPermissions(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (value.read === null || isStringArray(value.read))
    && (value.write === null || isStringArray(value.write))
    && hasOptionalFiniteNumber(value, 'globScanMaxDepth')
    && (!hasOwn(value, 'entries')
      || (Array.isArray(value.entries) && value.entries.every(isFileSystemSandboxEntry)));
}

function isAdditionalPermissionProfile(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const networkIsValid = value.network === null
    || (isRecord(value.network)
      && (typeof value.network.enabled === 'boolean' || value.network.enabled === null));
  return networkIsValid
    && (value.fileSystem === null || isAdditionalFileSystemPermissions(value.fileSystem));
}

function isNetworkApprovalContext(value: unknown): boolean {
  if (!isRecord(value) || typeof value.host !== 'string') return false;
  return value.protocol === 'http'
    || value.protocol === 'https'
    || value.protocol === 'socks5Tcp'
    || value.protocol === 'socks5Udp';
}

function isNetworkPolicyAmendment(value: unknown): boolean {
  return isRecord(value)
    && typeof value.host === 'string'
    && (value.action === 'allow' || value.action === 'deny');
}

function isCommandApprovalDecision(value: unknown): boolean {
  if (
    value === 'accept'
    || value === 'acceptForSession'
    || value === 'decline'
    || value === 'cancel'
  ) {
    return true;
  }
  if (!isRecord(value)) return false;
  if (isRecord(value.acceptWithExecpolicyAmendment)) {
    return isStringArray(value.acceptWithExecpolicyAmendment.execpolicy_amendment);
  }
  if (isRecord(value.applyNetworkPolicyAmendment)) {
    return isNetworkPolicyAmendment(
      value.applyNetworkPolicyAmendment.network_policy_amendment,
    );
  }
  return false;
}

function isCommandApprovalParams(value: unknown): value is CommandExecutionRequestApprovalParams {
  if (!isRecord(value)) return false;
  return typeof value.threadId === 'string'
    && typeof value.turnId === 'string'
    && typeof value.itemId === 'string'
    && isFiniteNumber(value.startedAtMs)
    && hasOwn(value, 'environmentId')
    && isStringOrNull(value.environmentId)
    && hasOptionalStringOrNull(value, 'approvalId')
    && hasOptionalStringOrNull(value, 'reason')
    && hasOptionalStringOrNull(value, 'command')
    && hasOptionalStringOrNull(value, 'cwd')
    && hasOptionalNullable(value, 'networkApprovalContext', isNetworkApprovalContext)
    && hasOptionalNullable(value, 'additionalPermissions', isAdditionalPermissionProfile)
    && hasOptionalNullable(value, 'proposedExecpolicyAmendment', isStringArray)
    && hasOptionalNullable(
      value,
      'proposedNetworkPolicyAmendments',
      (candidate) => Array.isArray(candidate) && candidate.every(isNetworkPolicyAmendment),
    )
    && hasOptionalNullable(
      value,
      'commandActions',
      (candidate) => Array.isArray(candidate) && candidate.every(isCommandAction),
    )
    && hasOptionalNullable(
      value,
      'availableDecisions',
      (candidate) => Array.isArray(candidate) && candidate.every(isCommandApprovalDecision),
    );
}

function isFileChangeApprovalParams(value: unknown): value is FileChangeRequestApprovalParams {
  if (!isRecord(value)) return false;
  return typeof value.threadId === 'string'
    && typeof value.turnId === 'string'
    && typeof value.itemId === 'string'
    && isFiniteNumber(value.startedAtMs)
    && hasOptionalStringOrNull(value, 'reason')
    && hasOptionalStringOrNull(value, 'grantRoot');
}

function isToolRequestUserInputParams(value: unknown): value is ToolRequestUserInputParams {
  if (!isRecord(value) || !Array.isArray(value.questions)) return false;
  return typeof value.threadId === 'string'
    && typeof value.turnId === 'string'
    && typeof value.itemId === 'string'
    && (value.autoResolutionMs === null || isFiniteNumber(value.autoResolutionMs))
    && value.questions.every((question) => {
      if (!isRecord(question)) return false;
      return typeof question.id === 'string'
        && typeof question.header === 'string'
        && typeof question.question === 'string'
        && typeof question.isOther === 'boolean'
        && typeof question.isSecret === 'boolean'
        && (question.options === null || (
          Array.isArray(question.options)
          && question.options.every((option) => isRecord(option)
            && typeof option.label === 'string'
            && typeof option.description === 'string')
        ));
    });
}

function isPermissionsRequestApprovalParams(
  value: unknown,
): value is PermissionsRequestApprovalParams {
  if (!isRecord(value)) return false;
  return typeof value.threadId === 'string'
    && typeof value.turnId === 'string'
    && typeof value.itemId === 'string'
    && isStringOrNull(value.environmentId)
    && isFiniteNumber(value.startedAtMs)
    && typeof value.cwd === 'string'
    && isStringOrNull(value.reason)
    && isAdditionalPermissionProfile(value.permissions);
}

function isMcpElicitationParams(value: unknown): value is McpServerElicitationRequestParams {
  if (!isRecord(value)) return false;
  if (
    typeof value.threadId !== 'string'
    || !isStringOrNull(value.turnId)
    || typeof value.serverName !== 'string'
    || !hasOwn(value, '_meta')
    || !isJsonValue(value._meta)
    || typeof value.message !== 'string'
  ) {
    return false;
  }

  if (value.mode === 'form') {
    return isMcpElicitationSchema(value.requestedSchema);
  }
  if (value.mode === 'openai/form') {
    return hasOwn(value, 'requestedSchema') && isJsonValue(value.requestedSchema);
  }
  if (value.mode === 'url') {
    return typeof value.url === 'string' && typeof value.elicitationId === 'string';
  }
  return false;
}

function isMcpElicitationSchema(value: unknown): boolean {
  if (!isRecord(value) || value.type !== 'object' || !isRecord(value.properties)) {
    return false;
  }
  return hasOptionalString(value, '$schema')
    && Object.values(value.properties).every(isMcpElicitationPrimitiveSchema)
    && (!hasOwn(value, 'required') || isStringArray(value.required));
}

function hasValidSchemaDescription(value: Record<string, unknown>): boolean {
  return hasOptionalString(value, 'title') && hasOptionalString(value, 'description');
}

function isMcpElicitationPrimitiveSchema(value: unknown): boolean {
  if (!isRecord(value) || !hasValidSchemaDescription(value)) return false;
  if (value.type === 'boolean') {
    return !hasOwn(value, 'default') || typeof value.default === 'boolean';
  }
  if (value.type === 'number' || value.type === 'integer') {
    return hasOptionalFiniteNumber(value, 'minimum')
      && hasOptionalFiniteNumber(value, 'maximum')
      && hasOptionalFiniteNumber(value, 'default');
  }
  if (value.type === 'array') {
    if (
      !hasOptionalFiniteNumber(value, 'minItems')
      || !hasOptionalFiniteNumber(value, 'maxItems')
      || (hasOwn(value, 'default') && !isStringArray(value.default))
      || !isRecord(value.items)
    ) {
      return false;
    }
    if (value.items.type === 'string') return isStringArray(value.items.enum);
    return Array.isArray(value.items.anyOf)
      && value.items.anyOf.every((option) => {
        return isRecord(option)
          && typeof option.const === 'string'
          && typeof option.title === 'string';
      });
  }
  if (value.type !== 'string') return false;
  if (hasOwn(value, 'enum')) {
    return isStringArray(value.enum)
      && (!hasOwn(value, 'enumNames') || isStringArray(value.enumNames))
      && hasOptionalString(value, 'default');
  }
  if (hasOwn(value, 'oneOf')) {
    return Array.isArray(value.oneOf)
      && value.oneOf.every((option) => {
        return isRecord(option)
          && typeof option.const === 'string'
          && typeof option.title === 'string';
      })
      && hasOptionalString(value, 'default');
  }
  const formatIsValid = !hasOwn(value, 'format')
    || value.format === 'email'
    || value.format === 'uri'
    || value.format === 'date'
    || value.format === 'date-time';
  return hasOptionalFiniteNumber(value, 'minLength')
    && hasOptionalFiniteNumber(value, 'maxLength')
    && formatIsValid
    && hasOptionalString(value, 'default');
}

function isInitializeResponse(value: unknown): value is AppServerInitializeResponse {
  if (!isRecord(value)) return false;
  return typeof value.userAgent === 'string'
    && typeof value.codexHome === 'string'
    && typeof value.platformFamily === 'string'
    && typeof value.platformOs === 'string';
}

function isRpcErrorObject(value: unknown): value is AppServerRpcErrorObject {
  if (!isRecord(value)) return false;
  return isFiniteNumber(value.code)
    && typeof value.message === 'string'
    && (!hasOwn(value, 'data') || isJsonValue(value.data));
}

function requestIdKey(id: AppServerRequestId): string {
  return `${typeof id}:${String(id)}`;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export class CodexAppServerClient {
  private readonly command: string;
  private readonly spawnProcess: SpawnAppServerProcess;
  private readonly maxFrameBytes: number;
  private readonly stopTimeoutMs: number;
  private readonly forceKillTimeoutMs: number;
  private readonly stdoutDecoder = new StringDecoder('utf8');
  private readonly stderrDecoder = new StringDecoder('utf8');
  private readonly pendingClientRequests = new Map<string, PendingClientRequest>();
  private readonly pendingServerRequests = new Map<string, PendingServerRequest>();

  private child: AppServerProcess | null = null;
  private stdoutBuffer = '';
  private nextRequestId = 1;
  private currentState: AppServerClientState = 'idle';
  private initializing = false;
  private initialized = false;
  private readonly exitWaiters = new Set<() => void>();
  private stopPromise: Promise<void> | null = null;

  constructor(private readonly options: CodexAppServerClientOptions = {}) {
    this.command = options.command ?? 'codex';
    this.spawnProcess = options.spawn ?? defaultSpawn;
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    this.forceKillTimeoutMs = options.forceKillTimeoutMs ?? DEFAULT_FORCE_KILL_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.maxFrameBytes) || this.maxFrameBytes <= 0) {
      throw new AppServerTransportError('maxFrameBytes must be a positive safe integer');
    }
    if (!Number.isSafeInteger(this.stopTimeoutMs) || this.stopTimeoutMs < 0) {
      throw new AppServerTransportError('stopTimeoutMs must be a non-negative safe integer');
    }
    if (!Number.isSafeInteger(this.forceKillTimeoutMs) || this.forceKillTimeoutMs < 0) {
      throw new AppServerTransportError('forceKillTimeoutMs must be a non-negative safe integer');
    }
  }

  get state(): AppServerClientState {
    return this.currentState;
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  start(): void {
    if (this.currentState !== 'idle') {
      throw new AppServerTransportError(`Cannot start app-server from ${this.currentState} state`);
    }

    try {
      this.child = this.spawnProcess(this.command, CODEX_APP_SERVER_ARGS, {
        cwd: this.options.cwd,
        env: this.options.env,
      });
      this.currentState = 'running';
      this.bindProcess(this.child);
    } catch (error) {
      const transportError = new AppServerTransportError(
        `Failed to spawn Codex app-server: ${toError(error).message}`,
        { cause: error },
      );
      this.fail(transportError);
      throw transportError;
    }
  }

  async initialize(params: AppServerInitializeParams): Promise<AppServerInitializeResponse> {
    if (this.initializing || this.initialized) {
      throw new AppServerProtocolError('Codex app-server initialize may only be sent once');
    }
    this.initializing = true;

    try {
      const response = await this.sendRequest<unknown, AppServerInitializeParams>('initialize', params);
      if (!isInitializeResponse(response)) {
        const error = new AppServerProtocolError('Codex app-server returned a malformed initialize result');
        this.fail(error);
        throw error;
      }
      this.sendNotification('initialized');
      this.initialized = true;
      return response;
    } finally {
      this.initializing = false;
    }
  }

  sendRequest<TResult, TParams>(method: string, params: TParams): Promise<TResult> {
    this.assertRunning();
    if (!method) {
      return Promise.reject(new AppServerProtocolError('RPC request method must not be empty'));
    }

    const id = this.nextRequestId++;
    const key = requestIdKey(id);

    return new Promise<TResult>((resolve, reject) => {
      this.pendingClientRequests.set(key, {
        method,
        resolve: (value) => resolve(value as TResult),
        reject,
      });

      try {
        this.writeFrame({ id, method, params });
      } catch (error) {
        if (this.pendingClientRequests.delete(key)) {
          reject(toError(error));
        }
      }
    });
  }

  sendNotification<TParams>(method: string, params?: TParams): void {
    this.assertRunning();
    if (!method) {
      throw new AppServerProtocolError('RPC notification method must not be empty');
    }
    const frame = params === undefined ? { method } : { method, params };
    this.writeFrame(frame);
  }

  stop(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopProcess(signal);
    return this.stopPromise;
  }

  private async stopProcess(signal: NodeJS.Signals): Promise<void> {
    if (this.currentState === 'idle') {
      this.currentState = 'exited';
      return;
    }
    if (this.currentState === 'exited') return;
    if (this.currentState === 'stopping') {
      await this.waitForExit(this.stopTimeoutMs);
      return;
    }
    if (this.currentState === 'failed') {
      try {
        this.child?.kill('SIGKILL');
      } catch (cause) {
        this.reportError(new AppServerTransportError(
          `Failed to force-kill failed Codex app-server: ${toError(cause).message}`,
          { cause },
        ));
        return;
      }
      await this.waitForExit(this.forceKillTimeoutMs);
      return;
    }

    this.currentState = 'stopping';
    const error = new AppServerTransportError('Codex app-server transport stopped');
    this.rejectPendingClientRequests(error);
    this.pendingServerRequests.clear();

    try {
      this.child?.kill(signal);
    } catch (cause) {
      this.currentState = 'failed';
      this.reportError(new AppServerTransportError(
        `Failed to stop Codex app-server: ${toError(cause).message}`,
        { cause },
      ));
      return;
    }

    if (await this.waitForExit(this.stopTimeoutMs)) return;
    try {
      this.child?.kill('SIGKILL');
    } catch (cause) {
      this.currentState = 'failed';
      this.reportError(new AppServerTransportError(
        `Failed to force-kill Codex app-server: ${toError(cause).message}`,
        { cause },
      ));
      return;
    }
    await this.waitForExit(this.forceKillTimeoutMs);
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.currentState === 'exited') return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let timeout: NodeJS.Timeout | undefined;
      const onExit = (): void => {
        if (timeout) clearTimeout(timeout);
        this.exitWaiters.delete(onExit);
        resolve(true);
      };
      this.exitWaiters.add(onExit);
      timeout = setTimeout(() => {
        this.exitWaiters.delete(onExit);
        resolve(false);
      }, timeoutMs);
    });
  }

  private bindProcess(child: AppServerProcess): void {
    child.stdout.on('data', (chunk: Buffer | string) => this.handleStdoutData(chunk));
    child.stdout.on('end', () => this.handleStdoutEnd());
    child.stdout.on('error', (error: Error) => {
      this.fail(new AppServerTransportError(`Codex app-server stdout failed: ${error.message}`, { cause: error }));
    });
    child.stdin.on('error', (error: Error) => {
      this.fail(new AppServerTransportError(`Codex app-server stdin failed: ${error.message}`, { cause: error }));
    });
    child.stderr.on('data', (chunk: Buffer | string) => this.handleStderrData(chunk));
    child.stderr.on('end', () => this.handleStderrEnd());
    child.stderr.on('error', (error: Error) => {
      this.fail(new AppServerTransportError(`Codex app-server stderr failed: ${error.message}`, { cause: error }));
    });
    child.on('error', (error: Error) => {
      this.fail(new AppServerTransportError(`Codex app-server process failed: ${error.message}`, { cause: error }));
    });
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      this.handleExit(code, signal);
    });
  }

  private handleStdoutData(chunk: Buffer | string): void {
    if (this.currentState !== 'running') return;
    this.stdoutBuffer += this.stdoutDecoder.write(
      typeof chunk === 'string' ? Buffer.from(chunk) : chunk,
    );

    let newlineIndex = this.stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0 && this.currentState === 'running') {
      let line = this.stdoutBuffer.slice(0, newlineIndex);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);

      if (Buffer.byteLength(line, 'utf8') > this.maxFrameBytes) {
        this.fail(new AppServerProtocolError('Codex app-server frame exceeded maxFrameBytes'));
        return;
      }
      try {
        this.handleLine(line);
      } catch (error) {
        this.fail(new AppServerTransportError(
          `Codex app-server frame handling failed: ${toError(error).message}`,
          { cause: error },
        ));
        return;
      }
      newlineIndex = this.stdoutBuffer.indexOf('\n');
    }

    if (
      this.currentState === 'running'
      && Buffer.byteLength(this.stdoutBuffer, 'utf8') > this.maxFrameBytes
    ) {
      this.fail(new AppServerProtocolError('Codex app-server frame exceeded maxFrameBytes'));
    }
  }

  private handleStdoutEnd(): void {
    if (this.currentState !== 'running') return;
    this.stdoutBuffer += this.stdoutDecoder.end();
    if (this.stdoutBuffer.length > 0) {
      this.fail(new AppServerProtocolError('Codex app-server stdout ended with an incomplete frame'));
      return;
    }
    this.fail(new AppServerTransportError('Codex app-server stdout ended before the process exited'));
  }

  private handleStderrData(chunk: Buffer | string): void {
    const decoded = this.stderrDecoder.write(
      typeof chunk === 'string' ? Buffer.from(chunk) : chunk,
    );
    if (decoded.length > 0) this.reportStderr(decoded);
  }

  private handleStderrEnd(): void {
    const decoded = this.stderrDecoder.end();
    if (decoded.length > 0) this.reportStderr(decoded);
  }

  private handleLine(line: string): void {
    if (line.length === 0) {
      this.fail(new AppServerProtocolError('Codex app-server emitted an empty protocol frame'));
      return;
    }

    let frame: unknown;
    try {
      frame = JSON.parse(line) as unknown;
    } catch (error) {
      this.fail(new AppServerProtocolError('Codex app-server emitted invalid JSON', { cause: error }));
      return;
    }

    if (!isRecord(frame)) {
      this.fail(new AppServerProtocolError('Codex app-server frame must be an object'));
      return;
    }

    const hasMethod = hasOwn(frame, 'method');
    const hasId = hasOwn(frame, 'id');
    if (hasMethod) {
      if (typeof frame.method !== 'string' || frame.method.length === 0) {
        this.fail(new AppServerProtocolError('Codex app-server frame has an invalid method'));
        return;
      }
      if (hasId) {
        if (!isRequestId(frame.id)) {
          this.fail(new AppServerProtocolError('Codex app-server request has an invalid id'));
          return;
        }
        this.handleServerRequest(frame.method, frame.id, frame.params);
      } else {
        this.handleNotification(frame.method, frame.params);
      }
      return;
    }

    if (hasId) {
      if (!isRequestId(frame.id)) {
        this.fail(new AppServerProtocolError('Codex app-server response has an invalid id'));
        return;
      }
      this.handleResponse(frame.id, frame);
      return;
    }

    this.fail(new AppServerProtocolError('Codex app-server frame is not a request, response, or notification'));
  }

  private handleResponse(id: AppServerRequestId, frame: Record<string, unknown>): void {
    const hasResult = hasOwn(frame, 'result');
    const hasError = hasOwn(frame, 'error');
    if (hasResult === hasError) {
      this.fail(new AppServerProtocolError('Codex app-server response must contain exactly one of result or error'));
      return;
    }

    const key = requestIdKey(id);
    const pending = this.pendingClientRequests.get(key);
    if (!pending) {
      this.fail(new AppServerProtocolError(`Codex app-server responded with unknown request id ${String(id)}`));
      return;
    }
    this.pendingClientRequests.delete(key);

    if (hasError) {
      if (!isRpcErrorObject(frame.error)) {
        const error = new AppServerProtocolError(
          `Codex app-server returned a malformed error for ${pending.method}`,
        );
        pending.reject(error);
        this.fail(error);
        return;
      }
      pending.reject(new AppServerRpcError(frame.error.code, frame.error.message, frame.error.data));
      return;
    }
    pending.resolve(frame.result);
  }

  private handleNotification(method: string, params: unknown): void {
    const notification: AppServerNotification = params === undefined
      ? { method }
      : { method, params: params as AppServerJsonValue };
    try {
      this.options.onNotification?.(notification);
    } catch (error) {
      this.fail(new AppServerTransportError(
        `Codex app-server notification handler failed: ${toError(error).message}`,
        { cause: error },
      ));
    }
  }

  private handleServerRequest(method: string, id: AppServerRequestId, params: unknown): void {
    let request: AppServerServerRequest;
    if (method === 'item/commandExecution/requestApproval') {
      if (!isCommandApprovalParams(params)) {
        this.fail(new AppServerProtocolError(`Codex app-server emitted malformed params for ${method}`));
        return;
      }
      request = { method, id, params };
    } else if (method === 'item/fileChange/requestApproval') {
      if (!isFileChangeApprovalParams(params)) {
        this.fail(new AppServerProtocolError(`Codex app-server emitted malformed params for ${method}`));
        return;
      }
      request = { method, id, params };
    } else if (method === 'item/tool/requestUserInput') {
      if (!isToolRequestUserInputParams(params)) {
        this.fail(new AppServerProtocolError(`Codex app-server emitted malformed params for ${method}`));
        return;
      }
      request = { method, id, params };
    } else if (method === 'item/permissions/requestApproval') {
      if (!isPermissionsRequestApprovalParams(params)) {
        this.fail(new AppServerProtocolError(`Codex app-server emitted malformed params for ${method}`));
        return;
      }
      request = { method, id, params };
    } else if (method === 'mcpServer/elicitation/request') {
      if (!isMcpElicitationParams(params)) {
        this.fail(new AppServerProtocolError(`Codex app-server emitted malformed params for ${method}`));
        return;
      }
      request = { method, id, params };
    } else {
      const unhandled = params === undefined
        ? { id, method }
        : { id, method, params: params as AppServerJsonValue };
      this.writeFrame({
        id,
        error: {
          code: METHOD_NOT_FOUND,
          message: `Unsupported Codex app-server request: ${method}`,
        },
      });
      try {
        this.options.onUnhandledServerRequest?.(unhandled);
      } catch (error) {
        this.reportError(toError(error));
      }
      return;
    }

    const key = requestIdKey(id);
    if (this.pendingServerRequests.has(key)) {
      this.fail(new AppServerProtocolError(`Codex app-server reused pending request id ${String(id)}`));
      return;
    }
    this.pendingServerRequests.set(key, { method: request.method });

    const dispatch = this.createDispatch(request);
    if (!this.options.onServerRequest) {
      this.cancelServerRequest(dispatch);
      return;
    }

    try {
      const handlerResult = this.options.onServerRequest(dispatch);
      void Promise.resolve(handlerResult).catch((error: unknown) => {
        this.handleServerRequestHandlerError(id, error);
      });
    } catch (error) {
      this.handleServerRequestHandlerError(id, error);
    }
  }

  private createDispatch(request: AppServerServerRequest): AppServerServerRequestDispatch {
    const reject = (error: AppServerRpcErrorObject): void => {
      this.finishServerRequest(request.id, { id: request.id, error });
    };

    switch (request.method) {
      case 'item/commandExecution/requestApproval':
        return {
          ...request,
          respond: (response: CommandExecutionRequestApprovalResponse) => {
            this.finishServerRequest(request.id, { id: request.id, result: response });
          },
          reject,
        };
      case 'item/fileChange/requestApproval':
        return {
          ...request,
          respond: (response: FileChangeRequestApprovalResponse) => {
            this.finishServerRequest(request.id, { id: request.id, result: response });
          },
          reject,
        };
      case 'item/tool/requestUserInput':
        return {
          ...request,
          respond: (response: ToolRequestUserInputResponse) => {
            this.finishServerRequest(request.id, { id: request.id, result: response });
          },
          reject,
        };
      case 'item/permissions/requestApproval':
        return {
          ...request,
          respond: (response: PermissionsRequestApprovalResponse) => {
            this.finishServerRequest(request.id, { id: request.id, result: response });
          },
          reject,
        };
      case 'mcpServer/elicitation/request':
        return {
          ...request,
          respond: (response: McpServerElicitationRequestResponse) => {
            this.finishServerRequest(request.id, { id: request.id, result: response });
          },
          reject,
        };
    }
  }

  private finishServerRequest(id: AppServerRequestId, frame: object): void {
    const key = requestIdKey(id);
    if (!this.pendingServerRequests.delete(key)) {
      throw new AppServerProtocolError(`Codex app-server request ${String(id)} was already resolved`);
    }
    this.writeFrame(frame);
  }

  private cancelServerRequest(dispatch: AppServerServerRequestDispatch): void {
    switch (dispatch.method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        dispatch.respond({ decision: 'cancel' });
        break;
      case 'item/tool/requestUserInput':
        dispatch.respond({ answers: {} });
        break;
      case 'item/permissions/requestApproval':
        dispatch.respond({ permissions: {}, scope: 'turn', strictAutoReview: true });
        break;
      case 'mcpServer/elicitation/request':
        dispatch.respond({ action: 'cancel', content: null, _meta: null });
        break;
    }
  }

  private handleServerRequestHandlerError(id: AppServerRequestId, value: unknown): void {
    const pending = this.pendingServerRequests.get(requestIdKey(id));
    if (pending) {
      const result = pending.method === 'mcpServer/elicitation/request'
        ? { action: 'cancel', content: null, _meta: null }
        : pending.method === 'item/tool/requestUserInput'
          ? { answers: {} }
          : pending.method === 'item/permissions/requestApproval'
            ? { permissions: {}, scope: 'turn', strictAutoReview: true }
            : { decision: 'cancel' };
      try {
        this.finishServerRequest(id, { id, result });
      } catch (error) {
        this.fail(new AppServerTransportError(
          `Failed to cancel Codex app-server request ${String(id)}: ${toError(error).message}`,
          { cause: error },
        ));
      }
    }
    this.reportError(new AppServerTransportError(
      `Codex app-server request handler failed: ${toError(value).message}`,
      { cause: value },
    ));
  }

  private writeFrame(frame: object): void {
    this.assertRunning();
    let encoded: string;
    try {
      encoded = `${JSON.stringify(frame)}\n`;
    } catch (error) {
      const protocolError = new AppServerProtocolError('Failed to encode Codex app-server frame', { cause: error });
      this.fail(protocolError);
      throw protocolError;
    }

    try {
      this.child!.stdin.write(encoded, 'utf8', (error?: Error | null) => {
        if (error) {
          this.fail(new AppServerTransportError(
            `Failed to write to Codex app-server stdin: ${error.message}`,
            { cause: error },
          ));
        }
      });
    } catch (error) {
      const transportError = new AppServerTransportError(
        `Failed to write to Codex app-server stdin: ${toError(error).message}`,
        { cause: error },
      );
      this.fail(transportError);
      throw transportError;
    }
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.currentState === 'idle' || this.currentState === 'exited') return;
    const expectedStop = this.currentState === 'stopping';
    const error = new AppServerExitedError(code, signal);
    if (expectedStop) {
      this.currentState = 'exited';
    } else if (this.currentState !== 'failed') {
      this.currentState = 'exited';
      this.rejectPendingClientRequests(error);
      this.pendingServerRequests.clear();
      this.reportError(error);
    }
    try {
      this.options.onExit?.({ code, signal });
    } catch (callbackError) {
      this.reportError(toError(callbackError));
    }
    for (const resolve of [...this.exitWaiters]) resolve();
  }

  private fail(error: Error): void {
    if (
      this.currentState === 'stopping'
      || this.currentState === 'failed'
      || this.currentState === 'exited'
    ) return;
    this.currentState = 'failed';
    this.rejectPendingClientRequests(error);
    this.pendingServerRequests.clear();
    this.reportError(error);
    try {
      this.child?.kill('SIGTERM');
    } catch {
      // The transport is already failed; there is no recovery path for kill errors.
    }
  }

  private rejectPendingClientRequests(error: Error): void {
    const pending = [...this.pendingClientRequests.values()];
    this.pendingClientRequests.clear();
    for (const request of pending) request.reject(error);
  }

  private reportStderr(chunk: string): void {
    try {
      this.options.onStderr?.(chunk);
    } catch (error) {
      this.reportError(toError(error));
    }
  }

  private reportError(error: Error): void {
    try {
      this.options.onError?.(error);
    } catch {
      // Diagnostics must not recursively destabilize the protocol state machine.
    }
  }

  private assertRunning(): void {
    if (this.currentState !== 'running' || !this.child) {
      throw new AppServerTransportError(
        `Codex app-server transport is not running (state=${this.currentState})`,
      );
    }
  }
}
