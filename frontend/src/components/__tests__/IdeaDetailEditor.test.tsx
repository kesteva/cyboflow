/**
 * Component tests for IdeaDetailEditor.
 *
 * Covers the markdown edit -> save -> modal-lifecycle path:
 *   - seeds the form from the idea's current fields.
 *   - editing the markdown body and saving forwards the full update payload
 *     (incl body + scope + expectedVersion) to cyboflow.tasks.update.
 *   - a successful save fires onSaved and closes the modal (onClose).
 *   - the Write/Preview toggle swaps the body input for a markdown preview.
 *   - a rejecting save surfaces the error and keeps the modal open.
 *
 * MarkdownPreview is mocked to a plain div so the heavy react-markdown/mermaid
 * stack is not pulled into jsdom.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { BacklogTaskItem } from '../../../../shared/types/tasks';

const { mockUpdate, mockGetAttachments } = vi.hoisted(() => ({
  mockUpdate: vi.fn().mockResolvedValue({ taskId: 'idea_1' }),
  mockGetAttachments: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      tasks: {
        update: { mutate: mockUpdate },
        getAttachments: { query: mockGetAttachments },
      },
    },
  },
}));

// Attachment file IO goes through window.electronAPI.ideas — stub it so the
// useIdeaAttachments hook has something to call (no attachments in these tests).
Object.defineProperty(window, 'electronAPI', {
  configurable: true,
  value: {
    ideas: {
      saveAttachments: vi.fn().mockResolvedValue([]),
      loadAttachments: vi.fn().mockResolvedValue([]),
    },
  },
});

vi.mock('../MarkdownPreview', () => ({
  MarkdownPreview: ({ content }: { content: string }) => (
    <div data-testid="markdown-preview">{content}</div>
  ),
}));

import { IdeaDetailEditor } from '../IdeaDetailEditor';

function makeIdea(overrides: Partial<BacklogTaskItem> = {}): BacklogTaskItem {
  return {
    id: 'idea_1',
    project_id: 9,
    type: 'idea',
    ref: 'IDEA-001',
    title: 'Original title',
    summary: 'Original summary',
    body: '# Original body',
    priority: 'P2',
    repo: null,
    parent_epic_id: null,
    originating_idea_id: null,
    scope: null,
    board_id: 'board-1',
    stage_id: 's-idea',
    archived_at: null,
    decomposed_at: null,
    approved_at: '2026-01-01T00:00:00.000Z',
    sort_order: null,
    stage_position: 1,
    version: 3,
    inFlow: [],
    awaitingReview: false,
    isDone: false,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  mockUpdate.mockClear();
  mockUpdate.mockResolvedValue({ taskId: 'idea_1' });
});

describe('IdeaDetailEditor', () => {
  it('renders nothing when closed', () => {
    render(<IdeaDetailEditor idea={makeIdea()} isOpen={false} onClose={vi.fn()} />);
    expect(screen.queryByTestId('idea-detail-editor')).not.toBeInTheDocument();
  });

  it('seeds the form from the idea fields', () => {
    render(<IdeaDetailEditor idea={makeIdea()} isOpen onClose={vi.fn()} />);
    expect(screen.getByLabelText('Idea title')).toHaveValue('Original title');
    expect(screen.getByTestId('idea-body-input')).toHaveValue('# Original body');
  });

  it('edits the markdown body and saves the full payload through tasks.update', async () => {
    const onClose = vi.fn();
    const onSaved = vi.fn();
    render(<IdeaDetailEditor idea={makeIdea()} isOpen onClose={onClose} onSaved={onSaved} />);

    // Let the attachments fetch resolve so the save includes attachments (the
    // editor omits them until loaded, to avoid clobbering existing ones).
    await waitFor(() => expect(mockGetAttachments).toHaveBeenCalled());

    fireEvent.change(screen.getByTestId('idea-body-input'), {
      target: { value: '# New body\n\nUpdated markdown.' },
    });
    fireEvent.change(screen.getByLabelText('Idea scope'), { target: { value: 'large' } });
    fireEvent.click(screen.getByTestId('idea-detail-save'));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    expect(mockUpdate).toHaveBeenCalledWith({
      projectId: 9,
      taskId: 'idea_1',
      title: 'Original title',
      summary: 'Original summary',
      body: '# New body\n\nUpdated markdown.',
      scope: 'large',
      attachments: [],
      expectedVersion: 3,
    });
    // Modal lifecycle: a successful save fires onSaved and closes the modal.
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('idea_1'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('the Preview toggle renders the markdown body via MarkdownPreview', () => {
    render(<IdeaDetailEditor idea={makeIdea()} isOpen onClose={vi.fn()} />);
    expect(screen.queryByTestId('idea-body-preview')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('body-mode-preview'));
    const preview = screen.getByTestId('idea-body-preview');
    expect(within(preview).getByTestId('markdown-preview')).toHaveTextContent('# Original body');
  });

  it('surfaces an error and keeps the modal open when the save rejects', async () => {
    mockUpdate.mockRejectedValueOnce(new Error('concurrency: stale version'));
    const onClose = vi.fn();
    render(<IdeaDetailEditor idea={makeIdea()} isOpen onClose={onClose} />);

    fireEvent.click(screen.getByTestId('idea-detail-save'));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('concurrency'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('disables Save when the title is emptied', () => {
    render(<IdeaDetailEditor idea={makeIdea()} isOpen onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Idea title'), { target: { value: '   ' } });
    expect(screen.getByTestId('idea-detail-save')).toBeDisabled();
  });
});
