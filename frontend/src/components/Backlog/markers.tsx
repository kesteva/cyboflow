/**
 * Small presentational marks rendered on backlog cards / list rows:
 *   - TypeTag      (idea | epic | task)
 *   - PriorityTag  (P0 | P1 | P2)
 *   - FlowMarker   (terracotta pulsing dot + "agent · session") — MULTIPLE per
 *                  card when a task has parallel runs (inFlow.length > 1)
 *   - ReviewMarker (gold person glyph "Awaiting review")
 *   - DoneFlag     (green "Merged")
 *
 * Colors map the Protoflow design hex to the EXISTING semantic theme tokens in
 * styles/tokens/colors.css: terracotta → --color-interactive-primary,
 * gold → --color-status-warning, green → --color-status-success.
 *
 * The breathing-glow on an in-flight card honours prefers-reduced-motion via
 * the `motion-reduce:` Tailwind variant (drops the pulse animation).
 */
import { User } from 'lucide-react';
import type { FlowOverlay, Priority, TaskType } from '../../../../shared/types/tasks';

const TYPE_LABEL: Record<TaskType, string> = {
  idea: 'Idea',
  epic: 'Epic',
  task: 'Task',
};

export function TypeTag({ type }: { type: TaskType }): React.JSX.Element {
  return (
    <span className="eyebrow rounded-[3px] border border-border-primary bg-bg-tertiary px-1.5 py-px text-text-secondary">
      {TYPE_LABEL[type]}
    </span>
  );
}

const PRIORITY_CLASS: Record<Priority, string> = {
  // P0 = highest urgency (warm-red error token), P1 = warning, P2 = neutral.
  P0: 'border-status-error/40 bg-status-error/10 text-status-error',
  P1: 'border-status-warning/40 bg-status-warning/10 text-status-warning',
  P2: 'border-border-primary bg-bg-tertiary text-text-tertiary',
};

export function PriorityTag({ priority }: { priority: Priority }): React.JSX.Element {
  return (
    <span
      className={`eyebrow rounded-[3px] border px-1.5 py-px ${PRIORITY_CLASS[priority]}`}
      title={`Priority ${priority}`}
    >
      {priority}
    </span>
  );
}

/**
 * One FlowMarker per active run. Renders a pulsing terracotta dot and the
 * resolved "agent · session" label. The session label is the short run id.
 */
export function FlowMarker({ flow }: { flow: FlowOverlay }): React.JSX.Element {
  const session = flow.runId.slice(0, 8);
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-interactive/40 bg-interactive-surface px-2 py-0.5 text-[10px] font-semibold text-interactive"
      title={`In flow: ${flow.agent} · ${session}`}
      data-testid="flow-marker"
    >
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-interactive opacity-60 motion-reduce:hidden" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-interactive" />
      </span>
      <span className="truncate">
        {flow.agent} · {session}
      </span>
    </span>
  );
}

export function ReviewMarker(): React.JSX.Element {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-status-warning/40 bg-status-warning/10 px-2 py-0.5 text-[10px] font-semibold text-status-warning"
      title="Awaiting review"
      data-testid="review-marker"
    >
      <User className="h-3 w-3" strokeWidth={2} />
      Awaiting review
    </span>
  );
}

export function DoneFlag(): React.JSX.Element {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-status-success/40 bg-status-success/10 px-2 py-0.5 text-[10px] font-semibold text-status-success"
      title="Merged"
      data-testid="done-flag"
    >
      Merged
    </span>
  );
}
