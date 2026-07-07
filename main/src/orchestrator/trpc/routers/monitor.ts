/**
 * cyboflow.monitor sub-router — the typed tRPC contract for the run's ON-DEMAND
 * monitor (the monitor-unify refactor; supersedes the old `cyboflow.supervisorChat`
 * sub-router). The monitor conversation renders in the run's EXISTING unified Chat
 * pane (`runs.listUnifiedMessages` over `raw_events`) — there is NO separate
 * transcript store and NO per-run transcript subscription. This router is thin:
 *   - isActive    : query    → whether the run has an active monitor session.
 *   - send        : mutation → relay a user chat turn to the run's monitor.
 *   - stepResults : query    → the deterministic per-step results timeline.
 *
 * `send` delegates the inject→answer→inject orchestration to the monitor session's
 * `converse` (it injects the human turn + the monitor's reply into the run's
 * unified stream, which the renderer picks up via the streamEvents-driven refetch —
 * so the router never touches `raw_events` directly). A run with no active monitor
 * (the default review-queue mode, a terminal run) resolves fail-soft
 * (`{ delivered: false }` / `{ active: false }` / `[]`).
 *
 * LAZY REHYDRATION (monitor lazy-rehydration): after an app restart the
 * MonitorRegistry is empty, so a registry MISS here does not necessarily mean the
 * run has no monitor — its session object simply did not survive the restart (the
 * monitor itself is stateless per call; nothing else needs restoring). The
 * composition root wires a `MonitorRehydrator` via `setMonitorRehydrator`; on a
 * registry miss `isActive`/`send` consult it and, when it revives a session
 * (registering it as a side effect), proceed as if the registry had hit. Unset /
 * null rehydrator or a rehydrator that returns null (refused — see
 * monitorRehydration.ts) preserves the exact legacy miss behavior. A throwing
 * rehydrator is fail-soft: logged and treated as a miss, never surfaced to the
 * caller.
 *
 * Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3',
 * or main/src/services/*.
 */
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { MonitorRegistry, type MonitorSession } from '../../programmatic/monitor';
import { StepResultStore, type StepResultRow } from '../../stepResultStore';

// ---------------------------------------------------------------------------
// Lazy-rehydration seam
// ---------------------------------------------------------------------------

/**
 * Structural view of the lazy monitor rehydrator (implemented in
 * monitorRehydration.ts, wired at boot by the composition root). Consulted ONLY
 * on a MonitorRegistry miss; `rehydrate` registers the revived session itself
 * (mirrors the registry's own register-on-create contract), so callers here just
 * re-read the registry (or use the returned session directly).
 */
export interface MonitorRehydrator {
  rehydrate(runId: string): MonitorSession | null;
}

let monitorRehydrator: MonitorRehydrator | null = null;

/**
 * Wire the lazy monitor rehydrator at boot (composition root). Idempotent — may
 * be called again to replace it; tests install a fake per case and clear it via
 * {@link _resetMonitorRehydratorForTesting}.
 */
export function setMonitorRehydrator(rehydrator: MonitorRehydrator | null): void {
  monitorRehydrator = rehydrator;
}

/** Test-only: clear the wired rehydrator so a case starts from the unset (legacy) state. */
export function _resetMonitorRehydratorForTesting(): void {
  monitorRehydrator = null;
}

/**
 * Look up a run's monitor session, falling back to the lazy rehydrator on a
 * registry miss. Fail-soft: a throwing rehydrator is logged and treated as a
 * miss (`undefined`) rather than escaping to the caller.
 */
function lookupOrRehydrate(runId: string): MonitorSession | undefined {
  const existing = MonitorRegistry.getInstance().get(runId);
  if (existing) return existing;
  if (!monitorRehydrator) return undefined;
  try {
    return monitorRehydrator.rehydrate(runId) ?? undefined;
  } catch (err) {
    console.warn(
      `[monitor.lookupOrRehydrate] rehydrator threw for run ${runId}; treating as miss:`,
      err instanceof Error ? err.message : String(err),
    );
    return undefined;
  }
}

export const monitorRouter = router({
  /**
   * Whether a monitor session is active for a run — drives whether the renderer
   * enables the Chat composer for the run (only programmatic runs with the SDK
   * monitor have one). Registry lookup, falling back to lazy rehydration on a miss
   * (see `lookupOrRehydrate`).
   */
  isActive: protectedProcedure
    .input(z.object({ runId: z.string() }))
    .query(({ input }): { active: boolean } => {
      return { active: lookupOrRehydrate(input.runId) !== undefined };
    }),

  /**
   * Relay a user chat turn to the run's monitor (the human seam). No-op (returns
   * { delivered: false }) when no monitor session is active for the run (including
   * after a failed/refused lazy rehydration attempt).
   *
   * The monitor session owns the inject→answer→inject orchestration via `converse`:
   * it injects the human's turn so it renders + becomes part of the history the
   * monitor reads, runs the grounded answer, then injects the reply. The user's turn
   * + the monitor's reply arrive in the renderer via the unified stream (injected
   * server-side → raw_events → streamEvents live-refresh → listUnifiedMessages), so
   * the router does NOT return the transcript — it only confirms delivery.
   *
   * Fail-soft: `converse` (and `answer`) never throw, so this resolves cleanly even
   * when the monitor's query errors (the monitor injects an apologetic assistant
   * turn). A session predating `converse` falls back to a bare `answer` (no render).
   */
  send: protectedProcedure
    .input(z.object({ runId: z.string(), text: z.string() }))
    .mutation(async ({ input }): Promise<{ delivered: boolean }> => {
      const session = lookupOrRehydrate(input.runId);
      if (!session) return { delivered: false };
      if (session.converse) {
        await session.converse(input.text);
      } else {
        // Defensive fallback for a session without the inject-owning `converse`
        // (e.g. a faked test session): still consult the monitor so the turn is
        // not silently dropped — it just won't render until `converse` is wired.
        await session.answer(input.text);
      }
      return { delivered: true };
    }),

  /**
   * Deterministic per-step results for a run (migration 033) — the structured
   * outcome of each settled step (done/skipped/failed/rejected/canceled + attempts).
   * [] when the store is uninitialized or the run has no results. UNCHANGED from the
   * old supervisorChat router.
   */
  stepResults: protectedProcedure
    .input(z.object({ runId: z.string() }))
    .query(({ input }): StepResultRow[] => {
      return StepResultStore.tryGetInstance()?.listForRun(input.runId) ?? [];
    }),
});
