/**
 * FlowProgress — the horizontal phase stepper for a single active run.
 *
 * Renders one equal-width segment per workflow PHASE: a thin colored bar above a
 * tiny uppercase phase label. Bars up to and including the current phase are
 * filled with the LITERAL phase hex from the workflow definition (inline style,
 * never a token — per the design contract); the current phase's bar gets a soft
 * ring and its label goes bold. Phases beyond the current one show a faint muted
 * bar. No animation here (the live pulse lives on the run's status dot).
 *
 * Phase state is read live via {@link useWorkflowPhaseState}. When the live
 * definition has not resolved yet, we fall back to the static
 * {@link resolveWorkflowDefinition} so the stepper renders immediately from the
 * built-in (or persisted spec_json) definition.
 *
 * Self-contained except for the runId/workflowName/specJson props the parent
 * card supplies. Hooks discipline: this opens exactly one phase subscription, so
 * it must be rendered once per card — never inside a loop.
 */
import { useWorkflowPhaseState } from '../../hooks/useWorkflowPhaseState';
import { derivePhaseFill } from '../../utils/homeClassify';
import { resolveWorkflowDefinition } from '../../../../shared/types/workflows';

/** Faint muted fill for phases that have not been reached yet. */
const UNFILLED_BAR_COLOR = '#d8cfb8';

export interface FlowProgressProps {
  /** The workflow_runs.id whose live phase state drives the stepper. */
  runId: string;
  /** Human-readable workflow name, used for the static fallback definition. */
  workflowName: string;
  /** Optional JSON-encoded WorkflowDefinition override (edited/custom flows). */
  specJson?: string | null;
}

export function FlowProgress({ runId, workflowName, specJson }: FlowProgressProps): React.JSX.Element | null {
  const { definition: liveDefinition, currentStepId } = useWorkflowPhaseState(runId);

  // Prefer the live definition; fall back to the static resolver so the stepper
  // is populated before the phase-state query resolves.
  const definition = liveDefinition ?? resolveWorkflowDefinition(workflowName, specJson ?? null);

  const segments = derivePhaseFill(definition, currentStepId);
  if (segments.length === 0) return null;

  return (
    <div className="flex w-full items-end gap-1">
      {segments.map((seg) => (
        <div key={seg.phaseId} className="flex min-w-0 flex-1 flex-col gap-1">
          {/* Phase bar — literal hex when filled, faint muted otherwise. */}
          <div
            className="h-1"
            style={{
              backgroundColor: seg.filled ? seg.color : UNFILLED_BAR_COLOR,
              boxShadow: seg.current ? `0 0 0 2px ${seg.color}33` : undefined,
            }}
          />
          {/* Phase label — bold + primary on the current phase, faint otherwise. */}
          <span
            className={`eyebrow truncate ${
              seg.current ? 'font-bold text-text-primary' : 'text-text-tertiary'
            }`}
            style={{ fontSize: '8px' }}
          >
            {seg.label}
          </span>
        </div>
      ))}
    </div>
  );
}
