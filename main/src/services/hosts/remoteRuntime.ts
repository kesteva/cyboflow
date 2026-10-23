/**
 * RemoteRuntime — the one place an agent manager (Claude SDK, Codex app-server) gets everything it needs to run a
 * process on an SSH environment (spec M2 §3 B1). It owns no process and no connection of its own; it composes the
 * pieces Phase A shipped:
 *
 *   resolveHostId()  which machine a spawn belongs to (explicit → workflow_runs.host_id → sessions.host_id);
 *   prepare()        the launch gates, the per-host orch link (HostsService.linkFor → `ssh -R` forward) and the
 *                    per-run orch token FILE on the remote, returning a RemoteRuntimeSession;
 *   session          remote toolchain paths, the remote PATH / env (remoteLaunch.composeRemoteEnv allowlist), the
 *                    ExecutionHost's spawn / fs / git, and release() for the link;
 *   removeRunToken() best-effort cleanup of the token file when a run ends (spec F2).
 *
 * Secrets: the orch token is minted locally (orchestrator/orchAuthToken.ts, idempotent per run) and travels to the
 * remote ONLY as the stdin of MachineFs.writeFile into `<remoteRoot>/run/<runId>.token` (mode 0600, directory
 * 0700). The process gets `CYBOFLOW_ORCH_TOKEN_FILE`; `CYBOFLOW_ORCH_TOKEN` itself is never in a remote env, a
 * prelude or any argv. The Claude OAuth token never leaves the remote (the spawn wrapper reads `<remoteRoot>/env`
 * there when HostSpawnSpec.withTokenEnvFile is set).
 *
 * LOCAL behaviour: nothing here runs for This Mac — resolveHostId() returns null for a local / NULL host and the
 * caller keeps its existing local path untouched. prepare() refuses a local id.
 */
import { createHash } from 'node:crypto';
import { isRemoteHostId, redactSecrets, type HostView, type PreflightResult } from '../../../../shared/types/hosts';
import { isOrchSockAuthDisabled, mintOrchToken } from '../../orchestrator/orchAuthToken';
import { HostsDisabledError, RemoteHostsDisabledError } from '../../orchestrator/hosts/errors';
import type {
  ExecutionHost,
  GitExecutor,
  HostProcess,
  HostSpawnSpec,
  MachineFs,
} from '../../orchestrator/trpc/contracts/executionHost';
import type { DatabaseLike, LoggerLike } from '../../orchestrator/types';
import type { HostLinkHandle } from './hostsService';
import { remoteFactsFromPreflight } from './hostRegistry';
import type { CaptureErrorFn } from './preflight/preflightEngine';
import {
  composeRemoteEnv,
  composeRemotePath,
  DEFAULT_REMOTE_BASE_PATH,
  type PathRemap,
  type RemoteHostFacts,
} from './remoteLaunch';
import { remoteToolchainPaths } from './toolchain/toolchainPusher';
import { TOOLCHAIN_HASH_RE, TOOLCHAIN_MANIFEST_NAME } from './toolchain/types';

// ---------------------------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------------------------

/**
 * Why prepare() (or a session call) refused. `message` is user-presentable (no secret, no ssh target); `code` is a
 * closed set for callers and telemetry.
 */
export type RemoteRuntimeErrorCode =
  | 'orch-auth-disabled'
  | 'not-remote'
  | 'archived'
  | 'needs-check'
  | 'not-installed'
  | 'no-node'
  | 'link-down'
  | 'token-write'
  | 'invalid-id'
  | 'released';

