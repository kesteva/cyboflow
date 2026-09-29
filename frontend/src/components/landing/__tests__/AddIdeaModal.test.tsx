/**
 * AddIdeaModal — the landing page's simplified idea capture.
 *
 * Covers the title/summary split of the single input, the project picker only
 * appearing with more than one project, the create → launch-step transition,
 * "+ Add another idea" looping back with a cleared input, the launch handoff,
 * and a rejected create surfacing its error in place.
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));

vi.mock('../../../trpc/client', () => ({
  trpc: { cyboflow: { tasks: { create: { mutate: mockCreate } } } },
}));

import { AddIdeaModal, splitIdeaText, type AddIdeaProjectRef } from '../AddIdeaModal';
import { ADD_IDEA_MODAL_DRAFT_KEY } from '../../../utils/ideaDraftStorage';

const ONE_PROJECT: AddIdeaProjectRef[] = [{ id: 1, name: 'Alpha' }];
const TWO_PROJECTS: AddIdeaProjectRef[] = [
  { id: 1, name: 'Alpha' },
  { id: 2, name: 'Beta' },
];

beforeEach(() => {
  mockCreate.mockReset().mockResolvedValue({ taskId: 'idea_new' });
  localStorage.clear();
});

function typeIdea(text: string): void {
  fireEvent.change(screen.getByTestId('add-idea-input'), { target: { value: text } });
}

describe('splitIdeaText', () => {
  it('keeps a single sentence as the whole title with a null summary', () => {
    expect(splitIdeaText('Add a chapter timeline view')).toEqual({
      title: 'Add a chapter timeline view',
      summary: null,
    });
  });

  it('splits at the first sentence terminator, dropping a trailing period from the title', () => {
    expect(splitIdeaText('Add a timeline view. It should show chapters in order.')).toEqual({
      title: 'Add a timeline view',
      summary: 'It should show chapters in order.',
    });
  });

  it('splits at the first newline when it comes before any sentence break', () => {
    expect(splitIdeaText('Timeline view\nWith drag-to-reorder chapters.')).toEqual({
      title: 'Timeline view',
      summary: 'With drag-to-reorder chapters.',
    });
  });

  it('keeps ! and ? on the title', () => {
    expect(splitIdeaText('Ship dark mode! Everyone keeps asking.')).toEqual({
      title: 'Ship dark mode!',
      summary: 'Everyone keeps asking.',
    });
  });
});

describe('AddIdeaModal — capture step', () => {
  it('hides the project picker with a single project and creates into it', async () => {
    render(
      <AddIdeaModal isOpen onClose={vi.fn()} projects={ONE_PROJECT} onLaunchPlanner={vi.fn()} />,
    );
    expect(screen.queryByTestId('add-idea-project')).not.toBeInTheDocument();
    typeIdea('Do the thing');
    fireEvent.click(screen.getByTestId('add-idea-submit'));
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    expect(mockCreate.mock.calls[0][0]).toEqual({
      projectId: 1,
      type: 'idea',
      title: 'Do the thing',
      summary: null,
    });
  });

  it('shows the project picker with several projects and sends the picked one', async () => {
    render(
      <AddIdeaModal isOpen onClose={vi.fn()} projects={TWO_PROJECTS} onLaunchPlanner={vi.fn()} />,
    );
    fireEvent.change(screen.getByTestId('add-idea-project'), { target: { value: '2' } });
    typeIdea('Beta idea');
    fireEvent.click(screen.getByTestId('add-idea-submit'));
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    expect(mockCreate.mock.calls[0][0]).toMatchObject({ projectId: 2 });
  });

  it('keeps the submit disabled until non-blank text is entered', () => {
    render(
      <AddIdeaModal isOpen onClose={vi.fn()} projects={ONE_PROJECT} onLaunchPlanner={vi.fn()} />,
    );
    expect(screen.getByTestId('add-idea-submit')).toBeDisabled();
    typeIdea('   ');
    expect(screen.getByTestId('add-idea-submit')).toBeDisabled();
    typeIdea('real');
    expect(screen.getByTestId('add-idea-submit')).not.toBeDisabled();
  });

  it('surfaces a rejected create in place and stays on the capture step', async () => {
    mockCreate.mockRejectedValue(new Error('backlog unavailable'));
    render(
      <AddIdeaModal isOpen onClose={vi.fn()} projects={ONE_PROJECT} onLaunchPlanner={vi.fn()} />,
    );
    typeIdea('Doomed');
    fireEvent.click(screen.getByTestId('add-idea-submit'));
    expect(await screen.findByRole('alert')).toHaveTextContent('backlog unavailable');
    expect(screen.getByTestId('add-idea-input')).toBeInTheDocument();
  });
});

describe('AddIdeaModal — launch step', () => {
  async function reachLaunchStep(onLaunchPlanner = vi.fn().mockResolvedValue('run_1'), onClose = vi.fn()) {
    render(
      <AddIdeaModal isOpen onClose={onClose} projects={ONE_PROJECT} onLaunchPlanner={onLaunchPlanner} />,
    );
    typeIdea('Add a timeline view. With chapters.');
    fireEvent.click(screen.getByTestId('add-idea-submit'));
    await screen.findByTestId('add-idea-launch-planner');
  }

  it('echoes the created idea title and offers the planner launch', async () => {
    await reachLaunchStep();
    expect(screen.getByTestId('add-idea-echo')).toHaveTextContent('Add a timeline view');
    expect(screen.getByText('Launch a planner now?')).toBeInTheDocument();
  });

  it('hands the created idea to onLaunchPlanner and closes', async () => {
    const onLaunchPlanner = vi.fn().mockResolvedValue('run_1');
    const onClose = vi.fn();
    await reachLaunchStep(onLaunchPlanner, onClose);
    fireEvent.click(screen.getByTestId('add-idea-launch-planner'));
    await waitFor(() => expect(onLaunchPlanner).toHaveBeenCalledWith('idea_new', 1));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('"+ Add another idea" returns to a cleared capture step without closing', async () => {
    const onClose = vi.fn();
    await reachLaunchStep(vi.fn(), onClose);
    fireEvent.click(screen.getByTestId('add-idea-add-another'));
    expect((screen.getByTestId('add-idea-input') as HTMLTextAreaElement).value).toBe('');
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('AddIdeaModal — draft persistence across close', () => {
  it('preserves typed text and the picked project across an unmount/remount after Cancel', () => {
    const onClose = vi.fn();
    const { unmount } = render(
      <AddIdeaModal isOpen onClose={onClose} projects={TWO_PROJECTS} onLaunchPlanner={vi.fn()} />,
    );
    typeIdea('Draft idea text');
    fireEvent.change(screen.getByTestId('add-idea-project'), { target: { value: '2' } });
    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);

    // Simulate reopening after the component identity is lost (e.g. the
    // modal's owning page unmounted and remounted, or the app reloaded) —
    // only a localStorage-backed draft can survive this, not React state.
    unmount();
    render(
      <AddIdeaModal isOpen onClose={vi.fn()} projects={TWO_PROJECTS} onLaunchPlanner={vi.fn()} />,
    );

    expect((screen.getByTestId('add-idea-input') as HTMLTextAreaElement).value).toBe(
      'Draft idea text',
    );
    expect((screen.getByTestId('add-idea-project') as HTMLSelectElement).value).toBe('2');
  });

  it('preserves the draft across overlay/Escape-style closes too, since they share handleClose', () => {
    // The Cancel button, the header X, an overlay click, and Escape all route
    // through the same Modal `onClose` prop (AddIdeaModal's handleClose) — so
    // exercising Escape is an equivalent check of the same code path.
    const onClose = vi.fn();
    const { unmount } = render(
      <AddIdeaModal isOpen onClose={onClose} projects={ONE_PROJECT} onLaunchPlanner={vi.fn()} />,
    );
    typeIdea('Escape-preserved draft');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    unmount();
    render(<AddIdeaModal isOpen onClose={vi.fn()} projects={ONE_PROJECT} onLaunchPlanner={vi.fn()} />);
    expect((screen.getByTestId('add-idea-input') as HTMLTextAreaElement).value).toBe(
      'Escape-preserved draft',
    );
  });

  it('clears the persisted draft on a successful create — reopening afterward is blank', async () => {
    const onClose = vi.fn();
    const { unmount } = render(
      <AddIdeaModal isOpen onClose={onClose} projects={ONE_PROJECT} onLaunchPlanner={vi.fn()} />,
    );
    typeIdea('Ship the thing');
    fireEvent.click(screen.getByTestId('add-idea-submit'));
    await screen.findByTestId('add-idea-launch-planner');

    expect(localStorage.getItem(ADD_IDEA_MODAL_DRAFT_KEY)).toBeNull();

    unmount();
    render(<AddIdeaModal isOpen onClose={onClose} projects={ONE_PROJECT} onLaunchPlanner={vi.fn()} />);
    expect((screen.getByTestId('add-idea-input') as HTMLTextAreaElement).value).toBe('');
  });

  it('does not write to localStorage again on an unrelated re-render (e.g. an error clearing)', async () => {
    mockCreate.mockRejectedValueOnce(new Error('backlog unavailable'));
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    render(
      <AddIdeaModal isOpen onClose={vi.fn()} projects={ONE_PROJECT} onLaunchPlanner={vi.fn()} />,
    );

    typeIdea('Stable text');
    const draftCallsAfterTyping = setItemSpy.mock.calls.filter(
      ([key]) => key === ADD_IDEA_MODAL_DRAFT_KEY,
    ).length;
    expect(draftCallsAfterTyping).toBeGreaterThan(0);

    // Trigger a rejected create (busy true -> false, error set then implicitly
    // present) — none of this touches text/projectOverride, so it must not
    // cause another draft write.
    fireEvent.click(screen.getByTestId('add-idea-submit'));
    await screen.findByRole('alert');

    const draftCallsAfterError = setItemSpy.mock.calls.filter(
      ([key]) => key === ADD_IDEA_MODAL_DRAFT_KEY,
    ).length;
    expect(draftCallsAfterError).toBe(draftCallsAfterTyping);

    setItemSpy.mockRestore();
  });
});
