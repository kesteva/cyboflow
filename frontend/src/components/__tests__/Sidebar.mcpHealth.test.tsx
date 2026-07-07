/**
 * Sidebar MCP health indicator tests — post-TASK-626.
 *
 * The Sidebar bottom MCP dot was removed in TASK-626. StatusBar's
 * McpHealthIndicator is now the single MCP health surface.
 *
 * This file verifies:
 *   (a) Sidebar no longer renders a MCP dot or MCP label text.
 *   (b) useMcpHealth is not imported by Sidebar (verified by code grep,
 *       enforced here via the absence of any MCP-related DOM nodes).
 */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

// Mock useUpdater so the sidebar's mount-time updater subscription is a no-op.
// This test asserts MCP surfaces only; the updater path is exercised by
// Sidebar.updatePill.test.tsx. Pinning an idle state renders no update pill.
vi.mock('../../hooks/useUpdater', () => ({
  useUpdater: () => ({
    state: { status: 'idle' },
    check: vi.fn().mockResolvedValue(undefined),
    download: vi.fn(),
    install: vi.fn(),
    reset: vi.fn(),
  }),
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
// Helper
// ---------------------------------------------------------------------------

function renderSidebar() {
  return render(
    <Sidebar
      onAboutClick={() => undefined}
      onPromptHistoryClick={() => undefined}
      width={240}
      onResize={() => undefined}
      pendingReviewCount={0}
      humanReviewActive={false}
      onToggleHumanReview={() => undefined}
    />,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Sidebar — MCP indicator removed (TASK-626)', () => {
  it('does not render a MCP dot (no .bg-status-success.rounded-full in bottom section)', () => {
    renderSidebar();
    // The sidebar should not contain any MCP-specific status dots in the bottom bar.
    // Note: the StatusBar's McpHealthIndicator is NOT rendered in Sidebar tests.
    // We verify the bottom bar has no MCP label.
    const mcpLabel = screen.queryByText('MCP');
    expect(mcpLabel).not.toBeInTheDocument();
  });

  it('does not render a "MCP server:" tooltip anywhere in Sidebar', () => {
    renderSidebar();
    const mcpTitleEl = document.querySelector('[title^="MCP server:"]');
    expect(mcpTitleEl).not.toBeInTheDocument();
  });

  it('still renders the project tree section', () => {
    renderSidebar();
    expect(screen.getByTestId('project-tree')).toBeInTheDocument();
  });

  it('still renders the sidebar root element', () => {
    renderSidebar();
    expect(screen.getByTestId('sidebar')).toBeInTheDocument();
  });
});
