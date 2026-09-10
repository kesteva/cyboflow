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
 */
import { create } from 'zustand';
import { trpc } from '../trpc/client';
import { CATALOG_WIDGET_SPECS } from '../../../shared/customViews/catalogSpecs';
import {
  CUSTOM_VIEW_SURFACES,
  DEFAULT_VIEW_ID,
  type CustomView,
  type CustomViewSurface,
  type CustomWidget,
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

type BySurface<T> = Record<CustomViewSurface, T>;

export interface CustomViewsState {
  viewsBySurface: BySurface<ViewEntry[]>;
  /** `'default'` until a surface loads and reports otherwise. */
  activeViewIdBySurface: BySurface<string>;
  widgets: CustomWidget[];
  loadedSurfaces: BySurface<boolean>;
  /** S5/S6 fill this; always `null` in S4. */
  authoring: AuthoringSlot | null;

  /** Wire one surface. Returns an idempotent release; call it on unmount. */
  init: (surface: CustomViewSurface) => () => void;
  /** Optimistic switch + `setActiveView` mutation; reverts on failure. */
  setActive: (surface: CustomViewSurface, viewId: string) => Promise<void>;
  /** Re-read the custom-widget library. */
  refreshWidgets: () => Promise<void>;
  /** The spec a layout ref resolves to, or `null` (unknown id, or draft-only). */
  resolveWidgetSpec: (ref: WidgetRef) => WidgetSpec | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bySurface<T>(value: () => T): BySurface<T> {
  const out = {} as BySurface<T>;
  for (const surface of CUSTOM_VIEW_SURFACES) out[surface] = value();
  return out;
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

  return {
    viewsBySurface: bySurface<ViewEntry[]>(() => []),
    activeViewIdBySurface: bySurface<string>(() => DEFAULT_VIEW_ID),
    widgets: [],
    loadedSurfaces: bySurface<boolean>(() => false),
    authoring: null,

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
