/**
 * DynamicWorkflowPanel — one detected Claude Code dynamic workflow (the
 * in-session Workflow tool / `ultracode`), rendered from a tracked
 * {@link DynamicWorkflowRunState} snapshot. Purely presentational — the
 * caller (QuickSessionCanvas) owns store wiring.
 *
 * Card chrome mirrors ActiveAgentCard (square corners, hairline border):
 *   - title row: pulsing rust dot while running (✓ / ✕ when terminal) + the
 *     workflow name + an uppercase status chip,
 *   - description (when the script meta carries one),
 *   - the static phase PLAN as chips — journal lines carry no phase
 *     attribution, so this is explicitly a plan, never per-phase progress,
 *   - a live line: agent tally ("N running · M done" from state.agents) and
 *     elapsed time while running (~30s wall-clock ticker, cleared on unmount —
 *     same pattern as ActiveAgentCard),
 *   - when terminal: the completion summary + totals (agents / tokens / tool
 *     calls / duration) from the wf_<id>.json record.
 *
 * `expanded` (canvas-takeover variant, default false) additionally renders one
 * row per subagent, modeled on the CLI's own TUI workflow view: status glyph,
 * display name, model, output tokens, tool count and idle/elapsed hints. Every
 * per-agent field beyond {agentId, status} is OPTIONAL — an older main build
 * (or the race before the first transcript parse) sends bare agents, and the
 * row degrades to a glyph + "agent N" + an em-dash. Agent labels do NOT exist
 * on disk, so display names fall back to each agent's prompt excerpt with the
 * longest shared prologue stripped (see computeAgentDisplayNames).
 */
import { useEffect, useState } from 'react';
import { formatElapsed } from '../../utils/homeClassify';
import {
  DynamicWorkflowAgents,
  formatDurationMs,
} from './DynamicWorkflowAgents';
import type { DynamicWorkflowRunState } from '../../../../shared/types/dynamicWorkflows';

// formatModelName + computeAgentDisplayNames live in DynamicWorkflowAgents (the
// shared agent-row module); re-exported here for existing importers/tests.
export { formatModelName, computeAgentDisplayNames } from './DynamicWorkflowAgents';

/** Wall-clock refresh cadence for the elapsed counter (matches ActiveAgentCard). */
const ELAPSED_TICK_MS = 30_000;

/**
 * Coarser-grained but still-live cadence for the expanded variant — drives the
 * per-agent idle hints, which need finer resolution than the 30s elapsed tick.
 */
const EXPANDED_TICK_MS = 5_000;

/** Status → accent color (paper-theme CSS vars, matching the app's badges). */
const STATUS_COLOR: Record<DynamicWorkflowRunState['status'], string> = {
  running: 'var(--color-phase-execute)',
  completed: 'var(--color-status-success)',
  failed: 'var(--color-status-error)',
};

