/**
 * Value formatting for tier-2 widget shapes — the renderer half of
 * `WidgetValueFormat` (shared/types/customViews.ts).
 *
 * A widget's rows come back as `Scalar`s straight from SQLite, so every
 * formatter has to survive a string where it expected a number (a SUM over an
 * empty set, a TEXT column the author picked by mistake) without throwing or
 * printing `NaN`. The rule throughout: coerce, and if the coercion fails, print
 * the raw value rather than a lie.
 *
 * `tokens` deliberately matches the Insights chart legend's compact form
 * (`1.2m` / `340k`) so the same number reads the same way whether it is on the
 * statistics page or in a widget the user built.
 */
import type { Scalar } from '../../../shared/types/customViews';
import type { WidgetValueFormat } from '../../../shared/types/customViews';

/** A `Scalar` as a number, or `null` when it is not one. */
export function toNumber(value: Scalar): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Compact token figure: >= 1M -> 'N.Nm', >= 1000 -> 'Nk', else the integer. */
export function compactTokens(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(0)}k`;
  return `${Math.round(n)}`;
}

/** A millisecond duration as `1h 4m` / `4m 12s` / `900ms`. */
export function compactDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSec = Math.round(ms / 1000);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin === 0) return `${s}s`;
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  if (h === 0) return `${m}m ${s}s`;
  return `${h}h ${m}m`;
}

/**
 * Render one cell/stat value. An unformatted value prints as-is; `null` prints
 * an em dash (the app's "not knowable" mark, same as the queue header's).
 */
export function formatWidgetValue(value: Scalar, format?: WidgetValueFormat): string {
  if (value === null) return '—';
  if (format === undefined) return String(value);
  const n = toNumber(value);
  if (n === null) return String(value);
  switch (format) {
    case 'number':
      return n.toLocaleString();
    case 'tokens':
      return compactTokens(n);
    case 'usd':
      return `$${n.toFixed(n < 1 ? 4 : 2)}`;
    case 'percent':
      return `${(n * 100).toFixed(1)}%`;
    case 'duration':
      return compactDuration(n);
    default:
      return String(value);
  }
}
