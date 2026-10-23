/**
 * MergeBackStore — the SOLE writer of session_merge_backs (migration 153; enforced by
 * mergeBackSoleWriter.test.ts). Same shape as HostStore: one PQueue({concurrency: 1}), one synchronous
 * transaction per write, change callbacks fire only AFTER the transaction returned. Reads are synchronous.
 * Timestamps are Date#toISOString().
 */
import PQueue from 'p-queue';
import type { DatabaseLike, LoggerLike, PreparedStatement } from '../types';
import { canTransition, isMergeBackState, type MergeBackState } from './mergeBackState';

export class MergeBackStateConflictError extends Error {
  constructor(
    readonly sessionId: string,
    readonly actual: MergeBackState | null,
    readonly expected: readonly MergeBackState[],
  ) {
    super(`Merge-back state conflict: expected one of [${expected.join(', ')}], found ${actual ?? 'no row'}.`);
    this.name = 'MergeBackStateConflictError';
  }
}

export class InvalidMergeBackTransitionError extends Error {
  constructor(readonly from: MergeBackState, readonly to: MergeBackState) {
    super(`Invalid merge-back transition ${from} -> ${to}.`);
    this.name = 'InvalidMergeBackTransitionError';
  }
}

export interface MergeBackRow {
  sessionId: string;
  hostId: string;
  projectId: number;
  mergeKey: string;
  branch: string;
  remoteWorktreePath: string | null;
  state: MergeBackState;
  baseSha: string | null;
  importSha: string | null;
  checkpointSha: string | null;
  localWorktreePath: string | null;
  /** The local main the last merge landed on (stamped with `merged`). */
  mergedSha: string | null;
  /** When the last `merged` was recorded (ISO). */
  mergedAt: string | null;
  /** When that merge's run / lane close-out completed (ISO); null = not (yet) recorded. */
  closedOutAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMergeBackInput {
  sessionId: string;
  hostId: string;
  projectId: number;
  mergeKey: string;
  branch: string;
  remoteWorktreePath?: string | null;
  baseSha?: string | null;
  state: MergeBackState;
}

export interface MergeBackPatch {
  remoteWorktreePath?: string | null;
  baseSha?: string | null;
  importSha?: string | null;
  checkpointSha?: string | null;
  localWorktreePath?: string | null;
  mergedSha?: string | null;
  mergedAt?: string | null;
  closedOutAt?: string | null;
  lastError?: string | null;
}

export interface MergeBackChange {
  sessionId: string;
  hostId: string;
  state: MergeBackState;
  previous: MergeBackState | null;
}

interface RawRow {
  session_id: string;
  host_id: string;
  project_id: number;
  merge_key: string;
  branch: string;
  remote_worktree_path: string | null;
  state: string;
  base_sha: string | null;
  import_sha: string | null;
  checkpoint_sha: string | null;
  local_worktree_path: string | null;
  merged_sha?: string | null;
  merged_at?: string | null;
  closed_out_at?: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

const PATCH_COLUMNS: Record<keyof MergeBackPatch, string> = {
  remoteWorktreePath: 'remote_worktree_path',
  baseSha: 'base_sha',
  importSha: 'import_sha',
  checkpointSha: 'checkpoint_sha',
  localWorktreePath: 'local_worktree_path',
  mergedSha: 'merged_sha',
  mergedAt: 'merged_at',
  closedOutAt: 'closed_out_at',
  lastError: 'last_error',
};

function toRow(r: RawRow): MergeBackRow {
  if (!isMergeBackState(r.state)) throw new Error(`session_merge_backs holds unknown state '${r.state}'`);
  return {
    sessionId: r.session_id,
    hostId: r.host_id,
    projectId: r.project_id,
    mergeKey: r.merge_key,
    branch: r.branch,
    remoteWorktreePath: r.remote_worktree_path,
    state: r.state,
    baseSha: r.base_sha,
    importSha: r.import_sha,
    checkpointSha: r.checkpoint_sha,
    localWorktreePath: r.local_worktree_path,
    mergedSha: r.merged_sha ?? null,
    mergedAt: r.merged_at ?? null,
    closedOutAt: r.closed_out_at ?? null,
    lastError: r.last_error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface MergeBackStoreOptions {
  now?: () => Date;
  logger?: LoggerLike;
  /** Called after each committed write. A throwing listener is logged and swallowed. */
  onChange?: (change: MergeBackChange) => void;
}

export class MergeBackStore {
  private readonly now: () => Date;
  private readonly logger: LoggerLike | undefined;
  private readonly onChange: ((change: MergeBackChange) => void) | undefined;
  private readonly queue = new PQueue({ concurrency: 1 });
  private readonly stmts = new Map<string, PreparedStatement>();

  constructor(private readonly db: DatabaseLike, opts: MergeBackStoreOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    this.logger = opts.logger;
    this.onChange = opts.onChange;
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

  private write<T>(fn: () => { result: T; change: MergeBackChange | null }): Promise<T> {
    return this.queue.add(() => {
      const txn = this.db.transaction(fn) as () => { result: T; change: MergeBackChange | null };
      const done = txn();
      try {
        if (done.change) this.onChange?.(done.change);
      } catch (err) {
        this.logger?.warn('[hosts] merge-back change listener threw', { error: err instanceof Error ? err.name : 'unknown' });
      }
      return done.result;
    }) as Promise<T>;
  }

  // ------------------------------------------------------------------ reads

  get(sessionId: string): MergeBackRow | null {
    const r = this.stmt('SELECT * FROM session_merge_backs WHERE session_id = ?').get(sessionId) as RawRow | undefined;
    return r ? toRow(r) : null;
  }

  listByState(states: readonly MergeBackState[]): MergeBackRow[] {
    if (states.length === 0) return [];
    const marks = states.map(() => '?').join(', ');
    const rows = this.stmt(
      `SELECT * FROM session_merge_backs WHERE state IN (${marks}) ORDER BY created_at ASC, session_id ASC`,
    ).all(...states) as RawRow[];
    return rows.map(toRow);
  }

  listForHost(hostId: string): MergeBackRow[] {
    const rows = this.stmt(
      'SELECT * FROM session_merge_backs WHERE host_id = ? ORDER BY created_at ASC, session_id ASC',
    ).all(hostId) as RawRow[];
    return rows.map(toRow);
  }

  // ----------------------------------------------------------------- writes

  create(input: CreateMergeBackInput): Promise<MergeBackRow> {
    return this.write(() => {
      if (!isMergeBackState(input.state)) throw new Error(`Unknown merge-back state '${String(input.state)}'`);
      const ts = this.now().toISOString();
      this.stmt(
        `INSERT INTO session_merge_backs
           (session_id, host_id, project_id, merge_key, branch, remote_worktree_path, state, base_sha, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.sessionId,
        input.hostId,
        input.projectId,
        input.mergeKey,
        input.branch,
        input.remoteWorktreePath ?? null,
        input.state,
        input.baseSha ?? null,
        ts,
        ts,
      );
      const row = this.get(input.sessionId) as MergeBackRow;
      return {
        result: row,
        change: { sessionId: row.sessionId, hostId: row.hostId, state: row.state, previous: null },
      };
    });
  }

  /** Compare-and-set: moves to `to` only when the stored state is in `from` and the edge is allowed. */
  transition(
    sessionId: string,
    opts: { from: readonly MergeBackState[]; to: MergeBackState; patch?: MergeBackPatch },
  ): Promise<MergeBackRow> {
    return this.write(() => {
      const cur = this.get(sessionId);
      if (!cur || !opts.from.includes(cur.state)) {
        throw new MergeBackStateConflictError(sessionId, cur ? cur.state : null, opts.from);
      }
      if (!canTransition(cur.state, opts.to)) throw new InvalidMergeBackTransitionError(cur.state, opts.to);
      const ts = this.now().toISOString();
      const sets = ['state = ?', 'updated_at = ?'];
      const params: unknown[] = [opts.to, ts];
      // Entering `merged` records WHEN in the same write, and opens a fresh close-out (stamped by markClosedOut).
      const patch: MergeBackPatch = opts.to === 'merged' ? { mergedAt: ts, closedOutAt: null, ...opts.patch } : { ...opts.patch };
      for (const key of Object.keys(PATCH_COLUMNS) as Array<keyof MergeBackPatch>) {
        const v = patch[key];
        if (v !== undefined) {
          sets.push(`${PATCH_COLUMNS[key]} = ?`);
          params.push(v);
        }
      }
      const res = this.stmt(
        // Re-assert the expected state in the WHERE so the CAS holds even if the read above were stale.
        `UPDATE session_merge_backs SET ${sets.join(', ')} WHERE session_id = ? AND state = ?`,
      ).run(...params, sessionId, cur.state);
      if (res.changes !== 1) throw new MergeBackStateConflictError(sessionId, null, opts.from);
      const row = this.get(sessionId) as MergeBackRow;
      return {
        result: row,
        change: { sessionId, hostId: row.hostId, state: row.state, previous: cur.state },
      };
    });
  }

  /**
   * Records that the close-out of the last merge completed (closed_out_at := now) without touching state. A no-op
   * (null) for a row that never merged or already carries the stamp.
   */
  markClosedOut(sessionId: string): Promise<MergeBackRow | null> {
    return this.write(() => {
      const cur = this.get(sessionId);
      if (!cur || cur.mergedAt === null || cur.closedOutAt !== null) return { result: null, change: null };
      const ts = this.now().toISOString();
      this.stmt(
        'UPDATE session_merge_backs SET closed_out_at = ?, updated_at = ? WHERE session_id = ? AND closed_out_at IS NULL',
      ).run(ts, ts, sessionId);
      const row = this.get(sessionId) as MergeBackRow;
      return { result: row, change: { sessionId, hostId: row.hostId, state: row.state, previous: row.state } };
    });
  }

  /** Records (or clears) last_error without touching state. */
  setError(sessionId: string, message: string | null): Promise<MergeBackRow | null> {
    return this.write(() => {
      const cur = this.get(sessionId);
      if (!cur) {
        return { result: null, change: null };
      }
      this.stmt('UPDATE session_merge_backs SET last_error = ?, updated_at = ? WHERE session_id = ?').run(
        message,
        this.now().toISOString(),
        sessionId,
      );
      const row = this.get(sessionId) as MergeBackRow;
      return { result: row, change: { sessionId, hostId: row.hostId, state: row.state, previous: row.state } };
    });
  }
}
