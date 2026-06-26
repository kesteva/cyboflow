/**
 * TaskDetailModal tests — the full-detail overlay for one backlog task.
 *
 * Asserts: closed when task is null; renders ref/title/priority/summary + the
 * full markdown body via MarkdownPreview; graceful "No additional detail" state
 * for an empty body; Escape + close-button forward onClose.
 *
 * react-markdown is ESM-heavy in jsdom, so MarkdownPreview is stubbed to a plain
 * div that echoes its content (mirrors ArtifactTabRenderer.test.tsx).
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TaskDetailModal } from '../TaskDetailModal';
import type { BacklogTaskItem } from '../../../../../shared/types/tasks';

vi.mock('../../MarkdownPreview', () => ({
  MarkdownPreview: ({ content }: { content: string }) => <div data-testid="md-preview">{content}</div>,
}));

function makeTask(overrides: Partial<BacklogTaskItem> = {}): BacklogTaskItem {
  return {
    id: 'TASK-1',
    project_id: 1,
    type: 'task',
    ref: 'TASK-041',
    title: 'Build tab strip',
    summary: 'Tab strip across the top.',
    body: '## Acceptance\n\nRender a horizontal tab strip.',
    priority: 'P0',
    repo: null,
    parent_epic_id: 'EPIC-1',
    originating_idea_id: 'IDEA-018',
    scope: null,
    board_id: 'b1',
    stage_id: 's1',
    archived_at: null,
    version: 1,
    stage_position: 1,
    inFlow: [],
    awaitingReview: false,
    isDone: false,
    created_at: '2026-06-18T00:00:00Z',
    updated_at: '2026-06-18T00:00:00Z',
    ...overrides,
  };
}

describe('TaskDetailModal', () => {
  it('renders nothing when task is null', () => {
    const { container } = render(<TaskDetailModal task={null} onClose={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('task-detail-modal')).not.toBeInTheDocument();
  });

  it('renders ref, title, priority, summary, and the markdown body', () => {
    render(<TaskDetailModal task={makeTask()} onClose={vi.fn()} />);

    expect(screen.getByTestId('task-detail-modal')).toBeInTheDocument();
    expect(screen.getByText('TASK-041')).toBeInTheDocument();
    expect(screen.getByTestId('task-detail-title')).toHaveTextContent('Build tab strip');
    expect(screen.getByTestId('task-detail-priority')).toHaveTextContent('P0');
    expect(screen.getByTestId('task-detail-summary')).toHaveTextContent('Tab strip across the top.');
    expect(screen.getByTestId('md-preview')).toHaveTextContent('Render a horizontal tab strip.');
    expect(screen.queryByTestId('task-detail-nobody')).not.toBeInTheDocument();
  });

  it('shows the No-additional-detail state for a null body', () => {
    render(<TaskDetailModal task={makeTask({ body: null })} onClose={vi.fn()} />);
    expect(screen.getByTestId('task-detail-nobody')).toHaveTextContent('No additional detail.');
    expect(screen.queryByTestId('md-preview')).not.toBeInTheDocument();
  });

  it('shows the No-additional-detail state for a whitespace-only body', () => {
    render(<TaskDetailModal task={makeTask({ body: '   \n  ' })} onClose={vi.fn()} />);
    expect(screen.getByTestId('task-detail-nobody')).toBeInTheDocument();
    expect(screen.queryByTestId('md-preview')).not.toBeInTheDocument();
  });

  it('forwards onClose from the close button and from Escape', () => {
    const onClose = vi.fn();
    render(<TaskDetailModal task={makeTask()} onClose={onClose} />);

    fireEvent.click(screen.getByLabelText('Close modal'));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
