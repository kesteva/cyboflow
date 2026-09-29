/**
 * NewTaskDialog — the "+ New idea" dialog (idea-only: hand-created entities are
 * always ideas; epics/tasks are minted by the planner).
 *
 * Covers the default-project chain (filterProjectId ?? projectId ?? projects[0]),
 * an explicit pick winning, create ALWAYS sending the selected id (not the raw
 * prop), field reset on close, and a rejected create surfacing the error without
 * calling onCreated.
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { BacklogProjectRef } from '../../../stores/backlogStore';
import type { IdeaAttachment } from '../../../../../shared/types/tasks';
import { NEW_TASK_DIALOG_DRAFT_KEY } from '../../../utils/ideaDraftStorage';

const { mockCreate, mockUseIdeaAttachments } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockUseIdeaAttachments: vi.fn(),
}));

vi.mock('../../../trpc/client', () => ({
  trpc: { cyboflow: { tasks: { create: { mutate: mockCreate } } } },
}));

// Mutable backlog-store state, read via the selector API.
let mockProjects: BacklogProjectRef[] = [];
let mockFilterProjectId: number | null = null;
vi.mock('../../../stores/backlogStore', () => ({
  useBacklogStore: (selector: (s: { projects: BacklogProjectRef[]; filterProjectId: number | null }) => unknown) =>
    selector({ projects: mockProjects, filterProjectId: mockFilterProjectId }),
}));

// The attachment hook + strip pull in IPC we don't exercise here. Mocked as a
// spy (not a plain arrow fn) so tests can assert the (pendingKey, initial)
// args NewTaskDialog calls it with, and control what `attachments` it reports
// back (which the write-draft effect persists).
vi.mock('../../../hooks/useIdeaAttachments', () => ({
  useIdeaAttachments: mockUseIdeaAttachments,
}));
vi.mock('../../cyboflow/IdeaAttachmentStrip', () => ({ IdeaAttachmentStrip: () => null }));

import { NewTaskDialog } from '../NewTaskDialog';

function project(id: number, name: string): BacklogProjectRef {
  return { id, name } as BacklogProjectRef;
}

/** Default mock behavior: reports back whatever `initial` it was seeded with. */
function defaultAttachmentsMock(_ownerKey: string, initial: IdeaAttachment[]) {
  return {
    attachments: initial,
    previews: initial,
    busy: false,
    error: null,
    handlePaste: vi.fn(),
    handleDrop: vi.fn(),
    addFiles: vi.fn(),
    remove: vi.fn(),
    reset: vi.fn(),
  };
}

beforeEach(() => {
  localStorage.clear();
  mockCreate.mockReset().mockResolvedValue({ taskId: 'tsk_new' });
  mockUseIdeaAttachments.mockReset().mockImplementation(defaultAttachmentsMock);
  mockProjects = [project(1, 'Alpha'), project(2, 'Beta'), project(3, 'Gamma')];
  mockFilterProjectId = null;
});

function projectSelect(): HTMLSelectElement {
  return screen.getByTestId('new-task-project') as HTMLSelectElement;
}

describe('NewTaskDialog — default project chain', () => {
  it('defaults to the board filter project when set (filterProjectId wins over the prop)', () => {
    mockFilterProjectId = 2;
    render(<NewTaskDialog isOpen projectId={1} onClose={vi.fn()} />);
    expect(projectSelect().value).toBe('2');
  });

  it('falls back to the projectId prop when there is no board filter', () => {
    mockFilterProjectId = null;
    render(<NewTaskDialog isOpen projectId={3} onClose={vi.fn()} />);
    expect(projectSelect().value).toBe('3');
  });

  it('falls back to the first known project when both filter and prop are null', () => {
    mockFilterProjectId = null;
    render(<NewTaskDialog isOpen projectId={null} onClose={vi.fn()} />);
    expect(projectSelect().value).toBe('1');
  });
});

