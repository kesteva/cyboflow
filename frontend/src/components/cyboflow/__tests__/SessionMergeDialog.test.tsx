import '@testing-library/jest-dom';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../utils/api', () => ({
  API: {
    sessions: {
      squashAndRebaseToMain: vi.fn(),
      rebaseToMain: vi.fn(),
      delete: vi.fn(),
      getBranchCommitSubjects: vi.fn(),
    },
  },
}));

vi.mock('../../../stores/errorStore', () => ({
  useErrorStore: Object.assign(vi.fn(() => ({})), {
    getState: vi.fn(() => ({ showError: mockShowError })),
  }),
}));

const mockShowError = vi.fn();

import { SessionMergeDialog } from '../SessionMergeDialog';
import { API } from '../../../utils/api';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(API.sessions.squashAndRebaseToMain).mockResolvedValue({ success: true });
  vi.mocked(API.sessions.rebaseToMain).mockResolvedValue({ success: true });
  vi.mocked(API.sessions.delete).mockResolvedValue({ success: true });
  // Prefill probe fires on open; empty subjects = no prefill (tests own the field).
  vi.mocked(API.sessions.getBranchCommitSubjects).mockResolvedValue({
    success: true,
    data: { subjects: [] },
  });
});

describe('SessionMergeDialog', () => {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    sessionId: 'sess-merge-1',
    onSuccess: vi.fn(),
  };

  it('renders two equal strategy option cards', () => {
    render(<SessionMergeDialog {...defaultProps} />);
    expect(screen.getByTestId('strategy-squash')).toBeInTheDocument();
    expect(screen.getByTestId('strategy-preserve')).toBeInTheDocument();
    expect(screen.getByText('Squash merge')).toBeInTheDocument();
    expect(screen.getByText('Preserve commits')).toBeInTheDocument();
  });

  it('shows commit message textarea when squash is selected; hides when preserve is selected', () => {
    render(<SessionMergeDialog {...defaultProps} />);

    expect(screen.queryByTestId('squash-commit-message')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('strategy-squash'));
    expect(screen.getByTestId('squash-commit-message')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('strategy-preserve'));
    expect(screen.queryByTestId('squash-commit-message')).not.toBeInTheDocument();
  });

  it('confirm button disabled when no strategy is selected', () => {
    render(<SessionMergeDialog {...defaultProps} />);
    expect(screen.getByTestId('merge-confirm')).toBeDisabled();
  });

  it('confirm button disabled when squash selected but commit message is empty', () => {
    render(<SessionMergeDialog {...defaultProps} />);
    fireEvent.click(screen.getByTestId('strategy-squash'));
    expect(screen.getByTestId('merge-confirm')).toBeDisabled();
  });

  it('confirm button enabled when preserve-commits selected (no message needed)', () => {
    render(<SessionMergeDialog {...defaultProps} />);
    fireEvent.click(screen.getByTestId('strategy-preserve'));
    expect(screen.getByTestId('merge-confirm')).not.toBeDisabled();
  });

  it('squash confirm calls squashAndRebaseToMain then delete then onSuccess', async () => {
    render(<SessionMergeDialog {...defaultProps} />);
    fireEvent.click(screen.getByTestId('strategy-squash'));
    fireEvent.change(screen.getByPlaceholderText('Describe the changes...'), { target: { value: 'feat: my change' } });

    await act(async () => {
      fireEvent.click(screen.getByTestId('merge-confirm'));
    });

    expect(API.sessions.squashAndRebaseToMain).toHaveBeenCalledWith('sess-merge-1', 'feat: my change');
    expect(API.sessions.delete).toHaveBeenCalledWith('sess-merge-1');
    expect(defaultProps.onSuccess).toHaveBeenCalled();
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it('preserve confirm calls rebaseToMain then delete then onSuccess', async () => {
    render(<SessionMergeDialog {...defaultProps} />);
    fireEvent.click(screen.getByTestId('strategy-preserve'));

    await act(async () => {
      fireEvent.click(screen.getByTestId('merge-confirm'));
    });

    expect(API.sessions.rebaseToMain).toHaveBeenCalledWith('sess-merge-1');
    expect(API.sessions.delete).toHaveBeenCalledWith('sess-merge-1');
    expect(defaultProps.onSuccess).toHaveBeenCalled();
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it('merge failure triggers showError and skips delete', async () => {
    vi.mocked(API.sessions.squashAndRebaseToMain).mockResolvedValue({
      success: false,
      error: 'Merge conflict',
      details: 'Conflicting files: foo.ts',
    });

    render(<SessionMergeDialog {...defaultProps} />);
    fireEvent.click(screen.getByTestId('strategy-squash'));
    fireEvent.change(screen.getByPlaceholderText('Describe the changes...'), { target: { value: 'feat: change' } });

    await act(async () => {
      fireEvent.click(screen.getByTestId('merge-confirm'));
    });

    expect(mockShowError).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Merge failed',
      error: 'Merge conflict',
    }));
    expect(API.sessions.delete).not.toHaveBeenCalled();
    expect(defaultProps.onSuccess).not.toHaveBeenCalled();
  });

  it('shows loading state on confirm button during merge', async () => {
    let resolveSquash: (v: { success: boolean }) => void;
    vi.mocked(API.sessions.squashAndRebaseToMain).mockReturnValue(
      new Promise((res) => { resolveSquash = res; }),
    );

    render(<SessionMergeDialog {...defaultProps} />);
    fireEvent.click(screen.getByTestId('strategy-squash'));
    fireEvent.change(screen.getByPlaceholderText('Describe the changes...'), { target: { value: 'msg' } });

    await act(async () => {
      fireEvent.click(screen.getByTestId('merge-confirm'));
    });

    expect(screen.getByText('Merging...')).toBeInTheDocument();
    expect(screen.getByTestId('merge-confirm')).toBeDisabled();

    await act(async () => {
      resolveSquash!({ success: true });
    });
  });

  it('Cmd/Ctrl+Enter keyboard shortcut triggers confirm when enabled', async () => {
    render(<SessionMergeDialog {...defaultProps} />);
    fireEvent.click(screen.getByTestId('strategy-preserve'));

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Enter', metaKey: true });
    });

    await waitFor(() => {
      expect(API.sessions.rebaseToMain).toHaveBeenCalledWith('sess-merge-1');
    });
  });
});
