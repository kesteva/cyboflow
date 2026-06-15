/**
 * dynamicWorkflowStore — Zustand slice mirroring the main process's tracked
 * Claude Code "dynamic workflows" (the in-session Workflow tool / `ultracode`).
 *
 * Cyboflow never launches these — the main process passively DETECTS that a
 * session's agent launched one and streams full state snapshots (see
 * shared/types/dynamicWorkflows.ts for the contract and on-disk sources). This
 * store is the renderer-side mirror:
 *
 *   - `trpc.cyboflow.dynamicWorkflows.list({})`        → seed (all sessions)
 *   - `trpc.cyboflow.dynamicWorkflows.onChanged`       → per-change snapshots
 *
 * Every event carries the FULL {@link DynamicWorkflowRunState} — receivers
 * REPLACE the keyed entry, never merge (the tracker owns reconciliation).
 *
 * ## init() lifecycle (mirrors activeRunsStore)
 * `init()` is idempotent (guard flag) and safe to call from every consumer
 * mount — QuickSessionCanvas and the landing home both call it. The
 * subscription is a shared singleton, so consumers do NOT tear it down on
 * unmount (same treatment landingStore gives `useActiveRunsStore.init()`);
 * the returned unsubscribe exists for tests and app-level teardown.
 *
 * All failures are caught and `console.warn`-ed (never thrown), mirroring
 * activeRunsStore.
 */
import { create } from 'zustand';
import { useMemo } from 'react';
import { trpc } from '../trpc/client';
import type { DynamicWorkflowRunState } from '../../../shared/types/dynamicWorkflows';

// ---------------------------------------------------------------------------
// Pure selector helpers — exported for unit testing.
// ---------------------------------------------------------------------------

/**
 * Dynamic workflows belonging to one session, most recent first
 * (`startedAt` desc — a session can launch several over its lifetime).
 */
export function selectForSession(
  byWfRunId: Record<string, DynamicWorkflowRunState>,
  sessionId: string,
): DynamicWorkflowRunState[] {
  return Object.values(byWfRunId)
    .filter((state) => state.sessionId === sessionId)
    .sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    );
}

/** Currently-running dynamic workflows across ALL sessions (landing home). */
export function selectActive(
  byWfRunId: Record<string, DynamicWorkflowRunState>,
): DynamicWorkflowRunState[] {
  return Object.values(byWfRunId).filter((state) => state.status === 'running');
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface DynamicWorkflowsState {
  /** Tracked dynamic workflows keyed by the CLI's `wf_*` run id. */
  byWfRunId: Record<string, DynamicWorkflowRunState>;

  /**
   * Seed from `dynamicWorkflows.list({})` and subscribe to `onChanged`
   * snapshots. Idempotent — safe to call on every consumer mount.
   * Returns an unsubscribe function (shared singleton; see module doc).
   */
  init: () => (() => void);
}

export const useDynamicWorkflowStore = create<DynamicWorkflowsState>((set) => {
  let initialized = false;
  let cachedUnsubscribe: (() => void) | null = null;

  /** REPLACE the keyed entry with a full snapshot (contract: never merge). */
  const applySnapshot = (state: DynamicWorkflowRunState): void => {
    set((s) => ({
      byWfRunId: { ...s.byWfRunId, [state.wfRunId]: state },
    }));
  };

  /** Drop a dismissed entry (onRemoved). No-op when the key is already gone. */
  const dropEntry = (wfRunId: string): void => {
    set((s) => {
      if (!(wfRunId in s.byWfRunId)) return s;
      const next = { ...s.byWfRunId };
      delete next[wfRunId];
      return { byWfRunId: next };
    });
  };

  return {
    byWfRunId: {},

    init: () => {
      if (initialized) return cachedUnsubscribe!;
      initialized = true;

      // Seed with the full cross-session list. Events that race the seed are
      // safe: both paths write full snapshots, so last-write-wins is correct.
      void trpc.cyboflow.dynamicWorkflows.list
        .query({})
        .then((states) => {
          for (const state of states) applySnapshot(state);
        })
        .catch((err: unknown) => {
          console.warn('[dynamicWorkflowStore] initial list failed:', err);
        });

      // Payload type is inferred from AppRouter (repo rule — never a local
      // mirror or `unknown` + shape guard): event is DynamicWorkflowChangedEvent.
      const changedSub = trpc.cyboflow.dynamicWorkflows.onChanged.subscribe(undefined, {
        onData: (event) => {
          applySnapshot(event.state);
        },
        onError: (err: unknown) =>
          console.warn('[dynamicWorkflowStore] onChanged error:', err),
      });

      // Removals (dismiss CTA / superseded by continued PTY interaction): drop
      // the keyed entry. Payload inferred from AppRouter (DynamicWorkflowRemovedEvent).
      const removedSub = trpc.cyboflow.dynamicWorkflows.onRemoved.subscribe(undefined, {
        onData: (event) => {
          dropEntry(event.wfRunId);
        },
        onError: (err: unknown) =>
          console.warn('[dynamicWorkflowStore] onRemoved error:', err),
      });

      const unsubscribe = () => {
        changedSub.unsubscribe();
        removedSub.unsubscribe();
        initialized = false;
        cachedUnsubscribe = null;
      };
      cachedUnsubscribe = unsubscribe;
      return unsubscribe;
    },
  };
});

// ---------------------------------------------------------------------------
// Selector hooks
// ---------------------------------------------------------------------------

/**
 * Dynamic workflows for one session, most recent first. Memoized on the stable
 * `byWfRunId` slice so it does not return a fresh array reference every render.
 */
export function useDynamicWorkflowsForSession(sessionId: string): DynamicWorkflowRunState[] {
  const byWfRunId = useDynamicWorkflowStore((s) => s.byWfRunId);
  return useMemo(() => selectForSession(byWfRunId, sessionId), [byWfRunId, sessionId]);
}

/**
 * Running dynamic workflows across every session — the landing home's
 * active-agents feed. Memoized on the stable `byWfRunId` slice.
 */
export function useActiveDynamicWorkflows(): DynamicWorkflowRunState[] {
  const byWfRunId = useDynamicWorkflowStore((s) => s.byWfRunId);
  return useMemo(() => selectActive(byWfRunId), [byWfRunId]);
}
