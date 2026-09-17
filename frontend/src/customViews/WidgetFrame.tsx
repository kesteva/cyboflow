/**
 * WidgetFrame — the box every widget renders inside (the "Widget states"
 * artboard, docs/proposals/CUSTOM-VIEWS.md §5.3).
 *
 * Purely presentational and shared by three callers, which is why it is its own
 * module rather than a local in `WidgetHost`: the host (every data state),
 * `ViewSurface` (the "not available on this page" chip for a section ref that
 * belongs to the other surface), and S5's editable block wrapper.
 *
 * The chrome is deliberately thin — a title row that can carry header actions,
 * one muted meta line, the body, and an optional status line under it — so a
 * widget reads as part of the page rather than as a card pasted onto it. It
 * borrows the queue's own tokens (`SectionHeader`'s 13px bold title, the muted
 * 11px descriptor) instead of inventing a second visual language.
 */
import type { ReactNode } from 'react';

export interface WidgetFrameProps {
  title: string;
  /** Muted one-liner under the title: source names, freshness. */
  meta?: ReactNode;
  /** Right-aligned controls on the title row (header actions, Retry). */
  headerRight?: ReactNode;
  /** The widget body. */
  children: ReactNode;
  /** A line under the body: an action outcome, or "updating…" over stale data. */
  status?: ReactNode;
  /** Test hook; defaults to a stable generic id. */
  testId?: string;
}

/** WidgetFrame — see {@link WidgetFrameProps}. */
export function WidgetFrame({
  title,
  meta,
  headerRight,
  children,
  status,
  testId = 'widget-frame',
}: WidgetFrameProps): React.JSX.Element {
  return (
    <section data-testid={testId} className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-[13px] font-bold text-text-primary">{title}</span>
          {meta !== undefined && meta !== null && (
            <span className="truncate text-[11px] text-text-tertiary" data-testid={`${testId}-meta`}>
              {meta}
            </span>
          )}
        </div>
        {headerRight !== undefined && headerRight !== null && (
          <div className="flex shrink-0 items-center gap-1.5">{headerRight}</div>
        )}
      </div>
      {children}
      {status !== undefined && status !== null && (
        <div className="text-[11px] text-text-tertiary" data-testid={`${testId}-status`}>
          {status}
        </div>
      )}
    </section>
  );
}

/**
 * The body a widget shows when its layout item references something this page
 * cannot render: a section id owned by the OTHER surface, or a catalog id this
 * build no longer ships. Never an error — a view is portable data and a stale
 * reference is an expected state, not a failure.
 */
export function UnavailableBody({ reason }: { reason: string }): React.JSX.Element {
  return (
    <div
      data-testid="widget-unavailable"
      className="border border-dashed border-border-primary bg-surface-raised px-[18px] py-3.5 text-center text-[11px] text-text-tertiary"
    >
      {reason}
    </div>
  );
}
