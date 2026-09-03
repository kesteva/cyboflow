import type { ClaudeSpawnerOptions } from '../../../../orchestrator/runExecutor';
import type { PermissionMode } from '../../../../../../shared/types/workflows';
import { resolveAgentModelAlias } from '../../agentModelContext';
import { isValidEffortForProvider } from '../../../../../../shared/types/reasoningEffort';
import { codexPermissionFlagsForMode } from '../codexPtyManager';
import { electronRunAsNodeGuardEnv } from '../../../../utils/electronNodeGuard';
import { getShellPath } from '../../../../utils/shellPath';
import { orchTokenEnv } from '../../../../orchestrator/orchAuthToken';
import { managedTestConcurrencyEnv } from '../../../../../../shared/types/testConcurrency';
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

/**
 * Per-spawn inputs to the HERMETIC isolation branch (`isolation: 'agent'`) that
 * cannot be derived from the spawn options alone. Read by the manager at spawn
 * time (userMcpServers.ts) and threaded into every builder that produces the
 * thread configuration — the warm fingerprint included, so a change in the
 * user's own MCP list busts a parked app-server.
 */
export interface CodexIsolationConfig {
  /**
   * The user's own `[mcp_servers.<id>]` entries from `$CODEX_HOME/config.toml`.
   * The thread `config` override MERGES with that file (verified live), and
   * Codex has no "disable all" key — so each one is disabled BY NAME with the
   * documented `mcp_servers.<id>.enabled = false`.
   */
  disabledMcpServers: readonly string[];
}

type ThreadConfiguration = Omit<AppServerThreadStartParams, 'ephemeral' | 'experimentalRawEvents'>;

