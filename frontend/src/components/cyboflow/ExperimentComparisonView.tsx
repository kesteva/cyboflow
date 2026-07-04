/**
 * ExperimentComparisonView — the full-width center surface for a side-by-side
 * A/B experiment's pairwise comparison (A/B testing slice C).
 *
 * Opened via `navigationStore.openExperimentComparison(experimentId)` from: the
 * WorkflowSummaryPanel experiment banner, the RunCenterPane experiment chip, an
 * `experiments.listForDashboard` row click (Insights → Experiments), or a
 * blocking `kind:'decision', gate:'experiment-comparison'` review-queue card.
 *
 * Data sources (all AppRouter-inferred — no local mirrors):
 *   - `experiments.get`               — the experiment row (status, project,
 *     variant/seed ids) driving the CTA gates.
 *   - `experiments.getComparison`     — per-arm status/usage/eval/findings/entity
 *     counts + the aggregate pairwise verdict.
 *   - `experiments.getComparisonDiffs` — the FROZEN per-arm diff texts (works
 *     post-decide, once the worktrees are gone).
 * Polled (mirroring WorkflowSummaryPanel's eval-poll cadence) while the
 * comparison is not yet resolved (`absent | pending | running`); a resolved
 * comparison (`complete | failed | skipped`) stops the timer.
 *
 * Layout: (a) verdict card, (b) two arm columns (reusing WorkflowSummaryPanel's
 * `ScoreSummary`), (c) a shared changed-file list with side-by-side frozen diffs
 * (reusing FileTabRenderer's `DiffBody`), (d) footer CTAs (decide) + follow-ups
 * (rerun / switchToRotation).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, Trophy, Ban, RotateCcw, Shuffle } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useNavigationStore } from '../../stores/navigationStore';
import { useCyboflowStore } from '../../stores/cyboflowStore';
import { cn } from '../../utils/cn';
import { bootstrapArmSessionPanels } from '../../utils/bootstrapArmSessionPanels';
import { ScoreSummary, type FindingRow } from './WorkflowSummaryPanel';
import { DiffBody } from './FileTabRenderer';
import { IdeaPickerModal } from './IdeaPickerModal';
import { ConfirmDialog } from '../ConfirmDialog';
import { parseFileDiffs, findFileDiff } from '../../utils/parseFileHunks';
import { formatRuntime } from './runEvalDisplay';
import {
  isExperimentArmSettled,
  isExperimentSettled,
} from '../../../../shared/types/experiments';
import type {
  ExperimentRow,
  ExperimentComparisonPayload,
  ExperimentComparisonDiffs,
  ExperimentArmView,
  ExperimentArm,
  PairwiseSample,
} from '../../../../shared/types/experiments';
import type { QualityFinding } from '../../../../shared/types/insights';

/** How often to re-poll while the comparison is not yet resolved. */
const COMPARISON_POLL_MS = 10_000;

/** Map a QualityFinding (comparison payload's per-arm findings) into ScoreSummary's FindingRow. */
function toFindingRow(f: QualityFinding): FindingRow {
  const loc = f.locations[0];
  return {
    id: f.id,
    severity: f.severity ?? 'info',
    location: loc === undefined ? null : loc.line === undefined ? loc.path : `${loc.path}:${loc.line}`,
    category: f.category,
    title: f.title,
  };
}

function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1000) return `${(n / 1000).toFixed(0)}k`;
  return `${Math.round(n)}`;
}

function formatCost(n: number | null): string {
  return n === null ? '—' : `$${n.toFixed(2)}`;
}

/** The first arm whose run status is failed/canceled (for the "did not complete" message). */
function stalledArm(payload: ExperimentComparisonPayload): ExperimentArm | null {
  if (payload.armA.status === 'failed' || payload.armA.status === 'canceled') return 'A';
  if (payload.armB.status === 'failed' || payload.armB.status === 'canceled') return 'B';
  return null;
}

export interface ExperimentComparisonViewProps {
  experimentId: string;
}

