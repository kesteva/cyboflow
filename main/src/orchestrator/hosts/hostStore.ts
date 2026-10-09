/**
 * HostStore — the SOLE writer of the Environments tables (migration 152: hosts, host_project_checkouts)
 * and of projects.default_host_id. Enforced by hostsSoleWriter.test.ts.
 *
 * Shape (template: PersistentAgentStore): one PQueue({concurrency: 1}) orders writes; each write is ONE
 * synchronous better-sqlite3 transaction; events go out on hostEvents only AFTER the transaction returned
 * (a throwing transaction emits nothing). Reads are synchronous and unqueued.
 *
 * Timestamps are written as Date#toISOString() — never datetime('now').
 */
import { randomUUID } from 'node:crypto';
import PQueue from 'p-queue';
import type { DatabaseLike, LoggerLike, PreparedStatement } from '../types';
import { emitHostsChanged } from '../hostsBridge';
import {
  CAPABILITY_TIERS,
  HOST_KINDS,
  HOST_LABEL_MAX,
  LIFECYCLE_STATES,
  SSH_TARGET_RE,
  type CapabilityTier,
  type HostKind,
  type HostsChangedEvent,
  type LifecycleState,
  type PreflightResult,
  type SshHostConfig,
} from '../../../../shared/types/hosts';
import { TERMINAL_RUN_STATUSES_SQL_IN } from '../../../../shared/types/cyboflow';
import {
  HostHasActiveWorkError,
  HostLabelTakenError,
  HostNotFoundError,
  InvalidHostLabelError,
  InvalidSshTargetError,
  LocalHostImmutableError,
} from './errors';
import { clampUserCap } from './tierRule';

export const LOCAL_HOST_ID = 'local';
// eslint-disable-next-line no-control-regex
const LABEL_CONTROL_RE = /[\u0000-\u001F\u007F]/;

