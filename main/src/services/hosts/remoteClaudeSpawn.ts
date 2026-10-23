/**
 * remoteClaudeSpawn — everything the Claude SDK manager (services/panels/claude/claudeCodeManager.ts) needs to run
 * a spawn on an SSH environment (spec M2 §3 B2), kept here so the manager only branches on "remote or not" (it sits
 * under a file-size ratchet). Every helper is used ONLY for a remote host; a This Mac spawn never reaches this file
 * past resolveClaudeSpawnHostId().
 *
 *  resolveClaudeSpawnHostId  which machine (explicit → session row → run/session rows), fail-closed;
 *  prepareRemoteClaudeSpawn  RemoteRuntime.prepare (gates, orch link, 0600 token file) + the remote artifacts dir;
 *                            a refusal becomes a readable Error (`host-unreachable: …` for a link outage);
 *  remoteClaudeMcpServers    the EXCLUSIVE cyboflow-only MCP map (remote node/bundle/socket, token as a FILE path —
 *                            this JSON lands on the claude argv as --mcp-config, so the token itself never does);
 *  remoteClaudeRunEnv        the allowlisted env (no `process.env` spread, remote PATH, remote artifacts dir);
 *  remoteClaudeSdkOptions    pathToClaudeCodeExecutable + the `spawnClaudeCodeProcess` factory below;
 *  installRemoteWorkflowBundle / removeRemoteWorkflowBundle
 *                            the `/cyboflow-<phase>` bundle + agent overlay placed in the REMOTE worktree through
 *                            ExecutionHost.fs (spec M2 §5 D1), serialized per worktree;
 *  loadRemoteSpawnPermissionRules
 *                            the remote worktree's `.claude/settings{,.local}.json` (bounded host reads) merged with
 *                            this Mac's user settings, fail-closed (spec M2 §5 D2).
 *
 * The spawn factory (createRemoteClaudeSpawn), given the SDK's SpawnOptions:
 *  - IGNORES `command` (a LOCAL path: the SDK's resolved binary, or the packaged one) and runs the pushed remote
 *    `<remoteRoot>/toolchain/<hash>/claude`;
 *  - passes `args` through minus any flag that would carry a LOCAL path (`--add-dir`, `--plugin-dir`,
 *    `--plugin-dir-no-mcp`, `--debug-file`, `--managed-settings`, `--project-config-root=`) — the manager never
 *    produces them for a remote spawn; this is the backstop, and a dropped flag is logged by name only;
 *  - re-filters `env` through the session allowlist (RemoteRuntimeSession.env → remoteLaunch.composeRemoteEnv):
 *    remote HOME/USER/…, the remote PATH, CYBOFLOW_* (orch socket / token FILE / artifacts dir remapped), the extra
 *    keys and the SDK's own protocol flags (CLAUDE_CODE_* / CLAUDE_AGENT_SDK_*). This Mac's env, CYBOFLOW_ORCH_TOKEN,
 *    CLAUDE_CODE_OAUTH_TOKEN and ELECTRON_RUN_AS_NODE never leave; the env rides the wrapper's stdin prelude;
 *  - forwards `signal` (abort → HostProcess.kill: stdin EOF, then the remote process-group kill);
 *  - has the remote agent token read ON the remote from `<remoteRoot>/env` (withTokenEnvFile);
 *  - drains stderr (the SDK never reads a custom spawner's stderr, and a full pipe would stall the remote agent),
 *    logging a bounded, already-redacted tail when the process fails.
 * The returned HostProcess satisfies the SDK's SpawnedProcess (pid undefined).
 */
