import { describe, expect, it } from 'vitest';
import {
  buildCodexAppServerEnvironment,
  buildCodexAppServerThreadResumeParams,
  buildCodexAppServerThreadStartParams,
} from './runConfig';

const runtimeConfig = {
  orchSocketPath: '/tmp/cyboflow-orch.sock',
  bridgeScriptPath: '/app/cyboflowMcpServer.js',
  nodeExecutablePath: '/usr/local/bin/node',
};

describe('Codex app-server run configuration', () => {
  it('injects workflow runtime, model, permissions, instructions, and MCP configuration', () => {
    const params = buildCodexAppServerThreadStartParams('run-1', {
      panelId: 'run-1',
      sessionId: 'run-1',
      runId: 'run-1',
      worktreePath: '/tmp/worktree',
      prompt: 'ship it',
      systemPromptAppend: 'Report results through Cyboflow.',
      agentPermissionMode: 'acceptEdits',
      model: 'gpt-5.5',
    }, runtimeConfig);

    expect(params).toEqual({
      cwd: '/tmp/worktree',
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      model: 'gpt-5.5',
      developerInstructions: 'Report results through Cyboflow.',
      ephemeral: false,
      experimentalRawEvents: true,
      config: {
        mcp_servers: {
          cyboflow: {
            command: '/usr/local/bin/node',
            args: ['/app/cyboflowMcpServer.js'],
            env: {
              CYBOFLOW_RUN_ID: 'run-1',
              CYBOFLOW_ORCH_SOCKET: '/tmp/cyboflow-orch.sock',
            },
            required: true,
            default_tools_approval_mode: 'approve',
          },
        },
      },
    });
    expect(params).not.toHaveProperty('hooks');
  });

  it('omits a stale Claude model and maps dontAsk to native unrestricted settings', () => {
    const params = buildCodexAppServerThreadStartParams('run-1', {
      panelId: 'run-1',
      sessionId: 'run-1',
      worktreePath: '/tmp/worktree',
      prompt: 'ship it',
      agentPermissionMode: 'dontAsk',
      model: 'sonnet',
    }, runtimeConfig);

    expect(params).toMatchObject({
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
    });
    expect(params).not.toHaveProperty('model');
  });

  it('resumes the requested external thread without dropping per-run configuration', () => {
    const params = buildCodexAppServerThreadResumeParams('run-1', 'thread-1', {
      panelId: 'run-1',
      sessionId: 'run-1',
      worktreePath: '/tmp/worktree',
      prompt: 'continue',
    }, runtimeConfig);

    expect(params).toMatchObject({
      threadId: 'thread-1',
      excludeTurns: false,
      cwd: '/tmp/worktree',
      sandbox: 'read-only',
      approvalPolicy: 'on-request',
    });
  });

  it('inherits the ChatGPT-authenticated CLI environment and adds run correlation', () => {
    expect(buildCodexAppServerEnvironment('run-1', runtimeConfig, {
      CODEX_HOME: '/home/user/.codex',
      PATH: '/usr/local/bin',
    })).toEqual({
      CODEX_HOME: '/home/user/.codex',
      PATH: '/usr/local/bin',
      CYBOFLOW_RUN_ID: 'run-1',
      CYBOFLOW_ORCH_SOCKET: '/tmp/cyboflow-orch.sock',
    });
  });
});
