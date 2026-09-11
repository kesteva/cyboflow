/**
 * customViewsStore — the renderer's read model for Custom Views
 * (docs/proposals/CUSTOM-VIEWS.md §5.5).
 *
 * Holds the saved views per surface, which one is active, and the custom-widget
 * library. It deliberately does NOT hold widget DATA: every `WidgetHost` owns
 * its own poll, because two instances of the same widget with different
 * settings are different data and a shared cache here would just re-implement
 * the main process's (§4.3).
 *
 * ## Scope in S4
 *
 * This is the READ path only. The customize-mode editing actions the plan lists
 * on this store (`enterCustomize` / `moveItem` / `toggleHidden` /
 * `updateItemSettings` / `removeItem` / `insertItem` / `save` / `discard`) land
 * in S5, and the authoring actions (`openAuthoring` / `onDraftEvent` /
 * `finishAuthoring`) in S6. The `authoring` field is declared here — typed as
 * the plan specifies — and stays `null`; the `onWidgetDraft` subscription is
 * opened here too, and its events are dropped, because the SUBSCRIPTION IS THE
 * LOAD-BEARING PART: it must be live before the seed queries so a draft landing
 * mid-load is never missed once S6 binds a handler to it.
 *
 * ## Seed-query + subscription race
 *
 * `init(surface)` follows the canonical policy (`hooks/useWorkflowPhaseState.ts`):
 * open the subscription FIRST, then fire the seed queries, then commit on
 * resolution behind a `cancelled` flag. A subscription opened after the seeds
 * would leave a window in which an event is lost.
 *
 * ## Refcounting
 *
 * Both landing pages can be mounted at once (the shell keeps the review queue
 * alive behind the project overview), and each calls `init`. Per surface we
 * keep ONE subscription plus a refcount; the release returned by `init` is
 * idempotent and tears the wiring down only at zero — the `reviewItemsSlice`
 * idiom, generation counter included so a release issued for a superseded
 * wiring cannot decrement the new one.
 *
 * ## Degrading, never blanking
 *
 * Every call is caught. A backend without the router wired (or a test that
 * mocks a narrower `trpc`) leaves the surface unloaded and `viewsBySurface`
 * empty, which `ViewSurface` renders as the Default view — the current page.
 * That is the correct failure mode: customization is additive, so losing it
 * must cost nothing.
 *
 * ## S5 — the draft (customize mode)
 *
 * `draft` is the ONLY thing customize-mode editing touches; the saved
 * `viewsBySurface` entry is untouched until `save` succeeds. `enterCustomize`
 * seeds the draft from the active view's layout when one is active, or — when
 * Default is active (including "not loaded yet" and a corrupt active view) —
 * from the canonical catalog section order, so customizing from Default starts
 * from exactly what the user is already looking at. Every editing action
 * (`moveItem` / `toggleHidden` / `updateItemSettings` / `removeItem` /
 * `insertItem`) is a pure `draft.layout.items` transform and a no-op when
 * there is no draft for anything to apply to.
 *
 * `save` never throws to its caller: on failure (a CAS `concurrency` race,
 * `name_taken`, or anything else) it records the code on `draft.saveError` and
 * KEEPS the draft, so the customize-mode UI stays exactly where the user left
 * it with the reason visible — see `edit/SaveDiscardControls.tsx`. Only a
 * successful save or an explicit `discard()` clears `draft`.
 */
import { create } from 'zustand';
import { trpc } from '../trpc/client';
import { CATALOG_WIDGET_SPECS } from '../../../shared/customViews/catalogSpecs';
import { sectionOrderFor } from '../customViews/catalog';
import {
  CUSTOM_VIEW_SURFACES,
  DEFAULT_VIEW_ID,
  type CustomView,
  type CustomViewSurface,
  type CustomWidget,
  type LayoutItem,
  type Scalar,
  type ViewLayout,
  type WidgetRef,
  type WidgetSpec,
} from '../../../shared/types/customViews';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A stored view whose `layout_json` failed to parse. Mirrors
 * `main/src/orchestrator/customViews/types.ts`'s `CorruptCustomView` — declared
 * again here rather than imported so the renderer's module graph never reaches
 * into `main/`. The store surfaces these (it never silently drops them) so S5's
 * switcher can flag them; `ViewSurface` treats one as "no layout" and falls
 * back to Default.
 */