export class RemoteRuntimeError extends Error {
  readonly code: RemoteRuntimeErrorCode;
  constructor(code: RemoteRuntimeErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RemoteRuntimeError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Host resolution (pure over the db)
// ---------------------------------------------------------------------------------------------------------------

export interface HostIdLookup {
  /** An explicit host from the caller (RunExecutor passes the run's stamp). A string wins outright. */
  hostId?: string | null;
  sessionId?: string | null;
  runId?: string | null;
}

/** 'local' / null / undefined / '' → null (This Mac); anything else is the remote host id. */
export function normalizeHostId(id: string | null | undefined): string | null {
  return isRemoteHostId(id) && id.length > 0 ? id : null;
}

function readHostColumn(db: DatabaseLike, table: 'workflow_runs' | 'sessions', id: string): string | null {
  const row = db.prepare(`SELECT host_id FROM ${table} WHERE id = ?`).get(id) as { host_id?: string | null } | undefined;
  return normalizeHostId(row?.host_id ?? null);
}

/**
 * Which machine a spawn runs on; null = This Mac.
 *
 * Precedence: an explicit `hostId` STRING wins (normalised: 'local' → null). Otherwise `workflow_runs.host_id` of
 * `runId`, then `sessions.host_id` of `sessionId`. A NULL stamp is "This Mac or unknown", never an override: a run
 * row with a NULL host (e.g. a quick-session sentinel run) does not mask its session's remote stamp, and an explicit
 * `hostId: null` falls through to the lookups. So the answer is remote whenever either row says remote — a remote
 * spawn can fail loudly, but it can never silently become a local one. DB errors propagate (fail closed).
 */
export function resolveHostIdFromDb(db: DatabaseLike, input: HostIdLookup): string | null {
  if (typeof input.hostId === 'string') return normalizeHostId(input.hostId);
  if (input.runId) {
    const fromRun = readHostColumn(db, 'workflow_runs', input.runId);
    if (fromRun !== null) return fromRun;
  }
  if (input.sessionId) {
    const fromSession = readHostColumn(db, 'sessions', input.sessionId);
    if (fromSession !== null) return fromSession;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Remote names
// ---------------------------------------------------------------------------------------------------------------

const REMOTE_KEY_RE = /^[A-Za-z0-9._-]{1,128}$/;
const RUN_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * A filename-safe remote key (`[A-Za-z0-9._-]`, ≤ 128, the HostSpawnSpec.spawnKey contract) for any local key. A key
 * that already qualifies is returned as-is; anything else (a lane key `<runId>:<itemId>`) has the other characters
 * replaced by `_` plus an 8-hex digest of the original, so two different local keys never share a pidfile.
 */
export function remoteSpawnKey(key: string): string {
  if (key.length === 0) throw new RemoteRuntimeError('invalid-id', 'A spawn needs a non-empty key.');
  if (REMOTE_KEY_RE.test(key) && key !== '.' && key !== '..') return key;
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 8);
  const safe = key.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 119);
  return `${safe}-${digest}`;
}

function assertRunId(runId: string): string {
  if (!RUN_ID_RE.test(runId) || runId === '.' || runId === '..') {
    throw new RemoteRuntimeError('invalid-id', 'That run id cannot name a file on the environment.');
  }
  return runId;
}

/** `<remoteRoot>/run` — pidfiles and token files (0700). */
export function remoteRunDir(remoteRoot: string): string {
  return `${remoteRoot.replace(/\/+$/, '')}/run`;
}

/** `<remoteRoot>/run/<runId>.token` (0600). */
export function remoteRunTokenFile(remoteRoot: string, runId: string): string {
  return `${remoteRunDir(remoteRoot)}/${assertRunId(runId)}.token`;
}

/** `<remoteRoot>/artifacts/runs/<runKey>`. */
export function remoteArtifactsDir(remoteRoot: string, runKey: string): string {
  return `${remoteRoot.replace(/\/+$/, '')}/artifacts/runs/${assertRunId(runKey)}`;
}

const BASE_PATH_DIRS: ReadonlySet<string> = new Set(DEFAULT_REMOTE_BASE_PATH.split(':'));

/** Directory of an absolute remote path, or null (relative, or a dir the base PATH already names). */
function remoteDirOf(p: string | null): string | null {
  if (p === null || !p.startsWith('/')) return null;
  const i = p.lastIndexOf('/');
  const dir = i <= 0 ? '/' : p.slice(0, i);
  return BASE_PATH_DIRS.has(dir) ? null : dir;
}

// ---------------------------------------------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------------------------------------------

/** Absolute remote paths of the installed toolchain and the probed tools. */
export interface RemoteRuntimePaths {
  /** `<remoteRoot>/toolchain/<hash>/claude` — the native claude binary to run instead of the SDK's local one. */
  claude: string;
  /** `<remoteRoot>/toolchain/<hash>/cyboflowMcpServer.js` — the self-contained cyboflow MCP bridge. */
  mcpBundle: string;
  /** The pushed codex entrypoint; null when this toolchain has no codex for the machine's arch. */
  codexBin: string | null;
  /** Codex helper binaries, prepended to the remote PATH; null without codex. */
  codexPathDir: string | null;
  /** Absolute node (≥ 22) — the MCP bridge's interpreter. */
  nodePath: string;
  gitPath: string | null;
}

export interface RemoteEnvOptions {
  /** Extra local keys copied (path-remapped) besides every CYBOFLOW_* key: the lane env keys. */
  extraKeys?: readonly string[];
  /** Local→remote path prefixes applied to every copied value (the worktree, …). */
  pathMap?: readonly PathRemap[];
  /** Remote CYBOFLOW_RUN_ARTIFACTS_DIR (see artifactsDir()); dropped when absent. */
  artifactsDir?: string | null;
  /** CODEX_HOME only when it is set REMOTELY. */
  codexHome?: string | null;
}

export interface RemoteSessionSpawnOptions {
  /** release() the session when the process exits (the usual one-process-per-session shape). Default false. */
  releaseOnExit?: boolean;
}

/** What prepare() returns; one per spawn (or warm process). Call release() exactly when the process is gone. */
export interface RemoteRuntimeSession {
  readonly hostId: string;
  /**
   * The host's generation when this session was prepared (HostsService.generation). Callers that cache remote
   * writes for the app's lifetime (role files, artifact dirs) include it in their keys, so an address change or an
   * archive invalidates them.
   */
  readonly generation: number;
  /** Probe facts (expanded remote root, home, env base). */
  readonly facts: RemoteHostFacts;
  /** Absolute, expanded. */
  readonly remoteRoot: string;
  readonly paths: RemoteRuntimePaths;
  /** The remote end of this Mac's orch socket forward: the process's CYBOFLOW_ORCH_SOCKET. */
  readonly remoteSock: string;
  /** `<remoteRoot>/run/<runId>.token` (0600): the process's CYBOFLOW_ORCH_TOKEN_FILE. */
  readonly tokenFile: string;
  readonly runId: string;
  /** prepare()'s spawnKey made filename-safe (remoteSpawnKey); spawn()'s default. */
  readonly spawnKey: string;
  /** codex is pushed for this arch AND signed in (the last full check's runtimes.codexSdk). */
  readonly codexAvailable: boolean;
  /** `<remoteRoot>/artifacts/runs/<runKey>`. */
  artifactsDir(runKey: string): string;
  /** `<codexPathDir>:<nodeDir>:<gitDir>:/usr/bin:/bin:/usr/sbin:/sbin` (absent pieces skipped). */
  remotePath(): string;
  /**
   * The COMPLETE remote child env from a locally composed one (remoteLaunch.composeRemoteEnv allowlist): remote
   * HOME/USER/…, TERM=dumb, remotePath(), CYBOFLOW_* (remapped), CYBOFLOW_ORCH_SOCKET = remoteSock,
   * CYBOFLOW_ORCH_TOKEN_FILE = tokenFile. CYBOFLOW_ORCH_TOKEN, ELECTRON_RUN_AS_NODE and every non-allowlisted local
   * key are dropped.
   */
  env(localEnv: Readonly<Record<string, string | undefined>>, opts?: RemoteEnvOptions): Record<string, string>;
  /**
   * ExecutionHost.spawn on this machine (dedicated ssh connection, env on the stdin prelude). `spawnKey` defaults
   * to the session's and is made filename-safe. Throws RemoteRuntimeError('released') after release().
   */
  spawn(spec: Omit<HostSpawnSpec, 'spawnKey'> & { spawnKey?: string }, opts?: RemoteSessionSpawnOptions): HostProcess;
  readonly fs: MachineFs;
  readonly git: GitExecutor;
  /** Release the orch link lease. Idempotent: only the first call releases. */
  release(): void;
  readonly released: boolean;
}

// ---------------------------------------------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------------------------------------------

/** The HostsService surface the runtime uses (structural, for fakes). */
export interface RemoteRuntimeHostsLike {
  status(): { running: boolean; killed: boolean };
  /** @throws HostNotFoundError */
  get(id: string): Pick<HostView, 'id' | 'kind' | 'archivedAt' | 'remoteReady' | 'preflight'>;
  /** @throws for gates / unknown host; acquire() rejects when the forward cannot open (and self-releases). */
  linkFor(hostId: string): HostLinkHandle;
  /** HostsService.generation: bumped on a target change / archive. Every remote-write cache key includes it. */
  generation(hostId: string): number;
}

export interface RemoteRuntimeDeps {
  db: DatabaseLike;
  hosts: RemoteRuntimeHostsLike;
  /** HostRegistry.get — @throws HostNotFoundError. */
  getHost(hostId: string): ExecutionHost;
  logger: LoggerLike;
  captureError?: CaptureErrorFn;
  /** Orch token source; default mintOrchToken (idempotent per run). Never logged. */
  mintToken?: (runId: string) => string;
  /** Kill-switch source for CYBOFLOW_DISABLE_ORCH_SOCK_AUTH; default process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface PrepareOptions {
  /** The run whose orch token the process carries (workflow_runs.id, or the session's run identity). */
  runId: string;
  /** The manager's spawn key (lane keys allowed; made filename-safe for the remote pidfile). */
  spawnKey: string;
}

const MANIFEST_MAX_BYTES = 256 * 1024;
const CODEX_TARGET_RE = /^[A-Za-z0-9._-]{1,128}$/;

interface InstalledToolchain {
  hash: string;
  codexTarget: string | null;
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'unknown';
}

function readableMessage(err: unknown): string {
  return redactSecrets(err instanceof Error ? err.message : String(err));
}

export class RemoteRuntime {
  /**
   * Token files written this app session: `<hostId>\0<generation>\0<file>` → in-flight/settled write. A failed write
   * is forgotten (retry); a target change / archive bumps the generation, so the new machine is written afresh.
   */
  private readonly tokenWrites = new Map<string, Promise<void>>();
  /** The installed manifest's codex target per host + hash (read once from the remote). */
  private readonly installed = new Map<string, Promise<InstalledToolchain>>();

  constructor(private readonly deps: RemoteRuntimeDeps) {}

  /** See resolveHostIdFromDb. */
  resolveHostId(input: HostIdLookup): string | null {
    return resolveHostIdFromDb(this.deps.db, input);
  }

  /**
   * Gate, link and token for a spawn on `hostId`. Gates, in order: Environments running (HostsDisabledError), remote
   * hosts not kill-switched (RemoteHostsDisabledError), orch-socket auth on ('orch-auth-disabled'), the host exists
   * (HostNotFoundError) and is a live SSH machine ('not-remote' / 'archived'), its last complete check recorded the
   * remote facts ('needs-check'), cyboflow tools installed ('not-installed'), node known ('no-node'). Then the link
   * ('link-down') and the 0600 token file ('token-write'; the link is released again). Live reachability is the
   * launch path's hostsService.prelaunch(), not this.
   */
  async prepare(hostIdIn: string, opts: PrepareOptions): Promise<RemoteRuntimeSession> {
    const { hosts, logger } = this.deps;
    const status = hosts.status();
    if (!status.running) throw new HostsDisabledError();
    if (status.killed) throw new RemoteHostsDisabledError();
    if (isOrchSockAuthDisabled(this.deps.env ?? process.env)) {
      throw new RemoteRuntimeError(
        'orch-auth-disabled',
        'Remote runs need orchestrator socket authentication; it is turned off (CYBOFLOW_DISABLE_ORCH_SOCK_AUTH).',
      );
    }
    const hostId = normalizeHostId(hostIdIn);
    if (hostId === null) throw new RemoteRuntimeError('not-remote', 'This Mac does not run remote processes.');
    const generation = hosts.generation(hostId);
    const runId = assertRunId(opts.runId);
    const spawnKey = remoteSpawnKey(opts.spawnKey);

    const view = hosts.get(hostId);
    if (view.archivedAt !== null) throw new RemoteRuntimeError('archived', 'This environment was removed.');
    if (view.kind !== 'ssh') throw new RemoteRuntimeError('not-remote', 'This environment is not a remote machine.');
    const preflight: PreflightResult | null = view.preflight;
    const facts = remoteFactsFromPreflight(preflight);
    if (facts === null || !preflight?.remote) {
      throw new RemoteRuntimeError('needs-check', 'This environment has no completed check yet. Run a check first.');
    }
    const hash = preflight.toolchainHash;
    if (!view.remoteReady || hash === null || !TOOLCHAIN_HASH_RE.test(hash)) {
      throw new RemoteRuntimeError('not-installed', 'cyboflow tools are not installed on this environment (Install cyboflow tools).');
    }
    const nodePath = preflight.remote.nodePath;
    if (nodePath === null || !nodePath.startsWith('/')) {
      throw new RemoteRuntimeError('no-node', 'Node.js 22 was not found on this environment.');
    }
    const host = this.deps.getHost(hostId);
    const toolchain = await this.installedToolchain(hostId, generation, host, facts.remoteRoot, hash);
    const tc = remoteToolchainPaths(facts.remoteRoot, toolchain);
    const paths: RemoteRuntimePaths = {
      claude: tc.claude,
      mcpBundle: tc.mcpBundle,
      codexBin: tc.codexBin,
      codexPathDir: tc.codexPathDir,
      nodePath,
      gitPath: preflight.remote.gitPath,
    };

    const link = hosts.linkFor(hostId);
    let remoteSock: string;
    try {
      remoteSock = (await link.acquire()).remoteSock;
    } catch (err) {
      // acquire() releases its own ref on failure.
      throw new RemoteRuntimeError('link-down', `The orchestrator link to this environment is not available: ${readableMessage(err)}`, { cause: err });
    }

    const tokenFile = remoteRunTokenFile(facts.remoteRoot, runId);
    try {
      await this.writeRunToken(hostId, generation, host, facts.remoteRoot, runId, tokenFile);
    } catch (err) {
      link.release();
      logger.warn('[hosts] could not write the run token on the environment', { hostId, runId, error: errorName(err) });
      this.deps.captureError?.('host-spawn', err, { hostKind: 'ssh', step: 'token-write', errorClass: errorName(err) });
      throw new RemoteRuntimeError('token-write', `Could not prepare the run on this environment: ${readableMessage(err)}`, { cause: err });
    }

    logger.info('[hosts] remote runtime prepared', { hostId, runId });
    return this.createSession({
      hostId, generation, host, facts, paths, remoteSock, tokenFile, runId, spawnKey, link,
      codexAvailable: tc.codexBin !== null && preflight.runtimes.codexSdk,
    });
  }

  /**
   * Delete `<remoteRoot>/run/<runId>.token` (run terminal, spec F2). Best-effort: never throws, and a host that is
   * gone, unchecked or unreachable is just logged. The next prepare() for the run writes it again.
   */
  async removeRunToken(hostIdIn: string, runId: string): Promise<void> {
    const hostId = normalizeHostId(hostIdIn);
    if (hostId === null) return;
    try {
      const host = this.deps.getHost(hostId);
      const root = host.info.remoteRoot;
      if (root === null || !root.startsWith('/')) return;
      const file = remoteRunTokenFile(root, runId);
      this.tokenWrites.delete(tokenKey(hostId, this.deps.hosts.generation(hostId), file));
      await host.fs.unlink({ hostId, path: file });
    } catch (err) {
      this.deps.logger.warn('[hosts] could not remove a run token on the environment', { hostId, runId, error: errorName(err) });
    }
  }

  /** The installed toolchain's codex target, from `<hash>/manifest.json` on the remote (once per host generation + hash). */
  private installedToolchain(
    hostId: string,
    generation: number,
    host: ExecutionHost,
    remoteRoot: string,
    hash: string,
  ): Promise<InstalledToolchain> {
    const key = `${hostId}\0${generation}\0${remoteRoot}\0${hash}`;
    const hit = this.installed.get(key);
    if (hit) return hit;
    const dir = remoteToolchainPaths(remoteRoot, { hash, codexTarget: null }).dir;
    const read = (async (): Promise<InstalledToolchain> => {
      let raw: string;
      try {
        raw = await host.fs.readFile({ hostId, path: `${dir}/${TOOLCHAIN_MANIFEST_NAME}` }, MANIFEST_MAX_BYTES);
      } catch (err) {
        throw new RemoteRuntimeError('not-installed', 'cyboflow tools on this environment are missing or damaged (Install cyboflow tools).', { cause: err });
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        throw new RemoteRuntimeError('not-installed', 'cyboflow tools on this environment are damaged (Install cyboflow tools).', { cause: err });
      }
      const m = parsed as { hash?: unknown; codexTarget?: unknown } | null;
      const target = m?.codexTarget;
      if (m === null || typeof m !== 'object' || m.hash !== hash
        || !(target === null || target === undefined || (typeof target === 'string' && CODEX_TARGET_RE.test(target)))) {
        throw new RemoteRuntimeError('not-installed', 'cyboflow tools on this environment do not match this app (Install cyboflow tools).');
      }
      return { hash, codexTarget: typeof target === 'string' ? target : null };
    })();
    this.installed.set(key, read);
    read.catch(() => {
      if (this.installed.get(key) === read) this.installed.delete(key);
    });
    return read;
  }

  /** `<remoteRoot>/run` (0700) then the token (0600, over stdin) — once per host generation + token file. */
  private writeRunToken(
    hostId: string,
    generation: number,
    host: ExecutionHost,
    remoteRoot: string,
    runId: string,
    tokenFile: string,
  ): Promise<void> {
    const key = tokenKey(hostId, generation, tokenFile);
    const hit = this.tokenWrites.get(key);
    if (hit) return hit;
    const mint = this.deps.mintToken ?? mintOrchToken;
    const write = (async (): Promise<void> => {
      const runDir = remoteRunDir(remoteRoot);
      await host.fs.mkdirp({ hostId, path: runDir });
      // No `--`: macOS chmod rejects it after the mode; the path is absolute, so it cannot read as an option.
      const r = await host.exec.exec(['chmod', '700', runDir]);
      if (r.code !== 0) throw new Error(`chmod failed${r.stderr ? `: ${redactSecrets(r.stderr).trim().slice(0, 200)}` : ''}`);
      await host.fs.writeFile({ hostId, path: tokenFile }, `${mint(runId)}\n`, 0o600);
    })();
    this.tokenWrites.set(key, write);
    write.catch(() => {
      if (this.tokenWrites.get(key) === write) this.tokenWrites.delete(key);
    });
    return write;
  }

  private createSession(input: {
    hostId: string;
    generation: number;
    host: ExecutionHost;
    facts: RemoteHostFacts;
    paths: RemoteRuntimePaths;
    remoteSock: string;
    tokenFile: string;
    runId: string;
    spawnKey: string;
    link: HostLinkHandle;
    codexAvailable: boolean;
  }): RemoteRuntimeSession {
    const { hostId, generation, host, facts, paths, remoteSock, tokenFile, runId, spawnKey, link, codexAvailable } = input;
    const logger = this.deps.logger;
    let released = false;
    const nodeDir = remoteDirOf(paths.nodePath);
    const gitDir = remoteDirOf(paths.gitPath);
    const remotePath = (): string => composeRemotePath({
      codexPathDir: paths.codexPathDir,
      nodeDir,
      gitDir: gitDir === nodeDir ? null : gitDir,
    });
    const release = (): void => {
      if (released) return;
      released = true;
      try {
        link.release();
      } catch (err) {
        logger.warn('[hosts] orchestrator link release failed', { hostId, error: errorName(err) });
      }
    };
    return {
      hostId,
      generation,
      facts,
      remoteRoot: facts.remoteRoot,
      paths,
      remoteSock,
      tokenFile,
      runId,
      spawnKey,
      codexAvailable,
      artifactsDir: (runKey: string): string => remoteArtifactsDir(facts.remoteRoot, runKey),
      remotePath,
      env: (localEnv, opts = {}): Record<string, string> => composeRemoteEnv(localEnv, {
        facts,
        path: remotePath(),
        orchSocket: remoteSock,
        orchTokenFile: tokenFile,
        artifactsDir: opts.artifactsDir ?? null,
        codexHome: opts.codexHome ?? null,
        extraKeys: opts.extraKeys,
        pathMap: opts.pathMap,
      }),
      spawn: (spec, opts = {}): HostProcess => {
        if (released) throw new RemoteRuntimeError('released', 'This remote run was already released.');
        const proc = host.spawn({ ...spec, spawnKey: remoteSpawnKey(spec.spawnKey ?? spawnKey) });
        if (opts.releaseOnExit) proc.once('exit', release);
        return proc;
      },
      fs: host.fs,
      git: host.git,
      release,
      get released(): boolean {
        return released;
      },
    };
  }
}

function tokenKey(hostId: string, generation: number, tokenFile: string): string {
  return `${hostId}\0${generation}\0${tokenFile}`;
}
