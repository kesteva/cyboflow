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
