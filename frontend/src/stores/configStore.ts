import { create } from 'zustand';
import { API } from '../utils/api';
import type { AppConfig } from '../types/config';

interface ConfigStore {
  config: AppConfig | null;
  isLoading: boolean;
  error: string | null;
  fetchConfig: () => Promise<void>;
  /**
   * Persist + refetch. Returns `true` on success, `false` on failure — the
   * store still swallows the error into `error` state (existing callers rely
   * on that non-throwing contract), but callers that need a definitive
   * success/fail signal for retry UX (e.g. the onboarding Telemetry step) can
   * check the return value instead of racing the shared `error` field.
   */
  updateConfig: (updates: Partial<AppConfig>) => Promise<boolean>;
}

export const useConfigStore = create<ConfigStore>((set, get) => ({
  config: null,
  isLoading: false,
  error: null,

  fetchConfig: async () => {
    set({ isLoading: true, error: null });
    try {
      const response = await API.config.get();
      if (response.success && response.data) {
        set({ config: response.data, isLoading: false });
      } else {
        set({ error: response.error || 'Failed to fetch config', isLoading: false });
      }
    } catch (error) {
      set({ error: 'Failed to fetch config', isLoading: false });
    }
  },

  updateConfig: async (updates: Partial<AppConfig>) => {
    try {
      const response = await API.config.update(updates);
      if (response.success) {
        // Refetch to ensure we have the latest config
        await get().fetchConfig();
        return true;
      }
      set({ error: response.error || 'Failed to update config' });
      return false;
    } catch (error) {
      set({ error: 'Failed to update config' });
      return false;
    }
  },
}));