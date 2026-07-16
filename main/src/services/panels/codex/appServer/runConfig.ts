import type { ClaudeSpawnerOptions } from '../../../../orchestrator/runExecutor';
import type { PermissionMode } from '../../../../../../shared/types/workflows';
import { resolveAgentModelAlias } from '../../agentModelContext';
import { isValidEffortForProvider } from '../../../../../../shared/types/reasoningEffort';
import { codexPermissionFlagsForMode } from '../codexPtyManager';
import { electronRunAsNodeGuardEnv } from '../../../../utils/electronNodeGuard';
import { getShellPath } from '../../../../utils/shellPath';
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
          // Guard: nodeExecutablePath may resolve to the Electron app binary for a
          // packaged app with no standalone node on PATH — without this flag,
          // messaging Codex boots a whole new Cyboflow app. See electronNodeGuard.
          ...electronRunAsNodeGuardEnv(runtimeConfig.nodeExecutablePath),
        },
        required: true,
        default_tools_approval_mode: 'approve',
      },
    },
  };
}

/**
 * Union two PATH strings, `shellPath` first, dropping empties and duplicates.
 * The app-server (and every command the Codex agent shells out to, including the
 * project gate) inherits this PATH, so it MUST carry the user's login-shell PATH
 * — a packaged app launched from Finder has only the restricted launchd PATH in
 * `process.env`, which lacks pnpm/node(nvm)/homebrew and makes the gate fail to
 * start. See `getShellPath` for the login-shell resolution.
 */
function mergePathValue(
  shellPath: string,
  existingPath: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string {
  const delimiter = platform === 'win32' ? ';' : ':';
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const part of `${shellPath}${delimiter}${existingPath ?? ''}`.split(delimiter)) {
    const trimmed = part.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    merged.push(trimmed);
  }
  return merged.join(delimiter);
}

export function buildCodexAppServerEnvironment(
  runId: string,
  runtimeConfig: CodexAppServerMcpRuntimeConfig,
  inheritedEnvironment: NodeJS.ProcessEnv = process.env,
  resolveShellPath: () => string = getShellPath,
): NodeJS.ProcessEnv {
  const pathKey =
    Object.keys(inheritedEnvironment).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  return {
    ...inheritedEnvironment,
    [pathKey]: mergePathValue(resolveShellPath(), inheritedEnvironment[pathKey]),
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
): Pick<AppServerTurnStartParams, 'model' | 'effort'> {
  const model = resolveAgentModelAlias('codex', options.model);
  // Per-turn reasoning effort (IDEA-029). The spawn caller normalizes against
  // the provider, but re-guard here against Codex's scale (drops Claude-only
  // `max`) so a non-normalizing caller can't push an unaccepted value onto the
  // turn. `turnSession.startTurn` spreads this straight into the turn/start
  // params, so `effort` reaches Codex without any further plumbing.
  const effort =
    options.reasoningEffort && isValidEffortForProvider('codex', options.reasoningEffort)
      ? options.reasoningEffort
      : undefined;
  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
}
