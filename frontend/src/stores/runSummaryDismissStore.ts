/**
 * runSummaryDismissStore — per-run "I've dismissed the completion summary" flag.
 *
 * The end-of-workflow summary (WorkflowSummaryPanel) is derived purely from the
 * run's status (resolveRunSummaryVariant), so a finished run re-forces the
 * summary onto the Flow tab on every remount / re-selection — trapping the user
 * on the completion view even after they've moved on (e.g. to a follow-up chat
 * in the same session). This store records, per run id, that the operator has
 * dismissed that summary, so CyboflowRoot can show the run's canvas/chat instead
 * and stop re-forcing it.
 *
 * IN-MEMORY only (no DB, no localStorage), mirroring centerPaneStore: the
 * dismissal persists across sequential re-selections within the app session and
 * resets on refresh (a fresh load shows the summary again — the durable source
 * of the run's outcome is the DB / Insights). Keyed by RUN id (not session) so a
 * session that later launches a new run starts that run un-dismissed.
 *
 * Only the terminal / self-contained summary variants ('complete' | 'failed')
 * are dismissable; the 'review' variant is a live decision gate and must never
 * be hidden — that gating lives in the caller (CyboflowRoot), not here.
 */
import { create } from 'zustand';

interface RunSummaryDismissStore {
  /** Run ids whose completion summary the operator has dismissed. */
  dismissed: Record<string, true>;
  /** Dismiss a run's completion summary (idempotent). */
  dismiss: (runId: string) => void;
  /** Re-show a run's completion summary (idempotent). */
  restore: (runId: string) => void;
}

export const useRunSummaryDismissStore = create<RunSummaryDismissStore>((set) => ({
  dismissed: {},
  dismiss: (runId) =>
    set((s) => (s.dismissed[runId] ? s : { dismissed: { ...s.dismissed, [runId]: true } })),
  restore: (runId) =>
    set((s) => {
      if (!s.dismissed[runId]) return s;
      const next = { ...s.dismissed };
      delete next[runId];
      return { dismissed: next };
    }),
}));

/** Reactive selector: has this run's completion summary been dismissed? */
export function useRunSummaryDismissed(runId: string | null): boolean {
  return useRunSummaryDismissStore((s) => (runId !== null ? !!s.dismissed[runId] : false));
}
