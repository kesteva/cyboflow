/**
 * humanPrerequisites — surface the HUMAN work a freshly-minted sprint batch
 * depends on, as standing review-queue items (migration 137).
 *
 * THE PROBLEM. A `human` task is real work with real acceptance criteria that
 * no agent can do — an account, a purchase, a physical device, a legal
 * sign-off. Agent tasks legitimately depend on its output, and the dependency
 * analyzer records those edges because they are board truth. But a human task
 * never becomes a sprint lane (SprintLaneStore.filterEligibleTaskIds excludes
 * it), so nothing in the sprint will ever move it to Done, and its edge is
 * therefore deliberately NON-GATING (taskListing.foldDependencyRows). That is
 * the right call for scheduling — and it means the human work would otherwise
 * be invisible at exactly the moment it starts to matter. This is the surface
 * that makes it visible.
 *
 * WHAT IT WRITES. One NON-BLOCKING `human_task` review item per human
 * prerequisite, entity-linked to that task, listing the batch tasks waiting on
 * it. Non-blocking is deliberate: the sprint does NOT wait: agent lanes proceed
 * with a stub, an env var, or a feature flag, exactly as the task prompts
 * instruct, and the item is the human's to-do, not a gate on the machine.
 *
 * IDEMPOTENCE. Keyed on `source = 'human-task:<humanTaskId>'` through
 * ReviewItemRouter.createIfNoPending, which does the check and the create as ONE
 * task on the per-project queue. The key is PER HUMAN TASK, not per batch: a
 * second batch that depends on the same human task must not mint a second copy
 * of the same to-do. Two sessions racing, or a rewind re-running createForRun,
 * both collapse onto the one pending item.
 *
 * WHAT IT SKIPS. An archived human task, and one already sitting at a terminal
 * board stage (Done / Won't do) — the work is finished or abandoned, and
 * re-raising it would be noise. Note the asymmetry with readiness: a terminal
 * human prerequisite still does not gate (it never did), it simply has nothing
 * left to ask a human for.
 */
import type { DatabaseLike, LoggerLike } from './types';
import type { ReviewItemRouter } from './reviewItemRouter';

/** One human prerequisite + the batch tasks blocked on it. */
interface HumanPrerequisite {
  humanTaskId: string;
  humanRef: string;
  humanTitle: string;
  /** Refs of the batch tasks that record a blocking edge to this human task. */
  dependentRefs: string[];
}

interface PrereqEdgeRow {
  human_task_id: string;
  human_ref: string;
  human_title: string;
  dependent_ref: string;
}

export interface SurfaceHumanPrerequisitesArgs {
  projectId: number;
  batchId: string;
  /** The batch's materialized task ids (createForRun's post-filter set). */
  taskIds: string[];
}

/**
 * Every human prerequisite of the given batch tasks, with its dependents.
 *
 * Only `blocking` edges count — a `related` edge is advisory metadata and
 * carries no claim that anyone is waiting. Archived and terminal-stage human
 * tasks are filtered in SQL. Returns [] on any schema that predates the
 * `executor` column, which is correct: no task can be human before 137.
 */