/** One totals cell — value over a wide-tracked micro-label (StatCell shape). */
function TotalCell({ value, label, testId }: { value: string; label: string; testId: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span
        data-testid={testId}
        style={{
          fontSize: 12,
          fontWeight: 700,
          color: 'var(--color-text-primary)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </span>
      <span
        style={{
          fontSize: 8.5,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--color-text-tertiary)',
          fontWeight: 700,
        }}
      >
        {label}
      </span>
    </div>
  );
}

export interface DynamicWorkflowPanelProps {
  state: DynamicWorkflowRunState;
  /**
   * Canvas-takeover variant: adds per-agent rows below the live line and
   * tightens the wall-clock tick to drive their idle hints. Default false —
   * the compact card rendering is unchanged.
   */
  expanded?: boolean;
  /**
   * When provided AND the run is terminal, renders a dismiss "×" in the title
   * row that calls this (the caller fires the dynamicWorkflows.dismiss
   * mutation). Omitted while running — a live run has no dismiss affordance.
   */
  onDismiss?: () => void;
}

export function DynamicWorkflowPanel({
  state,
  expanded = false,
  onDismiss,
}: DynamicWorkflowPanelProps): React.JSX.Element {
  const isRunning = state.status === 'running';
  const accent = STATUS_COLOR[state.status];

  // Wall-clock counter — bumps every ~30s so elapsed re-renders without a
  // per-second timer (ActiveAgentCard pattern). Only ticks while running;
  // the expanded variant ticks coarsely-but-faster for the agent idle hints.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!isRunning) return;
    const id = setInterval(
      () => setNowMs(Date.now()),
      expanded ? EXPANDED_TICK_MS : ELAPSED_TICK_MS,
    );
    return () => clearInterval(id);
  }, [isRunning, expanded]);

  const runningAgents = state.agents.filter((a) => a.status === 'running').length;
  const doneAgents = state.agents.filter((a) => a.status === 'done').length;

  return (
    <div
      className="border border-border-primary bg-surface-primary p-3 transition-colors hover:border-border-emphasized"
      data-testid={`dynamic-workflow-panel-${state.wfRunId}`}
    >
      {/* Title row */}
      <div className="flex items-center gap-2">
        {isRunning ? (
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 shrink-0 rounded-full animate-pulse motion-reduce:animate-none"
            style={{ background: accent }}
          />
        ) : (
          <span aria-hidden="true" className="shrink-0" style={{ color: accent, fontSize: 11 }}>
            {state.status === 'completed' ? '✓' : '✕'}
          </span>
        )}
        <span
          className="truncate font-bold text-text-primary"
          style={{ fontSize: '13px' }}
          title={state.name}
          data-testid="dynamic-workflow-name"
        >
          {state.name}
        </span>
        <span className="eyebrow shrink-0 text-text-tertiary">dynamic workflow</span>
        <span
          className={`eyebrow shrink-0 px-1.5 py-0.5${onDismiss && !isRunning ? '' : ' ml-auto'}`}
          style={{ color: accent, border: `1px solid ${accent}` }}
          data-testid="dynamic-workflow-status"
        >
          {state.status}
        </span>
        {onDismiss && !isRunning && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss workflow"
            title="Dismiss"
            className="ml-auto shrink-0 rounded p-0.5 leading-none text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-primary"
            data-testid="dynamic-workflow-dismiss"
          >
            <span aria-hidden="true" style={{ fontSize: 13, lineHeight: 1 }}>
              ✕
            </span>
          </button>
        )}
      </div>

      {/* Description (script meta, when present) */}
      {state.description !== undefined && state.description.length > 0 && (
        <p
          className="mt-1.5 text-text-secondary"
          style={{ fontSize: '11px', lineHeight: 1.45 }}
          data-testid="dynamic-workflow-description"
        >
          {state.description}
        </p>
      )}

      {/* Phase PLAN — static chips. Journal lines carry no phase attribution,
          so there is deliberately no per-phase progress here. */}
      {state.phases.length > 0 && (
        <div className="mt-2.5" data-testid="dynamic-workflow-phases">
          <span className="eyebrow text-text-tertiary">plan</span>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {state.phases.map((phase, i) => (
              <span
                key={`${i}-${phase.title}`}
                className="border border-border-primary px-1.5 py-0.5 text-text-secondary"
                style={{ fontSize: '10px' }}
                title={phase.detail}
              >
                {i + 1} · {phase.title}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Live line — agent tally + elapsed while running */}
      <div
        className="mt-2.5 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-text-tertiary"
        style={{ fontSize: '11px' }}
      >
        <span data-testid="dynamic-workflow-agent-tally">
          <span className="font-bold" style={{ color: runningAgents > 0 ? accent : undefined }}>
            {runningAgents} running
          </span>{' '}
          · <span className="font-bold text-text-secondary">{doneAgents} done</span>
        </span>
        {isRunning && (
          <span data-testid="dynamic-workflow-elapsed">{formatElapsed(state.startedAt, nowMs)}</span>
        )}
      </div>

      {/* Per-agent rows — expanded (takeover) variant only. Stage-bucketed when
          agents map cleanly to the phase plan, else a flat list. */}
      {expanded && <DynamicWorkflowAgents state={state} nowMs={nowMs} />}

      {/* Terminal block — summary + totals from the wf_<id>.json record */}
      {!isRunning && (
        <div className="mt-2.5 border-t border-border-primary pt-2.5">
          {state.summary !== undefined && state.summary.length > 0 && (
            <p
              className="text-text-secondary"
              style={{ fontSize: '11px', lineHeight: 1.45 }}
              data-testid="dynamic-workflow-summary"
            >
              {state.summary}
            </p>
          )}
          {state.totals !== undefined && (
            <div
              className="mt-2 flex flex-wrap gap-x-5 gap-y-2"
              data-testid="dynamic-workflow-totals"
            >
              {state.totals.agentCount !== undefined && (
                <TotalCell
                  value={String(state.totals.agentCount)}
                  label="agents"
                  testId="dynamic-workflow-total-agents"
                />
              )}
              {state.totals.totalTokens !== undefined && (
                <TotalCell
                  value={state.totals.totalTokens.toLocaleString()}
                  label="tokens"
                  testId="dynamic-workflow-total-tokens"
                />
              )}
              {state.totals.totalToolCalls !== undefined && (
                <TotalCell
                  value={state.totals.totalToolCalls.toLocaleString()}
                  label="tool calls"
                  testId="dynamic-workflow-total-tools"
                />
              )}
              {state.totals.durationMs !== undefined && (
                <TotalCell
                  value={formatDurationMs(state.totals.durationMs)}
                  label="duration"
                  testId="dynamic-workflow-total-duration"
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
