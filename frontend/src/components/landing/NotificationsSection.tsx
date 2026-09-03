/**
 * NotificationsSection — the grey band: things that already happened.
 *
 * A `notification` review item is an FYI (a dynamic workflow finished, a
 * background job reported home). Nothing is halted and nothing is being asked,
 * so these rows must NOT sit in the red "Needs your input" band, whose kicker
 * ("Asked you") and verb ("Answer →") both claim an agent is waiting on a reply
 * that does not exist. The chokepoint already refuses to mint a blocking
 * notification, so this section is informational by construction.
 *
 * Rows mirror HumanTasksSection's single-line chrome with the body behind
 * "Details ▸": "Open →" jumps to the run that filed it, and "Dismiss" is the
 * only triage an FYI has (there is no follow-up to track).
 *
 * It sits BELOW "Ready for review": finished work that still needs a verdict
 * outranks a notice about work that has already been accounted for.
 *
 * The section is omitted entirely when empty — an empty well would imply the
 * queue expects a backlog of notices, which it does not.
 */
import React from 'react';
import type { ReviewItem } from '../../../../shared/types/reviews';
import { useReviewItemActions } from '../../hooks/useReviewItemActions';
import { Chip, GhostButton, PrimaryButton, SecondaryButton, SectionHeader } from './QueuePrimitives';
import { compactAge } from './queueSelectors';

function NotificationRow({
  item,
  projectName,
  nowMs,
  onOpen,
  onDismissed,
}: {
  item: ReviewItem;
  projectName: string | null;
  nowMs: number;
  onOpen: (item: ReviewItem) => void;
  onDismissed: () => void;
}): React.JSX.Element {
  const [expanded, setExpanded] = React.useState(false);
  const { dismiss, pendingItemId } = useReviewItemActions();
  const hasBody = item.body !== null && item.body !== '';
  const busy = pendingItemId === item.id;

  const acknowledge = (): void => {
    void dismiss(item.project_id, item.id).then((ok) => {
      if (ok) onDismissed();
    });
  };

  return (
    <div
      data-testid="rq-notification-row"
      className="flex flex-col gap-1.5 border border-border-primary bg-surface-raised px-3.5 py-2.5 shadow-[inset_3px_0_0_var(--color-text-tertiary)]"
    >
      <div className="flex items-center gap-2">
        <span className="eyebrow shrink-0 text-text-tertiary">FYI</span>
        <span className="min-w-0 truncate text-[12.5px] font-bold text-text-primary" title={item.title}>
          {item.title}
        </span>
        {projectName !== null && <Chip title={projectName}>{projectName}</Chip>}
        <span className="ml-auto shrink-0 text-[10px] text-text-tertiary">
          {compactAge(item.created_at, nowMs)}
        </span>
      </div>
      <div className="flex items-center gap-2.5 text-[11px]">
        {hasBody && !expanded && (
          <span className="min-w-0 flex-1 truncate text-text-secondary" title={item.body ?? undefined}>
            {item.body}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2.5">
          {hasBody && (
            <GhostButton className="text-[11px]" onClick={() => setExpanded((v) => !v)}>
              Details {expanded ? '▾' : '▸'}
            </GhostButton>
          )}
          {item.run_id !== null && <PrimaryButton onClick={() => onOpen(item)}>Open →</PrimaryButton>}
          <SecondaryButton onClick={acknowledge} disabled={busy}>
            {busy ? 'Dismissing…' : 'Dismiss'}
          </SecondaryButton>
        </span>
      </div>
      {expanded && hasBody && (
        <p className="whitespace-pre-wrap border-t border-dashed border-border-primary pt-2 text-[11px] leading-relaxed text-text-secondary">
          {item.body}
        </p>
      )}
    </div>
  );
}

export interface NotificationsSectionProps {
  items: ReviewItem[];
  projectNameById: Record<number, string>;
  nowMs: number;
  /** Jump to whatever filed the notice (the run's session workspace). */
  onOpen: (item: ReviewItem) => void;
  /** Called after a successful dismiss so the page can re-derive its counts. */
  onDismissed: () => void;
}

/** NotificationsSection — see {@link NotificationsSectionProps}. */
export function NotificationsSection({
  items,
  projectNameById,
  nowMs,
  onOpen,
  onDismissed,
}: NotificationsSectionProps): React.JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <section data-testid="rq-notifications-section" className="flex flex-col gap-2">
      <SectionHeader dotClass="bg-text-tertiary" title="Notifications" count={items.length} />
      {items.map((item) => (
        <NotificationRow
          key={item.id}
          item={item}
          projectName={projectNameById[item.project_id] ?? null}
          nowMs={nowMs}
          onOpen={onOpen}
          onDismissed={onDismissed}
        />
      ))}
    </section>
  );
}
