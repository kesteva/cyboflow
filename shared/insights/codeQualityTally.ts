/**
 * codeQualityTally — pure aggregation over {@link QualityFinding}[] for the
 * Insights "03 Code quality" section (TASK-291).
 *
 * The section used to render every open finding as a row (unbounded scroll on
 * a project with hundreds of findings, no aggregation). This module computes
 * the TALLY the section renders by default instead: counts per bucket×status,
 * per category, per severity, per source, recurring-title counts (normalized),
 * and a weekly opened/resolved trend — plus the pure filter/paginate helpers
 * the drill-down list uses once a human clicks a tally cell.
 *
 * Kept dependency-free (no React, no store) and in `shared/` (not
 * `frontend/src/`) so a backend test can reuse the exact same aggregation the
 * UI renders — mirrors the `shared/customViews/transform.ts` convention (pure
 * row logic shared between main and frontend). The bucket/status classifiers
 * this module tallies BY are imported, never re-derived: {@link
 * classifyQualityFinding} (bucket) and {@link parseResolutionKind} (resolved
 * refinement) — the same two the component's chip rendering already keys on
 * (see CodeQualitySection.tsx), so a tally count can never drift from what a
 * drill-down row would show for the same finding.
 *
 * Keep this file free of Node.js built-ins so it imports in any environment
 * (main process AND renderer), per the shared/ convention.
 */

import {
  classifyQualityFinding,
  type QualityBucket,
  type QualityFinding,
} from '../types/insights';
import { parseResolutionKind } from '../types/reviews';

// ---------------------------------------------------------------------------
// Status axis — refines QualityFinding.status by its resolution prefix for
// resolved items, mirroring CodeQualitySection's chipLabel() exactly.
// ---------------------------------------------------------------------------

/**
 * The six status buckets a tally cell distinguishes. 'resolved' is the
 * generic fallback for a resolved item whose resolution carries no known
 * prefix (or none at all) — mirrors chipLabel()'s default 'Resolved' chip.
 */
export type QualityTallyStatus = 'open' | 'fixed' | 'triaged' | 'promoted' | 'resolved' | 'dismissed';

export const QUALITY_TALLY_STATUSES: readonly QualityTallyStatus[] = [
  'open',
  'fixed',
  'triaged',
  'promoted',
  'resolved',
  'dismissed',
];

/**
 * Classify one finding's tally status. pending → open, dismissed → dismissed
 * (status alone decides both, same as chipLabel); resolved is refined by
 * {@link parseResolutionKind} — fixed/triaged/promoted match their prefix,
 * 'other' and null resolutions fall back to the generic 'resolved'.
 */
export function classifyTallyStatus(f: QualityFinding): QualityTallyStatus {
  switch (f.status) {
    case 'pending':
      return 'open';
    case 'dismissed':
      return 'dismissed';
    case 'resolved':
      switch (parseResolutionKind(f.resolution)) {
        case 'fixed':
          return 'fixed';
        case 'triaged':
          return 'triaged';
        case 'promoted':
          return 'promoted';
        default:
          return 'resolved';
      }
  }
}

// ---------------------------------------------------------------------------
// Category / severity / source axes
// ---------------------------------------------------------------------------

/** Sentinel category key for a finding whose payload carried none. */
export const CATEGORY_UNSET = 'uncategorized';

/** Severity axis key, including the explicit "no severity" sentinel. */
export type QualitySeverityKey = 'error' | 'warning' | 'info' | 'unset';

/** Sentinel severity key for a finding whose severity is null. */
export const SEVERITY_UNSET: QualitySeverityKey = 'unset';

/** Sentinel source key for a finding with no recorded provenance. */
export const SOURCE_UNKNOWN = 'unknown';

/**
 * Source prefixes whose TAIL is a per-finding-instance id (a run id, a group
 * hash) rather than a stable category — collapsing them to their prefix is
 * what keeps build-environment noise to ONE tally line instead of a dozen.
 * `build-break-group:<runId>:<groupKey>` (see programmaticRunHost.ts
 * `reportBuildBreakGroup`) is the only such source today; the list is a plain
 * array (not a closed union) so a future emitter can add its own prefix
 * without a type change.
 */
const COLLAPSED_SOURCE_PREFIXES: readonly string[] = ['build-break-group:'];

