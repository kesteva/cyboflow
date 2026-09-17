/**
 * BacklogSection — funnel counts, per-project selection locking, and the
 * Launch planner/sprint selection bars.
 */
import '@testing-library/jest-dom';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import type { BacklogTaskItem, Board } from '../../../../../shared/types/tasks';
import { BacklogSection } from '../BacklogSection';

function makeStage(position: number, id: string, label: string): Board['stages'][number] {
  return {
    id,
    label,
    color_oklch: 'oklch(0.6 0.1 250)',
    hint: null,
    position,
    write_policy: 'asserted',
    is_terminal: position === 9,
    hidden_by_default: false,
  } as Board['stages'][number];
}

function makeBoard(projectId: number): Board {
  return {
    id: `board-${projectId}`,
    project_id: projectId,
    name: 'Default',
    kind: 'default',
    is_default: true,
    stages: [
      makeStage(1, 'idea', 'Idea'),
      makeStage(6, 'ready', 'Ready for development'),
      makeStage(7, 'in-dev', 'In development'),
      makeStage(9, 'done', 'Done'),
    ],
  };
}

function makeTask(overrides: Partial<BacklogTaskItem> & { id: string; type: BacklogTaskItem['type'] }): BacklogTaskItem {
  const isEpicOrTask = overrides.type === 'epic' || overrides.type === 'task';
  return {
    project_id: 1,
    ref: `T-${overrides.id}`,
    title: overrides.title ?? `Item ${overrides.id}`,
    summary: null,
    body: null,
    priority: 'P2',
    category: 'feature',
    executor: 'agent',
    repo: null,
    parent_epic_id: null,
    originating_idea_id: null,
    scope: overrides.type === 'idea' ? null : null,
    board_id: `board-${overrides.project_id ?? 1}`,
    stage_id: overrides.type === 'idea' ? 'idea' : 'ready',
    archived_at: null,
    decomposed_at: null,
    approved_at: isEpicOrTask ? '2026-07-01T00:00:00.000Z' : null,
    sort_order: null,
    version: 1,
    stage_position: overrides.type === 'idea' ? 1 : 6,
    inFlow: [],
    awaitingReview: false,
    isDone: false,
    memberships: [],
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

const NOOP = (): void => {};

describe('BacklogSection', () => {
  it('renders funnel counts from a small fixture', () => {
    const tasks: BacklogTaskItem[] = [
      makeTask({ id: 'idea-1', type: 'idea' }),
      makeTask({ id: 'idea-2', type: 'idea' }),
      makeTask({ id: 'task-1', type: 'task', stage_position: 6 }),
      makeTask({ id: 'task-2', type: 'task', stage_position: 7 }),
      makeTask({ id: 'task-3', type: 'task', stage_position: 9, isDone: true }),
    ];
    render(
      <BacklogSection
        tasks={tasks}
        boards={[makeBoard(1)]}
        projectNameById={{ 1: 'proj-1' }}
        projectCount={1}
        variant="full"
        launchingColumn={null}
        onOpenBacklog={NOOP}
        onLaunchPlanner={NOOP}
        onLaunchSprint={NOOP}
      />,
    );

    const section = screen.getByTestId('rq-backlog-section');
    expect(within(section).getByText('Idea')).toBeInTheDocument();
    expect(within(section).getByText('Ready for development')).toBeInTheDocument();
    expect(within(section).getByText('In development')).toBeInTheDocument();
    expect(within(section).getByText('Done')).toBeInTheDocument();
    // Two ideas, one ready task, one in-dev task, one done task — 5 total items.
    expect(within(section).getByText('5')).toBeInTheDocument();
  });

  it('disables checkboxes for a different project once one item is selected', async () => {
    const user = userEvent.setup();
    const tasks: BacklogTaskItem[] = [
      makeTask({ id: 'idea-a', type: 'idea', project_id: 1, title: 'Idea A' }),
      makeTask({ id: 'idea-b', type: 'idea', project_id: 2, title: 'Idea B' }),
    ];
    render(
      <BacklogSection
        tasks={tasks}
        boards={[makeBoard(1), makeBoard(2)]}
        projectNameById={{ 1: 'proj-1', 2: 'proj-2' }}
        projectCount={2}
        variant="full"
        launchingColumn={null}
        onOpenBacklog={NOOP}
        onLaunchPlanner={NOOP}
        onLaunchSprint={NOOP}
      />,
    );

    const rowA = screen.getByText('Idea A').closest('label') as HTMLElement;
    const rowB = screen.getByText('Idea B').closest('label') as HTMLElement;
    const checkboxA = within(rowA).getByRole('checkbox');
    const checkboxB = within(rowB).getByRole('checkbox');

    expect(checkboxB).not.toBeDisabled();
    await user.click(checkboxA);
    expect(checkboxA).toBeChecked();
    expect(checkboxB).toBeDisabled();
    expect(rowB).toHaveAttribute('title', 'Launch is per-project');
  });

  it('shows the selection bar and passes selected ids + projectId to onLaunchPlanner', async () => {
    const user = userEvent.setup();
    const onLaunchPlanner = vi.fn();
    const tasks: BacklogTaskItem[] = [makeTask({ id: 'idea-a', type: 'idea', project_id: 1, title: 'Idea A' })];
    render(
      <BacklogSection
        tasks={tasks}
        boards={[makeBoard(1)]}
        projectNameById={{ 1: 'proj-1' }}
        projectCount={1}
        variant="full"
        launchingColumn={null}
        onOpenBacklog={NOOP}
        onLaunchPlanner={onLaunchPlanner}
        onLaunchSprint={NOOP}
      />,
    );

    expect(screen.queryByTestId('rq-launch-planner')).not.toBeInTheDocument();
    const row = screen.getByText('Idea A').closest('label') as HTMLElement;
    await user.click(within(row).getByRole('checkbox'));

    expect(screen.getByText('1 idea selected')).toBeInTheDocument();
    await user.click(screen.getByTestId('rq-launch-planner'));
    expect(onLaunchPlanner).toHaveBeenCalledWith(['idea-a'], 1);
  });

  it('passes selected task ids + projectId to onLaunchSprint', async () => {
    const user = userEvent.setup();
    const onLaunchSprint = vi.fn();
    const tasks: BacklogTaskItem[] = [
      makeTask({ id: 'task-a', type: 'task', project_id: 1, title: 'Task A', stage_position: 6 }),
    ];
    render(
      <BacklogSection
        tasks={tasks}
        boards={[makeBoard(1)]}
        projectNameById={{ 1: 'proj-1' }}
        projectCount={1}
        variant="full"
        launchingColumn={null}
        onOpenBacklog={NOOP}
        onLaunchPlanner={NOOP}
        onLaunchSprint={onLaunchSprint}
      />,
    );

    const row = screen.getByText('Task A').closest('label') as HTMLElement;
    await user.click(within(row).getByRole('checkbox'));
    await user.click(screen.getByTestId('rq-launch-sprint'));
    expect(onLaunchSprint).toHaveBeenCalledWith(['task-a'], 1);
  });

  it('funnel-only variant hides the pick columns', () => {
    const tasks: BacklogTaskItem[] = [makeTask({ id: 'idea-a', type: 'idea', title: 'Idea A' })];
    render(
      <BacklogSection
        tasks={tasks}
        boards={[makeBoard(1)]}
        projectNameById={{ 1: 'proj-1' }}
        projectCount={1}
        variant="funnel-only"
        launchingColumn={null}
        onOpenBacklog={NOOP}
        onLaunchPlanner={NOOP}
        onLaunchSprint={NOOP}
      />,
    );

    expect(screen.queryByTestId('rq-idea-row')).not.toBeInTheDocument();
    expect(screen.queryByText('Idea A')).not.toBeInTheDocument();
  });

  it('renders the bootstrap well for an empty backlog regardless of variant', () => {
    const onOpenBacklog = vi.fn();
    render(
      <BacklogSection
        tasks={[]}
        boards={[makeBoard(1)]}
        projectNameById={{ 1: 'proj-1' }}
        projectCount={1}
        variant="full"
        launchingColumn={null}
        onOpenBacklog={onOpenBacklog}
        onLaunchPlanner={NOOP}
        onLaunchSprint={NOOP}
      />,
    );

    expect(screen.getByTestId('rq-state-well-backlog-empty')).toBeInTheDocument();
    expect(screen.getByText('Backlog is empty')).toBeInTheDocument();
  });
});
