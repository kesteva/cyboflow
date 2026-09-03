import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import {
  buildCodexAppServerEnvironment,
  buildCodexAppServerThreadResumeParams,
  buildCodexAppServerThreadStartParams,
  buildCodexAppServerTurnOptions,
} from './runConfig';
import { orchTokenRegistry } from '../../../../orchestrator/orchAuthToken';

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
              // Randomly minted per run — asserted for shape here and for
              // correctness by the dedicated bearer-token test below.
              CYBOFLOW_ORCH_TOKEN: expect.any(String),
            },
            required: true,
            default_tools_approval_mode: 'approve',
            tool_timeout_sec: 7 * 24 * 60 * 60,
          },
        },
      },
    });
    expect(params).not.toHaveProperty('hooks');
  });

  it('sets ELECTRON_RUN_AS_NODE on the MCP bridge env when node resolves to the Electron app binary', () => {
    const params = buildCodexAppServerThreadStartParams('run-1', {
      panelId: 'run-1',
      sessionId: 'run-1',
      worktreePath: '/tmp/worktree',
      prompt: 'ship it',
    }, { ...runtimeConfig, nodeExecutablePath: process.execPath });

    const server = (params.config as {
      mcp_servers: { cyboflow: { command: string; env: Record<string, string> } };
    }).mcp_servers.cyboflow;
    expect(server.command).toBe(process.execPath);
    // Without this flag, messaging Codex would boot a whole new Cyboflow app.
    expect(server.env.ELECTRON_RUN_AS_NODE).toBe('1');
  });

  it('omits ELECTRON_RUN_AS_NODE when a real node binary is resolved', () => {
    const params = buildCodexAppServerThreadStartParams('run-1', {
      panelId: 'run-1',
      sessionId: 'run-1',
      worktreePath: '/tmp/worktree',
      prompt: 'ship it',
    }, runtimeConfig);

    const server = (params.config as { mcp_servers: { cyboflow: { env: Record<string, string> } } })
      .mcp_servers.cyboflow;
    expect(server.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
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
    expect(params.model).toBeUndefined();
  });

  it('omits auto so the Codex runtime selects its advertised default', () => {
    const params = buildCodexAppServerThreadStartParams('run-1', {
      panelId: 'run-1',
      sessionId: 'run-1',
      worktreePath: '/tmp/worktree',
      prompt: 'ship it',
      model: 'auto',
    }, runtimeConfig);

    expect(params.model).toBeUndefined();
  });

  it('maps only auto mode to the pinned auto-review reviewer', () => {
    const base = {
      panelId: 'run-1',
      sessionId: 'run-1',
      worktreePath: '/tmp/worktree',
      prompt: 'ship it',
    };
    expect(buildCodexAppServerThreadStartParams('run-1', {
      ...base,
      agentPermissionMode: 'auto',
    }, runtimeConfig).approvalsReviewer).toBe('auto_review');
    for (const agentPermissionMode of ['default', 'acceptEdits', 'dontAsk'] as const) {
      expect(buildCodexAppServerThreadStartParams('run-1', {
        ...base,
        agentPermissionMode,
      }, runtimeConfig).approvalsReviewer).toBe('user');
    }
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
      excludeTurns: true,
      cwd: '/tmp/worktree',
      sandbox: 'read-only',
      approvalPolicy: 'on-request',
    });
  });

  it('keeps workflow turns in normal execution mode while resolving the model', () => {
    const base = {
      panelId: 'run-1',
      sessionId: 'run-1',
      worktreePath: '/tmp/worktree',
      prompt: 'ship it',
      model: 'gpt-5.5',
    };

    expect(buildCodexAppServerTurnOptions(base)).toEqual({ model: 'gpt-5.5' });
  });

  it('inherits the ChatGPT-authenticated CLI environment, enriches PATH with the login shell, and adds run correlation', () => {
    // PATH entries are joined with the host delimiter (':' on POSIX, ';' on
    // win32) — build the expectation the same way instead of hardcoding ':'.
    const d = path.delimiter;
    const shellPath = '/opt/homebrew/bin:/Users/me/.nvm/versions/node/v22/bin';
    expect(buildCodexAppServerEnvironment('run-1', runtimeConfig, {
      CODEX_HOME: '/home/user/.codex',
      PATH: '/usr/local/bin',
    }, () => shellPath)).toEqual({
      CODEX_HOME: '/home/user/.codex',
      // Login-shell PATH is prepended so pnpm/node resolve for the gate; the
      // inherited entry is preserved after it.
      PATH: [shellPath, '/usr/local/bin'].join(d),
      CYBOFLOW_RUN_ID: 'run-1',
      CYBOFLOW_ORCH_SOCKET: '/tmp/cyboflow-orch.sock',
      CYBOFLOW_ORCH_TOKEN: expect.any(String),
      // Marks the tree as agent-spawned so the project gate self-governs its
      // vitest fork pool instead of taking the whole box per sprint lane.
      CYBOFLOW_MANAGED_TEST_CONCURRENCY: '1',
    });
  });

  it('mints one bearer token per run and puts the SAME value on both channels', () => {
    const params = buildCodexAppServerThreadStartParams('run-tok', {
      panelId: 'run-tok',
      sessionId: 'run-tok',
      worktreePath: '/tmp/worktree',
      prompt: 'ship it',
      model: 'gpt-5.5',
    }, runtimeConfig);
    const mcp = (params.config as {
      mcp_servers: { cyboflow: { env: Record<string, string> } };
    }).mcp_servers.cyboflow.env;
    const appServerEnv = buildCodexAppServerEnvironment('run-tok', runtimeConfig, {}, () => '');

    // The MCP subprocess and the shell hook (which inherits the app-server env)
    // are two clients of one run — a mismatch would get one of them refused.
    expect(mcp.CYBOFLOW_ORCH_TOKEN).toBe(appServerEnv.CYBOFLOW_ORCH_TOKEN);
    expect(orchTokenRegistry.verify('run-tok', mcp.CYBOFLOW_ORCH_TOKEN)).toBe(true);
    expect(orchTokenRegistry.verify('run-other', mcp.CYBOFLOW_ORCH_TOKEN)).toBe(false);
  });

  it('recovers pnpm when the inherited PATH is the restricted launchd PATH (packaged-app symptom)', () => {
    // Entries are delimited and deduped with the host delimiter — parameterize
    // the fixture on path.delimiter so the dedupe property is verified on both.
    const d = path.delimiter;
    const env = buildCodexAppServerEnvironment(
      'run-1',
      runtimeConfig,
      { PATH: ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(d) },
      () => ['/opt/homebrew/bin', '/usr/bin', '/bin'].join(d),
    );
    expect(env.PATH?.split(d)).toContain('/opt/homebrew/bin');
    // No duplicate entries even though the shell PATH and inherited PATH overlap.
    expect(env.PATH).toBe(['/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(d));
  });

  it('creates PATH from the login shell when the inherited environment has none', () => {
    const env = buildCodexAppServerEnvironment(
      'run-1',
      runtimeConfig,
      {},
      () => '/opt/homebrew/bin',
    );
    expect(env.PATH).toBe('/opt/homebrew/bin');
  });
  it('stamps the MCP scope into the bridge env ONLY when a scope is set', () => {
    const base = {
      panelId: 'run-1',
      sessionId: 'run-1',
      worktreePath: '/tmp/worktree',
      prompt: 'ship it',
    };
    const scoped = buildCodexAppServerThreadStartParams(
      'run-1',
      { ...base, mcpScope: 'global-agent' as const },
      runtimeConfig,
    );
    const unscoped = buildCodexAppServerThreadStartParams('run-1', base, runtimeConfig);

    const envOf = (params: { config?: unknown }): Record<string, string> =>
      (params.config as { mcp_servers: { cyboflow: { env: Record<string, string> } } })
        .mcp_servers.cyboflow.env;
    // Without it the assistant would be served the RUN-scoped tool family, most
    // of which fail for a run-less identity.
    expect(envOf(scoped).CYBOFLOW_MCP_SCOPE).toBe('global-agent');
    expect(envOf(unscoped)).not.toHaveProperty('CYBOFLOW_MCP_SCOPE');
  });

  it('confines a hermetic global-agent spawn regardless of the permission mode', () => {
    const params = buildCodexAppServerThreadStartParams('agent:thread-1', {
      panelId: 'agent:thread-1',
      sessionId: 'agent:thread-1',
      worktreePath: '/Users/me',
      prompt: 'what changed today?',
      systemPromptAppend: 'You are the Cyboflow assistant.',
      // The isolation branch bypasses codexPermissionFlagsForMode entirely —
      // dontAsk would otherwise map to danger-full-access.
      agentPermissionMode: 'dontAsk',
      isolation: 'agent',
      mcpScope: 'global-agent',
      model: 'gpt-5.5',
    }, runtimeConfig);

    expect(params).toEqual({
      cwd: '/Users/me',
      sandbox: 'read-only',
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      model: 'gpt-5.5',
      developerInstructions: 'You are the Cyboflow assistant.',
      ephemeral: false,
      experimentalRawEvents: true,
      config: {
        mcp_servers: {
          cyboflow: {
            command: '/usr/local/bin/node',
            args: ['/app/cyboflowMcpServer.js'],
            env: {
              CYBOFLOW_RUN_ID: 'agent:thread-1',
              CYBOFLOW_ORCH_SOCKET: '/tmp/cyboflow-orch.sock',
              CYBOFLOW_ORCH_TOKEN: expect.any(String),
              CYBOFLOW_MCP_SCOPE: 'global-agent',
            },
            required: true,
            default_tools_approval_mode: 'approve',
            tool_timeout_sec: 7 * 24 * 60 * 60,
          },
        },
        // The residual escapes from a read-only sandbox: the default shell tool
        // and web search. Both are removed by documented Codex config keys.
        features: { shell_tool: false },
        web_search: 'disabled',
      },
    });
  });

  it('leaves a resumed isolation thread under the same confinement', () => {
    const params = buildCodexAppServerThreadResumeParams('agent:thread-1', 'codex-thread-1', {
      panelId: 'agent:thread-1',
      sessionId: 'agent:thread-1',
      worktreePath: '/Users/me',
      prompt: 'and yesterday?',
      isolation: 'agent',
      mcpScope: 'global-agent',
    }, runtimeConfig);

    expect(params).toMatchObject({
      threadId: 'codex-thread-1',
      excludeTurns: true,
      sandbox: 'read-only',
      approvalPolicy: 'never',
    });
  });
});
