/**
 * backlogStore — Zustand slice for the native task backlog (Phase 0 + Phase 1).
 *
 * PROJECT-SCOPED. Unlike the singleton {@link useReviewQueueStore} (one global
 * queue), the backlog is per-project: every `init(projectId)` performs a full
 * sync for THAT project, replaces the in-memory tasks + boards, and subscribes
 * to `cyboflow.tasks.onTaskChanged` for that project's channel.
 *
 * ## Re-subscribe on projectId CHANGE (not just unmount)
 *
 * The active project can change without the BacklogPane unmounting (the user
 * picks another project while the pane stays open). `init()` therefore tears
 * down the previous project's subscription and re-syncs whenever the projectId
 * differs from the one currently wired — mirroring the resync intent of
 * reviewQueueStore but keyed on projectId rather than a one-shot guard.
 *
 * ## Resync strategy (same as reviewQueueStore)
 *
 * The full-state list query is the source of truth. The `onTaskChanged`
 * subscription deltas are an optimisation applied on top — correctness does NOT
 * depend on receiving every delta. On any subscription error we fall back to
 * 'disconnected' and a later `init()` re-syncs.
 *
 * ## Layout preference
 *
 * `layoutMode` ('kanban' | 'list') is persisted under `cyboflow-backlog-layout`
 * via {@link migrateLocalStorageKey} (mount-only migration from the legacy
 * `crystal-backlog-layout` key) — NEVER via ad-hoc getItem/setItem rename logic.
 */
import { create } from 'zustand';
import { trpc } from '../trpc/client';
import { migrateLocalStorageKey } from '../utils/migrateLocalStorageKey';
import type { BacklogTaskItem, Board, TaskChangedEvent } from '../../../shared/types/tasks';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'disconnected';

export type LayoutMode = 'kanban' | 'list';

const LAYOUT_LEGACY_KEY = 'crystal-backlog-layout';
const LAYOUT_KEY = 'cyboflow-backlog-layout';

/**
 * Read the persisted layout mode (mount-only legacy migration). Defaults to
 * 'kanban' when unset or invalid.
 */
export function readPersistedLayout(): LayoutMode {
  const raw = migrateLocalStorageKey(LAYOUT_LEGACY_KEY, LAYOUT_KEY);
  return raw === 'list' ? 'list' : 'kanban';
}

/** Persist the layout mode. Swallows storage failures (private mode). */
function persistLayout(mode: LayoutMode): void {
  try {
    localStorage.setItem(LAYOUT_KEY, mode);
  } catch {
    // Ignore — a failed persist must never crash a reducer.
  }
}

export interface BacklogState {
  /** Project whose backlog is currently loaded (null until first init). */
  projectId: number | null;
  /** Flat task list for the active project (epics carry nested `children`). */
  tasks: BacklogTaskItem[];
  /** Boards (with their stages) for the active project — drives the columns. */
  boards: Board[];
  /** tRPC subscription connection status, for display in the UI. */
  connectionStatus: ConnectionStatus;
  /** Persisted Kanban/List toggle. */
  layoutMode: LayoutMode;
  /** Whether hidden_by_default (won't-do / archived) stages are shown. */
  showArchived: boolean;

  // -- Reducers (pure / synchronous) ---------------------------------------

  /** Replace the entire task list atomically (full-sync path). */
  replaceTasks: (tasks: BacklogTaskItem[]) => void;
  /** Replace the boards list atomically (full-sync path). */
  replaceBoards: (boards: Board[]) => void;
  /**
   * Apply a single TaskChangedEvent delta. Idempotent on `created`/`updated`
   * (upsert by id), removes on `deleted`. Events for a different project are
   * ignored (stale subscription safety after a project switch).
   */
  applyTaskChange: (event: TaskChangedEvent) => void;
  /** Update the connection status. */
  setConnectionStatus: (status: ConnectionStatus) => void;
  /** Set + persist the layout mode. */
  setLayoutMode: (mode: LayoutMode) => void;
  /** Toggle the show-archived filter. */
  toggleShowArchived: () => void;

  // -- Actions (async / side-effectful) ------------------------------------

  /**
   * Initialise (or re-target) the store for `projectId`.
   *
   * - First call: full sync + subscribe.
   * - Same projectId again: no-op (returns the cached unsubscribe).
   * - DIFFERENT projectId: tear down the old subscription, re-sync, re-subscribe.
   *
   * Returns an unsubscribe function the caller should invoke on unmount.
   */
  init: (projectId: number) => (() => void);
}

