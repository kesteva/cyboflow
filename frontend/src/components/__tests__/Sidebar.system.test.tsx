/**
 * Sidebar System rail item — present on non-Windows, entirely absent on
 * Windows (frontend half of the platform gate), and wired to onToggleSystem.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { isWindowsMock } = vi.hoisted(() => ({ isWindowsMock: vi.fn() }));

vi.mock('../../utils/platform', async (orig) => ({
  ...(await orig<typeof import('../../utils/platform')>()),
  isWindowsPlatform: isWindowsMock,
}));
vi.mock('../Settings', () => ({ Settings: () => null }));
vi.mock('../DraggableProjectTreeView', () => ({ DraggableProjectTreeView: () => <div /> }));
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
  }) => <button onClick={onClick} aria-label={label}>{children}</button>,
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

import React from 'react';
import { Sidebar } from '../Sidebar';

beforeEach(() => {
  isWindowsMock.mockReset();
  Object.defineProperty(window, 'electronAPI', {
    writable: true,
    value: {
      invoke: vi.fn().mockResolvedValue({ success: false }),
      getVersionInfo: () => Promise.resolve({ success: false }),
      uiState: { getExpanded: () => Promise.resolve({ success: false }) },
    },
  });
});

function renderSidebar(extra: Partial<React.ComponentProps<typeof Sidebar>> = {}) {
  return render(
    <Sidebar
      onAboutClick={() => undefined}
      width={240}
      onResize={() => undefined}
      pendingReviewCount={0}
      humanReviewActive={false}
      onToggleHumanReview={() => undefined}
      {...extra}
    />,
  );
}

describe('Sidebar — System rail item', () => {
  it('renders on non-Windows and toggles via onToggleSystem', () => {
    isWindowsMock.mockReturnValue(false);
    const onToggleSystem = vi.fn();
    renderSidebar({ onToggleSystem });
    const item = screen.getByTestId('system-rail-item');
    expect(item).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(item);
    expect(onToggleSystem).toHaveBeenCalledTimes(1);
  });

  it('reflects systemActive via aria-pressed', () => {
    isWindowsMock.mockReturnValue(false);
    renderSidebar({ systemActive: true });
    expect(screen.getByTestId('system-rail-item')).toHaveAttribute('aria-pressed', 'true');
  });

  it('is entirely absent (not disabled) on Windows', () => {
    isWindowsMock.mockReturnValue(true);
    renderSidebar();
    expect(screen.queryByTestId('system-rail-item')).not.toBeInTheDocument();
    expect(screen.queryByText('System')).not.toBeInTheDocument();
  });
});
