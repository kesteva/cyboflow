import type { CodexModelCatalog, CodexModelOption } from '../../../shared/types/agentModels';
import {
  PROVIDER_MODEL_CATALOG_SLICES,
  useProviderModelCatalog,
} from './providerModelCatalogStore';

/**
 * The CODEX view of the provider-keyed catalog store
 * ({@link providerModelCatalogStore}). Everything provider-agnostic — the fetch,
 * the one-shot latch, the error handling — lives there; what stays here is the
 * one genuinely Codex-specific thing: the synthesized `'auto'` row.
 *
 * `'auto'` is a CONFIG value, not a model the runtime advertises. Selecting it
 * means "send no model and let the Codex runtime pick", so it can never come
 * back from `model/list` and has to be prepended locally — its description
 * names the runtime default when discovery found one.
 */

function autoOption(catalog: CodexModelCatalog | null): CodexModelOption {
  const runtimeDefault = catalog?.models.find((model) => model.id === catalog.defaultModel);
  return {
    id: 'auto',
    label: 'Auto/default',
    description: runtimeDefault
      ? `Use the Codex runtime default (${runtimeDefault.label})`
      : 'Use the Codex runtime default',
    isDefault: false,
  };
}

export interface CodexModelCatalogHook {
  options: CodexModelOption[];
  defaultModel: string | null;
  loading: boolean;
  error: string | null;
}

export function useCodexModelCatalog(enabled = true): CodexModelCatalogHook {
  const { catalog, loading, error } = useProviderModelCatalog('codex', enabled);
  return {
    options: [autoOption(catalog), ...(catalog?.models ?? [])],
    defaultModel: catalog?.defaultModel ?? null,
    loading,
    error,
  };
}

/**
 * Re-run Codex discovery after a failure, for a surface that offers an explicit
 * Retry (the onboarding Model step's unreachable-catalog well).
 *
 * A failed `load()` already releases the one-shot latch, so a LATER MOUNT
 * retries on its own — but the mount that failed is still standing, and its
 * `ensureStarted` has already run for this mount. Clearing the slice first is
 * what makes the retry visible: it drops the stale `error` and re-arms the
 * latch, so `ensureStarted(true)` starts a fresh fetch and the picker returns to
 * its loading state instead of sitting on the old failure.
 */
export function retryCodexModelCatalog(): void {
  PROVIDER_MODEL_CATALOG_SLICES.codex.reset();
  PROVIDER_MODEL_CATALOG_SLICES.codex.ensureStarted(true);
}

export const codexModelCatalogStoreForTests = PROVIDER_MODEL_CATALOG_SLICES.codex.store;

export function resetCodexModelCatalogStoreForTests(): void {
  PROVIDER_MODEL_CATALOG_SLICES.codex.reset();
}
