/**
 * backlogStore — Zustand slice for the native task backlog (cross-project board).
 *
 * GLOBAL. Like the singleton {@link useReviewQueueStore}, there is exactly ONE
 * backlog: `init()` performs a full sync across ALL projects
 * (`list({projectId: null})` + `boardsForProject({projectId: null})` + the
 * project list over IPC) and subscribes to `cyboflow.tasks.onTaskChanged` with
 * `projectId: null`, which bridges the chokepoint's cross-project
 * TASK_ALL_CHANNEL. Narrowing to one project is a pure VIEW concern:
 * `filterProjectId` (in-memory, default null = All projects) is applied by the
 * backlog selectors, never by the data layer.
 *
 * ## Idempotent while wired + teardown on unsubscribe
 *
 * `init()` is keyed on a closure-private `wired` boolean: while the single
 * global subscription is live, repeated calls (StrictMode double-effects,
 * multiple mounts) return the cached unsubscribe without re-syncing. Calling
 * that unsubscribe tears the subscription down so a later `init()` re-wires.
 *
 * ## Resync strategy (same as reviewQueueStore)
 *
 * The full-state list query is the source of truth. The `onTaskChanged`
 * subscription deltas are an optimisation applied on top — correctness does NOT
 * depend on receiving every delta (see {@link applyTaskChangeToList}, which
 * deliberately DROPS child upserts whose parent epic is absent). On any
 * subscription error we fall back to 'disconnected' and a later `init()`
 * re-syncs.
 *
 * ## Layout preference
 *
 * `layoutMode` ('kanban' | 'list') is persisted under `cyboflow-backlog-layout`
 * via {@link migrateLocalStorageKey} (mount-only migration from the legacy
 * `crystal-backlog-layout` key) — NEVER via ad-hoc getItem/setItem rename logic.
 */
import { create } from 'zustand';
import { trpc } from '../trpc/client';
import { API, type IPCResponse } from '../utils/api';
import { migrateLocalStorageKey } from '../utils/migrateLocalStorageKey';
import type { Project } from '../types/project';
import type { BacklogTaskItem, Board, TaskChangedEvent } from '../../../shared/types/tasks';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'disconnected';

export type LayoutMode = 'kanban' | 'list';

/** Minimal project reference — feeds the filter dropdown and card chips. */
export interface BacklogProjectRef {
  id: number;
  name: string;
}

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
  /** True once the first global full sync has committed (replaces projectId-keyed loading). */
  loaded: boolean;
  /** Top-level items across ALL projects (epics carry nested `children`). */
  tasks: BacklogTaskItem[];
  /** Boards (with their stages) across ALL projects — drives the unified columns. */
  boards: Board[];
  /** All known projects — feeds the filter dropdown and card project chips. */
  projects: BacklogProjectRef[];
  /** Active project filter; null = All projects (the default). In-memory only. */
  filterProjectId: number | null;
  /** tRPC subscription connection status, for display in the UI. */
  connectionStatus: ConnectionStatus;
  /** Persisted Kanban/List toggle. */
  layoutMode: LayoutMode;
  /** Whether archived items + hidden_by_default stages are shown. */
  showArchived: boolean;

  // -- Reducers (pure / synchronous) ---------------------------------------

  /** Replace the entire task list atomically (full-sync path). */
  replaceTasks: (tasks: BacklogTaskItem[]) => void;
  /** Replace the boards list atomically (full-sync path). */
  replaceBoards: (boards: Board[]) => void;
  /** Replace the projects list atomically (full-sync path). */
  replaceProjects: (projects: BacklogProjectRef[]) => void;
  /**
   * Apply a single TaskChangedEvent delta from the global stream. Idempotent
   * upsert by id (nested for child tasks), removes on `deleted` — see
   * {@link applyTaskChangeToList}. No project guard: the single subscription
   * carries every project.
   */
  applyTaskChange: (event: TaskChangedEvent) => void;
  /** Set the project filter (null = All projects). View-only, not persisted. */
  setFilterProject: (id: number | null) => void;
  /** Update the connection status. */
  setConnectionStatus: (status: ConnectionStatus) => void;
  /** Set + persist the layout mode. */
  setLayoutMode: (mode: LayoutMode) => void;
  /** Toggle the show-archived filter. */
  toggleShowArchived: () => void;

  // -- Actions (async / side-effectful) ------------------------------------

  /**
   * Initialise the global backlog: full sync (tasks + boards + projects, all
   * cross-project) and subscribe to the global task-change stream.
   *
   * Idempotent while wired — repeat calls return the cached unsubscribe.
   * Returns an unsubscribe function the caller should invoke on unmount; after
   * it runs, the next `init()` re-syncs and re-subscribes.
   */
  init: () => (() => void);
}

