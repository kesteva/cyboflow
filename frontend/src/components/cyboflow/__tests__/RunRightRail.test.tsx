/**
 * RunRightRail component tests (TASK-767).
 *
 * Behaviors verified:
 *   1. Renders three tabs (Workflow Progress / File Explorer / Diff);
 *      Workflow Progress is default selected; its placeholder is visible on first render.
 *   2. Clicking File Explorer shows its placeholder and hides the Workflow Progress placeholder.
 *   3. Clicking Diff shows its placeholder and hides the other two placeholders.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';

import { RunRightRail } from '../RunRightRail';

describe('RunRightRail', () => {
  it('renders three tabs; Workflow Progress is selected by default and shows its placeholder', () => {
    render(<RunRightRail />);

    // All three tabs are present
    const wpTab = screen.getByRole('tab', { name: 'Workflow Progress' });
    const feTab = screen.getByRole('tab', { name: 'File Explorer' });
    const diffTab = screen.getByRole('tab', { name: 'Diff' });

    expect(wpTab).toBeInTheDocument();
    expect(feTab).toBeInTheDocument();
    expect(diffTab).toBeInTheDocument();

    // Workflow Progress is selected; others are not
    expect(wpTab.getAttribute('aria-selected')).toBe('true');
    expect(feTab.getAttribute('aria-selected')).toBe('false');
    expect(diffTab.getAttribute('aria-selected')).toBe('false');

    // Workflow Progress placeholder is visible
    expect(screen.getByTestId('run-right-rail-workflow-progress-placeholder')).toBeInTheDocument();

    // Root has required layout classes
    const root = screen.getByTestId('run-right-rail');
    expect(root).toHaveClass('w-[296px]');
    expect(root).toHaveClass('shrink-0');
    expect(root).toHaveClass('border-l');
  });

  it('clicking File Explorer tab shows its placeholder and hides the Workflow Progress placeholder', () => {
    render(<RunRightRail />);

    // Default: Workflow Progress visible
    expect(screen.getByTestId('run-right-rail-workflow-progress-placeholder')).toBeInTheDocument();

    // Click File Explorer
    fireEvent.click(screen.getByRole('tab', { name: 'File Explorer' }));

    // File Explorer placeholder is now visible
    expect(screen.getByTestId('run-right-rail-file-explorer-placeholder')).toBeInTheDocument();

    // Workflow Progress placeholder is gone
    expect(screen.queryByTestId('run-right-rail-workflow-progress-placeholder')).not.toBeInTheDocument();

    // aria-selected reflects new selection
    expect(screen.getByRole('tab', { name: 'File Explorer' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Workflow Progress' }).getAttribute('aria-selected')).toBe('false');
  });

  it('clicking Diff tab shows its placeholder and hides the other two placeholders', () => {
    render(<RunRightRail />);

    // Click Diff
    fireEvent.click(screen.getByRole('tab', { name: 'Diff' }));

    // Diff placeholder is visible
    expect(screen.getByTestId('run-right-rail-diff-placeholder')).toBeInTheDocument();

    // Other two placeholders are gone
    expect(screen.queryByTestId('run-right-rail-workflow-progress-placeholder')).not.toBeInTheDocument();
    expect(screen.queryByTestId('run-right-rail-file-explorer-placeholder')).not.toBeInTheDocument();

    // aria-selected reflects new selection
    expect(screen.getByRole('tab', { name: 'Diff' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Workflow Progress' }).getAttribute('aria-selected')).toBe('false');
    expect(screen.getByRole('tab', { name: 'File Explorer' }).getAttribute('aria-selected')).toBe('false');
  });
});