/**
 * Normalize a finding's raw `source` for the by-source tally: null → the
 * unknown sentinel, a collapsed-prefix source → just its prefix (sans the
 * trailing colon), everything else (e.g. 'agent:eval', 'visual-verify')
 * unchanged — those are already stable, finding-independent labels.
 */
export function normalizeFindingSource(source: string | null): string {
  if (source === null) return SOURCE_UNKNOWN;
  for (const prefix of COLLAPSED_SOURCE_PREFIXES) {
    if (source.startsWith(prefix)) return prefix.slice(0, -1);
  }
  return source;
}

// ---------------------------------------------------------------------------
// Recurring-title normalization
// ---------------------------------------------------------------------------

/** The 'Shared build break (N lanes): ' advisory prefix (programmaticRunHost.ts). */
const SHARED_BUILD_BREAK_PREFIX_RE = /^Shared build break \(\d+ lanes?\):\s*/;

/** A hyphenated UUID (v4-shaped or not — any 8-4-4-4-12 hex grouping). */
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/** A bare 32-hex-char run id (randomUUID with dashes stripped — workflowRegistry.ts). */
const HEX32_RE = /\b[0-9a-f]{32}\b/gi;

/**
 * Normalize a finding title for the recurring-titles tally: strip the
 * 'Shared build break (N lanes): ' prefix (so every lane's report of the same
 * underlying break collapses to its `sampleTitle`) and replace embedded run
 * ids (hyphenated UUIDs or bare 32-hex tokens) with a stable placeholder, so
 * two reports of the SAME error differing only by which run filed them still
 * count as one recurring title. Collapses repeated whitespace left behind by
 * either substitution and trims the result.
 */
