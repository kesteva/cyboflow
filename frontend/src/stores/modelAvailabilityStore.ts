import { useEffect } from 'react';
import { create } from 'zustand';
import { API } from '../utils/api';
import {
  isAliasUsable as isAliasUsablePure,
  guardedModelByAlias,
  type ModelAvailabilityMap,
} from '../../../shared/types/modelAvailability';

/**
 * modelAvailabilityStore — the renderer mirror of the backend
 * ModelAvailabilityService. Holds the guarded-model (Fable 5) availability
 * snapshot so every model picker can grey out a model that's been pulled from
 * release. Seeded empty (all models usable — the optimistic default) until the
 * first snapshot arrives; updated live via the `model-availability-changed` push.
 */
interface ModelAvailabilityState {
  availability: ModelAvailabilityMap;
  setAvailability: (map: ModelAvailabilityMap) => void;
}

const useStore = create<ModelAvailabilityState>((set) => ({
  availability: {},
  setAvailability: (map) => set({ availability: map }),
}));

/** Reason string for a greyed-out guarded alias, or null when it's usable. */
function reasonForAlias(alias: string | null | undefined, map: ModelAvailabilityMap): string | null {
  const guarded = guardedModelByAlias(alias);
  if (!guarded) return null;
  const entry = map[guarded.concreteId];
  return entry && entry.status === 'unavailable' ? (entry.reason ?? 'Currently unavailable') : null;
}

// App-lifetime init runs exactly once, on the first picker mount — fetch the
// snapshot and subscribe to live flips. The subscription is intentionally never
// torn down (it's a global that outlives any single picker); the window teardown
// removes the underlying IPC listener.
let started = false;
function ensureStarted(): void {
  if (started) return;
  started = true;
  try {
    const { setAvailability } = useStore.getState();
    API.models
      .getAvailability()
      .then((res) => {
        if (res.success && res.data) setAvailability(res.data);
      })
      .catch(() => {
        /* optimistic: leave empty (all usable) */
      });
    API.models.onAvailabilityChanged((map) => setAvailability(map));
  } catch {
    /* availability IPC unavailable (preload skew) — stay optimistic (all usable) */
  }
}

export interface ModelAvailabilityHook {
  /** True unless the alias is a guarded model currently marked unavailable. */
  isAliasUsable: (alias: string | null | undefined) => boolean;
  /** Human reason when a guarded alias is unavailable, else null (for tooltips). */
  unavailableReason: (alias: string | null | undefined) => string | null;
}

/**
 * Subscribe a component to guarded-model availability. Lazily boots the store on
 * first use (fetch + live subscribe) and re-renders on every status flip. The
 * returned helpers are bound to the current snapshot.
 */
export function useModelAvailability(): ModelAvailabilityHook {
  const availability = useStore((s) => s.availability);
  useEffect(ensureStarted, []);
  return {
    isAliasUsable: (alias) => isAliasUsablePure(alias, availability),
    unavailableReason: (alias) => reasonForAlias(alias, availability),
  };
}
