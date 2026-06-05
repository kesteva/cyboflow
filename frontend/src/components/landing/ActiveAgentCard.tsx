/**
 * ActiveAgentCard — a single in-flight workflow run on the landing home.
 *
 * Card chrome (square corners, hairline border that warms on hover) wrapping:
 *   - a pulsing rust status dot + the workflow name + a workflow-id chip,
 *   - the horizontal phase stepper ({@link FlowProgress}),
 *   - a "now line": branch · current step · elapsed · (model) · Open → link.
 *
 * Elapsed time is recomputed each render against a wall-clock counter that bumps
 * on a ~30s interval (cleared on unmount) — formatElapsed owns the formatting and
 * the caller owns the clock so it stays deterministic/testable.
 *
 * The model is shown ONLY when this run is the active run in {@link useCyboflowStore}
 * (so the stream-event log is live for it); it is read from the first system/init
 * event. For any other run the model is omitted rather than fabricated.
 *
 * Hooks discipline: this renders exactly one {@link FlowProgress}, which opens a
 * single phase subscription per card. Never render this inside a loop body that
 * would call hooks conditionally.
 */
import { useEffect, useMemo, useState } from 'react';
import { useWorkflowPhaseState } from '../../hooks/useWorkflowPhaseState';
import { formatElapsed } from '../../utils/homeClassify';
import { useCyboflowStore } from '../../stores/cyboflowStore';
import { useNavigationStore } from '../../stores/navigationStore';
import type { ActiveRunRow } from '../../stores/activeRunsStore';
import type { StreamEvent } from '../../utils/cyboflowApi';
import { FlowProgress } from './FlowProgress';

/** Wall-clock refresh cadence for the elapsed counter. */
const ELAPSED_TICK_MS = 30_000;

export interface ActiveAgentCardProps {
  run: ActiveRunRow;
  projectName: string;
}

/**
 * Pull the model name from the first system/init stream event in the log, or
 * null when none has arrived. Narrows the discriminated StreamEvent union — no
 * casts, no `any`.
 */
function findInitModel(events: StreamEvent[]): string | null {
  for (const event of events) {
    if (event.type === 'system' && event.payload.subtype === 'init') {
      return event.payload.model;
    }
  }
  return null;
}

function openRunSession(run: ActiveRunRow): void {
  useCyboflowStore.getState().setActiveRun(run.id);
  useNavigationStore.getState().setActiveProjectId(run.project_id);
  useNavigationStore.getState().goToSession();
}

export function ActiveAgentCard({ run, projectName }: ActiveAgentCardProps): React.JSX.Element {
  const { definition, currentStepId } = useWorkflowPhaseState(run.id);

  // Wall-clock counter — bumps every ~30s so elapsed re-renders without a
  // per-second timer. formatElapsed reads the current epoch-ms each render.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), ELAPSED_TICK_MS);
    return () => clearInterval(id);
  }, []);

  // Model: only when THIS run is the active run (its stream log is live).
  const activeRunId = useCyboflowStore((s) => s.activeRunId);
  const streamEvents = useCyboflowStore((s) => s.streamEvents);
  const model = useMemo(() => {
    if (activeRunId !== run.id) return null;
    return findInitModel(streamEvents);
  }, [activeRunId, run.id, streamEvents]);

  // Current step display name — find the step whose id matches currentStepId
  // across every phase in the resolved definition.
  const currentStepName = useMemo(() => {
    if (definition === null || currentStepId === null) return null;
    for (const phase of definition.phases) {
      for (const step of phase.steps) {
        if (step.id === currentStepId) return step.name;
      }
    }
    return null;
  }, [definition, currentStepId]);

  const elapsed = formatElapsed(run.started_at, nowMs);

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
          title={`${run.workflowName} · ${projectName}`}
        >
          {run.workflowName}
        </span>
        <span className="eyebrow ml-auto shrink-0 border border-border-emphasized px-1.5 py-0.5 text-text-tertiary">
          {run.workflowName}
        </span>
      </div>

      {/* Horizontal phase stepper */}
      <div className="mt-3">
        <FlowProgress runId={run.id} workflowName={run.workflowName} />
      </div>

      {/* Now line */}
      <div className="mt-3 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-text-tertiary" style={{ fontSize: '11px' }}>
        {run.branch_name !== null && (
          <span className="truncate text-status-success" title={run.branch_name}>
            ⌥ {run.branch_name}
          </span>
        )}
        {currentStepName !== null && (
          <span className="truncate text-text-secondary">
            ▸ <span className="font-bold text-text-primary">{currentStepName}</span>
          </span>
        )}
        <span>{elapsed}</span>
        {model !== null && <span className="truncate">{model}</span>}
        <button
          type="button"
          onClick={() => openRunSession(run)}
          className="eyebrow ml-auto shrink-0 text-text-tertiary hover:text-interactive"
        >
          Open →
        </button>
      </div>
    </div>
  );
}
