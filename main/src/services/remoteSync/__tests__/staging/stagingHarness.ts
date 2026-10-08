/**
 * Two-machine harness against the STAGING cyboflow-sync service.
 *
 * The desktop depends on the service contract, not the server's code, so the
 * convergence scenarios run two real desktop databases (full migration chain,
 * their own router and engine) against the deployed staging Worker. Each test
 * gets a throwaway workspace from the staging-only `/__test/v1` hooks and
 * deletes it afterwards (a daily cron sweeps any leak).
 *
 * Opt-in: the suites skip unless CYBOFLOW_SYNC_STAGING_SECRET holds the
 * staging test-admin secret (CYBOFLOW_SYNC_STAGING_ORIGIN overrides the
 * origin). Faults are injected client-side through the FetchLike seam.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import { DatabaseService } from '../../../../database/database';
import { TaskChangeRouter, type TaskChange } from '../../../../orchestrator/taskChangeRouter';
import { dbAdapter } from '../../../../orchestrator/__test_fixtures__/dbAdapter';
import { REMOTE_SYNC_STAGING_ORIGIN } from '../../../../../../shared/types/remoteSync';
import { SYNC_PROTOCOL_HEADER } from '../../../../../../shared/types/remoteSyncWire';
import { RemoteSyncEngine, type PassOutcome } from '../../engine';
import { SyncHttpClient, type FetchLike } from '../../syncHttpClient';
import { SyncStore } from '../../syncStore';

export const STAGING_SECRET = process.env.CYBOFLOW_SYNC_STAGING_SECRET ?? '';
export const STAGING_ORIGIN = (process.env.CYBOFLOW_SYNC_STAGING_ORIGIN ?? REMOTE_SYNC_STAGING_ORIGIN).replace(/\/$/, '');
export const stagingEnabled = STAGING_SECRET.length > 0;

interface ProvisionedDevice {
  deviceId: string;
  code: string;
  name: string;
  token: string;
}

interface ProvisionedWorkspace {
  workspaceId: string;
  accountId: string;
  epoch: number;
  devices: ProvisionedDevice[];
}

async function hook<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${STAGING_ORIGIN}/__test/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${STAGING_SECRET}`,
      [SYNC_PROTOCOL_HEADER]: '1',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`test hook ${method} ${path} → ${res.status} ${text}`);
  return JSON.parse(text) as T;
}

/** A fault the next matching request suffers. */
export type Fault =
  /** The request never leaves (network down). */
  | { kind: 'fail_before'; match: RegExp }
  /** The server commits, then the response is lost (crash mid-push). */
  | { kind: 'drop_response'; match: RegExp };

/** A FetchLike over global fetch with a queue of one-shot faults and a request log. */
export class FaultyFetch {
  readonly faults: Fault[] = [];
  readonly log: Array<{ method: string; url: string; body: string | null; status: number | 'fault' }> = [];

  readonly fetch: FetchLike = (async (input: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : null;
    const i = this.faults.findIndex((f) => f.match.test(`${method} ${url}`));
    const fault = i >= 0 ? this.faults.splice(i, 1)[0] : undefined;
    if (fault?.kind === 'fail_before') {
      this.log.push({ method, url, body, status: 'fault' });
      throw new TypeError('fetch failed (injected)');
    }
    const res = await fetch(input, init);
    if (fault?.kind === 'drop_response') {
      await res.text();
      this.log.push({ method, url, body, status: 'fault' });
      throw new TypeError('socket hang up (injected)');
    }
    this.log.push({ method, url, body, status: res.status });
    return res;
  }) as FetchLike;

  pushes(): Array<{ batchId: string; ops: number }> {
    return this.log
      .filter((l) => l.method === 'POST' && /\/push$/.test(l.url) && l.body)
      .map((l) => {
        const req = JSON.parse(l.body as string) as { batchId: string; ops: unknown[] };
        return { batchId: req.batchId, ops: req.ops.length };
      });
  }
}

/** One desktop: its own data dir, DB, router, store, client and engine. */
export class Machine {
  readonly dir: string;
  readonly svc: DatabaseService;
  readonly db: Database.Database;
  readonly router: TaskChangeRouter;
  readonly store: SyncStore;
  readonly net = new FaultyFetch();
  readonly client: SyncHttpClient;
  readonly engine: RemoteSyncEngine;
  readonly projectId: number;
  private clockMs: number | null = null;

