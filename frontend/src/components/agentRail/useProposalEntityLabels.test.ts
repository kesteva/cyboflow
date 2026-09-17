/**
 * Unit tests for useProposalEntityLabels (TASK-221).
 *
 * ProposalCard.test.tsx already exercises this hook end-to-end through
 * ProposalCard/ProposalCardBodies for the task/epic/idea + stage path and the
 * happy/unresolved finding path. This file isolates the hook's own contract
 * more finely:
 *   - synchronous task/epic/idea resolution off the live backlogStore
 *     (including epic children flattened one level) and board-stage lookup.
 *   - the finding (`rvw_`) path: batched `reviewItems.get`, deduped across
 *     two ids in the SAME `ids` array so a shared finding fires one query,
 *     not two, and never refetched once the module-level cache holds a
 *     resolution (across separate hook renders/mounts).
 *   - a rejected `reviewItems.get` degrades to "unresolved" (absent from the
 *     map) rather than throwing or leaving the hook pending forever.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { BacklogTaskItem, Board } from '../../../../shared/types/tasks';
import { useBacklogStore } from '../../stores/backlogStore';
import { trpc } from '../../trpc/client';
import { useProposalEntityLabels } from './useProposalEntityLabels';

const mockReviewItemsGet = vi.mocked(trpc.cyboflow.reviewItems.get.query);

function makeBacklogTask(overrides: Partial<BacklogTaskItem> & { id: string; ref: string; title: string }): BacklogTaskItem {
  return {
    project_id: 1,
    type: 'task',
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
    stage_id: 'ready',
    archived_at: null,
    decomposed_at: null,
    approved_at: '2026-07-01T00:00:00.000Z',
    sort_order: null,
    version: 1,
    stage_position: 6,
    inFlow: [],
    awaitingReview: false,
    isDone: false,
    memberships: [],
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeBoard(overrides: Partial<Board> = {}): Board {
  return {
    id: 'board-1',
    project_id: 1,
    name: 'Default',
    kind: 'default',
    is_default: true,
    stages: [
      { id: 'ready', label: 'Ready', color_oklch: 'oklch(0.7 0.15 145)', hint: null, position: 5, write_policy: 'asserted', is_terminal: false, hidden_by_default: false },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  useBacklogStore.setState({ tasks: [], boards: [] });
});

describe('useProposalEntityLabels — task/epic/idea + stage (synchronous, off backlogStore)', () => {
  it('resolves a top-level task and flattens an epic\'s children one level', () => {
    useBacklogStore.setState({
      tasks: [
        makeBacklogTask({ id: 'tsk_flat', ref: 'TASK-001', title: 'Top-level task' }),
        makeBacklogTask({
          id: 'epc_1',
          ref: 'EPIC-033',
          title: 'Onboarding rework',
          type: 'epic',
          children: [makeBacklogTask({ id: 'tsk_child', ref: 'TASK-201', title: 'Child of the epic', parent_epic_id: 'epc_1' })],
        }),
      ],
      boards: [makeBoard()],
    });

    const { result } = renderHook(() => useProposalEntityLabels(['tsk_flat', 'epc_1', 'tsk_child']));

    expect(result.current.entities.get('tsk_flat')).toMatchObject({ ref: 'TASK-001', title: 'Top-level task', type: 'task' });
    expect(result.current.entities.get('epc_1')).toMatchObject({ ref: 'EPIC-033', title: 'Onboarding rework', type: 'epic' });
    expect(result.current.entities.get('tsk_child')).toMatchObject({ ref: 'TASK-201', title: 'Child of the epic', parentEpicId: 'epc_1' });
    expect(result.current.stages.get('ready')).toMatchObject({ label: 'Ready' });
  });

  it('an id absent from the backlog is simply absent from the map — never a placeholder entry', () => {
    const { result } = renderHook(() => useProposalEntityLabels(['tsk_missing']));
    expect(result.current.entities.has('tsk_missing')).toBe(false);
    expect(result.current.entities.size).toBe(0);
  });

  it('an unknown stage id is absent from the stages map', () => {
    useBacklogStore.setState({ boards: [makeBoard()] });
    const { result } = renderHook(() => useProposalEntityLabels([]));
    expect(result.current.stages.has('unknown-stage')).toBe(false);
  });
});

describe('useProposalEntityLabels — finding (`rvw_`) resolution', () => {
  it('batches two distinct finding ids into one Promise.all-driven fetch and resolves both', async () => {
    mockReviewItemsGet.mockImplementation(async ({ reviewItemId }) => {
      if (reviewItemId === 'rvw_a') return { id: 'rvw_a', title: 'Finding A' } as unknown as Awaited<ReturnType<typeof trpc.cyboflow.reviewItems.get.query>>;
      if (reviewItemId === 'rvw_b') return { id: 'rvw_b', title: 'Finding B' } as unknown as Awaited<ReturnType<typeof trpc.cyboflow.reviewItems.get.query>>;
      return null;
    });

    const { result } = renderHook(() => useProposalEntityLabels(['rvw_a', 'rvw_b']));
    expect(result.current.entities.has('rvw_a')).toBe(false);

    await waitFor(() => expect(result.current.entities.get('rvw_a')).toMatchObject({ title: 'Finding A', type: 'finding', ref: '' }));
    expect(result.current.entities.get('rvw_b')).toMatchObject({ title: 'Finding B', type: 'finding' });
  });

  it('dedupes two ids-arrays sharing the SAME finding id across two hook instances into one query', async () => {
    mockReviewItemsGet.mockClear();
    mockReviewItemsGet.mockImplementation(async () => ({ id: 'rvw_shared', title: 'Shared finding' }) as unknown as Awaited<ReturnType<typeof trpc.cyboflow.reviewItems.get.query>>);

    const first = renderHook(() => useProposalEntityLabels(['rvw_shared']));
    const second = renderHook(() => useProposalEntityLabels(['rvw_shared']));

    await waitFor(() => expect(first.result.current.entities.get('rvw_shared')).toMatchObject({ title: 'Shared finding' }));
    await waitFor(() => expect(second.result.current.entities.get('rvw_shared')).toMatchObject({ title: 'Shared finding' }));

    expect(mockReviewItemsGet).toHaveBeenCalledTimes(1);
  });

  it('once cached (success or not-found), a later mount for the same id does not refetch', async () => {
    mockReviewItemsGet.mockClear();
    mockReviewItemsGet.mockResolvedValueOnce({ id: 'rvw_once', title: 'Resolved once' } as unknown as Awaited<ReturnType<typeof trpc.cyboflow.reviewItems.get.query>>);

    const first = renderHook(() => useProposalEntityLabels(['rvw_once']));
    await waitFor(() => expect(first.result.current.entities.get('rvw_once')).toMatchObject({ title: 'Resolved once' }));
    expect(mockReviewItemsGet).toHaveBeenCalledTimes(1);

    // A fresh hook mount for the SAME id reads the module-level cache — no
    // second network round-trip, even though this is an entirely new
    // component instance.
    let second!: ReturnType<typeof renderHook<ReturnType<typeof useProposalEntityLabels>, unknown>>;
    await act(async () => {
      second = renderHook(() => useProposalEntityLabels(['rvw_once']));
      await Promise.resolve();
    });
    expect(second.result.current.entities.get('rvw_once')).toMatchObject({ title: 'Resolved once' });
    expect(mockReviewItemsGet).toHaveBeenCalledTimes(1);
  });

  it('a rejected fetch degrades to unresolved (absent from the map) rather than throwing', async () => {
    mockReviewItemsGet.mockClear();
    mockReviewItemsGet.mockRejectedValueOnce(new Error('network down'));

    const { result } = renderHook(() => useProposalEntityLabels(['rvw_errors']));
    await waitFor(() => expect(mockReviewItemsGet).toHaveBeenCalledWith({ reviewItemId: 'rvw_errors' }));
    // Give the .catch()/.finally() chain a tick to settle.
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.entities.has('rvw_errors')).toBe(false);
  });
});
