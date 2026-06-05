/**
 * WorkflowListRow — one workflow rendered as a selectable row in the wizard's
 * step-2 workflow list.
 *
 * Left: tight-cased title + (when default) a "DEFAULT" tag + subtitle +
 * the slash-command in mono. Right: a "<n> STEPS · <m> PHASES" eyebrow and,
 * when the flow has been run before, a "USED <relative>" line. Selected →
 * terracotta border.
 *
 * The card model is {@link WorkflowCardMeta} from `workflowMeta.ts` — built by
 * the parent from the two tRPC list queries.
 */
import type { WorkflowCardMeta } from './workflowMeta';

interface WorkflowListRowProps {
  meta: WorkflowCardMeta;
  selected: boolean;
  onSelect: () => void;
}

/**
 * Format an ISO timestamp as a compact "used X ago" relative label.
 * Returns null when the timestamp is missing or unparseable.
 */
function formatRelative(iso: string | null): string | null {
  if (iso === null) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;

  const diffMs = Math.max(0, Date.now() - then);
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w ago`;
}

export function WorkflowListRow({
  meta,
  selected,
  onSelect,
}: WorkflowListRowProps): React.JSX.Element {
  const used = formatRelative(meta.lastUsedAt);

  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid="workflow-list-row"
      aria-pressed={selected}
      className={`flex w-full items-start justify-between gap-3 border bg-surface-primary p-3 text-left transition-colors ${
        selected
          ? 'border-interactive'
          : 'border-border-primary hover:border-border-emphasized'
      }`}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex items-center gap-2">
          <span
            className="truncate text-text-primary"
            style={{ fontSize: '14px', fontWeight: 700 }}
          >
            {meta.title}
          </span>
          {meta.isDefault && (
            <span
              className="eyebrow shrink-0 border border-border-primary px-1 py-0.5 text-text-secondary"
              data-testid="workflow-row-default-tag"
            >
              Default
            </span>
          )}
        </div>
        {meta.subtitle.length > 0 && (
          <span className="truncate text-xs text-text-secondary">
            {meta.subtitle}
          </span>
        )}
        <span className="truncate font-mono text-xs text-text-tertiary">
          {meta.slashCommand}
        </span>
      </div>

      <div className="flex shrink-0 flex-col items-end gap-1 text-right">
        <span className="eyebrow text-text-muted">
          {meta.stepCount} STEPS · {meta.phaseCount} PHASES
        </span>
        {used !== null && (
          <span className="eyebrow text-text-tertiary">USED {used}</span>
        )}
      </div>
    </button>
  );
}
