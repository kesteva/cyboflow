/**
 * StatCard — the tier-2 `stat` shape: one big number and its label.
 *
 * Reads the FIRST row of the named source, because that is what a stat source
 * is: a scalar aggregate. A source that came back empty renders an em dash
 * rather than a zero — "no rows" and "the answer is zero" are different facts
 * and only one of them is safe to assert.
 */
import type { Scalar, WidgetValueFormat } from '../../../../shared/types/customViews';
import { formatWidgetValue } from '../format';

export interface StatCardProps {
  rows: ReadonlyArray<Record<string, Scalar>>;
  /** Row field holding the figure. */
  value: string;
  label?: string;
  format?: WidgetValueFormat;
}

/** StatCard — see {@link StatCardProps}. */
export function StatCard({ rows, value, label, format }: StatCardProps): React.JSX.Element {
  const first = rows[0];
  const raw: Scalar = first === undefined ? null : (first[value] ?? null);
  return (
    <div
      data-testid="widget-stat"
      className="flex flex-col gap-0.5 border border-border-primary bg-surface-raised px-[18px] py-3.5"
    >
      <span className="text-[24px] font-bold tabular-nums leading-tight text-text-primary">
        {formatWidgetValue(raw, format)}
      </span>
      {label !== undefined && <span className="text-[11px] text-text-tertiary">{label}</span>}
    </div>
  );
}
