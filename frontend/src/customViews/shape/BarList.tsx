/**
 * BarList — the tier-2 `bars` shape: a horizontal bar per row.
 *
 * Reuses `Insights/charts/BarRow` verbatim rather than re-spelling the track /
 * fill geometry, so a widget's bars and the Insights page's bars are the same
 * object. All this adds is the shared comparison maximum (the largest value in
 * the set, which is what makes the rows comparable at a glance) and the value
 * formatting.
 */
import { BarRow } from '../../components/Insights/charts/BarRow';
import type { Scalar, WidgetValueFormat } from '../../../../shared/types/customViews';
import { formatWidgetValue, toNumber } from '../format';

export interface BarListProps {
  rows: ReadonlyArray<Record<string, Scalar>>;
  /** Row field holding the bar's label. */
  label: string;
  /** Row field holding the bar's magnitude. */
  value: string;
  format?: WidgetValueFormat;
}

/** BarList — see {@link BarListProps}. */
export function BarList({ rows, label, value, format }: BarListProps): React.JSX.Element {
  const numeric = rows.map((row) => toNumber(row[value] ?? null) ?? 0);
  const max = numeric.reduce((acc, n) => (n > acc ? n : acc), 0);
  return (
    <div data-testid="widget-bars" className="flex flex-col gap-1.5">
      {rows.map((row, i) => (
        <BarRow
          key={`${String(row[label] ?? '')}:${i}`}
          label={String(row[label] ?? '')}
          value={numeric[i]}
          max={max}
          valueLabel={formatWidgetValue(row[value] ?? null, format)}
        />
      ))}
    </div>
  );
}