describe('NewTaskDialog — create', () => {
  it('sends the SELECTED project id (an explicit pick, not the raw prop)', async () => {
    render(<NewTaskDialog isOpen projectId={1} onClose={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.change(projectSelect(), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'do the thing' } });
    fireEvent.click(screen.getByTestId('new-task-submit'));
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    expect(mockCreate.mock.calls[0][0]).toMatchObject({ projectId: 3, title: 'do the thing', type: 'idea' });
  });

  it('defaults the category to feature and sends a re-picked category on create', async () => {
    render(<NewTaskDialog isOpen projectId={1} onClose={vi.fn()} onCreated={vi.fn()} />);
    expect((screen.getByLabelText('Task category') as HTMLSelectElement).value).toBe('feature');
    fireEvent.change(screen.getByLabelText('Task category'), { target: { value: 'bug' } });
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'squash it' } });
    fireEvent.click(screen.getByTestId('new-task-submit'));
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    expect(mockCreate.mock.calls[0][0]).toMatchObject({ category: 'bug', title: 'squash it' });
  });

  it('calls onCreated with the new id on success', async () => {
    const onCreated = vi.fn();
    render(<NewTaskDialog isOpen projectId={1} onClose={vi.fn()} onCreated={onCreated} />);
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'x' } });
    fireEvent.click(screen.getByTestId('new-task-submit'));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('tsk_new'));
  });

  it('surfaces the error and never calls onCreated when create rejects', async () => {
    mockCreate.mockRejectedValue(new Error('title collides'));
    const onCreated = vi.fn();
    render(<NewTaskDialog isOpen projectId={1} onClose={vi.fn()} onCreated={onCreated} />);
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'dup' } });
    fireEvent.click(screen.getByTestId('new-task-submit'));
    expect(await screen.findByRole('alert')).toHaveTextContent('title collides');
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('keeps the submit disabled until a non-blank title is entered', () => {
    render(<NewTaskDialog isOpen projectId={1} onClose={vi.fn()} />);
    expect(screen.getByTestId('new-task-submit')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: '   ' } });
    expect(screen.getByTestId('new-task-submit')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'real' } });
    expect(screen.getByTestId('new-task-submit')).not.toBeDisabled();
  });
});

describe('NewTaskDialog — idea size hint (IDEA-009)', () => {
  it('sends the picked scope on create', async () => {
    render(<NewTaskDialog isOpen projectId={1} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'a big one' } });
    fireEvent.change(screen.getByTestId('new-task-scope'), { target: { value: 'large' } });
    fireEvent.click(screen.getByTestId('new-task-submit'));
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    expect(mockCreate.mock.calls[0][0]).toMatchObject({ type: 'idea', scope: 'large' });
  });

  it('omits scope entirely when left unset (column stays NULL, the planner judges)', async () => {
    render(<NewTaskDialog isOpen projectId={1} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'unsure' } });
    fireEvent.click(screen.getByTestId('new-task-submit'));
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    expect(mockCreate.mock.calls[0][0]).not.toHaveProperty('scope');
  });

  it('always creates an idea — there is no type picker', async () => {
    render(<NewTaskDialog isOpen projectId={1} onClose={vi.fn()} />);
    expect(screen.queryByLabelText('Task type')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'anything' } });
    fireEvent.click(screen.getByTestId('new-task-submit'));
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    expect(mockCreate.mock.calls[0][0]).toMatchObject({ type: 'idea' });
  });
});

