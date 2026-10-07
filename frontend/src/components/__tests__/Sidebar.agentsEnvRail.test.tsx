/**
 * Sidebar Agents & Environments rail item: absent unless the feature is running, sits below System, shows on
 * Windows too, reflects the active pane via aria-pressed, and mounts the rail section above the project tree.
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
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
vi.mock('../agentsEnv/PersistentAgentsRailSection', () => ({
  PersistentAgentsRailSection: () => <div data-testid="rail-section-stub" />,
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

import React from 'react';
import { Sidebar } from '../Sidebar';
import { useNavigationStore } from '../../stores/navigationStore';
import { useAgentsEnvAvailable, usePersistentAgentsStore } from '../../stores/persistentAgentsStore';
import { makeStatus } from '../agentsEnv/__tests__/fixtures';

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
  useNavigationStore.setState({ agentsEnvOpen: false, agentsEnvAgentId: null });
  usePersistentAgentsStore.setState({ featureStatus: null });
});

type Extra = { agentsEnvAvailable?: boolean; agentsEnvActive?: boolean; onToggleAgentsEnv?: () => void };

function renderSidebar(props: Extra = {}) {
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

/** App's wiring in miniature: the real gate hook driving the real Sidebar. */
function Gated(): React.JSX.Element {
  const available = useAgentsEnvAvailable();
  const open = useNavigationStore((s) => s.agentsEnvOpen);
  return (
    <Sidebar
      onAboutClick={() => undefined}
      width={240}
      onResize={() => undefined}
      pendingReviewCount={0}
      humanReviewActive={false}
      onToggleHumanReview={() => undefined}
      agentsEnvAvailable={available}
      agentsEnvActive={open && available}
      onToggleAgentsEnv={() => useNavigationStore.getState().toggleAgentsEnv()}
    />
  );
}

describe('Sidebar: Agents & Environments rail item', () => {
  it('absent when agentsEnvAvailable is false or omitted', () => {
    const { rerender } = renderSidebar();
    expect(screen.queryByTestId('agents-env-rail-item')).toBeNull();
    expect(screen.queryByTestId('rail-section-stub')).toBeNull();
    rerender(
      <Sidebar
        onAboutClick={() => undefined}
        width={240}
        onResize={() => undefined}
        pendingReviewCount={0}
        humanReviewActive={false}
        onToggleHumanReview={() => undefined}
        agentsEnvAvailable={false}
      />,
    );
    expect(screen.queryByTestId('agents-env-rail-item')).toBeNull();
  });

  it('renders after System with its title and subtitle', () => {
    renderSidebar({ agentsEnvAvailable: true });
    const item = screen.getByTestId('agents-env-rail-item');
    expect(item).toHaveTextContent('Agents & Environments');
    expect(item).toHaveTextContent('Machines · persistent agents');
    const system = screen.getByTestId('system-rail-item');
    expect(system.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shown on Windows too, where the System item is absent', () => {
    isWindowsPlatformSpy.mockReturnValue(true);
    renderSidebar({ agentsEnvAvailable: true });
    expect(screen.getByTestId('agents-env-rail-item')).toBeInTheDocument();
    expect(screen.queryByTestId('system-rail-item')).toBeNull();
  });

  it('aria-pressed mirrors agentsEnvActive', () => {
    const { rerender } = renderSidebar({ agentsEnvAvailable: true, agentsEnvActive: false });
    expect(screen.getByTestId('agents-env-rail-item')).toHaveAttribute('aria-pressed', 'false');
    rerender(
      <Sidebar
        onAboutClick={() => undefined}
        width={240}
        onResize={() => undefined}
        pendingReviewCount={0}
        humanReviewActive={false}
        onToggleHumanReview={() => undefined}
        agentsEnvAvailable
        agentsEnvActive
      />,
    );
    expect(screen.getByTestId('agents-env-rail-item')).toHaveAttribute('aria-pressed', 'true');
  });

  it('a click calls onToggleAgentsEnv once', () => {
    const onToggleAgentsEnv = vi.fn();
    renderSidebar({ agentsEnvAvailable: true, onToggleAgentsEnv });
    fireEvent.click(screen.getByTestId('agents-env-rail-item'));
    expect(onToggleAgentsEnv).toHaveBeenCalledTimes(1);
  });

  it('the rail section mounts above Projects & Sessions', () => {
    renderSidebar({ agentsEnvAvailable: true });
    const stub = screen.getByTestId('rail-section-stub');
    const heading = screen.getByText('Projects & Sessions');
    expect(stub.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('a running status shows the item; a killed status removes it and closes an open pane', () => {
    usePersistentAgentsStore.setState({ featureStatus: makeStatus() });
    render(<Gated />);
    const item = screen.getByTestId('agents-env-rail-item');
    fireEvent.click(item);
    expect(useNavigationStore.getState().agentsEnvOpen).toBe(true);
    expect(screen.getByTestId('agents-env-rail-item')).toHaveAttribute('aria-pressed', 'true');

    act(() => {
      usePersistentAgentsStore.setState({ featureStatus: makeStatus({ enabled: true, killed: true, running: false }) });
    });
    expect(screen.queryByTestId('agents-env-rail-item')).toBeNull();
    expect(useNavigationStore.getState().agentsEnvOpen).toBe(false);
  });
});
