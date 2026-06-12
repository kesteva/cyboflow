/**
 * StatsSection — Insights mockup section 02.
 *
 * "02 STATISTICS — how each workflow is performing." Merges the two per-workflow
 * aggregates the store carries — run-outcome stats ({@link WorkflowRunStats}) and
 * the usage rollup ({@link WorkflowUsageStats}) — by `workflowId` into one card
 * per workflow, then renders a per-step token breakdown for the busiest one.
 *
 * Card content (per the mockup):
 *   - workflow name + a big avg-tokens figure (compact '184k' form).
 *   - an 'error X% · runs N · cost $Y' meta line (cost 2dp, '—' when null).
 *   - a {@link Sparkline} of the usage trend for that workflow (totalTokens).
 *
 * Below the cards a "TOKEN BY STEP" panel ranks the {@link StepTokenBucket}s of
 * the workflow with the MOST totalRuns via {@link BarRow}; the panel is hidden
 * when that workflow has no step data. A small ⚠ integrity hint surfaces when
 * any workflow has `nullOutcomeRuns > 0` (terminal runs whose outcome was never
 * stamped — see the shared contract's data-integrity note).
 *
 * Formatting helpers (compactTokens / formatCost) live here because they are the
 * presentation contract for THIS section, not shared domain logic.
 */
import { useMemo } from 'react';
import { useInsightsStore } from '../../stores/insightsStore';
import { BarRow } from './charts/BarRow';
import { Sparkline } from './charts/Sparkline';
import type {
  WorkflowRunStats,
  WorkflowUsageStats,
} from '../../../../shared/types/insights';

// ---------------------------------------------------------------------------
// Presentation formatters — section-local (display contract, not domain logic).
// ---------------------------------------------------------------------------

/** Compact token figure: >= 1000 → 'Nk' (rounded), else the raw integer. */
function compactTokens(n: number | null): string {
  if (n === null) return '—';
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
  avgTotalTokens: number | null;
  totalCostUsd: number | null;
}

/**
 * Merge `workflowStats` (always the spine — every workflow that has run) with
 * `workflowUsage` (present only for workflows with usage data) by `workflowId`.
 * Usage fields fall back to null when a workflow has stats but no usage rollup.
 */
function mergeWorkflowCards(
  stats: WorkflowRunStats[],
  usage: WorkflowUsageStats[],
): WorkflowCardModel[] {
  const usageById = new Map<string, WorkflowUsageStats>();
  for (const u of usage) usageById.set(u.workflowId, u);

  return stats.map((s): WorkflowCardModel => {
    const u = usageById.get(s.workflowId) ?? null;
    return {
      workflowId: s.workflowId,
      workflowName: s.workflowName,
      totalRuns: s.totalRuns,
      errorRatePct: s.errorRatePct,
      nullOutcomeRuns: s.nullOutcomeRuns,
      avgTotalTokens: u?.avgTotalTokens ?? null,
      totalCostUsd: u?.totalCostUsd ?? null,
    };
  });
}

/** One workflow card — name, big avg-tokens figure, meta line, sparkline. */
function WorkflowCard({
  card,
  trendPoints,
}: {
  card: WorkflowCardModel;
  trendPoints: number[];
}): React.JSX.Element {
  return (
    <div
      className="rounded-card border border-border-primary bg-surface-primary p-4"
      data-testid={`stats-card-${card.workflowId}`}
    >
      <div className="eyebrow text-text-tertiary">{card.workflowName}</div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className="text-3xl font-bold tabular-nums text-text-primary" data-testid="stats-avg-tokens">
          {compactTokens(card.avgTotalTokens)}
        </span>
        <span className="text-[10px] uppercase tracking-wider text-text-tertiary">avg tokens</span>
      </div>
      <div className="mt-1 text-xs text-text-secondary" data-testid="stats-meta">
        error {card.errorRatePct}% · runs {card.totalRuns} · cost {formatCost(card.totalCostUsd)}
      </div>
      <div className="mt-3">
        <Sparkline points={trendPoints} strokeClass="text-interactive" />
      </div>
    </div>
  );
}

export function StatsSection(): React.JSX.Element {
  const workflowStats = useInsightsStore((s) => s.workflowStats);
  const workflowUsage = useInsightsStore((s) => s.workflowUsage);
  const stepTokens = useInsightsStore((s) => s.stepTokens);
  const usageTrends = useInsightsStore((s) => s.usageTrends);

  const cards = useMemo(
    () => mergeWorkflowCards(workflowStats, workflowUsage),
    [workflowStats, workflowUsage],
  );

  // Integrity hint — sum of terminal-but-unstamped-outcome runs across workflows.
  const nullOutcomeTotal = useMemo(
    () => workflowStats.reduce((sum, s) => sum + s.nullOutcomeRuns, 0),
    [workflowStats],
  );

  // Busiest workflow (most totalRuns) drives the per-step token panel.
  const busiest = useMemo<WorkflowRunStats | null>(() => {
    let top: WorkflowRunStats | null = null;
    for (const s of workflowStats) {
      if (top === null || s.totalRuns > top.totalRuns) top = s;
    }
    return top;
  }, [workflowStats]);

  const busiestBuckets = busiest === null ? [] : stepTokens[busiest.workflowId] ?? [];
  const maxBucket = busiestBuckets.reduce((m, b) => Math.max(m, b.totalTokens), 0);

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
            />
          ))}
        </div>
      )}

      {busiestBuckets.length > 0 && busiest !== null && (
        <div className="mt-5" data-testid="stats-token-by-step">
          <div className="eyebrow mb-2 text-text-tertiary">
            Token by step · {busiest.workflowName}
          </div>
          <div className="space-y-1.5">
            {busiestBuckets.map((bucket) => (
              <BarRow
                key={bucket.stepId}
                label={bucket.stepId}
                value={bucket.totalTokens}
                max={maxBucket}
                valueLabel={compactTokens(bucket.totalTokens)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
