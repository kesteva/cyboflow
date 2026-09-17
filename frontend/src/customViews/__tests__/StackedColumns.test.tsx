/**
 * StackedColumns — the GENERIC contract of the chart extracted from
 * `DailyUsageChart` (docs/proposals/CUSTOM-VIEWS.md §5.3).
 *
 * The daily-usage tests already pin the adapter's behaviour; these pin what the
 * tier-2 `columns` shape relies on and the adapter never exercises: an axis
 * derived from the rows themselves (a `group`ed source already emits one row
 * per bucket, so there are no gaps to fill), arbitrary field names, and the
 * numeric coercion that a SQLite `Scalar` makes unavoidable.
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { StackedColumns, seriesLegend } from '../shape/StackedColumns';

const PALETTE = ['#aaa', '#bbb', '#ccc'];

const ROWS = [
  { bucket: '2026-09-01', model: 'opus', tokens: 100 },
  { bucket: '2026-09-01', model: 'sonnet', tokens: 40 },
  { bucket: '2026-09-02', model: 'opus', tokens: 60 },
];

describe('seriesLegend', () => {
  it('ranks series by grand total DESC and assigns palette colors by rank', () => {
    expect(seriesLegend(ROWS, 'model', 'tokens', PALETTE)).toEqual([
      { series: 'opus', total: 160, color: '#aaa' },
      { series: 'sonnet', total: 40, color: '#bbb' },
    ]);
  });

  it('breaks ties on the series name so the order is stable', () => {
    const tied = [
      { s: 'b', v: 5 },
      { s: 'a', v: 5 },
    ];
    expect(seriesLegend(tied, 's', 'v', PALETTE).map((e) => e.series)).toEqual(['a', 'b']);
  });

  it('coerces string magnitudes and treats junk as zero', () => {
    const rows = [
      { s: 'a', v: '10' },
      { s: 'a', v: 'not-a-number' },
      { s: 'a', v: null },
    ];
    expect(seriesLegend(rows, 's', 'v', PALETTE)[0].total).toBe(10);
  });

  it('wraps the palette when there are more series than colors', () => {
    const rows = [
      { s: 'a', v: 4 },
      { s: 'b', v: 3 },
      { s: 'c', v: 2 },
      { s: 'd', v: 1 },
    ];
    expect(seriesLegend(rows, 's', 'v', PALETTE)[3].color).toBe('#aaa');
  });
});

describe('StackedColumns', () => {
  it('derives the axis from the rows when no xCategories are given', () => {
    const { container } = render(
      <StackedColumns rows={ROWS} x="bucket" series="model" y="tokens" palette={PALETTE} />,
    );
    // Two columns, three non-zero segments.
    expect(screen.getByTestId('stacked-columns-hover-2026-09-01')).toBeInTheDocument();
    expect(screen.getByTestId('stacked-columns-hover-2026-09-02')).toBeInTheDocument();
    expect(container.querySelectorAll('svg rect')).toHaveLength(3);
  });

  it('keeps an empty slot for an xCategory with no rows', () => {
    const { container } = render(
      <StackedColumns
        rows={ROWS}
        x="bucket"
        series="model"
        y="tokens"
        palette={PALETTE}
        xCategories={['2026-08-31', '2026-09-01', '2026-09-02']}
      />,
    );
    expect(screen.getByTestId('stacked-columns-hover-2026-08-31')).toBeInTheDocument();
    // The gap adds a slot, not a segment.
    expect(container.querySelectorAll('svg rect')).toHaveLength(3);
  });

  it('ignores rows outside the declared axis', () => {
    const { container } = render(
      <StackedColumns
        rows={ROWS}
        x="bucket"
        series="model"
        y="tokens"
        palette={PALETTE}
        xCategories={['2026-09-02']}
      />,
    );
    expect(container.querySelectorAll('svg rect')).toHaveLength(1);
  });

  it('renders a tooltip with each series and the column total on hover', () => {
    render(
      <StackedColumns
        rows={ROWS}
        x="bucket"
        series="model"
        y="tokens"
        palette={PALETTE}
        formatValue={(n) => `${n}t`}
        formatSeries={(s) => s.toUpperCase()}
      />,
    );
    fireEvent.mouseEnter(screen.getByTestId('stacked-columns-hover-2026-09-01'));
    const tip = screen.getByTestId('stacked-columns-tooltip');
    expect(tip).toHaveTextContent('OPUS');
    expect(tip).toHaveTextContent('100t');
    expect(tip).toHaveTextContent('140t'); // the column total
  });

  it('renders the empty label instead of a zero-height plot when there are no rows', () => {
    const { container } = render(
      <StackedColumns
        rows={[]}
        x="bucket"
        series="model"
        y="tokens"
        palette={PALETTE}
        emptyLabel="Nothing charted."
      />,
    );
    expect(screen.getByTestId('stacked-columns-chart')).toHaveTextContent('Nothing charted.');
    expect(container.querySelector('svg')).toBeNull();
  });

  it('honours the test-id prefix so an adapter keeps its own hooks', () => {
    render(
      <StackedColumns
        rows={ROWS}
        x="bucket"
        series="model"
        y="tokens"
        palette={PALETTE}
        testIdPrefix="widget-columns-i1"
      />,
    );
    expect(screen.getByTestId('widget-columns-i1-chart')).toBeInTheDocument();
    expect(screen.getByTestId('widget-columns-i1-legend')).toBeInTheDocument();
  });
});
