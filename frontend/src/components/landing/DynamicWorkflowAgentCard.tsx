/**
 * DynamicWorkflowAgentCard — a session-hosted Claude Code dynamic workflow
 * (the Workflow tool / ultracode) on the landing home.
 *
 * Visually a sibling of {@link ActiveAgentCard} (same square-corner chrome,
 * pulsing status dot, eyebrow chip, "now line"), but driven by the passively
 * detected {@link DynamicWorkflowRunState} instead of an ActiveRunRow:
 *   - title row: session name + workflow name + a "dynamic workflow" type chip,
 *   - a compact phase-plan line (static phase titles from the script meta —
 *     journal lines carry no phase attribution, so there is no live stepper),
 *   - a "now line": live agent tally ("N running · M done" from journal.jsonl)
 *     · elapsed · Open → link.
 *
 * Elapsed time reuses the ActiveAgentCard pattern: recomputed each render
 * against a wall-clock counter bumped on a ~30s interval (cleared on unmount);
 * formatElapsed owns the formatting and the caller owns the clock.
 *
 * Open → selects the HOSTING SESSION, mirroring the rail's session-row click
 * (DraggableProjectTreeView.handleSessionClick): setActiveQuickSession with the
 * hosting run id (the `__quick__` sentinel run for quick sessions) so the
 * approval subscription starts, then flip to the session surface. Routing
 * through setActiveRun would throw on the sentinel in getPhaseState.
 */
import { useEffect, useMemo, useState } from 'react';
import type { DynamicWorkflowRunState } from '../../../../shared/types/dynamicWorkflows';
import { formatElapsed } from '../../utils/homeClassify';
import { DynamicWorkflowAgents } from '../cyboflow/DynamicWorkflowAgents';
import { useCyboflowStore } from '../../stores/cyboflowStore';
import { useNavigationStore } from '../../stores/navigationStore';

/** Wall-clock refresh cadence for the elapsed counter. */
const ELAPSED_TICK_MS = 30_000;

export interface DynamicWorkflowAgentCardProps {
  state: DynamicWorkflowRunState;
}

function openWorkflowSession(state: DynamicWorkflowRunState): void {
  useCyboflowStore.getState().setActiveQuickSession(state.sessionId, state.runId);
  useNavigationStore.getState().setActiveProjectId(state.projectId);
  useNavigationStore.getState().goToSession();
}

export function DynamicWorkflowAgentCard({ state }: DynamicWorkflowAgentCardProps): React.JSX.Element {
  // Expand toggle (the ▸ in the now line) — reveals the full live workflow state
  // (stage-bucketed agents) inline, without leaving the review queue.
  const [expanded, setExpanded] = useState<boolean>(false);

  // Wall-clock counter — bumps every ~30s so elapsed re-renders without a
  // per-second timer. formatElapsed reads the current epoch-ms each render.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), ELAPSED_TICK_MS);
    return () => clearInterval(id);
  }, []);

  // Live agent tally from journal.jsonl-derived lifecycles.
  const { runningCount, doneCount } = useMemo(() => {
    let running = 0;
    for (const agent of state.agents) {
      if (agent.status === 'running') running += 1;
    }
    return { runningCount: running, doneCount: state.agents.length - running };
  }, [state.agents]);

  // Compact phase plan — static titles from the script meta, joined.
  const phasePlan = useMemo(() => {
    if (state.phases.length === 0) return null;
    return state.phases.map((phase) => phase.title).join(' → ');
  }, [state.phases]);

  const elapsed = formatElapsed(state.startedAt, nowMs);

  return (
    <div className="border border-border-primary bg-surface-primary p-3 transition-colors hover:border-border-emphasized">
      {/* Title row */}
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-interactive animate-pulse motion-reduce:animate-none"
        />
        <span
          className="truncate font-bold text-text-primary"
          style={{ fontSize: '13px' }}
          title={`${state.sessionName} · ${state.name}`}
        >
          {state.sessionName}
        </span>
        <span className="truncate text-text-secondary" style={{ fontSize: '12px' }} title={state.name}>
          {state.name}
        </span>
        <span className="eyebrow ml-auto shrink-0 border border-border-emphasized px-1.5 py-0.5 text-text-tertiary">
          dynamic workflow
        </span>
      </div>

      {/* Compact phase plan (static — no live phase attribution in the journal) */}
      {phasePlan !== null && (
        <div className="mt-3 truncate text-text-tertiary" style={{ fontSize: '11px' }} title={phasePlan}>
          {phasePlan}
        </div>
      )}

      {/* Now line — the ▸ toggles the inline expanded workflow state. */}
      <div className="mt-3 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-text-tertiary" style={{ fontSize: '11px' }}>
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          className="flex items-center gap-1 truncate text-text-secondary hover:text-text-primary"
          title={expanded ? 'Hide agents' : 'Show agents'}
          data-testid="dynamic-workflow-card-toggle"
        >
          <span aria-hidden="true" style={{ fontSize: 9 }}>
            {expanded ? '▾' : '▸'}
          </span>
          <span className="font-bold text-text-primary">
            {runningCount} running · {doneCount} done
          </span>
        </button>
        <span>{elapsed}</span>
        <button
          type="button"
          onClick={() => openWorkflowSession(state)}
          className="eyebrow ml-auto shrink-0 text-text-tertiary hover:text-interactive"
        >
          Open →
        </button>
      </div>

      {/* Expanded workflow state — stage-bucketed (or flat) live agent list. */}
      {expanded && <DynamicWorkflowAgents state={state} nowMs={nowMs} />}
    </div>
  );
}
