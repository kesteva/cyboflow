/**
 * RotationComparisonBody — the ROTATION-mode body for ExperimentComparisonView
 * (`exp.kind === 'rotation'`). Rendered inside the parent's shared chrome
 * (header + close button) in place of the side-by-side verdict card / arm
 * columns / changed-file list / footer, which do not apply to an ongoing
 * randomized rotation (no paired arms, no frozen diffs).
 *
 * Data sources (both AppRouter-inferred):
 *   - `experiments.rotationStats` — per-arm aggregate stats, field-parallel to
 *     the workflow-level VariantStats table (see ExperimentsSection's
 *     VariantStatsTable, whose look this mirrors). Zero-run arms always
 *     present.
 *   - `experiments.rotationRuns`  — per-run drill-down (newest first), grouped
 *     here by `armVariantId` under each arm's stats block.
 *
 * Polls both every `ROTATION_POLL_MS` while `exp.status === 'running'` (same
 * setTimeout-tick + alive-ref pattern as the parent's comparison poll); a
 * settled rotation (`decided | abandoned | superseded`) fetches once and stops.
 *
 * Footer: while running, one "Declare <label> winner" CTA per arm (confirm-
 * gated) plus "End rotation (no winner)"; `decideRotation` / `abandonRotation`
 * conclude the rotation, then `onReload` re-fetches the parent's `exp` so this
 * component re-renders into its settled summary state.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Trophy, Ban } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useNavigationStore } from '../../stores/navigationStore';
import { useCyboflowStore } from '../../stores/cyboflowStore';
import { ConfirmDialog } from '../ConfirmDialog';
import { MIN_VARIANT_RUNS, isBaselineArm, isExperimentSettled } from '../../../../shared/types/experiments';
import type { ExperimentRow, RotationArmStats, RotationExperimentRun } from '../../../../shared/types/experiments';

/** How often to re-poll while the rotation is still running. */
const ROTATION_POLL_MS = 10_000;

function formatCost(n: number | null): string {
  return n === null ? '—' : `$${n.toFixed(2)}`;
}

function compactTokens(n: number | null): string {
  if (n === null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1000) return `${(n / 1000).toFixed(0)}k`;
  return `${Math.round(n)}`;
}

