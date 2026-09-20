/**
 * monitorActionSinks — the composition-root collaborators for the supervisor's
 * AUTONOMOUS actions on the programmatic plane: the lane-triage trio (read a
 * task, adjust its body, audit the rescue), the two review-loop sinks (audit the
 * consult, file a set-aside entry), and the escalation-review pair (read the
 * run's review queue for a gate consult, annotate the gate with its verdict).
 *
 * WHY A MODULE AND NOT index.ts. These are built where the `TaskMutationDeps`
 * and review-queue seams the monitor's own chat actions use are built, so that
 * every backlog write still lands on the `TaskChangeRouter` chokepoint and every
 * audit note on the same `ReviewItemRouter` seam — reusing those objects rather
 * than minting parallel ones is the whole point. That block lives deep inside
 * `initializeServices()`, which sits AT its file-size ratchet cap (issue #19),
 * so the LOGIC lives here and index.ts keeps only the one-line construction.
 *
 * ACTORS, deliberately different per sink:
 *   - `monitor`      — the supervisor's own audit trail (review-loop consults).
 *                      It is the supervisor speaking about its own decision.
 *   - `orchestrator` — the lane-rescue audit and the SET-ASIDE findings. A
 *                      set-aside finding must be indistinguishable from the
 *                      accepted-risk finding the approve-design gate files for
 *                      the same `AR-n` entry, or `filedAdversarialIds` would
 *                      stop deduping and the human would see it twice.
 *
 * FAIL-SOFT is the CALLER's contract, not this module's: every sink is awaited
 * by a host method that already wraps it in try/catch, so a throw here degrades
 * one record, never a decision.
 *
 * Standalone-typecheck invariant: no imports from 'electron' or 'better-sqlite3'.
 */
import type { DatabaseLike, LoggerLike } from './types';
import type { ReviewItemRouter } from './reviewItemRouter';
import { selectTaskById } from './taskListing';
import {
  adjustRunTaskForLaneTriage,
  type TaskMutationDeps,
  type TaskMutationResult,
} from './taskMutationHandler';
import {
  ADVERSARIAL_FINDING_CATEGORY,
  ADVERSARIAL_FINDING_SOURCE,
  filedAdversarialIds,
  renderAcceptedRiskBody,
} from './gateSideEffects';
import { adversarialSeverityToReviewSeverity } from '../../../shared/types/adversarialReview';
import type {
  LaneTriageAdjustResult,
  LaneTriageTaskFacts,
} from './programmatic/programmaticRunHost';
import { ESCALATION_REVIEW_ITEM_CAP } from './programmatic/programmaticRunHost';
import type { EscalationReviewItemSummary, SetAsideFindingInput } from './programmatic/types';
import { SUPERVISOR_RECOMMENDATION_HEADING } from '../../../shared/types/reviews';
import type { ReviewItemKind } from '../../../shared/types/reviews';

/**
 * The autonomous LANE-RESCUE collaborators, keyed by run id because the runner
 * binds one host per run but this bag is built once for the process.
 *
 * Every method is run-scoped through its `runId` argument rather than captured,
 * for the same reason: `DefaultProgrammaticRunner` is constructed EARLY in
 * `initializeServices`, while the deps these reuse are built in a later nested
 * block, so the runner reaches them through a late-bound holder.
 */
export interface LaneTriageActions {
  /** Enrich a bare fan-out item id with the task's ref/title/current body. */
  readTask(runId: string, itemId: string): LaneTriageTaskFacts | undefined;
  /** Apply the monitor's `adjust_and_retry` body replacement (a refusal is ok:false). */
  adjustTask(runId: string, input: { taskRef: string; body: string }): Promise<LaneTriageAdjustResult>;
  /** File the non-blocking audit record for one autonomous rescue. */
  fileFinding(runId: string, input: { title: string; body: string }): Promise<void>;
}

/** Everything the sinks in this module need from the composition root. */
export interface MonitorActionSinkDeps {
  db: DatabaseLike;
  /** A run's project id — review items are project-scoped. */
  runProjectId: (runId: string) => number | undefined;
  /** The review-item chokepoint. */
  applyReviewItem: ReviewItemRouter['applyReviewItem'];
  /** The SAME TaskMutationDeps the monitor's chat `edit_task` action routes through. */
  taskMutations: TaskMutationDeps;
  /**
   * Human-readable text for a refused task mutation — index.ts's `mapTaskResult`
   * message, injected so the host's downgrade note and the audit finding read
   * exactly like the chat action's refusal.
   */
  describeTaskFailure: (result: TaskMutationResult) => string;
  logger?: LoggerLike;
}

