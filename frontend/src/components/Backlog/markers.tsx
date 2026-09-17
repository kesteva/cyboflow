/**
 * Small presentational marks rendered on backlog cards / list rows:
 *   - TypeTag      (idea | epic | task)
 *   - PriorityTag  (P0 | P1 | P2)
 *   - CategoryTag  (feature | bug | chore — migration 059)
 *   - ScopeTag     (S = small, L = large — idea scope hint; hidden when unset)
 *   - ExecutorBadge (neutral "Human" — a task only a person can do, migration
 *                  137; hidden for the 'agent' default, which is every other
 *                  task and every idea/epic)
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
 *   - LedgerChip   (one of the idea component ledger's five components — see
 *                  shared/types/ideaComponents.ts. FOUR visual states even
 *                  though the ledger only has three: staleness is a separate
 *                  axis from state, so an incomplete component with prior work
 *                  ("needs review") reads differently from one that was never
 *                  started. Rendered by TaskCard.tsx, one per component, on
 *                  ideas only.)
 *
 * Colors map the Protoflow design hex to the EXISTING semantic theme tokens in
 * styles/tokens/colors.css: terracotta → --color-interactive-primary,
 * gold → --color-status-warning, green → --color-status-success.
 *
 * The breathing-glow on an in-flight card honours prefers-reduced-motion via
 * the `motion-reduce:` Tailwind variant (drops the pulse animation).
 */
import { User, Bug, Sparkles, Wrench, FlaskConical, UserRound } from 'lucide-react';
import type { EntityCategory, FlowOverlay, IdeaScope, Priority, TaskType } from '../../../../shared/types/tasks';
import { IDEA_COMPONENT_LABELS } from '../../../../shared/types/ideaComponents';
import type { IdeaComponentState } from '../../../../shared/types/ideaComponents';

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

/**
 * 7-level ramp (migration 117 widen; was P0-P2). P0/P1/P2 keep their original
 * colors (hottest red -> warning amber -> the existing neutral) as the TOP of
 * the ramp; P3-P6 continue it downward by fading the SAME neutral tokens
 * P2 already uses, so the scale reads as one continuous cool-down rather than
 * a second unrelated palette bolted on. P6 lands on `text-disabled` — the
 * dimmest text token in the theme — for the most muted tier.
 */
