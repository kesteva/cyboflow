/**
 * HumanTasksSection + ./humanTasks — the backlog-sourced "Human tasks" band.
 *
 *  - selectPendingHumanTasks keeps approved, unarchived, non-terminal human tasks only;
 *  - the kickoff prompt carries each task's body, id, and Done stage id;
 *  - "Mark complete" moves every selected task to its board's Done stage;
 *  - Verify / Help open ONE in-place session over the selection;
 *  - a cross-project selection prompts for a single project instead of launching,
 *    and picking one narrows the selection and launches into that project.
 */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BacklogTaskItem, Board } from '../../../../../shared/types/tasks';

const { setStageMock, startWithKickoffMock, setActiveProjectIdMock } = vi.hoisted(() => ({
  setStageMock: vi.fn().mockResolvedValue({ taskId: 'x' }),
  startWithKickoffMock: vi.fn().mockResolvedValue(undefined),
  setActiveProjectIdMock: vi.fn(),
}));

vi.mock('../../../trpc/client', () => ({
  trpc: { cyboflow: { tasks: { setStage: { mutate: setStageMock } } } },
}));
vi.mock('../../../hooks/useQuickSession', () => ({
  useQuickSession: () => ({ startWithKickoff: startWithKickoffMock, isStarting: false, error: null }),
}));
vi.mock('../../../hooks/useReviewItemActions', () => ({
  useReviewItemActions: () => ({ resolve: vi.fn(), pendingItemId: null }),
}));
vi.mock('../../../stores/navigationStore', () => ({
  useNavigationStore: { getState: () => ({ setActiveProjectId: setActiveProjectIdMock, goToSession: vi.fn() }) },
}));

import { HumanTasksSection } from '../HumanTasksSection';
import { buildHumanTaskKickoff, dependentsByHumanRef, selectPendingHumanTasks } from '../humanTasks';

function makeBoard(projectId: number): Board {
  const stage = (position: number, isTerminal: boolean) => ({
    id: `b${projectId}-s${position}`,
    label: `S${position}`,
    color_oklch: '',
    hint: null,
    position,
    write_policy: 'user' as Board['stages'][number]['write_policy'],
    is_terminal: isTerminal,
    hidden_by_default: false,
  });
  return {
    id: `board-${projectId}`,
    project_id: projectId,
    name: 'Default',
    kind: 'default',
    is_default: true,
    stages: [stage(6, false), stage(9, true), stage(10, true)],
  };
}

function makeTask(overrides: Partial<BacklogTaskItem> & { id: string }): BacklogTaskItem {
  const projectId = overrides.project_id ?? 1;
  return {
    type: 'task',
    project_id: projectId,
    ref: `TASK-${overrides.id}`,
    title: `Task ${overrides.id}`,
    summary: null,
    body: null,
    priority: 'P2',
    category: 'feature',
    executor: 'human',
    repo: null,
    parent_epic_id: null,
    originating_idea_id: null,
    scope: null,
    board_id: `board-${projectId}`,
    stage_id: `b${projectId}-s6`,
    archived_at: null,
    decomposed_at: null,
    approved_at: '2026-07-01T00:00:00.000Z',
    sort_order: null,
    version: 3,
    stage_position: 6,
    inFlow: [],
    awaitingReview: false,
    isDone: false,
    memberships: [],
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  } as BacklogTaskItem;
}

const BOARDS = [makeBoard(1), makeBoard(2)];

function renderSection(tasks: BacklogTaskItem[]) {
  return render(
    <HumanTasksSection
      tasks={tasks}
      dependentsByHumanRef={new Map()}
      boards={BOARDS}
      actionItems={[]}
      projectNameById={{ 1: 'alpha', 2: 'beta' }}
      nowMs={0}
      onResolved={vi.fn()}
    />,
  );
}

beforeEach(() => {
  setStageMock.mockClear();
  startWithKickoffMock.mockClear();
  setActiveProjectIdMock.mockClear();
});

