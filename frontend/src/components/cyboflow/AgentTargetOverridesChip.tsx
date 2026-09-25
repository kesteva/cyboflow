/**
 * AgentTargetOverridesChip — a one-line notice above {@link RunPendingInputStrip}'s
 * pending items, surfacing the run-scoped agent-target overrides written by a
 * systemic-pause "Switch runtime & retry" ({@link SystemicPauseSwitchForm}, plan
 * v2 D3/D4). Hidden entirely when the run carries none.
 *
 * Re-queries `runs.runAgentTargets` on mount, whenever the run's PENDING
 * review items change (a new pause, or the pause clearing, can mean a fresh or
 * cleared override set — piggybacking on the SAME `useReviewItemsSlice`
 * subscription `RunPendingInputStrip` already keeps alive, rather than opening
 * a second one), and whenever the run's override layer is bumped in
 * runAgentTargetsStore (a switch or revert landed). Its own Revert bumps that
 * store too, so the canvas step cards drop back to the launch-time models.
 * Several agent keys pinned to the identical target are grouped onto one line;
 * distinct targets each get their own.
 */
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { useReviewItemsSlice, pendingReviewItemsForRun } from '../../stores/reviewItemsSlice';
import { useRunAgentTargetsStore, useRunAgentTargetsVersion } from '../../stores/runAgentTargetsStore';
import { trpc } from '../../trpc/client';
import { Button } from '../ui/Button';
import { WORKFLOW_AGENT_RUNTIME_LABELS } from '../../../../shared/types/agentRuntime';
import type { RunAgentTarget, RunAgentTargetOverrides } from '../../../../shared/types/workflows';

interface AgentTargetOverridesChipProps {
  runId: string;
  /**
   * True when the chip is the ONLY thing the strip renders (nothing pending):
   * it then carries the strip's own top border + background so it still reads
   * as a footer strip, instead of the divider it draws above a pending list.
   */
  standalone?: boolean;
}

/** One line's worth of grouped agent keys sharing an identical target. */
interface TargetGroup {
  keys: string[];
  target: RunAgentTarget;
}

/** Group `overrides`' entries by identical (runtime, model, providerModel, effort). */
function groupOverrides(overrides: RunAgentTargetOverrides): TargetGroup[] {
  const bySignature = new Map<string, TargetGroup>();
  for (const [agentKey, target] of Object.entries(overrides)) {
    const signature = JSON.stringify([
      target.runtime ?? null,
      target.model ?? null,
      target.providerModel ?? null,
      target.effort ?? null,
    ]);
    const existing = bySignature.get(signature);
    if (existing) {
      existing.keys.push(agentKey);
    } else {
      bySignature.set(signature, { keys: [agentKey], target });
    }
  }
  return Array.from(bySignature.values());
}

/** "implement, code-review → Codex SDK (gpt-5.6-sol)" for one group. */
function groupPhrase(group: TargetGroup): string {
  const runtimeLabel = group.target.runtime ? WORKFLOW_AGENT_RUNTIME_LABELS[group.target.runtime] : 'same runtime';
  const modelLabel = group.target.model ?? group.target.providerModel ?? null;
  return `${group.keys.join(', ')} → ${runtimeLabel}${modelLabel ? ` (${modelLabel})` : ''}`;
}

export function AgentTargetOverridesChip({ runId, standalone = false }: AgentTargetOverridesChipProps): ReactElement | null {
  const items = useReviewItemsSlice((s) => s.items);
  const pendingItems = useMemo(() => pendingReviewItemsForRun(items, runId), [items, runId]);

  const agentTargetsVersion = useRunAgentTargetsVersion(runId);

  const [overrides, setOverrides] = useState<RunAgentTargetOverrides | null>(null);
  const [reverting, setReverting] = useState(false);

  const refetch = useCallback((): void => {
    void trpc.cyboflow.runs.runAgentTargets
      .query({ runId })
      .then((result) => { setOverrides(result); })
      .catch(() => { setOverrides(null); });
  }, [runId]);

  useEffect(() => {
    refetch();
    // Re-query on mount AND whenever this run's pending items change (a fresh
    // pause opening, or one clearing, is exactly when the override set could
    // have changed) AND whenever the override layer is bumped — `refetch`
    // itself only depends on `runId`, so it is omitted here to keep the
    // dependency to those two signals.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingItems, agentTargetsVersion]);

  const handleRevert = (): void => {
    setReverting(true);
    void trpc.cyboflow.runs.clearRunAgentTargets
      .mutate({ runId })
      .then(() => {
        // Bumping re-runs the effect above (this chip's own re-query) and the
        // canvas's `runs.getStepModels` re-fetch in RunCenterPane.
        useRunAgentTargetsStore.getState().bump(runId);
      })
      .finally(() => { setReverting(false); });
  };

  if (overrides === null || Object.keys(overrides).length === 0) return null;

  const groups = groupOverrides(overrides);

  return (
    <div
      className={
        standalone
          ? 'flex-shrink-0 flex flex-wrap items-center gap-2 border-t border-border-primary bg-bg-secondary px-4 py-1.5 text-xs text-text-secondary'
          : 'flex flex-wrap items-center gap-2 border-b border-border-primary px-4 py-1.5 text-xs text-text-secondary'
      }
      data-testid="agent-targets-chip"
      data-standalone={standalone ? 'true' : undefined}
    >
      <span>
        Agents switched: {groups.map(groupPhrase).join('; ')}
      </span>
      <Button variant="ghost" size="sm" disabled={reverting} onClick={handleRevert} data-testid="agent-targets-revert">
        Revert
      </Button>
    </div>
  );
}
