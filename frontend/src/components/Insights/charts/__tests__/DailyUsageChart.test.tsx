/**
 * Unit tests for DailyUsageChart — the 30-day per-model stacked-bar chart.
 *
 * Covers the load-bearing presentation contract:
 *   - utcDayKeys: emits exactly `days` UTC 'YYYY-MM-DD' keys, oldest first and
 *     today last, off the UTC midnight of the reference date.
 *   - modelLegend: ranks models by grand-total tokens DESC (stable tie-break),
 *     assigns palette colors by that rank.
 *   - Render: a multi-day / multi-model fixture draws one <rect> segment per
 *     (day, model) that has tokens, each with a hover <title>, plus a legend
 *     entry (swatch + shortened name + compact total) per model.
 *   - The single-model case stacks one segment per populated day.
 *   - The empty state (no points) renders the muted line, not the SVG.
 *
 * The axis/rank math is asserted against the EXPORTED pure helpers (utcDayKeys /
 * modelLegend) so the numbers are pinned at the source, with render-level checks
 * confirming the helpers are wired into the DOM.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { DailyModelUsagePoint } from '../../../../../../shared/types/insights';
import {
  DailyUsageChart,
  PALETTE,
  utcDayKeys,
  modelLegend,
} from '../DailyUsageChart';

/** Build a usage point with the token total derived from input+output. */
function point(
  day: string,
  model: string,
  input: number,
  output: number,
): DailyModelUsagePoint {
  return {
    day,
    model,
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    assistantMessageCount: 1,
  };
}

describe('utcDayKeys', () => {
  it('emits exactly `days` keys, oldest first and today last', () => {
    const keys = utcDayKeys(3, new Date('2026-06-12T15:00:00Z'));
    expect(keys).toEqual(['2026-06-10', '2026-06-11', '2026-06-12']);
  });

  it('uses the UTC date regardless of the time-of-day on the reference date', () => {
    // Late-evening UTC still maps to the same UTC calendar day.
    const keys = utcDayKeys(1, new Date('2026-06-12T23:59:59Z'));
    expect(keys).toEqual(['2026-06-12']);
  });

  it('defaults the window to a 30-key axis when given 30 days', () => {
    expect(utcDayKeys(30, new Date('2026-06-12T00:00:00Z'))).toHaveLength(30);
  });
});

describe('modelLegend', () => {
  it('ranks models by grand-total tokens DESC and assigns palette by rank', () => {
    const points = [
      point('2026-06-10', 'claude-sonnet', 10, 10), // 20
      point('2026-06-11', 'claude-opus', 100, 100), // 200
      point('2026-06-11', 'claude-sonnet', 5, 5), // +10 -> sonnet 30
    ];
    const legend = modelLegend(points);
    expect(legend.map((e) => e.model)).toEqual(['claude-opus', 'claude-sonnet']);
    expect(legend.map((e) => e.totalTokens)).toEqual([200, 30]);
    expect(legend[0].color).toBe(PALETTE[0]);
    expect(legend[1].color).toBe(PALETTE[1]);
  });

  it('breaks ties on model id ascending for a stable order', () => {
    const points = [
      point('2026-06-10', 'zeta', 50, 0),
      point('2026-06-10', 'alpha', 50, 0),
    ];
    expect(modelLegend(points).map((e) => e.model)).toEqual(['alpha', 'zeta']);
  });

  it('wraps the palette when there are more models than colors', () => {
    const points = Array.from({ length: PALETTE.length + 1 }, (_, i) =>
      // descending totals so rank == index
      point('2026-06-10', `m${i}`, (PALETTE.length + 1 - i) * 100, 0),
    );
    const legend = modelLegend(points);
    expect(legend[PALETTE.length].color).toBe(PALETTE[0]);
  });
});