export interface CorruptViewEntry {
  id: string;
  surface: CustomViewSurface;
  name: string;
  revision: number;
  layout: null;
  corrupt: true;
  createdAt: string;
  updatedAt: string;
}

/** What `listViews` returns: a parsed view, or a flagged corrupt row. */
export type ViewEntry = CustomView | CorruptViewEntry;

/** True when the entry parsed and carries a usable layout. */
export function isUsableView(entry: ViewEntry): entry is CustomView {
  return (entry as CorruptViewEntry).corrupt !== true;
}

/**
 * The placeholder slot awaiting an assistant-built widget (§5.5). S6 fills it;
 * S4 declares it so the shape is pinned by the same contract that will use it.
 */
export interface AuthoringSlot {
  sessionId: string;
  instanceId: string;
  mode: 'create' | 'edit';
  widgetId: string | null;
}

/**
 * Customize mode's editable copy of one surface's layout (§5.5). `baseViewId`
 * / `baseRevision` are `null` when customizing started from Default — there is
 * no existing view to CAS-update, so `save({mode:'update'})` is not a valid
 * call against a `null` `baseViewId` (the UI routes that case to
 * `mode:'new'` instead; see `edit/SaveDiscardControls.tsx`).
 */
export interface CustomViewsDraft {
  surface: CustomViewSurface;
  layout: ViewLayout;
  baseViewId: string | null;
  baseRevision: number | null;
  dirty: boolean;
  /** The failed save's error code (`'concurrency'`, `'name_taken'`, ...), or `null`. Cleared on the next save attempt. */
  saveError: string | null;
}

/** `updateItemSettings`'s patch. `null` on `title`/`refreshSec` clears the override. */
export interface DraftItemPatch {
  settings?: Record<string, Scalar>;
  title?: string | null;
  refreshSec?: number | null;
}

type BySurface<T> = Record<CustomViewSurface, T>;

export interface CustomViewsState {
  viewsBySurface: BySurface<ViewEntry[]>;
  /** `'default'` until a surface loads and reports otherwise. */
  activeViewIdBySurface: BySurface<string>;
  widgets: CustomWidget[];
  loadedSurfaces: BySurface<boolean>;
  /** S5/S6 fill this; always `null` in S4. */
  authoring: AuthoringSlot | null;
  /** Customize mode's working copy for ONE surface at a time; `null` outside customize mode. */
  draft: CustomViewsDraft | null;

  /** Wire one surface. Returns an idempotent release; call it on unmount. */
  init: (surface: CustomViewSurface) => () => void;
  /** Optimistic switch + `setActiveView` mutation; reverts on failure. */
  setActive: (surface: CustomViewSurface, viewId: string) => Promise<void>;
  /** Re-read the custom-widget library. */
  refreshWidgets: () => Promise<void>;
  /** The spec a layout ref resolves to, or `null` (unknown id, or draft-only). */
  resolveWidgetSpec: (ref: WidgetRef) => WidgetSpec | null;

