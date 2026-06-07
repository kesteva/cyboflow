import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import { RunEndDialog } from '../RunEndDialog';

describe('RunEndDialog', () => {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    onConfirm: vi.fn(),
  };

  it('renders nothing when closed', () => {
    render(<RunEndDialog {...defaultProps} isOpen={false} />);
    expect(screen.queryByText(/End this workflow/)).not.toBeInTheDocument();
  });

  it('shows the completed copy + labels by default', () => {
    render(<RunEndDialog {...defaultProps} status="completed" />);
    expect(screen.getByText('End this workflow?')).toBeInTheDocument();
    expect(screen.getByText(/worktree and diff are preserved/)).toBeInTheDocument();
    expect(screen.getByText('End workflow')).toBeInTheDocument();
    expect(screen.getByText('Stay on workflow')).toBeInTheDocument();
  });

  it('tailors the title for a failed run', () => {
    render(<RunEndDialog {...defaultProps} status="failed" />);
    expect(screen.getByText('End this failed workflow?')).toBeInTheDocument();
  });

  it('clicking End workflow fires onConfirm', () => {
    const onConfirm = vi.fn();
    render(<RunEndDialog {...defaultProps} onConfirm={onConfirm} status="completed" />);
    fireEvent.click(screen.getByText('End workflow'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('clicking Stay on workflow closes without confirming', () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    render(<RunEndDialog {...defaultProps} onClose={onClose} onConfirm={onConfirm} status="completed" />);
    fireEvent.click(screen.getByText('Stay on workflow'));
    expect(onClose).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
