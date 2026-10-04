/**
 * Sidebar System rail item — present by default, ENTIRELY absent (not disabled)
 * when `isWindowsPlatform()` is true, and wired to `onToggleSystem`.
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { isWindowsPlatformSpy } = vi.hoisted(() => ({ isWindowsPlatformSpy: vi.fn() }));

vi.mock('../../utils/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/platform')>()),
  isWindowsPlatform: isWindowsPlatformSpy,
}));

vi.mock('../Settings', () => ({ Settings: () => null }));
vi.mock('../DraggableProjectTreeView', () => ({
  DraggableProjectTreeView: () => <div data-testid="project-tree" />,
}));
vi.mock('../ArchiveProgress', () => ({ ArchiveProgress: () => null }));
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
vi.mock('../../hooks/useUpdater', () => ({
  useUpdater: () => ({
    state: { status: 'idle' },
    check: vi.fn().mockResolvedValue(undefined),
    download: vi.fn(),
    install: vi.fn(),
    reset: vi.fn(),
  }),
}));

const mockInvoke = vi.fn();
beforeEach(() => {
  isWindowsPlatformSpy.mockReset();
  isWindowsPlatformSpy.mockReturnValue(false);
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue({ success: false });
  Object.defineProperty(window, 'electronAPI', {
    writable: true,
    value: {
      invoke: mockInvoke,
      getVersionInfo: () => Promise.resolve({ success: false }),
      uiState: { getExpanded: () => Promise.resolve({ success: false }) },
    },
  });
});

import React from 'react';
import { Sidebar } from '../Sidebar';

function renderSidebar(props: { systemActive?: boolean; onToggleSystem?: () => void } = {}) {
  return render(
    <Sidebar
      onAboutClick={() => undefined}
      width={240}
      onResize={() => undefined}
      pendingReviewCount={0}
      humanReviewActive={false}
      onToggleHumanReview={() => undefined}
      {...props}
    />,
  );
}

describe('Sidebar — System rail item', () => {
  it('renders below Verify Queue with the System eyebrow on non-Windows', () => {
    renderSidebar();
    const item = screen.getByTestId('system-rail-item');
    expect(item).toHaveTextContent('System · live process & worktree monitor');
    const verify = screen.getByTestId('verify-queue-rail-item');
    expect(verify.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('is absent (not merely disabled) when isWindowsPlatform() is true', () => {
    isWindowsPlatformSpy.mockReturnValue(true);
    renderSidebar();
    expect(screen.queryByTestId('system-rail-item')).not.toBeInTheDocument();
    // Sibling rail items are unaffected.
    expect(screen.getByTestId('verify-queue-rail-item')).toBeInTheDocument();
  });

  it('calls onToggleSystem on click and reflects systemActive via aria-pressed', () => {
    const onToggleSystem = vi.fn();
    renderSidebar({ systemActive: true, onToggleSystem });
    const item = screen.getByTestId('system-rail-item');
    expect(item).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(item);
    expect(onToggleSystem).toHaveBeenCalledTimes(1);
  });
});
