/**
 * DailyUsageChart — the 30-day daily token-use chart at the top of the Insights
 * Statistics section.
 *
 * Dependency-free, pure-presentational primitive (no chart library, no store /
 * router import — props only). Renders a hand-rolled SVG column chart in the same
 * idiom as its chart siblings ({@link BarRow}, Sparkline): one column slot per
 * UTC day across the last `days` days ending today, with each day's per-model
 * usage drawn as a vertical STACK of colored segments. Days without any
 * {@link DailyModelUsagePoint} render as an empty slot, so a sparse history keeps
 * a stable, evenly-spaced axis instead of collapsing the gaps.
 *
 * Three presentation rules keep the render deterministic and honest:
 *   - Model stack order AND legend order are the models sorted by their GRAND
 *     TOTAL tokens (summed across the window) DESC, so the largest contributor is
 *     always assigned the first palette color and drawn at the base of each bar.
 *   - Colors come from a fixed module-level {@link PALETTE} indexed by that legend
 *     order (wrapping if there are more models than palette entries) — the same
 *     model gets the same hue in every bar and in the legend.
 *   - Bar heights normalize against the busiest day's total, so the tallest day
 *     fills the plot height and quiet days stay proportional; a window with no
 *     usage at all renders the empty-state text rather than a flat zero-height
 *     plot.
 *
 * Each segment carries an SVG <title> ('model · YYYY-MM-DD · N tokens') for a
 * native hover tooltip, and the plot is responsive via `viewBox` (it scales to
 * the container width at a fixed ~120px drawing height). The legend below the
 * plot shows each model's swatch, shortened name (leading 'claude-' stripped),
 * and compact total. With no points at all the component renders a muted
 * "No token usage recorded in the last N days." line in place of the SVG.
 */
import type { DailyModelUsagePoint } from '../../../../../shared/types/insights';

/**
 * Deterministic warm-paper palette for the per-model stack, indexed by legend
 * order (model rank by grand-total tokens, DESC). These are the theme's phase
 * hues (styles/tokens/colors.css `--color-phase-*`) used as explicit SVG fills —
 * Sparkline/BarRow set the precedent that SVG geometry takes literal colors
 * rather than semantic Tailwind classes. More models than entries wrap modulo
 * the array length.
 */
export const PALETTE: readonly string[] = [
  '#c96442', // terracotta (execute)
  '#3b6dd6', // blue (plan)
  '#2d8a5b', // green (verify)
  '#8b5cf6', // violet (compound)
  '#a87a2c', // amber (review)
  '#5a4ad6', // indigo (refine)
  '#8a4a4a', // muted red (prune)
];

/** SVG drawing height in px (the plot area; legend sits below in normal flow). */
const PLOT_HEIGHT = 120;

/** SVG drawing width in px — arbitrary; the viewBox makes the render responsive. */
const PLOT_WIDTH = 480;

/** Fraction of each column slot occupied by the bar (rest is inter-bar gap). */
const BAR_FILL = 0.7;

/** Vertical padding (px) reserved at the top so the tallest bar never clips. */
const TOP_INSET = 4;

/**
 * Compact token figure: >= 1M → 'N.Nm', >= 1000 → 'Nk' (rounded), else the raw
 * integer.
 *
 * Replicates StatsSection.compactTokens deliberately (this chart stays
 * import-free of section internals) so its legend totals read identically to
 * the cards above it.
 */
function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1000) return `${(n / 1000).toFixed(0)}k`;
  return `${Math.round(n)}`;
}

/** Strip a leading 'claude-' so the legend shows e.g. 'sonnet-4' not the full id. */
function shortModelName(model: string): string {
  return model.startsWith('claude-') ? model.slice('claude-'.length) : model;
}

/** Two-digit zero-pad for the UTC date parts of {@link utcDayKeys}. */
function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/**
 * The 'YYYY-MM-DD' UTC day keys for the last `days` days ending on `today`
 * (oldest first, today last). Built off the UTC midnight of `today` so the keys
 * line up with `DailyModelUsagePoint.day` (a UTC date slice) regardless of the
 * caller's local timezone. Exported so the colocated test pins the axis math
 * without re-deriving it.
 */
export function utcDayKeys(days: number, today: Date): string[] {
  const base = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate(),
  );
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(base - i * 86_400_000);
    out.push(
      `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`,
    );
  }
  return out;
}

/** One model's window-wide total, paired with its rendered swatch color. */
export interface ModelLegendEntry {
  model: string;
  totalTokens: number;
  color: string;
}

