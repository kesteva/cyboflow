/**
 * HostRegistry — hostId -> ExecutionHost. This Mac is one LocalHost; SSH machines get an SshHost built from
 * the store row and cached by id. The cache key includes the target, label and remote root, so an edited row
 * rebuilds on the next get() even without an explicit invalidate(); hostsService also invalidates on update
 * and archive.
 *
 * Remote facts (spawn env base, expanded remote root) are a LIVE getter over the store row's latest complete
 * preflight (`preflight.remote`), not a snapshot taken at build time: a preflight that finishes after an SshHost
 * was cached is visible to it on the next spawn without a rebuild.
 */
import type { PreflightResult } from '../../../../shared/types/hosts';
import type { ExecutionHost } from '../../orchestrator/trpc/contracts/executionHost';
import { HostNotFoundError } from '../../orchestrator/hosts/errors';
import { LOCAL_HOST_ID, type HostRow } from '../../orchestrator/hosts/hostStore';
import type { LoggerLike } from '../../orchestrator/types';
import type { CaptureErrorFn } from './preflight/preflightEngine';
import { composeRemotePath, DEFAULT_REMOTE_BASE_PATH, type RemoteHostFacts } from './remoteLaunch';
import { SshHost, type SshHostDeps } from './sshHost';
import type { SshTransportLike } from './sshTransport';

const BASE_PATH_DIRS: ReadonlySet<string> = new Set(DEFAULT_REMOTE_BASE_PATH.split(':'));

/**
 * Directory part of an absolute remote path (`/a/b/node` → `/a/b`); null for anything else and for a directory the
 * base PATH already names.
 */
function remoteDirOf(p: string | null): string | null {
  if (p === null || !p.startsWith('/')) return null;
  const i = p.lastIndexOf('/');
  const dir = i <= 0 ? '/' : p.slice(0, i);
  return BASE_PATH_DIRS.has(dir) ? null : dir;
}

/**
 * RemoteHostFacts from a persisted preflight: only a complete result that recorded `remote` qualifies (null
 * otherwise — the host has not been checked, or only before remote flows existed). PATH names the probed node and
 * git directories ahead of the system dirs.
 */
export function remoteFactsFromPreflight(preflight: PreflightResult | null | undefined): RemoteHostFacts | null {
  const r = preflight?.remote;
  if (!preflight || preflight.probeComplete === false || !r || !r.home || !r.remoteRoot.startsWith('/')) return null;
  const nodeDir = remoteDirOf(r.nodePath);
  const gitDir = remoteDirOf(r.gitPath);
  return {
    remoteRoot: r.remoteRoot,
    home: r.home,
    path: composeRemotePath({ nodeDir, gitDir: gitDir === nodeDir ? null : gitDir }),
    user: r.user,
    logname: r.logname,
    shell: r.shell,
    tmpdir: r.tmpdir,
    lang: r.lang,
  };
}

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
    const store = this.deps.store;
    const host = create({
      id: row.id,
      label: row.label,
      sshTarget: row.sshTarget,
      remoteRoot,
      remoteFacts: () => remoteFactsFromPreflight(store.get(hostId)?.preflight),
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