  constructor(readonly device: ProvisionedDevice, workspace: ProvisionedWorkspace) {
    this.dir = mkdtempSync(join(tmpdir(), `cyboflow-sync-${device.code.toLowerCase()}-`));
    this.svc = new DatabaseService(join(this.dir, 'sessions.db'));
    this.svc.initialize();
    this.db = this.svc.getDb();
    const adapter = dbAdapter(this.db);
    this.router = new TaskChangeRouter(adapter);
    this.store = new SyncStore(adapter);
    this.store.putDevice({ accountId: workspace.accountId, deviceId: device.deviceId, deviceCode: device.code, active: true });
    this.projectId = this.svc.createProject(`Project on ${device.name}`, join(this.dir, 'repo')).id;
    this.client = new SyncHttpClient({
      origin: STAGING_ORIGIN,
      fetch: this.net.fetch,
      getToken: () => device.token,
      appVersion: '0.0.0-harness',
    });
    this.engine = new RemoteSyncEngine({
      db: adapter,
      router: this.router,
      store: this.store,
      client: this.client,
      deviceId: device.deviceId,
      now: () => this.clockMs ?? Date.now(),
    });
  }

  /** Pin (or release, with null) this machine's wall clock. */
  setClock(ms: number | null): void {
    this.clockMs = ms;
  }

  link(remoteProjectId: string): void {
    this.store.optIn(this.projectId, remoteProjectId, null);
  }

  /** A local write, as a user makes it, followed by what the change listener does. */
  async edit(change: Omit<TaskChange, 'actor'> & { actor?: TaskChange['actor'] }): Promise<string> {
    const { taskId } = await this.router.applyChange(this.projectId, { actor: 'user', ...change });
    this.noteChange(taskId);
    return taskId;
  }

  /** What the TASK_ALL_CHANNEL listener does for a local write (the global emitter can't tell two test DBs apart). */
  noteChange(entityId: string): void {
    for (const type of ['idea', 'epic', 'task'] as const) {
      if (this.row(`${type}s` as 'ideas' | 'epics' | 'tasks', entityId)) {
        this.engine.noteLocalChange(this.projectId, type, entityId);
      }
    }
  }

  async sync(): Promise<PassOutcome> {
    return this.engine.syncProject(this.projectId);
  }

  stageId(position: number): string {
    return `stage-board-${this.projectId}-default-${position}`;
  }

  row(table: 'ideas' | 'epics' | 'tasks', id: string): Record<string, unknown> | undefined {
    return this.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  }

  version(table: 'ideas' | 'epics' | 'tasks', id: string): number {
    return (this.row(table, id)?.version as number | undefined) ?? 0;
  }

  close(): void {
    try {
      this.svc.close();
    } catch {
      // already closed
    }
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** A provisioned staging workspace with two machines whose projects are linked. */
export class TwoMachines {
  private constructor(
    readonly workspace: ProvisionedWorkspace,
    readonly a: Machine,
    readonly b: Machine,
    readonly remoteProjectId: string,
  ) {}

  static async create(): Promise<TwoMachines> {
    const workspace = await hook<ProvisionedWorkspace>('POST', '/workspaces', {
      devices: [
        { name: 'Machine A', code: 'AAA', platform: 'darwin', appVersion: '0.0.0-harness' },
        { name: 'Machine B', code: 'BBB', platform: 'darwin', appVersion: '0.0.0-harness' },
      ],
    });
    const a = new Machine(workspace.devices[0], workspace);
    const b = new Machine(workspace.devices[1], workspace);
    const fingerprint = `harness/${workspace.workspaceId}`;
    const created = await a.client.createProject({ name: 'Harness project', fingerprint });
    const remoteProjectId = created.body.project.id;
    a.link(remoteProjectId);
    b.link(remoteProjectId);
    return new TwoMachines(workspace, a, b, remoteProjectId);
  }

  /** Sync both machines until a full round changes nothing (bounded). */
  async settle(rounds = 4): Promise<void> {
    for (let i = 0; i < rounds; i += 1) {
      const ra = await this.a.sync();
      const rb = await this.b.sync();
      for (const r of [ra, rb]) {
        if (r.status !== 'ok') throw new Error(`sync did not succeed: ${JSON.stringify(r)}`);
      }
      if (ra.status === 'ok' && rb.status === 'ok' && ra.pushed + rb.pushed + ra.pulled + rb.pulled === 0) return;
    }
  }

  async bumpEpoch(): Promise<number> {
    return (await hook<{ epoch: number }>('POST', `/workspaces/${this.workspace.workspaceId}/epoch`)).epoch;
  }

  async dispose(): Promise<void> {
    this.a.close();
    this.b.close();
    try {
      await hook('DELETE', `/workspaces/${this.workspace.workspaceId}`);
    } catch {
      // 404 on repeat / retryable 500: the staging cron sweeps leftovers.
    }
  }
}