function loadHumanPrerequisites(
  db: DatabaseLike,
  taskIds: string[],
  logger?: LoggerLike,
): HumanPrerequisite[] {
  if (taskIds.length === 0) return [];
  try {
    const placeholders = taskIds.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT h.id    AS human_task_id,
                h.ref   AS human_ref,
                h.title AS human_title,
                b.ref   AS dependent_ref
           FROM task_dependencies d
           JOIN tasks b ON b.id = d.task_id
           JOIN tasks h ON h.id = d.depends_on_task_id
           LEFT JOIN board_stages bs ON bs.id = h.stage_id
          WHERE d.kind = 'blocking'
            AND d.task_id IN (${placeholders})
            AND h.executor = 'human'
            AND h.archived_at IS NULL
            AND COALESCE(bs.is_terminal, 0) = 0
          ORDER BY h.ref ASC, b.ref ASC`,
      )
      .all(...taskIds) as PrereqEdgeRow[];

    const byHumanTask = new Map<string, HumanPrerequisite>();
    for (const row of rows) {
      let entry = byHumanTask.get(row.human_task_id);
      if (!entry) {
        entry = {
          humanTaskId: row.human_task_id,
          humanRef: row.human_ref,
          humanTitle: row.human_title,
          dependentRefs: [],
        };
        byHumanTask.set(row.human_task_id, entry);
      }
      entry.dependentRefs.push(row.dependent_ref);
    }
    return [...byHumanTask.values()];
  } catch (err) {
    if (err instanceof Error && /no such (column|table)/i.test(err.message)) {
      logger?.debug('[humanPrerequisites] scan skipped (pre-137 schema)', { error: err.message });
      return [];
    }
    throw err;
  }
}

/** The review-item body for one human prerequisite. */
function composeBody(prereq: HumanPrerequisite): string {
  const waiting =
    prereq.dependentRefs.length === 1
      ? `${prereq.dependentRefs[0]} depends on this work.`
      : `${prereq.dependentRefs.length} sprint tasks depend on this work: ${prereq.dependentRefs.join(', ')}.`;
  return [
    `**${prereq.humanRef} — ${prereq.humanTitle}** is a human task: work only a person can do.`,
    '',
    waiting,
    '',
    'The sprint continues without waiting; mark this task done on the board when the work is finished.',
  ].join('\n');
}

/**
 * Mint one standing `human_task` review item per human prerequisite of a
 * freshly-minted sprint batch. Wired as SprintLaneStore's `onBatchMinted` dep.
 *
 * FAIL-SOFT per item: one item that cannot be written must not stop the others,
 * and none of them may stop a sprint that has already materialized. The store's
 * hook contract swallows a throw from this function too, so this is defence in
 * depth rather than the only guard.
 *
 * @returns the number of items actually created (an already-pending item counts
 *          as zero — nothing was written).
 */
export async function surfaceHumanPrerequisites(
  db: DatabaseLike,
  reviewRouter: Pick<ReviewItemRouter, 'createIfNoPending'>,
  args: SurfaceHumanPrerequisitesArgs,
  logger?: LoggerLike,
): Promise<number> {
  const prereqs = loadHumanPrerequisites(db, args.taskIds, logger);
  if (prereqs.length === 0) return 0;

  let created = 0;
  for (const prereq of prereqs) {
    try {
      const result = await reviewRouter.createIfNoPending(args.projectId, {
        op: 'create',
        actor: 'orchestrator',
        kind: 'human_task',
        title: `Human work: ${prereq.humanRef} ${prereq.humanTitle}`,
        body: composeBody(prereq),
        // NEVER blocking — see the module docblock. The sprint proceeds.
        blocking: false,
        // Keyed on the HUMAN TASK, not the batch: a second batch depending on
        // the same human work must not mint a second copy of the same to-do.
        source: `human-task:${prereq.humanTaskId}`,
        entityType: 'task',
        entityId: prereq.humanTaskId,
        payload: { kind: 'human_task' },
      });
      if (result.created) created += 1;
    } catch (err) {
      logger?.warn('[humanPrerequisites] failed to surface a human prerequisite (ignored)', {
        batchId: args.batchId,
        humanTaskId: prereq.humanTaskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (created > 0) {
    logger?.info('[humanPrerequisites] surfaced human prerequisites for a sprint batch', {
      batchId: args.batchId,
      projectId: args.projectId,
      created,
      candidates: prereqs.length,
    });
  }
  return created;
}

/**
 * The SprintLaneStore `onBatchMinted` hook, ready to inject: fires AFTER
 * createForRun commits and turns the batch's human prerequisites into standing
 * review items — the only place that work becomes visible, since a human task
 * never gets a lane and its blocking edge is deliberately non-gating. Async and
 * fail-soft on BOTH sides (the store swallows a synchronous throw; the .catch
 * here swallows a rejection), because a sprint that has already materialized
 * must never be failed by a side-effect.
 */
export function humanPrerequisiteSink(
  db: DatabaseLike,
  reviewRouter: Pick<ReviewItemRouter, 'createIfNoPending'>,
  logger?: LoggerLike,
): (args: SurfaceHumanPrerequisitesArgs) => void {
  return (args) => {
    void surfaceHumanPrerequisites(db, reviewRouter, args, logger).catch((err: unknown) => {
      logger?.warn('[Cyboflow] human-prerequisite surfacing failed (ignored)', {
        batchId: args.batchId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  };
}
