/**
 * Persistence for the global-agent chat thread (migration 074:
 * agent_threads / agent_thread_events / agent_proposals).
 *
 * This store is the ONLY writer for the three agent_* tables besides
 * AgentThreadEventsSink (a later task, append-only to agent_thread_events).
 * Proposal status transitions are guarded UPDATEs keyed on the CURRENT
 * status (a CAS state machine) so two concurrent confirms race safely — the
 * loser's UPDATE simply matches zero rows. The DatabaseLike dependency keeps
 * this module independent of Electron and better-sqlite3.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseLike } from '../types';
import type {
  AgentProposal,
  AgentProposalPayload,
  AgentProposalPreconditions,
  AgentProposalStatus,
  AgentThread,
  AgentThreadEvent,
  AgentThreadScope,
} from '../../../../shared/types/agentThread';

export type AgentThreadIdFactory = () => string;

interface ThreadRow {
  id: string;
  scope: AgentThreadScope;
  model: string | null;
  claude_session_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ThreadEventRow {
  id: number;
  thread_id: string;
  event_type: string;
  payload_json: string;
  created_at: string;
}

interface ProposalRow {
  id: string;
  thread_id: string;
  kind: string;
  payload_json: string;
  preconditions_json: string | null;
  status: AgentProposalStatus;
  result_json: string | null;
  idempotency_key: string | null;
  created_at: string;
  decided_at: string | null;
}

export class AgentThreadDbStore {
  constructor(
    private readonly db: DatabaseLike,
    private readonly createId: AgentThreadIdFactory = randomUUID,
  ) {}

  // -------------------------------------------------------------------------
  // Threads
  // -------------------------------------------------------------------------

  /** Insert a new thread and read it back so timestamps reflect the DB clock. */
  createThread(input?: { id?: string; scope?: AgentThreadScope; model?: string | null }): AgentThread {
    const id = input?.id ?? this.createId();
    this.db
      .prepare(
        `INSERT INTO agent_threads (id, scope, model)
         VALUES (?, ?, ?)`,
      )
      .run(id, input?.scope ?? 'global', input?.model ?? null);

    const thread = this.getThread(id);
    if (!thread) {
      throw new Error(`AgentThreadDbStore: failed to read back created thread ${id}`);
    }
    return thread;
  }

  getThread(id: string): AgentThread | null {
    const row = this.db
      .prepare(
        `SELECT id, scope, model, claude_session_id, created_at, updated_at
           FROM agent_threads
          WHERE id = ?`,
      )
      .get(id) as ThreadRow | undefined;
    return row ? this.toThread(row) : null;
  }

  /** Newest thread for a scope. Ties on created_at (second-granularity) break on id DESC. */
  findLatestThreadByScope(scope: AgentThreadScope): AgentThread | null {
    const row = this.db
      .prepare(
        `SELECT id, scope, model, claude_session_id, created_at, updated_at
           FROM agent_threads
          WHERE scope = ?
          ORDER BY created_at DESC, id DESC
          LIMIT 1`,
      )
      .get(scope) as ThreadRow | undefined;
    return row ? this.toThread(row) : null;
  }

  /** One-time-per-turn capture of the provider-owned warm-resume session id. */
  updateClaudeSessionId(threadId: string, claudeSessionId: string | null): boolean {
    const result = this.db
      .prepare(
        `UPDATE agent_threads
            SET claude_session_id = ?,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`,
      )
      .run(claudeSessionId, threadId);
    return result.changes === 1;
  }

  /**
   * Read the persisted auto-digest timestamp (epoch ms), or null if the thread
   * has never auto-digested (or does not exist). Backs the once-per-day throttle
   * across restarts (migration 076).
   */
  getLastDigestAt(threadId: string): number | null {
    const row = this.db
      .prepare(`SELECT last_digest_at FROM agent_threads WHERE id = ?`)
      .get(threadId) as { last_digest_at: number | null } | undefined;
    return row?.last_digest_at ?? null;
  }

  /** Stamp the auto-digest timestamp (epoch ms). No-op if the thread is gone. */
  setLastDigestAt(threadId: string, atMs: number): void {
    this.db
      .prepare(`UPDATE agent_threads SET last_digest_at = ? WHERE id = ?`)
      .run(atMs, threadId);
  }

  private toThread(row: ThreadRow): AgentThread {
    return {
      id: row.id,
      scope: row.scope,
      model: row.model,
      claudeSessionId: row.claude_session_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  /** Append one event, mirroring raw_events' shape but thread-keyed. */
  appendEvent(threadId: string, eventType: string, payloadJson: string): number {
    const result = this.db
      .prepare(
        `INSERT INTO agent_thread_events (thread_id, event_type, payload_json)
         VALUES (?, ?, ?)`,
      )
      .run(threadId, eventType, payloadJson);
    return Number(result.lastInsertRowid);
  }

  listEvents(threadId: string, opts?: { afterId?: number; limit?: number }): AgentThreadEvent[] {
    const clauses = ['thread_id = ?'];
    const params: unknown[] = [threadId];
    if (opts?.afterId !== undefined) {
      clauses.push('id > ?');
      params.push(opts.afterId);
    }
    let sql = `SELECT id, thread_id, event_type, payload_json, created_at
                 FROM agent_thread_events
                WHERE ${clauses.join(' AND ')}
                ORDER BY id ASC`;
    if (opts?.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(opts.limit);
    }
    const rows = this.db.prepare(sql).all(...params) as ThreadEventRow[];
    return rows.map((row) => this.toEvent(row));
  }

  private toEvent(row: ThreadEventRow): AgentThreadEvent {
    return {
      id: row.id,
      threadId: row.thread_id,
      eventType: row.event_type,
      payloadJson: row.payload_json,
      createdAt: row.created_at,
    };
  }

  // -------------------------------------------------------------------------
  // Proposals
  // -------------------------------------------------------------------------

  createProposal(input: {
    id?: string;
    threadId: string;
    payload: AgentProposalPayload;
    preconditions?: AgentProposalPreconditions | null;
  }): AgentProposal {
    const id = input.id ?? this.createId();
    this.db
      .prepare(
        `INSERT INTO agent_proposals (id, thread_id, kind, payload_json, preconditions_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.threadId,
        input.payload.kind,
        JSON.stringify(input.payload),
        input.preconditions ? JSON.stringify(input.preconditions) : null,
      );

    const proposal = this.getProposal(id);
    if (!proposal) {
      throw new Error(`AgentThreadDbStore: failed to read back created proposal ${id}`);
    }
    return proposal;
  }

  getProposal(id: string): AgentProposal | null {
    const row = this.db
      .prepare(
        `SELECT id, thread_id, kind, payload_json, preconditions_json, status,
                result_json, idempotency_key, created_at, decided_at
           FROM agent_proposals
          WHERE id = ?`,
      )
      .get(id) as ProposalRow | undefined;
    return row ? this.toProposal(row) : null;
  }

  listProposals(threadId: string, opts?: { statuses?: AgentProposalStatus[] }): AgentProposal[] {
    const clauses = ['thread_id = ?'];
    const params: unknown[] = [threadId];
    if (opts?.statuses && opts.statuses.length > 0) {
      clauses.push(`status IN (${opts.statuses.map(() => '?').join(', ')})`);
      params.push(...opts.statuses);
    }
    const rows = this.db
      .prepare(
        `SELECT id, thread_id, kind, payload_json, preconditions_json, status,
                result_json, idempotency_key, created_at, decided_at
           FROM agent_proposals
          WHERE ${clauses.join(' AND ')}
          ORDER BY created_at ASC, id ASC`,
      )
      .all(...params) as ProposalRow[];
    return rows.map((row) => this.toProposal(row));
  }

  /** Cross-thread lookup used for boot-time reconciliation of orphaned rows. */
  listProposalsByStatus(status: AgentProposalStatus): AgentProposal[] {
    const rows = this.db
      .prepare(
        `SELECT id, thread_id, kind, payload_json, preconditions_json, status,
                result_json, idempotency_key, created_at, decided_at
           FROM agent_proposals
          WHERE status = ?
          ORDER BY created_at ASC, id ASC`,
      )
      .all(status) as ProposalRow[];
    return rows.map((row) => this.toProposal(row));
  }

  /**
   * CAS-claim a proposed proposal for execution. This is THE double-confirm
   * race guard: exactly one caller's UPDATE matches the 'proposed' row and
   * stamps its idempotency key; the loser's UPDATE matches zero rows and
   * must not touch the winner's key.
   */
  claimProposal(id: string, idempotencyKey: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE agent_proposals
            SET status = 'executing',
                idempotency_key = ?
          WHERE id = ?
            AND status = 'proposed'`,
      )
      .run(idempotencyKey, id);
    return result.changes === 1;
  }

  /** Terminal transition out of 'executing' — the only status that can finalize. */
  finalizeProposal(id: string, status: 'executed' | 'failed', resultJson: string | null): boolean {
    const result = this.db
      .prepare(
        `UPDATE agent_proposals
            SET status = ?,
                result_json = ?,
                decided_at = CURRENT_TIMESTAMP
          WHERE id = ?
            AND status = 'executing'`,
      )
      .run(status, resultJson, id);
    return result.changes === 1;
  }

  /** Supersede a still-live proposal (proposed or executing) — e.g. a newer proposal replaces it. */
  supersedeProposal(id: string, resultJson?: string | null): boolean {
    const result = this.db
      .prepare(
        `UPDATE agent_proposals
            SET status = 'superseded',
                result_json = ?,
                decided_at = CURRENT_TIMESTAMP
          WHERE id = ?
            AND status IN ('proposed', 'executing')`,
      )
      .run(resultJson ?? null, id);
    return result.changes === 1;
  }

  /** Dismiss a still-proposed (not yet claimed) proposal. */
  dismissProposal(id: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE agent_proposals
            SET status = 'dismissed',
                decided_at = CURRENT_TIMESTAMP
          WHERE id = ?
            AND status = 'proposed'`,
      )
      .run(id);
    return result.changes === 1;
  }

  private toProposal(row: ProposalRow): AgentProposal {
    const payload = this.parseJson<AgentProposalPayload>(row.payload_json, row.id);
    return {
      id: row.id,
      threadId: row.thread_id,
      kind: payload.kind,
      payload,
      preconditions: row.preconditions_json
        ? this.parseJson<AgentProposalPreconditions>(row.preconditions_json, row.id)
        : null,
      status: row.status,
      result: row.result_json ? this.parseJson<unknown>(row.result_json, row.id) : null,
      idempotencyKey: row.idempotency_key,
      createdAt: row.created_at,
      decidedAt: row.decided_at,
    };
  }

  private parseJson<T>(raw: string, proposalId: string): T {
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new Error(`AgentThreadDbStore: corrupt JSON on proposal ${proposalId}`);
    }
  }
}
