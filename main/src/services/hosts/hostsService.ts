/**
 * HostsService — implements HostsFacade (orchestrator/hostsBridge.ts) over HostStore + HostRegistry + the
 * terminal manager, plus the gates:
 *  - feature: mutations, preflights and terminal I/O are refused (HostsDisabledError, mapped by NAME to
 *    `feature_disabled`) unless status().running (= available && enabled). Reads always answer.
 *  - kill switch CYBOFLOW_DISABLE_REMOTE_HOSTS: every mutation that targets an SSH machine, every SSH
 *    preflight and every terminal is refused with RemoteHostsDisabledError; rows stay readable.
 *
 * In memory only: the in-flight preflight per host (concurrent runPreflight calls coalesce onto it) and the
 * most recent attempt per host (HostView.lastAttempt — an unreachable run is not persisted beyond lifecycle).
 * Events: emitPreflightProgress per decided check and once with done:true; emitHostsChanged whenever the
 * view changes in memory (HostStore emits for its own writes).
 *
 * Orchestrator links (spec A7): the service owns ONE HostLinkPool (one refcounted `ssh -N -R` orch-socket forward
 * per SSH machine). linkFor(id) hands later stages an acquire/release handle; link-up / link-down refresh the view
 * (HostView.linkState) and reach onLinkEvent listeners. A target change or archive closes that machine's link;
 * shutdown() closes them all.
 *
 * Full tier (spec A6): preflightExtras() is what an SshHost's preflight runs with — the EXPECTED toolchain for the
 * machine's arch (this Mac's bundle, hashed by the toolchain module; repeated builds cost a stat per file thanks to
 * the hasher's (path, size, mtime) cache, and concurrent builds for one arch coalesce) and a link handle for
 * mcp-roundtrip. prelaunch() is the launch-time gate: it judges the last complete full preflight, whatever its age
 * (tier, runtimes and sign-in are stable; the scheduler refreshes them daily), and then checks reachability, the
 * toolchain and the link live under a 2 s budget — that live run is NEVER recorded, emitted or shown as the last
 * attempt. A launch never runs a full preflight: that can take a minute and spends a model request. installToolchain() is the explicit
 * "Install cyboflow tools" action (progress on the bridge's toolchain channel), followed by a full preflight.
 */
import {
  redactSecrets,
  type CapabilityTier,
  type HostLinkViewState,
  type HostsFeatureStatus,
  type HostView,
  type PreflightCheckId,
  type PreflightCheckResult,
  type PreflightResult,
  type ToolchainProgressEvent,
} from '../../../../shared/types/hosts';
import {
  emitHostsChanged,
  emitPreflightProgress,
  emitToolchainProgress,
  type HostsFacade,
} from '../../orchestrator/hostsBridge';
import {
  HostNeedsPreflightError,
  HostNotFoundError,
  HostTerminalUnavailableError,
  LocalHostImmutableError,
  RemoteHostsDisabledError,
  HostsDisabledError,
} from '../../orchestrator/hosts/errors';
import type { HostRow, HostStore } from '../../orchestrator/hosts/hostStore';
import { effectiveTier } from '../../orchestrator/hosts/tierRule';
import type { LoggerLike } from '../../orchestrator/types';
import { isHostPreflightScheduleKilled, isRemoteHostsKilled } from './flags';
import { HostLink, HostLinkPool, type HostLinkEvent, type HostLinkLease, type HostLinkTimers } from './hostLink';
import { remoteFactsFromPreflight, type HostRegistry } from './hostRegistry';
import type { ExpectedToolchain } from './preflight/checks';
import type {
  CaptureErrorFn,
  PreflightOrchLink,
  SshPreflightExtras,
} from './preflight/preflightEngine';
import type { SshTransportLike } from './sshTransport';
import type { BuildToolchainManifestOptions, BuiltToolchain } from './toolchain/toolchainHash';
import {
  ToolchainPushError,
  type PushToolchainInput,
  type PushToolchainResult,
} from './toolchain/toolchainPusher';
import type { ResolvedToolchainSources } from './toolchain/toolchainResolver';
import {
  CODEX_ENTRYPOINT_REL,
  TOOLCHAIN_CLAUDE_REL,
  TOOLCHAIN_CODEX_DIR,
  TOOLCHAIN_MCP_REL,
  ToolchainUnavailableError,
  toolchainArchFromUname,
  type ToolchainArch,
  type ToolchainManifest,
} from './toolchain/types';

/** Structural shape of HostTerminalManager (hostTerminalManager.ts); the service depends on nothing else. */
export interface HostTerminalsLike {
  /** Returns `host::<hostId>::t<n>`; throws HostTerminalUnavailableError past the open-terminal cap. */
  open(hostId: string, sshTarget: string): string;
  write(terminalId: string, text: string): void;
  resize(terminalId: string, cols: number, rows: number): void;
  /** Unknown id -> { backlog: '', exited: true, exitCode: null }. */
  getBacklog(terminalId: string): { backlog: string; exited: boolean; exitCode: number | null };
  closeOne(terminalId: string): void;
  closeForHost(hostId: string): void;
  destroyAll(): void;
  listOwnedShells(): Array<{ pid: number; terminalId: string; hostId: string }>;
}

