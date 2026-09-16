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

import { WorktreeStrip } from '../WorktreeStrip';
import { trpc } from '../../../trpc/client';
import type { WorktreeStatusEntry, WorktreeStatusPayload } from '../../../../../shared/types/runFiles';

const mockCommit = vi.mocked(trpc.cyboflow.sessionGit.commit.mutate);
const mockGitRestore = vi.mocked(trpc.cyboflow.workspaceFiles.gitRestore.mutate);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The lifted panel snapshot the strip renders (its `worktree` prop). */
function worktreeOf(entries: WorktreeStatusEntry[]): WorktreeStatusPayload {
  return { entries, groups: [], committedUnavailable: false };
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
});

describe('WorktreeStrip', () => {
  it('renders a count equal to entries.length of the LIFTED snapshot for a mixed-flags fixture (no fetch of its own)', () => {
    render(<WorktreeStrip sessionId="s1" worktree={worktreeOf(MIXED_ENTRIES)} />);
    expect(screen.getByTestId('worktree-strip-count').textContent).toBe('3 uncommitted');
  });

  it('counts a two-group file (staged AND unstaged) ONCE, not per group membership', () => {
    render(<WorktreeStrip sessionId="s1" worktree={worktreeOf(TWO_GROUP_ENTRIES)} />);
    expect(screen.getByTestId('worktree-strip-count').textContent).toBe('2 uncommitted');
  });

  it('a parentless run (sessionId null) still shows the lifted snapshot count, with both actions disabled', () => {
    render(<WorktreeStrip sessionId={null} worktree={worktreeOf(MIXED_ENTRIES)} />);
    expect(screen.getByTestId('worktree-strip-count').textContent).toBe('3 uncommitted');

    const commitBtn = screen.getByTestId('worktree-strip-commit') as HTMLButtonElement;
    const restoreBtn = screen.getByTestId('worktree-strip-restore') as HTMLButtonElement;
    expect(commitBtn.disabled).toBe(true);
    expect(commitBtn.getAttribute('title')).toBe('Select a session to commit changes');
    expect(restoreBtn.disabled).toBe(true);
    expect(restoreBtn.getAttribute('title')).toBe('Select a session to restore changes');
  });

  it('disables Commit… (with a title) but keeps Restore enabled when a conflicted entry is present', () => {
    render(<WorktreeStrip sessionId="s1" worktree={worktreeOf(CONFLICTED_ENTRIES)} />);
    expect(screen.getByTestId('worktree-strip-count').textContent).toBe('2 uncommitted');

    const commitBtn = screen.getByTestId('worktree-strip-commit') as HTMLButtonElement;
    const restoreBtn = screen.getByTestId('worktree-strip-restore') as HTMLButtonElement;
    expect(commitBtn.disabled).toBe(true);
    expect(commitBtn.getAttribute('title')).toBe('Resolve conflicts before committing');
    expect(restoreBtn.disabled).toBe(false);
  });

  it('with NO snapshot yet (loading / failed fetch) the count is unknown and Commit is disabled — never treated as clean', () => {
    render(<WorktreeStrip sessionId="s1" worktree={undefined} />);
    expect(screen.getByTestId('worktree-strip-count').textContent).toBe('… uncommitted');

    const commitBtn = screen.getByTestId('worktree-strip-commit') as HTMLButtonElement;
    expect(commitBtn.disabled).toBe(true);
    expect(commitBtn.getAttribute('title')).toBe('Working-tree status is not available yet');
    // Restore only needs a session.
    expect((screen.getByTestId('worktree-strip-restore') as HTMLButtonElement).disabled).toBe(false);
  });

  it('a pending snapshot followed by a conflicted one: Commit stays disabled throughout', () => {
    const { rerender } = render(<WorktreeStrip sessionId="s1" worktree={undefined} />);
    expect((screen.getByTestId('worktree-strip-commit') as HTMLButtonElement).disabled).toBe(true);

    rerender(<WorktreeStrip sessionId="s1" worktree={worktreeOf(CONFLICTED_ENTRIES)} />);
    const commitBtn = screen.getByTestId('worktree-strip-commit') as HTMLButtonElement;
    expect(commitBtn.disabled).toBe(true);
    expect(commitBtn.getAttribute('title')).toBe('Resolve conflicts before committing');
  });

  it('submission re-checks the LATEST snapshot: a dialog opened while clean refuses to commit once the tree is conflicted', async () => {
    const { rerender } = render(<WorktreeStrip sessionId="s1" worktree={worktreeOf(MIXED_ENTRIES)} />);
    fireEvent.click(screen.getByTestId('worktree-strip-commit'));
    const textarea = await screen.findByPlaceholderText('Enter commit message...');
    fireEvent.change(textarea, { target: { value: 'oops' } });

    // The tree turns conflicted while the dialog is open.
    rerender(<WorktreeStrip sessionId="s1" worktree={worktreeOf(CONFLICTED_ENTRIES)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }));

    await screen.findByText('Resolve conflicts before committing');
    expect(mockCommit).not.toHaveBeenCalled();
  });

  it('submission refuses to commit when the snapshot has been lost (undefined) since the dialog opened', async () => {
    const { rerender } = render(<WorktreeStrip sessionId="s1" worktree={worktreeOf(MIXED_ENTRIES)} />);
    fireEvent.click(screen.getByTestId('worktree-strip-commit'));
    const textarea = await screen.findByPlaceholderText('Enter commit message...');
    fireEvent.change(textarea, { target: { value: 'oops' } });

    rerender(<WorktreeStrip sessionId="s1" worktree={undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }));

    await screen.findByText('Working-tree status is not available yet');
    expect(mockCommit).not.toHaveBeenCalled();
  });

  it('Restore: confirms, calls gitRestore.mutate({ sessionId }), then signals onMutated', async () => {
    mockGitRestore.mockResolvedValue({ success: true });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onMutated = vi.fn();
    render(<WorktreeStrip sessionId="s1" worktree={worktreeOf(MIXED_ENTRIES)} onMutated={onMutated} />);

    fireEvent.click(screen.getByTestId('worktree-strip-restore'));
    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() => {
      expect(mockGitRestore).toHaveBeenCalledWith({ sessionId: 's1' });
    });
    await waitFor(() => expect(onMutated).toHaveBeenCalledTimes(1));
    confirmSpy.mockRestore();
  });

  it('Restore: declining the confirm calls no mutation and no onMutated', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const onMutated = vi.fn();
    render(<WorktreeStrip sessionId="s1" worktree={worktreeOf(MIXED_ENTRIES)} onMutated={onMutated} />);

    fireEvent.click(screen.getByTestId('worktree-strip-restore'));
    expect(confirmSpy).toHaveBeenCalled();
    expect(mockGitRestore).not.toHaveBeenCalled();
    expect(onMutated).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('Restore: a failed mutation does NOT signal onMutated', async () => {
    mockGitRestore.mockResolvedValue({ success: false, error: 'nope' });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onMutated = vi.fn();
    render(<WorktreeStrip sessionId="s1" worktree={worktreeOf(MIXED_ENTRIES)} onMutated={onMutated} />);

    fireEvent.click(screen.getByTestId('worktree-strip-restore'));
    await waitFor(() => expect(mockGitRestore).toHaveBeenCalled());
    await Promise.resolve();
    expect(onMutated).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('Commit…: a REFUSED commit (success:false) still signals onMutated so the stale snapshot is refetched', async () => {
    // The backend's live-index probe refused the commit (a conflict arrived
    // after this strip's last fetch). The strip's snapshot is now known-stale
    // — it must ask the rail to refetch instead of leaving Commit… enabled
    // beside a conflicted tree.
    mockCommit.mockResolvedValue({ success: false, error: 'Resolve conflicts before committing (1 unmerged: f.txt)' });
    const onMutated = vi.fn();
    render(<WorktreeStrip sessionId="s1" worktree={worktreeOf(MIXED_ENTRIES)} onMutated={onMutated} />);

    fireEvent.click(screen.getByTestId('worktree-strip-commit'));
    const textarea = await screen.findByPlaceholderText('Enter commit message...');
    fireEvent.change(textarea, { target: { value: 'wip' } });
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }));

    await waitFor(() => expect(mockCommit).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onMutated).toHaveBeenCalledTimes(1));
    // ...and the error still reaches the dialog.
    expect(await screen.findByText(/Resolve conflicts before committing/)).toBeTruthy();
  });

  it('width discipline (240px rail minimum): the count is the yielding element (min-w-0 truncate + title), the buttons never wrap', () => {
    render(
      <div style={{ width: 240 }}>
        <WorktreeStrip sessionId="s1" worktree={worktreeOf(MIXED_ENTRIES)} />
      </div>,
    );
    const strip = screen.getByTestId('worktree-strip');
    expect(strip.className).toMatch(/\bmin-w-0\b/);
    expect(strip.className).toMatch(/\boverflow-hidden\b/);

    const count = screen.getByTestId('worktree-strip-count');
    expect(count.className).toMatch(/\btruncate\b/);
    expect(count.className).toMatch(/\bmin-w-0\b/);
    expect(count.getAttribute('title')).toBe('3 uncommitted');

    for (const id of ['worktree-strip-commit', 'worktree-strip-restore']) {
      expect(screen.getByTestId(id).className).toMatch(/\bwhitespace-nowrap\b/);
    }
  });

  it('Commit…: opens CommitDialog, typing a message and confirming calls commit.mutate({ sessionId, message }) and signals onMutated', async () => {
    mockCommit.mockResolvedValue({ success: true });
    const onMutated = vi.fn();
    render(<WorktreeStrip sessionId="s1" worktree={worktreeOf(MIXED_ENTRIES)} onMutated={onMutated} />);
    expect(screen.getByTestId('worktree-strip-count').textContent).toBe('3 uncommitted');

    fireEvent.click(screen.getByTestId('worktree-strip-commit'));

    const textarea = await screen.findByPlaceholderText('Enter commit message...');
    fireEvent.change(textarea, { target: { value: 'my commit message' } });

    fireEvent.click(screen.getByRole('button', { name: 'Commit' }));

    await waitFor(() => {
      expect(mockCommit).toHaveBeenCalledWith({ sessionId: 's1', message: 'my commit message' });
    });
    await waitFor(() => expect(onMutated).toHaveBeenCalledTimes(1));
  });
});
