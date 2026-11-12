/**
 * HostLink — the per-host orch-socket forward (spec A7). One dedicated `ssh -N -R <remoteRoot>/s/o.sock:<local
 * orch.sock>` per ssh host, shared by every live remote spawn on it: the orch token is per RUN and the socket
 * server authenticates per runId, so one forward per host is enough.
 *
 *  - acquire() takes a reference and resolves with the remote socket path once the forward is up (opening it on
 *    the first reference); release() drops one. A rejected acquire holds no reference.
 *  - At refcount 0 the forward stays open for IDLE_CLOSE_MS (60 s) so back-to-back spawns reuse it, then closes.
 *  - An unexpected exit while references are held emits 'link-down' and reconnects with backoff 1, 2, 5, 10 s
 *    (10 s thereafter) until it is up again ('link-up') or the last reference is released. While reconnecting,
 *    acquire() fails fast with HostLinkDownError instead of queueing a launch behind an unreachable host.
 *  - The remote socket path must stay under 100 bytes (macOS sun_path is 104 incl. NUL); a longer one throws
 *    RemoteSocketPathTooLongError before any ssh.
 *
 * Timers are injected so the backoff and idle close are testable without real time.
 */
import { redactSecrets } from '../../../../shared/types/hosts';
import type { LoggerLike } from '../../orchestrator/types';
import type { ForwardHandle, SshTransportLike } from './sshTransport';

export const HOST_LINK_IDLE_CLOSE_MS = 60_000;
export const HOST_LINK_BACKOFF_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000];
/** Remote socket paths must be shorter than this many bytes. */
export const REMOTE_SOCK_MAX_BYTES = 100;

export class RemoteSocketPathTooLongError extends Error {
  readonly bytes: number;
  constructor(bytes: number) {
    super(`The environment's folder path is too long for the orchestrator link (${bytes} bytes; must be under ${REMOTE_SOCK_MAX_BYTES}). Choose a shorter remote folder.`);
    this.name = 'RemoteSocketPathTooLongError';
    this.bytes = bytes;
  }
}

export class HostLinkDownError extends Error {
  constructor(message = 'The link to this environment is down; reconnecting.') {
    super(message);
    this.name = 'HostLinkDownError';
  }
}

export class HostLinkNotReadyError extends Error {
  constructor() {
    super('This environment has not been checked yet. Run a check first.');
    this.name = 'HostLinkNotReadyError';
  }
}

/** `<remoteRoot>/s/o.sock`, validated for length. */
export function remoteOrchSocketPath(remoteRoot: string): string {
  const sock = `${remoteRoot.replace(/\/+$/, '')}/s/o.sock`;
  const bytes = Buffer.byteLength(sock, 'utf8');
  if (bytes >= REMOTE_SOCK_MAX_BYTES) throw new RemoteSocketPathTooLongError(bytes);
  return sock;
}

export type HostLinkEvent =
  | { type: 'link-up'; hostId: string; remoteSock: string }
  | { type: 'link-down'; hostId: string; reason: string };

export type HostLinkState = 'idle' | 'opening' | 'up' | 'reconnecting' | 'disposed';

export interface HostLinkTimers {
  /** Returns a cancel function. */
  setTimer(fn: () => void, ms: number): () => void;
}

const realTimers: HostLinkTimers = {
  setTimer: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return () => clearTimeout(t);
  },
};

export interface HostLinkDeps {
  hostId: string;
  sshTarget: string;
  transport: Pick<SshTransportLike, 'openForward'>;
  /** Expanded absolute remote root from the latest complete probe; null before one. */
  remoteRoot: () => string | null;
  /** This Mac's orch socket (`<cyboflow dir>/sockets/orch.sock`). */
  localSock: () => string;
  timers?: HostLinkTimers;
  idleCloseMs?: number;
  backoffMs?: readonly number[];
  logger?: LoggerLike;
}

export interface HostLinkLease {
  remoteSock: string;
}

export class HostLink {
  private refs = 0;
  private linkState: HostLinkState = 'idle';
  private handle: ForwardHandle | null = null;
  private remoteSock: string | null = null;
  private opening: Promise<void> | null = null;
  private attempt = 0;
  private cancelIdle: (() => void) | null = null;
  private cancelReconnect: (() => void) | null = null;
  private readonly listeners = new Set<(e: HostLinkEvent) => void>();
  private readonly timers: HostLinkTimers;

  constructor(private readonly deps: HostLinkDeps) {
    this.timers = deps.timers ?? realTimers;
  }

  get state(): HostLinkState {
    return this.linkState;
  }

  get refCount(): number {
    return this.refs;
  }