export type HostStoreLike = Pick<
  HostStore,
  'list' | 'get' | 'activeWork' | 'addSsh' | 'update' | 'setUserCap' | 'recordPreflight' | 'archive' | 'setProjectDefault'
>;

/** linkFor() cannot hand out a link: This Mac, links not wired, or no local orch socket to forward. */
export class HostLinkUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostLinkUnavailableError';
  }
}

/** What linkFor() returns: one release() per successful acquire(). */
export interface HostLinkHandle {
  /** Resolves with the remote socket path once the forward is up (opens it on first use). */
  acquire(): Promise<HostLinkLease>;
  release(): void;
}

export interface HostLinksDeps {
  /** The SAME SshTransport the registry uses (forwards are dedicated connections, not the shared master). */
  transport: Pick<SshTransportLike, 'openForward'>;
  /** This Mac's orch socket path; null when there is none to forward (Windows named pipe / not started). */
  getOrchSocketPath(): string | null;
  timers?: HostLinkTimers;
}

/**
 * The toolchain module (spec A5) as the service uses it; the composition wires the real functions. Absent ⇒ the
 * preflight keeps the M1 shape (sdk-binary-hash skipped) and installToolchain() refuses.
 */
export interface HostsToolchainDeps {
  /** @throws ToolchainUnavailableError when this build has no tools for `arch` (or the MCP bundle is not built). */
  resolveSources(arch: ToolchainArch): ResolvedToolchainSources;
  buildManifest(resolved: ResolvedToolchainSources, opts?: BuildToolchainManifestOptions): Promise<BuiltToolchain>;
  push(input: PushToolchainInput): Promise<PushToolchainResult>;
  /** The SAME SshTransport the registry uses. */
  transport: PushToolchainInput['transport'];
}

/** The runtime a launch needs on the machine. */
export type PrelaunchRuntime = 'claude-sdk' | 'codex-sdk';

export type PrelaunchFailureCode =
  | 'unreachable' | 'not-installed' | 'no-auth' | 'tier' | 'runtime-unavailable' | 'disabled' | 'archived' | 'link-down'
  | 'needs-check';

export type PrelaunchResult = { ok: true } | { ok: false; code: PrelaunchFailureCode; reason: string };

export interface HostsServiceDeps {
  store: HostStoreLike;
  registry: Pick<HostRegistry, 'get' | 'invalidate' | 'closeAllMasters'>;
  terminals: HostTerminalsLike;
  appVersion: string;
  /** ConfigManager.isEnvironmentsAvailable() (= dev build). */
  isAvailable(): boolean;
  /** ConfigManager.isEnvironmentsEnabled(). */
  isEnabled(): boolean;
  /** Kill-switch source; read per call. Default process.env. */
  env?: NodeJS.ProcessEnv;
  logger: LoggerLike;
  captureError?: CaptureErrorFn;
  /** Orchestrator links; absent ⇒ linkFor() throws HostLinkUnavailableError (tests / stripped wiring). */
  links?: HostLinksDeps;
  /** The toolchain module; absent ⇒ no toolchain checks and no install. */
  toolchain?: HostsToolchainDeps;
}

interface LastAttempt {
  at: string;
  reachable: boolean;
  summary: string;
}

interface InFlight {
  promise: Promise<PreflightResult>;
  controller: AbortController;
}

interface InstallInFlight {
  promise: Promise<void>;
  controller: AbortController;
}

/** One line for HostView.lastAttempt. */
export function summarizePreflight(result: PreflightResult): string {
  if (!result.reachable) {
    const reach = result.results.find((r) => r.id === 'ssh-reachable');
    return `Not reachable${reach && reach.status === 'fail' ? `: ${reach.detail}` : ''}`;
  }
  if (result.probeComplete === false) return 'Reachable, but the check did not finish (connection dropped or timed out)';
  const count = (s: string): number => result.results.filter((r) => r.status === s).length;
  const parts = [
    [count('pass'), 'passed'],
    [count('warn'), count('warn') === 1 ? 'warning' : 'warnings'],
    [count('fail'), 'failed'],
    [count('skipped'), 'skipped'],
  ] as const;
  return parts.filter(([n]) => n > 0).map(([n, w]) => `${n} ${w}`).join(' · ') || 'No checks ran';
}

/** HostView.remoteReady: an SSH machine whose latest complete preflight passed sdk-binary-hash and recorded facts. */
export function isRemoteReady(row: Pick<HostRow, 'kind' | 'preflight'>): boolean {
  if (row.kind !== 'ssh' || remoteFactsFromPreflight(row.preflight) === null) return false;
  return row.preflight?.results.some((r) => r.id === 'sdk-binary-hash' && r.status === 'pass') === true;
}