function buildMcpConfig(
  runId: string,
  runtimeConfig: CodexAppServerMcpRuntimeConfig,
  mcpScope?: ClaudeSpawnerOptions['mcpScope'],
  disabledMcpServers: readonly string[] = [],
): Record<string, AppServerJsonValue> {
  const disabled: Record<string, AppServerJsonValue> = {};
  for (const name of disabledMcpServers) {
    if (name === 'cyboflow') continue;
    disabled[name] = { enabled: false };
  }
  return {
    mcp_servers: {
      ...disabled,
      cyboflow: {
        command: runtimeConfig.nodeExecutablePath,
        args: [runtimeConfig.bridgeScriptPath],
        env: {
          CYBOFLOW_RUN_ID: runId,
          CYBOFLOW_ORCH_SOCKET: runtimeConfig.orchSocketPath,
          // Bearer token for `runId` (orchAuthToken.ts) — the socket server
          // refuses to bind the runId without it. This config is sent over the
          // app-server JSON-RPC channel, never written to disk.
          ...orchTokenEnv(runId),
          // Tag the server's advertised tool scope so cyboflowMcpServer surfaces
          // the matching scoped family (and gates out the run-scoped tools):
          // 'global-agent' → the global-agent read/propose family; 'design' → the
          // minimal design toolset. Mirrors composeMcpServers in
          // claudeCodeManager.ts. Absent ⇒ no scope env, run-scoped and
          // byte-identical to before.
          ...(mcpScope ? { CYBOFLOW_MCP_SCOPE: mcpScope } : {}),
          // Guard: nodeExecutablePath may resolve to the Electron app binary for a
          // packaged app with no standalone node on PATH — without this flag,
          // messaging Codex boots a whole new Cyboflow app. See electronNodeGuard.
          ...electronRunAsNodeGuardEnv(runtimeConfig.nodeExecutablePath),
        },
        required: true,
        default_tools_approval_mode: 'approve',
        // Codex's MCP client aborts any tools/call after 300s by default — fatal
        // for cyboflow_request_user_input, which blocks until a human answers
        // (a 5-minute-away user kills the interview; the bridge itself imposes
        // NO timeout on that gate — see cyboflowMcpServer). Codex has no
        // documented "disabled" value, so pin a week as the outer bound.
        tool_timeout_sec: 7 * 24 * 60 * 60,
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
    // Bearer token for `runId`. The app-server passes its env down to the
    // PreToolUse shell hook, which is the client that actually presents it.
    ...orchTokenEnv(runId),
    // The app-server — and every command the Codex agent shells out to,
    // including the project gate — inherits this env, so marking it here is what
    // makes a Codex lane's gate self-govern its vitest fork pool.
    ...managedTestConcurrencyEnv(),
  };
}

export function buildCodexAppServerThreadConfiguration(
  runId: string,
  options: ClaudeSpawnerOptions,
  runtimeConfig: CodexAppServerMcpRuntimeConfig,
  isolation?: CodexIsolationConfig,
): ThreadConfiguration {
  const model = resolveAgentModelAlias('codex', options.model);
  const instructions = options.systemPromptAppend
    ? { developerInstructions: options.systemPromptAppend }
    : {};

  // HERMETIC global-agent isolation (ClaudeSpawnerOptions.isolation) — a
  // DEDICATED branch, not a flag swap: none of codexPermissionFlagsForMode's four
  // modes yields {read-only, never}, and the global agent has no permission mode
  // to resolve (it is run-less). Mirrors the Claude manager, which special-cases
  // isolation before its ordinary permission ladder.
  //
  // The confinement is the whole point: the assistant reads and proposes through
  // the scoped cyboflow MCP family and nothing else.
  //   - sandbox 'read-only' + approvalPolicy 'never' — no writes, and no human
  //     prompt to route (there is no workflow_runs row for a router to gate on).
  //   - features.shell_tool false — "Enable the default shell tool for running
  //     commands" (Codex config reference), so the agent gets no shell at all.
  //   - web_search 'disabled' — "Remove the tool" (same reference).
  // The warm fingerprint already hashes this whole configuration, so an isolation
  // change busts a parked app-server on its own.
  if (options.isolation === 'agent') {
    return {
      cwd: options.worktreePath,
      sandbox: 'read-only',
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      config: {
        ...buildMcpConfig(runId, runtimeConfig, options.mcpScope, isolation?.disabledMcpServers ?? []),
        // Every built-in surface a read-only sandbox does not already close,
        // each by its documented key (Codex config reference):
        //   shell_tool / unified_exec — the shell + the PTY-backed `exec` tool
        //     (verified live: shell_tool alone still leaves `exec`);
        //   multi_agent — spawn_agent / send_input / wait_agent … ;
        //   apps + apps._default.enabled — ChatGPT app/connector tools, which
        //     "are not controlled by the sandboxed-command network proxy";
        //   remote_plugin — the remote plugin catalog (request_plugin_install).
        features: {
          shell_tool: false,
          unified_exec: false,
          multi_agent: false,
          apps: false,
          remote_plugin: false,
        },
        apps: { _default: { enabled: false } },
        include_apply_patch_tool: false,
        web_search: 'disabled',
      },
      ...(model ? { model } : {}),
      ...instructions,
    };
  }

  const permissionMode: PermissionMode = options.agentPermissionMode ?? 'default';
  const permissionFlags = codexPermissionFlagsForMode(permissionMode);

  return {
    cwd: options.worktreePath,
    sandbox: permissionFlags.sandbox,
    approvalPolicy: permissionFlags.approval,
    approvalsReviewer: permissionMode === 'auto' ? 'auto_review' : 'user',
    config: buildMcpConfig(runId, runtimeConfig, options.mcpScope),
    ...(model ? { model } : {}),
    ...instructions,
  };
}

export function buildCodexAppServerThreadStartParams(
  runId: string,
  options: ClaudeSpawnerOptions,
  runtimeConfig: CodexAppServerMcpRuntimeConfig,
  isolation?: CodexIsolationConfig,
): AppServerThreadStartParams {
  return {
    ...buildCodexAppServerThreadConfiguration(runId, options, runtimeConfig, isolation),
    ephemeral: false,
    experimentalRawEvents: true,
  };
}

export function buildCodexAppServerThreadResumeParams(
  runId: string,
  threadId: string,
  options: ClaudeSpawnerOptions,
  runtimeConfig: CodexAppServerMcpRuntimeConfig,
  isolation?: CodexIsolationConfig,
): AppServerThreadResumeParams {
  return {
    ...buildCodexAppServerThreadConfiguration(runId, options, runtimeConfig, isolation),
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