/**
 * Distinct models ranked by grand-total tokens (DESC), each tagged with its
 * palette color by rank. Drives BOTH the stack order and the legend. Ties break
 * on model id (ascending) so the order is stable across renders. Exported for
 * the colocated test.
 */
export function modelLegend(points: DailyModelUsagePoint[]): ModelLegendEntry[] {
  const totals = new Map<string, number>();
  for (const p of points) {
    totals.set(p.model, (totals.get(p.model) ?? 0) + p.totalTokens);
  }
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([model, totalTokens], i) => ({
      model,
      totalTokens,
      color: PALETTE[i % PALETTE.length],
    }));
}

interface DailyUsageChartProps {
  /** The per-day, per-model usage buckets (a sparse set; gaps are filled). */
  points: DailyModelUsagePoint[];
  /** Trailing window length in days, ending today. Defaults to 30. */
  days?: number;
}

export function DailyUsageChart({
  points,
  days = 30,
}: DailyUsageChartProps): React.JSX.Element {
  // No usage at all → muted line instead of an empty/zero-height plot.
  if (points.length === 0) {
    return (
      <p
        className="py-8 text-center text-sm text-text-muted"
        data-testid="daily-usage-chart"
      >
        No token usage recorded in the last {days} days.
      </p>
    );
  }

  const legend = modelLegend(points);
  const dayKeys = utcDayKeys(days, new Date());

  // day -> model -> totalTokens, restricted to the visible window.
  const byDay = new Map<string, Map<string, number>>();
  for (const key of dayKeys) byDay.set(key, new Map());
  for (const p of points) {
    const row = byDay.get(p.day);
    if (row === undefined) continue; // outside the window — ignore.
    row.set(p.model, (row.get(p.model) ?? 0) + p.totalTokens);
  }

  // Busiest day's total drives the vertical scale; 0 only if every visible day
  // is empty (all points fell outside the window), in which case bars collapse.
  let maxDayTotal = 0;
  for (const key of dayKeys) {
    let sum = 0;
    for (const v of byDay.get(key)!.values()) sum += v;
    if (sum > maxDayTotal) maxDayTotal = sum;
  }

  const slotWidth = PLOT_WIDTH / days;
  const barWidth = slotWidth * BAR_FILL;
  const usableHeight = PLOT_HEIGHT - TOP_INSET;
  // Map a token count to a pixel height; non-positive max → 0 (no divide-by-zero).
  const toHeight = (tokens: number): number =>
    maxDayTotal <= 0 ? 0 : (tokens / maxDayTotal) * usableHeight;

  return (
    <div data-testid="daily-usage-chart">
      {/* relative wrapper so the y-axis max label can overlay the plot as HTML.
          It must NOT live inside the SVG: preserveAspectRatio="none" stretches
          the 480-unit viewBox to the container width, which distorts <text>
          glyphs horizontally (rects stretch fine — text does not). */}
      <div className="relative">
        {maxDayTotal > 0 && (
          <span
            aria-hidden
            className="pointer-events-none absolute left-0.5 top-0.5 font-mono text-[10px] leading-none text-text-tertiary"
          >
            {compactTokens(maxDayTotal)}
          </span>
        )}
        <svg
          width="100%"
          height={PLOT_HEIGHT}
          viewBox={`0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`daily token usage over ${days} days`}
        >
          {dayKeys.map((key, col) => {
            const row = byDay.get(key)!;
            const x = col * slotWidth + (slotWidth - barWidth) / 2;
            // Stack from the baseline up, in legend order (largest model first).
            let cursor = PLOT_HEIGHT; // bottom of the plot in SVG y.
            return legend.map((entry) => {
              const tokens = row.get(entry.model) ?? 0;
              if (tokens <= 0) return null;
              const h = toHeight(tokens);
              cursor -= h;
              return (
                <rect
                  key={`${key}:${entry.model}`}
                  x={x}
                  y={cursor}
                  width={barWidth}
                  height={h}
                  fill={entry.color}
                >
                  <title>{`${entry.model} · ${key} · ${tokens} tokens`}</title>
                </rect>
              );
            });
          })}
        </svg>
      </div>
      <ul
        className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px]"
        data-testid="daily-usage-legend"
      >
        {legend.map((entry) => (
          <li key={entry.model} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ backgroundColor: entry.color }}
            />
            <span className="font-mono text-text-secondary">
              {shortModelName(entry.model)}
            </span>
            <span className="font-mono tabular-nums text-text-tertiary">
              {compactTokens(entry.totalTokens)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
