/**
 * Unit tests for the dependency-free Insights chart primitives.
 *
 * Covers the load-bearing math + edge cases called out in the task:
 *   - BarRow width math: zero/negative max → 0%, value > max → clamped 100%,
 *     2dp rounding, valueLabel fallback, accessible aria-label.
 *   - Sparkline: <2 points → empty <svg> of the same size (layout stability),
 *     >40 points → average-pooled to exactly 40 polyline coordinate pairs,
 *     flat series → all y on the vertical midline.
 *
 * The width/coordinate math is asserted against the EXPORTED pure helpers
 * (barFillPct / averagePool / buildPolylinePoints) so the numbers are pinned at
 * the source, with a few render-level checks to confirm the helpers are actually
 * wired into the DOM.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BarRow, barFillPct } from '../BarRow';
import {
  Sparkline,
  averagePool,
  buildPolylinePoints,
  MAX_POINTS,
} from '../Sparkline';

describe('barFillPct', () => {
  it('returns 0 when max is zero (no divide-by-zero)', () => {
    expect(barFillPct(5, 0)).toBe(0);
  });

  it('returns 0 when max is negative', () => {
    expect(barFillPct(5, -10)).toBe(0);
  });

  it('returns 0 for a zero value against a positive max', () => {
    expect(barFillPct(0, 100)).toBe(0);
  });

  it('computes a proportional percentage', () => {
    expect(barFillPct(25, 100)).toBe(25);
    expect(barFillPct(3, 8)).toBe(37.5);
  });

  it('rounds to 2 decimal places', () => {
    // 1/3 -> 33.3333… -> 33.33
    expect(barFillPct(1, 3)).toBe(33.33);
  });

  it('clamps values greater than max to 100', () => {
    expect(barFillPct(150, 100)).toBe(100);
  });
});

describe('BarRow', () => {
  it('renders the fill width from barFillPct', () => {
    render(<BarRow label="executor" value={3} max={8} />);
    const row = screen.getByRole('img', { name: 'executor: 3' });
    // The fill div is the inner div carrying an explicit width style.
    const fill = row.querySelector('div[style*="width"]');
    expect(fill).not.toBeNull();
    expect((fill as HTMLElement).style.width).toBe('37.5%');
  });

  it('collapses the fill to 0% when max is non-positive', () => {
    render(<BarRow label="empty" value={5} max={0} />);
    const fill = screen.getByRole('img').querySelector('div[style*="width"]');
    expect((fill as HTMLElement).style.width).toBe('0%');
  });

  it('falls back to String(value) when no valueLabel is given', () => {
    render(<BarRow label="planner" value={42} max={100} />);
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'planner: 42' })).toBeInTheDocument();
  });

  it('uses valueLabel for both the display cell and the aria-label', () => {
    render(<BarRow label="cost" value={1234} max={2000} valueLabel="$12.34" />);
    expect(screen.getByText('$12.34')).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: 'cost: $12.34' }),
    ).toBeInTheDocument();
  });

  it('applies a custom accentClass to the fill div', () => {
    render(
      <BarRow label="errors" value={1} max={2} accentClass="bg-status-error" />,
    );
    const fill = screen.getByRole('img').querySelector('div[style*="width"]');
    expect(fill).toHaveClass('bg-status-error');
  });
});

describe('averagePool', () => {
  it('pools a longer series into exactly the requested bucket count', () => {
    const input = Array.from({ length: 90 }, (_, i) => i);
    expect(averagePool(input, MAX_POINTS)).toHaveLength(40);
  });

  it('averages the samples within each bucket', () => {
    // 4 values into 2 buckets -> [avg(0,1), avg(2,3)] = [0.5, 2.5]
    expect(averagePool([0, 1, 2, 3], 2)).toEqual([0.5, 2.5]);
  });

  it('returns a copy unchanged when length <= buckets', () => {
    const input = [5, 6, 7];
    const out = averagePool(input, 40);
    expect(out).toEqual([5, 6, 7]);
    expect(out).not.toBe(input); // defensive copy, not the same reference
  });

  it('covers every sample exactly once (sum is preserved across uneven buckets)', () => {
    // 7 values into 3 buckets: bucket sizes differ by one, but the grand total
    // (sum of bucket means weighted by size) must equal the input sum.
    const input = [1, 2, 3, 4, 5, 6, 7];
    const pooled = averagePool(input, 3);
    expect(pooled).toHaveLength(3);
    // bucket boundaries: [0,2) [2,4) [4,7) -> means 1.5, 3.5, 6
    expect(pooled).toEqual([1.5, 3.5, 6]);
  });
});

describe('buildPolylinePoints', () => {
  it('emits one coordinate pair per input value', () => {
    const coords = buildPolylinePoints([1, 2, 3, 4], 120, 28);
    expect(coords).toHaveLength(4);
  });

  it('spaces x evenly from 0 to width', () => {
    const coords = buildPolylinePoints([1, 2, 3], 120, 28);
    expect(coords.map(([x]) => x)).toEqual([0, 60, 120]);
  });

  it('maps a flat series to the vertical midline', () => {
    const height = 28;
    const mid = height / 2; // INSET cancels: (2 + (28-2)) / 2 = 14
    const coords = buildPolylinePoints([5, 5, 5, 5], 120, height);
    for (const [, y] of coords) {
      expect(y).toBe(mid);
    }
  });

  it('maps an all-zero series to the midline (zero range, not NaN)', () => {
    const coords = buildPolylinePoints([0, 0, 0], 100, 20);
    for (const [, y] of coords) {
      expect(y).toBe(10);
      expect(Number.isNaN(y)).toBe(false);
    }
  });

  it('places the data maximum at the top inset and the minimum at the bottom', () => {
    const height = 30;
    const coords = buildPolylinePoints([0, 10], 100, height);
    // min=0 -> bottom (height - INSET = 28); max=10 -> top (INSET = 2).
    expect(coords[0][1]).toBe(28);
    expect(coords[1][1]).toBe(2);
  });
});

describe('Sparkline', () => {
  it('renders an empty <svg> of the same size for fewer than 2 points', () => {
    const { container } = render(<Sparkline points={[7]} width={120} height={28} />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('width')).toBe('120');
    expect(svg?.getAttribute('height')).toBe('28');
    expect(svg?.querySelector('polyline')).toBeNull();
    expect(svg?.getAttribute('aria-label')).toBe('trend of 1 points');
  });

  it('renders an empty <svg> for an empty series', () => {
    const { container } = render(<Sparkline points={[]} />);
    const svg = container.querySelector('svg');
    expect(svg?.querySelector('polyline')).toBeNull();
    expect(svg?.getAttribute('aria-label')).toBe('trend of 0 points');
  });

  it('pools 90 input points down to 40 polyline coordinate pairs', () => {
    const points = Array.from({ length: 90 }, (_, i) => i);
    const { container } = render(<Sparkline points={points} />);
    const polyline = container.querySelector('polyline');
    expect(polyline).not.toBeNull();
    const pairs = polyline!.getAttribute('points')!.trim().split(/\s+/);
    expect(pairs).toHaveLength(40);
    // aria-label reports the ORIGINAL count, not the pooled one.
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toBe(
      'trend of 90 points',
    );
  });

  it('does not pool a series of 40 or fewer points', () => {
    const points = Array.from({ length: 40 }, (_, i) => i);
    const { container } = render(<Sparkline points={points} />);
    const pairs = container
      .querySelector('polyline')!
      .getAttribute('points')!
      .trim()
      .split(/\s+/);
    expect(pairs).toHaveLength(40);
  });

  it('renders a flat-series polyline on the midline', () => {
    const { container } = render(
      <Sparkline points={[3, 3, 3, 3]} width={120} height={28} />,
    );
    const pairs = container
      .querySelector('polyline')!
      .getAttribute('points')!
      .trim()
      .split(/\s+/);
    // every y coordinate is the midline (14)
    for (const pair of pairs) {
      const [, y] = pair.split(',');
      expect(Number(y)).toBe(14);
    }
  });

  it('applies the default success stroke class and non-scaling stroke', () => {
    const { container } = render(<Sparkline points={[1, 2, 3]} />);
    const polyline = container.querySelector('polyline');
    expect(polyline).toHaveClass('stroke-status-success');
    expect(polyline?.getAttribute('vector-effect')).toBe('non-scaling-stroke');
    expect(polyline?.getAttribute('fill')).toBe('none');
  });

  it('honors a custom strokeClass', () => {
    const { container } = render(
      <Sparkline points={[1, 2]} strokeClass="stroke-interactive" />,
    );
    expect(container.querySelector('polyline')).toHaveClass('stroke-interactive');
  });
});
