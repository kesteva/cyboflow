/**
 * Sidebar update-pill render tests — TASK-001.
 *
 * The Sidebar bottom version line flips to an auto-updater pill driven by the
 * `useUpdater()` hook's discriminated `state.status`. This file verifies each
 * lifecycle rendering:
 *   - 'available'   → interactive "Update available →" pill; click → download()
 *   - 'downloading' → non-interactive "Downloading… {percent}%" pill (no click)
 *   - 'downloaded'  → interactive "Restart to update" pill; click → install()
 *   - other states  → muted "v{version}…" line; click → onAboutClick, no pill
 *   - check() runs exactly once on mount.
 *
 * The "Report a bug" button shares that footer block, so its independence from
 * `version` is guarded here too — see the second describe.
 *
 * Mocking mirrors Sidebar.mcpHealth.test.tsx: heavy sub-components are stubbed,
 * window.electronAPI is faked for the mount-time version fetch, and useUpdater
 * is mocked so each case can pin `state` and spy on the action fns.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UpdateUiState } from '../../hooks/useUpdater';

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

// ---------------------------------------------------------------------------
// useUpdater mock — per-test controllable state + action spies
// ---------------------------------------------------------------------------

const downloadSpy = vi.fn();
const installSpy = vi.fn();
const checkSpy = vi.fn();
const resetSpy = vi.fn();
let mockUpdateState: UpdateUiState = { status: 'idle' };

function setUpdaterState(state: UpdateUiState) {
  mockUpdateState = state;
}

vi.mock('../../hooks/useUpdater', () => ({
  useUpdater: () => ({
    state: mockUpdateState,
    check: checkSpy,
    download: downloadSpy,
    install: installSpy,
    reset: resetSpy,
  }),
}));

// ---------------------------------------------------------------------------
// window.electronAPI mock — mount-time version fetch must resolve a version so
// the bottom version block renders (it is gated on a truthy `version`).
// ---------------------------------------------------------------------------

const mockInvoke = vi.fn();
beforeEach(() => {
  downloadSpy.mockReset();
  installSpy.mockReset();
  checkSpy.mockReset().mockResolvedValue(undefined);
  resetSpy.mockReset();
  mockUpdateState = { status: 'idle' };

  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue({ success: false });
  Object.defineProperty(window, 'electronAPI', {
    writable: true,
    value: {
      invoke: mockInvoke,
      getVersionInfo: () =>
        Promise.resolve({
          success: true,
          data: { current: '1.2.3', gitCommit: 'abcdef1', worktreeName: 'main', variant: 'production' },
        }),
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

function renderSidebar(onAboutClick: () => void = () => undefined) {
  return render(
    <Sidebar
      onAboutClick={onAboutClick}
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

describe('Sidebar — update pill (TASK-001)', () => {
  it("status 'available' renders an interactive pill; clicking it calls download()", async () => {
    setUpdaterState({ status: 'available', version: '1.3.0' });
    renderSidebar();

    const pill = await screen.findByText('Update available →');
    expect(pill).toBeInTheDocument();

    fireEvent.click(pill);
    expect(downloadSpy).toHaveBeenCalledTimes(1);
    expect(installSpy).not.toHaveBeenCalled();
  });

  it("status 'downloading' renders a non-interactive progress pill (no click wired)", async () => {
    setUpdaterState({ status: 'downloading', percent: 42 });
    renderSidebar();

    const pill = await screen.findByText('Downloading… 42%');
    expect(pill).toBeInTheDocument();

    // No update-action pill text; clicking the progress element wires nothing.
    expect(screen.queryByText('Update available →')).not.toBeInTheDocument();
    expect(screen.queryByText('Restart to update')).not.toBeInTheDocument();

    fireEvent.click(pill);
    expect(downloadSpy).not.toHaveBeenCalled();
    expect(installSpy).not.toHaveBeenCalled();
  });

  it("status 'downloaded' renders an interactive pill; clicking it calls install()", async () => {
    setUpdaterState({ status: 'downloaded', version: '1.3.0' });
    renderSidebar();

    const pill = await screen.findByText('Restart to update');
    expect(pill).toBeInTheDocument();

    fireEvent.click(pill);
    expect(installSpy).toHaveBeenCalledTimes(1);
    expect(downloadSpy).not.toHaveBeenCalled();
  });

  it("status 'idle' renders the muted version line; clicking it calls onAboutClick and shows no pill", async () => {
    const onAboutClick = vi.fn();
    setUpdaterState({ status: 'idle' });
    renderSidebar(onAboutClick);

    const versionLine = await screen.findByTitle('Click to view version details');
    expect(versionLine).toHaveTextContent('v1.2.3');
    expect(versionLine).toHaveTextContent('main');
    expect(versionLine).toHaveTextContent('abcdef1');

    // None of the update-pill affordances should be present.
    expect(screen.queryByText('Update available →')).not.toBeInTheDocument();
    expect(screen.queryByText('Restart to update')).not.toBeInTheDocument();
    expect(screen.queryByText(/Downloading…/)).not.toBeInTheDocument();

    fireEvent.click(versionLine);
    expect(onAboutClick).toHaveBeenCalledTimes(1);
  });

  it("status 'unsupported' also renders the muted version line and no pill", async () => {
    const onAboutClick = vi.fn();
    setUpdaterState({ status: 'unsupported' });
    renderSidebar(onAboutClick);

    const versionLine = await screen.findByTitle('Click to view version details');
    expect(versionLine).toHaveTextContent('v1.2.3');
    expect(screen.queryByText('Update available →')).not.toBeInTheDocument();

    fireEvent.click(versionLine);
    expect(onAboutClick).toHaveBeenCalledTimes(1);
  });

  it('calls check() exactly once on mount', async () => {
    setUpdaterState({ status: 'idle' });
    renderSidebar();

    await waitFor(() => expect(checkSpy).toHaveBeenCalledTimes(1));
  });
});

/**
 * The footer's middle segment identifies WHICH dev checkout you are looking at.
 * It prefers the human session name over the worktree slug, because a renamed
 * session ("support codex assistant") says far more than the auto-generated
 * `hidden-comet-20260901` directory it lives in. The main process only reports
 * `sessionName` when it differs from the worktree name, so the renderer's rule
 * is a plain fallback.
 */
