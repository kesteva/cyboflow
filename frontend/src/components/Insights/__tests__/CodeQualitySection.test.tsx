/**
 * CodeQualitySection tests (TASK-291 tally-first redesign).
 *
 * The insights store is mocked to supply a fixed `qualityFindings` array; the
 * REAL shared `classifyQualityFinding` / `computeCodeQualityTally` run (not
 * mocked) so this asserts the component's default TALLY render and its
 * drill-down wiring against the shared aggregation, never a re-implementation.
 *
 * Coverage:
 *   - Default render shows tallies only — no `quality-finding-row` is mounted,
 *     and per-bucket badge counts match the bucket totals (unchanged contract
 *     from the pre-redesign flat list).
 *   - Category / severity / source / recurring-title tallies render and are
 *     clickable (the exhaustive count math itself is covered by
 *     shared/insights/__tests__/codeQualityTally.test.ts).
 *   - Clicking a tally cell opens a drill-down whose row content (title, meta
 *     line, status chip, severity dot, post-merge lag) matches the ORIGINAL
 *     flat-list rendering contract, and whose count equals the tally.
 *   - Pagination caps a page at 50 rows.
 *   - "Seed compounding with these" calls the store's bulk seed action with
 *     every id in the filtered set (not just the current page).
 *   - A 400+ finding project renders the default tally view without mounting
 *     one row per finding.
 */
