import type { AppServerServerRequestDispatch } from './client';

export const CODEX_APP_SERVER_APPROVAL_SOURCE = 'approval:codex-app-server';

export interface ApprovalBridgeDecision {
  behavior: 'allow' | 'deny';
  updatedInput?: Record<string, unknown>;
  message?: string;
}

/** Structural subset of ApprovalRouter used by the app-server transport. */
export interface ApprovalRouterPort {
  requestApproval(
    runId: string,
    toolName: string,
    input: Record<string, unknown>,
    socketReply: (decision: ApprovalBridgeDecision) => void,
    source?: string,
  ): Promise<ApprovalBridgeDecision>;
  clearPendingForRun(runId: string): void;
}

export interface CodexAppServerApprovalBridgeOptions {
  runId: string;
  approvalRouter: ApprovalRouterPort;
  source?: string;
  onError?: (error: Error) => void;
}

interface PendingApproval {
  request: AppServerServerRequestDispatch;
}

export class CodexAppServerApprovalBridgeError extends Error {
  override readonly name: string = 'CodexAppServerApprovalBridgeError';
}

function requestKey(request: AppServerServerRequestDispatch): string {
  return `${typeof request.id}:${String(request.id)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMcpToolCallApproval(request: AppServerServerRequestDispatch): boolean {
  if (request.method !== 'mcpServer/elicitation/request') return false;
  return isRecord(request.params._meta)
    && request.params._meta.codex_approval_kind === 'mcp_tool_call';
}

function mcpToolName(request: Extract<
  AppServerServerRequestDispatch,
  { method: 'mcpServer/elicitation/request' }
>): string {
  const metadata = request.params._meta;
  if (isRecord(metadata)) {
    if (typeof metadata.tool_name === 'string' && metadata.tool_name.length > 0) {
      return metadata.tool_name;
    }
    if (typeof metadata.toolName === 'string' && metadata.toolName.length > 0) {
      return metadata.toolName;
    }
  }
  return `MCP:${request.params.serverName}`;
}

export class CodexAppServerApprovalBridge {
  private readonly runId: string;
  private readonly approvalRouter: ApprovalRouterPort;
  private readonly source: string;
  private readonly onError?: (error: Error) => void;
  private readonly pending = new Map<string, PendingApproval>();
  private readonly handledRequests = new WeakSet<object>();
  private disposed = false;

  constructor(options: CodexAppServerApprovalBridgeOptions) {
    this.runId = options.runId;
    this.approvalRouter = options.approvalRouter;
    this.source = options.source ?? CODEX_APP_SERVER_APPROVAL_SOURCE;
    this.onError = options.onError;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  async handleServerRequest(request: AppServerServerRequestDispatch): Promise<void> {
    if (this.handledRequests.has(request)) return;
    this.handledRequests.add(request);

    if (this.disposed) {
      this.cancelRequest(request);
      return;
    }

    if (
      request.method === 'mcpServer/elicitation/request'
      && !isMcpToolCallApproval(request)
    ) {
      this.cancelRequest(request);
      return;
    }

    const key = requestKey(request);
    if (this.pending.has(key)) {
      this.reportError(new CodexAppServerApprovalBridgeError(
        `Codex app-server approval request id ${String(request.id)} is already pending`,
      ));
      return;
    }

    this.pending.set(key, { request });
    try {
      const decision = await this.approvalRouter.requestApproval(
        this.runId,
        this.toolName(request),
        this.approvalInput(request),
        () => {
          // The returned promise is authoritative. ApprovalRouter resolves it
          // alongside this callback, so responding here would duplicate RPC output.
        },
        this.source,
      );
      this.finishWithDecision(key, decision);
    } catch (cause) {
      this.cancelPending(key);
      this.reportError(new CodexAppServerApprovalBridgeError(
        `Codex approval routing failed for request ${String(request.id)}`,
        { cause },
      ));
    }
  }

  teardown(): void {
    if (this.disposed) return;
    this.disposed = true;

    const pendingKeys = [...this.pending.keys()];
    for (const key of pendingKeys) this.cancelPending(key);

    try {
      this.approvalRouter.clearPendingForRun(this.runId);
    } catch (cause) {
      this.reportError(new CodexAppServerApprovalBridgeError(
        `Failed to clear pending Codex approvals for run ${this.runId}`,
        { cause },
      ));
    }
  }

  private toolName(request: AppServerServerRequestDispatch): string {
    switch (request.method) {
      case 'item/commandExecution/requestApproval':
        return 'Bash';
      case 'item/fileChange/requestApproval':
        return 'Edit';
      case 'mcpServer/elicitation/request':
        return mcpToolName(request);
    }
  }

  private approvalInput(request: AppServerServerRequestDispatch): Record<string, unknown> {
    const itemId = request.method === 'mcpServer/elicitation/request'
      ? null
      : request.params.itemId;
    const correlation = {
      provider: 'codex-app-server',
      runId: this.runId,
      requestId: request.id,
      threadId: request.params.threadId,
      turnId: request.params.turnId,
      itemId,
    };

    return {
      ...request.params,
      runId: this.runId,
      requestId: request.id,
      appServerMethod: request.method,
      threadId: request.params.threadId,
      turnId: request.params.turnId,
      itemId,
      correlation,
    };
  }

  private finishWithDecision(key: string, decision: ApprovalBridgeDecision): void {
    const pending = this.takePending(key);
    if (!pending) return;

    try {
      switch (pending.request.method) {
        case 'item/commandExecution/requestApproval':
        case 'item/fileChange/requestApproval':
          pending.request.respond({
            decision: decision.behavior === 'allow' ? 'accept' : 'decline',
          });
          break;
        case 'mcpServer/elicitation/request':
          pending.request.respond({
            action: decision.behavior === 'allow' ? 'accept' : 'decline',
            content: null,
            _meta: null,
          });
          break;
      }
    } catch (cause) {
      this.reportError(new CodexAppServerApprovalBridgeError(
        `Failed to respond to Codex approval request ${String(pending.request.id)}`,
        { cause },
      ));
    }
  }

  private cancelPending(key: string): void {
    const pending = this.takePending(key);
    if (pending) this.cancelRequest(pending.request);
  }

  private takePending(key: string): PendingApproval | undefined {
    const pending = this.pending.get(key);
    if (pending) this.pending.delete(key);
    return pending;
  }

  private cancelRequest(request: AppServerServerRequestDispatch): void {
    try {
      switch (request.method) {
        case 'item/commandExecution/requestApproval':
        case 'item/fileChange/requestApproval':
          request.respond({ decision: 'cancel' });
          break;
        case 'mcpServer/elicitation/request':
          request.respond({ action: 'cancel', content: null, _meta: null });
          break;
      }
    } catch (cause) {
      this.reportError(new CodexAppServerApprovalBridgeError(
        `Failed to cancel Codex approval request ${String(request.id)}`,
        { cause },
      ));
    }
  }

  private reportError(error: Error): void {
    try {
      this.onError?.(error);
    } catch {
      // Diagnostics must not destabilize approval delivery or teardown.
    }
  }
}

