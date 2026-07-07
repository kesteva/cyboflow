/**
 * variantsStore — per-workflow list of {@link WorkflowVariantRow}s (migration
 * 048 / workflow A/B testing), backing the VariantSelector picker and the
 * Workflows-editor variant management section.
 *
 * Keyed by `workflowId` (variants are workflow-scoped, unlike the cross-project
 * workflowsStore gallery), with a simple fetch-once-then-invalidate-on-mutate
 * contract: `fetch` is a no-op re-entrancy guard (skips while already loading
 * for that workflow); every variants.create/update/setStatus/delete call site
 * MUST call `invalidate(workflowId)` afterwards so the list stays live (no
 * separate subscription — variant edits are always user-initiated from the same
 * client, unlike run status which needs a push channel).
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import type { inferRouterOutputs } from '@trpc/server';
import { trpc } from '../trpc/client';
import type { AppRouter } from '../../../shared/types/trpc';

type RouterOutputs = inferRouterOutputs<AppRouter>;

/** AppRouter-inferred variant row — never a local mirror (CLAUDE.md IPC rule). */
export type WorkflowVariantRow = RouterOutputs['cyboflow']['variants']['list'][number];

export interface VariantsState {
  /** Variant rows keyed by workflowId. Absent key = never fetched. */
  byWorkflowId: Record<string, WorkflowVariantRow[]>;
  /** True once `fetch` has resolved at least once for a workflowId. */
  loadedWorkflowIds: Record<string, boolean>;
  /** True while a fetch is in flight for a workflowId (re-entrancy guard). */
  loading: Record<string, boolean>;
  /** Last fetch failure's message per workflowId; null when clean. */
  error: Record<string, string | null>;

  /** Fetch (or re-fetch) a workflow's variant list. No-op while already loading. */
  fetch: (workflowId: string) => Promise<void>;
  /** Alias for `fetch` — call after any variants.* mutation to keep the list live. */
  invalidate: (workflowId: string) => Promise<void>;
}

export const useVariantsStore = create<VariantsState>((set, get) => ({
  byWorkflowId: {},
  loadedWorkflowIds: {},
  loading: {},
  error: {},

  fetch: async (workflowId: string) => {
    if (get().loading[workflowId]) return;
    set((s) => ({
      loading: { ...s.loading, [workflowId]: true },
      error: { ...s.error, [workflowId]: null },
    }));
    try {
      const rows = await trpc.cyboflow.variants.list.query({ workflowId });
      set((s) => ({
        byWorkflowId: { ...s.byWorkflowId, [workflowId]: rows },
        loadedWorkflowIds: { ...s.loadedWorkflowIds, [workflowId]: true },
        loading: { ...s.loading, [workflowId]: false },
      }));
    } catch (err: unknown) {
      set((s) => ({
        loading: { ...s.loading, [workflowId]: false },
        error: {
          ...s.error,
          [workflowId]: err instanceof Error ? err.message : 'Failed to load variants',
        },
      }));
    }
  },

  invalidate: async (workflowId: string) => {
    // Bypass the loading re-entrancy guard directly (an invalidate right after a
    // mutation should never be skipped just because the seed fetch is settling).
    set((s) => ({ error: { ...s.error, [workflowId]: null } }));
    try {
      const rows = await trpc.cyboflow.variants.list.query({ workflowId });
      set((s) => ({
        byWorkflowId: { ...s.byWorkflowId, [workflowId]: rows },
        loadedWorkflowIds: { ...s.loadedWorkflowIds, [workflowId]: true },
      }));
    } catch (err: unknown) {
      set((s) => ({
        error: {
          ...s.error,
          [workflowId]: err instanceof Error ? err.message : 'Failed to load variants',
        },
      }));
    }
  },
}));

/**
 * Hook: a workflow's variant list, fetched on mount / whenever `workflowId`
 * changes. Pass `null` to skip fetching (e.g. create-mode editor with no
 * workflow row yet) — returns an empty, not-loaded result.
 */
export function useWorkflowVariants(workflowId: string | null): {
  variants: WorkflowVariantRow[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
} {
  const fetchFn = useVariantsStore((s) => s.fetch);
  const variants = useVariantsStore((s) => (workflowId ? s.byWorkflowId[workflowId] : undefined)) ?? [];
  const loaded = useVariantsStore((s) => (workflowId ? s.loadedWorkflowIds[workflowId] : false)) ?? false;
  const loading = useVariantsStore((s) => (workflowId ? s.loading[workflowId] : false)) ?? false;
  const error = useVariantsStore((s) => (workflowId ? s.error[workflowId] : null)) ?? null;

  useEffect(() => {
    if (workflowId) void fetchFn(workflowId);
  }, [workflowId, fetchFn]);

  return { variants, loaded, loading, error };
}
