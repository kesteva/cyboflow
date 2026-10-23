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
 */
import type {
  CapabilityTier,
  HostLinkViewState,
  HostsFeatureStatus,
  HostView,
  PreflightResult,
} from '../../../../shared/types/hosts';
import { emitHostsChanged, emitPreflightProgress, type HostsFacade } from '../../orchestrator/hostsBridge';
import {
  HostNotFoundError,
  HostTerminalUnavailableError,
  RemoteHostsDisabledError,
  HostsDisabledError,
} from '../../orchestrator/hosts/errors';
import type { HostRow, HostStore } from '../../orchestrator/hosts/hostStore';
import { effectiveTier } from '../../orchestrator/hosts/tierRule';
import type { LoggerLike } from '../../orchestrator/types';
import { isHostPreflightScheduleKilled, isRemoteHostsKilled } from './flags';
import { HostLink, HostLinkPool, type HostLinkEvent, type HostLinkLease, type HostLinkTimers } from './hostLink';
import { remoteFactsFromPreflight, type HostRegistry } from './hostRegistry';
import type { CaptureErrorFn } from './preflight/preflightEngine';
import type { SshTransportLike } from './sshTransport';

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

export class HostsService implements HostsFacade {
  private readonly inflight = new Map<string, InFlight>();
  private readonly lastAttempts = new Map<string, LastAttempt>();
  /** The pool's current link per host (for HostView.linkState); a disposed one reads as idle. */
  private readonly links = new Map<string, HostLink>();
  private readonly linkPool: HostLinkPool | null;
  private readonly linkListeners = new Set<(e: HostLinkEvent) => void>();

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
    this.deps.registry.invalidate(id);
    this.disposeLink(id);
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
    this.lastAttempts.delete(id);
    this.deps.terminals.closeForHost(id);
    this.disposeLink(id);
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
      remoteRoot: () => remoteFactsFromPreflight(this.deps.store.get(hostId)?.preflight)?.remoteRoot ?? null,
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
