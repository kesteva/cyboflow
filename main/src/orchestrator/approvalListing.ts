/**
 * approvalListing — shared SELECT JOIN helper for pending approvals.
 *
 * Exports `selectPendingApprovals(db)` so the tRPC listPending procedure and
 * bridge parity tests share a single implementation of the query.  Previously
 * the tRPC router inlined this SQL and the bridge test duplicated it verbatim,
 * causing silent drift whenever the schema or projection changed.
 *
 * Standalone-typecheck invariant: NO imports from 'electron', 'better-sqlite3',
 * or main/src/services/*. Only narrow interfaces and shared utilities.
 */
import { providerForRuntimeValue } from '../../../shared/types/agentRuntime';
import type { Approval } from '../../../shared/types/approvals';
import { truncatePayloadPreview } from '../../../shared/utils/approvals';
import type { DatabaseLike } from './types';

// ---------------------------------------------------------------------------
// Internal DB row shape for the SELECT JOIN below
// ---------------------------------------------------------------------------

interface DbApprovalRow {
  id: string;
  runId: string;
  workflowName: string;
  toolName: string;
  payloadPreviewRaw: string;
  rationale: string | null;
  createdAt: string;
  status: string;
  /**
   * SQLite has no boolean: the column is INTEGER 0/1. Typed as number here so
   * the coercion to `Approval.awaited` happens in exactly one place below.
   */
  awaited: number;
  /** `sessions.name` via LEFT JOIN; null when the join was not made or the row is gone. */
  sessionName: string | null;
  /** `sessions.worktree_name` via the same LEFT JOIN; null on the same conditions. */
  worktreeName: string | null;
  /** `workflow_runs.agent_runtime`; null when the column is absent on an old schema. */
  agentRuntime: string | null;
}

/**
 * WeakMap-cached `PRAGMA table_info` probe, mirroring `taskListing.ts`'s.
 *
 * The attribution JOIN is OPTIONAL for a real reason, not just old-schema
 * politeness: `sessions` is legacy (declared in schema.sql, not a numbered
 * migration) and the narrow gate fixtures that exercise this query build only
 * `approvals` + `workflow_runs` + `workflows`. An unconditional join would turn
 * every one of those into a SQL error, so the columns are probed and the join
 * is added only when it can succeed. Fail-soft: a PRAGMA error reads back
 * absent, and the caller simply gets nulls.
 */
const columnExistsCache = new WeakMap<DatabaseLike, Map<string, boolean>>();