describe('Sidebar — version line workspace label', () => {
  function stubVersionInfo(data: Record<string, unknown>) {
    Object.defineProperty(window, 'electronAPI', {
      writable: true,
      value: {
        invoke: mockInvoke,
        getVersionInfo: () => Promise.resolve({ success: true, data }),
        uiState: { getExpanded: () => Promise.resolve({ success: false }) },
      },
    });
  }

  it('shows the session name instead of the worktree name when one is reported', async () => {
    setUpdaterState({ status: 'idle' });
    stubVersionInfo({
      current: '1.2.3',
      gitCommit: 'abcdef1',
      worktreeName: 'hidden-comet-20260901',
      sessionName: 'support codex assistant',
    });

    renderSidebar();

    const versionLine = await screen.findByTitle('Click to view version details');
    await waitFor(() => expect(versionLine).toHaveTextContent('support codex assistant'));
    expect(versionLine).not.toHaveTextContent('hidden-comet-20260901');
    expect(versionLine).toHaveTextContent('abcdef1');
  });

  it('falls back to the worktree name when no session name is reported', async () => {
    setUpdaterState({ status: 'idle' });
    stubVersionInfo({
      current: '1.2.3',
      gitCommit: 'abcdef1',
      worktreeName: 'hidden-comet-20260901',
    });

    renderSidebar();

    const versionLine = await screen.findByTitle('Click to view version details');
    await waitFor(() => expect(versionLine).toHaveTextContent('hidden-comet-20260901'));
  });
});

/**
 * The bug-report button lives INSIDE the same bordered footer block as the
 * version line, which is the whole risk this guards: the block must not inherit
 * the version line's `{version && …}` gate. A user whose version fetch failed —
 * or who is looking at the sidebar before it resolves — is exactly the user with
 * something to report.
 */
describe('Sidebar — bug report button', () => {
  it('renders even when the version fetch fails and the rest of the block does not', async () => {
    setUpdaterState({ status: 'available', version: '1.3.0' });
    Object.defineProperty(window, 'electronAPI', {
      writable: true,
      value: {
        invoke: mockInvoke,
        getVersionInfo: () => Promise.resolve({ success: false }),
        uiState: { getExpanded: () => Promise.resolve({ success: false }) },
      },
    });

    renderSidebar();

    expect(await screen.findByText('Report a bug')).toBeInTheDocument();
    // Everything version-gated stays absent — including the update pill, which
    // has always waited on `version` and still does.
    expect(screen.queryByTitle('Click to view version details')).not.toBeInTheDocument();
    expect(screen.queryByText('Update available →')).not.toBeInTheDocument();
  });

  it('opens the bug report dialog when clicked', async () => {
    setUpdaterState({ status: 'idle' });
    renderSidebar();

    fireEvent.click(await screen.findByText('Report a bug'));

    expect(await screen.findByText('Report a bug', { selector: 'h2' })).toBeInTheDocument();
  });
});
