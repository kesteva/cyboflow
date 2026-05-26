/**
 * RunBottomPane component tests (TASK-756).
 *
 * Behaviors verified:
 *   1. Renders three tab buttons with labels Chat, Terminal, Data Stream.
 *   2. Data Stream is the default active tab; RunView is mounted on first render.
 *   3. Clicking Terminal tab shows the "Terminal — coming soon" placeholder and hides RunView.
 *   4. Clicking Chat tab shows the inline chat placeholder and hides RunView.
 *   5. Clicking Data Stream tab after switching away restores RunView.
 */
import '@testing-library/jest-dom';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock cyboflowApi — same pattern as RunView.test.tsx
// ---------------------------------------------------------------------------

vi.mock('../../../utils/cyboflowApi', () => ({
  subscribeToStreamEvents: vi.fn(() => vi.fn()),
  cyboflowApi: {
    subscribeToStreamEvents: vi.fn(() => vi.fn()),
    approveRun: vi.fn(),
  },
}));

// Import after mocks so vi.mock hoisting is in effect
import { RunBottomPane } from '../RunBottomPane';
import { useCyboflowStore } from '../../../stores/cyboflowStore';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  act(() => {
    useCyboflowStore.getState().clearActiveRun();
  });
  // jsdom does not implement scrollIntoView; stub it so RunView's auto-scroll
  // useEffect does not throw and tests can focus on rendering behaviour.
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RunBottomPane', () => {
  it('renders three tabs with labels Chat, Terminal, Data Stream', () => {
    render(<RunBottomPane />);
    expect(screen.getByRole('tab', { name: 'Chat' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Terminal' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Data Stream' })).toBeInTheDocument();
  });

  it('defaults to Data Stream tab and mounts RunView (renders activeRunId)', () => {
    act(() => {
      useCyboflowStore.getState().setActiveRun('run-xyz');
    });
    render(<RunBottomPane />);
    // RunView renders the runId text when Data Stream (default) tab is active
    expect(screen.getByText('run-xyz')).toBeInTheDocument();
  });

  it('clicking Terminal tab shows "Terminal — coming soon" and hides RunView', () => {
    act(() => {
      useCyboflowStore.getState().setActiveRun('run-xyz');
    });
    render(<RunBottomPane />);

    // Default: RunView is visible
    expect(screen.getByText('run-xyz')).toBeInTheDocument();

    // Click Terminal tab
    fireEvent.click(screen.getByRole('tab', { name: 'Terminal' }));

    // Terminal placeholder visible
    expect(screen.getByText('Terminal — coming soon')).toBeInTheDocument();
    // RunView content gone
    expect(screen.queryByText('run-xyz')).not.toBeInTheDocument();
  });

  it('clicking Chat tab shows the inline chat placeholder and hides RunView', () => {
    act(() => {
      useCyboflowStore.getState().setActiveRun('run-xyz');
    });
    render(<RunBottomPane />);

    // Default: RunView is visible
    expect(screen.getByText('run-xyz')).toBeInTheDocument();

    // Click Chat tab
    fireEvent.click(screen.getByRole('tab', { name: 'Chat' }));

    // Chat placeholder is visible
    expect(screen.getByTestId('run-bottom-pane-chat-placeholder')).toBeInTheDocument();
    // RunView content gone
    expect(screen.queryByText('run-xyz')).not.toBeInTheDocument();
  });

  it('clicking Data Stream tab after switching away restores RunView', () => {
    act(() => {
      useCyboflowStore.getState().setActiveRun('run-xyz');
    });
    render(<RunBottomPane />);

    // Switch to Terminal
    fireEvent.click(screen.getByRole('tab', { name: 'Terminal' }));
    expect(screen.queryByText('run-xyz')).not.toBeInTheDocument();

    // Switch back to Data Stream
    fireEvent.click(screen.getByRole('tab', { name: 'Data Stream' }));
    expect(screen.getByText('run-xyz')).toBeInTheDocument();
  });
});
