/**
 * Shared types for the unified review inbox (review_items table, migration 016).
 *
 * SINGLE SOURCE OF TRUTH: the SQL columns in
 * main/src/database/migrations/016_review_items.sql, the DB row interface in
 * main/src/database/models.ts (ReviewItemRow), and the chokepoint output in
 * main/src/orchestrator/reviewItemRouter.ts must all match these shapes
 * field-for-field. entitySchemaParity.test.ts pins ReviewItemRow <-> the table.
 *
 * The review queue is the unified human-attention inbox. Four item kinds funnel
 * into one table:
 *   - finding     — non-blocking observation emitted by a Sprint agent (P3).
 *   - permission  — a real-time PreToolUse/approval gate (blocking=true, P4).
 *   - decision    — an approve-idea / approve-plan gate; resolving auto-resumes
 *                   the run subject to aggregate-unblock (blocking=true, P4).
 *   - human_task  — a free-form human action item; blocking per-item.
 *
 * Triage = resolve / dismiss / promote-to-task (the last mints a real task
 * through the TaskChangeRouter chokepoint).
 *
 * Keep this file free of Node.js built-ins so it imports in any environment
 * (main process AND renderer).
 */

// ---------------------------------------------------------------------------
// Scalar enums
// ---------------------------------------------------------------------------

/** The four review-item kinds (DB CHECK on review_items.kind). */
export type ReviewItemKind = 'finding' | 'permission' | 'decision' | 'human_task';

/** Lifecycle status (DB CHECK on review_items.status). */
export type ReviewItemStatus = 'pending' | 'resolved' | 'dismissed';

/** Severity — only meaningful for findings (DB CHECK on review_items.severity). */
export type ReviewItemSeverity = 'info' | 'warning' | 'error';

/**
 * Soft polymorphic entity link. A review item MAY reference an idea/epic/task
 * (entity_type + entity_id, both nullable, code-validated — NO hard FK).
 */
export type ReviewItemEntityType = 'idea' | 'epic' | 'task';

/**
 * Free-form provenance string carried on review_items.source. Examples:
 *   'agent:executor'      — a Sprint agent emitted a finding.
 *   'approval'            — folded from the PreToolUse/approval path.
 *   'gate:approve-idea'   — an approve-idea decision gate.
 *   'gate:approve-plan'   — an approve-plan decision gate.
 *   'user'                — a manually-created human task / triage item.
 * Modeled as a plain string (not a closed union) so new emitters do not require
 * a shared-type edit; consumers treat it as opaque provenance.
 */
export type ReviewItemSource = string;

// ---------------------------------------------------------------------------
// Per-kind payload union
// ---------------------------------------------------------------------------

/**
 * Finding payload — a non-blocking observation. `category` lets the UI group
 * findings (e.g. 'security', 'perf', 'style'); `suggestedFix` is optional prose.
 */
export interface FindingPayload {
  kind: 'finding';
  category?: string;
  suggestedFix?: string;
  /** Optional file:line locations the finding refers to. */
  locations?: Array<{ path: string; line?: number }>;
}

/**
 * Permission payload — folds the real-time PreToolUse/approval request. Carries
 * enough to render the approval and (in P4) to resolve the held-open socket.
 */
export interface PermissionPayload {
  kind: 'permission';
  toolName: string;
  /** The tool input as the agent requested it (serialized-safe JSON value). */
  toolInput: unknown;
  /** The approvals-row id this review item folds, when sourced from an approval. */
  approvalId?: string;
}

/**
 * Decision payload — an approve-idea / approve-plan gate. `gate` discriminates
 * which gate opened it; resolving auto-resumes the run (P4, aggregate-unblock).
 */
export interface DecisionPayload {
  kind: 'decision';
  gate: 'approve-idea' | 'approve-plan';
  /** Optional summary the gate wants the human to confirm. */
  summary?: string;
}

/**
 * Human-task payload — a free-form human action item. `dueHint` is optional
 * prose (NOT a parsed date) so the UI can surface urgency without a date parser.
 */
export interface HumanTaskPayload {
  kind: 'human_task';
  dueHint?: string;
}

/**
 * Discriminated payload union keyed on `kind`. Persisted as JSON in
 * review_items.payload_json; the discriminant MUST match the row's `kind`
 * column (the ReviewItemRouter asserts this on create).
 */
export type ReviewItemPayload =
  | FindingPayload
  | PermissionPayload
  | DecisionPayload
  | HumanTaskPayload;

// ---------------------------------------------------------------------------
// Read-model item
// ---------------------------------------------------------------------------

/**
 * The read-model item rendered by the review-queue UI. Columns from
 * `review_items` plus the parsed `payload` (from payload_json). SQLite BOOLEAN
 * is normalized to a real boolean on read.
 */
export interface ReviewItem {
  id: string;
  project_id: number;
  /** The run that produced this item; null for manual/triage items. */
  run_id: string | null;
  /** Soft polymorphic link — null when the item references no entity. */
  entity_type: ReviewItemEntityType | null;
  entity_id: string | null;
  kind: ReviewItemKind;
  status: ReviewItemStatus;
  /** Whether this item gates run resume (aggregate-unblock, P4). */
  blocking: boolean;
  title: string;
  body: string | null;
  /** Only meaningful for findings; null otherwise. */
  severity: ReviewItemSeverity | null;
  source: ReviewItemSource | null;
  /** Parsed payload_json (null when unset or unparseable). */
  payload: ReviewItemPayload | null;
  created_at: string;
  updated_at: string;
  /** Actor that resolved/dismissed; null while pending. */
  resolved_by: string | null;
  /** Free-form resolution note (e.g. 'promoted:tsk_...'); null while pending. */
  resolution: string | null;
}

// ---------------------------------------------------------------------------
// Chokepoint event payload
// ---------------------------------------------------------------------------

/**
 * The action a committed review-item change represents.
 *   - created   — a new review item entered the inbox.
 *   - resolved  — triaged as resolved (incl. promote-to-task).
 *   - dismissed — triaged as dismissed (cruft).
 */
export type ReviewItemChangeAction = 'created' | 'resolved' | 'dismissed';

/**
 * Emitted on the project-scoped channel after every committed review-item
 * change. The renderer applies it to its in-memory inbox without a full
 * re-fetch (mirrors TaskChangedEvent).
 */
export interface ReviewItemChangedEvent {
  projectId: number;
  reviewItemId: string;
  action: ReviewItemChangeAction;
  item: ReviewItem;
}
