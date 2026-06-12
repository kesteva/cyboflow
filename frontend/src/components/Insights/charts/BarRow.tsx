/**
 * BarRow — one horizontal labeled bar in the Insights view.
 *
 * Dependency-free, pure-presentational primitive (no chart library, no store /
 * router import). Renders a three-column grid row:
 *   [ monospace label ] [ full-width track with a proportional fill ] [ value ]
 *
 * The fill width is `value / max` clamped to [0, 100] %, so callers can pass a
 * shared `max` (e.g. the largest value in a set of rows) and the bars stay
 * comparable. A non-positive `max` collapses the fill to 0% rather than dividing
 * by zero — this is the "no data yet" steady state.
 *
 * Styling resolves entirely through the paper-theme semantic tokens
 * (styles/tokens/colors.css): the track is `bg-surface-tertiary` (the same muted
 * fill StatusIndicator uses for its progress bar) and the fill defaults to the
 * terracotta `bg-interactive` accent. Override `accentClass` to recolor the fill
 * (e.g. a status hue) without touching the track.
 */
import { cn } from '../../../utils/cn';

interface BarRowProps {
  /** Left-column label (rendered monospace, truncated). */
  label: string;
  /** This row's value; the fill width is value/max. */
  value: number;
  /** The comparison maximum across the row set. value/max drives the fill. */
  max: number;
  /** Right-aligned display string. Defaults to String(value). */
  valueLabel?: string;
  /** Tailwind class(es) for the fill div. Defaults to the terracotta accent. */
  accentClass?: string;
}

/**
 * Fill percentage for one bar, rounded to 2 decimal places.
 *
 * Exported so the colocated test pins the exact width math (zero/negative max →
 * 0, over-max value → clamped 100) against the same source the component renders.
 */
export function barFillPct(value: number, max: number): number {
  if (max <= 0) return 0;
  const raw = (value / max) * 100;
  const clamped = Math.min(100, Math.max(0, raw));
  return Math.round(clamped * 100) / 100;
}

export function BarRow({
  label,
  value,
  max,
  valueLabel,
  accentClass = 'bg-interactive',
}: BarRowProps): React.JSX.Element {
  const pct = barFillPct(value, max);
  const display = valueLabel ?? String(value);
  return (
    <div
      role="img"
      aria-label={`${label}: ${display}`}
      className="grid grid-cols-[minmax(0,8rem)_1fr_auto] items-center gap-3 text-xs"
    >
      <span className="truncate font-mono text-text-secondary" title={label}>
        {label}
      </span>
      <div className="h-2 overflow-hidden rounded-full bg-surface-tertiary">
        <div
          className={cn('h-full rounded-full', accentClass)}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-right font-mono tabular-nums text-text-primary">
        {display}
      </span>
    </div>
  );
}
