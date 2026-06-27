/**
 * DiffViewer — file-header open-vs-toggle behavior.
 *
 * When `onOpenFile` is provided, clicking a file's header opens that file
 * (center-pane tab) rather than expanding/collapsing the inline diff; the
 * chevron button still toggles inline expansion. Without `onOpenFile` the whole
 * header toggles (legacy behavior). Monaco + ThemeContext are mocked so the test
 * stays a focused unit on the header interaction.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

vi.mock('../MonacoDiffViewer', () => ({
  MonacoDiffViewer: () => <div data-testid="monaco-diff-viewer-mock" />,
}));
vi.mock('../../../../contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: 'light' }),
}));

import DiffViewer from '../DiffViewer';

// One modified file with a single hunk — enough for a parseable header.
const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,2 @@',
  ' context',
  '-old',
  '+new',
  '',
].join('\n');

describe('DiffViewer — onOpenFile header behavior', () => {
  it('clicking the file header opens the file when onOpenFile is provided', () => {
    const onOpenFile = vi.fn();
    render(<DiffViewer diff={DIFF} isAllCommitsSelected={false} onOpenFile={onOpenFile} />);

    // The header carries the file path; click it.
    fireEvent.click(screen.getByText('src/a.ts'));

    expect(onOpenFile).toHaveBeenCalledTimes(1);
    expect(onOpenFile).toHaveBeenCalledWith('src/a.ts');
  });

  it('the chevron still toggles inline expansion (does not open the file)', () => {
    const onOpenFile = vi.fn();
    render(<DiffViewer diff={DIFF} isAllCommitsSelected={false} onOpenFile={onOpenFile} />);

    // Files expand by default → the collapse affordance is present.
    fireEvent.click(screen.getByRole('button', { name: 'Collapse diff' }));

    // The chevron stops propagation, so the header's open handler never fires.
    expect(onOpenFile).not.toHaveBeenCalled();
    // After collapsing, the chevron flips to the expand affordance.
    expect(screen.getByRole('button', { name: 'Expand diff' })).toBeInTheDocument();
  });

  it('without onOpenFile the header click toggles (legacy behavior)', () => {
    render(<DiffViewer diff={DIFF} isAllCommitsSelected={false} />);

    // No open-file affordance / chevron button is rendered in legacy mode.
    expect(screen.queryByRole('button', { name: 'Collapse diff' })).not.toBeInTheDocument();
    // The file header is still present and clickable (toggles inline diff).
    expect(screen.getByText('src/a.ts')).toBeInTheDocument();
  });
});