function formatMs(n: number | null): string {
  if (n === null) return '—';
  const totalSec = Math.round(n / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/** Human status/outcome text for one rotation run row. */
function runStatusLabel(run: RotationExperimentRun): string {
  return run.outcome !== null ? `${run.status} · ${run.outcome}` : run.status;
}

/** The winner label for a settled rotation's outcome summary, mirroring selectRotationDashboardRows. */
function winnerLabel(exp: ExperimentRow, stats: RotationArmStats[]): string | null {
  if (exp.promoted_variant_id === null) return null;
  if (isBaselineArm(exp.promoted_variant_id)) return 'Baseline';
  const match = stats.find((s) => s.armVariantId === exp.promoted_variant_id);
  return match ? match.label : exp.promoted_variant_id;
}

const STATUS_TEXT: Record<string, string> = {
  decided: 'Decided',
  abandoned: 'Abandoned',
  superseded: 'Superseded',
};

export interface RotationComparisonBodyProps {
  exp: ExperimentRow;
  onReload: () => Promise<void> | void;
}

export function RotationComparisonBody({ exp, onReload }: RotationComparisonBodyProps): React.JSX.Element {
  const [stats, setStats] = useState<RotationArmStats[] | null>(null);
  const [runs, setRuns] = useState<RotationExperimentRun[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [declareConfirmArm, setDeclareConfirmArm] = useState<string | null>(null);
  const [abandonConfirmOpen, setAbandonConfirmOpen] = useState(false);

  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const aliveRef = useRef(true);
  const running = exp.status === 'running';
  // Kept fresh via effect so `tick` can read the live status without needing
  // `running` in its own deps — that would change `tick`'s identity on
  // settle and re-run the mount effect mid-life (see aliveRef reset below).
  const runningRef = useRef(running);
  useEffect(() => {
    runningRef.current = running;
  }, [running]);

  const load = useCallback(async (): Promise<void> => {
    const [statsResult, runsResult] = await Promise.all([
      trpc.cyboflow.experiments.rotationStats.query({ experimentId: exp.id }),
      trpc.cyboflow.experiments.rotationRuns.query({ experimentId: exp.id }),
    ]);
    setStats(statsResult);
    setRuns(runsResult);
  }, [exp.id]);

  const tick = useCallback((): void => {
    load()
      .then(() => {
        if (!aliveRef.current) return;
        setLoadError(null);
        if (runningRef.current) pollTimerRef.current = setTimeout(tick, ROTATION_POLL_MS);
      })
      .catch((err: unknown) => {
        if (!aliveRef.current) return;
        setLoadError(err instanceof Error ? err.message : 'Failed to load rotation stats');
      });
  }, [load]);

  useEffect(() => {
    aliveRef.current = true;
    tick();
    return () => {
      aliveRef.current = false;
      if (pollTimerRef.current !== undefined) clearTimeout(pollTimerRef.current);
    };
  }, [tick]);

  const handleRunClick = (run: RotationExperimentRun): void => {
    if (run.sessionId === null) return;
    useCyboflowStore.getState().setActiveRun(run.runId, run.sessionId);
    useNavigationStore.getState().goToSession();
  };

  const handleDeclareWinner = async (armVariantId: string): Promise<void> => {
    if (actionBusy !== null) return;
    setActionBusy('decide');
    setActionError(null);
    try {
      await trpc.cyboflow.experiments.decideRotation.mutate({ experimentId: exp.id, winnerVariantId: armVariantId });
      await onReload();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Failed to declare a winner');
    } finally {
      setActionBusy(null);
      setDeclareConfirmArm(null);
    }
  };

  const handleAbandon = async (): Promise<void> => {
    if (actionBusy !== null) return;
    setActionBusy('abandon');
    setActionError(null);
    try {
      await trpc.cyboflow.experiments.abandonRotation.mutate({ experimentId: exp.id });
      await onReload();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Failed to end the rotation');
    } finally {
      setActionBusy(null);
      setAbandonConfirmOpen(false);
    }
  };

  const settled = isExperimentSettled(exp.status);
  const armLabels = (stats ?? []).map((s) => s.label);
  const declareArmStats = declareConfirmArm !== null ? (stats ?? []).find((s) => s.armVariantId === declareConfirmArm) ?? null : null;

  return (
    <div className="flex-1 overflow-y-auto px-7 py-5" data-testid="rotation-comparison-body">
      <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-6">
        <div className="rounded-card border border-border-primary bg-surface-primary p-5 shadow-sm" data-testid="rotation-header">
          <div className="eyebrow text-text-tertiary">Randomized rotation</div>
          <h3 className="mt-1 text-base font-semibold text-text-primary" data-testid="rotation-arm-labels">
            {armLabels.length > 0 ? armLabels.join(' vs ') : '—'}
          </h3>
          <div className="mt-1 text-xs text-text-secondary">
            Started {new Date(exp.created_at).toLocaleDateString()} · {(runs ?? []).length} runs
          </div>
        </div>

        {loadError !== null && (
          <p className="text-sm text-status-error" role="alert">
            {loadError}
          </p>
        )}

        {stats !== null && (
          <div className="overflow-x-auto rounded-card border border-border-primary" data-testid="rotation-stats-table">
            <table className="w-full min-w-[720px] text-left text-xs">
              <thead>
                <tr className="border-b border-border-primary bg-surface-secondary text-text-tertiary">
                  <th className="px-2 py-1.5 font-medium">Arm</th>
                  <th className="px-2 py-1.5 font-medium">Runs</th>
                  <th className="px-2 py-1.5 font-medium">Success</th>
                  <th className="px-2 py-1.5 font-medium">Avg duration</th>
                  <th className="px-2 py-1.5 font-medium">Avg tokens</th>
                  <th className="px-2 py-1.5 font-medium">Avg cost</th>
                  <th className="px-2 py-1.5 font-medium">Avg eval</th>
                  <th className="px-2 py-1.5 font-medium">Findings</th>
                  <th className="px-2 py-1.5 font-medium">Post-merge bugs</th>
                </tr>
              </thead>
              <tbody>
                {stats.map((s) => (
                  <tr key={s.armVariantId} className="border-b border-border-primary/60 last:border-b-0" data-testid={`rotation-stats-row-${s.armVariantId}`}>
                    <td className="px-2 py-1.5 text-text-primary">
                      {s.label}
                      {s.lowSample && (
                        <span className="ml-1 text-text-muted" data-testid={`rotation-lowsample-${s.armVariantId}`}>
                          n&lt;{MIN_VARIANT_RUNS}, provisional
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 tabular-nums text-text-secondary">{s.runs}</td>
                    <td className="px-2 py-1.5 tabular-nums text-text-secondary">{s.successRatePct}%</td>
                    <td className="px-2 py-1.5 tabular-nums text-text-secondary">{formatMs(s.avgDurationMs)}</td>
                    <td className="px-2 py-1.5 tabular-nums text-text-secondary">{compactTokens(s.avgTotalTokens)}</td>
                    <td className="px-2 py-1.5 tabular-nums text-text-secondary">{formatCost(s.avgCostUsd)}</td>
                    <td className="px-2 py-1.5 tabular-nums text-text-secondary">{s.avgEvalScore ?? '—'}</td>
                    <td className="px-2 py-1.5 tabular-nums text-text-secondary">{s.findingsCount}</td>
                    <td className="px-2 py-1.5 tabular-nums text-text-secondary">{s.postMergeBugCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {stats !== null && runs !== null && (
          <div className="flex flex-col gap-4" data-testid="rotation-run-lists">
            {stats.map((s) => {
              const armRuns = runs.filter((r) => r.armVariantId === s.armVariantId);
              return (
                <div key={s.armVariantId} className="flex flex-col gap-2 rounded-card border border-border-primary p-4" data-testid={`rotation-run-list-${s.armVariantId}`}>
                  <div className="text-xs font-semibold text-text-primary">{s.label}</div>
                  {armRuns.length === 0 ? (
                    <p className="text-xs text-text-muted">No runs yet.</p>
                  ) : (
                    <div className="flex flex-col divide-y divide-border-primary/60">
                      {armRuns.map((run) => {
                        const clickable = run.sessionId !== null;
                        const content = (
                          <>
                            <span className="rounded-full border border-border-primary bg-surface-secondary px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-text-secondary">
                              {runStatusLabel(run)}
                            </span>
                            <span className="text-text-tertiary">{new Date(run.createdAt).toLocaleDateString()}</span>
                            <span className="text-text-tertiary">{formatMs(run.durationMs)}</span>
                            <span className="text-text-tertiary">{formatCost(run.costUsd)}</span>
                          </>
                        );
                        return clickable ? (
                          <button
                            key={run.runId}
                            type="button"
                            data-testid={`rotation-run-row-${run.runId}`}
                            onClick={() => handleRunClick(run)}
                            className="flex items-center justify-between gap-2 px-1 py-1.5 text-left text-xs hover:bg-surface-hover"
                          >
                            {content}
                          </button>
                        ) : (
                          <div
                            key={run.runId}
                            data-testid={`rotation-run-row-${run.runId}`}
                            className="flex items-center justify-between gap-2 px-1 py-1.5 text-xs"
                          >
                            {content}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {actionError !== null && (
          <p className="text-sm text-status-error" role="alert">
            {actionError}
          </p>
        )}

        <div className="flex flex-col gap-2 border-t border-border-primary pt-5">
          <div className="eyebrow text-text-tertiary">Which version wins?</div>
          {!settled ? (
            running ? (
              <div className="flex flex-wrap items-center gap-2">
                {(stats ?? []).map((s) => (
                  <button
                    key={s.armVariantId}
                    type="button"
                    data-testid={`rotation-declare-winner-${s.armVariantId}`}
                    disabled={actionBusy !== null}
                    onClick={() => setDeclareConfirmArm(s.armVariantId)}
                    className="inline-flex items-center gap-1.5 rounded-button bg-interactive px-3.5 py-2 text-sm font-medium text-text-on-interactive hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Trophy size={14} /> Declare {s.label} winner
                  </button>
                ))}
                <button
                  type="button"
                  data-testid="rotation-abandon"
                  disabled={actionBusy !== null}
                  onClick={() => setAbandonConfirmOpen(true)}
                  className="inline-flex items-center gap-1.5 rounded-button border border-border-primary px-3.5 py-2 text-sm font-medium text-text-secondary hover:border-border-emphasized hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Ban size={14} /> End rotation (no winner)
                </button>
              </div>
            ) : (
              <p className="text-sm text-text-secondary">Waiting for rotation status…</p>
            )
          ) : (
            <p className="text-sm text-text-secondary" data-testid="rotation-outcome-summary">
              {STATUS_TEXT[exp.status] ?? exp.status}
              {exp.status === 'decided' && (
                <> · winner: {winnerLabel(exp, stats ?? [])}</>
              )}
              {exp.decided_at !== null && <> · {new Date(exp.decided_at).toLocaleDateString()}</>}
            </p>
          )}
        </div>
      </div>

      <ConfirmDialog
        isOpen={declareConfirmArm !== null}
        onClose={() => setDeclareConfirmArm(null)}
        onConfirm={() => {
          if (declareConfirmArm !== null) void handleDeclareWinner(declareConfirmArm);
        }}
        title={declareArmStats !== null ? `Declare ${declareArmStats.label} the winner?` : ''}
        message="This adopts the winning arm's step definition into the workflow (unless it's the baseline) and turns rotation off for this workflow."
        confirmText="Declare winner"
        cancelText="Cancel"
      />

      <ConfirmDialog
        isOpen={abandonConfirmOpen}
        onClose={() => setAbandonConfirmOpen(false)}
        onConfirm={() => void handleAbandon()}
        title="End rotation without a winner?"
        message="The rotation stops without adopting any arm's changes. Every active arm is paused, so the workflow reverts to its current baseline."
        confirmText="End rotation"
        cancelText="Cancel"
      />
    </div>
  );
}
