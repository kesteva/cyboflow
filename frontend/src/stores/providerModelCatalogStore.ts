import { useEffect } from 'react';
import { create } from 'zustand';
import type { StoreApi, UseBoundStore } from 'zustand';
import { AGENT_PROVIDERS, type AgentProvider } from '../../../shared/types/agentRuntime';
import type { ProviderModelCatalogs } from '../../../shared/types/agentModels';
import { API } from '../utils/api';

/**
 * Lazy, provider-keyed store for the DISCOVERED model catalogs — the models a
 * provider's own runtime advertises for the signed-in account (Codex's
 * `model/list`, Claude's `supportedModels()`), as opposed to the four PINNED
 * Claude aliases the picker always shows.
 *
 * Each provider gets its own slice, fetched ONCE on the first enabled mount and
 * shared across every picker: multiple mounts and a renderer reload must not
 * re-probe (discovery spawns a short-lived app-server on the Codex side). A
 * failed fetch releases the latch so a later mount retries, and leaves the slice
 * empty — every picker is written to stay usable with no catalog.
 *
 * The slices live in {@link PROVIDER_MODEL_CATALOG_SLICES}, an exhaustive
 * `Record<AgentProvider, …>`: a provider added to the union gets a working
 * catalog store from one entry, instead of a third hand-written module that
 * every picker then has to be taught to call. Each slice is built at a CONCRETE
 * provider, so `catalog` keeps that provider's own catalog type — the two shapes
 * genuinely differ (see ProviderModelCatalogs) and are not flattened.
 */

export interface ProviderCatalogState<P extends AgentProvider> {
  catalog: ProviderModelCatalogs[P] | null;
  loading: boolean;
  error: string | null;
  load(): Promise<void>;
}

interface ProviderCatalogSlice<P extends AgentProvider> {
  /** The zustand hook/store — also the test seam for reading state directly. */
  readonly store: UseBoundStore<StoreApi<ProviderCatalogState<P>>>;
  /** Kick the one-shot fetch if it has not started (and `enabled`). */
  readonly ensureStarted: (enabled: boolean) => void;
  /** Test-only: clear the slice AND release the one-shot latch. */
  readonly reset: () => void;
}

function createCatalogSlice<P extends AgentProvider>(provider: P): ProviderCatalogSlice<P> {
  let started = false;
  const store = create<ProviderCatalogState<P>>((set) => ({
    catalog: null,
    loading: false,
    error: null,
    async load() {
      set({ loading: true, error: null });
      try {
        const response = await API.models.getCatalog(provider);
        if (!response.success || !response.data) {
          throw new Error(response.error ?? `${provider} model discovery failed`);
        }
        set({ catalog: response.data, loading: false });
      } catch (error) {
        started = false; // allow a retry on a later mount
        set({
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  }));

  return {
    store,
    ensureStarted(enabled) {
      if (!enabled || started) return;
      started = true;
      void store.getState().load();
    },
    reset() {
      started = false;
      store.setState({ catalog: null, loading: false, error: null });
    },
  };
}

export const PROVIDER_MODEL_CATALOG_SLICES: {
  [P in AgentProvider]: ProviderCatalogSlice<P>;
} = {
  claude: createCatalogSlice('claude'),
  codex: createCatalogSlice('codex'),
  // Generic by construction — the slice needs no per-provider code, so OMP gets a
  // working store the moment its `models:get-catalog` fetcher returns real rows
  // (Phase 1, §5.1). `ensureStarted(enabled)` means nothing is fetched until a
  // picker actually shows OMP, which none does while the provider is off.
  omp: createCatalogSlice('omp'),
  // Generic by construction, same as OMP's row: the slice needs no per-
  // provider code, so Pi gets a working store the moment its
  // `models:get-catalog` fetcher returns real rows. Nothing is fetched until
  // a picker actually shows Pi.
  pi: createCatalogSlice('pi'),
};

export interface ProviderModelCatalogHook<P extends AgentProvider> {
  catalog: ProviderModelCatalogs[P] | null;
  loading: boolean;
  error: string | null;
}

/**
 * Subscribe to `provider`'s discovered catalog. Pass `enabled` (true only for a
 * picker actually showing that provider) — the one-shot fetch starts on the
 * first enabled mount. Returns a null catalog until it resolves, or permanently
 * if discovery fails.
 */
export function useProviderModelCatalog<P extends AgentProvider>(
  provider: P,
  enabled = true,
): ProviderModelCatalogHook<P> {
  const slice = PROVIDER_MODEL_CATALOG_SLICES[provider];
  const catalog = slice.store((state) => state.catalog);
  const loading = slice.store((state) => state.loading);
  const error = slice.store((state) => state.error);

  useEffect(() => {
    slice.ensureStarted(enabled);
  }, [slice, enabled]);

  return { catalog, loading, error };
}

/** Test-only: clear every provider slice and release its one-shot latch. */
export function resetProviderModelCatalogsForTests(): void {
  for (const provider of AGENT_PROVIDERS) {
    PROVIDER_MODEL_CATALOG_SLICES[provider].reset();
  }
}
