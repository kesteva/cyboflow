/**
 * SprintBatchProgressBadge — a compact live progress indicator for a running
 * parallel sprint batch (feat/parallel-sprint, P6).
 *
 * Renders "N tasks · M running · K integrated · status" for the batch the user
 * just launched. The batch advances on per-task run-status transitions (the
 * scheduler merges a drained run into the integration branch and frees a slot on
 * each), so we reuse the EXISTING reactive channel — cyboflow.events.onRunStatusChanged,
 * the same global lifecycle signal activeRunsStore subscribes to — as an
 * invalidation trigger and re-fetch the authoritative snapshot via
 * runs.batchProgress. No new polling loop, no new subscription endpoint.
 *
 * The badge self-dismisses once the batch reaches a terminal status (completed /
 * failed / canceled) is left to the user via the dismiss control; until then it
 * stays mounted reflecting the live aggregate.
 */
import { useCallback, useEffect, useState } from 'react';
import { trpc } from '../../trpc/client';
import type { SprintBatchProgress } from '../../../../shared/types/sprintBatch';

interface SprintBatchProgressBadgeProps {
  batchId: string;
  /** Clear the active-batch selection (removes the badge). */
  onDismiss: () => void;
}

/** Human-readable label for each batch status. */
const STATUS_LABEL: Readonly<Record<SprintBatchProgress['status'], string>> = {
  planning: 'analyzing dependencies',
  running: 'running',
  finalizing: 'finalizing',
  completed: 'completed',
  failed: 'failed',
  canceled: 'canceled',
};

export function SprintBatchProgressBadge({
  batchId,
  onDismiss,
}: SprintBatchProgressBadgeProps): React.JSX.Element | null {
  const [progress, setProgress] = useState<SprintBatchProgress | null>(null);

  const refresh = useCallback((): void => {
    trpc.cyboflow.runs.batchProgress
      .query({ batchId })
      .then((p) => setProgress(p))
      .catch((err: unknown) => {
        // A missing batch (or unwired deps) should not crash the badge — keep the
        // last good snapshot. The badge is informational only.
        console.warn('[SprintBatchProgressBadge] batchProgress failed:', err);
      });
  }, [batchId]);

  // Initial fetch + re-fetch on the global run-lifecycle signal. The batch
  // advances on per-task run transitions, so onRunStatusChanged is the precise
  // invalidation trigger (mirrors activeRunsStore's reactive strategy).
  useEffect(() => {
    refresh();
    const sub = trpc.cyboflow.events.onRunStatusChanged.subscribe(undefined, {
      onData: () => refresh(),
      onError: (err: unknown) =>
        console.warn('[SprintBatchProgressBadge] onRunStatusChanged error:', err),
    });
    return () => sub.unsubscribe();
  }, [refresh]);

  if (progress === null) return null;

  return (
    <div
      data-testid="sprint-batch-progress"
      role="status"
      className="flex items-center justify-between gap-2 rounded-input border border-border-primary bg-bg-secondary px-3 py-1.5 text-xs text-text-secondary"
    >
      <span>
        <span className="font-semibold text-text-primary">{progress.total}</span> tasks ·{' '}
        <span className="font-semibold text-text-primary">{progress.running}</span> running ·{' '}
        <span className="font-semibold text-text-primary">{progress.integrated}</span> integrated
        {progress.failed > 0 && (
          <>
            {' · '}
            <span className="font-semibold text-status-error">{progress.failed}</span> failed
          </>
        )}{' '}
        · {STATUS_LABEL[progress.status]}
      </span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss batch progress"
        data-testid="sprint-batch-progress-dismiss"
        className="text-text-tertiary hover:text-text-secondary"
      >
        ✕
      </button>
    </div>
  );
}
