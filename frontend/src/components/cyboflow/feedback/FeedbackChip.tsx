/**
 * FeedbackChip — the small "changes requested" indicator on an approve-ideas /
 * approve-designs gate row (IDEA-033), derived from {@link latestBatchStatus}.
 * Renders nothing when the idea has no feedback batches.
 */
import type { ReactElement } from 'react';
import type { ChipStatus } from './feedbackLogic';

const PASS = '#2d8a5b';
const FAIL = '#c0392b';

export function FeedbackChip({ status }: { status: ChipStatus | null }): ReactElement | null {
  if (status === null) return null;

  if (status.kind === 'pending') {
    return (
      <span
        data-testid="feedback-chip-pending"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '8.5px', fontWeight: 700, color: 'var(--color-interactive-primary)', border: `1px solid var(--color-interactive-primary)`, borderRadius: 2, padding: '1px 5px' }}
      >
        <span className="cf-pulse" aria-hidden="true">●</span>
        Revision in progress
      </span>
    );
  }

  if (status.kind === 'applied') {
    return (
      <span
        data-testid="feedback-chip-applied"
        style={{ fontSize: '8.5px', fontWeight: 700, color: PASS, border: `1px solid ${PASS}`, borderRadius: 2, padding: '1px 5px' }}
      >
        {`Changes requested · round ${status.round} applied`}
      </span>
    );
  }

  return (
    <span
      data-testid="feedback-chip-failed"
      title={status.error ?? undefined}
      style={{ fontSize: '8.5px', fontWeight: 700, color: FAIL, border: `1px solid ${FAIL}`, borderRadius: 2, padding: '1px 5px' }}
    >
      Revision failed
    </span>
  );
}
