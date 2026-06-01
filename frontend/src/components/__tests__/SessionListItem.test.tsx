/**
 * SessionListItem component tests (TASK-749)
 *
 * Covers:
 *   1. Quick badge rendered when session.runId is null
 *   2. Quick badge absent when session.runId is a non-null string
 *   3. Archive (delete) handler fires after confirmation
 *   4. Rename via inline edit + Enter invokes API.sessions.rename
 *   5. Favorite button invokes API.sessions.toggleFavorite
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { Session } from '../../types/session';
import { ContextMenuProvider } from '../../contexts/ContextMenuContext';

// ---------------------------------------------------------------------------
// Stub sub-components that bring in heavy/irrelevant dependencies
// ---------------------------------------------------------------------------

vi.mock('../StatusIndicator', () => ({
  StatusIndicator: () => null,
}));

vi.mock('../GitStatusIndicator', () => ({
  GitStatusIndicator: () => null,
}));

vi.mock('../RunScriptConfigDialog', () => ({
  RunScriptConfigDialog: () => null,
}));

vi.mock('../NimbalystInstallDialog', () => ({
  NimbalystInstallDialog: () => null,
}));

vi.mock('../icons/NimbalystIcon', () => ({
  NimbalystIcon: () => null,
}));

// ---------------------------------------------------------------------------
// Mock API
// ---------------------------------------------------------------------------

const mockDelete = vi.fn();
const mockRename = vi.fn();
const mockToggleFavorite = vi.fn();
const mockHasRunScript = vi.fn();
const mockGetRunningSession = vi.fn();

vi.mock('../../utils/api', () => ({
  API: {
    sessions: {
      hasRunScript: (...args: Parameters<typeof mockHasRunScript>) => mockHasRunScript(...args),
      getRunningSession: (...args: Parameters<typeof mockGetRunningSession>) => mockGetRunningSession(...args),
      delete: (...args: Parameters<typeof mockDelete>) => mockDelete(...args),
      rename: (...args: Parameters<typeof mockRename>) => mockRename(...args),
      toggleFavorite: (...args: Parameters<typeof mockToggleFavorite>) => mockToggleFavorite(...args),
    },
  },
}));

// ---------------------------------------------------------------------------
// Mock stores
// ---------------------------------------------------------------------------

const mockSetActiveSession = vi.fn().mockResolvedValue(undefined);
const mockAddDeletingSessionId = vi.fn();
const mockRemoveDeletingSessionId = vi.fn();

// The fake state object the component destructures from useSessionStore()
const fakeSessionStoreState = {
  activeSessionId: null as string | null,
  setActiveSession: (...args: Parameters<typeof mockSetActiveSession>) => mockSetActiveSession(...args),
  deletingSessionIds: new Set<string>(),
  addDeletingSessionId: (...args: Parameters<typeof mockAddDeletingSessionId>) => mockAddDeletingSessionId(...args),
  removeDeletingSessionId: (...args: Parameters<typeof mockRemoveDeletingSessionId>) => mockRemoveDeletingSessionId(...args),
  isGitStatusLoading: (_id: string) => false,
};

vi.mock('../../stores/sessionStore', () => {
  // Zustand stores can be called with or without a selector.
  // The component calls `useSessionStore()` with no selector, so we
  // return the full fake state. We also expose `getState` so the
  // imperative `useSessionStore.getState().isGitStatusLoading(...)` call
  // inside the component's useEffect works.
  const hook = (selector?: (s: typeof fakeSessionStoreState) => unknown) => {
    if (typeof selector === 'function') {
      return selector(fakeSessionStoreState);
    }
    return fakeSessionStoreState;
  };
  hook.getState = () => fakeSessionStoreState;
  return { useSessionStore: hook };
});

const mockNavigateToSessions = vi.fn();

// The fake state for the navigation store
const fakeNavigationStoreState = {
  navigateToSessions: (...args: Parameters<typeof mockNavigateToSessions>) => mockNavigateToSessions(...args),
};

vi.mock('../../stores/navigationStore', () => {
  const hook = (selector?: (s: typeof fakeNavigationStoreState) => unknown) => {
    if (typeof selector === 'function') {
      return selector(fakeNavigationStoreState);
    }
    return fakeNavigationStoreState;
  };
  return { useNavigationStore: hook };
});

// ---------------------------------------------------------------------------
// Stub window.electronAPI
// ---------------------------------------------------------------------------

const mockInvoke = vi.fn();

beforeEach(() => {
  mockInvoke.mockReset();
  // Default: git-status returns no result (success: false) so no git status is set
  mockInvoke.mockResolvedValue({ success: false });

  Object.defineProperty(window, 'electronAPI', {
    writable: true,
    configurable: true,
    value: {
      invoke: mockInvoke,
      nimbalyst: {
        checkInstalled: vi.fn().mockResolvedValue({ success: true, data: false }),
        openWorktree: vi.fn().mockResolvedValue({ success: true }),
      },
    },
  });

  // Reset mocks
  mockDelete.mockReset();
  mockRename.mockReset();
  mockToggleFavorite.mockReset();
  mockHasRunScript.mockReset();
  mockGetRunningSession.mockReset();
  mockSetActiveSession.mockReset().mockResolvedValue(undefined);
  mockAddDeletingSessionId.mockReset();
  mockRemoveDeletingSessionId.mockReset();
  mockNavigateToSessions.mockReset();

  // Default API responses
  mockHasRunScript.mockResolvedValue({ success: true, data: false });
  mockGetRunningSession.mockResolvedValue({ success: true, data: null });
  mockDelete.mockResolvedValue({ success: true });
  mockRename.mockResolvedValue({ success: true });
  mockToggleFavorite.mockResolvedValue({ success: true });
});

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function sessionFixture(overrides: Partial<Session>): Session {
  return {
    id: 'sess-001',
    name: 'Test Session',
    worktreePath: '/tmp/worktree/test',
    prompt: 'Do something',
    status: 'ready',
    createdAt: '2026-01-01T00:00:00Z',
    output: [],
    jsonMessages: [],
    runId: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Render helper
// ---------------------------------------------------------------------------

async function renderItem(session: Session) {
  // Lazy import after mocks are set up
  const { SessionListItem } = await import('../SessionListItem');
  const result = render(
    <ContextMenuProvider>
      <SessionListItem session={session} />
    </ContextMenuProvider>,
  );
  return result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionListItem — Quick badge', () => {
  it('renders Quick badge when session.runId is null', async () => {
    const session = sessionFixture({ runId: null });
    await renderItem(session);
    expect(screen.getByTitle('Quick session — not linked to a workflow run')).toBeInTheDocument();
    expect(screen.getByText('Quick')).toBeInTheDocument();
  });

  it('does not render Quick badge when session.runId is set', async () => {
    const session = sessionFixture({ runId: 'flow-abc' });
    await renderItem(session);
    expect(screen.queryByText('Quick')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Quick session — not linked to a workflow run')).not.toBeInTheDocument();
  });
});

describe('SessionListItem — session actions on null-runId session', () => {
  it('archive button click + confirm invokes API.sessions.delete(session.id)', async () => {
    const session = sessionFixture({ runId: null });
    await renderItem(session);

    // Click the archive button (aria-label "Archive session")
    const archiveBtn = screen.getByRole('button', { name: /archive session/i });
    fireEvent.click(archiveBtn);

    // ConfirmDialog should now be shown — click the "Archive" confirm button
    const confirmBtn = await screen.findByRole('button', { name: /^Archive$/i });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(mockDelete).toHaveBeenCalledWith(session.id);
    });
  });

  it('inline rename + Enter invokes API.sessions.rename(session.id, newName)', async () => {
    const session = sessionFixture({ runId: null, name: 'Original Name' });
    await renderItem(session);

    // Right-click to open the context menu
    const sessionRow = screen.getByText('Original Name').closest('div[class*="rounded"]') ??
      screen.getByText('Original Name').parentElement!;
    fireEvent.contextMenu(sessionRow);

    // Click the Rename option in the context menu
    const renameBtn = await screen.findByRole('button', { name: /rename/i });
    fireEvent.click(renameBtn);

    // An input should now be shown with the current session name
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'New Name' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(mockRename).toHaveBeenCalledWith(session.id, 'New Name');
    });
  });

  it('favorite button click invokes API.sessions.toggleFavorite(session.id)', async () => {
    const session = sessionFixture({ runId: null, isFavorite: false });
    await renderItem(session);

    const favoriteBtn = screen.getByRole('button', { name: /add to favorites/i });
    fireEvent.click(favoriteBtn);

    await waitFor(() => {
      expect(mockToggleFavorite).toHaveBeenCalledWith(session.id);
    });
  });
});
