/**
 * reviewItemListing — shared synchronous helpers for the run-pause review-item
 * fold (P4).
 *
 * The run-pause routers (ApprovalRouter, QuestionRouter, the human-gate manager,
 * and the interactive shell-approval path) co-write a `review_items` row in the
 * SAME db.transaction() as their legacy approvals/questions INSERT — they do NOT
 * route through the async per-project ReviewItemRouter PQueue, because the
 * atomicity requirement ("the approval row and the review item are committed or
 * rolled back together") cannot be satisfied across two independent transactions.
 *
 * These helpers therefore perform a DIRECT, SYNCHRONOUS write to review_items +
 * entity_events. They are the only sanctioned exception to the
 * "all review-item writes route through ReviewItemRouter.applyReviewItem" rule:
 * the rows they write are shape-identical to what the chokepoint produces (same
 * id prefix, same created+resolved entity_events deltas), so a folded item is
 * indistinguishable from a chokepoint-created one to every reader.
 *
 * TABLE-EXISTENCE GUARD: every helper is a no-op when the review_items table is
 * absent (a pre-migration-016 DB, e.g. the GATE_SCHEMA used by some orchestrator
 * unit tests). Production always holds the table; the guard keeps the run-pause
 * routers backward-compatible with the legacy schema fixtures and means a missing
 * inbox never breaks the load-bearing approval/question path.
 *
 * Standalone-typecheck invariant: NO imports from 'electron', 'better-sqlite3',
 * or any concrete service in main/src/services/*. The DB is the narrow
 * DatabaseLike interface.
 */
import { randomBytes } from 'node:crypto';
import type { DatabaseLike } from './types';
import type {
  DecisionPayload,
  PermissionPayload,
  ReviewItem,
  FindingProposedTarget,
  FindingPriority,
} from '../../../shared/types/reviews';
import { ReviewItemRouter, type ReviewItemDbRow } from './reviewItemRouter';

/** The (entity_type, entity_id) entity_events key reused for review items (mirrors reviewItemRouter). */
const ENTITY_EVENT_TYPE = 'review_item';

/** Actor recorded on a folded run-pause review item + its entity_events row. */
const FOLD_ACTOR = 'orchestrator';

// ---------------------------------------------------------------------------
// Table-existence guard (memoized per-DB via a WeakMap)
// ---------------------------------------------------------------------------

const reviewItemsTablePresent = new WeakMap<DatabaseLike, boolean>();

/**
 * True when the review_items table exists on `db`. Memoized per DB handle so
 * the sqlite_master probe runs at most once per process per connection.
 */
