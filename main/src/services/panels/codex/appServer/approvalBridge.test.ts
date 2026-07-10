import { describe, expect, it, vi } from 'vitest';
import type { AppServerServerRequestDispatch } from './client';
import {
  CODEX_APP_SERVER_APPROVAL_SOURCE,
  CodexAppServerApprovalBridge,
  type ApprovalBridgeDecision,
  type ApprovalRouterPort,
} from './approvalBridge';

type CommandDispatch = Extract<
  AppServerServerRequestDispatch,
  { method: 'item/commandExecution/requestApproval' }
>;
type FileDispatch = Extract<
  AppServerServerRequestDispatch,
  { method: 'item/fileChange/requestApproval' }
>;
type McpDispatch = Extract<
  AppServerServerRequestDispatch,
  { method: 'mcpServer/elicitation/request' }
>;

interface DeferredDecision {
  promise: Promise<ApprovalBridgeDecision>;
  resolve(decision: ApprovalBridgeDecision): void;
  reject(error: Error): void;
}

interface ApprovalCall {
  runId: string;
  toolName: string;
  input: Record<string, unknown>;
  socketReply: (decision: ApprovalBridgeDecision) => void;
  source?: string;
  deferred: DeferredDecision;
}

function deferredDecision(): DeferredDecision {
  let resolve!: (decision: ApprovalBridgeDecision) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<ApprovalBridgeDecision>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeApprovalRouter implements ApprovalRouterPort {
  readonly calls: ApprovalCall[] = [];
  readonly clearCalls: string[] = [];

  requestApproval(
    runId: string,
    toolName: string,
    input: Record<string, unknown>,
    socketReply: (decision: ApprovalBridgeDecision) => void,
    source?: string,
  ): Promise<ApprovalBridgeDecision> {
    const deferred = deferredDecision();
    this.calls.push({ runId, toolName, input, socketReply, source, deferred });
    return deferred.promise;
  }

  clearPendingForRun(runId: string): void {
    this.clearCalls.push(runId);
  }
}

function commandDispatch(id: string | number = 'command-1'): {
  request: CommandDispatch;
  respond: ReturnType<typeof vi.fn>;
} {
  const respond = vi.fn();
  return {
    respond,
    request: {
      id,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-command',
        startedAtMs: 100,
        approvalId: 'approval-command',
        environmentId: null,
        command: 'pnpm test',
        cwd: '/tmp/worktree',
      },
      respond,
      reject: vi.fn(),
    },
  };
}

function fileDispatch(id: string | number = 'file-1'): {
  request: FileDispatch;
  respond: ReturnType<typeof vi.fn>;
} {
  const respond = vi.fn();
  return {
    respond,
    request: {
      id,
      method: 'item/fileChange/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-file',
        startedAtMs: 101,
        reason: 'write generated file',
        grantRoot: '/tmp/worktree',
      },
      respond,
      reject: vi.fn(),
    },
  };
}

function mcpDispatch(options: {
  id?: string | number;
  mode?: 'form' | 'url';
  approval?: boolean;
} = {}): {
  request: McpDispatch;
  respond: ReturnType<typeof vi.fn>;
} {
  const respond = vi.fn();
  const base = {
    id: options.id ?? 'mcp-1',
    method: 'mcpServer/elicitation/request' as const,
    respond,
    reject: vi.fn(),
  };
  const metadata = options.approval
    ? { codex_approval_kind: 'mcp_tool_call', tool_name: 'cyboflow_create_task' }
    : null;

  if (options.mode === 'url') {
    return {
      respond,
      request: {
        ...base,
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          serverName: 'cyboflow',
          mode: 'url',
          _meta: metadata,
          message: 'Open authorization URL',
          url: 'https://example.test/authorize',
          elicitationId: 'elicitation-1',
        },
      },
    };
  }

  return {
    respond,
    request: {
      ...base,
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        serverName: 'cyboflow',
        mode: 'form',
        _meta: metadata,
        message: 'Allow MCP tool call?',
        requestedSchema: { type: 'object', properties: {} },
      },
    },
  };
}

function makeBridge(router = new FakeApprovalRouter(), onError?: (error: Error) => void): {
  bridge: CodexAppServerApprovalBridge;
  router: FakeApprovalRouter;
} {
  return {
    bridge: new CodexAppServerApprovalBridge({
      runId: 'run-1',
      approvalRouter: router,
      onError,
    }),
    router,
  };
}

