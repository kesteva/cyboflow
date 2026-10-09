import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  RemoteSyncConflict,
  RemoteSyncProjectStatus,
  RemoteSyncStatus,
} from '../../../../shared/types/remoteSync';

const m = vi.hoisted(() => ({
  getStatus: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  listConflicts: vi.fn(),
  resolveConflict: vi.fn(),
}));
vi.mock('../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      remoteSync: {
        getStatus: { query: m.getStatus },
        onChanged: { subscribe: m.subscribe },
        listConflicts: { query: m.listConflicts },
        resolveConflict: { mutate: m.resolveConflict },
      },
    },
  },
}));

import { useRemoteSyncConflictsStore } from '../../stores/remoteSyncConflictsStore';
import { useBacklogStore } from '../../stores/backlogStore';
import { SyncConflictsHost } from './SyncConflictsHost';
import { SyncConflictBadge } from './SyncConflictBadge';
import { SyncConflictBanner } from './SyncConflictBanner';
import { SyncConflictDialog } from './SyncConflictDialog';
import type { BacklogTaskItem } from '../../../../shared/types/tasks';

function project(over: Partial<RemoteSyncProjectStatus> = {}): RemoteSyncProjectStatus {
  return {
    projectId: 1,
    name: 'P',
    remoteProjectId: 'r1',
    status: 'active',
    statusDetail: null,
    lastSyncAt: null,
    syncing: false,
    backoffUntil: null,
    openConflicts: 0,
    heldDeletes: 0,
    trackerClaims: [],
    ...over,
  };
}

function status(projects: RemoteSyncProjectStatus[], enabled = true): RemoteSyncStatus {
  return {
    available: true,
    enabled,
    cloudState: 'ok',
    device: null,
    serverOrigin: null,
    staging: false,
    signedIn: true,
    projects,
  };
}

function conflict(over: Partial<RemoteSyncConflict> = {}): RemoteSyncConflict {
  return {
    id: 'c1',
    projectId: 1,
    entityId: 'e1',
    entityType: 'task',
    entityRef: 'TASK-1',
    entityTitle: 'Do thing',
    kind: 'field',
    field: 'title',
    current: { value: 'Mine', device: 'd1', thisDevice: true, at: 1_700_000_000_000 },
    other: { value: 'Theirs', device: 'd2', thisDevice: false, at: 1_700_000_100_000 },
    extra: null,
    createdAt: 10,
    resolvedAt: null,
    resolution: null,
    pendingResolution: null,
    changedSince: false,
    currentNow: 'Mine',
    actions: ['keep', 'use_other', 'merge'],
    ...over,
  };
}

let pushStatus: (s: RemoteSyncStatus) => void = () => undefined;

async function mountHost(s: RemoteSyncStatus, conflicts: RemoteSyncConflict[] = []): Promise<void> {
  m.getStatus.mockResolvedValue(s);
  m.listConflicts.mockImplementation(async ({ view }: { view: string }) => (view === 'open' ? conflicts : []));
  m.subscribe.mockImplementation((_arg: undefined, h: { onData: (s: RemoteSyncStatus) => void }) => {
    pushStatus = h.onData;
    return { unsubscribe: m.unsubscribe };
  });
  render(<SyncConflictsHost />);
  await waitFor(() => expect(m.getStatus).toHaveBeenCalled());
}

