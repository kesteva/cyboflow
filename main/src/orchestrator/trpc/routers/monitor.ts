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
 * Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3',
 * or main/src/services/*.
 */
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { MonitorRegistry } from '../../programmatic/monitor';
import { StepResultStore, type StepResultRow } from '../../stepResultStore';

export const monitorRouter = router({
  /**
   * Whether a monitor session is active for a run — drives whether the renderer
   * enables the Chat composer for the run (only programmatic runs with the SDK
   * monitor have one). Cheap registry lookup.
   */
  isActive: protectedProcedure
    .input(z.object({ runId: z.string() }))
    .query(({ input }): { active: boolean } => {
      return { active: MonitorRegistry.getInstance().get(input.runId) !== undefined };
    }),

  /**
   * Relay a user chat turn to the run's monitor (the human seam). No-op (returns
   * { delivered: false }) when no monitor session is active for the run.
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
      const session = MonitorRegistry.getInstance().get(input.runId);
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