  /**
   * Enter customize mode for `surface`: seed `draft` from the active view's
   * layout, or — Default active, not loaded yet, or the active view is
   * corrupt — from the canonical catalog section order (fresh `instanceId`s,
   * empty settings). Replaces any existing draft (for this or another
   * surface); customize mode is single-surface by design.
   */
  enterCustomize: (surface: CustomViewSurface) => void;
  /** Reorder the draft's items. No-op without a draft or out-of-range indices. */
  moveItem: (from: number, to: number) => void;
  /** Flip one item's `hidden` flag in the draft. */
  toggleHidden: (instanceId: string) => void;
  /** Merge `patch` into one draft item — settings merge, `title`/`refreshSec` set-or-clear. */
  updateItemSettings: (instanceId: string, patch: DraftItemPatch) => void;
  /** Drop one item from the draft. */
  removeItem: (instanceId: string) => void;
  /** Insert a new layout item for `ref` at index `at`, settings seeded from its spec's declared defaults. */
  insertItem: (at: number, ref: WidgetRef) => void;
  /**
   * Persist the draft. `mode:'update'` CAS-updates `draft.baseViewId` (a
   * `null` `baseViewId` is a caller error — there is nothing to update);
   * `mode:'new'` creates a view named `name`. On success the views list is
   * refreshed, the view is activated when `setActive` is true, and the draft
   * is cleared. On failure the draft is KEPT with `saveError` set to the
   * server's error code — this call never rejects.
   */
  save: (input: { mode: 'update' | 'new'; name: string; setActive: boolean }) => Promise<void>;
  /** Drop the draft without saving (and any pending authoring draft widget it owns). */
  discard: () => void;
  /** Rename a SAVED view (outside the draft) by id — looks up its current revision itself. */
  renameView: (id: string, name: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Delete a SAVED view by id; clears the active pref when it pointed here (server-side). */
  deleteView: (id: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** True while `surface` has an open draft. */
  isCustomizing: (surface: CustomViewSurface) => boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bySurface<T>(value: () => T): BySurface<T> {
  const out = {} as BySurface<T>;
  for (const surface of CUSTOM_VIEW_SURFACES) out[surface] = value();
  return out;
}

/** A fresh uuid — `crypto.randomUUID()` directly would work too; wrapped so tests can spy on it. */
function newInstanceId(): string {
  return crypto.randomUUID();
}

/** `{ settingName: declaredDefault }` for every setting a spec declares — the seed for a freshly-inserted item. */
function defaultSettingsFor(spec: WidgetSpec | null): Record<string, Scalar> {
  if (spec === null || spec.settings === undefined) return {};
  return Object.fromEntries(spec.settings.map((field) => [field.name, field.default]));
}

/** An error's message, else its string form — the convention every other call site in this module follows. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useCustomViewsStore = create<CustomViewsState>((set, get) => {
  // Closure-private wiring state, one slot per surface — NOT part of the
  // observable state (nothing renders off it).
  const teardownBySurface = new Map<CustomViewSurface, () => void>();
  const refCountBySurface = new Map<CustomViewSurface, number>();
  const generationBySurface = new Map<CustomViewSurface, number>();

  /**
   * Build a release for one wiring generation. Idempotent; a release whose
   * generation was superseded (the subscription errored and re-armed) does
   * nothing rather than decrementing a wiring it never belonged to.
   */
  function makeRelease(surface: CustomViewSurface, issuedGeneration: number): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if ((generationBySurface.get(surface) ?? 0) !== issuedGeneration) return;
      const next = (refCountBySurface.get(surface) ?? 1) - 1;
      refCountBySurface.set(surface, Math.max(0, next));
      if (next > 0) return;
      teardownBySurface.get(surface)?.();
      teardownBySurface.delete(surface);
      refCountBySurface.set(surface, 0);
    };
  }

  /** Seed queries for one surface, committed only while the wiring is current. */
  async function seed(surface: CustomViewSurface, generation: number): Promise<void> {
    const isCurrent = (): boolean => (generationBySurface.get(surface) ?? 0) === generation;
    const [views, active, widgets] = await Promise.all([
      trpc.cyboflow.customViews.listViews.query({ surface }).catch((err: unknown) => {
        console.error('[customViewsStore] listViews failed:', err);
        return [] as ViewEntry[];
      }),
      trpc.cyboflow.customViews.getActiveView.query({ surface }).catch((err: unknown) => {
        console.error('[customViewsStore] getActiveView failed:', err);
        return { viewId: DEFAULT_VIEW_ID };
      }),
      trpc.cyboflow.customViews.listWidgets.query().catch((err: unknown) => {
        console.error('[customViewsStore] listWidgets failed:', err);
        return [] as CustomWidget[];
      }),
    ]);
    if (!isCurrent()) return;
    set((s) => ({
      viewsBySurface: { ...s.viewsBySurface, [surface]: views as ViewEntry[] },
      activeViewIdBySurface: { ...s.activeViewIdBySurface, [surface]: active.viewId },
      widgets,
      loadedSurfaces: { ...s.loadedSurfaces, [surface]: true },
    }));
  }