export interface HostRow {
  id: string;
  label: string;
  kind: HostKind;
  sshTarget: string | null;
  remoteRoot: string | null;
  arch: string | null;
  osVersion: string | null;
  toolchainHash: string | null;
  detectedTier: CapabilityTier | null;
  userCapTier: CapabilityTier | null;
  preflight: PreflightResult | null;
  preflightAt: string | null;
  preflightAppVersion: string | null;
  lifecycleState: LifecycleState | null;
  lastSeenAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RawHostRow {
  id: string;
  label: string;
  kind: string;
  config_json: string;
  arch: string | null;
  os_version: string | null;
  toolchain_hash: string | null;
  detected_tier: string | null;
  user_cap_tier: string | null;
  preflight_json: string | null;
  preflight_at: string | null;
  preflight_app_version: string | null;
  lifecycle_state: string | null;
  last_seen_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface HostStoreOptions {
  now?: () => Date;
  newId?: () => string;
  logger?: LoggerLike;
}

export interface ActiveWork {
  sessions: number;
  runs: number;
}

function oneOf<T extends string>(list: readonly T[], v: string | null): T | null {
  return v !== null && (list as readonly string[]).includes(v) ? (v as T) : null;
}

function parseConfig(json: string): Partial<SshHostConfig> {
  try {
    const v: unknown = JSON.parse(json);
    if (typeof v !== 'object' || v === null) return {};
    const o = v as Record<string, unknown>;
    return {
      ...(typeof o.sshTarget === 'string' ? { sshTarget: o.sshTarget } : {}),
      ...(typeof o.remoteRoot === 'string' ? { remoteRoot: o.remoteRoot } : {}),
    };
  } catch {
    return {};
  }
}

function parsePreflight(json: string | null): PreflightResult | null {
  if (json === null) return null;
  try {
    const v: unknown = JSON.parse(json);
    return typeof v === 'object' && v !== null ? (v as PreflightResult) : null;
  } catch {
    return null;
  }
}

function toRow(r: RawHostRow): HostRow {
  const cfg = parseConfig(r.config_json);
  return {
    id: r.id,
    label: r.label,
    kind: oneOf(HOST_KINDS, r.kind) ?? 'local',
    sshTarget: cfg.sshTarget ?? null,
    remoteRoot: cfg.remoteRoot ?? null,
    arch: r.arch,
    osVersion: r.os_version,
    toolchainHash: r.toolchain_hash,
    detectedTier: oneOf(CAPABILITY_TIERS, r.detected_tier),
    userCapTier: oneOf(CAPABILITY_TIERS, r.user_cap_tier),
    preflight: parsePreflight(r.preflight_json),
    preflightAt: r.preflight_at,
    preflightAppVersion: r.preflight_app_version,
    lifecycleState: oneOf(LIFECYCLE_STATES, r.lifecycle_state),
    lastSeenAt: r.last_seen_at,
    archivedAt: r.archived_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Trim and validate a label; throws InvalidHostLabelError. */
export function normalizeLabel(raw: string): string {
  const label = raw.trim();
  if (label.length < 1 || label.length > HOST_LABEL_MAX || LABEL_CONTROL_RE.test(label)) {
    throw new InvalidHostLabelError();
  }
  return label;
}

export function assertSshTarget(target: string): void {
  if (!SSH_TARGET_RE.test(target)) throw new InvalidSshTargetError();
}

interface Done<T> {
  result: T;
  emits: HostsChangedEvent[];
}

export class HostStore {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly logger: LoggerLike | undefined;
  private readonly queue = new PQueue({ concurrency: 1 });
  private readonly stmts = new Map<string, PreparedStatement>();

  constructor(private readonly db: DatabaseLike, opts: HostStoreOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    this.newId = opts.newId ?? (() => randomUUID());
    this.logger = opts.logger;
  }

  /** Test seam for `.onIdle()`. */
  _queue(): PQueue {
    return this.queue;
  }

  private stmt(sql: string): PreparedStatement {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  private iso(): string {
    return this.now().toISOString();
  }

  private write<T>(fn: () => Done<T>): Promise<T> {
    return this.queue.add(() => {
      const txn = this.db.transaction(fn);
      const done = (txn as () => Done<T>)();
      for (const ev of done.emits) {
        try {
          emitHostsChanged(ev);
        } catch (err) {
          this.logger?.warn('[hosts] change listener threw', { error: err instanceof Error ? err.name : 'unknown' });
        }
      }
      return done.result;
    }) as Promise<T>;
  }

  // ------------------------------------------------------------------ reads

  list(opts: { includeArchived?: boolean } = {}): HostRow[] {
    const sql = opts.includeArchived
      ? 'SELECT * FROM hosts ORDER BY (id = \'local\') DESC, created_at ASC, id ASC'
      : 'SELECT * FROM hosts WHERE archived_at IS NULL ORDER BY (id = \'local\') DESC, created_at ASC, id ASC';
    return (this.stmt(sql).all() as RawHostRow[]).map(toRow);
  }

  get(id: string): HostRow | null {
    const r = this.stmt('SELECT * FROM hosts WHERE id = ?').get(id) as RawHostRow | undefined;
    return r ? toRow(r) : null;
  }

  activeWork(id: string): ActiveWork {
    const isLocal = id === LOCAL_HOST_ID;
    const hostClause = isLocal ? "(host_id IS NULL OR host_id = 'local')" : 'host_id = ?';
    const params = isLocal ? [] : [id];
    const s = this.stmt(
      `SELECT COUNT(*) AS n FROM sessions WHERE ${hostClause} AND status IN ('pending','running')`,
    ).get(...params) as { n: number };
    const r = this.stmt(
      `SELECT COUNT(*) AS n FROM workflow_runs WHERE ${hostClause} AND status NOT IN ${TERMINAL_RUN_STATUSES_SQL_IN}`,
    ).get(...params) as { n: number };
    return { sessions: s.n, runs: r.n };
  }

  projectDefault(projectId: number): string | null {
    const r = this.stmt('SELECT default_host_id AS h FROM projects WHERE id = ?').get(projectId) as
      | { h: string | null }
      | undefined;
    return r?.h ?? null;
  }

  // ----------------------------------------------------------------- writes

  private requireLive(id: string): HostRow {
    const row = this.get(id);
    if (!row || row.archivedAt !== null) throw new HostNotFoundError();
    return row;
  }

  private assertLabelFree(label: string, exceptId?: string): void {
    const clash = this.stmt('SELECT id FROM hosts WHERE label = ? AND archived_at IS NULL').get(label) as
      | { id: string }
      | undefined;
    if (clash && clash.id !== exceptId) throw new HostLabelTakenError();
  }

  async addSsh(input: { label: string; sshTarget: string }): Promise<string> {
    const label = normalizeLabel(input.label);
    assertSshTarget(input.sshTarget);
    const id = this.newId();
    return this.write(() => {
      this.assertLabelFree(label);
      const at = this.iso();
      const cfg: SshHostConfig = { sshTarget: input.sshTarget, remoteRoot: `~/cf-remote/${id}` };
      this.stmt(
        `INSERT INTO hosts (id, label, kind, config_json, created_at, updated_at) VALUES (?, ?, 'ssh', ?, ?, ?)`,
      ).run(id, label, JSON.stringify(cfg), at, at);
      return { result: id, emits: [{ kind: 'hosts', hostId: id }] };
    });
  }

  async update(id: string, patch: { label?: string; sshTarget?: string }): Promise<void> {
    const label = patch.label !== undefined ? normalizeLabel(patch.label) : undefined;
    if (patch.sshTarget !== undefined) assertSshTarget(patch.sshTarget);
    return this.write(() => {
      const row = this.requireLive(id);
      if (row.kind === 'local') throw new LocalHostImmutableError();
      const at = this.iso();
      if (label !== undefined && label !== row.label) {
        this.assertLabelFree(label, id);
        this.stmt('UPDATE hosts SET label = ?, updated_at = ? WHERE id = ?').run(label, at, id);
      }
      if (patch.sshTarget !== undefined && patch.sshTarget !== row.sshTarget) {
        const cfg: SshHostConfig = { sshTarget: patch.sshTarget, remoteRoot: row.remoteRoot ?? `~/cf-remote/${id}` };
        this.stmt(
          `UPDATE hosts SET config_json = ?, detected_tier = NULL, preflight_json = NULL, preflight_at = NULL,
             preflight_app_version = NULL, arch = NULL, os_version = NULL, toolchain_hash = NULL,
             lifecycle_state = NULL, updated_at = ? WHERE id = ?`,
        ).run(JSON.stringify(cfg), at, id);
      }
      return { result: undefined, emits: [{ kind: 'hosts', hostId: id }] };
    });
  }

  async setUserCap(id: string, cap: CapabilityTier | null): Promise<void> {
    return this.write(() => {
      const row = this.requireLive(id);
      const next = clampUserCap(row.detectedTier, cap);
      this.stmt('UPDATE hosts SET user_cap_tier = ?, updated_at = ? WHERE id = ?').run(next, this.iso(), id);
      return { result: undefined, emits: [{ kind: 'hosts', hostId: id }] };
    });
  }

  async recordPreflight(id: string, result: PreflightResult): Promise<void> {
    return this.write(() => {
      this.requireLive(id);
      const at = this.iso();
      if (result.reachable) {
        this.stmt(
          `UPDATE hosts SET preflight_json = ?, preflight_at = ?, preflight_app_version = ?, detected_tier = ?,
             arch = ?, os_version = ?, toolchain_hash = ?, lifecycle_state = 'online', last_seen_at = ?, updated_at = ?
           WHERE id = ?`,
        ).run(
          JSON.stringify(result), result.finishedAt, result.appVersion, result.detectedTier,
          result.arch, result.osVersion, result.toolchainHash, at, at, id,
        );
      } else {
        // Unreachable is lifecycle, not capability: keep the last reachable result and detected tier.
        this.stmt(`UPDATE hosts SET lifecycle_state = 'unreachable', updated_at = ? WHERE id = ?`).run(at, id);
      }
      return { result: undefined, emits: [{ kind: 'hosts', hostId: id }] };
    });
  }

  async archive(id: string): Promise<void> {
    return this.write(() => {
      const row = this.requireLive(id);
      if (row.kind === 'local') throw new LocalHostImmutableError();
      const work = this.activeWork(id);
      if (work.sessions > 0 || work.runs > 0) throw new HostHasActiveWorkError();
      const at = this.iso();
      this.stmt('UPDATE hosts SET archived_at = ?, updated_at = ? WHERE id = ?').run(at, at, id);
      this.stmt('UPDATE projects SET default_host_id = NULL WHERE default_host_id = ?').run(id);
      return { result: undefined, emits: [{ kind: 'hosts', hostId: id }] };
    });
  }

  async setProjectDefault(projectId: number, hostId: string | null): Promise<void> {
    return this.write(() => {
      if (hostId !== null) this.requireLive(hostId);
      this.stmt('UPDATE projects SET default_host_id = ? WHERE id = ?').run(hostId, projectId);
      return { result: undefined, emits: [{ kind: 'hosts' }] };
    });
  }
}
