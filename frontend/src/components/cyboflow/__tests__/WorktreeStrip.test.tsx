import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// --- trpc mock (mirrors BaseSelector.test.tsx's pattern) -------------------
vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      sessionGit: {
        commit: { mutate: vi.fn() },
      },
      workspaceFiles: {
        gitRestore: { mutate: vi.fn() },
      },
    },
  },
}));

// --- API mock ---------------------------------------------------------------
vi.mock('../../../utils/api', () => ({
  API: {
    sessions: {
      getCombinedDiff: vi.fn(),
    },
  },
}));

import { WorktreeStrip } from '../WorktreeStrip';
import { trpc } from '../../../trpc/client';
import { API } from '../../../utils/api';
import type { WorktreeStatusEntry } from '../../../../../shared/types/runFiles';

const mockCommit = vi.mocked(trpc.cyboflow.sessionGit.commit.mutate);
const mockGitRestore = vi.mocked(trpc.cyboflow.workspaceFiles.gitRestore.mutate);
const mockGetCombinedDiff = vi.mocked(API.sessions.getCombinedDiff);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function diffResponse(entries: WorktreeStatusEntry[]) {
  return {
    success: true as const,
    data: {
      diff: '',
      stats: { additions: 0, deletions: 0, filesChanged: entries.length },
      changedFiles: entries.map((e) => e.path),
      resolvedBase: null,
      worktree: {
        entries,
        groups: [],
        committedUnavailable: false,
      },
    },
  };
}

const MIXED_ENTRIES: WorktreeStatusEntry[] = [
  { path: 'a.ts', staged: true, unstaged: false, untracked: false, conflicted: false },
  { path: 'b.ts', staged: false, unstaged: true, untracked: false, conflicted: false },
  { path: 'c.ts', staged: false, unstaged: false, untracked: true, conflicted: false },
];

// A file that is BOTH staged and unstaged (a two-group file, porcelain "MM")
// — must be counted ONCE, since entries.length (not group-membership summing)
// drives the count.
const TWO_GROUP_ENTRIES: WorktreeStatusEntry[] = [
  { path: 'a.ts', staged: true, unstaged: true, untracked: false, conflicted: false },
  { path: 'b.ts', staged: false, unstaged: true, untracked: false, conflicted: false },
];

const CONFLICTED_ENTRIES: WorktreeStatusEntry[] = [
  { path: 'a.ts', staged: false, unstaged: false, untracked: false, conflicted: true },
  { path: 'b.ts', staged: true, unstaged: false, untracked: false, conflicted: false },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCombinedDiff.mockResolvedValue(diffResponse(MIXED_ENTRIES));
});

describe('WorktreeStrip', () => {
  it('renders a count equal to entries.length for a mixed-flags fixture', async () => {
    render(<WorktreeStrip sessionId="s1" />);
    await waitFor(() => expect(mockGetCombinedDiff).toHaveBeenCalledWith('s1'));
    await waitFor(() => {
      expect(screen.getByTestId('worktree-strip-count').textContent).toBe('3 uncommitted');
    });
  });

  it('counts a two-group file (staged AND unstaged) ONCE, not per group membership', async () => {
    mockGetCombinedDiff.mockResolvedValue(diffResponse(TWO_GROUP_ENTRIES));
    render(<WorktreeStrip sessionId="s1" />);
    await waitFor(() => {
      expect(screen.getByTestId('worktree-strip-count').textContent).toBe('2 uncommitted');
    });
  });

  it('disables both buttons with explanatory titles when sessionId is null', async () => {
    render(<WorktreeStrip sessionId={null} />);
    expect(mockGetCombinedDiff).not.toHaveBeenCalled();

    const commitBtn = screen.getByTestId('worktree-strip-commit') as HTMLButtonElement;
    const restoreBtn = screen.getByTestId('worktree-strip-restore') as HTMLButtonElement;
    expect(commitBtn.disabled).toBe(true);
    expect(commitBtn.getAttribute('title')).toBe('Select a session to commit changes');
    expect(restoreBtn.disabled).toBe(true);
    expect(restoreBtn.getAttribute('title')).toBe('Select a session to restore changes');
  });

  it('disables Commit… (with a title) but keeps Restore enabled when a conflicted entry is present', async () => {
    mockGetCombinedDiff.mockResolvedValue(diffResponse(CONFLICTED_ENTRIES));
    render(<WorktreeStrip sessionId="s1" />);
    await waitFor(() => {
      expect(screen.getByTestId('worktree-strip-count').textContent).toBe('2 uncommitted');
    });

    const commitBtn = screen.getByTestId('worktree-strip-commit') as HTMLButtonElement;
    const restoreBtn = screen.getByTestId('worktree-strip-restore') as HTMLButtonElement;
    expect(commitBtn.disabled).toBe(true);
    expect(commitBtn.getAttribute('title')).toBe('Resolve conflicts before committing');
    expect(restoreBtn.disabled).toBe(false);
  });

  it('Restore: confirms, then calls gitRestore.mutate({ sessionId })', async () => {
    mockGitRestore.mockResolvedValue({ success: true });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<WorktreeStrip sessionId="s1" />);
    await waitFor(() => expect(mockGetCombinedDiff).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId('worktree-strip-restore'));
    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() => {
      expect(mockGitRestore).toHaveBeenCalledWith({ sessionId: 's1' });
    });
    confirmSpy.mockRestore();
  });

  it('Restore: declining the confirm calls no mutation', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<WorktreeStrip sessionId="s1" />);
    await waitFor(() => expect(mockGetCombinedDiff).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId('worktree-strip-restore'));
    expect(confirmSpy).toHaveBeenCalled();
    expect(mockGitRestore).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('Commit…: opens CommitDialog, typing a message and confirming calls commit.mutate({ sessionId, message })', async () => {
    mockCommit.mockResolvedValue({ success: true });
    render(<WorktreeStrip sessionId="s1" />);
    await waitFor(() => {
      expect(screen.getByTestId('worktree-strip-count').textContent).toBe('3 uncommitted');
    });

    fireEvent.click(screen.getByTestId('worktree-strip-commit'));

    const textarea = await screen.findByPlaceholderText('Enter commit message...');
    fireEvent.change(textarea, { target: { value: 'my commit message' } });

    fireEvent.click(screen.getByRole('button', { name: 'Commit' }));

    await waitFor(() => {
      expect(mockCommit).toHaveBeenCalledWith({ sessionId: 's1', message: 'my commit message' });
    });
  });
});
