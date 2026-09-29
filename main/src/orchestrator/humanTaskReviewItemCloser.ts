/**
 * humanTaskReviewItemCloser — close a human task's standing `human_task` review
 * item once the task itself is finished.
 *
 * humanPrerequisites.ts mints one pending item per human prerequisite of a
 * sprint batch, keyed `source = 'human-task:<taskId>'`. The task is the truth
 * and the item only points at it, so the item must not outlive the work: a task
 * that reaches a terminal board stage (Done / Won't do), is archived, or is
 * deleted has nothing left to ask a human for. Listening on the task-change
 * stream (rather than patching each writer) covers every path that finishes a
 * task — the board, the Queue page's "Mark complete", and an agent calling
 * `cyboflow_set_task_stage` from a Verify / Help session.
 *
 * Done resolves the item; Won't do, archive, and delete dismiss it.
 */
import type { EventEmitter } from 'events';
import type { TaskChangedEvent } from '../../../shared/types/tasks';
import type { DatabaseLike, LoggerLike } from './types';
import type { ReviewItemRouter } from './reviewItemRouter';
import { TASK_ALL_CHANNEL } from './taskChangeRouter';

/** The `source` key humanPrerequisites mints a human task's review item under. */
export function humanTaskReviewSource(taskId: string): string {
  return `human-task:${taskId}`;
}

type Closure = { op: 'resolve' | 'dismiss'; resolution: string } | null;

/** How (if at all) this event finishes a human task's review item. Exported for tests. */
export function closureForEvent(db: DatabaseLike, event: TaskChangedEvent): Closure {
  const task = event.task;
  if (task.type !== 'task' || task.executor !== 'human') return null;
  if (event.action === 'deleted') return { op: 'dismiss', resolution: 'human-task:deleted' };
  if (task.isDone) return { op: 'resolve', resolution: 'human-task:done' };
  if (task.archived_at !== null) return { op: 'dismiss', resolution: 'human-task:archived' };
  const stage = db.prepare('SELECT is_terminal FROM board_stages WHERE id = ?').get(task.stage_id) as
    | { is_terminal: number }
    | undefined;
  if (stage?.is_terminal === 1) return { op: 'dismiss', resolution: 'human-task:terminal' };
  return null;
}

/**
 * Subscribe to the cross-project task stream. Fail-soft: a close that cannot be
 * written is logged, never thrown into the emitter. Returns the unsubscribe.
 */
export function attachHumanTaskReviewItemCloser(
  events: EventEmitter,
  db: DatabaseLike,
  reviewRouter: Pick<ReviewItemRouter, 'findPendingBySource' | 'applyReviewItem'>,
  logger?: LoggerLike,
): () => void {
  const listener = (event: TaskChangedEvent): void => {
    try {
      const closure = closureForEvent(db, event);
      if (closure === null) return;
      const reviewItemId = reviewRouter.findPendingBySource(event.projectId, humanTaskReviewSource(event.taskId));
      if (reviewItemId === null) return;
      reviewRouter
        .applyReviewItem(event.projectId, {
          op: closure.op,
          actor: 'orchestrator',
          reviewItemId,
          resolution: closure.resolution,
        })
        .catch((err: unknown) => {
          logger?.warn('[humanTaskReviewItemCloser] failed to close review item (ignored)', {
            taskId: event.taskId,
            reviewItemId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    } catch (err) {
      logger?.warn('[humanTaskReviewItemCloser] listener error (ignored)', {
        taskId: event.taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
  events.on(TASK_ALL_CHANNEL, listener);
  return () => {
    events.off(TASK_ALL_CHANNEL, listener);
  };
}
