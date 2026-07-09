/**
 * ExperimentsSection — Insights mockup section 04 (A/B testing slice C).
 *
 * "04 EXPERIMENTS — how workflow variants perform, and past head-to-heads."
 * Three parts, per workflow known to the store's `workflowStats` slice (the
 * same per-workflow list StatsSection cards from):
 *
 *   1. Per-variant stats table (`insights.variantStats`) — every VariantStats
 *      metric as a column; a workflow with no variants renders nothing (v1
 *      never shows an empty table). Low-sample rows (runs < MIN_VARIANT_RUNS)
 *      get an inline "n<5, provisional" annotation; a deleted variant (whose
 *      `variantStatus` came back null) is labelled with its denormalized
 *      `variantLabel` + "(deleted)".
 *   2. A rotation status line — which variants are currently `active` + their
 *      weights, read from {@link useWorkflowVariants} (variantsStore) rather
 *      than variantStats, since a freshly-activated variant with zero runs
 *      would not appear there yet.
 *   3. The past-experiments list (`experiments.listForDashboard`), grouped by
 *      `seriesKey` so a chain of reruns collapses into one aggregate line
 *      (e.g. "B preferred 2 of 3") with the individual experiments beneath —
 *      row click opens the comparison view via
 *      `navigationStore.openExperimentComparison`.
 *
 * This section reads trpc directly (unlike its siblings, which read a shared
 * store slice hydrated by InsightsView's single init() fan-out) — its data
 * (variant stats + the experiments dashboard list) is NOT part of that shared
 * fetch, and fetching it per-workflow here keeps the shared store free of an
 * A/B-testing-specific slice. Every read is advisory: a failed fetch degrades
 * to an empty/muted state rather than surfacing an error banner.
 */
import { useEffect, useState } from 'react';
import { trpc } from '../../trpc/client';
import { useInsightsStore } from '../../stores/insightsStore';
import { useWorkflowVariants } from '../../stores/variantsStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { cn } from '../../utils/cn';
import { MIN_VARIANT_RUNS } from '../../../../shared/types/experiments';
import type { VariantStats, ExperimentSummary } from '../../../../shared/types/experiments';

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

// ---------------------------------------------------------------------------
// Per-workflow variant stats table
// ---------------------------------------------------------------------------