export function normalizeFindingTitle(title: string): string {
  return title
    .replace(SHARED_BUILD_BREAK_PREFIX_RE, '')
    .replace(UUID_RE, '<id>')
    .replace(HEX32_RE, '<id>')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** One recurring-title tally entry — a normalized title with its occurrence count. */
export interface RecurringTitleTally {
  normalizedTitle: string;
  count: number;
  /** Ids of every finding that normalized to this title (for a drill-down / seed-compounding action). */
  findingIds: string[];
}

/** Default cap on the recurring-titles list a tally computes (top N by count). */
export const DEFAULT_RECURRING_TITLES_LIMIT = 10;

/**
 * Top-N recurring finding titles by occurrence, normalized via {@link
 * normalizeFindingTitle}. Sorted by count DESC, normalizedTitle ASC tiebreak
 * (stable regardless of input order). Pure.
 */
export function computeRecurringTitles(
  findings: readonly QualityFinding[],
  limit: number = DEFAULT_RECURRING_TITLES_LIMIT,
): RecurringTitleTally[] {
  const byTitle = new Map<string, { count: number; findingIds: string[] }>();
  for (const f of findings) {
    const key = normalizeFindingTitle(f.title);
    const entry = byTitle.get(key);
    if (entry) {
      entry.count += 1;
      entry.findingIds.push(f.id);
    } else {
      byTitle.set(key, { count: 1, findingIds: [f.id] });
    }
  }
  return [...byTitle.entries()]
    .map(([normalizedTitle, v]) => ({ normalizedTitle, count: v.count, findingIds: v.findingIds }))
    .sort((a, b) => b.count - a.count || a.normalizedTitle.localeCompare(b.normalizedTitle))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Weekly opened/resolved trend
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** Default trend window (days) — mirrors the Statistics daily-usage chart's fixed 30-day window. */
export const DEFAULT_TREND_WINDOW_DAYS = 30;

/** One week's opened/resolved counts. `weekStart` is the UTC date ('YYYY-MM-DD') the bucket begins. */
export interface WeeklyTrendPoint {
  weekStart: string;
  opened: number;
  /**
   * Best-effort count of non-pending findings whose `createdAt` fell in this
   * week. CAVEAT: `QualityFinding` carries no resolution timestamp today (only
   * `createdAt`), so this is opened-and-later-resolved counted by its OPEN
   * week, not by the week it was actually resolved — a real "resolved per
   * week" series needs a `resolvedAt`/`updatedAt` column threaded through
   * `selectQualityFindings` (backend change, out of this task's frontend-only
   * scope). Documented here rather than silently misnamed.
   */
  resolved: number;
}

/**
 * Bucket `findings` into UTC weeks covering the trailing `trendWindowDays`
 * ending at `now`, most-recent week last. A finding whose `createdAt` is
 * unparseable or falls outside the window is excluded. `resolved` counts
 * findings with a non-'pending' status bucketed by their `createdAt` week
 * (see the caveat on {@link WeeklyTrendPoint.resolved}). Pure; `now` is
 * injectable for deterministic tests.
 */
export function computeWeeklyTrend(
  findings: readonly QualityFinding[],
  trendWindowDays: number = DEFAULT_TREND_WINDOW_DAYS,
  now: Date = new Date(),
): WeeklyTrendPoint[] {
  const nowMs = now.getTime();
  const windowStartMs = nowMs - trendWindowDays * DAY_MS;
  const numWeeks = Math.max(1, Math.ceil(trendWindowDays / 7));

  const buckets: WeeklyTrendPoint[] = [];
  for (let i = numWeeks - 1; i >= 0; i--) {
    const weekEndMs = nowMs - i * WEEK_MS;
    const weekStartMs = weekEndMs - WEEK_MS;
    buckets.push({
      weekStart: new Date(weekStartMs).toISOString().slice(0, 10),
      opened: 0,
      resolved: 0,
    });
  }

  for (const f of findings) {
    const createdMs = Date.parse(f.createdAt);
    if (Number.isNaN(createdMs) || createdMs < windowStartMs || createdMs > nowMs) continue;
    const weeksAgo = Math.floor((nowMs - createdMs) / WEEK_MS);
    const idx = numWeeks - 1 - weeksAgo;
    if (idx < 0 || idx >= buckets.length) continue;
    buckets[idx].opened += 1;
    if (f.status !== 'pending') buckets[idx].resolved += 1;
  }

  return buckets;
}

// ---------------------------------------------------------------------------
// The full tally
// ---------------------------------------------------------------------------

/** One generic "key → count" tally entry, sorted DESC by count in the output arrays. */
export interface TallyEntry {
  key: string;
  count: number;
}

export interface CodeQualityTallyOptions {
  /** Trend window in days (see {@link computeWeeklyTrend}); default 30. */
  trendWindowDays?: number;
  /** How many recurring-title entries to keep; default {@link DEFAULT_RECURRING_TITLES_LIMIT}. */
  recurringTitlesLimit?: number;
  /** Injectable "now" for deterministic trend tests; defaults to `new Date()`. */
  now?: Date;
}

export interface CodeQualityTally {
  /** findings.length — the whole-inbox total (sum of every byBucket entry). */
  totalCount: number;
  /** bucket → status → count. Summing a bucket's six statuses reproduces today's per-bucket badge. */
  byBucketStatus: Record<QualityBucket, Record<QualityTallyStatus, number>>;
  /** bucket → total count (== sum of byBucketStatus[bucket]) — the exact number the current column badge shows. */
  byBucket: Record<QualityBucket, number>;
  /** category (or CATEGORY_UNSET) → count, sorted DESC. */
  byCategory: TallyEntry[];
  /** severity axis → count (all four keys always present, possibly 0). */
  bySeverity: Record<QualitySeverityKey, number>;
  /** normalized source → count, sorted DESC. */
  bySource: TallyEntry[];
  /** Top recurring finding titles, normalized + sorted DESC by occurrence. */
  recurringTitles: RecurringTitleTally[];
  /** Weekly opened/resolved series over the trend window, oldest week first. */
  weeklyTrend: WeeklyTrendPoint[];
}

function emptyStatusRecord(): Record<QualityTallyStatus, number> {
  return { open: 0, fixed: 0, triaged: 0, promoted: 0, resolved: 0, dismissed: 0 };
}

function sumStatuses(row: Record<QualityTallyStatus, number>): number {
  return QUALITY_TALLY_STATUSES.reduce((sum, status) => sum + row[status], 0);
}

function sortedEntries(counts: Map<string, number>): TallyEntry[] {
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/**
 * Compute the full code-quality tally over `findings` — the pure aggregation
 * {@link CodeQualitySection} renders by default. Every axis (bucket×status,
 * category, severity, source, recurring titles) is computed over the WHOLE
 * input array unfiltered by the trend window — only {@link
 * CodeQualityTally.weeklyTrend} is windowed — so `byBucket` totals always
 * equal today's per-bucket badge counts regardless of `trendWindowDays`.
 */
export function computeCodeQualityTally(
  findings: readonly QualityFinding[],
  options: CodeQualityTallyOptions = {},
): CodeQualityTally {
  const byBucketStatus: Record<QualityBucket, Record<QualityTallyStatus, number>> = {
    in_workflow: emptyStatusRecord(),
    verification: emptyStatusRecord(),
    post_merge: emptyStatusRecord(),
  };
  const categoryCounts = new Map<string, number>();
  const severity: Record<QualitySeverityKey, number> = { error: 0, warning: 0, info: 0, unset: 0 };
  const sourceCounts = new Map<string, number>();

  for (const f of findings) {
    const bucket = classifyQualityFinding(f);
    const status = classifyTallyStatus(f);
    byBucketStatus[bucket][status] += 1;

    const category = f.category ?? CATEGORY_UNSET;
    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);

    severity[f.severity ?? SEVERITY_UNSET] += 1;

    const source = normalizeFindingSource(f.source);
    sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1);
  }

  const byBucket: Record<QualityBucket, number> = {
    in_workflow: sumStatuses(byBucketStatus.in_workflow),
    verification: sumStatuses(byBucketStatus.verification),
    post_merge: sumStatuses(byBucketStatus.post_merge),
  };

  return {
    totalCount: findings.length,
    byBucketStatus,
    byBucket,
    byCategory: sortedEntries(categoryCounts),
    bySeverity: severity,
    bySource: sortedEntries(sourceCounts),
    recurringTitles: computeRecurringTitles(findings, options.recurringTitlesLimit),
    weeklyTrend: computeWeeklyTrend(findings, options.trendWindowDays, options.now),
  };
}

// ---------------------------------------------------------------------------
// Drill-down filter + pagination
// ---------------------------------------------------------------------------

/**
 * A drill-down filter scoping the flat list a clicked tally cell opens. Every
 * field is optional and AND-combined; an absent field imposes no constraint.
 * `category` / `severity` / `source` compare against the SAME normalized keys
 * the tally counted by (CATEGORY_UNSET / QualitySeverityKey / normalizeFindingSource).
 */
export interface QualityFindingFilter {
  bucket?: QualityBucket;
  status?: QualityTallyStatus;
  category?: string;
  severity?: QualitySeverityKey;
  source?: string;
  normalizedTitle?: string;
}

/** True when `f` matches every field `filter` specifies. Pure. */
export function matchesQualityFindingFilter(f: QualityFinding, filter: QualityFindingFilter): boolean {
  if (filter.bucket !== undefined && classifyQualityFinding(f) !== filter.bucket) return false;
  if (filter.status !== undefined && classifyTallyStatus(f) !== filter.status) return false;
  if (filter.category !== undefined && (f.category ?? CATEGORY_UNSET) !== filter.category) return false;
  if (filter.severity !== undefined && (f.severity ?? SEVERITY_UNSET) !== filter.severity) return false;
  if (filter.source !== undefined && normalizeFindingSource(f.source) !== filter.source) return false;
  if (filter.normalizedTitle !== undefined && normalizeFindingTitle(f.title) !== filter.normalizedTitle) {
    return false;
  }
  return true;
}

/** The findings matching every field of `filter`, in the input's original order. Pure. */
export function filterQualityFindings(
  findings: readonly QualityFinding[],
  filter: QualityFindingFilter,
): QualityFinding[] {
  return findings.filter((f) => matchesQualityFindingFilter(f, filter));
}

/** Max rows a single drill-down page renders (Done-when: "page size ≤ 50"). */
export const QUALITY_DRILLDOWN_PAGE_SIZE = 50;

/** One page of a paginated list, plus enough metadata to render pager controls. */
export interface Page<T> {
  items: T[];
  /** Total item count across every page (== the tally the drill-down was opened from). */
  total: number;
  /** The (clamped) zero-based page index this result actually rendered. */
  page: number;
  /** Total page count; always >= 1 even for an empty input. */
  pageCount: number;
}

/**
 * Slice `items` into page `page` (zero-based, clamped into range) of
 * `pageSize` (default {@link QUALITY_DRILLDOWN_PAGE_SIZE}). Pure.
 */
export function paginate<T>(
  items: readonly T[],
  page: number,
  pageSize: number = QUALITY_DRILLDOWN_PAGE_SIZE,
): Page<T> {
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const clampedPage = Math.min(Math.max(0, page), pageCount - 1);
  const start = clampedPage * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    total: items.length,
    page: clampedPage,
    pageCount,
  };
}
