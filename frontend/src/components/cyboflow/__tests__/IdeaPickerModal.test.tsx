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
    category: 'feature',
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
    // Single mode emits a 1-element array with no opts.
    expect(onPicked).toHaveBeenCalledWith(['IDEA-3']);
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
    expect(onPicked).toHaveBeenCalledWith(['IDEA-NEW']);
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

// ---------------------------------------------------------------------------
// Multi-select planner mode (IDEA-009)
// ---------------------------------------------------------------------------

const MULTI_ITEMS: BacklogTaskItem[] = [
  makeItem({ id: 'IDEA-A', ref: 'IDEA-A', title: 'Alpha', scope: 'small' }),
  makeItem({ id: 'IDEA-B', ref: 'IDEA-B', title: 'Bravo', scope: 'large' }),
  makeItem({ id: 'IDEA-C', ref: 'IDEA-C', title: 'Charlie', scope: null }),
  makeItem({ id: 'IDEA-D', ref: 'IDEA-D', title: 'Delta', scope: 'small' }),
  makeItem({ id: 'IDEA-E', ref: 'IDEA-E', title: 'Echo', scope: 'small' }),
];

async function renderMulti(items = MULTI_ITEMS, onPicked = vi.fn(), onClose = vi.fn()) {
  mockList.mockResolvedValue(structuredClone(items));
  render(<IdeaPickerModal isOpen multi projectId={1} onClose={onClose} onPicked={onPicked} />);
  // The meter renders once the checklist loads (multi + ideas.length > 0).
  await screen.findByTestId('idea-picker-meter');
  return { onPicked, onClose };
}

describe('IdeaPickerModal — multi-select planner mode', () => {
  it('caps the batch at 4: the 5th row disables and a banner appears', async () => {
    const { onPicked } = await renderMulti();

    for (const id of ['IDEA-A', 'IDEA-C', 'IDEA-D', 'IDEA-E']) {
      await act(async () => {
        fireEvent.click(screen.getByTestId(`idea-check-${id}`));
      });
    }

    expect(screen.getByTestId('idea-picker-meter')).toHaveTextContent('4 of 4 selected');
    expect(screen.getByTestId('idea-picker-cap-banner')).toBeInTheDocument();

    // The 5th (unchecked) row is disabled and clicking it is a no-op.
    const fifth = screen.getByTestId('idea-check-IDEA-B') as HTMLInputElement;
    expect(fifth).toBeDisabled();
    await act(async () => {
      fireEvent.click(fifth);
    });
    expect(screen.getByTestId('idea-picker-meter')).toHaveTextContent('4 of 4 selected');

    // Submit emits the batch of four with an empty separate list.
    await act(async () => {
      fireEvent.click(screen.getByTestId('idea-picker-submit'));
    });
    expect(onPicked).toHaveBeenCalledWith(['IDEA-A', 'IDEA-C', 'IDEA-D', 'IDEA-E'], {
      separateIdeaIds: [],
    });
  });

  it('renders S / L / ? scope badges per row', async () => {
    await renderMulti();

    // Small (A, D, E) → S; large (B) → L in list order; unset (C) → ?.
    const scopeTexts = screen.getAllByTestId('scope-tag').map((t) => t.textContent);
    expect(scopeTexts).toEqual(['S', 'L', 'S', 'S']);
    expect(screen.getByTestId('scope-tag-unset')).toHaveTextContent('?');
  });

  it('splits a large idea out via Plan separately and reports it in opts', async () => {
    const { onPicked } = await renderMulti();

    // Mixing a large idea (B) with another (A) surfaces the warning on B.
    await act(async () => {
      fireEvent.click(screen.getByTestId('idea-check-IDEA-A'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('idea-check-IDEA-B'));
    });

    const planBtn = await screen.findByTestId('plan-separately-IDEA-B');
    await act(async () => {
      fireEvent.click(planBtn);
    });

    // B leaves the checklist and becomes a queued-separate chip; A stays selected.
    expect(screen.queryByTestId('idea-check-IDEA-B')).not.toBeInTheDocument();
    expect(screen.getByTestId('separate-chip-IDEA-B')).toBeInTheDocument();
    expect(screen.getByTestId('idea-picker-meter')).toHaveTextContent('1 of 4 selected');

    await act(async () => {
      fireEvent.click(screen.getByTestId('idea-picker-submit'));
    });
    expect(onPicked).toHaveBeenCalledWith(['IDEA-A'], { separateIdeaIds: ['IDEA-B'] });
  });

  it('undo restores a parked idea to the selectable list (unchecked)', async () => {
    await renderMulti();

    await act(async () => {
      fireEvent.click(screen.getByTestId('idea-check-IDEA-A'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('idea-check-IDEA-B'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('plan-separately-IDEA-B'));
    });
    expect(screen.getByTestId('separate-chip-IDEA-B')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId('separate-undo-IDEA-B'));
    });

    expect(screen.queryByTestId('separate-chip-IDEA-B')).not.toBeInTheDocument();
    const restored = screen.getByTestId('idea-check-IDEA-B') as HTMLInputElement;
    expect(restored).toBeInTheDocument();
    expect(restored.checked).toBe(false);
  });

  it('a lone large idea shows no split warning (only when mixed)', async () => {
    await renderMulti();

    await act(async () => {
      fireEvent.click(screen.getByTestId('idea-check-IDEA-B'));
    });
    // Single large selection is fine on its own — no split prompt.
    expect(screen.queryByTestId('plan-separately-IDEA-B')).not.toBeInTheDocument();
  });

  it('allowPlanSeparately=false hides the split even on a mixed-large selection (wizard host)', async () => {
    // SessionStartWizard cannot fire the N+1 separate launches (it navigates
    // away on success), so it opts out of the affordance entirely — a peeled
    // idea there would be silently dropped.
    mockList.mockResolvedValue(structuredClone(MULTI_ITEMS));
    render(
      <IdeaPickerModal
        isOpen
        multi
        allowPlanSeparately={false}
        projectId={1}
        onClose={vi.fn()}
        onPicked={vi.fn()}
      />,
    );
    await screen.findByTestId('idea-picker-meter');

    await act(async () => {
      fireEvent.click(screen.getByTestId('idea-check-IDEA-A'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('idea-check-IDEA-B'));
    });

    // The mixed-large warning/split affordance never renders in this host.
    expect(screen.queryByTestId('plan-separately-IDEA-B')).not.toBeInTheDocument();
    expect(screen.queryByTestId('plan-separately-warning-IDEA-B')).not.toBeInTheDocument();
  });
});
