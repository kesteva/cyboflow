/**
 * TaskCard scope badge — renders a compact S/L chip beside the priority tag
 * only when `task.scope` is set; absent (identical to today) when null.
 *
 * The backlog store is mocked to an empty-boards/empty-projects snapshot
 * (mirrors CardActionsMenu.test.tsx) so CardActionsMenu — a card descendant —
 * renders nothing and the project chip row stays hidden; the trpc client is
 * stubbed since it's imported by TaskCard/CardActionsMenu even though no call
 * fires on a plain render.
 */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import type { BacklogTaskItem } from '../../../../../shared/types/tasks';

vi.mock('../../../stores/backlogStore', () => {
  const useBacklogStore = (
    selector: (s: { boards: unknown[]; projects: unknown[]; filterProjectId: number | null }) => unknown,
  ) => selector({ boards: [], projects: [], filterProjectId: null });
  return { useBacklogStore };
});

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      tasks: {
        ideaDecomposition: { query: vi.fn() },
        setStage: { mutate: vi.fn() },
        archive: { mutate: vi.fn() },
        delete: { mutate: vi.fn() },
        update: { mutate: vi.fn() },
        getAttachments: { query: vi.fn() },
      },
    },
  },
}));

import { BoardCard } from '../TaskCard';

function makeIdea(overrides: Partial<BacklogTaskItem> = {}): BacklogTaskItem {
  return {
    id: 'idea_1',
    project_id: 1,
    type: 'idea',
    ref: 'IDEA-001',
    title: 'Some idea',
    summary: null,
    body: null,
    priority: 'P1',
    repo: null,
    parent_epic_id: null,
    originating_idea_id: null,
    scope: null,
    board_id: 'board-1',
    stage_id: 's-1',
    archived_at: null,
    decomposed_at: null,
    approved_at: null,
    sort_order: null,
    version: 1,
    stage_position: 1,
    inFlow: [],
    awaitingReview: false,
    isDone: false,
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

const onRun = vi.fn();

describe('TaskCard scope badge', () => {
  it('renders "S" when scope is small', () => {
    render(<BoardCard task={makeIdea({ scope: 'small' })} onRun={onRun} launchingTaskId={null} now={Date.now()} />);
    const badge = screen.getByTestId('scope-tag');
    expect(badge).toHaveTextContent('S');
  });

  it('renders "L" when scope is large', () => {
    render(<BoardCard task={makeIdea({ scope: 'large' })} onRun={onRun} launchingTaskId={null} now={Date.now()} />);
    const badge = screen.getByTestId('scope-tag');
    expect(badge).toHaveTextContent('L');
  });

  it('renders nothing when scope is unset', () => {
    render(<BoardCard task={makeIdea({ scope: null })} onRun={onRun} launchingTaskId={null} now={Date.now()} />);
    expect(screen.queryByTestId('scope-tag')).not.toBeInTheDocument();
  });
});
