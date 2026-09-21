/**
 * Unit tests for codeQualityTally — the pure aggregation backing the Insights
 * "03 Code quality" tally-first redesign (TASK-291). Fixture-driven: build a
 * small set of QualityFindings covering every bucket/status/category/severity/
 * source combination and assert the tally + filter + pagination helpers
 * against hand-counted expectations.
 */
import { describe, it, expect } from 'vitest';
import type { QualityFinding } from '../../types/insights';
import {
  classifyTallyStatus,
  normalizeFindingSource,
  normalizeFindingTitle,
  computeRecurringTitles,
  computeWeeklyTrend,
  computeCodeQualityTally,
  filterQualityFindings,
  matchesQualityFindingFilter,
  paginate,
  CATEGORY_UNSET,
  SEVERITY_UNSET,
  SOURCE_UNKNOWN,
  QUALITY_DRILLDOWN_PAGE_SIZE,
} from '../codeQualityTally';

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

// ---------------------------------------------------------------------------
// classifyTallyStatus — mirrors CodeQualitySection's chipLabel exactly.
// ---------------------------------------------------------------------------

describe('classifyTallyStatus', () => {
  it('maps pending -> open, dismissed -> dismissed regardless of resolution', () => {
    expect(classifyTallyStatus(finding({ status: 'pending' }))).toBe('open');
    expect(
      classifyTallyStatus(finding({ status: 'dismissed', resolution: 'fixed:ignored' })),
    ).toBe('dismissed');
  });

  it('refines resolved by the resolution prefix', () => {
    expect(classifyTallyStatus(finding({ status: 'resolved', resolution: 'fixed:x' }))).toBe('fixed');
    expect(classifyTallyStatus(finding({ status: 'resolved', resolution: 'triaged:x' }))).toBe(
      'triaged',
    );
    expect(classifyTallyStatus(finding({ status: 'resolved', resolution: 'promoted:tsk_1' }))).toBe(
      'promoted',
    );
  });

  it('falls back to the generic resolved for free-text / null resolutions', () => {
    expect(classifyTallyStatus(finding({ status: 'resolved', resolution: 'looks fine' }))).toBe(
      'resolved',
    );
    expect(classifyTallyStatus(finding({ status: 'resolved', resolution: null }))).toBe('resolved');
  });
});

// ---------------------------------------------------------------------------
// normalizeFindingSource — collapses build-break-group:<id>:<hash> noise.
// ---------------------------------------------------------------------------

describe('normalizeFindingSource', () => {
  it('returns the unknown sentinel for a null source', () => {
    expect(normalizeFindingSource(null)).toBe(SOURCE_UNKNOWN);
  });

  it('leaves stable agent/visual-verify sources unchanged', () => {
    expect(normalizeFindingSource('agent:eval')).toBe('agent:eval');
    expect(normalizeFindingSource('agent:sprint-review')).toBe('agent:sprint-review');
    expect(normalizeFindingSource('visual-verify')).toBe('visual-verify');
  });

  it('collapses every build-break-group:<runId>:<hash> variant to one key', () => {
    expect(normalizeFindingSource('build-break-group:run-abc:deadbeef')).toBe('build-break-group');
    expect(normalizeFindingSource('build-break-group:run-xyz:cafef00d')).toBe('build-break-group');
  });
});

// ---------------------------------------------------------------------------
// normalizeFindingTitle — strips the shared build-break prefix + run ids.
// ---------------------------------------------------------------------------