  /**
   * Re-read one surface's views + active id after a direct mutation (save /
   * rename / delete) — a lighter sibling of `seed` that never touches
   * `widgets` and is not gated by the init/subscription race's generation
   * counter, because it runs in response to a user action that already
   * happened, not a mount race.
   */
  async function refreshViewsAndActive(surface: CustomViewSurface): Promise<void> {
    const [views, active] = await Promise.all([
      trpc.cyboflow.customViews.listViews.query({ surface }).catch((err: unknown) => {
        console.error('[customViewsStore] listViews (refresh) failed:', err);
        return get().viewsBySurface[surface];
      }),
      trpc.cyboflow.customViews.getActiveView.query({ surface }).catch((err: unknown) => {
        console.error('[customViewsStore] getActiveView (refresh) failed:', err);
        return { viewId: get().activeViewIdBySurface[surface] };
      }),
    ]);
    set((s) => ({
      viewsBySurface: { ...s.viewsBySurface, [surface]: views as ViewEntry[] },
      activeViewIdBySurface: { ...s.activeViewIdBySurface, [surface]: active.viewId },
    }));
  }

  return {
    viewsBySurface: bySurface<ViewEntry[]>(() => []),
    activeViewIdBySurface: bySurface<string>(() => DEFAULT_VIEW_ID),
    widgets: [],
    loadedSurfaces: bySurface<boolean>(() => false),
    authoring: null,
    draft: null,

    init: (surface) => {
      // A second consumer of a live wiring just takes a reference.
      const liveTeardown = teardownBySurface.get(surface);
      if (liveTeardown !== undefined) {
        refCountBySurface.set(surface, (refCountBySurface.get(surface) ?? 0) + 1);
        return makeRelease(surface, generationBySurface.get(surface) ?? 0);
      }

      const generation = (generationBySurface.get(surface) ?? 0) + 1;
      generationBySurface.set(surface, generation);
      refCountBySurface.set(surface, 1);

      // SUBSCRIPTION FIRST, seeds second (the race policy). S4 drops every
      // event — S6 binds them to the authoring slot — but the channel has to
      // be open before the seeds or a draft landing mid-load is lost.
      let unsubscribe: (() => void) | null = null;
      try {
        const subscription = trpc.cyboflow.customViews.onWidgetDraft.subscribe(undefined, {
          onData: () => {
            // S6: bind to `authoring.sessionId`. Ignored until then.
          },
          onError: (err: unknown) => {
            console.error('[customViewsStore] onWidgetDraft subscription error:', err);
          },
        });
        unsubscribe = () => subscription.unsubscribe();
      } catch (err: unknown) {
        // No router (or a narrower test double): the read path still works,
        // it just will not learn about drafts.
        console.error('[customViewsStore] onWidgetDraft subscribe failed:', err);
      }

      teardownBySurface.set(surface, () => {
        unsubscribe?.();
      });

      void seed(surface, generation).catch((err: unknown) => {
        console.error('[customViewsStore] seed failed:', err);
      });

      return makeRelease(surface, generation);
    },

    setActive: async (surface, viewId) => {
      const previous = get().activeViewIdBySurface[surface];
      if (previous === viewId) return;
      set((s) => ({
        activeViewIdBySurface: { ...s.activeViewIdBySurface, [surface]: viewId },
      }));
      try {
        await trpc.cyboflow.customViews.setActiveView.mutate({ surface, viewId });
      } catch (err: unknown) {
        console.error('[customViewsStore] setActiveView failed:', err);
        // Revert — but only if nothing else moved the surface meanwhile.
        set((s) =>
          s.activeViewIdBySurface[surface] === viewId
            ? { activeViewIdBySurface: { ...s.activeViewIdBySurface, [surface]: previous } }
            : s,
        );
      }
    },

    refreshWidgets: async () => {
      try {
        const widgets = await trpc.cyboflow.customViews.listWidgets.query();
        set({ widgets });
      } catch (err: unknown) {
        console.error('[customViewsStore] listWidgets failed:', err);
      }
    },

    resolveWidgetSpec: (ref) => {
      if (ref.type === 'catalog') {
        return CATALOG_WIDGET_SPECS[ref.catalogId] ?? null;
      }
      // Published only. A draft renders solely in the authoring slot (§7.3),
      // which S6 resolves through `draftOf` rather than through this lookup.
      const widget = get().widgets.find((w) => w.id === ref.widgetId);
      return widget?.publishedSpec ?? null;
    },

    // -------------------------------------------------------------------
    // Customize mode (S5)
    // -------------------------------------------------------------------

    enterCustomize: (surface) => {
      const state = get();
      const activeId = state.activeViewIdBySurface[surface];
      const entry = state.viewsBySurface[surface].find((v) => v.id === activeId);
      const usable = activeId !== DEFAULT_VIEW_ID && entry !== undefined && isUsableView(entry) ? entry : null;

      let items: LayoutItem[];
      let baseViewId: string | null;
      let baseRevision: number | null;
      if (usable !== null) {
        // Deep-enough clone: the draft must never alias the saved view's
        // arrays/objects, or an in-place edit would mutate `viewsBySurface`
        // before a save ever happens.
        items = usable.layout.items.map((it) => ({ ...it, settings: { ...it.settings } }));
        baseViewId = usable.id;
        baseRevision = usable.revision;
      } else {
        items = sectionOrderFor(surface).map((catalogId) => ({
          instanceId: newInstanceId(),
          widget: { type: 'catalog', catalogId } as const,
          settings: {},
        }));
        baseViewId = null;
        baseRevision = null;
      }

      set({
        draft: {
          surface,
          layout: { version: 1, items },
          baseViewId,
          baseRevision,
          dirty: false,
          saveError: null,
        },
      });
    },

    moveItem: (from, to) => {
      set((s) => {
        if (s.draft === null) return s;
        const items = s.draft.layout.items;
        if (from < 0 || from >= items.length || to < 0 || to >= items.length || from === to) return s;
        const next = [...items];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        return { draft: { ...s.draft, layout: { ...s.draft.layout, items: next }, dirty: true } };
      });
    },

    toggleHidden: (instanceId) => {
      set((s) => {
        if (s.draft === null) return s;
        const items = s.draft.layout.items.map((it) =>
          it.instanceId === instanceId ? { ...it, hidden: it.hidden !== true } : it,
        );
        return { draft: { ...s.draft, layout: { ...s.draft.layout, items }, dirty: true } };
      });
    },

    updateItemSettings: (instanceId, patch) => {
      set((s) => {
        if (s.draft === null) return s;
        const items = s.draft.layout.items.map((it) => {
          if (it.instanceId !== instanceId) return it;
          const next: LayoutItem = { ...it };
          if (patch.settings !== undefined) next.settings = { ...next.settings, ...patch.settings };
          if ('title' in patch) {
            if (patch.title === null || patch.title === undefined || patch.title.length === 0) delete next.title;
            else next.title = patch.title;
          }
          if ('refreshSec' in patch) {
            if (patch.refreshSec === null || patch.refreshSec === undefined) delete next.refreshSec;
            else next.refreshSec = patch.refreshSec;
          }
          return next;
        });
        return { draft: { ...s.draft, layout: { ...s.draft.layout, items }, dirty: true } };
      });
    },

    removeItem: (instanceId) => {
      set((s) => {
        if (s.draft === null) return s;
        const items = s.draft.layout.items.filter((it) => it.instanceId !== instanceId);
        return { draft: { ...s.draft, layout: { ...s.draft.layout, items }, dirty: true } };
      });
    },

    insertItem: (at, ref) => {
      const spec = get().resolveWidgetSpec(ref);
      const newItem: LayoutItem = {
        instanceId: newInstanceId(),
        widget: ref,
        settings: defaultSettingsFor(spec),
      };
      set((s) => {
        if (s.draft === null) return s;
        const items = [...s.draft.layout.items];
        const index = Math.max(0, Math.min(at, items.length));
        items.splice(index, 0, newItem);
        return { draft: { ...s.draft, layout: { ...s.draft.layout, items }, dirty: true } };
      });
    },

    save: async ({ mode, name, setActive }) => {
      const draft = get().draft;
      if (draft === null) return;
      // Clear a stale error from a previous attempt before this one starts.
      set((s) => (s.draft === null ? s : { draft: { ...s.draft, saveError: null } }));
      try {
        let saved: CustomView;
        if (mode === 'update') {
          if (draft.baseViewId === null || draft.baseRevision === null) {
            throw new Error('no_base_view');
          }
          saved = await trpc.cyboflow.customViews.updateView.mutate({
            id: draft.baseViewId,
            expectedRevision: draft.baseRevision,
            name,
            layout: draft.layout,
          });
        } else {
          saved = await trpc.cyboflow.customViews.createView.mutate({
            surface: draft.surface,
            name,
            layout: draft.layout,
          });
        }
        await refreshViewsAndActive(draft.surface);
        if (setActive) {
          await get().setActive(draft.surface, saved.id);
        }
        set({ draft: null });
      } catch (err: unknown) {
        const message = errorMessage(err);
        console.error('[customViewsStore] save failed:', err);
        set((s) => (s.draft === null ? s : { draft: { ...s.draft, saveError: message } }));
      }
    },

    discard: () => {
      const authoring = get().authoring;
      // S6 territory in full (openAuthoring never runs in S5, so `authoring`
      // stays null here) — guarded now so a discard mid-authoring-session
      // never leaves an orphaned draft widget once S6 lands.
      if (authoring !== null && authoring.widgetId !== null) {
        void trpc.cyboflow.customViews.discardDraft
          .mutate({ id: authoring.widgetId, authoringSessionId: authoring.sessionId })
          .catch((err: unknown) => {
            console.error('[customViewsStore] discardDraft failed:', err);
          });
      }
      set({ draft: null, authoring: null });
    },

    renameView: async (id, name) => {
      const state = get();
      let target: { surface: CustomViewSurface; revision: number } | null = null;
      for (const surface of CUSTOM_VIEW_SURFACES) {
        const entry = state.viewsBySurface[surface].find((v) => v.id === id);
        if (entry !== undefined && isUsableView(entry)) {
          target = { surface, revision: entry.revision };
          break;
        }
      }
      if (target === null) {
        return { ok: false, error: 'not_found' };
      }
      try {
        await trpc.cyboflow.customViews.updateView.mutate({
          id,
          expectedRevision: target.revision,
          name,
        });
        await refreshViewsAndActive(target.surface);
        return { ok: true };
      } catch (err: unknown) {
        console.error('[customViewsStore] renameView failed:', err);
        return { ok: false, error: errorMessage(err) };
      }
    },

    deleteView: async (id) => {
      const state = get();
      let surface: CustomViewSurface | null = null;
      for (const s of CUSTOM_VIEW_SURFACES) {
        if (state.viewsBySurface[s].some((v) => v.id === id)) {
          surface = s;
          break;
        }
      }
      try {
        await trpc.cyboflow.customViews.deleteView.mutate({ id });
        if (surface !== null) await refreshViewsAndActive(surface);
        return { ok: true };
      } catch (err: unknown) {
        console.error('[customViewsStore] deleteView failed:', err);
        return { ok: false, error: errorMessage(err) };
      }
    },

    isCustomizing: (surface) => {
      const draft = get().draft;
      return draft !== null && draft.surface === surface;
    },
  };
});

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/** The active view for `surface` — `null` for Default, an unknown id, or a corrupt row. */
export function useActiveView(surface: CustomViewSurface): CustomView | null {
  return useCustomViewsStore((s) => {
    const activeId = s.activeViewIdBySurface[surface];
    if (activeId === DEFAULT_VIEW_ID) return null;
    const entry = s.viewsBySurface[surface].find((v) => v.id === activeId);
    if (entry === undefined || !isUsableView(entry)) return null;
    return entry;
  });
}

/** Whether `surface`'s seed queries have committed at least once. */
export function useSurfaceLoaded(surface: CustomViewSurface): boolean {
  return useCustomViewsStore((s) => s.loadedSurfaces[surface]);
}

/** Reactive `isCustomizing` (§5.5) — true while `surface` has an open draft. */
export function useIsCustomizing(surface: CustomViewSurface): boolean {
  return useCustomViewsStore((s) => s.draft !== null && s.draft.surface === surface);
}

/** The open draft for `surface`, or `null` outside customize mode. */
export function useDraft(surface: CustomViewSurface): CustomViewsDraft | null {
  return useCustomViewsStore((s) => (s.draft !== null && s.draft.surface === surface ? s.draft : null));
}