function linkViewState(link: HostLink | undefined): HostLinkViewState {
  if (link === undefined) return 'idle';
  if (link.state === 'up') return 'up';
  if (link.state === 'reconnecting') return 'down';
  return 'idle';
}

function prelaunchFail(code: PrelaunchFailureCode, reason: string): PrelaunchResult {
  return { ok: false, code, reason };
}

function rowOf(result: PreflightResult, id: PreflightCheckId): PreflightCheckResult | undefined {
  return result.results.find((r) => r.id === id);
}

/** A check's detail with its fix appended, for a launch-refusal reason. */
function describeCheck(row: PreflightCheckResult | undefined, fallback: string): string {
  if (!row) return fallback;
  return row.fix ? `${row.label}: ${row.detail} (${row.fix})` : `${row.label}: ${row.detail}`;
}

/**
 * Judge a complete FULL preflight for a launch of `runtime` (pure). Order: reachable → toolchain installed →
 * signed in for that runtime → effective tier full (a failing link reads as link-down) → runtime present.
 */
export function judgeFullPreflight(
  result: PreflightResult,
  userCap: CapabilityTier | null,
  runtime: PrelaunchRuntime,
): PrelaunchResult {
  if (!result.reachable) return prelaunchFail('unreachable', describeCheck(rowOf(result, 'ssh-reachable'), 'The environment is not reachable.'));
  if (result.probeComplete === false) return prelaunchFail('unreachable', 'The last check of this environment did not finish.');
  const sdk = rowOf(result, 'sdk-binary-hash');
  if (sdk?.status !== 'pass') return prelaunchFail('not-installed', describeCheck(sdk, 'cyboflow tools are not installed (Install cyboflow tools)'));
  const auth = rowOf(result, runtime === 'claude-sdk' ? 'claude-auth' : 'codex-auth');
  if (auth?.status !== 'pass') return prelaunchFail('no-auth', describeCheck(auth, 'Not signed in on this environment.'));
  if (effectiveTier(result.detectedTier, userCap) !== 'full') {
    const blocking = result.results.find((r) => r.tierImpact === 'blocks-full' && (r.status === 'fail' || r.status === 'skipped'));
    if (blocking?.id === 'mcp-roundtrip') return prelaunchFail('link-down', describeCheck(blocking, 'The orchestrator link is down.'));
    if (blocking) return prelaunchFail('tier', describeCheck(blocking, 'This environment can only open terminals.'));
    return prelaunchFail('tier', userCap === 'cli'
      ? 'This environment is limited to terminals.'
      : 'This environment can only open terminals.');
  }
  const present = runtime === 'claude-sdk' ? result.runtimes.claudeSdk : result.runtimes.codexSdk;
  if (!present) {
    return prelaunchFail('runtime-unavailable', runtime === 'claude-sdk'
      ? 'Claude is not available on this environment.'
      : 'Codex is not available on this environment (its tools are not installed or it is not signed in).');
  }
  return { ok: true };
}

/** Judge a PRELAUNCH preflight (pure): reachable in time → toolchain → node → sign-in shape → link. */
export function judgePrelaunchPreflight(result: PreflightResult, runtime: PrelaunchRuntime): PrelaunchResult {
  const reach = rowOf(result, 'ssh-reachable');
  if (reach?.status !== 'pass') return prelaunchFail('unreachable', describeCheck(reach, 'The environment is not reachable.'));
  if (!result.probeComplete) return prelaunchFail('unreachable', 'The environment did not answer in time.');
  const sdk = rowOf(result, 'sdk-binary-hash');
  if (sdk?.status !== 'pass') return prelaunchFail('not-installed', describeCheck(sdk, 'cyboflow tools are not installed (Install cyboflow tools)'));
  const node = rowOf(result, 'node22');
  if (node?.status !== 'pass') return prelaunchFail('runtime-unavailable', describeCheck(node, 'Node.js 22 was not found.'));
  if (runtime === 'claude-sdk') {
    const auth = rowOf(result, 'claude-auth');
    if (auth?.status !== 'pass') return prelaunchFail('no-auth', describeCheck(auth, 'No Claude token on this environment.'));
  }
  const link = rowOf(result, 'mcp-roundtrip');
  if (link?.status !== 'pass') return prelaunchFail('link-down', describeCheck(link, 'The orchestrator link is down.'));
  return { ok: true };
}

/** The expected-toolchain view of a manifest: the three files the probe sizes. */
export function expectedFromManifest(manifest: ToolchainManifest): ExpectedToolchain {
  const codexRel = manifest.codexTarget ? `${TOOLCHAIN_CODEX_DIR}/${manifest.codexTarget}/${CODEX_ENTRYPOINT_REL}` : null;
  const wanted = new Set([TOOLCHAIN_CLAUDE_REL, TOOLCHAIN_MCP_REL, ...(codexRel ? [codexRel] : [])]);
  return {
    expectedHash: manifest.hash,
    files: manifest.files.filter((f) => wanted.has(f.rel)).map((f) => ({ rel: f.rel, size: f.size })),
    codexIncluded: codexRel !== null && manifest.files.some((f) => f.rel === codexRel),
    unavailableReason: null,
  };
}