describe('normalizeFindingTitle', () => {
  it('strips the "Shared build break (N lanes): " prefix', () => {
    expect(normalizeFindingTitle('Shared build break (3 lanes): TS2304: Cannot find name foo')).toBe(
      'TS2304: Cannot find name foo',
    );
    expect(normalizeFindingTitle('Shared build break (1 lane): boom')).toBe('boom');
  });

  it('replaces embedded hyphenated UUIDs with a stable placeholder', () => {
    expect(
      normalizeFindingTitle('Lane a1b2c3d4-e5f6-7890-abcd-ef0123456789 failed the build'),
    ).toBe('Lane <id> failed the build');
  });

  it('replaces embedded bare 32-hex run ids with a stable placeholder', () => {
    expect(normalizeFindingTitle('Run deadbeefdeadbeefdeadbeefdeadbeef broke')).toBe(
      'Run <id> broke',
    );
  });

  it('collapses two titles differing only by run id into the same normalized string', () => {
    const a = normalizeFindingTitle('Shared build break (2 lanes): failure in run deadbeefdeadbeefdeadbeefdeadbeef');
    const b = normalizeFindingTitle('Shared build break (4 lanes): failure in run cafebabecafebabecafebabecafebabe');
    expect(a).toBe(b);
  });

  it('leaves a plain title with no prefix or id untouched (besides trimming)', () => {
    expect(normalizeFindingTitle('Null check missing in parser.ts')).toBe(
      'Null check missing in parser.ts',
    );
  });
});

// ---------------------------------------------------------------------------
// computeRecurringTitles
// ---------------------------------------------------------------------------

describe('computeRecurringTitles', () => {
  it('counts occurrences of the normalized title and sorts DESC by count', () => {
    const findings = [
      finding({ id: 'a', title: 'Shared build break (2 lanes): TS2304 foo' }),
      finding({ id: 'b', title: 'Shared build break (3 lanes): TS2304 foo' }),
      finding({ id: 'c', title: 'Missing null guard' }),
      finding({ id: 'd', title: 'Missing null guard' }),
      finding({ id: 'e', title: 'Missing null guard' }),
    ];
    const out = computeRecurringTitles(findings);
    expect(out[0]).toEqual({
      normalizedTitle: 'Missing null guard',
      count: 3,
      findingIds: ['c', 'd', 'e'],
    });
    expect(out[1]).toEqual({
      normalizedTitle: 'TS2304 foo',
      count: 2,
      findingIds: ['a', 'b'],
    });
  });

  it('caps the result at `limit`', () => {
    const findings = Array.from({ length: 5 }, (_v, i) =>
      finding({ id: `f${i}`, title: `title-${i}` }),
    );
    expect(computeRecurringTitles(findings, 2)).toHaveLength(2);
  });

  it('tiebreaks equal counts alphabetically by normalized title', () => {
    const findings = [finding({ id: 'a', title: 'Zebra' }), finding({ id: 'b', title: 'Apple' })];
    const out = computeRecurringTitles(findings);
    expect(out.map((e) => e.normalizedTitle)).toEqual(['Apple', 'Zebra']);
  });
});

// ---------------------------------------------------------------------------
// computeWeeklyTrend
// ---------------------------------------------------------------------------

