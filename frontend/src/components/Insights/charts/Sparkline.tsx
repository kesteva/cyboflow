/**
 * Sparkline — an inline SVG polyline trend for the Insights view.
 *
 * Dependency-free, pure-presentational primitive (no chart library, no store /
 * router import). Draws `points` as a single open polyline scaled to fill the
 * `width` x `height` box, with a 2px vertical inset so the stroke never clips at
 * the extremes.
 *
 * Three deliberate behaviours keep the layout stable and the render honest:
 *   - Fewer than 2 points → an EMPTY <svg> of the same width/height. One point
 *     (or none) is not a trend; emitting the empty box preserves row height so
 *     a populating series does not shift the layout around it.
 *   - More than {@link MAX_POINTS} points → average-pooled into MAX_POINTS
 *     evenly-sized buckets first, so a long history renders at a fixed polyline
 *     density (and the SVG stays cheap) instead of one vertex per sample.
 *   - A FLAT series (every y equal, including all-zero) → the y-normalizer maps
 *     it to the vertical midline rather than dividing by a zero range.
 *
 * y is normalized into [INSET, height - INSET] with the data MAXIMUM at the top
 * (smaller pixel y) — the conventional "up is more" sparkline orientation. x is
 * evenly spaced across the full width. The stroke uses
 * vectorEffect='non-scaling-stroke' so it stays 1.5px crisp regardless of the
 * box dimensions, and defaults to the green `stroke-status-success` accent.
 */

/** Maximum rendered vertices; longer inputs are average-pooled to this count. */
export const MAX_POINTS = 40;

/** Vertical padding (px) reserved at the top and bottom so the stroke never clips. */
const INSET = 2;

/** Stroke width in px (constant via non-scaling-stroke). */
const STROKE_WIDTH = 1.5;

/**
 * Average-pool `values` into exactly `buckets` evenly-sized groups by index.
 *
 * Used only when the input is longer than MAX_POINTS. Boundaries are computed
 * with floating-point ratios and floored so the bucket sizes differ by at most
 * one — no sample is dropped and none is double-counted. Exported so the
 * colocated test can assert the bucketing (e.g. 90 points → 40 buckets).
 */
export function averagePool(values: number[], buckets: number): number[] {
  if (buckets <= 0 || values.length === 0) return [];
  if (values.length <= buckets) return values.slice();
  const out: number[] = [];
  for (let i = 0; i < buckets; i++) {
    const start = Math.floor((i * values.length) / buckets);
    const end = Math.floor(((i + 1) * values.length) / buckets);
    // Guard against an empty slice (cannot happen while values.length > buckets,
    // but keeps the mean well-defined if that invariant ever changes).
    const lo = start;
    const hi = Math.max(end, start + 1);
    let sum = 0;
    for (let j = lo; j < hi; j++) sum += values[j];
    out.push(sum / (hi - lo));
  }
  return out;
}

/**
 * Project `values` into SVG `[x, y]` coordinate pairs filling the box.
 *
 * x is evenly spaced across `width` (first point at 0, last at `width`); y is
 * inverted so the data maximum sits at the top inset. A flat series (zero range)
 * maps every point to the vertical midline. Exported so the test can pin the
 * coordinate math (count, flat-series midline) without parsing the rendered DOM.
 */
export function buildPolylinePoints(
  values: number[],
  width: number,
  height: number,
): Array<[number, number]> {
  const n = values.length;
  if (n === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  const top = INSET;
  const bottom = height - INSET;
  const mid = (top + bottom) / 2;
  return values.map((v, i): [number, number] => {
    const x = n === 1 ? 0 : (i / (n - 1)) * width;
    // Flat series → midline; otherwise invert so max is at the top inset.
    const y = range === 0 ? mid : bottom - ((v - min) / range) * (bottom - top);
    return [x, y];
  });
}

interface SparklineProps {
  /** The trend series (chronological). */
  points: number[];
  /** SVG box width in px. */
  width?: number;
  /** SVG box height in px. */
  height?: number;
  /** Tailwind stroke class for the polyline. Defaults to the success accent. */
  strokeClass?: string;
}

export function Sparkline({
  points,
  width = 120,
  height = 28,
  strokeClass = 'stroke-status-success',
}: SparklineProps): React.JSX.Element {
  // Fewer than 2 points is not a trend — emit an empty box of the same size so
  // the surrounding layout does not jump when data starts arriving.
  if (points.length < 2) {
    return (
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`trend of ${points.length} points`}
      />
    );
  }

  const pooled = points.length > MAX_POINTS ? averagePool(points, MAX_POINTS) : points;
  const coords = buildPolylinePoints(pooled, width, height);
  const pointsAttr = coords.map(([x, y]) => `${x},${y}`).join(' ');

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`trend of ${points.length} points`}
    >
      <polyline
        points={pointsAttr}
        fill="none"
        className={strokeClass}
        strokeWidth={STROKE_WIDTH}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