/**
 * Build the lane-triage trio over the shared deps.
 *
 * `readTask` is fail-soft (the consult still runs with an empty body — it just
 * cannot end in an adjust); `adjustTask` reports a refusal rather than throwing,
 * because the host DOWNGRADES a refused adjust to a plain rescue instead of
 * abandoning it; `fileFinding` is the non-blocking audit record — never
 * blocking, because a rescue that PARKED the run would defeat the point of
 * self-healing, and nothing merges without the run's existing human gate anyway.
 */
export function buildLaneTriageActions(deps: MonitorActionSinkDeps): LaneTriageActions {
  return {
    // The controller only ever holds opaque fan-out item ids; the host needs the
    // task's ref/title/CURRENT body to ask the monitor whether the acceptance
    // criteria conflict with repo reality.
    readTask: (_runId, itemId) => {
      try {
        const task = selectTaskById(deps.db, itemId);
        if (!task) return undefined;
        return {
          ...(task.ref ? { taskRef: task.ref } : {}),
          ...(task.title ? { taskTitle: task.title } : {}),
          ...(task.body ? { taskBody: task.body } : {}),
        };
      } catch (err) {
        deps.logger?.warn('[monitorActionSinks] lane-triage task read failed (fail-soft)', {
          itemId,
          error: err instanceof Error ? err.message : String(err),
        });
        return undefined;
      }
    },
    // The monitor's AUTONOMOUS requirements adjustment. adjustRunTaskForLaneTriage
    // is body-only and deliberately bypasses edit_task's queued-only lane guard
    // (safe because lane prompts re-read the body per spawn and the host always
    // pairs the edit with a lane rewind) — but it still routes through the SAME
    // TaskChangeRouter chokepoint via the SAME deps object edit_task uses.
    adjustTask: async (runId, input) => {
      const result = await adjustRunTaskForLaneTriage(runId, input, deps.taskMutations);
      if (result.ok) return { ok: true };
      return { ok: false, reason: deps.describeTaskFailure(result) };
    },
    fileFinding: async (runId, input) => {
      const projectId = deps.runProjectId(runId);
      if (projectId === undefined) return;
      await deps.applyReviewItem(projectId, {
        op: 'create',
        actor: 'orchestrator',
        kind: 'finding',
        title: input.title,
        body: input.body,
        severity: 'info',
        blocking: false,
        source: 'monitor',
        runId,
      });
    },
  };
}

/**
 * Build the SUPERVISOR-AUDIT sink: one non-blocking finding per review-loop
 * consult, recording a decision the human never confirmed.
 *
 * Actor `monitor` (not `orchestrator`): this is the supervisor accounting for
 * its OWN judgement, and the review queue's audit view should be able to tell
 * that apart from a mechanical write the orchestrator made.
 */
export function buildMonitorFindingSink(
  deps: MonitorActionSinkDeps,
): (runId: string, input: { title: string; body: string; category?: string }) => Promise<void> {
  return async (runId, input) => {
    const projectId = deps.runProjectId(runId);
    if (projectId === undefined) return;
    await deps.applyReviewItem(projectId, {
      op: 'create',
      actor: 'monitor',
      kind: 'finding',
      title: input.title,
      body: input.body,
      severity: 'info',
      blocking: false,
      source: 'monitor',
      runId,
      ...(input.category !== undefined
        ? { payload: { kind: 'finding' as const, category: input.category } }
        : {}),
    });
  };
}

/**
 * Build the SET-ASIDE sink: one non-blocking finding per adversarial-review
 * entry the supervisor excluded from a lap.
 *
 * Composed to be INDISTINGUISHABLE from the accepted-risk finding the
 * approve-design gate files for the same entry — same `AR-n — title` shape (the
 * idempotence key `gateSideEffects.filedAdversarialIds` reads off the title),
 * same source, same category, same severity mapping, same `proposedTarget`. That
 * is what stops the gate from filing the entry a second time when the human
 * later approves, which would present one defect as two.
 *
 * The body leads with the supervisor's reason so the finding reads as what it is
 * — an entry somebody deliberately deferred — before the reviewer's own words.
 *
 * IDEMPOTENT by `AR-n` prefix within the run, off the SAME probe the gate arm
 * uses: the supervisor votes once per round and may set the same entry aside on
 * every one of them, so without this a three-lap loop files one deferral three
 * times. Fail-soft in the same direction as the gate's — an unreadable history
 * reads as "nothing filed", because a duplicate is recoverable and a dropped
 * set-aside is not.
 */
