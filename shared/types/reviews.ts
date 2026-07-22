/**
 * Shared types for the unified review inbox (review_items table, migration 016).
 *
 * SINGLE SOURCE OF TRUTH: the SQL columns in
 * main/src/database/migrations/016_review_items.sql, the DB row interface in
 * main/src/database/models.ts (ReviewItemRow), and the chokepoint output in
 * main/src/orchestrator/reviewItemRouter.ts must all match these shapes
 * field-for-field. entitySchemaParity.test.ts pins ReviewItemRow <-> the table.
 *
 * (This module stays runtime-free; the QuestionPayload import below is type-only.)
 *
 * The review queue is the unified human-attention inbox. Five item kinds funnel
 * into one table:
 *   - finding      — non-blocking observation emitted by a Sprint agent (P3).
 *   - permission   — a real-time PreToolUse/approval gate (blocking=true, P4).
 *   - decision     — an approve-idea / approve-plan gate; resolving auto-resumes
 *                    the run subject to aggregate-unblock (blocking=true, P4).
 *   - human_task   — a free-form human action item; blocking per-item.
 *   - notification — an informational FYI (never blocking; its only triage is
 *                    dismiss — no resolve, no promote-to-task). Orchestrator-minted
 *                    only; agents cannot file it via the MCP report_finding tool.
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

import type { QuestionPayload } from './questions';

/** The five review-item kinds (DB CHECK on review_items.kind). */
export type ReviewItemKind = 'finding' | 'permission' | 'decision' | 'human_task' | 'notification';

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

/**
 * Source-tag prefix for idle-quick-session review items (minted by
 * IdleSessionDetector, one per session as `idle-session:<sessionId>`). Shared so
 * the main-side detector and the frontend "Idle sessions" queue section agree on
 * the tag. A review item whose `source` starts with this prefix is an idle-session
 * item.
 */
export const IDLE_REVIEW_SOURCE_PREFIX = 'idle-session:';

// ---------------------------------------------------------------------------
// Per-kind payload union
// ---------------------------------------------------------------------------

/**
 * Where the reporting agent hints that ACCEPTING a finding should land. A pure
 * routing hint — it does NOT make the edit, only steers the human's primary
 * action (mockup F4: accept → editor / docs / backlog "apply now"):
 *   - 'backlog' — promote the finding to a real backlog task (the existing
 *                 promote-to-task path). Maps to the Task-candidate bucket.
 *   - 'docs'    — a docs/ change the human applies manually. Documentation bucket.
 *   - 'prompt'  — a workflow-prompt / CLAUDE.md edit the human applies manually.
 *                 Folds into the Documentation bucket for DISPLAY ONLY (no data
 *                 migration — the persisted value stays 'prompt').
 *   - 'fix'     — a quick in-place code fix the compound run applies directly.
 *                 Maps to the Quick fix bucket (findings-triage redesign).
 * 'docs'/'prompt' resolve the item with a 'triaged:accepted-<target>' note (the
 * decision is recorded per the resolution-prefix convention; no task is minted).
 * See {@link findingBucket} for the canonical target → bucket mapping.
 */
export type FindingProposedTarget = 'backlog' | 'docs' | 'prompt' | 'fix';

/**
 * Finding priority — a first-class, SQL-sortable column on review_items
 * (migration 034). NULL = un-prioritized legacy finding; consumers render NULL
 * as an explicit "unset" badge and sort it LAST (never fabricate a 'P2' label).
 */
export const FINDING_PRIORITIES = ['P0', 'P1', 'P2'] as const;
export type FindingPriority = (typeof FINDING_PRIORITIES)[number];
export function isFindingPriority(v: unknown): v is FindingPriority {
  return typeof v === 'string' && (FINDING_PRIORITIES as readonly string[]).includes(v);
}

