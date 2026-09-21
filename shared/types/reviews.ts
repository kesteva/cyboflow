/**
 * Shared types for the unified review inbox (review_items table, migration 016).
 *
 * SINGLE SOURCE OF TRUTH: the SQL columns in
 * main/src/database/migrations/016_review_items.sql, the DB row interface in
 * main/src/database/models.ts (ReviewItemRow), and the chokepoint output in
 * main/src/orchestrator/reviewItemRouter.ts must all match these shapes
 * field-for-field. entitySchemaParity.test.ts pins ReviewItemRow <-> the table.
 *
 * (This module stays free of Node.js built-ins; the QuestionPayload import below
 * is type-only, and the one value import — `makeFenceState` — is a pure shared
 * helper with the same constraint.)
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
// The ONE fence-aware markdown line walker (artifacts.ts). Imported rather than
// re-derived so this module's section boundaries can never drift from the
// arch-design / design-spec extractors' reading of the same syntax.
import { makeFenceState } from './artifacts';

/** The five review-item kinds (DB CHECK on review_items.kind). */
export type ReviewItemKind = 'finding' | 'permission' | 'decision' | 'human_task' | 'notification';

/** Lifecycle status (DB CHECK on review_items.status). */
export type ReviewItemStatus = 'pending' | 'resolved' | 'dismissed';

/**
 * Who must act on a review item (migration 085) — an axis INDEPENDENT of
 * `blocking`. 'human' (default) renders in the review queue and, when blocking,
 * parks the run. 'machine' is a durable record the orchestrator consumes (e.g. the
 * visual merge-gate's under-cap loopback finding): never queued, never counted by
 * the aggregate-unblock gate. Splitting this off `blocking` is what prevents a
 * machine-mailbox blocking item from wedging the run on a card no human can see.
 */
export type ReviewItemAudience = 'human' | 'machine';

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
    | 'approve-design'
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
  /**
   * Who must act on this item (migration 085) — independent of `blocking`.
   * 'machine' items are the orchestrator's durable mailbox: excluded from the
   * queue and from the run-park blocking count. Defaults to 'human'.
   */
  audience: ReviewItemAudience;
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
// Gate-resolution grammar — `<verdict>[<modifier>]: <note>`
// ---------------------------------------------------------------------------

/** The three-way verdict a human records at a `gate:human-step:*` decision item. */
export type GateVerdictWord = 'approve' | 'reject' | 'revise';

/** A {@link parseGateResolution} result. `modifier`/`note` are omitted when absent. */
export interface ParsedGateResolution {
  verdict: GateVerdictWord;
  /** The bracketed qualifier, e.g. 'no-findings'. Validated by the HANDLER, not here. */
  modifier?: string;
  /** The human's own words after the colon, trimmed. Omitted when empty. */
  note?: string;
}

/**
 * The only modifier the grammar carries today: an approve-design approval that
 * must NOT log the review's remaining entries as accepted-risk findings.
 */
export const GATE_RESOLUTION_MODIFIER_NO_FINDINGS = 'no-findings';

/**
 * `<verdict>` / `<verdict>[<modifier>]` / `<verdict>: <note>` /
 * `<verdict>[<modifier>]: <note>`, anchored on the TRIMMED string.
 *
 * The `i` flag exists for the VERDICT (legacy writers spelled it 'Approve');
 * {@link parseGateResolution} normalizes both captures to lower case. An
 * upper-case modifier is therefore accepted and normalized — the parser never
 * throws on an old row, and the resolve handler is the thing that refuses any
 * modifier it does not recognize.
 */
const GATE_RESOLUTION_RE = /^(approve|reject|revise)(?:\[([a-z-]+)\])?(?::\s*([\s\S]*))?$/i;

/**
 * Build the resolution string stored for an explicit gate verdict.
 *
 * WHY A PREFIX. Every verdict reader used to string-sniff the whole resolution
 * (`r.includes('reject')`), so a human note like "revise: the architecture
 * rejects empty input" read as a REJECT and ended the run. An anchored verdict
 * prefix makes the verdict structural and leaves the note free text; readers
 * parse this first and fall back to the sniff only for legacy rows.
 *
 * A blank/whitespace `note` or `modifier` is dropped, so a bare outcome stores
 * exactly the bare verdict word it stored before this grammar existed.
 */
export function composeGateResolution(p: {
  verdict: GateVerdictWord;
  modifier?: string;
  note?: string;
}): string {
  const modifier = p.modifier?.trim();
  const note = p.note?.trim();
  const head = modifier ? `${p.verdict}[${modifier}]` : p.verdict;
  return note ? `${head}: ${note}` : head;
}

/**
 * Parse a stored resolution written by {@link composeGateResolution}, or null
 * for anything else — legacy free text ('please revise this', 'approved'), the
 * serialized `idea-verdicts:` / `design-verdicts:` maps, and the
 * `promoted:`/`fixed:`/`triaged:` triage prefixes all return null so their
 * existing readers keep owning them.
 */