  /** Subscribe to link-up / link-down. Returns the unsubscribe function. */
  onEvent(listener: (e: HostLinkEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async acquire(): Promise<HostLinkLease> {
    if (this.linkState === 'disposed') throw new HostLinkDownError('The link to this environment was closed.');
    if (this.linkState === 'reconnecting') throw new HostLinkDownError();
    const root = this.deps.remoteRoot();
    if (!root || !root.startsWith('/')) throw new HostLinkNotReadyError();
    const sock = remoteOrchSocketPath(root);
    this.refs++;
    this.clearIdle();
    if (this.linkState === 'up' && this.remoteSock !== null) return { remoteSock: this.remoteSock };
    if (this.opening === null) this.opening = this.openInitial(sock);
    try {
      await this.opening;
    } catch (err) {
      this.release();
      throw err;
    }
    if (this.remoteSock === null) {
      // Up and gone again between the resolve and this continuation.
      this.release();
      throw new HostLinkDownError();
    }
    return { remoteSock: this.remoteSock };
  }

  release(): void {
    if (this.refs === 0) return;
    this.refs--;
    if (this.refs > 0) return;
    if (this.linkState === 'reconnecting') {
      this.cancelReconnect?.();
      this.cancelReconnect = null;
      // A reconnect attempt may be in flight (handle set, ready pending): close it, or it would come up with no
      // reference and never be idle-closed.
      this.closeHandle();
      return;
    }
    if (this.linkState === 'up') this.startIdle();
  }

  /** Close the forward and refuse further acquires (app quit / host archived). */
  dispose(): void {
    this.linkState = 'disposed';
    this.refs = 0;
    this.clearIdle();
    this.cancelReconnect?.();
    this.cancelReconnect = null;
    const h = this.handle;
    this.handle = null;
    this.remoteSock = null;
    h?.close();
  }

  private openInitial(sock: string): Promise<void> {
    this.linkState = 'opening';
    const handle = this.startForward(sock);
    return handle.ready.then(
      () => {
        this.opening = null;
        if (this.handle !== handle) return;
        this.markUp(sock);
      },
      (err: unknown) => {
        this.opening = null;
        if (this.handle === handle) this.handle = null;
        // Only openInitial sets 'opening' (single-flight), whether or not its exit already cleared the handle.
        if (this.linkState === 'opening') this.linkState = 'idle';
        throw err;
      },
    );
  }

  private startForward(sock: string): ForwardHandle {
    // Defensive: never orphan a previous forward (its exit is ignored once it is no longer `this.handle`).
    const previous = this.handle;
    if (previous !== null) {
      this.handle = null;
      previous.close();
    }
    const handle = this.deps.transport.openForward(this.deps.sshTarget, { remoteSock: sock, localSock: this.deps.localSock() });
    this.handle = handle;
    handle.on('exit', (code, stderrTail) => this.onExit(handle, code, stderrTail));
    return handle;
  }

  private markUp(sock: string): void {
    this.linkState = 'up';
    this.remoteSock = sock;
    this.attempt = 0;
    this.emit({ type: 'link-up', hostId: this.deps.hostId, remoteSock: sock });
    if (this.refs === 0) this.startIdle();
  }

  private startIdle(): void {
    this.clearIdle();
    this.cancelIdle = this.timers.setTimer(() => {
      this.cancelIdle = null;
      if (this.refs === 0 && this.linkState === 'up') this.closeHandle();
    }, this.deps.idleCloseMs ?? HOST_LINK_IDLE_CLOSE_MS);
  }

  private onExit(handle: ForwardHandle, code: number | null, stderrTail: string): void {
    if (this.handle !== handle) return;
    this.handle = null;
    const wasUp = this.linkState === 'up';
    this.remoteSock = null;
    if (this.linkState === 'disposed') return;
    if (this.linkState === 'opening') return; // the initial ready rejection reports it
    if (this.refs === 0) {
      this.clearIdle();
      this.linkState = 'idle';
      this.attempt = 0;
      return;
    }
    if (wasUp) {
      const tail = redactSecrets(stderrTail).trim().split(/\r?\n/).pop() ?? '';
      const reason = tail ? tail.slice(0, 300) : `ssh exited${code === null ? '' : ` with ${code}`}`;
      this.deps.logger?.warn('[hosts] orchestrator link down; reconnecting', { hostId: this.deps.hostId, code });
      this.emit({ type: 'link-down', hostId: this.deps.hostId, reason });
    }
    this.linkState = 'reconnecting';
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const backoff = this.deps.backoffMs ?? HOST_LINK_BACKOFF_MS;
    const delay = backoff[Math.min(this.attempt, backoff.length - 1)] ?? 10_000;
    this.attempt++;
    this.cancelReconnect = this.timers.setTimer(() => {
      this.cancelReconnect = null;
      this.reconnect();
    }, delay);
  }

  private reconnect(): void {
    if (this.linkState !== 'reconnecting') return;
    if (this.refs === 0) {
      this.linkState = 'idle';
      this.attempt = 0;
      return;
    }
    let sock: string;
    try {
      const root = this.deps.remoteRoot();
      if (!root || !root.startsWith('/')) throw new HostLinkNotReadyError();
      sock = remoteOrchSocketPath(root);
    } catch {
      this.scheduleReconnect();
      return;
    }
    const handle = this.startForward(sock);
    handle.ready.then(
      () => {
        if (this.handle === handle && this.linkState === 'reconnecting') this.markUp(sock);
      },
      () => {
        /* its 'exit' schedules the next attempt */
      },
    );
  }

  private closeHandle(): void {
    const h = this.handle;
    this.handle = null;
    this.remoteSock = null;
    this.linkState = 'idle';
    this.attempt = 0;
    h?.close();
  }

  private clearIdle(): void {
    this.cancelIdle?.();
    this.cancelIdle = null;
  }

  private emit(e: HostLinkEvent): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        /* a listener never breaks the link */
      }
    }
  }
}

/** hostId → HostLink, created on first use. The hosts service owns one pool. */
export class HostLinkPool {
  private readonly links = new Map<string, HostLink>();

  constructor(private readonly create: (hostId: string) => HostLink) {}

  get(hostId: string): HostLink {
    let link = this.links.get(hostId);
    if (!link || link.state === 'disposed') {
      link = this.create(hostId);
      this.links.set(hostId, link);
    }
    return link;
  }

  /** Close one host's forward (target edited / archived). */
  dispose(hostId: string): void {
    this.links.get(hostId)?.dispose();
    this.links.delete(hostId);
  }

  disposeAll(): void {
    for (const link of this.links.values()) link.dispose();
    this.links.clear();
  }
}