describe('CodexAppServerApprovalBridge', () => {
  it('routes command approval with full correlation and maps allow to accept once', async () => {
    const { bridge, router } = makeBridge();
    const { request, respond } = commandDispatch();

    const handling = bridge.handleServerRequest(request);
    expect(router.calls).toHaveLength(1);
    expect(router.calls[0]).toMatchObject({
      runId: 'run-1',
      toolName: 'Bash',
      source: CODEX_APP_SERVER_APPROVAL_SOURCE,
      input: {
        runId: 'run-1',
        requestId: 'command-1',
        appServerMethod: 'item/commandExecution/requestApproval',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-command',
        command: 'pnpm test',
        approvalId: 'approval-command',
        correlation: {
          provider: 'codex-app-server',
          runId: 'run-1',
          requestId: 'command-1',
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-command',
        },
      },
    });

    router.calls[0].socketReply({ behavior: 'allow' });
    expect(respond).not.toHaveBeenCalled();
    router.calls[0].deferred.resolve({ behavior: 'allow' });
    await handling;

    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith({ decision: 'accept' });
    expect(bridge.pendingCount).toBe(0);
  });

  it('maps a denied file approval to decline', async () => {
    const { bridge, router } = makeBridge();
    const { request, respond } = fileDispatch();

    const handling = bridge.handleServerRequest(request);
    expect(router.calls[0]).toMatchObject({
      toolName: 'Edit',
      input: {
        requestId: 'file-1',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-file',
        grantRoot: '/tmp/worktree',
      },
    });
    router.calls[0].deferred.resolve({ behavior: 'deny', message: 'Not this file' });
    await handling;

    expect(respond).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith({ decision: 'decline' });
  });

  it('routes marked MCP tool approvals and maps allow to accept', async () => {
    const { bridge, router } = makeBridge();
    const { request, respond } = mcpDispatch({ approval: true });

    const handling = bridge.handleServerRequest(request);
    expect(router.calls[0]).toMatchObject({
      toolName: 'cyboflow_create_task',
      input: {
        requestId: 'mcp-1',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: null,
        serverName: 'cyboflow',
        _meta: { codex_approval_kind: 'mcp_tool_call' },
      },
    });
    router.calls[0].deferred.resolve({ behavior: 'allow' });
    await handling;

    expect(respond).toHaveBeenCalledWith({ action: 'accept', content: null, _meta: null });
  });

  it('cancels generic MCP form and URL elicitations without opening review items', async () => {
    const { bridge, router } = makeBridge();
    const form = mcpDispatch({ id: 'form-1' });
    const url = mcpDispatch({ id: 'url-1', mode: 'url' });

    await bridge.handleServerRequest(form.request);
    await bridge.handleServerRequest(url.request);

    expect(router.calls).toEqual([]);
    expect(form.respond).toHaveBeenCalledOnce();
    expect(form.respond).toHaveBeenCalledWith({ action: 'cancel', content: null, _meta: null });
    expect(url.respond).toHaveBeenCalledOnce();
    expect(url.respond).toHaveBeenCalledWith({ action: 'cancel', content: null, _meta: null });
  });

  it('does not respond twice when the same dispatch is handled more than once', async () => {
    const { bridge, router } = makeBridge();
    const { request, respond } = commandDispatch();

    const first = bridge.handleServerRequest(request);
    await bridge.handleServerRequest(request);
    expect(router.calls).toHaveLength(1);

    router.calls[0].deferred.resolve({ behavior: 'deny' });
    await first;
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it('cancels every pending request before clearing the router on teardown', async () => {
    const { bridge, router } = makeBridge();
    const command = commandDispatch('command-teardown');
    const file = fileDispatch('file-teardown');
    const commandHandling = bridge.handleServerRequest(command.request);
    const fileHandling = bridge.handleServerRequest(file.request);

    expect(bridge.pendingCount).toBe(2);
    bridge.teardown();
    bridge.teardown();

    expect(command.respond).toHaveBeenCalledWith({ decision: 'cancel' });
    expect(file.respond).toHaveBeenCalledWith({ decision: 'cancel' });
    expect(command.respond).toHaveBeenCalledTimes(1);
    expect(file.respond).toHaveBeenCalledTimes(1);
    expect(router.clearCalls).toEqual(['run-1']);
    expect(bridge.pendingCount).toBe(0);

    router.calls[0].deferred.resolve({ behavior: 'allow' });
    router.calls[1].deferred.resolve({ behavior: 'deny' });
    await Promise.all([commandHandling, fileHandling]);
    expect(command.respond).toHaveBeenCalledTimes(1);
    expect(file.respond).toHaveBeenCalledTimes(1);
  });

  it('cancels requests received after teardown without consulting the router', async () => {
    const { bridge, router } = makeBridge();
    bridge.teardown();
    const { request, respond } = commandDispatch('late-command');

    await bridge.handleServerRequest(request);

    expect(router.calls).toEqual([]);
    expect(respond).toHaveBeenCalledWith({ decision: 'cancel' });
  });

  it('cancels and reports routing failures', async () => {
    const errors: Error[] = [];
    const { bridge, router } = makeBridge(undefined, (error) => errors.push(error));
    const { request, respond } = commandDispatch('command-error');

    const handling = bridge.handleServerRequest(request);
    router.calls[0].deferred.reject(new Error('router unavailable'));
    await handling;

    expect(respond).toHaveBeenCalledWith({ decision: 'cancel' });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      name: 'CodexAppServerApprovalBridgeError',
      message: 'Codex approval routing failed for request command-error',
    });
  });
});

