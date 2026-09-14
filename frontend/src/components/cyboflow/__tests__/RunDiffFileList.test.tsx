/**
 * RunDiffFileList tests — the flat changed-files list in the rail Diff tab.
 *
 * Asserts: one row per changed file with its +/- counts, click opens the file
 * (no inline diff / no toggle), the empty state, and non-interactive rows when
 * no open handler is wired.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { RunDiffFileList } from '../RunDiffFileList';
import type { WorktreeStatusPayload } from '../../../../../shared/types/runFiles';

// Two files: a modified one (+1/-1) and an added one (+2/-0).
const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,2 @@',
  ' context',
  '-old',
  '+new',
  'diff --git a/src/new.ts b/src/new.ts',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/src/new.ts',
  '@@ -0,0 +1,2 @@',
  '+line one',
  '+line two',
  '',
].join('\n');

describe('RunDiffFileList', () => {
  it('renders one row per changed file with +/- counts', () => {
    render(<RunDiffFileList diff={DIFF} onOpenFile={vi.fn()} />);

    const rows = screen.getAllByTestId('run-diff-file-row');
    expect(rows).toHaveLength(2);

    const modified = rows[0];
    expect(within(modified).getByText('src/a.ts')).toBeInTheDocument();
    expect(within(modified).getByText('+1')).toBeInTheDocument();
    expect(within(modified).getByText('−1')).toBeInTheDocument();

    const added = rows[1];
    expect(within(added).getByText('src/new.ts')).toBeInTheDocument();
    expect(within(added).getByText('+2')).toBeInTheDocument();
  });

  it('clicking a row opens that file (no inline diff)', () => {
    const onOpenFile = vi.fn();
    render(<RunDiffFileList diff={DIFF} onOpenFile={onOpenFile} />);

    fireEvent.click(screen.getByText('src/a.ts'));
    expect(onOpenFile).toHaveBeenCalledTimes(1);
    expect(onOpenFile).toHaveBeenCalledWith('src/a.ts');
    // No hunk/diff body is rendered in the list.
    expect(screen.queryByText('context')).not.toBeInTheDocument();
  });

  it('shows the empty state for an empty diff', () => {
    render(<RunDiffFileList diff="" onOpenFile={vi.fn()} />);
    expect(screen.getByTestId('run-diff-file-list-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('run-diff-file-row')).not.toBeInTheDocument();
  });

  it('rows are disabled when no open handler is provided', () => {
    render(<RunDiffFileList diff={DIFF} />);
    screen.getAllByTestId('run-diff-file-row').forEach((row) => {
      expect(row).toBeDisabled();
    });
  });
});

// Diff blob backing the grouped fixtures below. Deliberately omits
// src/new.ts (the untracked member) to exercise the "membership present in a
// group's rollup but absent from the combined diff blob" fallback.
const GROUPED_DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,2 @@',
  ' context',
  '-old',
  '+new',
  'diff --git a/src/shared.ts b/src/shared.ts',
  'index 1111111..2222222 100644',
  '--- a/src/shared.ts',
  '+++ b/src/shared.ts',
  '@@ -1,1 +1,2 @@',
  ' context',
  '+added line',
  'diff --git a/src/staged.ts b/src/staged.ts',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/src/staged.ts',
  '@@ -0,0 +1,3 @@',
  '+line one',
  '+line two',
  '+line three',
  '',
].join('\n');

// src/shared.ts is BOTH unstaged and committed-since-base, with DIFFERENT
// per-scope rollup numbers in each (the whole point of independent numstat
// calls per DiffGroupRollup).
const GROUPS: WorktreeStatusPayload = {
  entries: [
    { path: 'src/a.ts', staged: false, unstaged: true, untracked: false, conflicted: false },
    { path: 'src/shared.ts', staged: false, unstaged: true, untracked: false, conflicted: false },
    { path: 'src/staged.ts', staged: true, unstaged: false, untracked: false, conflicted: false },
    { path: 'src/new.ts', staged: false, unstaged: false, untracked: true, conflicted: false },
  ],
  groups: [
    { scope: 'unstaged', files: ['src/a.ts', 'src/shared.ts'], additions: 5, deletions: 2 },
    { scope: 'staged', files: ['src/staged.ts'], additions: 3, deletions: 0 },
    { scope: 'untracked', files: ['src/new.ts'], additions: 10, deletions: 0 },
    { scope: 'committed', files: ['src/shared.ts'], additions: 8, deletions: 1 },
  ],
  committedUnavailable: false,
};

describe('RunDiffFileList grouped rendering', () => {
  it('renders four group headers with correct per-group file counts', () => {
    render(<RunDiffFileList diff={GROUPED_DIFF} groups={GROUPS} onOpenFile={vi.fn()} />);

    expect(within(screen.getByTestId('run-diff-group-header-unstaged')).getByText('2 files')).toBeInTheDocument();
    expect(within(screen.getByTestId('run-diff-group-header-staged')).getByText('1 file')).toBeInTheDocument();
    expect(within(screen.getByTestId('run-diff-group-header-untracked')).getByText('1 file')).toBeInTheDocument();
    expect(within(screen.getByTestId('run-diff-group-header-committed')).getByText('1 file')).toBeInTheDocument();
  });

  it("shows each group's own +/- rollup, not a shared/recomputed pair, even for a file in two groups", () => {
    render(<RunDiffFileList diff={GROUPED_DIFF} groups={GROUPS} onOpenFile={vi.fn()} />);

    const unstagedHeader = screen.getByTestId('run-diff-group-header-unstaged');
    expect(within(unstagedHeader).getByText('+5')).toBeInTheDocument();
    expect(within(unstagedHeader).getByText('−2')).toBeInTheDocument();

    const committedHeader = screen.getByTestId('run-diff-group-header-committed');
    expect(within(committedHeader).getByText('+8')).toBeInTheDocument();
    expect(within(committedHeader).getByText('−1')).toBeInTheDocument();
  });

  it('renders a file present in two groups as two separate rows (no dedup)', () => {
    render(<RunDiffFileList diff={GROUPED_DIFF} groups={GROUPS} onOpenFile={vi.fn()} />);
    expect(screen.getAllByText('src/shared.ts')).toHaveLength(2);
  });

  it('passes the group scope as a second onOpenFile argument', () => {
    const onOpenFile = vi.fn();
    render(<RunDiffFileList diff={GROUPED_DIFF} groups={GROUPS} onOpenFile={onOpenFile} />);

    fireEvent.click(within(screen.getByTestId('run-diff-group-unstaged')).getByText('src/a.ts'));
    expect(onOpenFile).toHaveBeenCalledWith('src/a.ts', 'unstaged');
  });

  it('renders a conflicted entry in Unstaged with a conflict marker, never in Staged', () => {
    const groupsWithConflict: WorktreeStatusPayload = {
      entries: [
        ...GROUPS.entries,
        { path: 'src/conflict.ts', staged: false, unstaged: false, untracked: false, conflicted: true },
      ],
      groups: [
        { scope: 'unstaged', files: ['src/a.ts'], additions: 1, deletions: 1 },
        // Simulates a hypothetical upstream classification slip: even if a
        // conflicted path ends up in the staged membership list, it must
        // never render under Staged.
        { scope: 'staged', files: ['src/staged.ts', 'src/conflict.ts'], additions: 3, deletions: 0 },
        { scope: 'untracked', files: [], additions: 0, deletions: 0 },
        { scope: 'committed', files: [], additions: 0, deletions: 0 },
      ],
      committedUnavailable: false,
    };

    render(<RunDiffFileList diff={GROUPED_DIFF} groups={groupsWithConflict} onOpenFile={vi.fn()} />);

    const unstagedSection = screen.getByTestId('run-diff-group-unstaged');
    expect(within(unstagedSection).getByText('src/conflict.ts')).toBeInTheDocument();
    expect(within(unstagedSection).getByTestId('run-diff-conflict-marker')).toBeInTheDocument();

    const stagedSection = screen.getByTestId('run-diff-group-staged');
    expect(within(stagedSection).queryByText('src/conflict.ts')).not.toBeInTheDocument();
  });

  it('renders an explanatory empty state for Committed when committedUnavailable is true', () => {
    const groupsUnavailable: WorktreeStatusPayload = {
      ...GROUPS,
      groups: GROUPS.groups.map((g) => (g.scope === 'committed' ? { ...g, files: [], additions: 0, deletions: 0 } : g)),
      committedUnavailable: true,
    };

    render(<RunDiffFileList diff={GROUPED_DIFF} groups={groupsUnavailable} onOpenFile={vi.fn()} />);

    const committedSection = screen.getByTestId('run-diff-group-committed');
    expect(within(committedSection).getByTestId('run-diff-group-committed-unavailable')).toBeInTheDocument();
    expect(within(committedSection).queryByTestId('run-diff-file-row')).not.toBeInTheDocument();
  });

  it('collapses and re-expands a group on header click', () => {
    render(<RunDiffFileList diff={GROUPED_DIFF} groups={GROUPS} onOpenFile={vi.fn()} />);

    const unstagedSection = screen.getByTestId('run-diff-group-unstaged');
    expect(within(unstagedSection).getAllByTestId('run-diff-file-row')).toHaveLength(2);

    fireEvent.click(screen.getByTestId('run-diff-group-header-unstaged'));
    expect(within(unstagedSection).queryAllByTestId('run-diff-file-row')).toHaveLength(0);

    fireEvent.click(screen.getByTestId('run-diff-group-header-unstaged'));
    expect(within(unstagedSection).getAllByTestId('run-diff-file-row')).toHaveLength(2);
  });

  it('still shows the file count and rollup numbers at a narrow (240px) width', () => {
    render(
      <div style={{ width: 240 }}>
        <RunDiffFileList diff={GROUPED_DIFF} groups={GROUPS} onOpenFile={vi.fn()} />
      </div>,
    );

    const unstagedHeader = screen.getByTestId('run-diff-group-header-unstaged');
    expect(within(unstagedHeader).getByText('2 files')).toBeInTheDocument();
    expect(within(unstagedHeader).getByText('+5')).toBeInTheDocument();
    expect(within(unstagedHeader).getByText('−2')).toBeInTheDocument();
  });
});
