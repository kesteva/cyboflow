import { useEffect } from 'react';
import { create } from 'zustand';
import type { CodexModelCatalog, CodexModelOption } from '../../../shared/types/agentModels';
import { API } from '../utils/api';

interface CodexModelCatalogState {
  catalog: CodexModelCatalog | null;
  loading: boolean;
  error: string | null;
  load(): Promise<void>;
}

const useStore = create<CodexModelCatalogState>((set) => ({
  catalog: null,
  loading: false,
  error: null,
  async load() {
    set({ loading: true, error: null });
    try {
      const response = await API.models.getCodexCatalog();
      if (!response.success || !response.data) {
        throw new Error(response.error ?? 'Codex model discovery failed');
      }
      set({ catalog: response.data, loading: false });
    } catch (error) {
      started = false;
      set({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
}));

let started = false;
function ensureStarted(enabled: boolean): void {
  if (!enabled || started) return;
  started = true;
  void useStore.getState().load();
}

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
  const state = useStore();
  useEffect(() => ensureStarted(enabled), [enabled]);
  return {
    options: [autoOption(state.catalog), ...(state.catalog?.models ?? [])],
    defaultModel: state.catalog?.defaultModel ?? null,
    loading: state.loading,
    error: state.error,
  };
}

export const codexModelCatalogStoreForTests = useStore;

export function resetCodexModelCatalogStoreForTests(): void {
  started = false;
  useStore.setState({ catalog: null, loading: false, error: null });
}