function unavailableToolchain(reason: string): ExpectedToolchain {
  return { expectedHash: null, files: [], codexIncluded: false, unavailableReason: reason };
}

/** Closed set for the host-toolchain seam's errorClass tag. */
function toolchainErrorClass(err: unknown): string {
  const name = err instanceof Error ? err.name : '';
  return name === 'ToolchainPushError' || name === 'InvalidToolchainFileError' || name === 'InvalidToolchainRootError'
    ? name
    : 'other';
}

export class HostsService implements HostsFacade {
  private readonly inflight = new Map<string, InFlight>();
  private readonly lastAttempts = new Map<string, LastAttempt>();
  /** The pool's current link per host (for HostView.linkState); a disposed one reads as idle. */
  private readonly links = new Map<string, HostLink>();
  private readonly linkPool: HostLinkPool | null;
  private readonly linkListeners = new Set<(e: HostLinkEvent) => void>();
  /** The absolute remote root a running preflight probed, for a link opened before any result was recorded. */
  private readonly probedRoots = new Map<string, string>();
  private readonly installs = new Map<string, InstallInFlight>();
  /** In-flight manifest builds per arch (a preflight and an install share one). */
  private readonly toolchainBuilds = new Map<ToolchainArch, Promise<BuiltToolchain>>();

  constructor(private readonly deps: HostsServiceDeps) {
    const linkDeps = deps.links;
    this.linkPool = linkDeps ? new HostLinkPool((hostId) => this.createLink(hostId, linkDeps)) : null;
  }

  // ---------------------------------------------------------------- gates

  status(): HostsFeatureStatus {
    const env = this.deps.env ?? process.env;
    const available = this.deps.isAvailable();
    const enabled = this.deps.isEnabled();
    return {
      available,
      enabled,
      killed: isRemoteHostsKilled(env),
      scheduleKilled: isHostPreflightScheduleKilled(env),
      running: available && enabled,
    };
  }

  private guard(): void {
    if (!this.status().running) throw new HostsDisabledError();
  }

  private guardRemote(): void {
    if (isRemoteHostsKilled(this.deps.env ?? process.env)) throw new RemoteHostsDisabledError();
  }

  /** guardRemote() when the host is an SSH machine. Unknown ids fall through to the store's not-found. */
  private guardRemoteFor(id: string): void {
    if (this.deps.store.get(id)?.kind === 'ssh') this.guardRemote();
  }

  private requireLive(id: string): HostRow {
    const row = this.deps.store.get(id);
    if (!row || row.archivedAt !== null) throw new HostNotFoundError();
    return row;
  }

  // ---------------------------------------------------------------- reads

  private buildView(row: HostRow): HostView {
    const isLocal = row.kind === 'local';
    const detected: CapabilityTier | null = isLocal ? 'full' : row.detectedTier;
    const cap: CapabilityTier | null = isLocal ? null : row.userCapTier;
    const work = this.deps.store.activeWork(row.id);
    return {
      id: row.id,
      label: row.label,
      kind: row.kind,
      sshTarget: row.sshTarget,
      remoteRoot: row.remoteRoot,
      arch: row.arch,
      osVersion: row.osVersion,
      detectedTier: detected,
      userCapTier: cap,
      effectiveTier: effectiveTier(detected, cap),
      tierSource: isLocal ? 'fixed' : 'detected',
      lifecycleState: isLocal ? 'online' : row.lifecycleState,
      lastSeenAt: row.lastSeenAt,
      preflight: row.preflight,
      preflightAt: row.preflightAt,
      lastAttempt: this.lastAttempts.get(row.id) ?? null,
      preflightRunning: this.inflight.has(row.id),
      installRunning: this.installs.has(row.id),
      remoteReady: isRemoteReady(row),
      linkState: isLocal ? 'idle' : linkViewState(this.links.get(row.id)),
      runningSessions: work.sessions,
      runningRuns: work.runs,
      archivedAt: row.archivedAt,
      createdAt: row.createdAt,
    };
  }

  list(opts: { includeArchived: boolean }): HostView[] {
    return this.deps.store.list({ includeArchived: opts.includeArchived }).map((row) => this.buildView(row));
  }

  get(id: string): HostView {
    const row = this.deps.store.get(id);
    if (!row) throw new HostNotFoundError();
    return this.buildView(row);
  }

  // ------------------------------------------------------------ mutations

  async addSsh(input: { label: string; sshTarget: string }): Promise<{ id: string }> {
    this.guard();
    this.guardRemote();
    const id = await this.deps.store.addSsh(input);
    this.kickPreflight(id);
    return { id };
  }

