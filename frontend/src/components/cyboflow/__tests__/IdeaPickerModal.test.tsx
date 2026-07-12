/**
 * IdeaPickerModal tests (migration 017, Piece A — pre-launch idea selection).
 *
 * Behaviors verified:
 *   1. Pick mode lists ONLY open ideas (type==='idea' && !isDone) from tasks.list;
 *      confirming calls onPicked with the selected idea id (no create.mutate).
 *   2. New mode creates an idea via tasks.create.mutate({ type:'idea', body, ... })
 *      and calls onPicked with the returned taskId.
 *   3. A failing create surfaces the server error inline (role=alert).
 *
 * tRPC mocking follows the WorkflowEditorModal.test.tsx pattern (file-local
 * vi.mock of '../../../trpc/client').
 */
import '@testing-library/jest-dom';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BacklogTaskItem } from '../../../../../shared/types/tasks';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<BacklogTaskItem>): BacklogTaskItem {
  return {
    id: 'IDEA-1',
    project_id: 1,
    type: 'idea',
    ref: 'IDEA-1',
    title: 'An idea',
    summary: null,
    body: null,
    priority: 'P2',
    repo: null,
    parent_epic_id: null,
    originating_idea_id: null,
    scope: null,
    board_id: 'board-1',
    stage_id: 'idea',
    archived_at: null,
    decomposed_at: null,
    approved_at: '2026-01-01T00:00:00.000Z',
    sort_order: null,
    stage_position: 1,
    version: 1,
    inFlow: [],
    awaitingReview: false,
    isDone: false,
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

const ITEMS: BacklogTaskItem[] = [
  makeItem({ id: 'IDEA-1', ref: 'IDEA-1', title: 'First idea' }),
  makeItem({ id: 'IDEA-2', ref: 'IDEA-2', title: 'Done idea', isDone: true }),
  makeItem({ id: 'EPIC-1', ref: 'EPIC-1', title: 'An epic', type: 'epic' }),
  makeItem({ id: 'IDEA-3', ref: 'IDEA-3', title: 'Second idea' }),
  makeItem({
    id: 'IDEA-4',
    ref: 'IDEA-4',
    title: 'Archived idea',
    archived_at: '2026-06-11T20:43:34Z',
  }),
  // Retired at plan approval: keeps its original stage (isDone stays false) and
  // is marked solely by decomposed_at — must not reappear as a planner seed.
  makeItem({
    id: 'IDEA-5',
    ref: 'IDEA-5',
    title: 'Decomposed idea',
    decomposed_at: '2026-06-30T10:00:00Z',
  }),
];

// ---------------------------------------------------------------------------
// tRPC mock — override the global setup.ts stub.
// ---------------------------------------------------------------------------

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      tasks: {
        list: { query: vi.fn() },
        create: { mutate: vi.fn() },
      },
    },
  },
}));

// Import after mocks so vi.mock hoisting is in effect.
import { IdeaPickerModal } from '../IdeaPickerModal';
import { trpc } from '../../../trpc/client';

const mockList = vi.mocked(trpc.cyboflow.tasks.list.query);
const mockCreate = vi.mocked(trpc.cyboflow.tasks.create.mutate);

beforeEach(() => {
  vi.clearAllMocks();
  mockList.mockResolvedValue(structuredClone(ITEMS));
  mockCreate.mockResolvedValue({ taskId: 'IDEA-NEW' });
});

async function renderOpen(onPicked = vi.fn(), onClose = vi.fn()) {
  render(<IdeaPickerModal isOpen projectId={1} onClose={onClose} onPicked={onPicked} />);
  // Wait for the idea list to resolve (the select renders post-load).
  await screen.findByLabelText('Select idea');
  return { onPicked, onClose };
}

describe('IdeaPickerModal — pick existing', () => {
  it('defaults to pick mode with no explainer (non-onboarding callers unchanged)', async () => {
    await renderOpen();
    expect(screen.getByTestId('idea-picker-mode-pick')).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByTestId('idea-picker-explainer')).not.toBeInTheDocument();
  });

  it('lists only open ideas and onPicked fires with the selected id (no create)', async () => {
    const { onPicked } = await renderOpen();

    const select = (await screen.findByLabelText('Select idea')) as HTMLSelectElement;
    // Only the two open ideas (IDEA-1, IDEA-3) — not the done idea, the
    // archived-in-place idea, the decomposed (retired) idea, or the epic.
    const optionValues = Array.from(select.options).map((o) => o.value);
    expect(optionValues).toEqual(['IDEA-1', 'IDEA-3']);

    // Select the second open idea, then confirm.
    await act(async () => {
      fireEvent.change(select, { target: { value: 'IDEA-3' } });
    });
    const submit = screen.getByTestId('idea-picker-submit');
    await act(async () => {
      fireEvent.click(submit);
    });

    expect(onPicked).toHaveBeenCalledOnce();
    expect(onPicked).toHaveBeenCalledWith('IDEA-3');
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('IdeaPickerModal — new idea', () => {
  it('creates an idea with body and onPicked fires with the returned id', async () => {
    const { onPicked } = await renderOpen();

    // Switch to new mode.
    await act(async () => {
      fireEvent.click(screen.getByTestId('idea-picker-mode-new'));
    });

    const titleInput = screen.getByLabelText('Idea title');
    const bodyInput = screen.getByLabelText('Idea body');
    await act(async () => {
      fireEvent.change(titleInput, { target: { value: '  Brand new idea  ' } });
      fireEvent.change(bodyInput, { target: { value: '  Some prose body.  ' } });
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('idea-picker-submit'));
    });

    expect(mockCreate).toHaveBeenCalledOnce();
    expect(mockCreate).toHaveBeenCalledWith({
      projectId: 1,
      type: 'idea',
      title: 'Brand new idea',
      body: 'Some prose body.',
      attachments: [],
      priority: 'P2',
    });
    expect(onPicked).toHaveBeenCalledWith('IDEA-NEW');
  });

  it('defaultMode="new" opens straight on the New idea form (onboarding path)', async () => {
    render(
      <IdeaPickerModal isOpen projectId={1} onClose={vi.fn()} onPicked={vi.fn()} defaultMode="new" showIdeaExplainer />,
    );
    // The New idea form is live without touching the toggle.
    expect(await screen.findByLabelText('Idea title')).toBeInTheDocument();
    expect(screen.getByTestId('idea-picker-mode-new')).toHaveAttribute('aria-selected', 'true');
    // The what's-an-idea explainer is rendered.
    expect(screen.getByTestId('idea-picker-explainer')).toHaveTextContent(
      'Ideas are the first step of the build process in Cyboflow',
    );
    // Flush the async ideas query so its state update doesn't leak past the test.
    await act(async () => {
      await Promise.resolve();
    });
  });

  it('surfaces a create error inline and does not call onPicked', async () => {
    mockCreate.mockRejectedValueOnce(new Error('chokepoint rejected: bad parent'));
    const { onPicked } = await renderOpen();

    await act(async () => {
      fireEvent.click(screen.getByTestId('idea-picker-mode-new'));
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Idea title'), { target: { value: 'X' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('idea-picker-submit'));
    });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('chokepoint rejected: bad parent');
    expect(onPicked).not.toHaveBeenCalled();
  });
});