// ---------------------------------------------------------------------------
// Pure upsert/remove reducer — exported for unit testing.
// ---------------------------------------------------------------------------

/** Shallow-copy an epic with `children` swapped in and rollups recomputed. */
function withChildren(epic: BacklogTaskItem, children: BacklogTaskItem[]): BacklogTaskItem {
  return {
    ...epic,
    children,
    childCount: children.length,
    pendingTasks: children.filter((c) => !c.isDone).length,
  };
}

/**
 * Apply a TaskChangedEvent to the nested task list. Returns a NEW array.
 *
 *  - 'deleted': removes the matching id at the top level AND from every epic's
 *    `children`, recomputing childCount/pendingTasks on touched epics (no-op
 *    if absent).
 *  - upsert of a CHILD task (`parent_epic_id` set): upserts INSIDE the parent
 *    epic's `children` (rollups recomputed) — never appended at the top level.
 *    If the parent epic is not in the list the event is DROPPED: the full sync
 *    remains the source of truth for structure.
 *  - any other upsert: replaces an existing top-level id in place, else
 *    appends. Emitted epic snapshots are self-contained (no nested children —
 *    see taskChangeRouter.buildBacklogTaskItem), so an in-place epic upsert
 *    carries over the children we already hold.
 */
export function applyTaskChangeToList(
  tasks: BacklogTaskItem[],
  event: TaskChangedEvent,
): BacklogTaskItem[] {
  if (event.action === 'deleted') {
    const next: BacklogTaskItem[] = [];
    for (const t of tasks) {
      if (t.id === event.taskId) continue; // removed at the top level
      if (t.type === 'epic' && t.children?.some((c) => c.id === event.taskId)) {
        next.push(withChildren(t, t.children.filter((c) => c.id !== event.taskId)));
      } else {
        next.push(t);
      }
    }
    return next;
  }

  const incoming = event.task;

  // Child task: upsert inside the parent epic's `children`.
  if (incoming.parent_epic_id !== null) {
    const parentIdx = tasks.findIndex(
      (t) => t.id === incoming.parent_epic_id && t.type === 'epic',
    );
    if (parentIdx === -1) {
      // Parent epic absent (event raced the epic's creation, or a stale
      // delta): drop it rather than appending a child at the top level.
      return tasks;
    }
    const parent = tasks[parentIdx];
    const children = parent.children ?? [];
    const childIdx = children.findIndex((c) => c.id === incoming.id);
    const nextChildren =
      childIdx === -1
        ? [...children, incoming]
        : children.map((c, i) => (i === childIdx ? incoming : c));
    const next = tasks.slice();
    next[parentIdx] = withChildren(parent, nextChildren);
    return next;
  }

  // Top-level upsert.
  const idx = tasks.findIndex((t) => t.id === incoming.id);
  if (idx === -1) {
    return [...tasks, incoming];
  }
  const existing = tasks[idx];
  const next = tasks.slice();
  next[idx] =
    existing.type === 'epic' && incoming.children === undefined && existing.children
      ? withChildren(incoming, existing.children) // preserve nested children
      : incoming;
  return next;
}

// ---------------------------------------------------------------------------
// IPC project fetch
// ---------------------------------------------------------------------------

/**
 * Fetch the project list over IPC and map to the minimal refs the board needs.
 * The IPCResponse<T> is annotated explicitly (CLAUDE.md rule) so a handler
 * shape change fails typecheck here rather than silently at runtime. Throws on
 * a failed response so the caller's full-sync catch handles it uniformly.
 */
