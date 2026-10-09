/**
 * HostRegistry — hostId -> ExecutionHost. This Mac is one LocalHost; SSH machines get an SshHost built from
 * the store row and cached by id. The cache key includes the target, label and remote root, so an edited row
 * rebuilds on the next get() even without an explicit invalidate(); hostsService also invalidates on update
 * and archive.
 */
import type { ExecutionHost } from '../../orchestrator/trpc/contracts/executionHost';
import { HostNotFoundError } from '../../orchestrator/hosts/errors';
import { LOCAL_HOST_ID, type HostRow } from '../../orchestrator/hosts/hostStore';
import type { LoggerLike } from '../../orchestrator/types';
import type { CaptureErrorFn } from './preflight/preflightEngine';
import { SshHost, type SshHostDeps } from './sshHost';
import type { SshTransportLike } from './sshTransport';

export interface HostRegistryDeps {
  store: { get(id: string): HostRow | null };
  transport: SshTransportLike;
  local: ExecutionHost;
  appVersion: string;
  createSshHost?: (deps: SshHostDeps) => ExecutionHost;
  captureError?: CaptureErrorFn;
  logger?: LoggerLike;
}

interface CacheEntry {
  key: string;
  host: ExecutionHost;
  sshTarget: string;
}

export class HostRegistry {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly deps: HostRegistryDeps) {}

  get transport(): SshTransportLike {
    return this.deps.transport;
  }

  /** @throws HostNotFoundError for an unknown or archived host. */
  get(hostId: string): ExecutionHost {
    if (hostId === LOCAL_HOST_ID) return this.deps.local;
    const row = this.deps.store.get(hostId);
    if (!row || row.archivedAt !== null || row.kind !== 'ssh' || row.sshTarget === null) {
      this.cache.delete(hostId);
      throw new HostNotFoundError();
    }
    const remoteRoot = row.remoteRoot ?? `~/cf-remote/${row.id}`;
    const key = JSON.stringify([row.sshTarget, row.label, remoteRoot]);
    const hit = this.cache.get(hostId);
    if (hit && hit.key === key) return hit.host;
    const create = this.deps.createSshHost ?? ((d: SshHostDeps) => new SshHost(d));
    const host = create({
      id: row.id,
      label: row.label,
      sshTarget: row.sshTarget,
      remoteRoot,
      appVersion: this.deps.appVersion,
      transport: this.deps.transport,
      captureError: this.deps.captureError,
      logger: this.deps.logger,
    });
    this.cache.set(hostId, { key, host, sshTarget: row.sshTarget });
    return host;
  }

  /** Drop the cached SshHost and close its shared master connection (best-effort). */
  invalidate(hostId: string): void {
    const hit = this.cache.get(hostId);
    this.cache.delete(hostId);
    if (hit) {
      try {
        this.deps.transport.closeMaster(hit.sshTarget);
      } catch {
        /* teardown is best-effort */
      }
    }
  }

  /** Fire-and-forget `ssh -O exit` for every SSH host this registry has built a connection for. */
  closeAllMasters(): void {
    const targets = new Set([...this.cache.values()].map((e) => e.sshTarget));
    for (const target of targets) {
      try {
        this.deps.transport.closeMaster(target);
      } catch {
        /* teardown is best-effort */
      }
    }
  }
}