export function parseGateResolution(
  resolution: string | null | undefined,
): ParsedGateResolution | null {
  if (typeof resolution !== 'string') return null;
  const m = GATE_RESOLUTION_RE.exec(resolution.trim());
  if (m === null) return null;
  // Normalized like the verdict: the `i` flag lets 'approve[NO-FINDINGS]' through
  // (the parser never rejects an old row), and the handler compares the literal.
  const modifier = m[2]?.toLowerCase();
  const note = (m[3] ?? '').trim();
  return {
    verdict: m[1].toLowerCase() as GateVerdictWord,
    ...(modifier ? { modifier } : {}),
    ...(note.length > 0 ? { note } : {}),
  };
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
 *   - annotated         — a still-pending item's body gained (or had replaced)
 *                         a machine-written markdown section — today only the
 *                         supervisor's recommendation. The item is NOT triaged;
 *                         every subscriber upserts the full item, so no
 *                         subscriber needs a new switch arm.
 */
export type ReviewItemChangeAction =
  | 'created'
  | 'resolved'
  | 'dismissed'
  | 'mutated'
  | 'staged'
  | 'selection-changed'
  | 'annotated';

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

// ---------------------------------------------------------------------------
// Supervisor recommendation — a machine-written section inside an item's body
//
// The run supervisor (monitor) may ANNOTATE a still-pending review item with a
// non-binding recommendation, so the card can tell the human which choice the
// brain that watched the whole run would make. It is a markdown SECTION inside
// the existing body rather than a new column: the body is the one field every
// surface already renders, so an annotation needs no migration, no IPC shape
// change, and degrades to plain prose anywhere that has not been taught the
// section (the review-queue markdown, a copied gate body, a CLI read).
//
// The helpers below are pure and runtime-free so both the main process (the
// router's `annotate` op) and the renderer (the card's chip) share ONE parser.
// ---------------------------------------------------------------------------

/**
 * The one heading `ReviewItemAnnotate` may write today. A closed set, so a body
 * can never be scribbled on with arbitrary machine sections, and so the parser
 * and the writer can never drift on the spelling.
 */
export const SUPERVISOR_RECOMMENDATION_HEADING = 'Supervisor recommendation';

/**
 * The choices a supervisor recommendation may name. `approve`/`reject` are the
 * plain human gate's menu — the only two CONTROLS such a gate renders;
 * `continue`/`rerun`/`dismiss` are the approve-design gate's own menu
 * (continue = approve and log the review's entries as accepted-risk findings,
 * rerun = send the design back for another pass, dismiss = continue WITHOUT
 * logging). Non-binding: nothing resolves a gate off this value.
 *
 * `revise` is deliberately ABSENT. No plain gate has a Revise control — the card
 * renders Approve and Reject only, and Reject ends the run — so a `revise`
 * recommendation could only ever point a human at the button that kills the run.
 * The resolution grammar's `revise` verdict ({@link GateVerdictWord}) is a
 * DIFFERENT vocabulary and keeps its meaning.
 */
export type SupervisorRecommendationChoice =
  | 'approve'
  | 'reject'
  | 'continue'
  | 'rerun'
  | 'dismiss';

/** An ATX H1/H2 heading line: `# text` or `## text` (at most three indents). */
const H1_H2_RE = /^ {0,3}(#{1,2})\s+(.*)$/;

/** Normalize a heading's text for comparison: trailing whitespace + case-insensitive. */
function normalizeHeading(text: string): string {
  return text.trim().toLowerCase();
}

/**
 * Index every H1/H2 heading line that sits OUTSIDE a fenced code block.
 *
 * Fence tracking is the whole point: a body that quotes a markdown template in a
 * ``` block ("## Supervisor recommendation" as an EXAMPLE) must not have that
 * example treated as a real section — replacing it would rewrite the human's
 * sample, and reading it would parse a recommendation nobody made.
 *
 * The fence scan itself is {@link makeFenceState}, the ONE fence-aware line
 * walker every section extractor in the codebase shares (artifacts.ts documents
 * it as such). Re-implementing it here was how this module ended up with its own
 * subtly different CommonMark reading — notably the backtick-fence-with-a-
 * backtick-in-its-info-string case, which the shared state declines to open and a
 * local copy happily swallowed to EOF.
 */
function indexHeadings(lines: string[]): Array<{ line: number; level: number; text: string }> {
  const out: Array<{ line: number; level: number; text: string }> = [];
  const fence = makeFenceState();
  for (let i = 0; i < lines.length; i++) {
    if (fence.handleLine(lines[i])) continue;
    if (fence.inFence()) continue;
    const headingMatch = H1_H2_RE.exec(lines[i]);
    if (headingMatch) {
      out.push({ line: i, level: headingMatch[1].length, text: headingMatch[2] });
    }
  }
  return out;
}

/**
 * Locate every `## <heading>` section in `lines`, as [startLine, endLineExclusive)
 * ranges. A section runs from its own heading line to the next H1/H2 outside a
 * fence (or end of body).
 */
function findSections(lines: string[], heading: string): Array<{ start: number; end: number }> {
  const headings = indexHeadings(lines);
  const wanted = normalizeHeading(heading);
  const ranges: Array<{ start: number; end: number }> = [];
  for (let h = 0; h < headings.length; h++) {
    if (headings[h].level !== 2 || normalizeHeading(headings[h].text) !== wanted) continue;
    const next = headings[h + 1];
    ranges.push({ start: headings[h].line, end: next ? next.line : lines.length });
  }
  return ranges;
}

/**
 * Insert or replace the `## <heading>` section of a markdown body.
 *
 * Replace-in-place (rather than append-and-let-the-last-one-win) is what makes a
 * re-annotation idempotent: a gate the supervisor annotates twice must end with
 * ONE recommendation, in the position the human already read it, not a growing
 * stack. Any further duplicate sections — from an older writer, or a body the
 * human pasted twice — are removed in the same pass, so the parser's "first
 * section" and the reader's "the section" can never disagree.
 *
 * Section boundaries follow {@link indexHeadings}: the next H1/H2 OUTSIDE a
 * fenced code block ends the section. Output always ends with exactly one
 * trailing newline. Pure — the input string is never mutated.
 */
export function upsertMarkdownSection(body: string, heading: string, markdown: string): string {
  const sectionText = `## ${heading.trim()}\n\n${markdown.trim()}\n`;
  const source = body ?? '';
  const lines = source.split('\n');
  const ranges = findSections(lines, heading);

  if (ranges.length === 0) {
    const base = source.replace(/\s+$/, '');
    return base === '' ? sectionText : `${base}\n\n${sectionText}`;
  }

  // Rebuild from the tail so the earlier ranges' indices stay valid: the FIRST
  // section becomes the new text, every later duplicate is dropped.
  const out = lines.slice();
  for (let i = ranges.length - 1; i >= 1; i--) {
    out.splice(ranges[i].start, ranges[i].end - ranges[i].start);
  }
  const first = ranges[0];
  out.splice(first.start, first.end - first.start, ...sectionText.replace(/\n$/, '').split('\n'), '');
  return `${out.join('\n').replace(/\s+$/, '')}\n`;
}

/**
 * Read back the body of the `## <heading>` section (its heading line excluded),
 * or null when the body carries no such section. Same boundary rules as
 * {@link upsertMarkdownSection}; leading/trailing blank lines are trimmed off.
 *
 * Used by the recommendation parser and by the gate consult's "already
 * annotated, leave it alone" check.
 */
export function readMarkdownSection(body: string | null | undefined, heading: string): string | null {
  if (typeof body !== 'string' || body === '') return null;
  const lines = body.split('\n');
  const ranges = findSections(lines, heading);
  if (ranges.length === 0) return null;
  return lines
    .slice(ranges[0].start + 1, ranges[0].end)
    .join('\n')
    .replace(/^\s*\n/, '')
    .replace(/\s+$/, '');
}

/**
 * The machine-readable first line of a supervisor recommendation:
 * `Recommended: <choice> — <one sentence>`. Case-insensitive on the choice; the
 * separator may be an em dash, a hyphen, or a colon.
 *
 * `revise` is not in the alternation, so a body carrying a stale
 * `Recommended: revise — …` (written before the choice was retired) parses as
 * nothing and the card renders no chip — which is the right degradation: it
 * would otherwise have emphasized Reject.
 */
const RECOMMENDED_LINE_RE =
  /^Recommended:\s*(approve|reject|continue|rerun|dismiss)\s*(?:—|-|:)\s*(.+)$/i;

/**
 * Parse the supervisor's recommendation out of a review-item body.
 *
 * Reads ONLY inside the `## Supervisor recommendation` section. A stray
 * `Recommended: approve — …` line elsewhere in the body — a reviewer quoting
 * itself, an agent's prose, a human's note — is deliberately ignored: the
 * section is the only thing the router writes, so it is the only thing that may
 * emphasize a button. Malformed (no section, no leading `Recommended:` line, an
 * unknown choice, an empty sentence) yields null and the card renders no chip.
 */
export function parseSupervisorRecommendation(
  body: string | null | undefined,
): { choice: SupervisorRecommendationChoice; sentence: string } | null {
  const section = readMarkdownSection(body, SUPERVISOR_RECOMMENDATION_HEADING);
  if (section === null) return null;
  const firstLine = section.split('\n').find((l) => l.trim() !== '');
  if (firstLine === undefined) return null;
  const m = RECOMMENDED_LINE_RE.exec(firstLine.trim());
  if (!m) return null;
  const sentence = m[2].trim();
  if (sentence === '') return null;
  return { choice: m[1].toLowerCase() as SupervisorRecommendationChoice, sentence };
}

/**
 * Compose the markdown a supervisor recommendation section carries: the
 * machine-readable `Recommended:` line first (so {@link parseSupervisorRecommendation}
 * finds it), then the optional human-readable rationale after one blank line.
 */
export function composeSupervisorRecommendation(
  choice: SupervisorRecommendationChoice,
  sentence: string,
  rationale?: string,
): string {
  const head = `Recommended: ${choice} — ${sentence.trim()}`;
  const tail = rationale?.trim();
  return tail ? `${head}\n\n${tail}` : head;
}
