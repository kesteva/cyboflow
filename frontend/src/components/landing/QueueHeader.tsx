/**
 * QueueHeader — the page title band: an eyebrow kicker over "<N> waiting on you".
 *
 * The header-right block is reserved for ONE thing: the Custom Views controls
 * (`controls`) — the view switcher and the Customize button
 * (docs/proposals/CUSTOM-VIEWS.md §6). An earlier revision carried a
 * "N blocking a sprint | Project overview →" cluster there; it was removed
 * because the count it repeated is already the headline and the link belonged
 * to a different surface, and that judgement still stands for anything ELSE
 * that wants this slot. The row is `items-start` so a tall control cluster
 * grows downward from the eyebrow's baseline rather than re-centring the title.
 *
 * The count's color is the page's one-glance signal, so it tracks the derived
 * {@link QueuePageState} rather than the number alone:
 *   - accent   — the normal "here is your pile" state,
 *   - green    — caught up (a zero worth celebrating),
 *   - muted    — a bootstrap zero (no sessions/projects/accounts) that means
 *                "nothing exists yet", not "you cleared it",
 *   - em dash  — the load failed, so no count is knowable. Rendering `0` there
 *                would assert something we cannot see.
 */
import React from 'react';
import type { QueuePageState } from '../../utils/reviewQueuePageState';

export interface QueueHeaderProps {
  waitingCount: number;
  state: QueuePageState;
  /** Right-aligned control cluster — the view switcher + Customize (S5). */
  controls?: React.ReactNode;
}

/** QueueHeader — see {@link QueueHeaderProps}. */
export function QueueHeader({ waitingCount, state, controls }: QueueHeaderProps): React.JSX.Element {
  const isBootstrapZero =
    state === 'no-sessions' || state === 'no-projects' || state === 'no-accounts';
  const countClass =
    state === 'error' || isBootstrapZero
      ? 'text-text-muted'
      : state === 'caught-up'
        ? 'text-status-success'
        : 'text-interactive';

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="eyebrow text-text-tertiary">Human review queue</div>
        <h1 className="text-[24px] font-bold tracking-[-0.01em] text-text-primary">
          <span className={`tabular-nums ${countClass}`} data-testid="rq-header-count">
            {state === 'error' ? '—' : waitingCount}
          </span>{' '}
          waiting on you
        </h1>
      </div>
      {controls !== undefined && controls !== null && (
        <div className="flex shrink-0 items-center gap-2">{controls}</div>
      )}
    </div>
  );
}
