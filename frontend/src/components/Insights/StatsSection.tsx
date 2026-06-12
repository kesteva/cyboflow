/**
 * StatsSection — Insights mockup section 02.
 *
 * "02 STATISTICS — how each workflow is performing." Merges the two per-workflow
 * aggregates the store carries — run-outcome stats ({@link WorkflowRunStats}) and
 * the usage rollup ({@link WorkflowUsageStats}) — by `workflowId` into one card
 * per workflow, with a 30-day daily token-use chart pinned above the grid and a
 * click-to-drill token panel below it.
 *
 * Layout (top → bottom):
 *   1. A {@link DailyUsageChart} of the store's `dailyUsage` slice (the section's
 *      cross-project, per-(day, model) token history for the last 30 days).
 *   2. The card grid — one {@link WorkflowCard} per workflow, sorted spendiest
 *      first (totalCostUsd DESC, null-cost cards last):
 *        - workflow name + a big TOTAL-tokens figure (compact '1.8m'/'184k'
 *          form) with a smaller '· avg Nk' per-run figure beside it.
 *        - an 'error X% · runs N · cost $Y' meta line (cost 2dp, '—' when null).
 *        - a {@link Sparkline} of the usage trend for that workflow (totalTokens).
 *      Each card is a SELECTABLE button (aria-pressed): clicking selects the
 *      workflow (and lazily ensures its drill-down detail exists via the store's
 *      {@link InsightsState.ensureWorkflowDetail}, since the per-workflow fan-out
 *      is capped); clicking the selected card again deselects.
 *   3. A token panel whose content follows the selection:
 *        - NO selection → "TOKEN BY FLOW": one {@link BarRow} per workflow from
 *          {@link WorkflowUsageStats.totalTokens}, sorted DESC (null/0 skipped).
 *        - a SELECTED flow → "TOKEN BY STEP · {name}": the selected workflow's
 *          {@link StepTokenBucket}s (a muted note when it has none yet), with a
 *          deselect affordance. {@link VersionHistory} follows the selection.
 *      The busiest-workflow (most totalRuns) computation survives ONLY as the
 *      VersionHistory fallback in the no-selection state — the step panel no
 *      longer keys off it.
 *
 * A small ⚠ integrity hint surfaces when any workflow has `nullOutcomeRuns > 0`
 * (terminal runs whose outcome was never stamped — see the shared contract's
 * data-integrity note).
 *
 * Formatting helpers (compactTokens / formatCost) live here because they are the
 * presentation contract for THIS section, not shared domain logic.
 */
import { useMemo, useState } from 'react';
import { useInsightsStore } from '../../stores/insightsStore';
import { BarRow } from './charts/BarRow';
import { Sparkline } from './charts/Sparkline';
import { DailyUsageChart } from './charts/DailyUsageChart';
import { VersionHistory } from './VersionHistory';
import { cn } from '../../utils/cn';
import type {
  WorkflowRunStats,
  WorkflowUsageStats,
} from '../../../../shared/types/insights';

// ---------------------------------------------------------------------------
// Presentation formatters — section-local (display contract, not domain logic).
// ---------------------------------------------------------------------------

/** Compact token figure: >= 1M → 'N.Nm', >= 1000 → 'Nk', else the raw integer. */
function compactTokens(n: number | null): string {
  if (n === null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1000) return `${(n / 1000).toFixed(0)}k`;
  return `${Math.round(n)}`;
}