async function fetchProjectRefs(): Promise<BacklogProjectRef[]> {
  const res: IPCResponse<Project[]> = await API.projects.getAll();
  if (!res.success || !res.data) {
    throw new Error(res.error ?? 'projects.getAll returned no data');
  }
  return res.data.map((p) => ({ id: p.id, name: p.name }));
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useBacklogStore = create<BacklogState>((set, get) => {
  // Closure-private subscription state — NOT exposed via BacklogState.
  // `wired` tracks whether the single global subscription is live so init()
  // is idempotent while mounted; `wireGeneration` invalidates a full sync
  // still in flight when its wiring was torn down (and possibly re-created).
  let wired = false;
  let wireGeneration = 0;
  let cachedUnsubscribe: (() => void) | null = null;

  return {
    loaded: false,
    tasks: [],
    boards: [],
    projects: [],
    filterProjectId: null,
    connectionStatus: 'idle',
    layoutMode: readPersistedLayout(),
    showArchived: false,

    // -- Reducers -------------------------------------------------------------

    replaceTasks: (tasks) => set({ tasks: [...tasks] }),

    replaceBoards: (boards) => set({ boards: [...boards] }),

    replaceProjects: (projects) => set({ projects: [...projects] }),

    applyTaskChange: (event) => {
      set({ tasks: applyTaskChangeToList(get().tasks, event) });
    },

    setFilterProject: (id) => set({ filterProjectId: id }),

    setConnectionStatus: (status) => set({ connectionStatus: status }),

    setLayoutMode: (mode) => {
      persistLayout(mode);
      set({ layoutMode: mode });
    },

    toggleShowArchived: () => set((s) => ({ showArchived: !s.showArchived })),

    // -- Actions --------------------------------------------------------------

    init: () => {
      // Already wired — return the cached unsubscribe (no-op).
      if (wired && cachedUnsubscribe) {
        return cachedUnsubscribe;
      }

      wired = true;
      const generation = ++wireGeneration;
      set({ connectionStatus: 'connecting' });

      const {
        replaceTasks,
        replaceBoards,
        replaceProjects,
        applyTaskChange,
        setConnectionStatus,
      } = get();

      // Full-state resync: ALL projects' tasks + boards + the project list.
      Promise.all([
        trpc.cyboflow.tasks.list.query({ projectId: null }),
        trpc.cyboflow.tasks.boardsForProject.query({ projectId: null }),
        fetchProjectRefs(),
      ])
        .then(([tasks, boards, projects]) => {
          // Guard against a teardown (or teardown + re-init) that landed
          // mid-flight: only commit if this wiring is still the live one.
          if (!wired || generation !== wireGeneration) return;
          replaceTasks(tasks);
          replaceBoards(boards);
          replaceProjects(projects);
          set({ loaded: true });
          setConnectionStatus('connected');
        })
        .catch((err: unknown) => {
          if (!wired || generation !== wireGeneration) return;
          console.error('[backlogStore] full sync failed:', err);
          setConnectionStatus('disconnected');
        });

      // Subscribe to the GLOBAL task-change stream (TASK_ALL_CHANNEL bridge).
      const subscription = trpc.cyboflow.tasks.onTaskChanged.subscribe(
        { projectId: null },
        {
          onData: (event) => {
            applyTaskChange(event);
          },
          onError: (err: unknown) => {
            console.error('[backlogStore] onTaskChanged subscription error:', err);
            setConnectionStatus('disconnected');
            subscription.unsubscribe();
            // Clear closure state so a subsequent init() re-subscribes.
            if (generation === wireGeneration) {
              wired = false;
              cachedUnsubscribe = null;
            }
          },
        },
      );

      const unsubscribe = () => {
        subscription.unsubscribe();
        if (generation === wireGeneration) {
          wired = false;
          cachedUnsubscribe = null;
        }
      };
      cachedUnsubscribe = unsubscribe;
      return unsubscribe;
    },
  };
});