describe('computeWeeklyTrend', () => {
  const now = new Date('2026-06-29T00:00:00.000Z'); // a Monday, for round week math

  it('produces ceil(windowDays/7) buckets, oldest week first', () => {
    const out = computeWeeklyTrend([], 14, now);
    expect(out).toHaveLength(2);
    expect(out[0].weekStart < out[1].weekStart).toBe(true);
  });

  it('buckets a finding into its createdAt week and counts it as opened', () => {
    const findings = [finding({ id: 'a', createdAt: '2026-06-28T00:00:00.000Z' })]; // most recent week
    const out = computeWeeklyTrend(findings, 14, now);
    expect(out[1].opened).toBe(1);
    expect(out[0].opened).toBe(0);
  });

  it('counts a non-pending finding as resolved in its createdAt week too', () => {
    const findings = [
      finding({ id: 'a', status: 'resolved', createdAt: '2026-06-28T00:00:00.000Z' }),
      finding({ id: 'b', status: 'pending', createdAt: '2026-06-28T00:00:00.000Z' }),
    ];
    const out = computeWeeklyTrend(findings, 14, now);
    expect(out[1]).toEqual({ weekStart: out[1].weekStart, opened: 2, resolved: 1 });
  });

  it('excludes findings outside the window and with unparseable createdAt', () => {
    const findings = [
      finding({ id: 'old', createdAt: '2026-01-01T00:00:00.000Z' }),
      finding({ id: 'bad', createdAt: 'not-a-date' }),
      finding({ id: 'future', createdAt: '2026-12-01T00:00:00.000Z' }),
    ];
    const out = computeWeeklyTrend(findings, 14, now);
    const total = out.reduce((sum, b) => sum + b.opened, 0);
    expect(total).toBe(0);
  });

  it('defaults to a 30-day window producing 5 weekly buckets', () => {
    const out = computeWeeklyTrend([], undefined, now);
    expect(out).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// computeCodeQualityTally — the full aggregate against a mixed fixture set.
// ---------------------------------------------------------------------------

describe('computeCodeQualityTally', () => {
  // One finding per (bucket, notable status) combination, plus category/severity/
  // source variety, so every axis has a hand-countable expectation.
  const findings: QualityFinding[] = [
    // in_workflow, open, security, error, agent:executor
    finding({
      id: 'iw-open',
      severity: 'error',
      category: 'security',
      source: 'agent:executor',
      sourceStep: 'executor',
    }),
    // in_workflow, fixed, robustness, warning, agent:executor
    finding({
      id: 'iw-fixed',
      status: 'resolved',
      resolution: 'fixed:patched',
      severity: 'warning',
      category: 'robustness',
      source: 'agent:executor',
      sourceStep: 'executor',
    }),
    // verification, open, tests, info, agent:eval
    finding({
      id: 'v-open',
      sourceStep: 'verify-step',
      source: 'agent:eval',
      severity: 'info',
      category: 'tests',
    }),
    // verification, dismissed, no category, no severity, no source
    finding({
      id: 'v-dismissed',
      sourceStep: 'verify-step',
      source: null,
      status: 'dismissed',
      severity: null,
      category: null,
    }),
    // post_merge (via category), triaged, security, error, build-break-group
    finding({
      id: 'pm-triaged',
      category: 'post-merge-bug',
      status: 'resolved',
      resolution: 'triaged:logged',
      severity: 'error',
      source: 'build-break-group:run-1:abc123',
      sourceStep: null,
    }),
    // post_merge (via category), promoted, security, error, build-break-group (same normalized source)
    finding({
      id: 'pm-promoted',
      category: 'post-merge-bug',
      status: 'resolved',
      resolution: 'promoted:tsk_1',
      severity: 'error',
      source: 'build-break-group:run-2:def456',
      sourceStep: null,
    }),
  ];

  const tally = computeCodeQualityTally(findings, { now: new Date('2026-06-10T00:00:00.000Z') });

  it('totalCount equals the input length', () => {
    expect(tally.totalCount).toBe(6);
  });

  it('byBucketStatus + byBucket match the hand-counted bucket×status matrix', () => {
    expect(tally.byBucketStatus.in_workflow.open).toBe(1);
    expect(tally.byBucketStatus.in_workflow.fixed).toBe(1);
    expect(tally.byBucket.in_workflow).toBe(2);

    expect(tally.byBucketStatus.verification.open).toBe(1);
    expect(tally.byBucketStatus.verification.dismissed).toBe(1);
    expect(tally.byBucket.verification).toBe(2);

    expect(tally.byBucketStatus.post_merge.triaged).toBe(1);
    expect(tally.byBucketStatus.post_merge.promoted).toBe(1);
    expect(tally.byBucket.post_merge).toBe(2);
  });

  it('byBucket totals sum to totalCount (== what the per-bucket badge would show today)', () => {
    const sum = tally.byBucket.in_workflow + tally.byBucket.verification + tally.byBucket.post_merge;
    expect(sum).toBe(tally.totalCount);
  });

  it('byCategory tallies each category (with the uncategorized sentinel), sorted DESC', () => {
    expect(tally.byCategory).toEqual(
      expect.arrayContaining([
        { key: 'post-merge-bug', count: 2 }, // pm-triaged, pm-promoted
        { key: 'security', count: 1 }, // iw-open
        { key: 'robustness', count: 1 },
        { key: 'tests', count: 1 },
        { key: CATEGORY_UNSET, count: 1 }, // v-dismissed
      ]),
    );
    expect(tally.byCategory[0]).toEqual({ key: 'post-merge-bug', count: 2 });
  });

  it('bySeverity tallies every finding including the unset sentinel', () => {
    expect(tally.bySeverity).toEqual({ error: 3, warning: 1, info: 1, [SEVERITY_UNSET]: 1 });
  });

  it('bySource collapses both build-break-group variants into one line', () => {
    const buildBreakEntry = tally.bySource.find((e) => e.key === 'build-break-group');
    expect(buildBreakEntry).toEqual({ key: 'build-break-group', count: 2 });
    expect(tally.bySource.find((e) => e.key === 'agent:executor')).toEqual({
      key: 'agent:executor',
      count: 2,
    });
    expect(tally.bySource.find((e) => e.key === SOURCE_UNKNOWN)).toEqual({
      key: SOURCE_UNKNOWN,
      count: 1,
    });
  });

  it('recurringTitles + weeklyTrend are present and internally consistent', () => {
    expect(tally.recurringTitles.length).toBeGreaterThan(0);
    expect(tally.weeklyTrend.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// filterQualityFindings / matchesQualityFindingFilter — the drill-down query.
// ---------------------------------------------------------------------------

describe('filterQualityFindings', () => {
  const findings: QualityFinding[] = [
    finding({ id: 'a', category: 'security', severity: 'error', source: 'agent:eval' }),
    finding({ id: 'b', category: 'security', severity: 'warning', source: 'agent:eval' }),
    finding({ id: 'c', category: 'tests', severity: 'error', source: 'agent:executor', status: 'dismissed' }),
  ];

  it('filters on a single field', () => {
    expect(filterQualityFindings(findings, { category: 'security' }).map((f) => f.id)).toEqual([
      'a',
      'b',
    ]);
  });

  it('AND-combines multiple fields', () => {
    expect(
      filterQualityFindings(findings, { category: 'security', severity: 'error' }).map((f) => f.id),
    ).toEqual(['a']);
  });

  it('matches the tally status axis (not the raw ReviewItem status)', () => {
    expect(filterQualityFindings(findings, { status: 'dismissed' }).map((f) => f.id)).toEqual(['c']);
  });

  it('returns everything when the filter is empty', () => {
    expect(filterQualityFindings(findings, {})).toHaveLength(3);
  });

  it('matchesQualityFindingFilter agrees with the array filter per-item', () => {
    for (const f of findings) {
      expect(matchesQualityFindingFilter(f, { category: 'security' })).toBe(f.category === 'security');
    }
  });
});

// ---------------------------------------------------------------------------
// paginate
// ---------------------------------------------------------------------------

describe('paginate', () => {
  const items = Array.from({ length: 120 }, (_v, i) => i);

  it('defaults to the 50-row drill-down page size', () => {
    const page0 = paginate(items, 0);
    expect(page0.items).toHaveLength(QUALITY_DRILLDOWN_PAGE_SIZE);
    expect(page0.items[0]).toBe(0);
    expect(page0.total).toBe(120);
    expect(page0.pageCount).toBe(3);
  });

  it('returns the correct slice for a middle page', () => {
    const page1 = paginate(items, 1);
    expect(page1.items[0]).toBe(50);
    expect(page1.items).toHaveLength(50);
  });

  it('the last page holds the remainder', () => {
    const page2 = paginate(items, 2);
    expect(page2.items).toHaveLength(20);
  });

  it('clamps an out-of-range page into [0, pageCount-1]', () => {
    expect(paginate(items, 99).page).toBe(2);
    expect(paginate(items, -5).page).toBe(0);
  });

  it('an empty input yields one empty page (pageCount=1, not 0)', () => {
    const empty = paginate([], 0);
    expect(empty.pageCount).toBe(1);
    expect(empty.items).toEqual([]);
    expect(empty.total).toBe(0);
  });

  it('honors a custom page size', () => {
    const page = paginate(items, 0, 10);
    expect(page.items).toHaveLength(10);
    expect(page.pageCount).toBe(12);
  });
});
