/**
 * StatusBar component tests — covers the three McpHealthStatus states.
 *
 * Strategy: mock `useMcpHealthStore` to inject each status variant without
 * triggering real IPC calls, then assert dot color and popover content.
 *
 * Tests:
 *   1. Cold mount with default state → yellow dot (starting)
 *   2. Store set to healthy → green dot + "healthy" in popover
 *   3. Store set to error with message → red dot + error message in popover
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpHealthState, McpHealthActions, McpHealthStatus } from '../stores/mcpHealthStore';

// ---------------------------------------------------------------------------
// Mock mcpHealthStore before importing components
// ---------------------------------------------------------------------------

type StoreShape = McpHealthState & McpHealthActions;

const mockStoreState: StoreShape = {
  status: 'starting',
  lastCheckedAt: null,
  lastError: null,
  pid: null,
  setHealth: vi.fn(),
  subscribeToMcpHealth: vi.fn(() => () => undefined),
};

vi.mock('../stores/mcpHealthStore', () => ({
  useMcpHealthStore: () => mockStoreState,
}));

// Import after mock is set up
import { StatusBar } from './StatusBar';

// ---------------------------------------------------------------------------
// Helper: reset mock state between tests
// ---------------------------------------------------------------------------

function setStatus(
  status: McpHealthStatus,
  opts: { lastCheckedAt?: number | null; lastError?: string | null; pid?: number | null } = {},
) {
  mockStoreState.status = status;
  mockStoreState.lastCheckedAt = opts.lastCheckedAt ?? null;
  mockStoreState.lastError = opts.lastError ?? null;
  mockStoreState.pid = opts.pid ?? null;
}

beforeEach(() => {
  setStatus('starting');
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StatusBar — McpHealthIndicator integration', () => {
  it('1. cold mount with default state shows yellow (starting) dot', () => {
    setStatus('starting');
    render(<StatusBar />);

    // The dot should carry the yellow class and be data-status="starting"
    const dot = document.querySelector('[data-status="starting"]');
    expect(dot).toBeInTheDocument();
    expect(dot).toHaveClass('bg-status-warning');
    expect(dot).not.toHaveClass('bg-status-success');
    expect(dot).not.toHaveClass('bg-status-error');

    // The Cyboflow label should be present
    expect(screen.getByText('Cyboflow')).toBeInTheDocument();
  });

  it('2. transitions to green (healthy) and popover shows status and timestamp', () => {
    const NOW = 1_700_000_000_000;
    setStatus('healthy', { lastCheckedAt: NOW });
    render(<StatusBar />);

    // Dot should be green
    const dot = document.querySelector('[data-status="healthy"]');
    expect(dot).toBeInTheDocument();
    expect(dot).toHaveClass('bg-status-success');

    // Open popover by clicking the button
    const triggerButton = screen.getByRole('button', { name: /MCP server status: healthy/i });
    fireEvent.click(triggerButton);

    // Popover should appear
    const popover = screen.getByRole('dialog', { name: /MCP server diagnostics/i });
    expect(popover).toBeInTheDocument();

    // Status line should say "healthy"
    expect(popover).toHaveTextContent('healthy');

    // Timestamp should be rendered (not "never")
    expect(popover).not.toHaveTextContent('never');
  });

  it('3. transitions to red (error) and popover shows error message', () => {
    setStatus('error', { lastError: 'subprocess exited with code 1', lastCheckedAt: null });
    render(<StatusBar />);

    // Dot should be red
    const dot = document.querySelector('[data-status="error"]');
    expect(dot).toBeInTheDocument();
    expect(dot).toHaveClass('bg-status-error');

    // Open popover
    const triggerButton = screen.getByRole('button', { name: /MCP server status: error/i });
    fireEvent.click(triggerButton);

    const popover = screen.getByRole('dialog', { name: /MCP server diagnostics/i });
    expect(popover).toBeInTheDocument();

    // Error message should be visible
    expect(popover).toHaveTextContent('subprocess exited with code 1');

    // Timestamp should be "never" since lastCheckedAt is null
    expect(popover).toHaveTextContent('never');
  });
});
