/**
 * Small presentational marks rendered on backlog cards / list rows:
 *   - TypeTag      (idea | epic | task)
 *   - PriorityTag  (P0 | P1 | P2)
 *   - CategoryTag  (feature | bug | chore — migration 059)
 *   - ScopeTag     (S = small, L = large — idea scope hint; hidden when unset)
 *   - ArchivedChip (neutral "Archived" — archive-in-place items, only visible
 *                  while the header Archived toggle is on)
 *   - ProjectChip  (project name — cross-project "All projects" view only)
 *   - FlowMarker   (terracotta dot + "agent · session") — MULTIPLE per card
 *                  when a task has parallel runs / batch lanes (inFlow.length
 *                  > 1). The dot only PULSES while the run is actually
 *                  'running' — a live but non-running association (queued,
 *                  awaiting_review, …) renders it static.
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
import { User, Bug, Sparkles, Wrench } from 'lucide-react';
import type { EntityCategory, FlowOverlay, IdeaScope, Priority, TaskType } from '../../../../shared/types/tasks';

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

const CATEGORY_LABEL: Record<EntityCategory, string> = {
  feature: 'Feature',
  bug: 'Bug',
  chore: 'Chore',
};

const CATEGORY_ICON: Record<EntityCategory, typeof Bug> = {
  feature: Sparkles,
  bug: Bug,
  chore: Wrench,
};

const CATEGORY_CLASS: Record<EntityCategory, string> = {
  // bug = attention-grabbing error-red token; chore/feature stay neutral so the
  // priority tag remains the primary urgency signal.
  bug: 'border-status-error/40 bg-status-error/10 text-status-error',
  chore: 'border-border-primary bg-bg-tertiary text-text-tertiary',
  feature: 'border-border-primary bg-bg-tertiary text-text-secondary',
};

export function CategoryTag({ category }: { category: EntityCategory }): React.JSX.Element {
  const Icon = CATEGORY_ICON[category];
  return (
    <span
      className={`eyebrow inline-flex items-center gap-1 rounded-[3px] border px-1.5 py-px ${CATEGORY_CLASS[category]}`}
      title={`Category: ${CATEGORY_LABEL[category]}`}
      data-testid="category-tag"
    >
      <Icon className="h-2.5 w-2.5" strokeWidth={2.5} />
      {CATEGORY_LABEL[category]}
    </span>
  );
}

const SCOPE_LABEL: Record<IdeaScope, string> = {
  small: 'S',
  large: 'L',
};

const SCOPE_CLASS: Record<IdeaScope, string> = {
  small: 'border-status-success/40 bg-status-success/10 text-status-success',
  large: 'border-status-warning/40 bg-status-warning/10 text-status-warning',
};

/** Compact S/L scope badge — only rendered by callers when `scope` is set. */
export function ScopeTag({ scope }: { scope: IdeaScope }): React.JSX.Element {
  return (
    <span
      className={`eyebrow rounded-[3px] border px-1.5 py-px ${SCOPE_CLASS[scope]}`}
      title={`Scope: ${scope}`}
      data-testid="scope-tag"
    >
      {SCOPE_LABEL[scope]}
    </span>
  );
}

/**
 * "Archived" chip for an archive-in-place item (`archived_at` stamped; the item
 * keeps its column). Rendered next to the TypeTag, and only ever visible while
 * the header Archived toggle reveals archived cards (which also dim).
 */
export function ArchivedChip(): React.JSX.Element {
  return (
    <span
      className="eyebrow rounded-[3px] border border-border-primary bg-bg-tertiary px-1.5 py-px text-text-tertiary"
      title="Archived — hidden unless the Archived toggle is on"
      data-testid="archived-chip"
    >
      Archived
    </span>
  );
}

/**
 * Project-name chip shown on cards in the cross-project "All projects" view
 * (filter set to All AND more than one project) so cards stay attributable.
 */
export function ProjectChip({ name }: { name: string }): React.JSX.Element {
  return (
    <span
      className="inline-flex max-w-[140px] rounded-full border border-border-primary bg-bg-tertiary px-2 py-px text-[10px] font-semibold text-text-tertiary"
      title={`Project: ${name}`}
      data-testid="project-chip"
    >
      <span className="truncate">{name}</span>
    </span>
  );
}

/**
 * One FlowMarker per associated run. Renders the resolved "agent · session"
 * label — the hosting session's name when known, else the short run id — and
 * a dot that only PULSES while `runStatus === 'running'` (a live but idle
 * association, e.g. queued/awaiting_review, renders it static).
 */
export function FlowMarker({ flow }: { flow: FlowOverlay }): React.JSX.Element {
  const session = flow.sessionName ?? flow.runId.slice(0, 8);
  const running = flow.runStatus === 'running';
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-interactive/40 bg-interactive-surface px-2 py-0.5 text-[10px] font-semibold text-interactive"
      title={`In flow: ${flow.agent} · ${session}`}
      data-testid="flow-marker"
    >
      <span className="relative flex h-2 w-2">
        {running && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-interactive opacity-60 motion-reduce:hidden" />
        )}
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