function VariantStatsTable({ workflowName, rows }: { workflowName: string; rows: VariantStats[] }): React.JSX.Element {
  return (
    <div className="overflow-x-auto rounded-card border border-border-primary" data-testid={`experiments-variant-table-${workflowName}`}>
      <table className="w-full min-w-[720px] text-left text-xs">
        <thead>
          <tr className="border-b border-border-primary bg-surface-secondary text-text-tertiary">
            <th className="px-2 py-1.5 font-medium">Variant</th>
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
          {rows.map((r) => (
            <tr key={r.variantId} className="border-b border-border-primary/60 last:border-b-0" data-testid={`experiments-variant-row-${r.variantId}`}>
              <td className="px-2 py-1.5 text-text-primary">
                {r.variantLabel}
                {r.variantStatus === null && <span className="ml-1 text-text-muted">(deleted)</span>}
                {r.lowSample && (
                  <span className="ml-1 text-text-muted" data-testid={`experiments-variant-lowsample-${r.variantId}`}>
                    n&lt;{MIN_VARIANT_RUNS}, provisional
                  </span>
                )}
              </td>
              <td className="px-2 py-1.5 tabular-nums text-text-secondary">{r.runs}</td>
              <td className="px-2 py-1.5 tabular-nums text-text-secondary">{r.successRatePct}%</td>
              <td className="px-2 py-1.5 tabular-nums text-text-secondary">{formatMs(r.avgDurationMs)}</td>
              <td className="px-2 py-1.5 tabular-nums text-text-secondary">{compactTokens(r.avgTotalTokens)}</td>
              <td className="px-2 py-1.5 tabular-nums text-text-secondary">{formatCost(r.avgCostUsd)}</td>
              <td className="px-2 py-1.5 tabular-nums text-text-secondary">{r.avgEvalScore ?? '—'}</td>
              <td className="px-2 py-1.5 tabular-nums text-text-secondary">{r.findingsCount}</td>
              <td className="px-2 py-1.5 tabular-nums text-text-secondary">{r.postMergeBugCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rotation status line (variantsStore, not variantStats — see file header)
// ---------------------------------------------------------------------------

function RotationStatusLine({ workflowId }: { workflowId: string }): React.JSX.Element | null {
  const { variants } = useWorkflowVariants(workflowId);
  const active = variants.filter((v) => v.status === 'active' && v.weight > 0);
  if (active.length === 0) return null;
  return (
    <p className="text-xs text-text-tertiary" data-testid={`experiments-rotation-status-${workflowId}`}>
      In rotation: {active.map((v) => `${v.label} (${v.weight})`).join(' · ')}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Per-workflow variant block (table + rotation line)
// ---------------------------------------------------------------------------

function WorkflowVariantsBlock({
  workflowId,
  workflowName,
  projectFilter,
}: {
  workflowId: string;
  workflowName: string;
  projectFilter: number | null;
}): React.JSX.Element | null {
  const [rows, setRows] = useState<VariantStats[] | null>(null);

  useEffect(() => {
    let alive = true;
    trpc.cyboflow.insights.variantStats
      .query({ workflowId, projectId: projectFilter })
      .then((r) => {
        if (alive) setRows(r);
      })
      .catch(() => {
        if (alive) setRows([]);
      });
    return () => {
      alive = false;
    };
  }, [workflowId, projectFilter]);

  // Never render an empty table — a workflow with no variants shows nothing.
  if (rows !== null && rows.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5" data-testid={`experiments-workflow-block-${workflowId}`}>
      <div className="flex items-baseline gap-2">
        <h4 className="text-sm font-semibold text-text-primary">{workflowName}</h4>
      </div>
      {rows === null ? (
        <p className="text-xs text-text-muted">Loading variant stats…</p>
      ) : (
        <VariantStatsTable workflowName={workflowName} rows={rows} />
      )}
      <RotationStatusLine workflowId={workflowId} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Past experiments — series grouping
// ---------------------------------------------------------------------------

interface SeriesGroup {
  seriesKey: string;
  items: ExperimentSummary[];
}

function groupBySeries(items: ExperimentSummary[]): SeriesGroup[] {
  const byKey = new Map<string, ExperimentSummary[]>();
  for (const it of items) {
    const list = byKey.get(it.seriesKey) ?? [];
    list.push(it);
    byKey.set(it.seriesKey, list);
  }
  return Array.from(byKey.entries()).map(([seriesKey, group]) => ({
    seriesKey,
    // Newest first within a series (listForDashboard already orders createdAt DESC).
    items: group,
  }));
}

/** Winning side per experiment: the human decision when settled, else the judge's verdict. */
function experimentSide(item: ExperimentSummary): 'A' | 'B' | null {
  if (item.decision === 'promote_a') return 'A';
  if (item.decision === 'promote_b') return 'B';
  if (item.decision === 'discard') return null;
  if (item.verdictPreference === 'A' || item.verdictPreference === 'B') return item.verdictPreference;
  return null;
}

function seriesAggregateLabel(group: SeriesGroup): string | null {
  if (group.items.length < 2) return null;
  let aCount = 0;
  let bCount = 0;
  for (const it of group.items) {
    const side = experimentSide(it);
    if (side === 'A') aCount += 1;
    else if (side === 'B') bCount += 1;
  }
  const total = group.items.length;
  if (aCount === bCount) return `No clear preference across ${total} runs`;
  const first = group.items[0];
  const winnerLabel = aCount > bCount ? first.armALabel : first.armBLabel;
  return `${winnerLabel} preferred ${Math.max(aCount, bCount)} of ${total}`;
}

const STATUS_LABEL: Record<ExperimentSummary['status'], string> = {
  running: 'Running',
  grading: 'Grading',
  decided: 'Decided',
  abandoned: 'Abandoned',
};

function ExperimentRow({ item }: { item: ExperimentSummary }): React.JSX.Element {
  const side = experimentSide(item);
  return (
    <button
      type="button"
      data-testid={`experiments-row-${item.experimentId}`}
      onClick={() => useNavigationStore.getState().openExperimentComparison(item.experimentId)}
      className="flex w-full items-center justify-between gap-2 rounded-button px-2 py-1.5 text-left text-xs hover:bg-surface-hover"
    >
      <span className="truncate text-text-secondary">
        {item.armALabel} vs {item.armBLabel}
      </span>
      <span className="flex flex-shrink-0 items-center gap-2 text-text-tertiary">
        {side !== null && (
          <span className="rounded-full border border-border-primary px-1.5 py-px text-[10px] font-medium uppercase">
            {side === 'A' ? item.armALabel : item.armBLabel}
          </span>
        )}
        <span
          className={cn(
            'rounded-full border px-1.5 py-px text-[10px] font-medium uppercase',
            item.status === 'decided'
              ? 'border-status-success/40 text-status-success'
              : item.status === 'abandoned'
                ? 'border-text-tertiary/40 text-text-tertiary'
                : 'border-interactive/40 text-interactive',
          )}
        >
          {STATUS_LABEL[item.status]}
        </span>
        <span>{new Date(item.createdAt).toLocaleDateString()}</span>
      </span>
    </button>
  );
}

function PastExperimentsList({ projectFilter }: { projectFilter: number | null }): React.JSX.Element {
  const [items, setItems] = useState<ExperimentSummary[] | null>(null);
  // Abandoned (torn-down) experiments are hidden by default; the toggle opts them in
  // (includeAbandoned threaded to listForDashboard). Changing it refetches.
  const [showAbandoned, setShowAbandoned] = useState(false);

  useEffect(() => {
    let alive = true;
    trpc.cyboflow.experiments.listForDashboard
      .query({ projectId: projectFilter, includeAbandoned: showAbandoned })
      .then((r) => {
        if (alive) setItems(r);
      })
      .catch(() => {
        if (alive) setItems([]);
      });
    return () => {
      alive = false;
    };
  }, [projectFilter, showAbandoned]);

  const toggle = (
    <label className="flex cursor-pointer select-none items-center gap-1.5 text-xs text-text-tertiary">
      <input
        type="checkbox"
        checked={showAbandoned}
        onChange={(e) => setShowAbandoned(e.target.checked)}
        className="rounded border-border-primary"
        data-testid="experiments-show-abandoned-toggle"
      />
      <span>Show abandoned</span>
    </label>
  );

  let body: React.JSX.Element;
  if (items === null) {
    body = <p className="text-xs text-text-muted">Loading experiments…</p>;
  } else if (items.length === 0) {
    body = <p className="text-xs text-text-muted">No A/B experiments have been run yet.</p>;
  } else {
    const groups = groupBySeries(items);
    body = (
      <div className="flex flex-col gap-3" data-testid="experiments-past-list">
        {groups.map((group) => {
          const aggregate = seriesAggregateLabel(group);
          return (
            <div key={group.seriesKey} className="rounded-card border border-border-primary" data-testid={`experiments-series-${group.seriesKey}`}>
              {aggregate !== null && (
                <div className="border-b border-border-primary bg-surface-secondary px-2 py-1 text-[11px] font-medium text-text-tertiary" data-testid={`experiments-series-aggregate-${group.seriesKey}`}>
                  {aggregate}
                </div>
              )}
              <div className="divide-y divide-border-primary/60">
                {group.items.map((it) => (
                  <ExperimentRow key={it.experimentId} item={it} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-end" data-testid="experiments-show-abandoned">
        {toggle}
      </div>
      {body}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section root
// ---------------------------------------------------------------------------

export function ExperimentsSection(): React.JSX.Element {
  const workflowStats = useInsightsStore((s) => s.workflowStats);
  const projectFilter = useInsightsStore((s) => s.projectFilter);

  // Distinct (workflowId, workflowName) pairs, stable order (workflowStats is
  // already deduped per workflow by the shared store's fan-out).
  const workflows = Array.from(new Map(workflowStats.map((w) => [w.workflowId, w.workflowName])).entries());

  return (
    <div className="flex flex-col gap-5" data-testid="experiments-section">
      <div className="flex items-baseline gap-2">
        <span className="eyebrow text-text-tertiary">04</span>
        <h3 className="text-base font-bold text-text-primary">Experiments</h3>
      </div>

      {workflows.length === 0 ? (
        <p className="text-xs text-text-muted">No workflow activity yet.</p>
      ) : (
        <div className="flex flex-col gap-4">
          {workflows.map(([workflowId, workflowName]) => (
            <WorkflowVariantsBlock
              key={workflowId}
              workflowId={workflowId}
              workflowName={workflowName}
              projectFilter={projectFilter}
            />
          ))}
        </div>
      )}

      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-semibold text-text-primary">Past experiments</h4>
        <PastExperimentsList projectFilter={projectFilter} />
      </div>
    </div>
  );
}