export function buildSetAsideFindingSink(
  deps: MonitorActionSinkDeps,
): (runId: string, input: SetAsideFindingInput) => Promise<void> {
  return async (runId, { entry, reason, round }) => {
    const projectId = deps.runProjectId(runId);
    if (projectId === undefined) return;
    if (filedAdversarialIds(deps.db, runId).has(entry.id)) {
      deps.logger?.info('[monitorActionSinks] set-aside entry already filed for this run; skipping the duplicate', {
        runId,
        arId: entry.id,
        round,
      });
      return;
    }
    const body = `Set aside by the supervisor on round ${round}: ${reason}\n\n${renderAcceptedRiskBody(entry)}`;
    await deps.applyReviewItem(projectId, {
      op: 'create',
      actor: 'orchestrator',
      kind: 'finding',
      title: `${entry.id} — ${entry.title}`,
      body,
      blocking: false,
      severity: adversarialSeverityToReviewSeverity(entry.severity),
      source: ADVERSARIAL_FINDING_SOURCE,
      runId,
      payload: {
        kind: 'finding',
        category: ADVERSARIAL_FINDING_CATEGORY,
        ...(entry.fix !== undefined ? { suggestedFix: entry.fix } : {}),
        proposedTarget: 'backlog',
      },
    });
  };
}

/**
 * The two ESCALATION-REVIEW collaborators: read this run's review queue for the
 * gate consult, and write the supervisor's recommendation back onto the gate
 * item.
 *
 * Run-scoped through their arguments, like {@link LaneTriageActions}, and for
 * the same reason (built once for the process, bound per run by the runner).
 */
export interface GateEscalationSinks {
  /** This run's review-queue rows as the consult sees them (≤ the cap, newest first). */
  listRunReviewItems(runId: string): Promise<EscalationReviewItemSummary[]>;
  /** Upsert the recommendation section into a PENDING item's body. */
  annotate(runId: string, input: { reviewItemId: string; markdown: string }): Promise<void>;
}

/** One `review_items` row as the escalation query selects it. */
interface EscalationRow {
  id?: unknown;
  kind?: unknown;
  source?: unknown;
  severity?: unknown;
  status?: unknown;
  title?: unknown;
}

/** A DB column that is actually a non-empty string, else null. */
function nullableStr(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Build the escalation-review sinks over the shared deps.
 *
 * The READ is a direct `review_items` SELECT rather than a router call: it is a
 * read, and the chokepoint rule governs WRITES. Its predicate is deliberately
 * two-armed — every PENDING row of this run, plus every `monitor`-sourced row
 * whatever its status. The second arm is the point of CR-9: an audit finding a
 * human already triaged still describes something this run did unattended, and
 * the gate reviewer is exactly the person who should see it. Newest first so the
 * cap drops the oldest context, not the freshest.
 *
 * The WRITE goes through the `annotate` op on the SAME `ReviewItemRouter` seam
 * every other sink here uses. It does NOT swallow the router's refusal: the host
 * distinguishes the expected `invalid_status` race (the human answered first)
 * from a real failure, and can only do that if the error reaches it.
 */
export function buildGateEscalationSinks(deps: MonitorActionSinkDeps): GateEscalationSinks {
  return {
    listRunReviewItems: async (runId) => {
      try {
        const rows = deps.db
          .prepare(
            `SELECT id, kind, source, severity, status, title
               FROM review_items
              WHERE run_id = ? AND (status = 'pending' OR source = 'monitor')
              ORDER BY created_at DESC, id DESC
              LIMIT ?`,
          )
          .all(runId, ESCALATION_REVIEW_ITEM_CAP) as EscalationRow[];
        return rows.map((row) => ({
          id: typeof row.id === 'string' ? row.id : '',
          kind: (typeof row.kind === 'string' ? row.kind : 'finding') as ReviewItemKind,
          source: nullableStr(row.source),
          severity: nullableStr(row.severity),
          status: typeof row.status === 'string' ? row.status : 'pending',
          title: typeof row.title === 'string' ? row.title : '',
        }));
      } catch (err) {
        // Fail-soft: the consult still runs, just without the queue context. A
        // thrown read here must never cost a gate its recommendation.
        deps.logger?.warn('[monitorActionSinks] escalation review-item read failed (fail-soft)', {
          runId,
          error: err instanceof Error ? err.message : String(err),
        });
        return [];
      }
    },
    annotate: async (runId, input) => {
      const projectId = deps.runProjectId(runId);
      if (projectId === undefined) return;
      await deps.applyReviewItem(projectId, {
        op: 'annotate',
        actor: 'monitor',
        reviewItemId: input.reviewItemId,
        heading: SUPERVISOR_RECOMMENDATION_HEADING,
        markdown: input.markdown,
        runId,
      });
    },
  };
}
