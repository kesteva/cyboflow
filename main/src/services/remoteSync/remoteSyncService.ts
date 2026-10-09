/**
 * RemoteSyncService — runs the sync engine inside the app (desktop doc, "Engine").
 *
 *   - Identity comes from the shared cyboflow cloud sign-in (CloudAccountHandle):
 *     the device id/code and the token. Sync never decrypts; with no token yet
 *     (locked) it waits quietly.
 *   - Cadence: a 60 s tick, wake/focus triggers, and a 2 s debounce after a
 *     local backlog write. One pass per project at a time; a trigger that lands
 *     mid-pass re-runs it once afterwards.
 *   - Failures back off per project (network/5xx/429, honouring Retry-After,
 *     capped at 2 min). 401 hands the dead token back to the cloud module.
 *   - Every 12th successful pass of a project runs the convergence checksum.
 *   - Linking (desktop doc, "Joining a second machine", M1a): the first machine
 *     creates the remote project and pushes its whole backlog; another machine
 *     joins it only with an empty local backlog, matched by repo fingerprint or
 *     picked explicitly.
 *
 * Constructed only in a dev build; does nothing unless sync is enabled
 * (ConfigManager.isRemoteSyncEnabled) and a device is signed in.
 */
import { EventEmitter } from 'node:events';
import type { TaskChangeRouter } from '../../orchestrator/taskChangeRouter';
import { TASK_ALL_CHANNEL, taskChangeEvents } from '../../orchestrator/taskChangeRouter';
import type { DatabaseLike } from '../../orchestrator/types';
import type { TaskChangedEvent } from '../../../../shared/types/tasks';
import type {
  RemoteSyncEnableRequest,
  RemoteSyncEnableResult,
  RemoteSyncProjectChoices,
  RemoteSyncRemoteProject,
  RemoteSyncStatus,
} from '../../../../shared/types/remoteSync';
import type { RemoteProject } from '../../../../shared/types/remoteSyncWire';
import { runGitCapture } from '../../utils/runGit';
import { isStagingOrigin } from '../../../../shared/types/cloudOrigins';
import type { CloudAccountHandle, CloudDevice } from '../cloud/cloudAccountHandle';
import { computeBackoffMs } from '../cloud/backoff';
import { RemoteSyncEngine, type PassOutcome } from './engine';
import { fingerprintProject, localFingerprint, type GitRunner } from './fingerprint';
import { isSyncedEntityType } from './projection';
import { SyncHttpClient, SyncHttpError } from './syncHttpClient';
import { SyncStore } from './syncStore';

export const SYNC_TICK_MS = 60_000;
export const SYNC_DEBOUNCE_MS = 2_000;
export const SYNC_BACKOFF_BASE_MS = 5_000;
export const SYNC_BACKOFF_CAP_MS = 120_000;
export const CHECKSUM_EVERY_PASSES = 12;
/** The service's limit on a project name. */
const MAX_PROJECT_NAME = 200;

export interface RemoteSyncServiceDeps {
  db: DatabaseLike;
  router: TaskChangeRouter;
  configManager: { isRemoteSyncAvailable(): boolean; isRemoteSyncEnabled(): boolean; on(event: 'config-updated', l: () => void): unknown };
  /** null when the cloud module is not composed (it never is in a release build). */
  cloud: CloudAccountHandle | null;
  /** Where a server restore exports the local values it discards. */
  restoreExportDir?: string;
  /** Raise a human-visible, non-blocking finding. */
  fileFinding?: (projectId: number, title: string, body: string) => void;
  /** Report a sync failure as a code (never content). */
  reportError?: (code: string, tags: Record<string, string>) => void;
  /** Subscribe to wake triggers (system resume, window focus). Returns unsubscribe. */
  subscribeWake?: (cb: () => void) => () => void;
  logger?: { info(msg: string, meta?: unknown): void; warn(msg: string, meta?: unknown): void; error(msg: string, meta?: unknown): void };
  now?: () => number;
  /** Run git for the project fingerprint; defaults to the app's git. */
  git?: GitRunner;
  /** Test seam: build the HTTP client. */
  createClient?: (device: CloudDevice, cloud: CloudAccountHandle) => SyncHttpClient;
}

