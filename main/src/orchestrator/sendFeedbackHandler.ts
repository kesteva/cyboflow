/**
 * sendFeedbackHandler — the guarded entry point behind the
 * cyboflow.feedback.sendBatch mutation (IDEA-033).
 *
 * "Send feedback" is only honoured while the document can still influence the
 * pending decision: the run must be parked in awaiting_review at a blocking
 * decision gate, and the owning idea must not yet be decomposed (approve-plan
 * passed). When the guard chain clears, it mints a batch via the FeedbackRouter
 * chokepoint and FIRES a host-driven revision (runRevisionBatch, injected as
 * `launchRevision`) DETACHED — the mutation returns immediately with the batch id
 * and the UI tracks progress over the feedback subscription. Refusals are DATA
 * (`{ noOp, reason }`), never thrown errors.
 *
 * Mirrors nudgeRunHandler.ts: a standalone module with every collaborator injected
 * via SendFeedbackDeps, carrying the standalone-typecheck invariant (no imports
 * from 'electron', 'better-sqlite3', or main/src/services/*) so it is unit-testable
 * without the tRPC context/router.
 */
import type { DatabaseLike, LoggerLike } from './types';
import type {
  FeedbackAtype,
  SendFeedbackNoOpReason,
  SendFeedbackResult,
} from '../../../shared/types/feedback';

// ---------------------------------------------------------------------------
// Collaborator interfaces (injected; the concrete singletons satisfy them)
// ---------------------------------------------------------------------------

/**
 * Narrow slice of FeedbackRouter: mint a batch (send-batch) plus the belt-and-
 * braces batch-failed flip for a launch that never even started. The concrete
 * FeedbackRouter.apply overloads satisfy both structurally.
 */
export interface SendFeedbackRouterLike {
  apply(
    projectId: number,
    change: { op: 'send-batch'; runId: string; atype: FeedbackAtype; sourceRef: string },
  ): Promise<{ batchId: string; round: number; commentIds: string[] }>;
  apply(
    projectId: number,
    change: { op: 'batch-failed'; batchId: string; error: string },
  ): Promise<unknown>;
}

/** Identity of the minted batch handed to the detached revision launcher. */
export interface RevisionBatchInfo {
  projectId: number;
  runId: string;
  batchId: string;
  atype: FeedbackAtype;
  sourceRef: string;
  round: number;
  commentIds: string[];
}

export interface SendFeedbackDeps {
  db: DatabaseLike;
  feedbackRouter: SendFeedbackRouterLike;
  /** Fire the host-driven revision for the minted batch (bound to runRevisionBatch). */
  launchRevision: (info: RevisionBatchInfo) => Promise<void>;
  logger?: LoggerLike;
}

export interface SendFeedbackInput {
  runId: string;
  atype: FeedbackAtype;
  /** The owning idea id (feedback source_ref IS the idea id). */
  sourceRef: string;
}

// ---------------------------------------------------------------------------
// Revision-launcher registry
// ---------------------------------------------------------------------------
//
// The production `launchRevision` closure binds runRevisionBatch to
// makeRevisionQuery (a service import) + TaskChangeRouter, so it CANNOT be built
// inside the standalone-typecheck-invariant tRPC router. index.ts wires it here at
// boot; the feedback router reads it via getRevisionLauncher() to assemble deps.

let launchRevisionImpl: ((info: RevisionBatchInfo) => Promise<void>) | null = null;

/** Register the production revision launcher (called once from main/src/index.ts). */
export function setRevisionLauncher(fn: (info: RevisionBatchInfo) => Promise<void>): void {
  launchRevisionImpl = fn;
}

/** Read the wired revision launcher. Throws if boot wiring has not run. */
export function getRevisionLauncher(): (info: RevisionBatchInfo) => Promise<void> {
  if (!launchRevisionImpl) {
    throw new Error(
      'revision launcher not wired. Call setRevisionLauncher() from main/src/index.ts.',
    );
  }
  return launchRevisionImpl;
}

/** Reset the registry — intended for tests only. */
export function _resetRevisionLauncherForTesting(): void {
  launchRevisionImpl = null;
}

