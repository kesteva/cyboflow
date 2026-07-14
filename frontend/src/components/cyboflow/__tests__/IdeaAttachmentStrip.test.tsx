/**
 * Behavioral tests for IdeaAttachmentStrip (migration 028 generalization: any
 * file type, not just images). Focus: an image preview keeps its <img>
 * thumbnail, while a non-image attachment renders the compact file chip
 * (icon + name) instead of attempting to preview the bytes.
 */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import { IdeaAttachmentStrip } from '../IdeaAttachmentStrip';
import type { AttachmentPreview } from '../../../hooks/useIdeaAttachments';

function makePreview(overrides: Partial<AttachmentPreview>): AttachmentPreview {
  return {
    id: 'att_1',
    name: 'file',
    path: '/artifacts/ideas/idea-1/att_1.bin',
    type: 'application/octet-stream',
    size: 123,
    ...overrides,
  };
}

describe('IdeaAttachmentStrip', () => {
  it('shows "Attachments" / "Attach file" controls and accepts any file type', () => {
    render(
      <IdeaAttachmentStrip previews={[]} busy={false} error={null} onAddFiles={vi.fn()} onRemove={vi.fn()} />,
    );

    expect(screen.getByText('Attachments')).toBeInTheDocument();
    expect(screen.getByText('Attach file')).toBeInTheDocument();
    const input = screen.getByTestId('idea-attach-file').parentElement?.querySelector('input[type="file"]');
    expect(input).not.toBeNull();
    expect(input?.getAttribute('accept')).toBeNull();
  });

  it('renders an <img> thumbnail for an image attachment', () => {
    const previews = [makePreview({ id: 'img_1', name: 'shot.png', type: 'image/png', dataUrl: 'data:image/png;base64,AAAA' })];
    render(
      <IdeaAttachmentStrip previews={previews} busy={false} error={null} onAddFiles={vi.fn()} onRemove={vi.fn()} />,
    );

    const img = screen.getByAltText('shot.png');
    expect(img.tagName).toBe('IMG');
    expect(screen.queryByTestId('idea-attachment-file-chip')).not.toBeInTheDocument();
  });

  it('renders a file chip (icon + name) for a non-image attachment instead of a thumbnail', () => {
    const previews = [makePreview({ id: 'pdf_1', name: 'report.pdf', type: 'application/pdf' })];
    render(
      <IdeaAttachmentStrip previews={previews} busy={false} error={null} onAddFiles={vi.fn()} onRemove={vi.fn()} />,
    );

    expect(screen.getByTestId('idea-attachment-file-chip')).toBeInTheDocument();
    expect(screen.getByText('report.pdf')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('still exposes a remove affordance for a non-image attachment', () => {
    const onRemove = vi.fn();
    const previews = [makePreview({ id: 'log_1', name: 'debug.log', type: 'text/plain' })];
    render(
      <IdeaAttachmentStrip previews={previews} busy={false} error={null} onAddFiles={vi.fn()} onRemove={onRemove} />,
    );

    screen.getByLabelText('Remove debug.log').click();
    expect(onRemove).toHaveBeenCalledWith('log_1');
  });
});