interface ProjectRuntime {
  running: Promise<void> | null;
  rerun: boolean;
  debounce: ReturnType<typeof setTimeout> | null;
  attempt: number;
  backoffUntil: number;
  okPasses: number;
  lastOutcome: PassOutcome['status'] | null;
}

export class RemoteSyncService extends EventEmitter {
  readonly store: SyncStore;
  private engine: RemoteSyncEngine | null = null;
  private client: SyncHttpClient | null = null;
  private readonly linking = new Set<number>();
  private engineDeviceId: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly runtimes = new Map<number, ProjectRuntime>();
  private readonly cleanups: Array<() => void> = [];
  private started = false;
  private readonly now: () => number;

  constructor(private readonly deps: RemoteSyncServiceDeps) {
    super();
    this.store = new SyncStore(deps.db);
    this.now = deps.now ?? (() => Date.now());
  }

  // ---- lifecycle -----------------------------------------------------------

  start(): void {
    if (this.started) return;
    this.started = true;
    const { cloud, configManager } = this.deps;
    const onTask = (event: TaskChangedEvent): void => this.handleTaskChanged(event);
    taskChangeEvents.on(TASK_ALL_CHANNEL, onTask);
    this.cleanups.push(() => taskChangeEvents.off(TASK_ALL_CHANNEL, onTask));

    if (cloud) {
      const reconcile = (): void => this.reconcileDevice();
      const onSignedIn = (): void => {
        this.reconcileDevice();
        void this.syncAll('signed_in');
      };
      cloud.on('signedIn', onSignedIn);
      cloud.on('signedOut', reconcile);
      cloud.on('revoked', reconcile);
      const onState = (): void => {
        this.reconcileDevice();
        if (this.canSync()) void this.syncAll('unlocked');
      };
      cloud.on('stateChanged', onState);
      this.cleanups.push(() => {
        cloud.off('signedIn', onSignedIn);
        cloud.off('signedOut', reconcile);
        cloud.off('revoked', reconcile);
        cloud.off('stateChanged', onState);
      });
      // Sign-out: best effort to push what is pending while the token still works.
      this.cleanups.push(cloud.onBeforeSignOut(() => this.flush()));
    }
    let lastEnabled = configManager.isRemoteSyncEnabled();
    configManager.on('config-updated', () => {
      const enabled = configManager.isRemoteSyncEnabled();
      if (enabled === lastEnabled) return;
      lastEnabled = enabled;
      this.reconcileDevice();
      if (enabled) void this.syncAll('enabled');
    });
    if (this.deps.subscribeWake) this.cleanups.push(this.deps.subscribeWake(() => void this.syncAll('wake')));

    this.timer = setInterval(() => void this.syncAll('tick'), SYNC_TICK_MS);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.reconcileDevice();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const rt of this.runtimes.values()) if (rt.debounce) clearTimeout(rt.debounce);
    for (const fn of this.cleanups.splice(0)) fn();
    this.started = false;
  }

  /** Resolves once no pass is running (quit, tests). */
  async idle(): Promise<void> {
    for (;;) {
      const running = [...this.runtimes.values()].map((rt) => rt.running).filter((p): p is Promise<void> => p !== null);
      if (running.length === 0) return;
      await Promise.allSettled(running);
    }
  }

  // ---- identity ------------------------------------------------------------

  /** Whether passes can run right now: enabled, signed in, token unlocked. */
  canSync(): boolean {
    const cloud = this.deps.cloud;
    return (
      this.deps.configManager.isRemoteSyncEnabled() &&
      cloud !== null &&
      cloud.getDevice() !== null &&
      cloud.getToken() !== null &&
      this.engine !== null
    );
  }

  /**
   * Mirror the signed-in device into remote_sync_device and (re)build the
   * engine for it. A different ACCOUNT unlinks every project (its remote ids
   * belong to another workspace; local data stays). A different DEVICE drops
   * any frozen batch: it was minted under the old device's dedupe key.
   */
  reconcileDevice(): void {
    const { cloud, configManager } = this.deps;
    const device = cloud?.getDevice() ?? null;
    const enabled = configManager.isRemoteSyncEnabled();
    const row = this.store.getDevice();
    if (!device) {
      if (row?.active) this.store.setDeviceActive(false);
      this.engine = null;
      this.client = null;
      this.engineDeviceId = null;
      this.emitChanged();
      return;
    }
    if (row && row.accountId !== device.accountId) {
      for (const p of this.store.listProjects()) {
        this.store.optOut(p.projectId);
        this.deps.fileFinding?.(
          p.projectId,
          'Sync turned off: signed in to a different account',
          'This computer signed in to a different cyboflow cloud account, so this project stopped syncing. Its local backlog is unchanged. Turn sync on again in Settings → Integrations → Sync.',
        );
      }
    } else if (row && row.deviceId !== device.deviceId) {
      for (const p of this.store.listProjects()) this.store.deleteBatch(p.projectId);
    }
    if (!row || row.accountId !== device.accountId || row.deviceId !== device.deviceId || row.deviceCode !== device.deviceCode || row.active !== enabled) {
      this.store.putDevice({ accountId: device.accountId, deviceId: device.deviceId, deviceCode: device.deviceCode, active: enabled });
    }
    if (enabled && cloud && this.engineDeviceId !== device.deviceId) {
      const client = this.deps.createClient
        ? this.deps.createClient(device, cloud)
        : new SyncHttpClient({ origin: device.origin, fetch: cloud.fetch, getToken: () => cloud.getToken(), appVersion: cloud.appVersion });
      this.client = client;
      this.engine = new RemoteSyncEngine({
        db: this.deps.db,
        router: this.deps.router,
        store: this.store,
        client,
        deviceId: device.deviceId,
        now: this.now,
        restoreExportDir: this.deps.restoreExportDir,
        onFinding: this.deps.fileFinding,
        logger: this.deps.logger,
      });
      this.engineDeviceId = device.deviceId;
    } else if (!enabled) {
      this.engine = null;
      this.client = null;
      this.engineDeviceId = null;
    }
    this.emitChanged();
  }

  /** The engine for passes and for project linking; null when sync cannot run. */
  getEngine(): RemoteSyncEngine | null {
    return this.canSync() ? this.engine : null;
  }

  // ---- triggers ------------------------------------------------------------

  private handleTaskChanged(event: TaskChangedEvent): void {
    try {
      if (event.actor === 'cyboflow-remote') return;
      if (event.task?.experiment_id) return;
      const project = this.store.getProject(event.projectId);
      if (!project?.remoteProjectId || !this.engine) return;
      const type = event.task?.type;
      if (event.action !== 'deleted' && type && isSyncedEntityType(type)) {
        this.engine.noteLocalChange(event.projectId, type, event.taskId);
      }
      this.armDebounce(event.projectId);
    } catch (err) {
      // Inline on a backlog write: a sync-side failure must never break it.
      this.deps.logger?.error('[remoteSync] change listener failed', { error: describe(err) });
    }
  }

  private armDebounce(projectId: number): void {
    const rt = this.runtime(projectId);
    if (rt.debounce) clearTimeout(rt.debounce);
    rt.debounce = setTimeout(() => {
      rt.debounce = null;
      void this.syncProject(projectId, 'write');
    }, SYNC_DEBOUNCE_MS);
    if (typeof rt.debounce.unref === 'function') rt.debounce.unref();
  }

  /** Sync every linked project (respecting each one's backoff unless `force`). */
  syncAll(trigger: string, opts: { force?: boolean } = {}): Promise<void> {
    if (!this.canSync()) return Promise.resolve();
    const runs = this.store
      .listProjects()
      .filter((p) => p.remoteProjectId)
      .map((p) => this.syncProject(p.projectId, trigger, opts));
    return Promise.all(runs).then(() => undefined);
  }

  /** "Sync now": ignores backoff. */
  syncNow(projectId?: number): Promise<void> {
    return projectId === undefined ? this.syncAll('manual', { force: true }) : this.syncProject(projectId, 'manual', { force: true });
  }

  /** Push what is pending (before sign-out). */
  flush(): Promise<void> {
    return this.syncAll('flush', { force: true });
  }

  /** One pass for a project, serialized per project. */
  syncProject(projectId: number, trigger: string, opts: { force?: boolean } = {}): Promise<void> {
    const rt = this.runtime(projectId);
    if (rt.running) {
      rt.rerun = true;
      return rt.running;
    }
    if (!opts.force && this.now() < rt.backoffUntil) return Promise.resolve();
    const engine = this.getEngine();
    if (!engine) return Promise.resolve();
    rt.running = (async () => {
      try {
        do {
          rt.rerun = false;
          const outcome = await engine.syncProject(projectId);
          await this.afterPass(projectId, engine, outcome, trigger);
        } while (rt.rerun && this.getEngine() === engine && this.now() >= rt.backoffUntil);
      } finally {
        rt.running = null;
        this.emitChanged();
      }
    })();
    this.emitChanged();
    return rt.running;
  }

  private async afterPass(projectId: number, engine: RemoteSyncEngine, outcome: PassOutcome, trigger: string): Promise<void> {
    const rt = this.runtime(projectId);
    rt.lastOutcome = outcome.status;
    if (outcome.status === 'ok') {
      rt.attempt = 0;
      rt.backoffUntil = 0;
      rt.okPasses += 1;
      if (rt.okPasses % CHECKSUM_EVERY_PASSES === 0) await this.runChecksum(projectId, engine);
      return;
    }
    if (outcome.status === 'skipped') return;
    if (outcome.status === 'paused') {
      if (outcome.reason === 'revoked') this.deps.cloud?.markRevoked('device_revoked');
      if (outcome.reason === 'not_entitled') this.deps.cloud?.requestAccountRefresh();
      this.deps.reportError?.(`paused_${outcome.reason}`, { projectId: String(projectId), trigger });
      return;
    }
    const err = outcome.error;
    if (err instanceof SyncHttpError) {
      if (err.kind === 'auth') {
        this.deps.cloud?.markRevoked('unauthorized');
        return;
      }
      if (err.kind === 'network' || err.kind === 'retryable') {
        rt.backoffUntil = this.now() + computeBackoffMs({
          attempt: rt.attempt,
          retryAfterMs: err.retryAfterMs,
          baseMs: SYNC_BACKOFF_BASE_MS,
          capMs: SYNC_BACKOFF_CAP_MS,
        });
        rt.attempt += 1;
        return;
      }
      this.deps.reportError?.(`http_${err.status}_${err.code}`, { projectId: String(projectId), trigger });
    } else {
      this.deps.reportError?.('pass_failed', { projectId: String(projectId), trigger });
    }
    // A terminal failure: back off like a transient one, so it is not hammered every 2 s.
    rt.backoffUntil = this.now() + computeBackoffMs({ attempt: rt.attempt, baseMs: SYNC_BACKOFF_BASE_MS, capMs: SYNC_BACKOFF_CAP_MS });
    rt.attempt += 1;
  }

  private async runChecksum(projectId: number, engine: RemoteSyncEngine): Promise<void> {
    try {
      const result = await engine.checksum(projectId);
      this.store.appendLog(projectId, `checksum: ${result}`);
      if (result === 'mismatch') this.deps.reportError?.('checksum_mismatch', { projectId: String(projectId) });
    } catch (err) {
      this.deps.logger?.warn('[remoteSync] checksum failed', { projectId, error: describe(err) });
    }
  }

  /** The user resumed after the "sync state went backwards" banner. */
  resumeAfterRewind(projectId: number): Promise<void> {
    this.engine?.resumeAfterRewind(projectId);
    return this.syncNow(projectId);
  }

  // ---- linking -------------------------------------------------------------

  /** What turning sync on for `projectId` can offer: its fingerprint and the remote projects to join. */
  async getProjectChoices(projectId: number): Promise<RemoteSyncProjectChoices> {
    const client = this.readyClient();
    if (!client) throw new Error('Sync is not ready: turn it on and sign in to cyboflow cloud first');
    const project = this.localProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);
    const fingerprint = await fingerprintProject(project.path, this.git());
    const available = this.unlinkedRemoteProjects(await this.listRemoteProjects(client), projectId);
    const matches = fingerprint ? available.filter((p) => p.fingerprint === fingerprint.wire) : [];
    return {
      projectId,
      fingerprint: fingerprint?.canonical ?? null,
      localItemCount: this.localItemCount(projectId),
      matches: matches.map(toChoice),
      others: available.filter((p) => !matches.includes(p)).map(toChoice),
    };
  }

  /**
   * Turn sync on for a project: create its remote project (the first machine;
   * the whole backlog pushes as creates) or join an existing one (local
   * backlog must be empty; the first pass pulls everything). The first pass
   * starts in the background; the status shows it.
   */
  async enableProject(req: RemoteSyncEnableRequest): Promise<RemoteSyncEnableResult> {
    const { projectId } = req;
    const client = this.readyClient();
    if (!client) return fail('not_ready', 'Sync is not ready: turn it on and sign in to cyboflow cloud first');
    const project = this.localProject(projectId);
    if (!project) return fail('not_found', `Project ${projectId} not found`);
    if (this.linking.has(projectId)) return fail('conflict', 'This project is already being linked');
    const existing = this.store.getProject(projectId)?.remoteProjectId ?? null;
    if (existing) {
      if (req.mode === 'join' && req.remoteProjectId !== existing) {
        return fail('conflict', 'This project already syncs with another remote project. Turn sync off for it first.');
      }
      return { ok: true, remoteProjectId: existing };
    }
    this.linking.add(projectId);
    try {
      let remoteProjectId: string;
      let fingerprint: string;
      if (req.mode === 'create') {
        fingerprint = (await fingerprintProject(project.path, this.git()))?.wire ?? localFingerprint();
        try {
          const created = await client.createProject({ name: project.name.slice(0, MAX_PROJECT_NAME), fingerprint });
          remoteProjectId = created.body.project.id;
        } catch (err) {
          const taken = existingProjectOf(err);
          if (taken) {
            return fail('exists', `“${taken.name}” already syncs this repository. Join it instead.`, toChoice(taken));
          }
          throw err;
        }
      } else {
        const count = this.localItemCount(projectId);
        if (count > 0) {
          return fail('not_empty', `This project already has ${count} backlog item${count === 1 ? '' : 's'}. For now, only a project with an empty backlog can join.`);
        }
        const remote = (await this.listRemoteProjects(client)).find((p) => p.id === req.remoteProjectId);
        if (!remote) return fail('not_found', 'That remote project no longer exists');
        if (this.linkedLocally(remote.id, projectId)) return fail('conflict', 'Another project on this computer already syncs with that remote project');
        remoteProjectId = remote.id;
        fingerprint = remote.fingerprint;
      }
      this.store.optIn(projectId, remoteProjectId, fingerprint);
      this.store.appendLog(projectId, req.mode === 'create' ? `created remote project ${remoteProjectId}` : `joined remote project ${remoteProjectId}`);
      this.emitChanged();
      void this.syncProject(projectId, req.mode === 'create' ? 'created' : 'joined', { force: true });
      return { ok: true, remoteProjectId };
    } catch (err) {
      this.handOffAuthFailure(err);
      return fail('failed', err instanceof SyncHttpError ? `${err.code}: ${err.message}` : describe(err));
    } finally {
      this.linking.delete(projectId);
    }
  }

  /**
   * Stop syncing a project on this machine. Its local backlog and the remote
   * project stay; only this machine's link and sync state go.
   */
  async disableProject(projectId: number): Promise<void> {
    const rt = this.runtimes.get(projectId);
    if (rt?.debounce) clearTimeout(rt.debounce);
    if (rt?.running) await rt.running;
    this.store.optOut(projectId);
    this.runtimes.delete(projectId);
    this.emitChanged();
  }

  private readyClient(): SyncHttpClient | null {
    return this.canSync() ? this.client : null;
  }

  private git(): GitRunner {
    return this.deps.git ?? (async (cwd, args) => (await runGitCapture(cwd, args)).stdout);
  }

  private async listRemoteProjects(client: SyncHttpClient): Promise<RemoteProject[]> {
    try {
      return (await client.listProjects()).body.projects;
    } catch (err) {
      this.handOffAuthFailure(err);
      throw err;
    }
  }

  private unlinkedRemoteProjects(remote: RemoteProject[], projectId: number): RemoteProject[] {
    return remote.filter((p) => !this.linkedLocally(p.id, projectId));
  }

  /** Another local project already syncs with `remoteProjectId`. */
  private linkedLocally(remoteProjectId: string, exceptProjectId: number): boolean {
    return this.store.listProjects().some((p) => p.remoteProjectId === remoteProjectId && p.projectId !== exceptProjectId);
  }

  private localProject(projectId: number): { name: string; path: string } | null {
    return (this.deps.db.prepare('SELECT name, path FROM projects WHERE id = ?').get(projectId) as { name: string; path: string } | undefined) ?? null;
  }

  /** Synced backlog rows (experiment arms never sync). */
  private localItemCount(projectId: number): number {
    const row = this.deps.db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM ideas WHERE project_id = ? AND experiment_id IS NULL)
              + (SELECT COUNT(*) FROM epics WHERE project_id = ? AND experiment_id IS NULL)
              + (SELECT COUNT(*) FROM tasks WHERE project_id = ? AND experiment_id IS NULL) AS n`,
      )
      .get(projectId, projectId, projectId) as { n: number };
    return row.n;
  }

  /** A dead token found outside a pass goes back to the cloud sign-in, like one found in a pass. */
  private handOffAuthFailure(err: unknown): void {
    if (!(err instanceof SyncHttpError)) return;
    if (err.kind === 'auth') this.deps.cloud?.markRevoked('unauthorized');
    else if (err.kind === 'revoked') this.deps.cloud?.markRevoked('device_revoked');
    else if (err.kind === 'not_entitled') this.deps.cloud?.requestAccountRefresh();
  }

  // ---- status --------------------------------------------------------------

  getStatus(): RemoteSyncStatus {
    const { configManager, cloud } = this.deps;
    if (!configManager.isRemoteSyncAvailable()) return { available: false };
    const device = cloud?.getDevice() ?? null;
    const projects = this.store.listProjects().map((p) => {
      const rt = this.runtimes.get(p.projectId);
      return {
        projectId: p.projectId,
        remoteProjectId: p.remoteProjectId,
        status: p.status,
        statusDetail: p.statusDetail,
        lastSyncAt: p.lastSyncAt,
        syncing: rt?.running !== null && rt?.running !== undefined,
        backoffUntil: rt && rt.backoffUntil > this.now() ? new Date(rt.backoffUntil).toISOString() : null,
        openConflicts: this.store.listOpenConflicts(p.projectId).length,
      };
    });
    return {
      available: true,
      enabled: configManager.isRemoteSyncEnabled(),
      cloudState: cloud?.getState() ?? 'signed_out',
      device: device ? { name: device.deviceName, code: device.deviceCode } : null,
      serverOrigin: device?.origin ?? null,
      staging: device ? isStagingOrigin(device.origin) : false,
      signedIn: device !== null,
      projects,
    };
  }

  private emitChanged(): void {
    this.emit('changed');
  }

  private runtime(projectId: number): ProjectRuntime {
    let rt = this.runtimes.get(projectId);
    if (!rt) {
      rt = { running: null, rerun: false, debounce: null, attempt: 0, backoffUntil: 0, okPasses: 0, lastOutcome: null };
      this.runtimes.set(projectId, rt);
    }
    return rt;
  }
}

function toChoice(p: RemoteProject): RemoteSyncRemoteProject {
  return { id: p.id, name: p.name, createdAt: p.createdAt };
}

function fail(reason: Exclude<RemoteSyncEnableResult, { ok: true }>['reason'], message: string, project?: RemoteSyncRemoteProject): RemoteSyncEnableResult {
  return project ? { ok: false, reason, message, project } : { ok: false, reason, message };
}

/** The remote project a `409 project_exists` names (the fingerprint is taken). */
function existingProjectOf(err: unknown): RemoteProject | null {
  if (!(err instanceof SyncHttpError) || err.status !== 409 || err.code !== 'project_exists') return null;
  const details = err.details as { project?: RemoteProject } | undefined;
  return details?.project && typeof details.project.id === 'string' ? details.project : null;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