// ---------------------------------------------------------------------------
// Internal row types
// ---------------------------------------------------------------------------

interface RunRow {
  project_id: number;
  status: string;
  worktree_path: string | null;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

function noOp(reason: SendFeedbackNoOpReason): SendFeedbackResult {
  return { noOp: true, reason };
}

/** Map a FeedbackError-shaped rejection code to a send-feedback no-op reason. */
function feedbackErrorReason(err: unknown): SendFeedbackNoOpReason | null {
  if (typeof err !== 'object' || err === null || !('code' in err)) return null;
  const code = (err as { code?: unknown }).code;
  if (code === 'busy') return 'busy';
  if (code === 'no_comments') return 'no_comments';
  return null;
}

/**
 * Guard a "send feedback" request and, on success, fire the revision detached.
 *
 * Guard chain (against the injected db):
 *   1. run row missing                                  → { noOp: 'not_found' }
 *   2. status !== awaiting_review                       → { noOp: 'not_parked' }
 *   3. no pending blocking decision gate for the run    → { noOp: 'no_gate' }
 *   4. idea row missing                                 → { noOp: 'not_found' }
 *      idea.decomposed_at non-null                      → { noOp: 'decomposed' }
 *   5. FeedbackRouter send-batch: 'busy' / 'no_comments' mapped; other errors rethrow.
 *   6. success → fire launchRevision detached, return { sent, batchId, round }.
 */
export async function sendFeedbackHandler(
  input: SendFeedbackInput,
  deps: SendFeedbackDeps,
): Promise<SendFeedbackResult> {
  const { db, feedbackRouter, launchRevision, logger } = deps;
  const { runId, atype, sourceRef } = input;

  // 1 + 2: run parked?
  const run = db
    .prepare('SELECT project_id, status, worktree_path FROM workflow_runs WHERE id = ?')
    .get(runId) as RunRow | undefined;
  if (!run) return noOp('not_found');
  if (run.status !== 'awaiting_review') return noOp('not_parked');

  // 3: a blocking decision gate must be open (the document can still influence it).
  const gate = db
    .prepare(
      `SELECT 1 AS ok FROM review_items
        WHERE run_id = ? AND kind = 'decision' AND status = 'pending' AND blocking = 1
        LIMIT 1`,
    )
    .get(runId) as { ok: number } | undefined;
  if (!gate) return noOp('no_gate');

  // 4: the owning idea must exist and not be decomposed.
  const idea = db
    .prepare('SELECT decomposed_at FROM ideas WHERE id = ?')
    .get(sourceRef) as { decomposed_at: string | null } | undefined;
  if (!idea) return noOp('not_found');
  if (idea.decomposed_at !== null) return noOp('decomposed');

  // 5: mint the batch through the chokepoint.
  let batchId: string;
  let round: number;
  let commentIds: string[];
  try {
    const result = await feedbackRouter.apply(run.project_id, {
      op: 'send-batch',
      runId,
      atype,
      sourceRef,
    });
    batchId = result.batchId;
    round = result.round;
    commentIds = result.commentIds;
  } catch (err) {
    const reason = feedbackErrorReason(err);
    if (reason) return noOp(reason);
    throw err;
  }

  // 6: fire the revision DETACHED — the mutation returns immediately. runRevisionBatch
  // never throws, so the .catch is belt-and-braces (flip the batch failed if the
  // launch itself could not even start).
  void launchRevision({
    projectId: run.project_id,
    runId,
    batchId,
    atype,
    sourceRef,
    round,
    commentIds,
  }).catch(async (err: unknown) => {
    logger?.error('[sendFeedback] launchRevision rejected before completing', {
      batchId,
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      await feedbackRouter.apply(run.project_id, {
        op: 'batch-failed',
        batchId,
        error: 'the revision could not be started',
      });
    } catch (flipErr) {
      logger?.error('[sendFeedback] belt-and-braces batch-failed flip threw (swallowed)', {
        batchId,
        error: flipErr instanceof Error ? flipErr.message : String(flipErr),
      });
    }
  });

  return { sent: true, batchId, round };
}