/**
 * Triage bucket a finding's {@link FindingProposedTarget} maps to — the SINGLE
 * source of truth reused by the seed block and the Insights triage UI:
 *   - 'quick' ← 'fix'      (Quick fix)
 *   - 'task'  ← 'backlog'  (Task candidate)
 *   - 'doc'   ← 'docs', legacy 'prompt', and null/unknown (Documentation update)
 */
export type FindingTagBucket = 'quick' | 'doc' | 'task';
export function findingBucket(t: FindingProposedTarget | null | undefined): FindingTagBucket {
  if (t === 'fix') return 'quick';
  if (t === 'backlog') return 'task';
  return 'doc'; // 'docs' and legacy 'prompt' fold here; null/unknown defaults to doc
}

/**
 * Finding payload — a non-blocking observation. `category` lets the UI group
 * findings (e.g. 'security', 'perf', 'style'); `suggestedFix` is optional prose.
 */
export interface FindingPayload {
  kind: 'finding';
  category?: string;
  suggestedFix?: string;
  /**
   * Optional accept-routing hint from the reporting agent — see
   * {@link FindingProposedTarget}. Absent when the agent has no preference, in
   * which case the card keeps its default Dismiss / Promote-to-task actions.
   */
  proposedTarget?: FindingProposedTarget;
  /** Optional file:line locations the finding refers to. */
  locations?: Array<{ path: string; line?: number }>;
  /**
   * Optional verification impact — how many times a regression-guard ran, how
   * many regressions it caught, a token delta, and free-text. All members are
   * optional so an agent can carry whichever signal it has; the mcp handler
   * drops malformed members rather than failing the finding write.
   */
  impact?: { ranCount?: number; caughtRegressions?: number; tokenDelta?: number; note?: string };
  /**
   * Machine-readable correlation for a VISUAL-VERIFY finding (verification-agent
   * redesign §5.7). Present only on findings raised by the verdict-delivery hook;
   * lets a later terminal verdict for the same lane find + supersede prior
   * unresolved findings at LOWER attempts, and makes finding creation idempotent
   * by `requestId` on delivery-outbox replay. `taskRef` is null for a
   * non-lane-attributed request; `attempt` is parsed from the request's
   * enqueue_key (`${runId}:${taskRef}:${attempt}`), falling back to the lane's
   * attempt counter, else 1.
   */
  visualVerify?: {
    runId: string;
    taskRef: string | null;
    attempt: number;
    requestId: string;
  };
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
 * Decision payload — an approve-idea / approve-plan gate, an
 * ask-user-question-recovery gate, OR (A/B testing slice C) an
 * experiment-comparison "pairwise verdict ready" notification. `gate`
 * discriminates which opened it; resolving an approve-* gate auto-resumes the run
 * (P4, aggregate-unblock), while an `experiment-comparison` item is resolved by
 * experiments.decide (it carries no run to resume).
 *
 * `ask-user-question-recovery` is a DURABLE fallback for the SDK substrate: when
 * an in-turn `AskUserQuestion` gate fails (the SDK control channel intermittently
 * drops with "Stream closed"), the agent degrades to a free-text question and its
 * turn drains — the run would otherwise rest in `awaiting_review` and render as
 * "Workflow complete", stranding the human decision. Detecting the failed
 * tool_result in the stream synthesizes THIS gate instead, carrying the original
 * `recoveredQuestions` so the review queue can re-offer the same options; picking
 * one resolves the item AND re-drives the run with the chosen answer as a resumed
 * turn. See main/src/orchestrator/askUserQuestionFailureDetector.ts.
 *
 * For `gate:'experiment-comparison'` the experiment fields are populated so the
 * review-queue card can route the human straight to the comparison view and
 * pre-select the suggested winner; they are omitted for the approve-* / recovery
 * gates.
 */
export interface DecisionPayload {
  kind: 'decision';
  gate:
    | 'approve-idea'
    | 'approve-ideas'
    | 'approve-designs'
    | 'approve-plan'
    | 'idea-size-guard'
    | 'ask-user-question-recovery'
    | 'experiment-comparison';
  /** Optional summary the gate wants the human to confirm. */
  summary?: string;
  /**
   * Only for `gate: 'idea-size-guard'`: the display ref of the ONE idea the
   * big-idea guard flagged as too large to run as a single idea (minted
   * agent-side). Unlike the approve-ideas batch, this guard is resolved by its
   * own dedicated split/keep mutations, NEVER by an {@link IdeaVerdictMap} — the
   * ref is carried only so the review-queue card can route the human to the
   * flagged idea. Omitted for every other gate.
   */
  ideaRef?: string;
  /**
   * Only for `gate: 'approve-ideas'`: the batch's idea display refs (e.g.
   * ['IDEA-014', 'IDEA-015']) the ONE blocking gate covers. The submitted
   * per-idea verdict map ({@link IdeaVerdictMap}) is validated against these refs
   * when the gate resolves — every ref must be decided, and no verdict may
   * reference a ref outside this list. Omitted for the scalar approve-* gates.
   */
  ideaRefs?: string[];
  /**
   * Only for `gate: 'approve-designs'`: the batch's idea display refs whose
   * architecture designs the ONE blocking gate covers (the design-approval
   * sibling of {@link ideaRefs}). The submitted per-idea verdict map
   * ({@link IdeaVerdictMap}) is validated against these refs when the gate
   * resolves — every ref must be decided, and no verdict may reference a ref
   * outside this list. Omitted for every non-approve-designs gate.
   */
  designRefs?: string[];
  /**
   * Only for `gate: 'ask-user-question-recovery'`: the original AskUserQuestion
   * payload the SDK gate failed to surface, so the review UI can re-offer the
   * exact same questions/options. The chosen option label becomes the resume text.
   */
  recoveredQuestions?: QuestionPayload[];
  /** (experiment-comparison) the experiment whose comparison is ready. */
  experimentId?: string;
  /** (experiment-comparison) the aggregate pairwise preference. */
  comparisonPreference?: 'A' | 'B' | 'tie';
  /** (experiment-comparison) the winning arm's run id, when the verdict has one. */
  suggestedWinnerRunId?: string | null;
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
 * Notification payload — an informational FYI. `notificationType` is an OPEN
 * string (like {@link ReviewItemSource}, not a closed union) so a new emitter
 * can tag its notice without a shared-type edit; consumers treat it as opaque.
 * Today's values: 'dynamic-workflow-finished' / 'dynamic-workflow-stalled'.
 */
export interface NotificationPayload {
  kind: 'notification';
  notificationType?: string;
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
  | HumanTaskPayload
  | NotificationPayload;

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
  /**
   * First-class finding priority (migration 034). Finding-scoped — null for
   * non-finding kinds AND for un-prioritized legacy findings.
   */
  priority: FindingPriority | null;
  /**
   * Non-null == the human approved this finding into READY (migration 034);
   * doubles as staging order. Finding-scoped — null for non-finding kinds and
   * for still-untriaged findings.
   */
  staged_at: string | null;
  /**
   * The per-finding "compound this" checkbox (migration 034; 0/1 normalized to
   * boolean in shapeRow). Finding-scoped — always false for non-finding kinds.
   */
  selected: boolean;
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
// Resolution-prefix convention
// ---------------------------------------------------------------------------

/**
 * `review_items.resolution` is a free-text note, but a small set of leading
 * `<verb>:` prefixes carry machine-readable triage intent the UI keys on:
 *   - 'promoted:<taskId>' — the finding minted a real backlog task.
 *   - 'fixed:<note>'      — the issue was fixed in-place.
 *   - 'triaged:<note>'    — reviewed + dispositioned without a code fix.
 * The convention is FORWARD-ONLY: any resolution that does NOT start with one
 * of these prefixes (incl. plain human prose) parses as 'other'; a null
 * resolution (still pending) parses as null. New writers must reuse a prefix
 * const rather than hand-typing the string so the parser cannot drift.
 */
export const RESOLUTION_PREFIX_PROMOTED = 'promoted:';
export const RESOLUTION_PREFIX_FIXED = 'fixed:';
export const RESOLUTION_PREFIX_TRIAGED = 'triaged:';

/**
 * Build the resolution note recorded when a human ACCEPTS a finding whose
 * proposedTarget is a manual ('docs' | 'prompt') edit — e.g.
 * 'triaged:accepted-docs'. Parses as 'triaged' (no code fix was applied here;
 * the human makes the edit). A 'backlog' target does NOT use this — it goes
 * through promote-to-task and records 'promoted:<taskId>' instead.
 *
 * The param is PINNED to the explicit literal `'docs' | 'prompt'` — NOT
 * `Exclude<FindingProposedTarget, 'backlog'>` — so widening the union with 'fix'
 * can NEVER silently broaden this manual-accept path. A 'fix' finding is
 * *compounded* (applied in-place by a compound run), never human-applied as
 * docs, so it must produce a compile error if it ever reaches here.
 */
export function acceptedResolution(target: 'docs' | 'prompt'): string {
  return `${RESOLUTION_PREFIX_TRIAGED}accepted-${target}`;
}

/** Discriminant a {@link parseResolutionKind} result narrows to. */
export type ResolutionKind = 'promoted' | 'fixed' | 'triaged' | 'other';

/**
 * Classify a `resolution` string by its leading prefix. Returns null for a null
 * (still-pending) resolution, the matching kind for a known prefix, and 'other'
 * for any free-text resolution that matches none — see the convention above.
 */
export function parseResolutionKind(resolution: string | null): ResolutionKind | null {
  if (resolution === null) return null;
  if (resolution.startsWith(RESOLUTION_PREFIX_PROMOTED)) return 'promoted';
  if (resolution.startsWith(RESOLUTION_PREFIX_FIXED)) return 'fixed';
  if (resolution.startsWith(RESOLUTION_PREFIX_TRIAGED)) return 'triaged';
  return 'other';
}

// ---------------------------------------------------------------------------
// Approve-ideas batch gate — per-idea verdict map
// ---------------------------------------------------------------------------

/** One human decision for a single idea at an approve-ideas batch gate. */
export type IdeaVerdict = 'approve' | 'deny';

/** True when `v` is a valid {@link IdeaVerdict}. */
export function isIdeaVerdict(v: unknown): v is IdeaVerdict {
  return v === 'approve' || v === 'deny';
}

/**
 * The per-idea verdicts a human submits at an approve-ideas BATCH gate, keyed by
 * the idea's display ref (e.g. 'IDEA-014'). The gate is ONE blocking review item
 * for the whole batch; resolving it folds the whole map atomically. A denied idea
 * simply STAYS on the backlog — retirement lineage is handled separately, never
 * here. Serialized into the review item's `resolution` via
 * {@link serializeIdeaVerdictMap} so the resumed planner reads which refs were
 * approved vs denied.
 */
export type IdeaVerdictMap = Record<string, IdeaVerdict>;

/**
 * Resolution-note prefix carrying a serialized {@link IdeaVerdictMap} for an
 * approve-ideas gate. Deliberately spells a rejected idea 'deny' (never
 * 'reject') so the serialized note can NEVER trip {@link parseGateVerdict}'s
 * 'reject' substring sniff — the batch gate still resolves as an
 * approve-to-proceed while the map records the per-idea decisions.
 */
export const RESOLUTION_PREFIX_IDEA_VERDICTS = 'idea-verdicts:';

/** Serialize a verdict map into the `resolution` note the resumed planner reads. */
export function serializeIdeaVerdictMap(map: IdeaVerdictMap): string {
  return `${RESOLUTION_PREFIX_IDEA_VERDICTS}${JSON.stringify(map)}`;
}

/**
 * Parse a serialized {@link IdeaVerdictMap} back out of a `resolution` note.
 * Returns null when the note carries no verdict-map prefix or the payload is not
 * a JSON object; non-approve/deny entries are dropped defensively, and an
 * all-garbage payload yields null.
 */
export function parseIdeaVerdictMap(resolution: string | null | undefined): IdeaVerdictMap | null {
  if (typeof resolution !== 'string' || !resolution.startsWith(RESOLUTION_PREFIX_IDEA_VERDICTS)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(resolution.slice(RESOLUTION_PREFIX_IDEA_VERDICTS.length));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const map: IdeaVerdictMap = {};
  for (const [ref, verdict] of Object.entries(parsed as Record<string, unknown>)) {
    if (isIdeaVerdict(verdict)) map[ref] = verdict;
  }
  return Object.keys(map).length > 0 ? map : null;
}

// ---------------------------------------------------------------------------
// Approve-designs batch gate — per-idea design verdict map
//
// The design-approval sibling of the approve-ideas verdict machinery above. The
// verdict VALUE type is the same approve/deny map keyed by idea display ref
// ({@link IdeaVerdictMap}) — an architecture design belongs to exactly one idea,
// so a design verdict is keyed by that idea's ref. Only the serialized
// resolution-note PREFIX differs, so a resumed planner reads design decisions
// separately from idea decisions (a run can carry both a resolved approve-ideas
// gate and a resolved approve-designs gate).
// ---------------------------------------------------------------------------

/**
 * Resolution-note prefix carrying a serialized {@link IdeaVerdictMap} for an
 * approve-designs gate. Like {@link RESOLUTION_PREFIX_IDEA_VERDICTS} it spells a
 * denied design 'deny' (never 'reject') so the note can never trip a 'reject'
 * substring sniff — the batch gate still resolves as approve-to-proceed while the
 * map records the per-design decisions.
 */
export const RESOLUTION_PREFIX_DESIGN_VERDICTS = 'design-verdicts:';

/** Serialize a design verdict map into the `resolution` note the resumed planner reads. */
export function serializeDesignVerdictMap(map: IdeaVerdictMap): string {
  return `${RESOLUTION_PREFIX_DESIGN_VERDICTS}${JSON.stringify(map)}`;
}

/**
 * Parse a serialized design {@link IdeaVerdictMap} back out of a `resolution`
 * note. Mirrors {@link parseIdeaVerdictMap}: returns null when the note carries
 * no design-verdict prefix or the payload is not a JSON object; non-approve/deny
 * entries are dropped defensively, and an all-garbage payload yields null.
 */
export function parseDesignVerdictMap(resolution: string | null | undefined): IdeaVerdictMap | null {
  if (typeof resolution !== 'string' || !resolution.startsWith(RESOLUTION_PREFIX_DESIGN_VERDICTS)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(resolution.slice(RESOLUTION_PREFIX_DESIGN_VERDICTS.length));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const map: IdeaVerdictMap = {};
  for (const [ref, verdict] of Object.entries(parsed as Record<string, unknown>)) {
    if (isIdeaVerdict(verdict)) map[ref] = verdict;
  }
  return Object.keys(map).length > 0 ? map : null;
}

// ---------------------------------------------------------------------------
// Chokepoint event payload
// ---------------------------------------------------------------------------

/**
 * The action a committed review-item change represents.
 *   - created           — a new review item entered the inbox.
 *   - resolved          — triaged as resolved (incl. promote-to-task).
 *   - dismissed         — triaged as dismissed (cruft).
 *   - mutated           — a finding was re-tagged (proposedTarget) and/or
 *                         re-prioritized while still untriaged (migration 034).
 *   - staged            — a finding was approved untriaged → ready
 *                         (staged_at set, selected pre-checked; migration 034).
 *   - selection-changed — a ready finding's compound-this checkbox toggled
 *                         (selected 0↔1; migration 034).
 */
export type ReviewItemChangeAction =
  | 'created'
  | 'resolved'
  | 'dismissed'
  | 'mutated'
  | 'staged'
  | 'selection-changed';

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
