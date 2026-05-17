// @vitest-environment jsdom
/**
 * Sidebar MCP health dot rendering tests.
 *
 * Mocks useMcpHealth to return each of the four status values and asserts
 * that the dot's class name maps correctly:
 *   'running'  -> bg-status-success
 *   'starting' -> bg-status-warning
 *   'failed'   -> bg-status-error
 *   'stopped'  -> bg-status-error
 *
 * Also asserts the tooltip (title attribute) reflects the status string
 * and surfaces lastError when present.
 */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpHealth } from '../../hooks/useMcpHealth';

// ---------------------------------------------------------------------------
// Mock useMcpHealth before the Sidebar import so vi.mock hoisting works
// ---------------------------------------------------------------------------

const mockMcpHealth: McpHealth = { status: 'starting', restartAttempts: 0 };

vi.mock('../../hooks/useMcpHealth', () => ({
  useMcpHealth: () => mockMcpHealth,
}));

// ---------------------------------------------------------------------------
// Mock heavy Sidebar sub-components to keep this test fast and self-contained
// ---------------------------------------------------------------------------

vi.mock('../Settings', () => ({
  Settings: () => null,
}));

vi.mock('../DraggableProjectTreeView', () => ({
  DraggableProjectTreeView: () => <div data-testid="project-tree" />,
}));

vi.mock('../ArchiveProgress', () => ({
  ArchiveProgress: () => null,
}));

vi.mock('../ui/Modal', () => ({
  Modal: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ModalHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ModalBody: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('../ui/Button', () => ({
  IconButton: ({ onClick, children, 'aria-label': label }: {
    onClick?: () => void;
    children?: React.ReactNode;
    'aria-label'?: string;
  }) => (
    <button onClick={onClick} aria-label={label}>{children}</button>
  ),
}));

// Mock window.electronAPI for the version fetch
const mockInvoke = vi.fn();
beforeEach(() => {
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue({ success: false });
  Object.defineProperty(window, 'electronAPI', {
    writable: true,
    value: {
      invoke: mockInvoke,
      getVersionInfo: () => Promise.resolve({ success: false }),
      uiState: {
        getExpanded: () => Promise.resolve({ success: false }),
      },
    },
  });
});

// Import Sidebar after mocks are set up
import React from 'react';
import { Sidebar } from '../Sidebar';

// ---------------------------------------------------------------------------
// Helper to set mock health and render
// ---------------------------------------------------------------------------

function renderSidebar(health: McpHealth) {
  Object.assign(mockMcpHealth, health);
  return render(
    <Sidebar
      onHelpClick={() => undefined}
      onAboutClick={() => undefined}
      onPromptHistoryClick={() => undefined}
      width={240}
      onResize={() => undefined}
    />,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Sidebar MCP health dot', () => {
  it('renders a green dot when MCP status is running', () => {
    renderSidebar({ status: 'running', restartAttempts: 0 });

    const dot = document.querySelector('.bg-status-success.rounded-full');
    expect(dot).toBeInTheDocument();
  });

  it('renders a yellow dot when MCP status is starting', () => {
    renderSidebar({ status: 'starting', restartAttempts: 0 });

    const dot = document.querySelector('.bg-status-warning.rounded-full');
    expect(dot).toBeInTheDocument();
  });

  it('renders a red dot when MCP status is failed', () => {
    renderSidebar({ status: 'failed', restartAttempts: 2 });

    const dot = document.querySelector('.bg-status-error.rounded-full');
    expect(dot).toBeInTheDocument();
  });

  it('renders a red dot when MCP status is stopped', () => {
    renderSidebar({ status: 'stopped', restartAttempts: 0 });

    const dot = document.querySelector('.bg-status-error.rounded-full');
    expect(dot).toBeInTheDocument();
  });

  it('shows MCP status in the title tooltip', () => {
    renderSidebar({ status: 'running', restartAttempts: 0 });

    const container = screen.getByTitle('MCP server: running');
    expect(container).toBeInTheDocument();
  });

  it('includes lastError in tooltip when present', () => {
    renderSidebar({ status: 'failed', restartAttempts: 2, lastError: 'subprocess died' });

    const container = screen.getByTitle('MCP server: failed — subprocess died');
    expect(container).toBeInTheDocument();
  });

  it('renders MCP label text', () => {
    renderSidebar({ status: 'running', restartAttempts: 0 });

    expect(screen.getByText('MCP')).toBeInTheDocument();
  });
});
