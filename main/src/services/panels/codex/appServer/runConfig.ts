import type { ClaudeSpawnerOptions } from '../../../../orchestrator/runExecutor';
import type { PermissionMode } from '../../../../../../shared/types/workflows';
import { resolveAgentModelAlias } from '../../agentModelContext';
import { codexPermissionFlagsForMode } from '../codexPtyManager';
import type {
  AppServerJsonValue,
  AppServerThreadResumeParams,
  AppServerThreadStartParams,
  AppServerTurnStartParams,
} from './protocol';

export interface CodexAppServerMcpRuntimeConfig {
  orchSocketPath: string;
  bridgeScriptPath: string;
  nodeExecutablePath: string;
}

type ThreadConfiguration = Omit<AppServerThreadStartParams, 'ephemeral' | 'experimentalRawEvents'>;

function buildMcpConfig(
  runId: string,
  runtimeConfig: CodexAppServerMcpRuntimeConfig,
): Record<string, AppServerJsonValue> {
  return {
    mcp_servers: {
      cyboflow: {
        command: runtimeConfig.nodeExecutablePath,
        args: [runtimeConfig.bridgeScriptPath],
        env: {
          CYBOFLOW_RUN_ID: runId,
          CYBOFLOW_ORCH_SOCKET: runtimeConfig.orchSocketPath,
        },
        required: true,
        default_tools_approval_mode: 'approve',
      },
    },
  };
}

export function buildCodexAppServerEnvironment(
  runId: string,
  runtimeConfig: CodexAppServerMcpRuntimeConfig,
  inheritedEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...inheritedEnvironment,
    CYBOFLOW_RUN_ID: runId,
    CYBOFLOW_ORCH_SOCKET: runtimeConfig.orchSocketPath,
  };
}

export function buildCodexAppServerThreadConfiguration(
  runId: string,
  options: ClaudeSpawnerOptions,
  runtimeConfig: CodexAppServerMcpRuntimeConfig,
): ThreadConfiguration {
  const permissionMode: PermissionMode = options.agentPermissionMode ?? 'default';
  const permissionFlags = codexPermissionFlagsForMode(permissionMode);
  const model = resolveAgentModelAlias('codex', options.model);

  return {
    cwd: options.worktreePath,
    sandbox: permissionFlags.sandbox,
    approvalPolicy: permissionFlags.approval,
    approvalsReviewer: permissionMode === 'auto' ? 'auto_review' : 'user',
    config: buildMcpConfig(runId, runtimeConfig),
    ...(model ? { model } : {}),
    ...(options.systemPromptAppend
      ? { developerInstructions: options.systemPromptAppend }
      : {}),
  };
}

export function buildCodexAppServerThreadStartParams(
  runId: string,
  options: ClaudeSpawnerOptions,
  runtimeConfig: CodexAppServerMcpRuntimeConfig,
): AppServerThreadStartParams {
  return {
    ...buildCodexAppServerThreadConfiguration(runId, options, runtimeConfig),
    ephemeral: false,
    experimentalRawEvents: true,
  };
}

export function buildCodexAppServerThreadResumeParams(
  runId: string,
  threadId: string,
  options: ClaudeSpawnerOptions,
  runtimeConfig: CodexAppServerMcpRuntimeConfig,
): AppServerThreadResumeParams {
  return {
    ...buildCodexAppServerThreadConfiguration(runId, options, runtimeConfig),
    threadId,
    excludeTurns: true,
  };
}

export function buildCodexAppServerTurnOptions(
  options: ClaudeSpawnerOptions,
): Pick<AppServerTurnStartParams, 'model'> {
  const model = resolveAgentModelAlias('codex', options.model);
  return model ? { model } : {};
}
