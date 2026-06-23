/**
 * PhaseRibbon — a PURELY PRESENTATIONAL phase ribbon for a workflow definition.
 *
 * Unlike {@link FlowProgress} (landing/FlowProgress.tsx), this component takes
 * NO runId, opens NO subscription, and carries NO filled/current state — so a
 * gallery of N cards renders N ribbons WITHOUT opening N phase subscriptions.
 *
 * It also FIXES the equal-width segment bug in FlowProgress (which uses
 * `flex-1`, giving every phase the same width regardless of step count): here
 * each segment's `flexGrow` is `max(1, phase.steps.length)` with `flexBasis: 0`,
 * so a 3-step phase renders 3x as wide as a 1-step phase.
 *
 * Each segment is filled with the LITERAL phase hex (`phase.color`) via inline
 * style — per the design contract phase fills are never tokens. The label is an
 * uppercase abbreviation derived from `phase.label`. `thin` renders an 8px-tall
 * label-less bar (for dense rows / stacked previews).
 */
import type { WorkflowDefinition } from '../../../../shared/types/workflows';

export interface PhaseRibbonProps {
  /** The workflow definition whose phases are rendered. */
  definition: WorkflowDefinition;
  /** When true, render an 8px-tall label-less bar instead of labelled segments. */
  thin?: boolean;
}

/**
 * Map a phase label to its short uppercase ribbon abbreviation. Unknown labels
 * fall back to the first 5 chars of the uppercased label.
 */
function phaseAbbrev(label: string): string {
  const key = label.trim().toLowerCase();
  switch (key) {
    case 'plan':
      return 'PLAN';
    case 'refine':
      return 'REFINE';
    case 'execute':
      return 'EXEC';
    case 'review':
    case 'sprint review':
      return 'REVIEW';
    case 'sprint plan':
      return 'SPLAN';
    case 'materialize':
      return 'MATL';
    case 'compound':
      return 'COMP';
    case 'prune':
      return 'PRUNE';
    default:
      return label.toUpperCase().slice(0, 5);
  }
}

export function PhaseRibbon({ definition, thin }: PhaseRibbonProps): React.JSX.Element {
  if (thin === true) {
    return (
      <div className="flex w-full items-stretch gap-0.5" style={{ height: '8px' }}>
        {definition.phases.map((phase) => (
          <div
            key={phase.id}
            style={{
              flexGrow: Math.max(1, phase.steps.length),
              flexBasis: 0,
              backgroundColor: phase.color,
            }}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="flex w-full items-end gap-1">
      {definition.phases.map((phase) => (
        <div
          key={phase.id}
          className="flex min-w-0 flex-col gap-1"
          style={{ flexGrow: Math.max(1, phase.steps.length), flexBasis: 0 }}
        >
          {/* Phase bar — literal hex fill (never a token, per the contract). */}
          <div className="h-1" style={{ backgroundColor: phase.color }} />
          {/* Phase abbreviation label. */}
          <span
            className="eyebrow truncate text-text-tertiary"
            style={{ fontSize: '8px' }}
          >
            {phaseAbbrev(phase.label)}
          </span>
        </div>
      ))}
    </div>
  );
}
