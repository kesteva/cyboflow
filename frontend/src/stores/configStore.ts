import { create } from 'zustand';
import { API } from '../utils/api';
import type { AppConfig, UpdateAppConfigRequest } from '../types/config';
import type {
  RunTypeDefaults,
  RunTypeDefaultsOp,
} from '../../../shared/types/sessionDefaults';

/**
 * The outcome of one `applyRunTypeDefault` write. Discriminated on purpose: the
 * caller MUST be able to tell "the write landed and the key previously held
 * nothing" (`{ ok: true, previous: null }`) from "the write never landed"
 * (`{ ok: false }`). Collapsing both onto `undefined` is what let a failed write
 * report success and hand its Undo a `{ kind: 'replace', value: null }` — a key
 * DELETION of a default the failed write never overwrote.
 *
 * Declared here rather than in `shared/types/sessionDefaults.ts` because it is a
 * renderer-store contract, not part of the IPC payload shape.
 */
export type ApplyRunTypeDefaultResult =
  | { ok: true; previous: RunTypeDefaults | null }
  | { ok: false; error: string };

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
  updateConfig: (updates: Partial<UpdateAppConfigRequest>) => Promise<boolean>;
  applyRunTypeDefault: (
    key: string,
    op: RunTypeDefaultsOp,
  ) => Promise<ApplyRunTypeDefaultResult>;
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
        set({
          error: (response.success ? undefined : response.error) || 'Failed to fetch config',
          isLoading: false,
        });
      }
    } catch (error) {
      set({ error: 'Failed to fetch config', isLoading: false });
    }
  },

  updateConfig: async (updates: Partial<UpdateAppConfigRequest>) => {
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

  applyRunTypeDefault: async (
    key: string,
    op: RunTypeDefaultsOp,
  ): Promise<ApplyRunTypeDefaultResult> => {
    try {
      const response = await API.config.applyRunTypeDefault(key, op);
      if (response.success) {
        await get().fetchConfig();
        // The IPC reports "no prior entry" as `undefined`; normalize to `null`
        // so the success shape has exactly one absent-value spelling.
        return { ok: true, previous: response.data?.previous ?? null };
      }
      const error = response.error || 'Failed to apply run type default';
      set({ error });
      return { ok: false, error };
    } catch {
      const message = 'Failed to apply run type default';
      set({ error: message });
      return { ok: false, error: message };
    }
  },
}));