const PRIORITY_CLASS: Record<Priority, string> = {
  // P0 = highest urgency (warm-red error token), P1 = warning, P2 = neutral.
  P0: 'border-status-error/40 bg-status-error/10 text-status-error',
  P1: 'border-status-warning/40 bg-status-warning/10 text-status-warning',
  P2: 'border-border-primary bg-bg-tertiary text-text-tertiary',
  P3: 'border-border-primary/70 bg-bg-tertiary/70 text-text-tertiary/90',
  P4: 'border-border-primary/50 bg-bg-tertiary/50 text-text-tertiary/70',
  P5: 'border-border-primary/30 bg-bg-tertiary/40 text-text-tertiary/50',
  P6: 'border-border-primary/20 bg-bg-tertiary/25 text-text-disabled',
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

/** Canonical display labels for the entity category enum — reuse this instead of re-capitalizing. */
export const CATEGORY_LABEL: Record<EntityCategory, string> = {
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
 * "In experiment" badge for an original seed task whose A/B experiment is still
 * running (`experimentSeed` overlay, C2). Its per-arm clones carry the runs and
 * are hidden by their experiment tag, so the deriver holds the original at "In
 * development" — this badge explains WHY it is there (a live head-to-head) versus
 * a normal sprint pull. Uses the interactive/terracotta accent to sit alongside
 * the flow marker family without reading as an error/warning.
 */
export function ExperimentBadge(): React.JSX.Element {
  return (
    <span
      className="eyebrow inline-flex items-center gap-1 rounded-[3px] border border-interactive/40 bg-interactive-surface px-1.5 py-px text-interactive"
      title="In an A/B experiment — two variant arms are working on this in parallel"
      data-testid="experiment-badge"
    >
      <FlaskConical className="h-2.5 w-2.5" strokeWidth={2.5} />
      In experiment
    </span>
  );
}

/**
 * "Human" badge for a task whose executor is 'human' (migration 137) — work only
 * a person can do, which no sprint will ever pick up.
 *
 * Deliberately NEUTRAL (the same muted border/surface the chore CategoryTag
 * uses), not a warning colour: a human task is a normal, healthy state of the
 * backlog, not a problem. Callers render it only for `executor === 'human'`;
 * the 'agent' default has no badge, because almost everything is an agent task
 * and a badge on all of them would carry no information.
 */
export function ExecutorBadge(): React.JSX.Element {
  return (
    <span
      className="eyebrow inline-flex items-center gap-1 rounded-[3px] border border-border-primary bg-bg-tertiary px-1.5 py-px text-text-secondary"
      title="Human task — only a person can do this work; it never runs in a sprint"
      data-testid="executor-badge"
    >
      <UserRound className="h-2.5 w-2.5" strokeWidth={2.5} />
      Human
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
 *
 * When `onOpen` is provided (the run has a known hosting session) the pill is
 * a button that opens that session; without it (a headless / session-less run)
 * it stays a plain span. `max-w-full` + the truncating label keep a long
 * session name inside the card instead of overflowing it.
 */
export function FlowMarker({
  flow,
  onOpen,
}: {
  flow: FlowOverlay;
  onOpen?: () => void;
}): React.JSX.Element {
  const session = flow.sessionName ?? flow.runId.slice(0, 8);
  const running = flow.runStatus === 'running';
  const pillClass =
    'inline-flex max-w-full items-center gap-1.5 rounded-full border border-interactive/40 bg-interactive-surface px-2 py-0.5 text-[10px] font-semibold text-interactive';
  const content = (
    <>
      <span className="relative flex h-2 w-2 flex-shrink-0">
        {running && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-interactive opacity-60 motion-reduce:hidden" />
        )}
        <span className="relative inline-flex h-2 w-2 rounded-full bg-interactive" />
      </span>
      <span className="min-w-0 truncate">
        {flow.agent} · {session}
      </span>
    </>
  );
  if (onOpen) {
    return (
      <button
        type="button"
        // stopPropagation: cards live inside draggable/expandable wrappers — the
        // click must open the session, not toggle the card.
        onClick={(e) => {
          e.stopPropagation();
          onOpen();
        }}
        className={`${pillClass} transition-colors hover:bg-interactive hover:text-text-on-interactive`}
        title={`Open session: ${flow.agent} · ${session}`}
        data-testid="flow-marker"
      >
        {content}
      </button>
    );
  }
  return (
    <span className={pillClass} title={`In flow: ${flow.agent} · ${session}`} data-testid="flow-marker">
      {content}
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

/**
 * A ledger chip's FOUR visual states. The ledger itself only has three
 * (complete/incomplete/skipped — shared/types/ideaComponents.ts) — staleness
 * is a separate axis carried by `staleAt`, not a fourth state, but it still
 * needs its own visual treatment: "needs review" (prior work exists, re-verify
 * it) must never collapse into "not started" (nothing has happened yet).
 */
export type LedgerChipVisualState = 'complete' | 'needs-review' | 'not-started' | 'skipped';

/** Human label per visual state — used by both the chip's title and LedgerExpand's row text. */
export const LEDGER_STATE_LABEL: Record<LedgerChipVisualState, string> = {
  complete: 'Complete',
  'needs-review': 'Needs review',
  'not-started': 'Not started',
  skipped: 'Skipped',
};

const LEDGER_CHIP_CLASS: Record<LedgerChipVisualState, string> = {
  complete: 'border-status-success/40 bg-status-success/10 text-status-success',
  'needs-review': 'border-status-warning/40 bg-status-warning/10 text-status-warning',
  'not-started': 'border-border-primary bg-bg-tertiary text-text-tertiary',
  // Muted AND dashed — clearly de-emphasised but still present, so the row of
  // five always reads as a checklist rather than a variable badge pile.
  skipped: 'border-dashed border-border-primary bg-bg-tertiary text-text-tertiary',
};

/** Resolve a ledger entry's visual state from its (state, staleAt) pair. */
export function ledgerChipVisualState(entry: Pick<IdeaComponentState, 'state' | 'staleAt'>): LedgerChipVisualState {
  if (entry.state === 'skipped') return 'skipped';
  if (entry.state === 'complete') return 'complete';
  return entry.staleAt !== null ? 'needs-review' : 'not-started';
}

/**
 * One idea component's ledger chip. Label comes from {@link IDEA_COMPONENT_LABELS}
 * — the shared vocabulary the card and the artifact renderer both read, so
 * never re-derive a second label here.
 */
export function LedgerChip({ component }: { component: IdeaComponentState }): React.JSX.Element {
  const visual = ledgerChipVisualState(component);
  const label = IDEA_COMPONENT_LABELS[component.component];
  return (
    <span
      className={`eyebrow rounded-[3px] border px-1.5 py-px ${LEDGER_CHIP_CLASS[visual]}`}
      title={`${label}: ${LEDGER_STATE_LABEL[visual]}`}
      data-testid={`ledger-chip-${component.component}`}
      data-ledger-state={visual}
    >
      {label}
    </span>
  );
}
