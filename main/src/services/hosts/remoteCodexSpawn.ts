/**
 * remoteCodexSpawn — what CodexSdkManager needs to start a run's Codex app-server on an SSH environment (spec M2
 * §3 B3). Only the manager's COLD-ENTRY client goes through here; onboarding detection, the model catalog,
 * `--version`, usage polling, the eval juror, the verifier and the PTY lane keep the local bundled codex.
 *
 *   prepareRemoteCodexLaunch()  RemoteRuntime.prepare (gates, orch link, 0600 token file) + the pushed codex;
 *   createRemoteCodexSpawn()    the client's `spawn` seam: ExecutionHost.spawn on that machine, returning the
 *                               HostProcess (pid undefined — the client's teardown then calls kill(), which runs the
 *                               remote process-group kill, and never signals a LOCAL group);
 *   remoteCodexMcpRuntimeConfig() the per-host cyboflow MCP bridge config (forwarded socket, pushed bundle, probed
 *                               node, token FILE) — the global local config is never mutated.
 *
 * Secrets: the orch token reaches the app-server and the MCP bridge only as CYBOFLOW_ORCH_TOKEN_FILE; the env rides
 * the spawn wrapper's stdin prelude, never an argv.
 */
import type { SpawnAppServerProcess } from '../panels/codex/appServer/client';
import type { CodexAppServerMcpRuntimeConfig } from '../panels/codex/appServer/runConfig';
import { CODEX_EXECUTABLE_VERSION } from '../panels/codex/codexExecutablePath';
import type { PrepareOptions, RemoteRuntimeSession } from './remoteRuntime';
import type { RemoteRuntimeLike } from './remoteRuntimeBridge';

/** The environment's toolchain has no codex for its architecture (or the session lost it). */
export class RemoteCodexUnavailableError extends Error {
  constructor() {
    super('This environment has no Codex tools. Install cyboflow tools on it again, or run this step with Claude.');
    this.name = 'RemoteCodexUnavailableError';
  }
}

/** Everything a cold Codex entry needs for one remote app-server. Owns `session`: release it when the process is gone. */
export interface RemoteCodexLaunch {
  session: RemoteRuntimeSession;
  /** The pushed codex entrypoint on the environment (the client's `command`). */
  command: string;
  /** The pushed codex is the app's own bundled build, so it carries the same version. */
  version: typeof CODEX_EXECUTABLE_VERSION;
  spawn: SpawnAppServerProcess;
  runtimeConfig: CodexAppServerMcpRuntimeConfig;
}

/** The cyboflow MCP bridge as the remote app-server must launch it. */
export function remoteCodexMcpRuntimeConfig(session: RemoteRuntimeSession): CodexAppServerMcpRuntimeConfig {
  return {
    orchSocketPath: session.remoteSock,
    bridgeScriptPath: session.paths.mcpBundle,
    nodeExecutablePath: session.paths.nodePath,
    orchTokenFile: session.tokenFile,
  };
}

function requireCodexBin(session: RemoteRuntimeSession): string {
  const bin = session.paths.codexBin;
  if (bin === null || !bin.startsWith('/')) throw new RemoteCodexUnavailableError();
  return bin;
}

/**
 * The client's spawn seam for `session`. The command is ALWAYS the pushed codex (the `command` argument is ignored,
 * so a local path can never be executed remotely); `cwd` is the remote worktree and `env` the complete remote env,
 * both as the manager composed them. The process releases the session when it exits.
 */
export function createRemoteCodexSpawn(session: RemoteRuntimeSession): SpawnAppServerProcess {
  return (_command, args, options) => {
    const command = requireCodexBin(session);
    return session.spawn(
      { command, args: [...args], cwd: options.cwd, env: options.env },
      { releaseOnExit: true },
    );
  };
}

/** Wrap a prepared session; throws RemoteCodexUnavailableError (session NOT released — the caller owns it). */
export function remoteCodexLaunch(session: RemoteRuntimeSession): RemoteCodexLaunch {
  return {
    session,
    command: requireCodexBin(session),
    version: CODEX_EXECUTABLE_VERSION,
    spawn: createRemoteCodexSpawn(session),
    runtimeConfig: remoteCodexMcpRuntimeConfig(session),
  };
}

/**
 * Gate + link + token on `hostId`, then the launch. Any failure after prepare() releases the session, so a refused
 * spawn never leaks an orch-link lease. Rejects with RemoteRuntimeError / HostsDisabledError /
 * RemoteHostsDisabledError (from prepare) or RemoteCodexUnavailableError — all with user-readable messages.
 */
export async function prepareRemoteCodexLaunch(
  rt: Pick<RemoteRuntimeLike, 'prepare'>,
  hostId: string,
  opts: PrepareOptions,
): Promise<RemoteCodexLaunch> {
  const session = await rt.prepare(hostId, opts);
  try {
    return remoteCodexLaunch(session);
  } catch (err) {
    session.release();
    throw err;
  }
}
