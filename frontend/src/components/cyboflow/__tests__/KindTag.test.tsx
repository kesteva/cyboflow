import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { KindTag } from '../KindTag';

describe('KindTag', () => {
  it('renders the worktree badge with the info hue and a square-tile-compatible label', () => {
    render(<KindTag kind="worktree" />);
    const badge = screen.getByTestId('kind-badge-worktree');
    expect(badge).toHaveTextContent('Worktree');
    expect(badge.className).toContain('text-status-info');
  });

  it('renders the process badge with the compound hue', () => {
    render(<KindTag kind="process" />);
    const badge = screen.getByTestId('kind-badge-process');
    expect(badge).toHaveTextContent('Process');
    expect(badge.className).toContain('--color-phase-compound');
  });

  it('locks shape to kind on the tile variant: square for worktree, round for process', () => {
    const { rerender } = render(<KindTag kind="worktree" variant="tile" />);
    expect(screen.getByTestId('kind-tile-worktree').className).toContain('rounded-card');
    expect(screen.getByTestId('kind-tile-worktree').className).not.toContain('rounded-full');

    rerender(<KindTag kind="process" variant="tile" />);
    expect(screen.getByTestId('kind-tile-process').className).toContain('rounded-full');
  });
});