function columnExists(db: DatabaseLike, table: string, column: string): boolean {
  let cache = columnExistsCache.get(db);
  if (!cache) {
    cache = new Map();
    columnExistsCache.set(db, cache);
  }
  const key = `${table}.${column}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  let present = false;
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
    present = rows.some((r) => r.name === column);
  } catch {
    present = false;
  }
  cache.set(key, present);
  return present;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** The identity half of an {@link Approval}: who is asking. */
export interface ApprovalAttribution {
  sessionName: string | null;
  worktreeName: string | null;
  agentProvider: string | null;
}

/** The all-null attribution every degradation path returns. */
const EMPTY_ATTRIBUTION: ApprovalAttribution = {
  sessionName: null,
  worktreeName: null,
  agentProvider: null,
};

/**
 * Coerce one run's raw session name + runtime into the shape the UI reads.
 *
 * The single place the rule lives. `selectPendingApprovals` gets these columns
 * from its own JOIN (one query for the whole queue) while
 * `buildApprovalCreatedEvent` looks up a single run, and the two projecting the
 * same row differently is precisely the drift this centralizes away.
 */
export function toApprovalAttribution(
  sessionName: unknown,
  agentRuntime: unknown,
  worktreeName: unknown = null,
): ApprovalAttribution {
  return {
    sessionName:
      typeof sessionName === 'string' && sessionName.length > 0 ? sessionName : null,
    // Same empty-string-is-absent rule as the name: a session row can carry ''
    // for a worktree it never got, and rendering a bare ⌥ is worse than nothing.
    worktreeName:
      typeof worktreeName === 'string' && worktreeName.length > 0 ? worktreeName : null,
    // A NULL runtime floors to the Claude default inside providerForRuntimeValue,
    // which would be a guess rather than a reading — so it stays null here and
    // the UI shows no provider at all.
    agentProvider:
      typeof agentRuntime === 'string' && agentRuntime.length > 0
        ? providerForRuntimeValue(agentRuntime, 'toApprovalAttribution')
        : null,
  };
}

/**
 * Read one run's attribution, degrading to nulls on any schema or lookup
 * failure. Used by the created-event bridge, which has a run id rather than a
 * queue-wide JOIN.
 */
export function selectApprovalAttribution(db: DatabaseLike, runId: string): ApprovalAttribution {
  const hasSession =
    columnExists(db, 'workflow_runs', 'session_id') && columnExists(db, 'sessions', 'name');
  // Probed independently of `name`: a fixture (or an old schema) can have one
  // without the other, and the join must degrade per-column rather than all-or-
  // nothing.
  const hasWorktree = hasSession && columnExists(db, 'sessions', 'worktree_name');
  const hasRuntime = columnExists(db, 'workflow_runs', 'agent_runtime');
  if (!hasSession && !hasRuntime) return EMPTY_ATTRIBUTION;

  try {
    const row = db
      .prepare(
        `SELECT
           ${hasSession ? 's.name' : 'NULL'} AS sessionName,
           ${hasWorktree ? 's.worktree_name' : 'NULL'} AS worktreeName,
           ${hasRuntime ? 'r.agent_runtime' : 'NULL'} AS agentRuntime
         FROM workflow_runs r
         ${hasSession ? 'LEFT JOIN sessions s ON s.id = r.session_id' : ''}
         WHERE r.id = ?`,
      )
      .get(runId) as
      | { sessionName?: unknown; worktreeName?: unknown; agentRuntime?: unknown }
      | undefined;
    if (!row) return EMPTY_ATTRIBUTION;
    return toApprovalAttribution(row.sessionName, row.agentRuntime, row.worktreeName);
  } catch {
    return EMPTY_ATTRIBUTION;
  }
}

/**
 * Return all pending approvals ordered oldest-first, projected into the
 * shared `Approval` type with `truncatePayloadPreview` applied.
 *
 * Reads from the `approvals` table where `status = 'pending'`, joined to
 * `workflow_runs` and `workflows` for the human-readable workflow name.
 *
 * @param db - Narrow DatabaseLike interface (real or test).
 * @returns Approval[] sorted by created_at ASC.
 */
export function selectPendingApprovals(db: DatabaseLike): Approval[] {
  const hasSession =
    columnExists(db, 'workflow_runs', 'session_id') && columnExists(db, 'sessions', 'name');
  const hasWorktree = hasSession && columnExists(db, 'sessions', 'worktree_name');
  const hasRuntime = columnExists(db, 'workflow_runs', 'agent_runtime');

  const rows = db.prepare(
    `SELECT
       a.id          AS id,
       a.run_id      AS runId,
       w.name        AS workflowName,
       a.tool_name   AS toolName,
       a.tool_input_json AS payloadPreviewRaw,
       a.rationale   AS rationale,
       a.created_at  AS createdAt,
       a.status      AS status,
       a.awaited     AS awaited,
       ${hasSession ? 's.name' : 'NULL'} AS sessionName,
       ${hasWorktree ? 's.worktree_name' : 'NULL'} AS worktreeName,
       ${hasRuntime ? 'r.agent_runtime' : 'NULL'} AS agentRuntime
     FROM approvals a
     JOIN workflow_runs r ON r.id = a.run_id
     JOIN workflows     w ON w.id = r.workflow_id
     ${hasSession ? 'LEFT JOIN sessions s ON s.id = r.session_id' : ''}
     WHERE a.status = 'pending'
     ORDER BY a.created_at ASC`,
  ).all() as DbApprovalRow[];

  return rows.map((row): Approval => ({
    id: row.id,
    runId: row.runId,
    workflowName: row.workflowName,
    toolName: row.toolName,
    payloadPreview: truncatePayloadPreview(row.payloadPreviewRaw),
    rationale: row.rationale,
    createdAt: new Date(row.createdAt).toISOString(),
    status: row.status as Approval['status'],
    // Migration 111 backfills 1, so a row written before it (or by any transport
    // that never touches the column) reads as awaited — the honest default.
    awaited: row.awaited !== 0,
    ...toApprovalAttribution(row.sessionName, row.agentRuntime, row.worktreeName),
  }));
}
