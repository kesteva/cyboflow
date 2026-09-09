import { describe, expect, it, vi } from 'vitest';
import type { AppServerServerRequestDispatch } from '../client';
import { decideIsolationRequest, handleIsolationRequest } from '../isolationRequestPolicy';

type Dispatch<TMethod extends AppServerServerRequestDispatch['method']> = Extract<
  AppServerServerRequestDispatch,
  { method: TMethod }
>;

type Respond = ReturnType<typeof vi.fn>;

function commandDispatch(): { request: Dispatch<'item/commandExecution/requestApproval'>; respond: Respond } {
  const respond = vi.fn();
  return {
    respond,
    request: {
      id: 'command-1',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-command',
        startedAtMs: 100,
        approvalId: 'approval-command',
        environmentId: null,
        command: 'rm -rf /',
        cwd: '/Users/me',
      },
      respond,
      reject: vi.fn(),
    },
  };
}

function fileChangeDispatch(): { request: Dispatch<'item/fileChange/requestApproval'>; respond: Respond } {
  const respond = vi.fn();
  return {
    respond,
    request: {
      id: 'file-1',
      method: 'item/fileChange/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-file',
        startedAtMs: 101,
        reason: 'write generated file',
        grantRoot: '/Users/me',
      },
      respond,
      reject: vi.fn(),
    },
  };
}

function permissionsDispatch(): { request: Dispatch<'item/permissions/requestApproval'>; respond: Respond } {
  const respond = vi.fn();
  return {
    respond,
    request: {
      id: 'permissions-1',
      method: 'item/permissions/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-permissions',
        environmentId: null,
        startedAtMs: 102,
        cwd: '/Users/me',
        reason: 'network access',
        permissions: {
          network: { enabled: true },
          fileSystem: { read: null, write: ['/Users/me'] },
        },
      },
      respond,
      reject: vi.fn(),
    },
  };
}

function questionDispatch(): { request: Dispatch<'item/tool/requestUserInput'>; respond: Respond } {
  const respond = vi.fn();
  return {
    respond,
    request: {
      id: 'question-1',
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-question',
        isBlocking: true,
        autoResolutionMs: null,
        questions: [{
          id: 'q1',
          header: 'Pick',
          question: 'Which project?',
          isOther: false,
          isSecret: false,
          options: [{ label: 'cyboflow', description: 'the cyboflow repo' }],
        }],
      },
      respond,
      reject: vi.fn(),
    },
  };
}

function mcpDispatch(options: {
  toolName?: string;
  serverName?: string;
  approvalKind?: string | null;
}): { request: Dispatch<'mcpServer/elicitation/request'>; respond: Respond } {
  const respond = vi.fn();
  const approvalKind = options.approvalKind === undefined ? 'mcp_tool_call' : options.approvalKind;
  return {
    respond,
    request: {
      id: 'mcp-1',
      method: 'mcpServer/elicitation/request',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        serverName: options.serverName ?? 'cyboflow',
        mode: 'form',
        _meta: approvalKind === null
          ? null
          : { codex_approval_kind: approvalKind, tool_name: options.toolName ?? 'cyboflow_list_tasks' },
        message: 'Allow MCP tool call?',
        requestedSchema: { type: 'object', properties: {} },
      },
      respond,
      reject: vi.fn(),
    },
  };
}

describe('global-agent isolation request policy', () => {
  it('accepts an MCP tool call for the scoped cyboflow family', () => {
    const { request, respond } = mcpDispatch({ toolName: 'cyboflow_list_tasks' });

    const decision = handleIsolationRequest(request);

    expect(decision).toEqual({
      decision: 'accept',
      method: 'mcpServer/elicitation/request',
      toolName: 'cyboflow_list_tasks',
      warning: null,
    });
    expect(respond).toHaveBeenCalledWith({ action: 'accept', content: null, _meta: null });
  });

  it('declines an MCP tool call from a server the user configured outside cyboflow', () => {
    // The one residual escape a read-only sandbox with no shell still leaves:
    // an MCP server merged in from the user's own ~/.codex/config.toml.
    const { request, respond } = mcpDispatch({
      serverName: 'github',
      toolName: 'github_create_pull_request',
    });

    const decision = handleIsolationRequest(request);

    expect(decision.decision).toBe('decline');
    expect(decision.warning).toContain('github_create_pull_request');
    expect(respond).toHaveBeenCalledWith({ action: 'decline', content: null, _meta: null });
  });

  it('declines an elicitation that is not a tool-call approval at all', () => {
    const { request, respond } = mcpDispatch({ approvalKind: null });

    expect(decideIsolationRequest(request).decision).toBe('decline');
    handleIsolationRequest(request);
    expect(respond).toHaveBeenCalledWith({ action: 'decline', content: null, _meta: null });
  });

  it('declines command execution, file changes, and permission grants', () => {
    const command = commandDispatch();
    const file = fileChangeDispatch();
    const permissions = permissionsDispatch();

    expect(handleIsolationRequest(command.request)).toMatchObject({
      decision: 'decline',
      toolName: 'Bash',
    });
    expect(command.respond).toHaveBeenCalledWith({ decision: 'decline' });

    expect(handleIsolationRequest(file.request)).toMatchObject({
      decision: 'decline',
      toolName: 'Edit',
    });
    expect(file.respond).toHaveBeenCalledWith({ decision: 'decline' });

    expect(handleIsolationRequest(permissions.request)).toMatchObject({
      decision: 'decline',
      toolName: 'Permissions',
    });
    // An EMPTY grant, not the requested network + write profile.
    expect(permissions.respond).toHaveBeenCalledWith({
      permissions: {},
      scope: 'turn',
      strictAutoReview: true,
    });
  });

  it('declines a user-input question with empty answers instead of routing it', () => {
    const { request, respond } = questionDispatch();

    const decision = handleIsolationRequest(request);

    expect(decision).toMatchObject({
      decision: 'decline',
      method: 'item/tool/requestUserInput',
      toolName: 'AskUserQuestion',
    });
    expect(respond).toHaveBeenCalledWith({ answers: {} });
  });

  it('names the method and tool in every decline warning', () => {
    for (const { request } of [
      commandDispatch(),
      fileChangeDispatch(),
      permissionsDispatch(),
      questionDispatch(),
    ]) {
      const decision = decideIsolationRequest(request);
      expect(decision.warning).toContain(decision.method);
      expect(decision.warning).toContain(decision.toolName);
    }
  });
});