import type { McpServerConfig, Options, SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import type Database from 'better-sqlite3';
import { redactSecrets } from '../../../../shared/types/hosts';
import { managedTestConcurrencyEnv } from '../../../../shared/types/testConcurrency';
import { loadMergedPermissionRulesFrom, type MergedPermissionRules } from '../../orchestrator/permissionRules';
import type { HostProcess } from '../../orchestrator/trpc/contracts/executionHost';
import type { DatabaseLike, LoggerLike } from '../../orchestrator/types';
import { describeWrapperExit } from './remoteLaunch';
import {
  normalizeHostId,
  RemoteRuntimeError,
  resolveHostIdFromDb,
  type RemoteRuntimeSession,
} from './remoteRuntime';
import { getRemoteRuntime, RemoteRuntimeNotComposedError } from './remoteRuntimeBridge';
import { hostBundleFs, type BundleFs } from '../panels/claude/bundleFs';
import { installWorkflowBundleVia } from '../panels/claude/workflowBundleInstall';
import type { WorkflowBundleWriter } from '../panels/claude/workflowBundleWriter';

export type { RemoteRuntimeSession };

/** SDK protocol flags the SDK adds to the env it hands a spawner; forwarded so the remote CLI speaks the same protocol. */
export const SDK_PROTOCOL_ENV_RE = /^CLAUDE_(?:CODE|AGENT_SDK)_[A-Z0-9_]+$/;

/** Flags whose VALUE is a path on this Mac (`--flag <path>`). */
const LOCAL_PATH_FLAGS: ReadonlySet<string> = new Set([
  '--add-dir',
  '--plugin-dir',
  '--plugin-dir-no-mcp',
  '--debug-file',
  '--managed-settings',
]);
/** Flags written `--flag=<path>`. */
const LOCAL_PATH_FLAG_PREFIXES: readonly string[] = ['--project-config-root=', '--debug-file=', '--add-dir=', '--plugin-dir='];

const STDERR_TAIL_BYTES = 4 * 1024;
/** ssh's own failure exit (connection refused / dropped / auth). */
const SSH_FAILURE_EXIT = 255;

// ---------------------------------------------------------------------------------------------------------------
// Host resolution + prepare
// ---------------------------------------------------------------------------------------------------------------

export interface ClaudeSpawnHostLookup {
  /** ClaudeSpawnOptions.hostId: a string wins outright ('local' → This Mac). */
  hostId?: string | null;
  /** sessions.host_id of the row the manager already read. */
  sessionHostId?: string | null;
  /** The spawn's gate run id (workflow_runs.id, or the chat sentinel). */
  runId: string;
  sessionId: string;
}

/**
 * Which machine a Claude spawn runs on; null = This Mac. An explicit host string wins, then the session row in hand,
 * then the run / session rows through the wired RemoteRuntime (a remote stamp on either row means remote; db errors
 * propagate). With no runtime wired (Environments not composed) the same lookup runs over `db`, so a remote-stamped
 * spawn still FAILS rather than running locally; only a db that cannot answer (a schema without host columns, i.e.
 * a test fixture) reads as This Mac there.
 */
export function resolveClaudeSpawnHostId(db: DatabaseLike, input: ClaudeSpawnHostLookup, logger?: LoggerLike): string | null {
  if (typeof input.hostId === 'string') return normalizeHostId(input.hostId);
  const fromSession = normalizeHostId(input.sessionHostId ?? null);
  if (fromSession !== null) return fromSession;
  const lookup = { runId: input.runId, sessionId: input.sessionId };
  const rt = getRemoteRuntime();
  if (rt !== null) return rt.resolveHostId(lookup);
  try {
    return resolveHostIdFromDb(db, lookup);
  } catch (err) {
    logger?.debug('[hosts] host lookup unavailable without Environments; treating as This Mac', {
      error: err instanceof Error ? err.name : 'unknown',
    });
    return null;
  }
}

/**
 * The readable reason a remote spawn could not start. An orch-link failure is a reachability problem and is prefixed
 * `host-unreachable:` so the run's failure text tells an environment outage from a configuration gap.
 */
export function remoteSpawnFailureMessage(err: unknown): string {
  const raw = redactSecrets(err instanceof Error ? err.message : String(err));
  if (err instanceof RemoteRuntimeError && err.code === 'link-down') return `host-unreachable: ${raw}`;
  return raw;
}

/**
 * Remote artifacts dirs already created this app session (`<hostId>\0<generation>\0<dir>`): skip the ssh round
 * trip per turn. The host generation makes a target change / archive forget them.
 */
const artifactDirsMade = new Set<string>();

/**
 * RemoteRuntime.prepare for one spawn, then `mkdir -p` the run's artifacts dir ON the environment (non-fatal; only
 * screenshots need it, the next spawn retries). Rejects with a plain Error carrying remoteSpawnFailureMessage (the
 * original as `cause`); it never falls back to This Mac.
 */
export async function prepareRemoteClaudeSpawn(
  hostId: string,
  opts: { runId: string; spawnKey: string },
  logger?: LoggerLike,
): Promise<RemoteRuntimeSession> {
  let session: RemoteRuntimeSession;
  try {
    const rt = getRemoteRuntime();
    if (rt === null) throw new RemoteRuntimeNotComposedError();
    session = await rt.prepare(hostId, opts);
  } catch (err) {
    const message = remoteSpawnFailureMessage(err);
    logger?.error('[hosts] Claude spawn refused on the environment', { hostId, reason: message });
    throw new Error(message, { cause: err });
  }
  const dir = session.artifactsDir(opts.runId);
  const key = `${hostId}\0${session.generation}\0${dir}`;
  if (!artifactDirsMade.has(key)) {
    try {
      await session.fs.mkdirp({ hostId, path: dir });
      artifactDirsMade.add(key);
    } catch (err) {
      logger?.warn('[hosts] could not create the run artifacts dir on the environment', {
        hostId,
        error: redactSecrets(err instanceof Error ? err.message : String(err)),
      });
    }
  }
  return session;
}

/** Test seam: forget which remote artifacts dirs were created. */
export function _resetRemoteClaudeSpawnForTesting(): void {
  artifactDirsMade.clear();
  bundleQueue.clear();
}

/** A spawn's remote session and whether its ClaudeSdkRun record took ownership. */
export interface RemoteLease {
  session: RemoteRuntimeSession | null;
  adopted: boolean;
}

/** Release a lease nobody adopted (a warm push into a live process, or a throw before the record existed). */
export function releaseUnadoptedLease(lease: RemoteLease): void {
  if (lease.session !== null && !lease.adopted) lease.session.release();
}

/**
 * The fail-closed permission-rule snapshot: empty allow = every gated call goes to the ApprovalRouter. What
 * loadRemoteSpawnPermissionRules returns if loading itself throws (it never should).
 */
export function emptyPermissionRules(): MergedPermissionRules {
  return freezeRules({ allow: [], deny: [], ask: [] });
}

/** Freeze a per-spawn snapshot (the manager's local loadSpawnPermissionRules does the same). */
function freezeRules(rules: MergedPermissionRules): MergedPermissionRules {
  Object.freeze(rules.allow);
  Object.freeze(rules.deny);
  Object.freeze(rules.ask);
  return Object.freeze(rules);
}

// ---------------------------------------------------------------------------------------------------------------
// Permission rules (spec M2 §5 D2)
// ---------------------------------------------------------------------------------------------------------------

/** A settings file larger than this is not trusted to be read whole (read as a failure → fail-closed). */
export const REMOTE_SETTINGS_MAX_BYTES = 256 * 1024;

/**
 * The frozen per-spawn permission rules for a REMOTE worktree: `<worktree>/.claude/settings.json` and
 * `settings.local.json` read through the environment's fs (stat, then a bounded read), merged with this Mac's
 * `~/.claude/settings.json` exactly as permissionRules.loadMergedPermissionRules does locally. A missing file has no
 * rules; any read failure (unreachable, oversized, a directory) drops every allow rule (fail-closed,
 * loadMergedPermissionRulesFrom). Never rejects. Read fresh per spawn, never cached (a revoked allow must apply on
 * the next turn — same contract as the local snapshot).
 */
export async function loadRemoteSpawnPermissionRules(
  session: Pick<RemoteRuntimeSession, 'hostId' | 'fs'>,
  worktreePath: string,
  logger?: LoggerLike,
  homeDir?: string,
): Promise<MergedPermissionRules> {
  const { hostId, fs } = session;
  const read = async (p: string): Promise<string | null> => {
    try {
      const st = await fs.stat({ hostId, path: p });
      if (st === null) return null;
      if (!st.isFile || st.size > REMOTE_SETTINGS_MAX_BYTES) throw new Error('not a readable settings file');
      const text = await fs.readFile({ hostId, path: p }, REMOTE_SETTINGS_MAX_BYTES + 1);
      if (text.length > REMOTE_SETTINGS_MAX_BYTES) throw new Error('settings file too large');
      return text;
    } catch (err) {
      logger?.warn('[hosts] could not read a project permission settings file on the environment; allow rules off for this spawn', {
        hostId,
        error: redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 300),
      });
      throw err;
    }
  };
  try {
    return freezeRules(await loadMergedPermissionRulesFrom(worktreePath, read, homeDir));
  } catch {
    return emptyPermissionRules();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Workflow bundle + agent overlay (spec M2 §5 D1)
// ---------------------------------------------------------------------------------------------------------------

/** Where a remote session's bundle lives: the host port plus the remote worktree (kept for teardown). */
export interface RemoteBundleTarget {
  readonly hostId: string;
  readonly port: BundleFs;
  readonly worktreePath: string;
}

/**
 * The bundle target for a remote spawn. The port wraps the session's MachineFs, which is the ExecutionHost's own fs
 * (it outlives the session's orch-link lease), so teardown after release() still reaches the environment.
 */
export function remoteBundleTarget(session: Pick<RemoteRuntimeSession, 'hostId' | 'fs'>, worktreePath: string): RemoteBundleTarget {
  return { hostId: session.hostId, port: hostBundleFs(session.fs, session.hostId), worktreePath };
}

/**
 * Per remote worktree (`<hostId>\0<path>`), the tail of the install/remove chain. Locally an install and a
 * teardown are synchronous, so they can never interleave; over ssh both are many round trips, and a teardown that is
 * fire-and-forget could otherwise land in the middle of (or after) the next spawn's install and strip the fresh
 * bundle. Chaining keeps them in call order.
 */
const bundleQueue = new Map<string, Promise<void>>();

function enqueueBundleOp(target: RemoteBundleTarget, op: () => Promise<void>): Promise<void> {
  const key = `${target.hostId}\0${target.worktreePath}`;
  const next = (bundleQueue.get(key) ?? Promise.resolve()).then(op).catch(() => undefined);
  bundleQueue.set(key, next);
  void next.then(() => {
    if (bundleQueue.get(key) === next) bundleQueue.delete(key);
  });
  return next;
}

/**
 * Install the run's workflow bundle + agent overlay into the REMOTE worktree (workflowBundleInstall
 * .installWorkflowBundleVia, 'prose' dispatch: the SDK path renders no stage scripts). Resolves once the files are
 * placed (the caller awaits it before query(), so the remote CLI discovers them at start). Never rejects.
 */
export function installRemoteWorkflowBundle(
  db: Database.Database,
  writer: WorkflowBundleWriter,
  runId: string,
  target: RemoteBundleTarget,
  logger?: LoggerLike,
): Promise<void> {
  return enqueueBundleOp(target, () =>
    installWorkflowBundleVia(target.port, db, writer, runId, target.worktreePath, logger, 'prose'));
}

/** Strip the cyboflow-* bundle files from the REMOTE worktree (user files untouched). Never rejects. */
export function removeRemoteWorkflowBundle(
  writer: WorkflowBundleWriter,
  target: RemoteBundleTarget,
  logger?: LoggerLike,
): Promise<void> {
  return enqueueBundleOp(target, async () => {
    try {
      await writer.removeVia(target.port, target.worktreePath);
    } catch (err) {
      logger?.warn('[hosts] could not remove the workflow bundle on the environment', {
        hostId: target.hostId,
        error: redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 300),
      });
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------
// SDK options
// ---------------------------------------------------------------------------------------------------------------

/** What the manager knows about a spawn that shapes its remote options. */
export interface RemoteClaudeSpawnInputs {
  /** The run identity: CYBOFLOW_RUN_ID, the token file's run and the artifacts dir key. */
  runKey: string;
  /** The remote worktree (the session's stored path, already remote-absolute). */
  cwd: string;
  mcpScope?: string;
  laneEnv?: Readonly<Record<string, string>>;
  verbose?: boolean;
  logger?: LoggerLike;
}

/**
 * The EXCLUSIVE cyboflow-only mcpServers map (like `isolation === 'agent'`: no base-project merge — this Mac's
 * .mcp.json / ~/.claude.json name local commands; the remote CLI still discovers the environment's own config via
 * settingSources). No electronRunAsNodeGuardEnv: the remote node is a real node.
 */
export function remoteClaudeMcpServers(
  session: Pick<RemoteRuntimeSession, 'paths' | 'remoteSock' | 'tokenFile'>,
  inputs: Pick<RemoteClaudeSpawnInputs, 'runKey' | 'mcpScope'>,
): Record<string, McpServerConfig> {
  return {
    cyboflow: {
      command: session.paths.nodePath,
      args: [session.paths.mcpBundle],
      env: {
        CYBOFLOW_RUN_ID: inputs.runKey,
        CYBOFLOW_ORCH_SOCKET: session.remoteSock,
        CYBOFLOW_ORCH_TOKEN_FILE: session.tokenFile,
        ...(inputs.mcpScope ? { CYBOFLOW_MCP_SCOPE: inputs.mcpScope } : {}),
      },
      alwaysLoad: true,
    },
  };
}

/** Local keys a remote Claude spawn forwards besides every CYBOFLOW_* key. */
function extraEnvKeys(inputs: Pick<RemoteClaudeSpawnInputs, 'laneEnv'>): string[] {
  return ['MCP_DEBUG', ...Object.keys(inputs.laneEnv ?? {})];
}

/**
 * The allowlisted Options.env: no `process.env` spread, the remote PATH (probed tool dirs), the artifacts dir on the
 * environment, the orch socket = the forward's remote end, the token as a FILE path. Deterministic per run + host,
 * so it does not churn the warm-session fingerprint. TODO(M2-D): a lane's build-slot env values are local paths;
 * remap them once build slots run on the environment.
 */
export function remoteClaudeRunEnv(
  session: Pick<RemoteRuntimeSession, 'env' | 'artifactsDir'>,
  inputs: Pick<RemoteClaudeSpawnInputs, 'runKey' | 'laneEnv' | 'verbose'>,
): Record<string, string> {
  return session.env(
    { ...managedTestConcurrencyEnv(), ...(inputs.verbose ? { MCP_DEBUG: '1' } : {}), ...inputs.laneEnv },
    { extraKeys: extraEnvKeys(inputs), pathMap: [], artifactsDir: session.artifactsDir(inputs.runKey) },
  );
}

/** The executable + spawner Options for a remote spawn (replacing the local packaged-binary lookup). */
export function remoteClaudeSdkOptions(
  session: RemoteClaudeSpawnSession & Pick<RemoteRuntimeSession, 'artifactsDir'>,
  inputs: RemoteClaudeSpawnInputs,
): Pick<Options, 'pathToClaudeCodeExecutable' | 'spawnClaudeCodeProcess'> {
  return {
    pathToClaudeCodeExecutable: session.paths.claude,
    spawnClaudeCodeProcess: createRemoteClaudeSpawn(session, {
      cwd: inputs.cwd,
      extraKeys: extraEnvKeys(inputs),
      artifactsDir: session.artifactsDir(inputs.runKey),
      logger: inputs.logger,
    }),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Spawn factory
// ---------------------------------------------------------------------------------------------------------------

/** The session surface the factory needs (RemoteRuntimeSession satisfies it). */
export type RemoteClaudeSpawnSession = Pick<RemoteRuntimeSession, 'hostId' | 'paths' | 'env' | 'spawn'>;

export interface RemoteClaudeSpawnConfig {
  /** Remote working directory, used when the SDK passes none (it always should: Options.cwd is set). */
  cwd: string;
  /** Local env keys forwarded besides every CYBOFLOW_* key (MCP_DEBUG, a lane's build-slot keys). */
  extraKeys?: readonly string[];
  /** Remote CYBOFLOW_RUN_ARTIFACTS_DIR; dropped when absent. */
  artifactsDir?: string | null;
  logger?: LoggerLike;
}

/**
 * Drop every arg that carries a LOCAL path (see LOCAL_PATH_FLAGS). Returns the kept args and the dropped flag
 * names (never their values: they are paths on this Mac).
 */
export function sanitizeRemoteClaudeArgs(args: readonly string[]): { args: string[]; dropped: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (LOCAL_PATH_FLAGS.has(arg)) {
      dropped.push(arg);
      i++; // its value
      continue;
    }
    const prefix = LOCAL_PATH_FLAG_PREFIXES.find((p) => arg.startsWith(p));
    if (prefix !== undefined) {
      dropped.push(prefix.slice(0, -1));
      continue;
    }
    kept.push(arg);
  }
  return { args: kept, dropped };
}

/** The env keys (besides CYBOFLOW_*) a remote spawn forwards from the SDK's env: the caller's plus the SDK's flags. */
export function remoteClaudeEnvKeys(
  env: Readonly<Record<string, string | undefined>>,
  extraKeys: readonly string[] = [],
): string[] {
  const keys = new Set(extraKeys);
  for (const key of Object.keys(env)) {
    if (SDK_PROTOCOL_ENV_RE.test(key)) keys.add(key);
  }
  return [...keys];
}

/** Keep the last `max` characters of stderr. */
function appendTail(tail: string, chunk: Buffer | string, max: number): string {
  const next = tail + (typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  return next.length > max ? next.slice(next.length - max) : next;
}

/**
 * Build the SDK `spawnClaudeCodeProcess` for one remote runtime session. Throws (synchronously, inside the SDK's
 * spawn) when the session was already released or the host cannot spawn yet; the SDK surfaces that as the turn's
 * error.
 */
export function createRemoteClaudeSpawn(
  session: RemoteClaudeSpawnSession,
  config: RemoteClaudeSpawnConfig,
): (options: SpawnOptions) => SpawnedProcess {
  const logger = config.logger;
  return (options: SpawnOptions): SpawnedProcess => {
    const { args, dropped } = sanitizeRemoteClaudeArgs(options.args);
    if (dropped.length > 0) {
      logger?.warn('[hosts] dropped local-path claude flags from a remote spawn', { hostId: session.hostId, flags: dropped });
    }
    const env = session.env(options.env, {
      extraKeys: remoteClaudeEnvKeys(options.env, config.extraKeys),
      pathMap: [],
      artifactsDir: config.artifactsDir ?? null,
    });
    const proc: HostProcess = session.spawn({
      command: session.paths.claude,
      args,
      cwd: options.cwd ?? config.cwd,
      env,
      signal: options.signal,
      withTokenEnvFile: true,
    });

    let stderrTail = '';
    proc.stderr.on('data', (chunk: Buffer | string) => {
      stderrTail = appendTail(stderrTail, chunk, STDERR_TAIL_BYTES);
    });
    proc.stderr.on('error', () => {
      /* the exit event tells the story */
    });
    proc.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      if (code === 0 || proc.killed) return;
      const reason = code === SSH_FAILURE_EXIT ? 'host-unreachable' : describeWrapperExit({ code }) ?? 'exited';
      // stderr is redacted line by line by the HostProcess before it is readable here.
      logger?.warn('[ssh] remote claude process ended', {
        hostId: session.hostId,
        code,
        signal,
        reason,
        stderrTail: stderrTail.trim().slice(-1024),
      });
    });
    return proc;
  };
}
