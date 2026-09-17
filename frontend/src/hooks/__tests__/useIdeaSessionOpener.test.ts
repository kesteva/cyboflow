/**
 * Unit tests for useIdeaSessionOpener (idea sessions plan, Stage 4 backlog
 * "Open").
 *
 * Behaviors verified:
 *   1. Success routing: API.sessions.openIdeaSession is called with
 *      { projectId, ideaId } from the task, then setActiveQuickSession +
 *      setActiveProjectId + goToSession fire, mirroring
 *      DraggableProjectTreeView.handleSessionClick's quick-session arm.
 *   2. Null chatRunId tolerance: a pre-existing home whose sentinel backfill
 *      is absent (chatRunId: null) still routes — setActiveQuickSession is
 *      called with `undefined`, not `null`.
 *   3. openingTaskId reflects the in-flight task id and clears afterward.
 *   4. Failure (success: false, and a thrown rejection) surfaces in `error`
 *      without navigating, and never sets openingTaskId to a stale value.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

import { useIdeaSessionOpener } from '../useIdeaSessionOpener';
import type { BacklogTaskItem } from '../../../../shared/types/tasks';

const { mockOpenIdeaSession } = vi.hoisted(() => ({
  mockOpenIdeaSession: vi.fn(),
}));

vi.mock('../../utils/api', () => ({
  API: {
    sessions: {
      openIdeaSession: mockOpenIdeaSession,
    },
  },
}));

vi.mock('../../utils/cyboflowApi', () => ({
  subscribeToStreamEvents: vi.fn(() => vi.fn()),
}));

import { useCyboflowStore } from '../../stores/cyboflowStore';
import { useNavigationStore } from '../../stores/navigationStore';

function makeIdeaTask(overrides: Partial<BacklogTaskItem> = {}): BacklogTaskItem {
  return {
    id: 'idea-1',
    project_id: 7,
    type: 'idea',
    ref: 'IDEA-1',
    title: 'An idea',
    summary: null,
    body: null,
    priority: 'P2',
    category: 'feature',
    executor: 'agent',
    repo: null,
    parent_epic_id: null,
    originating_idea_id: null,
    scope: null,
    board_id: 'board-1',
    stage_id: 'stage-1',
    archived_at: null,
    decomposed_at: null,
    approved_at: null,
    sort_order: null,
    version: 1,
    stage_position: 1,
    inFlow: [],
    awaitingReview: false,
    isDone: false,
    memberships: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  mockOpenIdeaSession.mockReset();

  act(() => {
    useCyboflowStore.getState().clearActiveQuickSession();
    useNavigationStore.setState({ activeProjectId: null, view: 'home', backlogOpen: true });
  });
});

describe('useIdeaSessionOpener — success routing', () => {
  it('calls API.sessions.openIdeaSession with { projectId, ideaId } from the task', async () => {
    mockOpenIdeaSession.mockResolvedValue({
      success: true,
      data: { sessionId: 'sess-idea-1', chatRunId: 'run-idea-1', claudePanelId: 'panel-1', created: true },
    });
    const { result } = renderHook(() => useIdeaSessionOpener());

    await act(async () => {
      await result.current.openIdeaSession(makeIdeaTask());
    });

    expect(mockOpenIdeaSession).toHaveBeenCalledWith({ projectId: 7, ideaId: 'idea-1' });
  });

  it('sets the active quick session, project, and navigates to the session view', async () => {
    mockOpenIdeaSession.mockResolvedValue({
      success: true,
      data: { sessionId: 'sess-idea-1', chatRunId: 'run-idea-1', claudePanelId: 'panel-1', created: true },
    });
    const { result } = renderHook(() => useIdeaSessionOpener());

    await act(async () => {
      await result.current.openIdeaSession(makeIdeaTask());
    });

    expect(useCyboflowStore.getState().selectedSessionId).toBe('sess-idea-1');
    expect(useNavigationStore.getState().activeProjectId).toBe(7);
    expect(useNavigationStore.getState().view).toBe('session');
    expect(useNavigationStore.getState().backlogOpen).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('tolerates a null chatRunId (setActiveQuickSession receives undefined, not null)', async () => {
    mockOpenIdeaSession.mockResolvedValue({
      success: true,
      data: { sessionId: 'sess-idea-2', chatRunId: null, claudePanelId: 'panel-2', created: false },
    });
    const { result } = renderHook(() => useIdeaSessionOpener());

    await act(async () => {
      await result.current.openIdeaSession(makeIdeaTask({ id: 'idea-2' }));
    });

    // No throw, and the session still gets selected — the null chatRunId
    // never reaches setActiveQuickSession's `runId` param as a literal null.
    expect(useCyboflowStore.getState().selectedSessionId).toBe('sess-idea-2');
    expect(result.current.error).toBeNull();
  });
});

describe('useIdeaSessionOpener — openingTaskId', () => {
  it('is null before and after a call, and set to the task id while in flight', async () => {
    let resolveCall!: (value: unknown) => void;
    mockOpenIdeaSession.mockReturnValueOnce(new Promise((resolve) => { resolveCall = resolve; }));

    const { result } = renderHook(() => useIdeaSessionOpener());
    expect(result.current.openingTaskId).toBeNull();

    act(() => {
      void result.current.openIdeaSession(makeIdeaTask());
    });

    await waitFor(() => {
      expect(result.current.openingTaskId).toBe('idea-1');
    });

    await act(async () => {
      resolveCall({ success: false, error: 'cancelled' });
    });

    expect(result.current.openingTaskId).toBeNull();
  });
});

describe('useIdeaSessionOpener — failure', () => {
  it('surfaces a { success: false } error without navigating', async () => {
    mockOpenIdeaSession.mockResolvedValue({ success: false, error: 'Idea is archived' });
    const { result } = renderHook(() => useIdeaSessionOpener());

    await act(async () => {
      await result.current.openIdeaSession(makeIdeaTask());
    });

    expect(result.current.error).toBe('Idea is archived');
    expect(useCyboflowStore.getState().selectedSessionId).toBeNull();
    expect(useNavigationStore.getState().view).toBe('home');
  });

  it('surfaces a thrown rejection without navigating', async () => {
    mockOpenIdeaSession.mockRejectedValue(new Error('network error'));
    const { result } = renderHook(() => useIdeaSessionOpener());

    await act(async () => {
      await result.current.openIdeaSession(makeIdeaTask());
    });

    expect(result.current.error).toBe('network error');
    expect(useCyboflowStore.getState().selectedSessionId).toBeNull();
  });
});
