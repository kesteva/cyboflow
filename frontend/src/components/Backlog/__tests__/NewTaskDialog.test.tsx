/**
 * NewTaskDialog — the "+ New backlog item" dialog.
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

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));

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

// The attachment hook + strip pull in IPC we don't exercise here.
vi.mock('../../../hooks/useIdeaAttachments', () => ({
  useIdeaAttachments: () => ({
    attachments: [],
    previews: [],
    busy: false,
    error: null,
    handlePaste: vi.fn(),
    handleDrop: vi.fn(),
    addFiles: vi.fn(),
    remove: vi.fn(),
    reset: vi.fn(),
  }),
}));
vi.mock('../../cyboflow/IdeaAttachmentStrip', () => ({ IdeaAttachmentStrip: () => null }));

import { NewTaskDialog } from '../NewTaskDialog';

function project(id: number, name: string): BacklogProjectRef {
  return { id, name } as BacklogProjectRef;
}

beforeEach(() => {
  mockCreate.mockReset().mockResolvedValue({ taskId: 'tsk_new' });
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

describe('NewTaskDialog — close resets fields', () => {
  it('clears the title and project override after Cancel + reopen', () => {
    const onClose = vi.fn();
    const { rerender } = render(<NewTaskDialog isOpen projectId={1} onClose={onClose} />);
    fireEvent.change(projectSelect(), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'draft title' } });
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
    // Simulate the parent closing then reopening the dialog.
    rerender(<NewTaskDialog isOpen={false} projectId={1} onClose={onClose} />);
    rerender(<NewTaskDialog isOpen projectId={1} onClose={onClose} />);
    expect((screen.getByLabelText('Task title') as HTMLInputElement).value).toBe('');
    // Override cleared → back to tracking the default (prop = 1).
    expect(projectSelect().value).toBe('1');
  });
});