describe('sync conflicts UI', () => {
  beforeEach(() => {
    for (const fn of Object.values(m)) fn.mockReset();
    useRemoteSyncConflictsStore.setState({
      status: null,
      conflicts: [],
      viewOpen: false,
      dialogConflictId: null,
      toast: null,
    });
  });

  describe('indicator', () => {
    it('renders nothing when unavailable', async () => {
      await mountHost({ available: false });
      expect(screen.queryByTestId('sync-indicator')).toBeNull();
    });

    it('renders nothing when sync is disabled or no project syncs', async () => {
      await mountHost(status([project()], false));
      expect(screen.queryByTestId('sync-indicator')).toBeNull();
    });

    it('renders nothing when the status query fails', async () => {
      m.getStatus.mockRejectedValue(new Error('boom'));
      m.subscribe.mockReturnValue({ unsubscribe: m.unsubscribe });
      render(<SyncConflictsHost />);
      await waitFor(() => expect(m.getStatus).toHaveBeenCalled());
      expect(screen.queryByTestId('sync-indicator')).toBeNull();
    });

    it('shows idle, syncing and error states', async () => {
      await mountHost(status([project()]));
      expect(await screen.findByTestId('sync-indicator')).toHaveAttribute('data-state', 'idle');
      act(() => pushStatus(status([project({ syncing: true })])));
      await waitFor(() => expect(screen.getByTestId('sync-indicator')).toHaveAttribute('data-state', 'syncing'));
      act(() => pushStatus(status([project({ backoffUntil: '2030-01-01T00:00:00Z' })])));
      await waitFor(() => expect(screen.getByTestId('sync-indicator')).toHaveAttribute('data-state', 'error'));
    });

    it('shows the open count excluding pending, and opens the view on click', async () => {
      await mountHost(status([project({ openConflicts: 2 })]), [
        conflict(),
        conflict({ id: 'c2', pendingResolution: 'keep' }),
      ]);
      const badge = await screen.findByTestId('sync-indicator-count');
      expect(badge).toHaveTextContent('1');
      fireEvent.click(screen.getByTestId('sync-indicator'));
      expect(await screen.findByTestId('sync-conflicts-view')).toBeInTheDocument();
    });
  });

  describe('toast', () => {
    it('fires once when the count rises, not on first load', async () => {
      await mountHost(status([project({ openConflicts: 1 })]), [conflict()]);
      await screen.findByTestId('sync-indicator');
      expect(useRemoteSyncConflictsStore.getState().toast).toBeNull();
      act(() => pushStatus(status([project({ openConflicts: 3 })])));
      await waitFor(() => expect(screen.getByText('3 sync conflicts need review')).toBeInTheDocument());
      // Same count again: nothing new.
      act(() => useRemoteSyncConflictsStore.getState().dismissToast());
      act(() => pushStatus(status([project({ openConflicts: 3 })])));
      expect(useRemoteSyncConflictsStore.getState().toast).toBeNull();
    });
  });

  describe('view', () => {
    it('groups by item with the applied side marked, and filters resolved', async () => {
      await mountHost(status([project({ openConflicts: 2 })]), [
        conflict(),
        conflict({ id: 'c2', field: 'body', createdAt: 20 }),
        conflict({ id: 'c3', entityId: 'e2', entityRef: 'TASK-2', entityTitle: 'Other' }),
      ]);
      await screen.findByTestId('sync-indicator');
      act(() => useRemoteSyncConflictsStore.getState().openView());
      expect(await screen.findAllByTestId('sync-conflict-group')).toHaveLength(2);
      expect(screen.getAllByTestId('sync-conflict-row')).toHaveLength(3);
      expect(screen.getAllByText('applied').length).toBe(3);
      expect(screen.getAllByText(/This computer · /).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/Another computer · /).length).toBeGreaterThan(0);

      m.listConflicts.mockImplementation(async ({ view }: { view: string }) =>
        view === 'resolved' ? [conflict({ id: 'r1', resolvedAt: 5, resolution: 'Kept current' })] : [],
      );
      fireEvent.click(screen.getByText('Resolved (30 days)'));
      expect(await screen.findByText('Resolved: Kept current')).toBeInTheDocument();
    });

    it('labels non-field kinds in words', async () => {
      await mountHost(status([project({ openConflicts: 1 })]), [
        conflict({ kind: 'dependency_edge', field: null, actions: ['keep'] }),
      ]);
      await screen.findByTestId('sync-indicator');
      act(() => useRemoteSyncConflictsStore.getState().openView());
      expect(await screen.findByText('Dependency removed to break a cycle')).toBeInTheDocument();
    });
  });

  describe('dialog', () => {
    function openDialogFor(c: RemoteSyncConflict): void {
      useRemoteSyncConflictsStore.setState({
        status: status([project({ openConflicts: 1 })]),
        conflicts: [c],
        dialogConflictId: c.id,
      });
      m.listConflicts.mockResolvedValue([c]);
      render(<SyncConflictDialog />);
    }

    beforeEach(() => {
      m.resolveConflict.mockResolvedValue({ ok: true });
    });

    it('focuses the default action and sends keep', async () => {
      openDialogFor(conflict());
      const keep = screen.getByRole('button', { name: 'Keep current' });
      expect(keep).toHaveFocus();
      fireEvent.click(keep);
      await waitFor(() =>
        expect(m.resolveConflict).toHaveBeenCalledWith({ conflictId: 'c1', action: { kind: 'keep' } }),
      );
    });

    it('sends use_other', async () => {
      openDialogFor(conflict());
      fireEvent.click(screen.getByRole('button', { name: 'Use the other value' }));
      await waitFor(() =>
        expect(m.resolveConflict).toHaveBeenCalledWith({ conflictId: 'c1', action: { kind: 'use_other' } }),
      );
    });

    it('merges with a pre-filled textarea', async () => {
      openDialogFor(conflict());
      fireEvent.click(screen.getByRole('button', { name: 'Merge…' }));
      const box = screen.getByLabelText('Merged value');
      expect(box).toHaveValue('Mine');
      fireEvent.change(box, { target: { value: 'Both' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save merged value' }));
      await waitFor(() =>
        expect(m.resolveConflict).toHaveBeenCalledWith({
          conflictId: 'c1',
          action: { kind: 'merge', value: 'Both' },
        }),
      );
    });

    it('shows a line diff for body and the changedSince notice with the newest value', () => {
      openDialogFor(
        conflict({
          field: 'body',
          current: { value: 'a\nb', device: null, thisDevice: true, at: 1 },
          other: { value: 'a\nc', device: null, thisDevice: false, at: 2 },
          changedSince: true,
          currentNow: 'a\nNEWEST',
        }),
      );
      expect(screen.getByTestId('sync-conflict-diff')).toBeInTheDocument();
      expect(screen.getByTestId('sync-conflict-changed-since')).toHaveTextContent(
        'Changed again since — the newest value here is shown as current',
      );
      expect(screen.getAllByText(/NEWEST/).length).toBeGreaterThan(0);
    });

    it('delete_vs_edit: lists lost values and recreates', async () => {
      openDialogFor(
        conflict({
          kind: 'delete_vs_edit',
          field: null,
          other: { value: { title: 'Lost title' }, device: null, thisDevice: false, at: 1 },
          actions: ['keep', 'recreate'],
        }),
      );
      expect(screen.getByText('Lost title')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Recreate as a new item' }));
      await waitFor(() =>
        expect(m.resolveConflict).toHaveBeenCalledWith({ conflictId: 'c1', action: { kind: 'recreate' } }),
      );
    });

    it('orphaned: moves under a chosen parent and deletes children after confirm', async () => {
      useBacklogStore.setState({
        tasks: [
          { id: 'ep1', project_id: 1, type: 'epic', ref: 'EPIC-1', title: 'Epic one' } as BacklogTaskItem,
          { id: 'tk1', project_id: 1, type: 'task', ref: 'TASK-9', title: 'A task' } as BacklogTaskItem,
        ],
      });
      openDialogFor(
        conflict({
          kind: 'orphaned',
          field: null,
          extra: { children: [{ id: 'k1', ref: 'TASK-5', type: 'task' }] },
          actions: ['keep', 'move', 'delete_children'],
        }),
      );
      expect(screen.getByText(/TASK-5/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Move…' }));
      expect(screen.queryByText(/A task/)).toBeNull();
      fireEvent.change(screen.getByLabelText('New parent'), { target: { value: 'ep1' } });
      fireEvent.click(screen.getByRole('button', { name: 'Move children' }));
      await waitFor(() =>
        expect(m.resolveConflict).toHaveBeenCalledWith({
          conflictId: 'c1',
          action: { kind: 'move', parentId: 'ep1' },
        }),
      );
    });

    it('orphaned: delete_children needs a confirm', async () => {
      openDialogFor(conflict({ kind: 'orphaned', field: null, extra: { children: [] }, actions: ['keep', 'delete_children'] }));
      fireEvent.click(screen.getByRole('button', { name: 'Delete children' }));
      expect(m.resolveConflict).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Yes, delete children' }));
      await waitFor(() =>
        expect(m.resolveConflict).toHaveBeenCalledWith({ conflictId: 'c1', action: { kind: 'delete_children' } }),
      );
    });

    it('shows the message on ok:false', async () => {
      m.resolveConflict.mockResolvedValue({ ok: false, message: 'Already resolved elsewhere' });
      openDialogFor(conflict());
      fireEvent.click(screen.getByRole('button', { name: 'Keep current' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Already resolved elsewhere');
    });
  });

  describe('badge and banner', () => {
    it('render null without a conflict', () => {
      const { container } = render(
        <>
          <SyncConflictBadge entityId="e1" />
          <SyncConflictBanner entityId="e1" />
        </>,
      );
      expect(container).toBeEmptyDOMElement();
    });

    it('render for an open conflict, not for a pending one; Review opens the dialog', () => {
      useRemoteSyncConflictsStore.setState({
        conflicts: [conflict(), conflict({ id: 'c9', entityId: 'e9', pendingResolution: 'keep' })],
      });
      render(
        <>
          <SyncConflictBadge entityId="e1" />
          <SyncConflictBanner entityId="e1" />
          <SyncConflictBadge entityId="e9" />
        </>,
      );
      expect(screen.getAllByTestId('sync-conflict-badge')).toHaveLength(1);
      expect(screen.getByTestId('sync-conflict-banner')).toHaveTextContent(
        'Title changed on two machines — the edit from this computer was applied.',
      );
      fireEvent.click(screen.getByRole('button', { name: 'Review' }));
      expect(useRemoteSyncConflictsStore.getState().dialogConflictId).toBe('c1');
    });
  });
});