// ---------------------------------------------------------------------------
// Pure upsert/remove reducer — exported for unit testing.
// ---------------------------------------------------------------------------

/**
 * Apply a TaskChangedEvent to a flat task list. Returns a NEW array.
 *  - 'deleted' removes the matching id (no-op if absent).
 *  - otherwise upserts: replaces an existing id in place, else appends.
 */
export function applyTaskChangeToList(
  tasks: BacklogTaskItem[],
  event: TaskChangedEvent,
): BacklogTaskItem[] {
  if (event.action === 'deleted') {
    return tasks.filter((t) => t.id !== event.taskId);
  }
  const idx = tasks.findIndex((t) => t.id === event.taskId);
  if (idx === -1) {
    return [...tasks, event.task];
  }
  const next = tasks.slice();
  next[idx] = event.task;
  return next;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useBacklogStore = create<BacklogState>((set, get) => {
  // Closure-private subscription state — NOT exposed via BacklogState.
  // `wiredProjectId` tracks which project the live subscription belongs to so
  // init() can detect a project CHANGE (not just a remount).
  let wiredProjectId: number | null = null;
  let cachedUnsubscribe: (() => void) | null = null;

  return {
    projectId: null,
    tasks: [],
    boards: [],
    connectionStatus: 'idle',
    layoutMode: readPersistedLayout(),
    showArchived: false,

    // -- Reducers -------------------------------------------------------------

    replaceTasks: (tasks) => set({ tasks: [...tasks] }),

    replaceBoards: (boards) => set({ boards: [...boards] }),

    applyTaskChange: (event) => {
      const state = get();
      // Ignore deltas for a project we are no longer showing — a late event
      // from a torn-down subscription must not corrupt the current view.
      if (state.projectId !== null && event.projectId !== state.projectId) return;
      set({ tasks: applyTaskChangeToList(state.tasks, event) });
    },

    setConnectionStatus: (status) => set({ connectionStatus: status }),

    setLayoutMode: (mode) => {
      persistLayout(mode);
      set({ layoutMode: mode });
    },

    toggleShowArchived: () => set((s) => ({ showArchived: !s.showArchived })),

    // -- Actions --------------------------------------------------------------

    init: (projectId) => {
      // Same project already wired — return the cached unsubscribe (no-op).
      if (wiredProjectId === projectId && cachedUnsubscribe) {
        return cachedUnsubscribe;
      }

      // Project CHANGED (or first init): tear down any prior subscription.
      if (cachedUnsubscribe) {
        cachedUnsubscribe();
      }

      wiredProjectId = projectId;
      set({ projectId, connectionStatus: 'connecting' });

      const { replaceTasks, replaceBoards, applyTaskChange, setConnectionStatus } = get();

      // Full-state resync: fetch tasks + boards for this project in parallel.
      Promise.all([
        trpc.cyboflow.tasks.list.query({ projectId }),
        trpc.cyboflow.tasks.boardsForProject.query({ projectId }),
      ])
        .then(([tasks, boards]) => {
          // Guard against a project switch that landed mid-flight: only commit
          // if this project is still the wired one.
          if (wiredProjectId !== projectId) return;
          replaceTasks(tasks);
          replaceBoards(boards);
          setConnectionStatus('connected');
        })
        .catch((err: unknown) => {
          if (wiredProjectId !== projectId) return;
          console.error('[backlogStore] full sync failed:', err);
          setConnectionStatus('disconnected');
        });

      // Subscribe to per-project task-change deltas.
      const subscription = trpc.cyboflow.tasks.onTaskChanged.subscribe(
        { projectId },
        {
          onData: (event) => {
            applyTaskChange(event);
          },
          onError: (err: unknown) => {
            console.error('[backlogStore] onTaskChanged subscription error:', err);
            setConnectionStatus('disconnected');
            subscription.unsubscribe();
            // Clear closure state so a subsequent init() re-subscribes.
            if (wiredProjectId === projectId) {
              wiredProjectId = null;
              cachedUnsubscribe = null;
            }
          },
        },
      );

      const unsubscribe = () => {
        subscription.unsubscribe();
        if (wiredProjectId === projectId) {
          wiredProjectId = null;
          cachedUnsubscribe = null;
        }
      };
      cachedUnsubscribe = unsubscribe;
      return unsubscribe;
    },
  };
});