/** USD cost to 2dp, or an em dash when the rollup carried no cost. */
function formatCost(n: number | null): string {
  return n === null ? '—' : `$${n.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Merge model — one card per workflowId, joining run-stats + usage-stats.
// ---------------------------------------------------------------------------

interface WorkflowCardModel {
  workflowId: string;
  workflowName: string;
  totalRuns: number;
  errorRatePct: number;
  nullOutcomeRuns: number;
  totalTokens: number | null;
  avgTotalTokens: number | null;
  totalCostUsd: number | null;
}

/** Sort key that sends null (no recorded cost/usage) below any real value ≥ 0. */
function nullsLast(n: number | null): number {
  return n === null ? -1 : n;
}

/**
 * Merge `workflowStats` (always the spine — every workflow that has run) with
 * `workflowUsage` (present only for workflows with usage data) by `workflowId`.
 * Usage fields fall back to null when a workflow has stats but no usage rollup.
 *
 * Cards come back sorted spendiest-first: totalCostUsd DESC (null cost last),
 * tie-broken by totalTokens DESC (null last), then workflowName ASC so the
 * grid order is stable across refreshes.
 */
function mergeWorkflowCards(
  stats: WorkflowRunStats[],
  usage: WorkflowUsageStats[],
): WorkflowCardModel[] {
  const usageById = new Map<string, WorkflowUsageStats>();
  for (const u of usage) usageById.set(u.workflowId, u);

  return stats
    .map((s): WorkflowCardModel => {
      const u = usageById.get(s.workflowId) ?? null;
      return {
        workflowId: s.workflowId,
        workflowName: s.workflowName,
        totalRuns: s.totalRuns,
        errorRatePct: s.errorRatePct,
        nullOutcomeRuns: s.nullOutcomeRuns,
        totalTokens: u?.totalTokens ?? null,
        avgTotalTokens: u?.avgTotalTokens ?? null,
        totalCostUsd: u?.totalCostUsd ?? null,
      };
    })
    .sort(
      (a, b) =>
        nullsLast(b.totalCostUsd) - nullsLast(a.totalCostUsd) ||
        nullsLast(b.totalTokens) - nullsLast(a.totalTokens) ||
        (a.workflowName < b.workflowName ? -1 : a.workflowName > b.workflowName ? 1 : 0),
    );
}

/** One by-flow token bar: a workflow with a non-null, positive totalTokens sum. */
interface FlowTokenRow {
  workflowId: string;
  workflowName: string;
  totalTokens: number;
}

/**
 * The "token by flow" bars: every workflow whose usage rollup carried a positive
 * `totalTokens`, sorted DESC. Workflows with a null or zero sum are dropped (no
 * usable bar). Pure so the no-selection default panel stays deterministic.
 */
function selectFlowTokenRows(usage: WorkflowUsageStats[]): FlowTokenRow[] {
  return usage
    .filter((u): u is WorkflowUsageStats & { totalTokens: number } =>
      u.totalTokens !== null && u.totalTokens > 0,
    )
    .map((u) => ({
      workflowId: u.workflowId,
      workflowName: u.workflowName,
      totalTokens: u.totalTokens,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
}

/**
 * One workflow card — name, big total-tokens figure (with a smaller per-run
 * average beside it), meta line, sparkline. Rendered as a selectable <button>:
 * `selected` toggles the aria-pressed state plus the paper-theme selected
 * affordance (emphasized border + a faint surface lift); the whole card is the
 * click target, and `onSelect` toggles selection in the parent.
 */
function WorkflowCard({
  card,
  trendPoints,
  selected,
  onSelect,
}: {
  card: WorkflowCardModel;
  trendPoints: number[];
  selected: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        'rounded-card border p-4 text-left transition-colors',
        'hover:border-border-emphasized hover:bg-surface-secondary',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-interactive',
        selected
          ? 'border-border-emphasized bg-surface-secondary'
          : 'border-border-primary bg-surface-primary',
      )}
      data-testid={`stats-card-${card.workflowId}`}
    >
      <div className="eyebrow text-text-tertiary">{card.workflowName}</div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className="text-3xl font-bold tabular-nums text-text-primary" data-testid="stats-total-tokens">
          {compactTokens(card.totalTokens)}
        </span>
        <span className="text-[10px] uppercase tracking-wider text-text-tertiary">tokens</span>
        {card.avgTotalTokens !== null && (
          <span
            className="ml-1 text-[10px] uppercase tracking-wider text-text-tertiary"
            data-testid="stats-avg-tokens"
          >
            · avg {compactTokens(card.avgTotalTokens)}
          </span>
        )}
      </div>
      <div className="mt-1 text-xs text-text-secondary" data-testid="stats-meta">
        error {card.errorRatePct}% · runs {card.totalRuns} · cost {formatCost(card.totalCostUsd)}
      </div>
      <div className="mt-3">
        <Sparkline points={trendPoints} strokeClass="text-interactive" />
      </div>
    </button>
  );
}

export function StatsSection(): React.JSX.Element {
  const workflowStats = useInsightsStore((s) => s.workflowStats);
  const workflowUsage = useInsightsStore((s) => s.workflowUsage);
  const stepTokens = useInsightsStore((s) => s.stepTokens);
  const usageTrends = useInsightsStore((s) => s.usageTrends);
  // `?? []` / `?? {}` tolerate a partial store mock that omits a slice (the live
  // store always initializes dailyUsage to [] and revisionHistory to {}); without
  // them the daily chart would read `.length` off undefined and a non-null
  // selection would index into undefined.
  const dailyUsage = useInsightsStore((s) => s.dailyUsage) ?? [];
  const revisionHistory = useInsightsStore((s) => s.revisionHistory) ?? {};

  // Which workflow's drill-down panel is showing; null = the by-flow overview.
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);

  const cards = useMemo(
    () => mergeWorkflowCards(workflowStats, workflowUsage),
    [workflowStats, workflowUsage],
  );

  // Integrity hint — sum of terminal-but-unstamped-outcome runs across workflows.
  const nullOutcomeTotal = useMemo(
    () => workflowStats.reduce((sum, s) => sum + s.nullOutcomeRuns, 0),
    [workflowStats],
  );

  // Busiest workflow (most totalRuns) — kept ONLY as the VersionHistory fallback
  // in the no-selection state; the token panel no longer keys off it.
  const busiest = useMemo<WorkflowRunStats | null>(() => {
    let top: WorkflowRunStats | null = null;
    for (const s of workflowStats) {
      if (top === null || s.totalRuns > top.totalRuns) top = s;
    }
    return top;
  }, [workflowStats]);

  // The by-flow token bars for the no-selection overview.
  const flowRows = useMemo(() => selectFlowTokenRows(workflowUsage), [workflowUsage]);
  const maxFlow = flowRows.reduce((m, r) => Math.max(m, r.totalTokens), 0);

  // The selected workflow's run-stats (for its name + revision lookup) and its
  // per-step token buckets. Both are absent until ensureWorkflowDetail resolves.
  const selectedStats =
    selectedWorkflowId === null
      ? null
      : workflowStats.find((s) => s.workflowId === selectedWorkflowId) ?? null;
  const selectedName = selectedStats?.workflowName ?? selectedWorkflowId ?? '';
  const selectedBuckets =
    selectedWorkflowId === null ? [] : stepTokens[selectedWorkflowId] ?? [];
  const maxBucket = selectedBuckets.reduce((m, b) => Math.max(m, b.totalTokens), 0);

  // Version history follows the SELECTED workflow when one is chosen; otherwise it
  // keeps the busiest-workflow fallback so the panel stays populated by default.
  const revisionWorkflow = selectedWorkflowId ?? busiest?.workflowId ?? null;
  const revisionName =
    selectedWorkflowId !== null ? selectedName : busiest?.workflowName ?? '';
  const revisions = revisionWorkflow === null ? [] : revisionHistory[revisionWorkflow] ?? [];

  // Toggle selection; selecting a NEW workflow eagerly ensures its drill-down
  // detail exists (it may sit outside the store's capped per-workflow fan-out).
  const handleSelect = (workflowId: string): void => {
    setSelectedWorkflowId((prev) => {
      if (prev === workflowId) return null;
      void useInsightsStore.getState().ensureWorkflowDetail(workflowId);
      return workflowId;
    });
  };

  return (
    <div data-testid="stats-section">
      <header className="flex flex-wrap items-baseline gap-2 border-b border-border-primary pb-2">
        <span className="eyebrow text-text-tertiary">02 Statistics</span>
        <span className="text-xs text-text-secondary">— how each workflow is performing</span>
        {nullOutcomeTotal > 0 && (
          <span
            className="ml-auto text-[10px] font-semibold text-status-warning"
            data-testid="stats-integrity-hint"
            title="Terminal runs whose merge outcome was never stamped"
          >
            ⚠ {nullOutcomeTotal} runs missing outcome
          </span>
        )}
      </header>

      <div className="mt-3" data-testid="stats-daily-usage">
        <div className="eyebrow mb-2 text-text-tertiary">Token use · last 30 days</div>
        <DailyUsageChart points={dailyUsage} />
      </div>

      {cards.length === 0 ? (
        <p className="py-8 text-center text-sm text-text-muted" data-testid="stats-empty">
          No workflow runs yet — statistics appear once a flow has run.
        </p>
      ) : (
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {cards.map((card) => (
            <WorkflowCard
              key={card.workflowId}
              card={card}
              trendPoints={(usageTrends[card.workflowId] ?? []).map((p) => p.totalTokens)}
              selected={selectedWorkflowId === card.workflowId}
              onSelect={() => handleSelect(card.workflowId)}
            />
          ))}
        </div>
      )}

      {(cards.length > 0 || revisions.length > 0) && (
        <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
          {selectedWorkflowId !== null ? (
            <div data-testid="stats-token-by-step">
              <div className="mb-2 flex items-baseline justify-between gap-2">
                <span className="eyebrow text-text-tertiary">
                  Token by step · {selectedName}
                </span>
                <button
                  type="button"
                  onClick={() => setSelectedWorkflowId(null)}
                  className="text-[11px] text-text-tertiary transition-colors hover:text-text-secondary"
                  data-testid="stats-deselect"
                >
                  ← all flows
                </button>
              </div>
              {selectedBuckets.length > 0 ? (
                <div className="space-y-1.5">
                  {selectedBuckets.map((bucket) => (
                    <BarRow
                      key={bucket.stepId}
                      label={bucket.stepId}
                      value={bucket.totalTokens}
                      max={maxBucket}
                      valueLabel={compactTokens(bucket.totalTokens)}
                    />
                  ))}
                </div>
              ) : (
                <p className="text-xs text-text-muted" data-testid="stats-no-steps">
                  No step attribution for this flow yet.
                </p>
              )}
            </div>
          ) : (
            <div data-testid="stats-token-by-flow">
              <div className="eyebrow mb-2 text-text-tertiary">Token by flow</div>
              {flowRows.length > 0 ? (
                <div className="space-y-1.5">
                  {flowRows.map((row) => (
                    <BarRow
                      key={row.workflowId}
                      label={row.workflowName}
                      value={row.totalTokens}
                      max={maxFlow}
                      valueLabel={compactTokens(row.totalTokens)}
                    />
                  ))}
                </div>
              ) : (
                <p className="text-xs text-text-muted" data-testid="stats-no-flow-tokens">
                  No token usage recorded for any flow yet.
                </p>
              )}
            </div>
          )}

          {revisions.length > 0 && (
            <VersionHistory workflowName={revisionName} revisions={revisions} />
          )}
        </div>
      )}
    </div>
  );
}