  async update(id: string, patch: { label?: string; sshTarget?: string }): Promise<void> {
    this.guard();
    const before = this.deps.store.get(id);
    if (before?.kind === 'ssh') this.guardRemote();
    await this.deps.store.update(id, patch);
    // A label-only edit needs no teardown: the registry's cache key includes the label, so the next get() builds
    // a fresh SshHost, and the shared master (keyed by target) keeps serving any probe that is running now.
    if (!before || patch.sshTarget === undefined || patch.sshTarget === before.sshTarget) return;
    // A new destination invalidates everything learned about the old one. Cancel a preflight still talking to
    // the OLD machine and drop it from the coalescing map FIRST, so the re-check below starts a fresh run
    // instead of coalescing onto (and recording) the old one.
    const running = this.inflight.get(id);
    if (running) {
      running.controller.abort();
      this.inflight.delete(id);
    }
    this.installs.get(id)?.controller.abort();
    this.deps.registry.invalidate(id);
    this.disposeLink(id);
    this.probedRoots.delete(id);
    this.lastAttempts.delete(id);
    this.kickPreflight(id);
  }

  async setUserCap(id: string, cap: CapabilityTier | null): Promise<void> {
    this.guard();
    this.guardRemoteFor(id);
    await this.deps.store.setUserCap(id, cap);
  }

  async archive(id: string): Promise<void> {
    this.guard();
    this.guardRemoteFor(id);
    await this.deps.store.archive(id);
    this.inflight.get(id)?.controller.abort();
    this.installs.get(id)?.controller.abort();
    this.lastAttempts.delete(id);
    this.deps.terminals.closeForHost(id);
    this.disposeLink(id);
    this.probedRoots.delete(id);
    this.deps.registry.invalidate(id);
  }

  async setProjectDefault(projectId: number, hostId: string | null): Promise<void> {
    this.guard();
    if (hostId !== null) this.guardRemoteFor(hostId);
    await this.deps.store.setProjectDefault(projectId, hostId);
  }

  // ------------------------------------------------------------ preflight

  /** Coalesces with an in-flight run for the same host. Rejects only for a gate or an unknown host. */
  async runPreflight(id: string): Promise<PreflightResult> {
    this.guard();
    const row = this.requireLive(id);
    if (row.kind === 'ssh') this.guardRemote();
    const existing = this.inflight.get(id);
    if (existing) return existing.promise;

    const controller = new AbortController();
    const promise = this.executePreflight(row, controller.signal).finally(() => {
      // Superseded by a target change: the replacement run owns the map entry and the done/changed events.
      if (this.inflight.get(id)?.controller !== controller) return;
      this.inflight.delete(id);
      emitPreflightProgress({ hostId: id, check: null, done: true });
      emitHostsChanged({ kind: 'hosts', hostId: id });
    });
    this.inflight.set(id, { promise, controller });
    emitHostsChanged({ kind: 'hosts', hostId: id });
    return promise;
  }

  private async executePreflight(row: HostRow, signal: AbortSignal): Promise<PreflightResult> {
    const host = this.deps.registry.get(row.id);
    const result = await host.preflight(
      'full',
      // A cancelled run's "Cancelled" rows must not leak into a replacement run's live checklist.
      (check) => {
        if (!signal.aborted) emitPreflightProgress({ hostId: row.id, check, done: false });
      },
      signal,
    );
    if (signal.aborted) return result; // cancelled (archive / target change / shutdown): nothing to record
    if (row.kind === 'ssh' && this.deps.store.get(row.id)?.sshTarget !== row.sshTarget) {
      // Defensive: the destination changed under this run; its answer describes a machine the row no longer names.
      return result;
    }
    this.lastAttempts.set(row.id, {
      at: result.finishedAt,
      reachable: result.reachable,
      summary: summarizePreflight(result),
    });
    try {
      await this.deps.store.recordPreflight(row.id, result);
    } catch (err) {
      // Archived mid-run is expected; anything else is a defect worth a seam report.
      this.deps.logger.warn('[hosts] could not record preflight', { error: err instanceof Error ? err.name : 'unknown' });
      if (!(err instanceof HostNotFoundError)) {
        try {
          this.deps.captureError?.('host-preflight', err, { hostKind: row.kind });
        } catch {
          /* telemetry never breaks a preflight */
        }
      }
    }
    return result;
  }

  /** Start a full preflight in the background (add / target change). Never throws. */
  private kickPreflight(id: string): void {
    this.runPreflight(id).catch((err: unknown) => {
      this.deps.logger.warn('[hosts] background preflight did not start', {
        error: err instanceof Error ? err.name : 'unknown',
      });
    });
  }

  // ------------------------------------------------------------ orchestrator links