export function hasReviewItemsTable(db: DatabaseLike): boolean {
  const cached = reviewItemsTablePresent.get(db);
  if (cached !== undefined) return cached;
  let present = false;
  try {
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'review_items'`)
      .get() as { name?: string } | undefined;
    present = row?.name === 'review_items';
  } catch {
    present = false;
  }
  reviewItemsTablePresent.set(db, present);
  return present;
}

// ---------------------------------------------------------------------------
// Internal: synchronous entity_events append (mirrors ReviewItemRouter.insertEvent)
// ---------------------------------------------------------------------------

interface FieldDelta {
  field: string;
  from: unknown;
  to: unknown;
}

/**
 * Append a polymorphic entity_events row for a review item, minting the
 * per-(entity_type, entity_id) seq atomically. Caller MUST already be inside the
 * enclosing db.transaction() so the seq read + INSERT cannot interleave.
 */
function insertReviewEvent(
  db: DatabaseLike,
  reviewItemId: string,
  kind: string,
  runId: string | null,
  deltas: FieldDelta[],
  now: string,
): void {
  const maxRow = db
    .prepare('SELECT MAX(seq) AS maxSeq FROM entity_events WHERE entity_type = ? AND entity_id = ?')
    .get(ENTITY_EVENT_TYPE, reviewItemId) as { maxSeq: number | null };
  const seq = (maxRow.maxSeq ?? 0) + 1;
  db.prepare(
    `INSERT INTO entity_events (entity_type, entity_id, seq, kind, actor, run_id, changes_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(ENTITY_EVENT_TYPE, reviewItemId, seq, kind, FOLD_ACTOR, runId, JSON.stringify(deltas), now);
}

/** Resolve the run's project_id; returns null when the run row is absent. */
function projectIdForRun(db: DatabaseLike, runId: string): number | null {
  const row = db
    .prepare('SELECT project_id AS projectId FROM workflow_runs WHERE id = ?')
    .get(runId) as { projectId?: unknown } | undefined;
  if (!row || row.projectId === undefined || row.projectId === null) return null;
  return typeof row.projectId === 'number' ? row.projectId : Number(row.projectId);
}

// ---------------------------------------------------------------------------
// Co-write: permission review item (ApprovalRouter + interactive shell-approval)
// ---------------------------------------------------------------------------

export interface CoWritePermissionArgs {
  /** The approvals-row id this review item folds (links the two for resolve). */
  approvalId: string;
  runId: string;
  toolName: string;
  /** The tool input as the agent requested it (serialized into the payload). */
  input: Record<string, unknown>;
  /** Provenance source (e.g. 'approval', 'approval:interactive'). */
  source: string;
  /** ISO timestamp shared with the enclosing transaction's other writes. */
  now: string;
}

/**
 * Co-INSERT a blocking permission review item INSIDE the caller's open
 * transaction. No-op (returns null) when the review_items table is absent.
 *
 * @returns the minted review-item id, or null when the inbox table is absent.
 */
export function coWritePermissionReviewItem(
  db: DatabaseLike,
  args: CoWritePermissionArgs,
): string | null {
  if (!hasReviewItemsTable(db)) return null;
  const projectId = projectIdForRun(db, args.runId);
  if (projectId === null) return null;

  const reviewItemId = `rvw_${randomBytes(10).toString('hex')}`;
  const payload: PermissionPayload = {
    kind: 'permission',
    toolName: args.toolName,
    toolInput: args.input,
    approvalId: args.approvalId,
  };
  const title = `Permission: ${args.toolName}`;

  db.prepare(
    `INSERT INTO review_items
       (id, project_id, run_id, entity_type, entity_id, kind, status, blocking,
        title, body, severity, source, payload_json, created_at, updated_at, resolved_by, resolution)
     VALUES (?, ?, ?, NULL, NULL, 'permission', 'pending', 1, ?, NULL, NULL, ?, ?, ?, ?, NULL, NULL)`,
  ).run(reviewItemId, projectId, args.runId, title, args.source, JSON.stringify(payload), args.now, args.now);

  insertReviewEvent(
    db,
    reviewItemId,
    'created',
    args.runId,
    [
      { field: 'kind', from: null, to: 'permission' },
      { field: 'status', from: null, to: 'pending' },
      { field: 'title', from: null, to: title },
      { field: 'blocking', from: null, to: true },
    ],
    args.now,
  );

  return reviewItemId;
}

// ---------------------------------------------------------------------------
// Co-write: decision review item (QuestionRouter + human-gate manager)
// ---------------------------------------------------------------------------

export interface CoWriteDecisionArgs {
  runId: string;
  title: string;
  body?: string | null;
  /** Provenance source (e.g. 'question', 'gate:human-step', 'gate:approve-plan'). */
  source: string;
  /** Optional decision payload (gate discriminator + summary). */
  payload?: DecisionPayload | null;
  /** ISO timestamp shared with the enclosing transaction's other writes. */
  now: string;
}

/**
 * Co-INSERT a blocking decision review item INSIDE the caller's open
 * transaction. No-op (returns null) when the review_items table is absent.
 *
 * @returns the minted review-item id, or null when the inbox table is absent.
 */
export function coWriteDecisionReviewItem(
  db: DatabaseLike,
  args: CoWriteDecisionArgs,
): string | null {
  if (!hasReviewItemsTable(db)) return null;
  const projectId = projectIdForRun(db, args.runId);
  if (projectId === null) return null;

  const reviewItemId = `rvw_${randomBytes(10).toString('hex')}`;
  const body = args.body ?? null;
  const payloadJson = args.payload ? JSON.stringify(args.payload) : null;

  db.prepare(
    `INSERT INTO review_items
       (id, project_id, run_id, entity_type, entity_id, kind, status, blocking,
        title, body, severity, source, payload_json, created_at, updated_at, resolved_by, resolution)
     VALUES (?, ?, ?, NULL, NULL, 'decision', 'pending', 1, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL)`,
  ).run(reviewItemId, projectId, args.runId, args.title, body, args.source, payloadJson, args.now, args.now);

  insertReviewEvent(
    db,
    reviewItemId,
    'created',
    args.runId,
    [
      { field: 'kind', from: null, to: 'decision' },
      { field: 'status', from: null, to: 'pending' },
      { field: 'title', from: null, to: args.title },
      { field: 'blocking', from: null, to: true },
    ],
    args.now,
  );

  return reviewItemId;
}

// ---------------------------------------------------------------------------
// Resolve: idempotent triage of a folded run-pause review item
// ---------------------------------------------------------------------------

/**
 * Resolve the pending permission review item linked to `approvalId` (matched on
 * payload_json's approvalId). IDEMPOTENT: a guarded UPDATE on status='pending'
 * means a second resolve (or a concurrent triage) is a silent no-op. No-op when
 * the table is absent.
 *
 * @returns the resolved review-item id, or null when nothing pending matched.
 */
export function resolvePermissionReviewItem(
  db: DatabaseLike,
  approvalId: string,
  resolvedBy: string,
  resolution: string | null,
  now: string,
  runId?: string | null,
): string | null {
  if (!hasReviewItemsTable(db)) return null;

  // Find the pending permission item whose payload references this approvalId.
  // (The folded item has no dedicated column for approvalId — it lives in the
  // payload union — so match on the JSON extraction; SQLite has json_extract.)
  const row = db
    .prepare(
      `SELECT id, run_id AS runId FROM review_items
        WHERE kind = 'permission' AND status = 'pending'
          AND json_extract(payload_json, '$.approvalId') = ?
        LIMIT 1`,
    )
    .get(approvalId) as { id?: string; runId?: string | null } | undefined;
  if (!row?.id) return null;

  return resolveReviewItemRow(db, row.id, resolvedBy, resolution, now, runId ?? row.runId ?? null);
}

/**
 * Resolve a pending review item by id (idempotent). Used by the human-gate
 * manager and the decision/question resolve path. No-op when the table is absent
 * or the row is not pending.
 *
 * @returns the resolved review-item id, or null when nothing pending matched.
 */
export function resolveReviewItemById(
  db: DatabaseLike,
  reviewItemId: string,
  resolvedBy: string,
  resolution: string | null,
  now: string,
  runId?: string | null,
): string | null {
  if (!hasReviewItemsTable(db)) return null;
  return resolveReviewItemRow(db, reviewItemId, resolvedBy, resolution, now, runId ?? null);
}

/**
 * Guarded UPDATE (status='pending' → 'resolved') + a 'resolved' entity_events
 * delta. Caller is responsible for the table-existence guard. Returns the id on
 * a real transition, null when changes===0 (already terminal / concurrent).
 */
function resolveReviewItemRow(
  db: DatabaseLike,
  reviewItemId: string,
  resolvedBy: string,
  resolution: string | null,
  now: string,
  runId: string | null,
): string | null {
  const info = db
    .prepare(
      `UPDATE review_items
          SET status = 'resolved', resolved_by = ?, resolution = ?, updated_at = ?
        WHERE id = ? AND status = 'pending'`,
    )
    .run(resolvedBy, resolution, now, reviewItemId) as { changes: number };
  if (info.changes === 0) return null;

  insertReviewEvent(
    db,
    reviewItemId,
    'resolved',
    runId,
    [
      { field: 'status', from: 'pending', to: 'resolved' },
      ...(resolution !== null ? [{ field: 'resolution', from: null, to: resolution }] : []),
    ],
    now,
  );
  return reviewItemId;
}

// ---------------------------------------------------------------------------
// Aggregate-unblock: pending blocking review items per run
// ---------------------------------------------------------------------------

/**
 * Count the still-PENDING blocking review items for a run. The aggregate-unblock
 * invariant: a run may only leave awaiting_review/awaiting_input when this count
 * reaches 0 (ALL blocking items resolved/dismissed). Returns 0 when the table is
 * absent (the legacy no-inbox path has no aggregate gate).
 */
export function countPendingBlockingReviewItems(db: DatabaseLike, runId: string): number {
  if (!hasReviewItemsTable(db)) return 0;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM review_items
        WHERE run_id = ? AND blocking = 1 AND status = 'pending'`,
    )
    .get(runId) as { n: number };
  return row.n;
}

/** True when the run has at least one pending blocking review item. */
export function hasPendingBlockingReviewItems(db: DatabaseLike, runId: string): boolean {
  return countPendingBlockingReviewItems(db, runId) > 0;
}

/**
 * Read-model snapshot of the pending blocking review items for a run, shaped via
 * the chokepoint's single-source ReviewItemRouter.shapeRow. Empty when the table
 * is absent.
 */
export function selectPendingBlockingReviewItems(db: DatabaseLike, runId: string): ReviewItem[] {
  if (!hasReviewItemsTable(db)) return [];
  const rows = db
    .prepare(
      `SELECT * FROM review_items
        WHERE run_id = ? AND blocking = 1 AND status = 'pending'
        ORDER BY created_at ASC, id ASC`,
    )
    .all(runId) as ReviewItemDbRow[];
  return rows.map((r) => ReviewItemRouter.shapeRow(r));
}

// ---------------------------------------------------------------------------
// Read helper: a single finding shaped for compound-run seed injection
// (findings-triage redesign / migration 032)
// ---------------------------------------------------------------------------

/**
 * The de-normalized finding shape RunExecutor injects into a SEEDED compound
 * run's prompt (the `## Selected findings` block) and the MCP
 * `cyboflow_get_selected_findings` reply.
 *
 * `proposedTarget` / `suggestedFix` / `locations` are lifted out of the finding's
 * `payload_json` (the FindingPayload union); `priority` is the first-class column
 * (migration 032). All three are null when the finding carried no such hint.
 */
export interface FindingSeedRow {
  id: string;
  title: string;
  body: string | null;
  severity: 'info' | 'warning' | 'error' | null;
  priority: FindingPriority | null;
  source: string | null;
  proposedTarget: FindingProposedTarget | null;
  suggestedFix: string | null;
  locations: Array<{ path: string; line?: number }> | null;
}

/** Parse the optional `proposedTarget` hint off a finding payload, dropping garbage. */
function liftProposedTarget(payload: unknown): FindingProposedTarget | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const t = (payload as { proposedTarget?: unknown }).proposedTarget;
  return t === 'backlog' || t === 'docs' || t === 'prompt' || t === 'fix' ? t : null;
}

/** Parse the optional `suggestedFix` prose off a finding payload. */
function liftSuggestedFix(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const f = (payload as { suggestedFix?: unknown }).suggestedFix;
  return typeof f === 'string' ? f : null;
}

/** Parse the optional `locations` array off a finding payload, dropping malformed entries. */
function liftLocations(payload: unknown): Array<{ path: string; line?: number }> | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const locs = (payload as { locations?: unknown }).locations;
  if (!Array.isArray(locs)) return null;
  const shaped: Array<{ path: string; line?: number }> = [];
  for (const loc of locs) {
    if (typeof loc !== 'object' || loc === null) continue;
    const path = (loc as { path?: unknown }).path;
    if (typeof path !== 'string') continue;
    const line = (loc as { line?: unknown }).line;
    shaped.push(typeof line === 'number' ? { path, line } : { path });
  }
  return shaped.length > 0 ? shaped : null;
}

/**
 * Read a single finding by id, shaped for compound-run seeding. Returns null when
 * the table is absent, the row is missing, or the row's kind is not 'finding'.
 *
 * Read-only — deliberately does NOT route through ReviewItemRouter (no write).
 * Reuses the table-existence guard so a pre-migration-016 DB is a clean no-op.
 */
export function selectFindingForSeed(db: DatabaseLike, reviewItemId: string): FindingSeedRow | null {
  if (!hasReviewItemsTable(db)) return null;
  const row = db
    .prepare(
      `SELECT id, title, body, severity, priority, source, payload_json AS payloadJson
         FROM review_items
        WHERE id = ? AND kind = 'finding'`,
    )
    .get(reviewItemId) as
    | {
        id: string;
        title: string;
        body: string | null;
        severity: 'info' | 'warning' | 'error' | null;
        priority: FindingPriority | null;
        source: string | null;
        payloadJson: string | null;
      }
    | undefined;
  if (!row) return null;

  let payload: unknown = null;
  if (row.payloadJson) {
    try {
      payload = JSON.parse(row.payloadJson);
    } catch {
      payload = null;
    }
  }

  return {
    id: row.id,
    title: row.title,
    body: row.body,
    severity: row.severity,
    priority: row.priority,
    source: row.source,
    proposedTarget: liftProposedTarget(payload),
    suggestedFix: liftSuggestedFix(payload),
    locations: liftLocations(payload),
  };
}