describe('selectPendingHumanTasks', () => {
  it('keeps only approved, unarchived, non-terminal human tasks', () => {
    const tasks = [
      makeTask({ id: '1' }),
      makeTask({ id: '2', executor: 'agent' }),
      makeTask({ id: '3', approved_at: null }),
      makeTask({ id: '4', archived_at: '2026-07-02T00:00:00.000Z' }),
      makeTask({ id: '5', isDone: true, stage_id: 'b1-s9' }),
      makeTask({ id: '6', stage_id: 'b1-s10' }),
      makeTask({ id: '7', type: 'epic' }),
    ];
    expect(selectPendingHumanTasks(tasks, BOARDS).map((t) => t.id)).toEqual(['1']);
  });
});

describe('dependentsByHumanRef', () => {
  it('keys open dependents by project + human ref', () => {
    const map = dependentsByHumanRef([
      makeTask({ id: '8', executor: 'agent', waitingOnHuman: ['TASK-1'] }),
      makeTask({ id: '9', executor: 'agent', waitingOnHuman: ['TASK-1'], isDone: true }),
    ]);
    expect(map.get('1:TASK-1')).toEqual(['TASK-8']);
  });
});

describe('buildHumanTaskKickoff', () => {
  it('includes each task body, id, and Done stage id', () => {
    const prompt = buildHumanTaskKickoff(
      'verify',
      [makeTask({ id: '1', body: 'Create the Apple account' })],
      BOARDS,
    );
    expect(prompt).toContain('Verify it is actually complete');
    expect(prompt).toContain('### TASK-1 — Task 1');
    expect(prompt).toContain('Create the Apple account');
    expect(prompt).toContain('Task id: `1` · Done stage id: `b1-s9`');
  });
});

describe('HumanTasksSection', () => {
  it('renders nothing when there is no human work', () => {
    const { container } = renderSection([]);
    expect(container).toBeEmptyDOMElement();
  });

  it('marks every selected task complete at its Done stage', async () => {
    renderSection([makeTask({ id: '1' }), makeTask({ id: '2' })]);
    await userEvent.click(screen.getByLabelText('Select all human tasks'));
    await userEvent.click(screen.getByTestId('rq-human-tasks-mark-complete'));
    expect(setStageMock).toHaveBeenCalledTimes(2);
    expect(setStageMock).toHaveBeenCalledWith({ projectId: 1, taskId: '1', stageId: 'b1-s9', expectedVersion: 3 });
  });

  it('opens one in-place session over a single-project selection', async () => {
    renderSection([makeTask({ id: '1' }), makeTask({ id: '2' })]);
    await userEvent.click(screen.getByLabelText('Select TASK-1 Task 1'));
    await userEvent.click(screen.getByLabelText('Select TASK-2 Task 2'));
    await userEvent.click(screen.getByTestId('rq-human-tasks-help'));
    expect(startWithKickoffMock).toHaveBeenCalledTimes(1);
    const args = startWithKickoffMock.mock.calls[0][0];
    expect(args.projectId).toBe(1);
    expect(args.worktreeMode).toBe('in-place');
    expect(args.kickoffPrompt).toContain('TASK-1');
    expect(args.kickoffPrompt).toContain('TASK-2');
  });

  it('prompts for one project when the selection spans several, then launches the pick', async () => {
    renderSection([makeTask({ id: '1' }), makeTask({ id: '2', project_id: 2 })]);
    await userEvent.click(screen.getByLabelText('Select all human tasks'));
    await userEvent.click(screen.getByTestId('rq-human-tasks-verify'));
    expect(startWithKickoffMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('rq-human-tasks-cross-project')).toHaveTextContent('spans 2 projects');

    await userEvent.click(screen.getByRole('button', { name: 'beta (1)' }));
    expect(startWithKickoffMock).toHaveBeenCalledTimes(1);
    const args = startWithKickoffMock.mock.calls[0][0];
    expect(args.projectId).toBe(2);
    expect(args.kickoffPrompt).toContain('TASK-2');
    expect(args.kickoffPrompt).not.toContain('TASK-1 ');
    expect(setActiveProjectIdMock).toHaveBeenCalledWith(2);
  });
});
