/**
 * Shared state for cross-machine sync conflicts (dev builds only).
 *
 * One status subscription feeds the toolbar indicator, the Conflicts view, the
 * per-item badge/banner and the "N sync conflicts need review" toast, so they
 * never each open their own. In a release build (`available: false`) or when
 * the query fails, `status` stays unavailable and every consumer renders nothing.
 */
import { create } from 'zustand';
import type { RemoteSyncConflict, RemoteSyncStatus } from '../../../shared/types/remoteSync';
import { trpc } from '../trpc/client';

type AvailableStatus = Extract<RemoteSyncStatus, { available: true }>;

interface RemoteSyncConflictsState {
  status: RemoteSyncStatus | null;
  /** Open conflicts across all synced projects; includes ones already resolved and waiting to send. */
  conflicts: RemoteSyncConflict[];
  viewOpen: boolean;
  dialogConflictId: string | null;
  /** One-shot toast text, set when the open count rises after a push. */
  toast: string | null;

  init: () => () => void;
  refreshConflicts: () => Promise<void>;
  openView: () => void;
  closeView: () => void;
  openDialog: (conflictId: string) => void;
  closeDialog: () => void;
  dismissToast: () => void;
}

function totalOpen(status: RemoteSyncStatus | null): number {
  if (status === null || !status.available) return 0;
  return status.projects.reduce((sum, p) => sum + p.openConflicts, 0);
}

/** Sync is on and at least one project syncs. */
export function isSyncActive(status: RemoteSyncStatus | null): status is AvailableStatus {
  return status !== null && status.available && status.enabled && status.projects.some((p) => p.remoteProjectId !== null);
}

/** Open conflicts that still need a person (not already resolved and pending send). */
export function needsReview(conflicts: RemoteSyncConflict[]): RemoteSyncConflict[] {
  return conflicts.filter((c) => c.resolvedAt === null && c.pendingResolution === null);
}

export const useRemoteSyncConflictsStore = create<RemoteSyncConflictsState>((set, get) => {
  let lastTotal: number | null = null;

  const applyStatus = (next: RemoteSyncStatus): void => {
    const total = totalOpen(next);
    const prev = lastTotal;
    lastTotal = total;
    const prevCounts = totalSignature(get().status);
    set({ status: next });
    if (prev !== null && total > prev) {
      set({ toast: `${total} sync conflict${total === 1 ? '' : 's'} need review` });
    }
    if (!next.available) {
      set({ conflicts: [] });
    } else if (prev === null || total !== prev || prevCounts !== totalSignature(next)) {
      void get().refreshConflicts();
    }
  };

  return {
    status: null,
    conflicts: [],
    viewOpen: false,
    dialogConflictId: null,
    toast: null,

    init: () => {
      lastTotal = null;
      let cancelled = false;
      try {
        void trpc.cyboflow.remoteSync.getStatus
          .query()
          .then((s) => {
            if (!cancelled && lastTotal === null) applyStatus(s);
          })
          .catch(() => {
            if (!cancelled && lastTotal === null) set({ status: { available: false } });
          });
      } catch {
        // No sync surface (or a partial test double): stay unavailable.
        set({ status: { available: false } });
      }
      let subscription: { unsubscribe: () => void } | null = null;
      try {
        subscription = trpc.cyboflow.remoteSync.onChanged.subscribe(undefined, {
          onData: (s) => {
            if (!cancelled) applyStatus(s);
          },
          onError: () => undefined,
        });
      } catch {
        // The initial query still renders; live pushes are an enhancement.
      }
      return () => {
        cancelled = true;
        subscription?.unsubscribe();
      };
    },

    refreshConflicts: async () => {
      if (!isSyncActive(get().status)) {
        set({ conflicts: [] });
        return;
      }
      try {
        const list = await trpc.cyboflow.remoteSync.listConflicts.query({ view: 'open' });
        set({ conflicts: list });
      } catch {
        // Keep what we have.
      }
    },

    openView: () => set({ viewOpen: true }),
    closeView: () => set({ viewOpen: false }),
    openDialog: (conflictId) => set({ dialogConflictId: conflictId }),
    closeDialog: () => set({ dialogConflictId: null }),
    dismissToast: () => set({ toast: null }),
  };
});

/** Per-project counts, so a count moving between projects still refetches. */
function totalSignature(status: RemoteSyncStatus | null): string {
  if (status === null || !status.available) return '';
  return status.projects.map((p) => `${p.projectId}:${p.openConflicts}`).join(',');
}