import '@testing-library/jest-dom';
import { render, screen, within, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { QualityFinding } from '../../../../../shared/types/insights';
import {
  parseResolutionKind,
  RESOLUTION_PREFIX_PROMOTED,
  RESOLUTION_PREFIX_FIXED,
  RESOLUTION_PREFIX_TRIAGED,
} from '../../../../../shared/types/reviews';

// ---------------------------------------------------------------------------
// Store mock — qualityFindings drives the component; seedCompoundingFromFindingIds
// is a spy so the "Seed compounding" wiring can be asserted without a real store.
// ---------------------------------------------------------------------------

let mockQualityFindings: QualityFinding[] = [];
const mockSeedCompounding = vi.fn().mockResolvedValue(undefined);

function snapshot() {
  return { qualityFindings: mockQualityFindings, seedCompoundingFromFindingIds: mockSeedCompounding };
}

vi.mock('../../../stores/insightsStore', () => {
  const useInsightsStore = (selector: (s: ReturnType<typeof snapshot>) => unknown) =>
    selector(snapshot());
  useInsightsStore.getState = () => snapshot();
  // Mirrors the real store's export exactly (see insightsStore.ts) — the
  // component imports this constant directly, not through the store hook.
  return { useInsightsStore, QUALITY_FINDINGS_LIMIT: 500 };
});

import { CodeQualitySection } from '../CodeQualitySection';

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

function finding(over: Partial<QualityFinding> = {}): QualityFinding {
  return {
    id: 'qf',
    projectId: 1,
    title: 'A finding',
    severity: 'info',
    status: 'pending',
    source: 'agent:executor',
    sourceStep: 'executor',
    category: null,
    locations: [],
    createdAt: '2026-06-10T00:00:00.000Z',
    resolution: null,
    runId: 'run-1',
    runOutcome: null,
    runEndedAt: null,
    workflowName: 'Sprint',
    ...over,
  };
}

beforeEach(() => {
  mockQualityFindings = [];
  mockSeedCompounding.mockClear();
});

// ---------------------------------------------------------------------------
// Default render — tallies only, no per-finding rows.
// ---------------------------------------------------------------------------

describe('CodeQualitySection default render (tallies)', () => {
  it('mounts no finding rows by default, even with data present', () => {
    mockQualityFindings = [
      finding({ id: 'qf-in', title: 'In-flow issue', sourceStep: 'executor' }),
      finding({ id: 'qf-verify', title: 'Caught at verify', sourceStep: 'verify-step' }),
    ];
    render(<CodeQualitySection />);
    expect(screen.queryAllByTestId('quality-finding-row')).toHaveLength(0);
    expect(screen.getByTestId('quality-tally-overview')).toBeInTheDocument();
  });

  it('routes findings into the three bucket columns with correct badge totals', () => {
    mockQualityFindings = [
      finding({ id: 'qf-in', title: 'In-flow issue', sourceStep: 'executor' }),
      finding({ id: 'qf-verify', title: 'Caught at verify', sourceStep: 'verify-step' }),
      finding({
        id: 'qf-post',
        title: 'Regression after merge',
        sourceStep: 'executor',
        runOutcome: 'merged',
        runEndedAt: '2026-06-10T00:00:00.000Z',
        createdAt: '2026-06-11T00:00:00.000Z',
      }),
    ];
    render(<CodeQualitySection />);
    const inCol = screen.getByTestId('quality-column-in_workflow');
    const verifyCol = screen.getByTestId('quality-column-verification');
    const postCol = screen.getByTestId('quality-column-post_merge');
    expect(within(inCol).getByTestId('quality-column-count')).toHaveTextContent('1');
    expect(within(verifyCol).getByTestId('quality-column-count')).toHaveTextContent('1');
    expect(within(postCol).getByTestId('quality-column-count')).toHaveTextContent('1');
  });

  it('shows a per-status tally cell inside a bucket column (Open) with the right count', () => {
    mockQualityFindings = [
      finding({ id: 'a', status: 'pending', sourceStep: 'executor' }),
      finding({ id: 'b', status: 'pending', sourceStep: 'executor' }),
    ];
    render(<CodeQualitySection />);
    expect(screen.getByTestId('quality-tally-in_workflow-open')).toHaveTextContent('2');
  });

  it('shows a quiet placeholder for an empty bucket column', () => {
    mockQualityFindings = [finding({ id: 'qf-only', sourceStep: 'executor' })];
    render(<CodeQualitySection />);
    // in_workflow has the one item; verification + post_merge are empty.
    expect(screen.getAllByTestId('quality-column-empty')).toHaveLength(2);
  });

  it('renders category, severity, and source tally panels', () => {
    mockQualityFindings = [
      finding({ id: 'a', category: 'security', severity: 'error', source: 'agent:eval' }),
    ];
    render(<CodeQualitySection />);
    expect(screen.getByTestId('quality-categories-security')).toBeInTheDocument();
    expect(screen.getByTestId('quality-severities-error')).toBeInTheDocument();
    expect(screen.getByTestId('quality-sources-agent:eval')).toBeInTheDocument();
  });

  it('collapses build-break-group sources into one tally line', () => {
    mockQualityFindings = [
      finding({ id: 'a', source: 'build-break-group:run-1:aaa' }),
      finding({ id: 'b', source: 'build-break-group:run-2:bbb' }),
    ];
    render(<CodeQualitySection />);
    expect(screen.getByTestId('quality-sources-build-break-group')).toHaveTextContent('2');
  });

  it('renders recurring titles normalized (build-break prefix + run id stripped)', () => {
    mockQualityFindings = [
      finding({
        id: 'a',
        title: 'Shared build break (2 lanes): TS2304 cannot find name foo',
      }),
      finding({
        id: 'b',
        title: 'Shared build break (5 lanes): TS2304 cannot find name foo',
      }),
    ];
    render(<CodeQualitySection />);
    const row = screen.getByTestId('quality-recurring-title-0');
    expect(row).toHaveTextContent('TS2304 cannot find name foo');
    expect(row).toHaveTextContent('2');
  });

  it('renders 400+ findings without mounting one row per finding', () => {
    mockQualityFindings = Array.from({ length: 471 }, (_v, i) =>
      finding({ id: `qf-${i}`, title: `Finding ${i}`, sourceStep: 'executor' }),
    );
    render(<CodeQualitySection />);
    expect(screen.queryAllByTestId('quality-finding-row')).toHaveLength(0);
    expect(screen.getByTestId('quality-column-in_workflow')).toHaveTextContent('471');
  });
});

// ---------------------------------------------------------------------------
// Drill-down — clicking a tally cell.
// ---------------------------------------------------------------------------

describe('CodeQualitySection drill-down', () => {
  it('opens a filtered list whose count equals the tally, and hides the overview', () => {
    mockQualityFindings = [
      finding({ id: 'a', status: 'pending', sourceStep: 'executor' }),
      finding({ id: 'b', status: 'pending', sourceStep: 'executor' }),
      finding({ id: 'c', status: 'resolved', resolution: 'fixed:x', sourceStep: 'executor' }),
    ];
    render(<CodeQualitySection />);
    fireEvent.click(screen.getByTestId('quality-tally-in_workflow-open'));

    expect(screen.queryByTestId('quality-tally-overview')).not.toBeInTheDocument();
    const drilldown = screen.getByTestId('quality-drilldown');
    expect(within(drilldown).getByTestId('quality-drilldown-count')).toHaveTextContent('2');
    expect(within(drilldown).getAllByTestId('quality-finding-row')).toHaveLength(2);
  });

  it('renders the original row content (title, meta line, status chip, severity dot) in the drill-down', () => {
    mockQualityFindings = [
      finding({
        id: 'qf-meta',
        title: 'Has meta',
        severity: 'error',
        sourceStep: 'executor',
        workflowName: 'Sprint',
        locations: [{ path: 'src/foo.ts', line: 42 }],
      }),
    ];
    render(<CodeQualitySection />);
    fireEvent.click(screen.getByTestId('quality-tally-in_workflow-open'));

    const row = screen.getByTestId('quality-finding-row');
    expect(within(row).getByText('Has meta')).toBeInTheDocument();
    expect(within(row).getByText('src/foo.ts · executor · Sprint')).toBeInTheDocument();
    expect(within(row).getByTestId('quality-status-chip')).toHaveTextContent('Open');
    expect(within(row).getByTestId('quality-severity-dot').className).toContain('bg-status-error');
  });

  it('refines the resolved status chip by resolution prefix inside the drill-down', () => {
    mockQualityFindings = [
      finding({
        id: 'qf-r',
        status: 'resolved',
        resolution: 'promoted:tsk_abc',
        sourceStep: 'executor',
      }),
    ];
    render(<CodeQualitySection />);
    fireEvent.click(screen.getByTestId('quality-tally-in_workflow-promoted'));
    expect(screen.getByTestId('quality-status-chip')).toHaveTextContent('Promoted');
  });

  it('ignores a stray resolution prefix on a pending or dismissed finding (status wins over resolution)', () => {
    // A resolution string can be left over from a prior state (or set by mistake)
    // on a non-resolved item; chipLabel() keys on status FIRST, so it must never
    // leak a Fixed/Promoted label onto an Open or Dismissed chip.
    mockQualityFindings = [
      finding({ id: 'qf-pending', status: 'pending', resolution: 'fixed:should be ignored', sourceStep: 'executor' }),
      finding({ id: 'qf-dismissed', status: 'dismissed', resolution: 'promoted:should be ignored', sourceStep: 'executor' }),
    ];
    render(<CodeQualitySection />);

    fireEvent.click(screen.getByTestId('quality-tally-in_workflow-open'));
    expect(screen.getByTestId('quality-status-chip')).toHaveTextContent('Open');

    fireEvent.click(screen.getByTestId('quality-drilldown-back'));
    fireEvent.click(screen.getByTestId('quality-tally-in_workflow-dismissed'));
    expect(screen.getByTestId('quality-status-chip')).toHaveTextContent('Dismissed');
  });

  it('shows the post-merge lag annotation for a post-merge row', () => {
    mockQualityFindings = [
      finding({
        id: 'qf-pm',
        sourceStep: 'executor',
        runOutcome: 'merged',
        runEndedAt: '2026-06-08T00:00:00.000Z',
        createdAt: '2026-06-10T00:00:00.000Z', // 2 days later
      }),
    ];
    render(<CodeQualitySection />);
    fireEvent.click(screen.getByTestId('quality-tally-post_merge-open'));
    const row = screen.getByTestId('quality-finding-row');
    expect(row.querySelector('.text-\\[10px\\]')?.textContent).toContain('2d after merge');
  });

  it('falls back to the category label as post-merge meta when there is no run linkage to compute a lag', () => {
    mockQualityFindings = [
      finding({
        id: 'qf-pm-cat',
        category: 'post-merge-bug',
        sourceStep: 'executor',
        runOutcome: null,
        runEndedAt: null,
      }),
    ];
    render(<CodeQualitySection />);
    fireEvent.click(screen.getByTestId('quality-tally-post_merge-open'));
    const row = screen.getByTestId('quality-finding-row');
    expect(row.querySelector('.text-\\[10px\\]')?.textContent).toContain('post-merge-bug');
  });

  /**
   * Render a single post-merge-bucket finding, drill into it, and return its
   * rendered meta-line text (or null when the row has no meta at all). Calls
   * `cleanup()` first so a test that invokes this more than once does not
   * leave two mounted trees behind (RTL's afterEach cleanup only runs
   * between `it()` blocks, not within one).
   */
  function postMergeMetaTextFor(over: Partial<QualityFinding>): string | null {
    cleanup();
    mockQualityFindings = [finding({ id: 'qf-pm', sourceStep: 'executor', ...over })];
    render(<CodeQualitySection />);
    fireEvent.click(screen.getByTestId('quality-tally-post_merge-open'));
    const row = screen.getByTestId('quality-finding-row');
    return row.querySelector('.text-\\[10px\\]')?.textContent ?? null;
  }

  it("appends '<N>h after merge' for a sub-day (under 24h) lag", () => {
    const meta = postMergeMetaTextFor({
      runOutcome: 'merged',
      runEndedAt: '2026-06-10T00:00:00.000Z',
      createdAt: '2026-06-10T05:00:00.000Z', // 5 hours later
    });
    expect(meta).toContain('5h after merge');
    // Sub-day lags use the hour label, never the day label.
    expect(meta).not.toContain('d after merge');
  });

  it('floors the lag to whole days (≥24h) and whole hours (<24h)', () => {
    // 50h -> 2d (floor of 2.08).
    expect(
      postMergeMetaTextFor({
        runOutcome: 'merged',
        runEndedAt: '2026-06-08T00:00:00.000Z',
        createdAt: '2026-06-10T02:00:00.000Z',
      }),
    ).toContain('2d after merge');
    // 90m -> 1h (floor of 1.5).
    expect(
      postMergeMetaTextFor({
        runOutcome: 'merged',
        runEndedAt: '2026-06-10T00:00:00.000Z',
        createdAt: '2026-06-10T01:30:00.000Z',
      }),
    ).toContain('1h after merge');
  });

  it('renders no lag (and no NaN) when the merge stamp is an invalid date', () => {
    const meta = postMergeMetaTextFor({
      runOutcome: 'merged',
      runEndedAt: 'not-a-date',
      createdAt: '2026-06-10T00:00:00.000Z',
      category: 'post-merge-bug', // still post_merge via category -> category fallback shown
    });
    expect(meta).not.toContain('NaN');
    expect(meta).not.toContain('after merge');
    expect(meta).toContain('post-merge-bug');
  });

  it('renders no lag when discovery precedes the merge (createdAt <= runEndedAt)', () => {
    // Such a finding is not post_merge by the time rule; with no category it
    // lands in_workflow instead and carries no lag annotation at all.
    cleanup();
    mockQualityFindings = [
      finding({
        id: 'qf-early',
        sourceStep: 'executor',
        runOutcome: 'merged',
        runEndedAt: '2026-06-10T00:00:00.000Z',
        createdAt: '2026-06-09T00:00:00.000Z',
      }),
    ];
    render(<CodeQualitySection />);
    fireEvent.click(screen.getByTestId('quality-tally-in_workflow-open'));
    const row = screen.getByTestId('quality-finding-row');
    const meta = row.querySelector('.text-\\[10px\\]')?.textContent ?? '';
    expect(meta).not.toContain('after merge');
    expect(meta).not.toContain('NaN');
  });

  it('does NOT annotate a row in the in-workflow bucket even when it carries merge stamps', () => {
    cleanup();
    mockQualityFindings = [
      finding({
        id: 'qf-inflow',
        sourceStep: 'executor',
        runOutcome: 'merged',
        runEndedAt: '2026-06-10T00:00:00.000Z',
        createdAt: '2026-06-09T00:00:00.000Z', // before the merge -> in_workflow, not post_merge
      }),
    ];
    render(<CodeQualitySection />);
    fireEvent.click(screen.getByTestId('quality-tally-in_workflow-open'));
    const row = screen.getByTestId('quality-finding-row');
    expect(within(row).queryByText(/after merge/)).toBeNull();
  });

  it('does NOT annotate a row in the verification bucket', () => {
    cleanup();
    mockQualityFindings = [finding({ id: 'qf-verify', sourceStep: 'verify-step' })];
    render(<CodeQualitySection />);
    fireEvent.click(screen.getByTestId('quality-tally-verification-open'));
    const row = screen.getByTestId('quality-finding-row');
    expect(within(row).queryByText(/after merge/)).toBeNull();
  });

  it('drills into a category tally and back out to the overview', () => {
    mockQualityFindings = [
      finding({ id: 'a', category: 'security', sourceStep: 'executor' }),
      finding({ id: 'b', category: 'robustness', sourceStep: 'executor' }),
    ];
    render(<CodeQualitySection />);
    fireEvent.click(screen.getByTestId('quality-categories-security'));
    expect(screen.getAllByTestId('quality-finding-row')).toHaveLength(1);
    expect(screen.getByTestId('quality-drilldown')).toHaveTextContent('security');

    fireEvent.click(screen.getByTestId('quality-drilldown-back'));
    expect(screen.getByTestId('quality-tally-overview')).toBeInTheDocument();
    expect(screen.queryByTestId('quality-drilldown')).not.toBeInTheDocument();
  });

  it('caps a drill-down page at 50 rows and pages through the rest', () => {
    mockQualityFindings = Array.from({ length: 120 }, (_v, i) =>
      finding({ id: `qf-${i}`, title: `Finding ${i}`, sourceStep: 'executor' }),
    );
    render(<CodeQualitySection />);
    fireEvent.click(screen.getByTestId('quality-tally-in_workflow-open'));

    expect(screen.getAllByTestId('quality-finding-row')).toHaveLength(50);
    expect(screen.getByTestId('quality-drilldown-count')).toHaveTextContent('120');
    expect(screen.getByTestId('quality-drilldown-page')).toHaveTextContent('Page 1 of 3');

    fireEvent.click(screen.getByTestId('quality-drilldown-next'));
    expect(screen.getAllByTestId('quality-finding-row')).toHaveLength(50);
    expect(screen.getByTestId('quality-drilldown-page')).toHaveTextContent('Page 2 of 3');

    fireEvent.click(screen.getByTestId('quality-drilldown-next'));
    expect(screen.getAllByTestId('quality-finding-row')).toHaveLength(20);
    expect(screen.getByTestId('quality-drilldown-page')).toHaveTextContent('Page 3 of 3');
    expect(screen.getByTestId('quality-drilldown-next')).toBeDisabled();
  });

  it('shows a quiet empty state when a filter matches nothing', () => {
    // Every finding is 'info' severity; SEVERITY_KEYS is a FIXED axis
    // (error/warning/info/unset), so the by-severity panel still renders a
    // clickable 'error' bar at count 0 (unlike TallyRow, TallyBarPanel's
    // bars carry no disabled={count===0} guard) — a real, reachable path to
    // an empty drill-down, not merely a defensive state.
    mockQualityFindings = [finding({ id: 'a', severity: 'info', sourceStep: 'executor' })];
    render(<CodeQualitySection />);
    fireEvent.click(screen.getByTestId('quality-severities-error'));

    expect(screen.getByTestId('quality-drilldown-count')).toHaveTextContent('0');
    expect(screen.getByTestId('quality-drilldown-empty')).toBeInTheDocument();
    expect(screen.queryAllByTestId('quality-finding-row')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// parseResolutionKind matrix — the shared classifier chipLabel()/postMergeMeta
// key on. Dedicated coverage (not just the indirect exercise through the
// drill-down chip-text assertions above) so a change to the prefix matching
// itself gets caught here rather than only surfacing as a wrong chip label.
// ---------------------------------------------------------------------------

describe('parseResolutionKind', () => {
  it('returns null for a null (still-pending) resolution', () => {
    expect(parseResolutionKind(null)).toBeNull();
  });

  it('classifies each known prefix', () => {
    expect(parseResolutionKind(`${RESOLUTION_PREFIX_PROMOTED}tsk_1`)).toBe('promoted');
    expect(parseResolutionKind(`${RESOLUTION_PREFIX_FIXED}patched`)).toBe('fixed');
    expect(parseResolutionKind(`${RESOLUTION_PREFIX_TRIAGED}reviewed`)).toBe('triaged');
  });

  it('classifies a prefix with an empty note (the colon alone is enough)', () => {
    expect(parseResolutionKind(RESOLUTION_PREFIX_FIXED)).toBe('fixed');
  });

  it("returns 'other' for free-text and unknown-prefix resolutions", () => {
    expect(parseResolutionKind('looks fine to me')).toBe('other');
    expect(parseResolutionKind('wontfix:later')).toBe('other');
    expect(parseResolutionKind('')).toBe('other');
    // Prefix must be LEADING — a mid-string occurrence does not match.
    expect(parseResolutionKind('see fixed: note below')).toBe('other');
  });
});

// ---------------------------------------------------------------------------
// Seed compounding.
// ---------------------------------------------------------------------------

describe('CodeQualitySection "Seed compounding with these"', () => {
  it('calls seedCompoundingFromFindingIds with EVERY id in the filtered set, not just the current page', () => {
    mockQualityFindings = Array.from({ length: 60 }, (_v, i) =>
      finding({ id: `qf-${i}`, sourceStep: 'executor' }),
    );
    render(<CodeQualitySection />);
    fireEvent.click(screen.getByTestId('quality-tally-in_workflow-open'));
    fireEvent.click(screen.getByTestId('quality-drilldown-seed'));

    expect(mockSeedCompounding).toHaveBeenCalledTimes(1);
    const idsPassed = mockSeedCompounding.mock.calls[0][0] as string[];
    expect(idsPassed).toHaveLength(60);
  });

  it('is enabled for a populated drill-down', () => {
    mockQualityFindings = [finding({ id: 'a', sourceStep: 'executor' })];
    render(<CodeQualitySection />);
    fireEvent.click(screen.getByTestId('quality-tally-in_workflow-open'));
    expect(screen.getByTestId('quality-drilldown-seed')).not.toBeDisabled();
  });

  it('is disabled when the filtered set is empty', () => {
    // Same reachable-empty-state path as the drill-down suite above: a
    // zero-count severity bar is still clickable, and the seed button binds
    // directly to `pageResult.total === 0`.
    mockQualityFindings = [finding({ id: 'a', severity: 'info', sourceStep: 'executor' })];
    render(<CodeQualitySection />);
    fireEvent.click(screen.getByTestId('quality-severities-error'));
    expect(screen.getByTestId('quality-drilldown-seed')).toBeDisabled();
  });
});