  /**
   * The orch-socket forward of an SSH machine, for a remote spawn: acquire() before the process starts, release()
   * when it exits. Throws (gates, unknown/archived host, This Mac, links not wired) synchronously; acquire() also
   * rejects with HostLinkUnavailableError when this Mac has no orch socket, and with the HostLink errors
   * (not checked yet, link down, socket path too long).
   */
  linkFor(hostId: string): HostLinkHandle {
    this.guard();
    this.guardRemote();
    const row = this.requireLive(hostId);
    if (row.kind !== 'ssh' || row.sshTarget === null) {
      throw new HostLinkUnavailableError('This Mac needs no orchestrator link.');
    }
    const pool = this.linkPool;
    if (pool === null) throw new HostLinkUnavailableError('Orchestrator links are not available in this build.');
    const link = pool.get(hostId);
    return {
      acquire: async (): Promise<HostLinkLease> => {
        if ((this.deps.links?.getOrchSocketPath() ?? null) === null) {
          throw new HostLinkUnavailableError('The cyboflow orchestrator socket is not running on this Mac.');
        }
        return link.acquire();
      },
      release: (): void => {
        const before = linkViewState(link);
        link.release();
        // The last release ends a reconnect loop without an event: refresh the view so 'down' does not linger.
        if (linkViewState(link) !== before) emitHostsChanged({ kind: 'hosts', hostId });
      },
    };
  }

  /** link-up / link-down for every SSH machine. Returns the unsubscribe function. */
  onLinkEvent(listener: (e: HostLinkEvent) => void): () => void {
    this.linkListeners.add(listener);
    return () => this.linkListeners.delete(listener);
  }

  private createLink(hostId: string, linkDeps: HostLinksDeps): HostLink {
    const row = this.deps.store.get(hostId);
    if (!row || row.sshTarget === null) throw new HostNotFoundError();
    const link = new HostLink({
      hostId,
      sshTarget: row.sshTarget,
      transport: linkDeps.transport,
      // A first check opens the link before its result (the remote facts) is recorded: fall back to its probe.
      remoteRoot: () => remoteFactsFromPreflight(this.deps.store.get(hostId)?.preflight)?.remoteRoot
        ?? this.probedRoots.get(hostId) ?? null,
      // acquire() refuses before this is ever read without a path; a reconnect that finds none fails and backs off.
      localSock: () => linkDeps.getOrchSocketPath() ?? '',
      timers: linkDeps.timers,
      logger: this.deps.logger,
    });
    link.onEvent((e) => this.onLinkEventInternal(e));
    this.links.set(hostId, link);
    return link;
  }

  private onLinkEventInternal(e: HostLinkEvent): void {
    if (e.type === 'link-up') this.deps.logger.info('[hosts] orchestrator link up', { hostId: e.hostId });
    else this.deps.logger.warn('[hosts] orchestrator link down', { hostId: e.hostId, reason: e.reason });
    emitHostsChanged({ kind: 'hosts', hostId: e.hostId });
    for (const l of this.linkListeners) {
      try {
        l(e);
      } catch {
        /* a listener never breaks the link */
      }
    }
  }

  private disposeLink(hostId: string): void {
    if (!this.links.has(hostId)) return;
    this.linkPool?.dispose(hostId);
    this.links.delete(hostId);
    emitHostsChanged({ kind: 'hosts', hostId });
  }

  // ------------------------------------------------------------ toolchain + full-tier preflight inputs

  /** Hash this Mac's toolchain for `arch` (coalesced per arch; the hasher's cache makes repeats a stat per file). */
  private buildToolchain(tc: HostsToolchainDeps, arch: ToolchainArch, onHashProgress?: (done: number, total: number) => void): Promise<BuiltToolchain> {
    const running = this.toolchainBuilds.get(arch);
    if (running) return running;
    const build = (async (): Promise<BuiltToolchain> => tc.buildManifest(tc.resolveSources(arch), { onHashProgress }))()
      .finally(() => {
        if (this.toolchainBuilds.get(arch) === build) this.toolchainBuilds.delete(arch);
      });
    this.toolchainBuilds.set(arch, build);
    return build;
  }

  /** The expected toolchain for a probed `uname -m`. Never rejects: an unusable build becomes unavailableReason. */
  private async expectedToolchainFor(unameM: string): Promise<ExpectedToolchain> {
    const tc = this.deps.toolchain;
    if (!tc) return unavailableToolchain('This build of cyboflow cannot install tools on other machines');
    const arch = toolchainArchFromUname(unameM);
    if (arch === null) return unavailableToolchain(`This build of cyboflow has no tools for ${unameM}`);
    try {
      return expectedFromManifest((await this.buildToolchain(tc, arch)).manifest);
    } catch (err) {
      if (err instanceof ToolchainUnavailableError) return unavailableToolchain(err.message);
      this.deps.logger.warn('[hosts] could not hash the local toolchain', { error: err instanceof Error ? err.name : 'unknown' });
      return unavailableToolchain(`Could not prepare the cyboflow tools: ${redactSecrets(err instanceof Error ? err.message : String(err))}`);
    }
  }

  /** mcp-roundtrip's (and the prelaunch link row's) handle on the machine's forward. */
  private preflightLink(hostId: string): PreflightOrchLink {
    let held: HostLinkHandle | null = null;
    return {
      available: () => (this.deps.links?.getOrchSocketPath() ?? null) !== null,
      acquire: async (remoteRoot: string) => {
        this.probedRoots.set(hostId, remoteRoot);
        const handle = this.linkFor(hostId);
        const lease = await handle.acquire();
        held = handle;
        return lease;
      },
      release: () => {
        const handle = held;
        held = null;
        handle?.release();
      },
    };
  }

