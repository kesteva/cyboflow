/**
 * attachHumanTaskReviewItemCloser — a human task's standing `human_task` review
 * item closes when the task finishes, by whichever writer finished it.
 *
 *  - Done resolves; Won't do (terminal, non-Done), archive, and delete dismiss;
 *  - a non-terminal human task, an agent task, and a task with no pending item
 *    write nothing;
 *  - the unsubscribe detaches the listener.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import { attachHumanTaskReviewItemCloser, humanTaskReviewSource } from '../humanTaskReviewItemCloser';
import { TASK_ALL_CHANNEL } from '../taskChangeRouter';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import type { BacklogTaskItem, TaskChangedEvent } from '../../../../shared/types/tasks';

function makeEvent(
  task: Partial<BacklogTaskItem>,
  action: TaskChangedEvent['action'] = 'stageMoved',
): TaskChangedEvent {
  return {
    projectId: 1,
    taskId: 'tsk_h',
    action,
    task: {
      id: 'tsk_h',
      type: 'task',
      executor: 'human',
      isDone: false,
      archived_at: null,
      stage_id: 'stage-open',
      ...task,
    } as BacklogTaskItem,
  };
}

describe('attachHumanTaskReviewItemCloser', () => {
  let events: EventEmitter;
  let db: Database.Database;
  let applyReviewItem: ReturnType<typeof vi.fn>;
  let findPendingBySource: ReturnType<typeof vi.fn>;
  let detach: () => void;

  beforeEach(() => {
    events = new EventEmitter();
    db = new Database(':memory:');
    db.exec('CREATE TABLE board_stages (id TEXT PRIMARY KEY, is_terminal INTEGER NOT NULL)');
    db.prepare('INSERT INTO board_stages VALUES (?, ?)').run('stage-open', 0);
    db.prepare('INSERT INTO board_stages VALUES (?, ?)').run('stage-wontdo', 1);
    applyReviewItem = vi.fn().mockResolvedValue({ reviewItemId: 'rvw_1', event: { id: 1, seq: 1 } });
    findPendingBySource = vi.fn().mockReturnValue('rvw_1');
    detach = attachHumanTaskReviewItemCloser(events, dbAdapter(db), { applyReviewItem, findPendingBySource });
  });

  afterEach(() => {
    detach();
    db.close();
  });

  it('resolves the pending item when the human task reaches Done', () => {
    events.emit(TASK_ALL_CHANNEL, makeEvent({ isDone: true }));
    expect(findPendingBySource).toHaveBeenCalledWith(1, humanTaskReviewSource('tsk_h'));
    expect(applyReviewItem).toHaveBeenCalledWith(1, {
      op: 'resolve',
      actor: 'orchestrator',
      reviewItemId: 'rvw_1',
      resolution: 'human-task:done',
    });
  });

  it.each([
    ['terminal non-Done stage', makeEvent({ stage_id: 'stage-wontdo' }), 'human-task:terminal'],
    ['archive', makeEvent({ archived_at: '2026-09-28T00:00:00.000Z' }, 'updated'), 'human-task:archived'],
    ['delete', makeEvent({}, 'deleted'), 'human-task:deleted'],
  ])('dismisses the pending item on %s', (_label, event, resolution) => {
    events.emit(TASK_ALL_CHANNEL, event);
    expect(applyReviewItem).toHaveBeenCalledWith(1, expect.objectContaining({ op: 'dismiss', resolution }));
  });

  it('writes nothing for an open human task', () => {
    events.emit(TASK_ALL_CHANNEL, makeEvent({}));
    expect(applyReviewItem).not.toHaveBeenCalled();
  });

  it('writes nothing for an agent task', () => {
    events.emit(TASK_ALL_CHANNEL, makeEvent({ executor: 'agent', isDone: true }));
    expect(findPendingBySource).not.toHaveBeenCalled();
    expect(applyReviewItem).not.toHaveBeenCalled();
  });

  it('writes nothing when no item is pending', () => {
    findPendingBySource.mockReturnValue(null);
    events.emit(TASK_ALL_CHANNEL, makeEvent({ isDone: true }));
    expect(applyReviewItem).not.toHaveBeenCalled();
  });

  it('stops listening once detached', () => {
    detach();
    events.emit(TASK_ALL_CHANNEL, makeEvent({ isDone: true }));
    expect(applyReviewItem).not.toHaveBeenCalled();
  });
});
