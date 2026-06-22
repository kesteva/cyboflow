/**
 * ReadyRow — one READY-to-compound finding: a whole-row clickable toggle bearing
 * a (presentational) checkbox, a priority badge, the title, and the source meta.
 * No type tag — the enclosing {@link ReadyBucket} already conveys the bucket.
 *
 * The whole row is the toggle target (role="button", Enter/Space keyboard), so the
 * checkbox inside is aria-hidden and clicks bubble to the row. Selected rows get a
 * subtle interactive-surface wash.
 */
import { cn } from '../../utils/cn';
import type { TriageFinding } from '../../stores/insightsStore';
import { composeUntriagedMeta, priorityBadge } from './findingsTagMeta';

interface ReadyRowProps {
  finding: TriageFinding;
  onToggle: () => void;
}

/** ReadyRow — see the file header. */
export function ReadyRow({ finding, onToggle }: ReadyRowProps): React.JSX.Element {
  const badge = priorityBadge(finding.priority);
  const selected = finding.selected;

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggle();
        }
      }}
      data-testid="ready-row"
      data-finding-id={finding.id}
      data-selected={selected}
      className={cn(
        'flex cursor-pointer items-center gap-2 px-2 py-1.5 transition-colors duration-[120ms] hover:bg-surface-hover',
        selected && 'bg-interactive-surface',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'flex h-3.5 w-3.5 shrink-0 items-center justify-center border',
          selected ? 'border-interactive bg-interactive text-text-on-interactive' : 'border-border-primary',
        )}
      >
        {selected && (
          <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M2.5 6.5 5 9l4.5-5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
      <span
        className={cn(
          'shrink-0 rounded-badge border px-1.5 py-px text-[10px] font-bold tabular-nums',
          badge.class,
        )}
        data-testid="priority-badge"
      >
        {badge.label}
      </span>
      <span className="truncate text-sm text-text-primary" title={finding.title}>
        {finding.title}
      </span>
      <span className="ml-auto shrink-0 text-[10px] text-text-tertiary">
        {composeUntriagedMeta(finding)}
      </span>
    </div>
  );
}