  /**
   * What an SSH machine's preflight runs with (SshHostDeps.preflightExtras, wired by the composition): the expected
   * toolchain (arch hint = the last complete check's), the link, and for prelaunch the last known node path.
   */
  async preflightExtras(hostId: string, mode: PreflightResult['mode']): Promise<SshPreflightExtras> {
    const row = this.deps.store.get(hostId);
    const extras: SshPreflightExtras = {};
    if (this.deps.toolchain) {
      extras.toolchain = {
        archHint: row?.preflight?.remote?.arch ?? row?.arch ?? null,
        expectedFor: (unameM) => this.expectedToolchainFor(unameM),
      };
    }
    if (this.linkPool !== null) extras.orchLink = this.preflightLink(hostId);
    if (mode === 'prelaunch') extras.prelaunchNodePath = row?.preflight?.remote?.nodePath ?? null;
    return extras;
  }

  /** The row's last complete, reachable FULL preflight, whatever its age; else null. */
  private lastFullPreflight(row: HostRow): PreflightResult | null {
    const p = row.preflight;
    if (!p || p.mode !== 'full' || p.probeComplete === false || !p.reachable) return null;
    return p;
  }

  /**
   * Launch-time gate for a remote session/run on `hostId`. This Mac always passes. Judges the last complete full
   * preflight (any age; none → 'needs-check') for toolchain, sign-in, tier and runtime, then checks reachability,
   * the toolchain and the link live under the 2 s prelaunch budget. The live run is never recorded and emits
   * nothing. Never throws.
   */
  async prelaunch(hostId: string, runtime: PrelaunchRuntime, signal?: AbortSignal): Promise<PrelaunchResult> {
    const st = this.status();
    if (!st.running) return prelaunchFail('disabled', 'Environments are turned off.');
    const row = this.deps.store.get(hostId);
    if (!row || row.archivedAt !== null) return prelaunchFail('archived', 'This environment was removed.');
    if (row.kind !== 'ssh') return { ok: true };
    if (st.killed) return prelaunchFail('disabled', 'Remote environments are turned off.');

    const last = this.lastFullPreflight(row);
    if (last === null) return prelaunchFail('needs-check', 'This environment has no completed check yet. Run a check first.');
    const gate = judgeFullPreflight(last, row.userCapTier, runtime);
    if (!gate.ok) return gate;
    let live: PreflightResult;
    try {
      live = await this.deps.registry.get(hostId).preflight('prelaunch', undefined, signal);
    } catch (err) {
      if (err instanceof HostNotFoundError) return prelaunchFail('archived', 'This environment was removed.');
      return prelaunchFail('unreachable', redactSecrets(err instanceof Error ? err.message : String(err)));
    }
    return judgePrelaunchPreflight(live, runtime);
  }

