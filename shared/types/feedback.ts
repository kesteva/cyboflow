/**
 * In-artifact feedback on spec/architecture documents (IDEA-033).
 *
 * Users highlight sections of the idea-spec / arch-design artifact tabs while a
 * planner/ship run is parked at a human gate, save comments, and send the batch.
 * Sending is the durable "changes requested" event: a host-driven scoped
 * revision agent rewrites the target document (the idea's markdown body — these
 * artifacts re-derive from it) through TaskChangeRouter while the gate stays
 * open, then the batch flips to 'applied' and its comments to 'addressed'
 * (consumed — per-round, not threaded).
 *
 * Backed by migration 077 (feedback_batches / feedback_comments); all writes go
 * through the FeedbackRouter chokepoint (main/src/orchestrator/feedbackRouter.ts).
 */

/** The two document artifacts that support highlight+comment feedback. */
export type FeedbackAtype = 'idea-spec' | 'arch-design';

export const FEEDBACK_ATYPES: readonly FeedbackAtype[] = ['idea-spec', 'arch-design'];

export function isFeedbackAtype(value: unknown): value is FeedbackAtype {
  return value === 'idea-spec' || value === 'arch-design';
}

/**
 * Run statuses that count as "parked at a human gate" for feedback purposes.
 * Human gates park runs under TWO statuses depending on the gate surface:
 * `awaiting_review` (HumanStepManager human steps, blocking findings) and
 * `awaiting_input` (QuestionRouter inline AskUserQuestion gates — e.g. the
 * single-idea `approve-idea` stub gate). Both co-write a pending blocking
 * `decision` review item, which is the actual gate binding; the status check is
 * only the cheap first-line guard, so it must accept both.
 */
export const FEEDBACK_PARKED_RUN_STATUSES: readonly string[] = [
  'awaiting_review',
  'awaiting_input',
];

/**
 * Anchors a comment to a span of the RENDERED document text.
 *
 * The documents live on `ideas.body` (a moving target — revisions rewrite it),
 * so anchoring is quote-based, not offset-based: `quote` is the selected plain
 * text, `occurrence` disambiguates repeats (0-based index among identical
 * matches in the rendered text), and `bodyHash` records which body version the
 * highlight was made against (hashDocumentText) so consumers can tell a
 * still-valid anchor from a stale one after a revision.
 */
export interface CommentAnchor {
  quote: string;
  occurrence: number;
  bodyHash: string;
}

export type FeedbackCommentStatus = 'draft' | 'sent' | 'addressed';
export type FeedbackBatchStatus = 'pending' | 'applied' | 'failed';

/** API shape of a feedback_comments row (camelCase; anchor parsed). */
export interface FeedbackComment {
  id: string;
  projectId: number;
  runId: string;
  atype: FeedbackAtype;
  /** Owning idea id (matches artifacts.source_ref for the per-entity atypes). */
  sourceRef: string;
  /** NULL while draft; stamped by send-batch. */
  batchId: string | null;
  anchor: CommentAnchor;
  /** The comment text the user typed. */
  body: string;
  status: FeedbackCommentStatus;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
  addressedAt: string | null;
}

/** API shape of a feedback_batches row — one per "Send feedback" click. */
export interface FeedbackBatch {
  id: string;
  projectId: number;
  runId: string;
  atype: FeedbackAtype;
  sourceRef: string;
  /** 1-based revision round per (runId, atype, sourceRef). */
  round: number;
  status: FeedbackBatchStatus;
  /** Human-readable failure detail when status='failed'. */
  error: string | null;
  createdAt: string;
  appliedAt: string | null;
}

/**
 * Change delta emitted by the FeedbackRouter chokepoint after every committed
 * write, broadcast on the project-scoped feedback subscription
 * (cyboflow.feedback.onFeedbackChanged). Carries the full updated rows for the
 * touched document so subscribers replace state without a refetch.
 */
export interface FeedbackChangedEvent {
  projectId: number;
  runId: string;
  atype: FeedbackAtype;
  sourceRef: string;
  comments: FeedbackComment[];
  batches: FeedbackBatch[];
}

/** Reasons a send-feedback request is refused without starting a revision. */
export type SendFeedbackNoOpReason =
  /** Run row missing. */
  | 'not_found'
  /** Run is not parked in awaiting_review. */
  | 'not_parked'
  /** No pending blocking decision gate is open for the run. */
  | 'no_gate'
  /** The idea has been decomposed (approve-plan passed) — the document can no longer influence the decision. */
  | 'decomposed'
  /** No draft comments exist for the document. */
  | 'no_comments'
  /** A revision batch for this document is already pending. */
  | 'busy';

export type SendFeedbackResult =
  | { sent: true; batchId: string; round: number }
  | { noOp: true; reason: SendFeedbackNoOpReason };

/**
 * Stable content hash for CommentAnchor.bodyHash — FNV-1a 32-bit over UTF-16
 * code units, hex-encoded. Pure and dependency-free so the renderer (anchor
 * capture) and main process (staleness checks) compute identical values.
 */
export function hashDocumentText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