describe('NewTaskDialog — draft persistence across an accidental close', () => {
  it('preserves the typed title after Cancel and restores it on a fresh mount', () => {
    const onClose = vi.fn();
    const { unmount } = render(<NewTaskDialog isOpen projectId={1} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'draft title' } });
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
    // Unmount (the real close path — the dialog stops being rendered) and
    // remount a fresh instance, as the parent does on the next "+ New" click.
    unmount();
    render(<NewTaskDialog isOpen projectId={1} onClose={onClose} />);
    expect((screen.getByLabelText('Task title') as HTMLInputElement).value).toBe('draft title');
  });

  it('preserves the summary too, and every close path (overlay/Escape/X) funnels through the same handler as Cancel', () => {
    // Modal's overlay/Escape/X all call the same onClose prop NewTaskDialog
    // wires to handleClose — Cancel exercises that shared code path.
    const onClose = vi.fn();
    const { unmount } = render(<NewTaskDialog isOpen projectId={1} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText('Task summary'), { target: { value: 'more context' } });
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    unmount();
    render(<NewTaskDialog isOpen projectId={1} onClose={onClose} />);
    expect((screen.getByLabelText('Task summary') as HTMLTextAreaElement).value).toBe('more context');
  });

  it('degrades silently to blank defaults on a corrupt or shape-invalid persisted draft', () => {
    localStorage.setItem(NEW_TASK_DIALOG_DRAFT_KEY, '{not valid json');
    expect(() => render(<NewTaskDialog isOpen projectId={1} onClose={vi.fn()} />)).not.toThrow();
    expect((screen.getByLabelText('Task title') as HTMLInputElement).value).toBe('');

    localStorage.setItem(NEW_TASK_DIALOG_DRAFT_KEY, JSON.stringify({ title: 'ok', body: 42 }));
    expect(() => render(<NewTaskDialog isOpen projectId={1} onClose={vi.fn()} />)).not.toThrow();
  });

  it('persists attachments under the pending key and restores them as `initial` on reopen', () => {
    const meta: IdeaAttachment = { id: 'att1', name: 'file.png', path: '/tmp/file.png', type: 'image/png', size: 123 };
    // Simulate a session where the user has attached a file: report `meta`
    // back regardless of the (empty, no-draft) `initial` seed it was called with.
    mockUseIdeaAttachments.mockImplementation((_ownerKey: string, initial: IdeaAttachment[]) => ({
      ...defaultAttachmentsMock(_ownerKey, initial),
      attachments: initial.length > 0 ? initial : [meta],
      previews: initial.length > 0 ? initial : [meta],
    }));

    const { unmount } = render(<NewTaskDialog isOpen projectId={1} onClose={vi.fn()} />);
    // Any field edit re-runs the write effect, which now includes the attachment.
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'with attachment' } });

    const raw = localStorage.getItem(NEW_TASK_DIALOG_DRAFT_KEY);
    expect(raw).toBeTruthy();
    const persisted = JSON.parse(raw as string) as { pendingKey: string; attachments: IdeaAttachment[] };
    expect(persisted.attachments).toEqual([meta]);
    const persistedPendingKey = persisted.pendingKey;

    unmount();
    render(<NewTaskDialog isOpen projectId={1} onClose={vi.fn()} />);

    const lastCall = mockUseIdeaAttachments.mock.calls[mockUseIdeaAttachments.mock.calls.length - 1];
    expect(lastCall[0]).toBe(persistedPendingKey);
    expect(lastCall[1]).toEqual([meta]);
  });

  it('clears the persisted draft and mints a fresh pendingKey after a successful submit', async () => {
    render(<NewTaskDialog isOpen projectId={1} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'submit me' } });

    const draftBefore = localStorage.getItem(NEW_TASK_DIALOG_DRAFT_KEY);
    expect(draftBefore).toBeTruthy();
    const pendingKeyBefore = (JSON.parse(draftBefore as string) as { pendingKey: string }).pendingKey;

    fireEvent.click(screen.getByTestId('new-task-submit'));
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));

    expect(localStorage.getItem(NEW_TASK_DIALOG_DRAFT_KEY)).toBeNull();

    const lastCall = mockUseIdeaAttachments.mock.calls[mockUseIdeaAttachments.mock.calls.length - 1];
    expect(lastCall[0]).not.toBe(pendingKeyBefore);
  });

  it('does not call localStorage.setItem on a re-render where the draft content is unchanged', () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    const { rerender } = render(<NewTaskDialog isOpen projectId={1} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'stable title' } });
    const callsAfterType = setItemSpy.mock.calls.length;
    expect(callsAfterType).toBeGreaterThan(0);

    // Re-render with the same props/state (a fresh onClose ref doesn't touch
    // any draft field) — the write effect must not fire another setItem.
    rerender(<NewTaskDialog isOpen projectId={1} onClose={vi.fn()} />);
    expect(setItemSpy.mock.calls.length).toBe(callsAfterType);
    setItemSpy.mockRestore();
  });
});