  /**
   * `git -C <cwd> <args…>` on `hostId`, stdout on exit 0 (the orchestrator's handle on a remote session worktree;
   * RunLauncher reads HEAD / the branch through it). Refused like any other host I/O while the feature is off or the
   * kill switch is on.
   * @throws HostsDisabledError / RemoteHostsDisabledError / HostNotFoundError / HostGitCommandError
   */
  async gitCapture(
    hostId: string,
    cwd: string,
    args: string[],
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<string> {
    this.guard();
    this.guardRemoteFor(hostId);
    const { stdout } = await this.deps.registry.get(hostId).git.capture({ hostId, path: cwd }, args, opts);
    return stdout;
  }

  /**
   * "Install cyboflow tools" (≈550 MB): hash this Mac's toolchain for the machine's arch, push it, then kick a full
   * preflight. Needs a complete check (remote folder + arch): HostNeedsPreflightError otherwise. One install per
   * host: a call while one runs returns the running promise. Progress → emitToolchainProgress.
   */
  installToolchain(id: string): Promise<void> {
    try {
      this.guard();
      this.guardRemote();
      const row = this.requireLive(id);
      if (row.kind !== 'ssh' || row.sshTarget === null) throw new LocalHostImmutableError();
      const running = this.installs.get(id);
      if (running) return running.promise;
      const tc = this.deps.toolchain;
      if (!tc) throw new ToolchainPushError('check', id, 'not available in this build');
      const facts = remoteFactsFromPreflight(row.preflight);
      const unameM = row.preflight?.remote?.arch ?? null;
      if (facts === null || unameM === null) throw new HostNeedsPreflightError();
      const arch = toolchainArchFromUname(unameM);
      if (arch === null) throw new ToolchainPushError('check', id, `this build of cyboflow has no tools for ${unameM}`);

      const controller = new AbortController();
      const promise = this.executeInstall(tc, id, row.sshTarget, facts.remoteRoot, arch, controller.signal).finally(() => {
        if (this.installs.get(id)?.controller === controller) this.installs.delete(id);
        emitHostsChanged({ kind: 'hosts', hostId: id });
      });
      this.installs.set(id, { promise, controller });
      emitHostsChanged({ kind: 'hosts', hostId: id });
      return promise;
    } catch (err) {
      return Promise.reject(err);
    }
  }

  private async executeInstall(
    tc: HostsToolchainDeps,
    id: string,
    target: string,
    remoteRoot: string,
    arch: ToolchainArch,
    signal: AbortSignal,
  ): Promise<void> {
    const progress = (ev: Omit<ToolchainProgressEvent, 'hostId' | 'message'>, message: string | null = null): void => {
      try {
        emitToolchainProgress({ hostId: id, ...ev, message });
      } catch {
        /* a listener never breaks an install */
      }
    };
    let step: 'hash' | 'push' = 'hash';
    try {
      progress({ phase: 'hashing', bytesSent: 0, bytesTotal: 0 });
      const built = await this.buildToolchain(tc, arch, (done, total) => progress({ phase: 'hashing', bytesSent: done, bytesTotal: total }));
      if (signal.aborted) throw new ToolchainPushError('aborted', id, 'cancelled');
      step = 'push';
      const result = await tc.push({
        hostId: id,
        transport: tc.transport,
        target,
        remoteRoot,
        manifest: built.manifest,
        sources: built.sources,
        signal,
        logger: this.deps.logger,
        onProgress: (p) => progress({ phase: p.phase, bytesSent: p.bytesSent, bytesTotal: p.bytesTotal }),
      });
      this.deps.logger.info('[hosts] cyboflow tools installed', {
        hostId: id,
        alreadyInstalled: result.alreadyInstalled,
        removed: result.removed.length,
      });
    } catch (err) {
      const named = err instanceof ToolchainUnavailableError || err instanceof ToolchainPushError
        ? err
        : new ToolchainPushError('check', id, redactSecrets(err instanceof Error ? err.message : String(err)));
      // The closed `step` tag: the pusher's own step, else where an unexpected error surfaced (hash | push).
      const pushStep = err instanceof ToolchainPushError ? err.step : step;
      progress({ phase: 'failed', bytesSent: 0, bytesTotal: 0 }, redactSecrets(named.message));
      this.deps.logger.warn('[hosts] installing cyboflow tools failed', { hostId: id, step: pushStep, error: named.name });
      // This build lacking tools for the arch is a configuration answer, and a cancel is the user's: neither is a defect.
      if (!(named instanceof ToolchainUnavailableError) && pushStep !== 'aborted') {
        try {
          const reported = new Error(redactSecrets(named.message));
          reported.name = named.name;
          this.deps.captureError?.('host-toolchain', reported, {
            hostKind: 'ssh',
            errorClass: toolchainErrorClass(err),
            step: pushStep,
          });
        } catch {
          /* telemetry never breaks an install */
        }
      }
      throw named;
    }
    // A cancelled install (archive / target change / quit) has nothing to re-check.
    if (!signal.aborted) this.kickPreflight(id);
  }

  // ------------------------------------------------------------ terminals

  async terminalOpen(hostId: string): Promise<{ terminalId: string }> {
    this.guard();
    this.guardRemote();
    const row = this.requireLive(hostId);
    if (row.kind !== 'ssh' || row.sshTarget === null) throw new HostTerminalUnavailableError();
    return { terminalId: this.deps.terminals.open(hostId, row.sshTarget) };
  }

  terminalInput(terminalId: string, text: string): void {
    this.guard();
    this.guardRemote();
    this.deps.terminals.write(terminalId, text);
  }

  terminalResize(terminalId: string, cols: number, rows: number): void {
    this.guard();
    this.guardRemote();
    this.deps.terminals.resize(terminalId, cols, rows);
  }

  terminalBacklog(terminalId: string): { backlog: string; exited: boolean; exitCode: number | null } {
    return this.deps.terminals.getBacklog(terminalId);
  }

  /** Always allowed: closing is cleanup, never new remote work. */
  terminalClose(terminalId: string): void {
    this.deps.terminals.closeOne(terminalId);
  }

  // ------------------------------------------------------------ lifecycle

  /**
   * Quit drain (sync): abort in-flight preflights, close orchestrator links, kill terminals, close shared ssh
   * masters. Never throws.
   */
  shutdown(): void {
    for (const f of this.inflight.values()) f.controller.abort();
    for (const i of this.installs.values()) i.controller.abort();
    try {
      this.linkPool?.disposeAll();
      this.links.clear();
    } catch (err) {
      this.deps.logger.warn('[hosts] link teardown failed', { error: err instanceof Error ? err.name : 'unknown' });
    }
    try {
      this.deps.terminals.destroyAll();
    } catch (err) {
      this.deps.logger.warn('[hosts] terminal teardown failed', { error: err instanceof Error ? err.name : 'unknown' });
    }
    try {
      this.deps.registry.closeAllMasters();
    } catch {
      /* best-effort */
    }
  }
}