describe('DailyUsageChart', () => {
  it('renders one titled <rect> segment per populated (day, model) across a multi-model fixture', () => {
    const today = new Date();
    const [d0, d1] = utcDayKeys(2, today);
    const points = [
      point(d0, 'claude-opus', 100, 100), // 200
      point(d0, 'claude-sonnet', 20, 20), // 40
      point(d1, 'claude-opus', 50, 50), // 100
    ];
    const { container } = render(<DailyUsageChart points={points} days={2} />);

    expect(screen.getByTestId('daily-usage-chart')).toBeInTheDocument();
    const rects = container.querySelectorAll('svg rect');
    // 3 populated (day, model) buckets -> 3 segments.
    expect(rects).toHaveLength(3);

    const titles = [...container.querySelectorAll('svg rect title')].map(
      (t) => t.textContent,
    );
    expect(titles).toContain(`claude-opus · ${d0} · 200 tokens`);
    expect(titles).toContain(`claude-sonnet · ${d0} · 40 tokens`);
    expect(titles).toContain(`claude-opus · ${d1} · 100 tokens`);

    // Legend: one entry per model, shortened name (no 'claude-') + compact total.
    const legend = screen.getByTestId('daily-usage-legend');
    const items = within(legend).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(legend).getByText('opus')).toBeInTheDocument();
    expect(within(legend).getByText('sonnet')).toBeInTheDocument();
    // opus total 300 -> '300'; sonnet 40 -> '40'.
    expect(within(legend).getByText('300')).toBeInTheDocument();
    expect(within(legend).getByText('40')).toBeInTheDocument();
  });

  it('compacts large legend totals to the k-form', () => {
    const today = new Date();
    const [day] = utcDayKeys(1, today);
    render(
      <DailyUsageChart points={[point(day, 'claude-opus', 6000, 6000)]} days={1} />,
    );
    // 12000 -> '12k' in the legend total (the y-axis max label also reads 12k,
    // so scope the assertion to the legend).
    const legend = screen.getByTestId('daily-usage-legend');
    expect(within(legend).getByText('12k')).toBeInTheDocument();
  });

  it('renders a single-model fixture as one segment per populated day', () => {
    const today = new Date();
    const keys = utcDayKeys(3, today);
    const points = [
      point(keys[0], 'claude-haiku', 10, 10),
      point(keys[2], 'claude-haiku', 30, 30),
      // keys[1] intentionally empty -> a gap slot, no segment.
    ];
    const { container } = render(<DailyUsageChart points={points} days={3} />);
    expect(container.querySelectorAll('svg rect')).toHaveLength(2);
    const legend = screen.getByTestId('daily-usage-legend');
    expect(within(legend).getAllByRole('listitem')).toHaveLength(1);
    expect(within(legend).getByText('haiku')).toBeInTheDocument();
  });

  it('ignores points whose day falls outside the visible window', () => {
    const today = new Date();
    const [inWindow] = utcDayKeys(1, today);
    const points = [
      point(inWindow, 'claude-opus', 10, 10),
      point('1999-01-01', 'claude-opus', 999, 999), // far outside -> dropped
    ];
    const { container } = render(<DailyUsageChart points={points} days={1} />);
    // Only the in-window bucket draws a segment.
    expect(container.querySelectorAll('svg rect')).toHaveLength(1);
  });

  it('renders the muted empty state (no SVG) when there are no points', () => {
    const { container } = render(<DailyUsageChart points={[]} days={30} />);
    const el = screen.getByTestId('daily-usage-chart');
    expect(el.tagName).toBe('P');
    expect(el).toHaveTextContent(
      'No token usage recorded in the last 30 days.',
    );
    expect(container.querySelector('svg')).toBeNull();
  });

  it('reflects a custom `days` count in the empty-state copy', () => {
    render(<DailyUsageChart points={[]} days={7} />);
    expect(
      screen.getByText('No token usage recorded in the last 7 days.'),
    ).toBeInTheDocument();
  });
});