export function ExperimentComparisonView({ experimentId }: ExperimentComparisonViewProps): React.JSX.Element {
  const [exp, setExp] = useState<ExperimentRow | null>(null);
  const [payload, setPayload] = useState<ExperimentComparisonPayload | null>(null);
  const [diffs, setDiffs] = useState<ExperimentComparisonDiffs | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [runAgainOpen, setRunAgainOpen] = useState(false);
  const [seedIdeaId, setSeedIdeaId] = useState<string | null>(null);
  const [seedIdeaLabel, setSeedIdeaLabel] = useState<string | null>(null);
  const [ideaPickerOpen, setIdeaPickerOpen] = useState(false);
  const [rotationConfirmOpen, setRotationConfirmOpen] = useState(false);

  // -- Data loading + polling ------------------------------------------------

  const load = useCallback(async (): Promise<{
    exp: ExperimentRow | null;
    payload: ExperimentComparisonPayload | null;
  }> => {
    const [expRow, comparisonPayload, diffsPayload] = await Promise.all([
      trpc.cyboflow.experiments.get.query({ experimentId }),
      trpc.cyboflow.experiments.getComparison.query({ experimentId }),
      trpc.cyboflow.experiments.getComparisonDiffs.query({ experimentId }),
    ]);
    setExp(expRow);
    setPayload(comparisonPayload);
    setDiffs(diffsPayload);
    return { exp: expRow, payload: comparisonPayload };
  }, [experimentId]);

  // `tick` is a ref-stable polling step (not tied to the mount effect) so that
  // handleRerunComparison can re-arm polling after the effect's own loop has
  // already stopped (comparisonStatus was 'complete' before the re-run) — see
  // the effect below for the mount/unmount wiring and `pollTimerRef` for the
  // outstanding-timer handle shared between the two call sites.
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const aliveRef = useRef(true);

  const tick = useCallback((): void => {
    load()
      .then((r) => {
        if (!aliveRef.current) return;
        setInitialLoading(false);
        if (r.exp === null || r.payload === null) {
          setLoadError('This experiment could not be found.');
          return;
        }
        setLoadError(null);
        const keepPolling =
          r.payload.comparisonStatus === 'absent' ||
          r.payload.comparisonStatus === 'pending' ||
          r.payload.comparisonStatus === 'running';
        if (keepPolling) pollTimerRef.current = setTimeout(tick, COMPARISON_POLL_MS);
      })
      .catch((err: unknown) => {
        if (!aliveRef.current) return;
        setInitialLoading(false);
        setLoadError(err instanceof Error ? err.message : 'Failed to load the comparison');
      });
  }, [load]);

  useEffect(() => {
    aliveRef.current = true;
    setInitialLoading(true);
    setLoadError(null);
    tick();
    return () => {
      aliveRef.current = false;
      if (pollTimerRef.current !== undefined) clearTimeout(pollTimerRef.current);
    };
  }, [tick]);

  // -- Shared changed-file list (client-side union of the two frozen diffs) --

  const armAFiles = useMemo(() => (diffs ? parseFileDiffs(diffs.armA.diff) : []), [diffs]);
  const armBFiles = useMemo(() => (diffs ? parseFileDiffs(diffs.armB.diff) : []), [diffs]);
  const filePaths = useMemo(() => {
    const set = new Set<string>();
    for (const f of armAFiles) set.add(f.path);
    for (const f of armBFiles) set.add(f.path);
    return Array.from(set).sort();
  }, [armAFiles, armBFiles]);

  useEffect(() => {
    if (selectedFilePath !== null && filePaths.includes(selectedFilePath)) return;
    setSelectedFilePath(filePaths[0] ?? null);
  }, [filePaths, selectedFilePath]);

  const selectedArmADiff = diffs && selectedFilePath ? findFileDiff(diffs.armA.diff, selectedFilePath) : null;
  const selectedArmBDiff = diffs && selectedFilePath ? findFileDiff(diffs.armB.diff, selectedFilePath) : null;

  // -- CTA gating -------------------------------------------------------------

  const armASettled = payload !== null && isExperimentArmSettled(payload.armA.status);
  const armBSettled = payload !== null && isExperimentArmSettled(payload.armB.status);
  const bothSettled = armASettled && armBSettled;
  const expSettled = exp !== null && isExperimentSettled(exp.status);
  const canDecide = exp !== null && payload !== null && !expSettled && bothSettled;
  const canRerunComparison = exp !== null && (exp.status === 'running' || exp.status === 'grading');
  const canSwitchToRotation = exp !== null && expSettled;

  // -- Actions -----------------------------------------------------------------

  const handleDecide = async (winnerRunId: string | null): Promise<void> => {
    if (actionBusy !== null) return;
    setActionBusy('decide');
    setActionError(null);
    try {
      await trpc.cyboflow.experiments.decide.mutate({ experimentId, winnerRunId });
      useNavigationStore.getState().closeExperimentComparison();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Failed to record the decision');
      setActionBusy(null);
    }
  };

  const handleRerunComparison = async (): Promise<void> => {
    if (actionBusy !== null) return;
    setActionBusy('rerunComparison');
    setActionError(null);
    try {
      await trpc.cyboflow.experiments.rerunComparison.mutate({ experimentId });
      // The mount effect's polling loop may have already stopped (comparisonStatus
      // was 'complete' before this re-run) — re-arm it via the shared `tick` so the
      // verdict card resumes polling instead of staying stuck on the stale state
      // until the view is closed and reopened.
      if (pollTimerRef.current !== undefined) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = undefined;
      }
      tick();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Failed to re-run the comparison');
    } finally {
      setActionBusy(null);
    }
  };

  const handleIdeaPicked = (ideaId: string): void => {
    setIdeaPickerOpen(false);
    setSeedIdeaId(ideaId);
    setSeedIdeaLabel(ideaId);
    void trpc.cyboflow.tasks.get
      .query({ taskId: ideaId })
      .then((row) => {
        if (row) setSeedIdeaLabel(`${row.ref} — ${row.title}`);
      })
      .catch(() => {});
  };

  const handleRunAgain = async (): Promise<void> => {
    if (exp === null || actionBusy !== null) return;
    setActionBusy('rerun');
    setActionError(null);
    try {
      // When the experiment is not yet decided, this composes as "Discard both &
      // run again": settle the live experiment FIRST, then chain the rerun.
      // `decide` hard-requires both arms settled (PRECONDITION_FAILED otherwise),
      // so only take that path once bothSettled — while an arm is still running,
      // `abandon` cancels it and tears the experiment down instead.
      if (!expSettled) {
        if (bothSettled) {
          await trpc.cyboflow.experiments.decide.mutate({ experimentId, winnerRunId: null });
        } else {
          await trpc.cyboflow.experiments.abandon.mutate({ experimentId });
        }
      }
      const result = await trpc.cyboflow.experiments.rerun.mutate({
        experimentId,
        ...(seedIdeaId !== null ? { seedIdeaId } : {}),
      });
      await bootstrapArmSessionPanels(result.armA.sessionId);
      useCyboflowStore.getState().setActiveRun(result.armA.runId, result.armA.sessionId);
      useNavigationStore.getState().setActiveProjectId(exp.project_id);
      // goToSession also clears experimentComparisonId (mutual-exclusion contract).
      useNavigationStore.getState().goToSession();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Failed to start the new experiment');
      setActionBusy(null);
    }
  };

  const handleSwitchToRotation = async (): Promise<void> => {
    if (exp === null || actionBusy !== null) return;
    setActionBusy('switchToRotation');
    setActionError(null);
    try {
      await trpc.cyboflow.experiments.switchToRotation.mutate({ experimentId });
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Failed to switch to rotation');
    } finally {
      setActionBusy(null);
      setRotationConfirmOpen(false);
    }
  };

  // -- Render -------------------------------------------------------------

  if (initialLoading) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-bg-primary" data-testid="experiment-comparison-loading">
        <p className="text-sm text-text-secondary">Loading comparison…</p>
      </div>
    );
  }

  if (loadError !== null || exp === null || payload === null) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-bg-primary" data-testid="experiment-comparison-error">
        <p className="text-sm text-status-error">{loadError ?? 'This experiment could not be found.'}</p>
        <button
          type="button"
          onClick={() => useNavigationStore.getState().closeExperimentComparison()}
          className="rounded-button border border-border-primary bg-bg-primary px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-bg-hover"
        >
          Close
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg-primary" data-testid="experiment-comparison-view">
      <div className="flex flex-shrink-0 items-center justify-between border-b border-border-primary bg-bg-secondary px-7 py-4">
        <div>
          <div className="eyebrow text-text-tertiary">A/B experiment · pairwise comparison</div>
          <h2 className="mt-1 text-[20px] font-bold tracking-[-0.01em] text-text-primary">Experiment comparison</h2>
        </div>
        <button
          type="button"
          data-testid="experiment-comparison-close"
          onClick={() => useNavigationStore.getState().closeExperimentComparison()}
          className="rounded-button p-1.5 text-text-tertiary hover:bg-bg-hover hover:text-text-primary"
          aria-label="Close comparison"
        >
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-7 py-5">
        <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-6">
          <VerdictCard payload={payload} onRerunComparison={handleRerunComparison} canRerunComparison={canRerunComparison} busy={actionBusy === 'rerunComparison'} />

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <ArmColumn arm={payload.armA} />
            <ArmColumn arm={payload.armB} />
          </div>

          <ChangedFileList
            filePaths={filePaths}
            selectedFilePath={selectedFilePath}
            onSelect={setSelectedFilePath}
            armALabel={diffs?.armA.label ?? payload.armA.variantLabel}
            armBLabel={diffs?.armB.label ?? payload.armB.variantLabel}
            armADiff={selectedArmADiff}
            armBDiff={selectedArmBDiff}
          />

          {actionError !== null && (
            <p className="text-sm text-status-error" role="alert">
              {actionError}
            </p>
          )}

          <div className="flex flex-col gap-3 border-t border-border-primary pt-5">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                data-testid="experiment-promote-a"
                disabled={!canDecide || actionBusy !== null}
                onClick={() => void handleDecide(payload.armA.runId)}
                className="inline-flex items-center gap-1.5 rounded-button bg-interactive px-3.5 py-2 text-sm font-medium text-text-on-interactive hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Trophy size={14} /> Promote A
              </button>
              <button
                type="button"
                data-testid="experiment-promote-b"
                disabled={!canDecide || actionBusy !== null}
                onClick={() => void handleDecide(payload.armB.runId)}
                className="inline-flex items-center gap-1.5 rounded-button bg-interactive px-3.5 py-2 text-sm font-medium text-text-on-interactive hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Trophy size={14} /> Promote B
              </button>
              <button
                type="button"
                data-testid="experiment-discard-both"
                disabled={!canDecide || actionBusy !== null}
                onClick={() => void handleDecide(null)}
                className="inline-flex items-center gap-1.5 rounded-button border border-border-primary px-3.5 py-2 text-sm font-medium text-text-secondary hover:border-border-emphasized hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Ban size={14} /> Discard both
              </button>
              {!bothSettled && !expSettled && (
                <span className="text-xs text-text-muted" data-testid="experiment-decide-hint">
                  Waiting for both arms to finish before a decision can be recorded.
                </span>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2 border-t border-dashed border-border-primary pt-3">
              {!runAgainOpen ? (
                <button
                  type="button"
                  data-testid="experiment-run-again-open"
                  onClick={() => setRunAgainOpen(true)}
                  className="inline-flex items-center gap-1.5 rounded-button border border-border-primary px-3 py-1.5 text-xs font-medium text-text-secondary hover:border-border-emphasized hover:text-text-primary"
                >
                  <RotateCcw size={13} />
                  {expSettled ? 'Run again with new seed…' : 'Discard both & run again…'}
                </button>
              ) : (
                <div className="flex flex-col gap-2 rounded-card border border-border-primary bg-surface-secondary/30 p-3" data-testid="experiment-run-again-panel">
                  <span className="text-xs font-medium text-text-secondary">
                    {expSettled
                      ? 'Repeat this head-to-head with the same variants.'
                      : 'This discards both live arms, then repeats the head-to-head with the same variants.'}
                  </span>
                  <div className="flex items-center gap-2 text-xs text-text-secondary">
                    <span>Seed idea (optional):</span>
                    {seedIdeaId === null ? (
                      <button
                        type="button"
                        onClick={() => setIdeaPickerOpen(true)}
                        data-testid="experiment-run-again-add-seed"
                        className="rounded-button border border-border-primary bg-bg-primary px-2 py-0.5 text-[11px] font-medium text-text-primary hover:bg-bg-hover"
                      >
                        Add a seed idea
                      </button>
                    ) : (
                      <>
                        <span className="truncate" data-testid="experiment-run-again-seed-label">{seedIdeaLabel}</span>
                        <button
                          type="button"
                          onClick={() => { setSeedIdeaId(null); setSeedIdeaLabel(null); }}
                          className="text-text-tertiary underline hover:text-text-primary"
                        >
                          Remove
                        </button>
                      </>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      data-testid="experiment-run-again-start"
                      disabled={actionBusy !== null}
                      onClick={() => void handleRunAgain()}
                      className="rounded-button bg-interactive px-3 py-1.5 text-xs font-medium text-text-on-interactive hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {actionBusy === 'rerun' ? 'Starting…' : expSettled ? 'Run again' : 'Discard both & run again'}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setRunAgainOpen(false); setSeedIdeaId(null); setSeedIdeaLabel(null); }}
                      disabled={actionBusy !== null}
                      className="rounded-button px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              <button
                type="button"
                data-testid="experiment-switch-to-rotation"
                disabled={!canSwitchToRotation || actionBusy !== null}
                title={canSwitchToRotation ? undefined : 'Available once the experiment is decided or abandoned'}
                onClick={() => setRotationConfirmOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-button border border-border-primary px-3 py-1.5 text-xs font-medium text-text-secondary hover:border-border-emphasized hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Shuffle size={13} />
                Switch to randomized
              </button>
            </div>
          </div>
        </div>
      </div>

      {ideaPickerOpen && exp !== null && (
        <IdeaPickerModal isOpen projectId={exp.project_id} onClose={() => setIdeaPickerOpen(false)} onPicked={handleIdeaPicked} />
      )}

      <ConfirmDialog
        isOpen={rotationConfirmOpen}
        onClose={() => setRotationConfirmOpen(false)}
        onConfirm={() => void handleSwitchToRotation()}
        title="Switch to randomized rotation?"
        message="Both variants are activated for rotation — future launches of this workflow randomly assign one of them, and every rotation run continues to accrue a judge-grading cost. This does not change the recorded decision for this experiment."
        confirmText="Switch to rotation"
        cancelText="Cancel"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Verdict card
// ---------------------------------------------------------------------------

const PREFERENCE_LABEL: Record<'A' | 'B' | 'tie', string> = { A: 'Prefers A', B: 'Prefers B', tie: 'Tie' };

function SampleChip({ sample }: { sample: PairwiseSample }): React.JSX.Element {
  const label = sample.preference === 'tie' ? 'Tie' : `Arm ${sample.preference}`;
  return (
    <span
      title={`Solution 1 = Arm ${sample.positionAFirst ? 'A' : 'B'} · Solution 2 = Arm ${sample.positionAFirst ? 'B' : 'A'} · confidence ${Math.round(sample.confidence * 100)}%`}
      data-testid="experiment-sample-chip"
      className="inline-flex items-center gap-1 rounded-full border border-border-primary bg-surface-secondary px-2 py-0.5 text-[11px] font-medium text-text-secondary"
    >
      #{sample.sampleIndex + 1} {label}
    </span>
  );
}

function VerdictCard({
  payload,
  onRerunComparison,
  canRerunComparison,
  busy,
}: {
  payload: ExperimentComparisonPayload;
  onRerunComparison: () => void;
  canRerunComparison: boolean;
  busy: boolean;
}): React.JSX.Element {
  const stalled = stalledArm(payload);
  return (
    <div className="rounded-card border border-border-primary bg-surface-primary p-5 shadow-sm" data-testid="experiment-verdict-card">
      <div className="flex items-start justify-between gap-3">
        <div className="eyebrow text-text-tertiary">Pairwise verdict</div>
        <div className="flex items-center gap-2">
          {payload.snapshotAt !== null && (
            <span className="text-xs text-text-muted" data-testid="experiment-snapshot-at">
              captured {new Date(payload.snapshotAt).toLocaleString()}
            </span>
          )}
          <button
            type="button"
            data-testid="experiment-rerun-comparison"
            disabled={!canRerunComparison || busy}
            onClick={onRerunComparison}
            title={canRerunComparison ? 'Re-capture diffs and re-judge' : 'Only available while the experiment is running or grading'}
            className="rounded-button border border-border-primary px-2.5 py-1 text-xs font-medium text-text-secondary hover:border-border-emphasized hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? 'Re-running…' : 'Re-run comparison'}
          </button>
        </div>
      </div>

      {payload.verdict !== null ? (
        <div className="mt-3 flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <span
              data-testid="experiment-verdict-preference"
              className={cn(
                'rounded-full border px-2.5 py-1 text-sm font-bold',
                payload.verdict.preference === 'tie'
                  ? 'border-text-tertiary/40 text-text-tertiary'
                  : 'border-status-success/40 bg-status-success/10 text-status-success',
              )}
            >
              {PREFERENCE_LABEL[payload.verdict.preference]}
            </span>
            <span className="text-xs text-text-secondary" data-testid="experiment-verdict-confidence">
              confidence {Math.round(payload.verdict.confidence * 100)}%
            </span>
            <span className="text-xs text-text-tertiary">
              A {payload.verdict.aCount} · B {payload.verdict.bCount} · tie {payload.verdict.tieCount} ({payload.verdict.sampleCount} samples)
            </span>
          </div>
          {payload.verdict.rationale !== '' && (
            <p className="text-sm text-text-secondary" data-testid="experiment-verdict-rationale">
              {payload.verdict.rationale}
            </p>
          )}
          <div className="flex flex-wrap gap-1.5" data-testid="experiment-verdict-samples">
            {payload.verdict.perSample.map((s) => (
              <SampleChip key={s.sampleIndex} sample={s} />
            ))}
          </div>
        </div>
      ) : (
        <p className="mt-3 text-sm text-text-secondary" data-testid="experiment-verdict-absent">
          {payload.comparisonStatus === 'absent' &&
            'Waiting for both arms to finish before automated grading begins — the diffs below update once each arm completes.'}
          {(payload.comparisonStatus === 'pending' || payload.comparisonStatus === 'running') &&
            'Automated grading is in progress…'}
          {payload.comparisonStatus === 'skipped' &&
            'Automated grading is disabled for this run — the diffs below are still comparable.'}
          {payload.comparisonStatus === 'failed' &&
            (stalled !== null
              ? `No automated verdict — Arm ${stalled} did not complete.`
              : 'No automated verdict is available for this comparison.')}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Arm column
// ---------------------------------------------------------------------------

function ArmColumn({ arm }: { arm: ExperimentArmView }): React.JSX.Element {
  const runtime = arm.usage ? formatRuntime(arm.usage.startedAt, arm.usage.endedAt) : null;
  return (
    <div className="flex flex-col gap-3 rounded-card border border-border-primary bg-surface-primary p-4" data-testid={`experiment-arm-${arm.arm.toLowerCase()}`}>
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="eyebrow text-text-tertiary">Arm {arm.arm}</div>
          <div className="text-sm font-semibold text-text-primary" title={arm.variantLabel}>{arm.variantLabel}</div>
        </div>
        <span
          data-testid={`experiment-arm-${arm.arm.toLowerCase()}-status`}
          className="rounded-full border border-border-primary bg-surface-secondary px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-text-secondary"
        >
          {arm.status}
        </span>
      </div>

      <div className="text-xs text-text-secondary" data-testid={`experiment-arm-${arm.arm.toLowerCase()}-meta`}>
        {arm.usage !== null ? (
          <>
            {compactTokens(arm.usage.totalTokens)} tokens · {formatCost(arm.usage.costUsd)}
            {runtime !== null && <> · {runtime}</>}
          </>
        ) : (
          'No usage recorded yet.'
        )}
      </div>

      <div className="text-xs text-text-tertiary" data-testid={`experiment-arm-${arm.arm.toLowerCase()}-entities`}>
        {arm.entitySummary.ideas} ideas · {arm.entitySummary.epics} epics · {arm.entitySummary.tasks} tasks
      </div>

      {arm.evalSummary !== null && (
        <ScoreSummary
          runEval={arm.evalSummary}
          findings={arm.findings.map(toFindingRow)}
          breakdownOpen={false}
          onToggleBreakdown={() => {}}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared changed-file list + side-by-side diff
// ---------------------------------------------------------------------------

function ChangedFileList({
  filePaths,
  selectedFilePath,
  onSelect,
  armALabel,
  armBLabel,
  armADiff,
  armBDiff,
}: {
  filePaths: string[];
  selectedFilePath: string | null;
  onSelect: (path: string) => void;
  armALabel: string;
  armBLabel: string;
  armADiff: ReturnType<typeof findFileDiff>;
  armBDiff: ReturnType<typeof findFileDiff>;
}): React.JSX.Element {
  if (filePaths.length === 0) {
    return (
      <div className="rounded-card border border-border-primary bg-surface-primary p-4 text-sm text-text-muted" data-testid="experiment-file-list-empty">
        No frozen diffs are available yet.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3 rounded-card border border-border-primary bg-surface-primary p-4" data-testid="experiment-file-list">
      <div className="eyebrow text-text-tertiary">Changed files</div>
      <div className="flex flex-wrap gap-1.5" data-testid="experiment-file-list-tabs">
        {filePaths.map((p) => (
          <button
            key={p}
            type="button"
            data-testid={`experiment-file-tab-${p}`}
            onClick={() => onSelect(p)}
            className={cn(
              'rounded-button border px-2 py-1 text-[11px] font-mono',
              p === selectedFilePath
                ? 'border-interactive bg-interactive/10 text-interactive'
                : 'border-border-primary text-text-secondary hover:border-border-emphasized',
            )}
          >
            {p}
          </button>
        ))}
      </div>
      {selectedFilePath !== null && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2" data-testid="experiment-file-diff-columns">
          <div className="overflow-hidden rounded-card border border-border-primary">
            <div className="border-b border-border-primary bg-surface-secondary px-2 py-1 text-[11px] font-medium text-text-tertiary">
              Arm A — {armALabel}
            </div>
            <div className="max-h-[420px] overflow-auto">
              {armADiff !== null ? (
                <DiffBody fileDiff={armADiff} mode="diff" />
              ) : (
                <p className="p-3 text-xs text-text-muted" data-testid="experiment-file-diff-a-empty">No changes in Arm A.</p>
              )}
            </div>
          </div>
          <div className="overflow-hidden rounded-card border border-border-primary">
            <div className="border-b border-border-primary bg-surface-secondary px-2 py-1 text-[11px] font-medium text-text-tertiary">
              Arm B — {armBLabel}
            </div>
            <div className="max-h-[420px] overflow-auto">
              {armBDiff !== null ? (
                <DiffBody fileDiff={armBDiff} mode="diff" />
              ) : (
                <p className="p-3 text-xs text-text-muted" data-testid="experiment-file-diff-b-empty">No changes in Arm B.</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
