/**
 * CommitDialog — blank-message guard, keyboard submit/close, the reject-keeps-open
 * lifecycle (isCommitting resets in finally), success closes, and the pluralized
 * default message.
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CommitDialog } from '../CommitDialog';

beforeEach(() => {
  vi.restoreAllMocks();
});

function commitButton(): HTMLButtonElement {
  // The primary button carries the "Commit" label text alongside its icon.
  return screen.getAllByRole('button').find((b) => /commit/i.test(b.textContent ?? '')) as HTMLButtonElement;
}

describe('CommitDialog', () => {
  it('seeds a pluralized default message from fileCount', () => {
    const { rerender } = render(
      <CommitDialog isOpen onClose={vi.fn()} onCommit={vi.fn()} fileCount={1} />,
    );
    expect(screen.getByRole('textbox')).toHaveValue('Update 1 file');
    rerender(<CommitDialog isOpen onClose={vi.fn()} onCommit={vi.fn()} fileCount={3} />);
    expect(screen.getByRole('textbox')).toHaveValue('Update 3 files');
  });

  it('blocks commit and shows an error when the message is blank; onCommit never fires', async () => {
    const onCommit = vi.fn().mockResolvedValue(undefined);
    render(<CommitDialog isOpen onClose={vi.fn()} onCommit={onCommit} fileCount={2} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } });
    // The disabled primary button can't be clicked; drive the keyboard path.
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', metaKey: true });
    expect(await screen.findByText('Please enter a commit message')).toBeInTheDocument();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('submits on Cmd/Ctrl+Enter and closes on success', async () => {
    const onCommit = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<CommitDialog isOpen onClose={onClose} onCommit={onCommit} fileCount={2} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'wire the thing' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(onCommit).toHaveBeenCalledWith('wire the thing'));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('closes on Escape without committing', () => {
    const onCommit = vi.fn();
    const onClose = vi.fn();
    render(<CommitDialog isOpen onClose={onClose} onCommit={onCommit} fileCount={2} />);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    // The composer's Escape handler closes the dialog (the Modal may also observe
    // Escape, so assert "closed" rather than an exact call count).
    expect(onClose).toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('keeps the dialog open, shows the error, and re-enables when onCommit rejects', async () => {
    const onCommit = vi.fn().mockRejectedValue(new Error('nothing to commit'));
    const onClose = vi.fn();
    render(<CommitDialog isOpen onClose={onClose} onCommit={onCommit} fileCount={2} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'attempt' } });
    fireEvent.click(commitButton());
    expect(await screen.findByText('nothing to commit')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    // isCommitting reset in finally → the button is clickable again.
    await waitFor(() => expect(commitButton()).not.toBeDisabled());
  });
});
