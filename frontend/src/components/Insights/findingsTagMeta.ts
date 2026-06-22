/**
 * Pure presentation helpers for the findings-triage redesign of the Insights
 * "01 Findings" surface (Direction A). Intentionally free of React + side
 * effects so the load-bearing bucketing / allocation / meta-compose logic is
 * unit-testable directly (see findingsTagMeta.test.ts).
 *
 * The canonical target -> bucket mapping is NOT redefined here: it lives in
 * shared/types/reviews.ts ({@link findingBucket} / {@link FindingTagBucket}) so
 * the seed block, compound.md, and this UI never drift.
 */
import { formatAge } from '../../utils/approvalFormatters';
import {
  FINDING_PRIORITIES,
  findingBucket,
  type FindingPriority,
  type FindingTagBucket,
  type ReviewItem,
  type ReviewItemSeverity,
} from '../../../../shared/types/reviews';

// ---------------------------------------------------------------------------
// Bucket order + display maps
// ---------------------------------------------------------------------------

/**
 * Fixed render order for the READY-to-compound buckets: Quick fix first (most
 * common), then Documentation update, then Task candidate. The greedy 5-row
 * allocator and the bucket-order tiebreak both iterate this array.
 */
export const READY_BUCKETS = ['quick', 'doc', 'task'] as const;

/** Human-readable bucket labels (compile-time exhaustive over the union). */
export const BUCKET_LABEL: Record<FindingTagBucket, string> = {
  quick: 'Quick fix',
  doc: 'Documentation update',
  task: 'Task candidate',
};

/**
 * Per-bucket swatch color (CSS value) — keyed on the union so adding a bucket
 * forces a compile error. quick -> terracotta (--color-phase-execute), doc ->
 * blue (--color-phase-plan), task -> violet (--color-phase-compound).
 */
export const BUCKET_SWATCH: Record<FindingTagBucket, string> = {
  quick: 'var(--color-phase-execute)',
  doc: 'var(--color-phase-plan)',
  task: 'var(--color-phase-compound)',
};

/**
 * Per-bucket text-color Tailwind utility for the tag label. quick uses the
 * interactive (terracotta) token; doc/task use bespoke arbitrary values mapped
 * to the matching phase token (no semantic blue/violet text token exists).
 */
export const BUCKET_TEXT_CLASS: Record<FindingTagBucket, string> = {
  quick: 'text-interactive',
  doc: 'text-[var(--color-phase-plan)]',
  task: 'text-[var(--color-phase-compound)]',
};

/**
 * Severity-dot color (CSS value) keyed on the finding severity union. error
 * uses the tokenized literal --severity-error (#b23b2e, OD-2), warning the
 * amber accent, info the muted disabled ink.
 */
export const SEVERITY_DOT: Record<ReviewItemSeverity, string> = {
  error: 'var(--severity-error)',
  warning: 'var(--amber-accent)',
  info: '#b3a685',
};

// ---------------------------------------------------------------------------
// Priority badge — including the explicit UNSET state (OD-8)
// ---------------------------------------------------------------------------

/** Visual spec for a single priority badge: a label + a Tailwind class set. */
export interface PriorityBadgeSpec {
  label: string;
  class: string;
}

/**
 * Per-priority badge spec keyed on the FindingPriority union (compile-time
 * exhaustive). P0 rust/error, P1 amber, P2 muted ink-3.
 */
export const PRIORITY_BADGE: Record<FindingPriority, PriorityBadgeSpec> = {
  P0: { label: 'P0', class: 'text-[var(--severity-error)] border-[var(--severity-error)]' },
  P1: { label: 'P1', class: 'text-[var(--amber-accent)] border-[var(--amber-accent)]' },
  P2: { label: 'P2', class: 'text-text-tertiary border-border-primary' },
};

/**
 * The explicit "no priority" rendering for a NULL/missing priority (OD-8): a
 * muted em-dash, NEVER a fabricated "P2" label. Day-one all legacy rows show
 * this, not a uniform fake P2.
 */
export const PRIORITY_BADGE_UNSET: PriorityBadgeSpec = {
  label: '—',
  class: 'text-text-tertiary border-border-tertiary',
};

/**
 * Resolve a finding priority (or null) to its badge spec. NULL maps to the
 * explicit UNSET badge — every render path is resilient to a missing priority.
 */
export function priorityBadge(priority: FindingPriority | null): PriorityBadgeSpec {
  return priority === null ? PRIORITY_BADGE_UNSET : PRIORITY_BADGE[priority];
}

// ---------------------------------------------------------------------------
// Untriaged meta line — 'path:line · source-tail · age'
// ---------------------------------------------------------------------------

/**
 * Compose the untriaged-row meta line in the design's
 * 'execute/runner.ts:142 · executor · 14m' form from THREE parts, joining only
 * the present ones with ' · ':
 *   1. location  — the first payload.locations entry rendered '<path>:<line>'
 *                  (just '<path>' when line absent; omitted entirely when there
 *                  is no location).
 *   2. source-tail — item.source with the leading 'agent:' prefix stripped
 *                  (item.source is 'agent:<label>', NEVER a path or an age).
 *   3. age       — formatAge(item.created_at).
 */
export function composeUntriagedMeta(item: ReviewItem): string {
  const parts: string[] = [];

  const payload = item.payload;
  if (payload && payload.kind === 'finding' && payload.locations && payload.locations.length > 0) {
    const first = payload.locations[0];
    parts.push(first.line === undefined ? first.path : `${first.path}:${first.line}`);
  }

  if (item.source) {
    const tail = item.source.startsWith('agent:') ? item.source.slice('agent:'.length) : item.source;
    if (tail.length > 0) {
      parts.push(tail);
    }
  }

  parts.push(formatAge(item.created_at));

  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Within-bucket sort — P0 -> P1 -> P2, null LAST (OD-8), created_at tiebreak
// ---------------------------------------------------------------------------

/** Sort rank for a priority: P0=0, P1=1, P2=2, null LAST (OD-8). */
function priorityRank(priority: FindingPriority | null): number {
  return priority === null ? FINDING_PRIORITIES.length : FINDING_PRIORITIES.indexOf(priority);
}

/**
 * Stable sort of ready rows within a bucket: P0 -> P1 -> P2, null priority
 * LAST (OD-8 — sorted last, never fabricated), with a created_at (oldest-first)
 * tiebreak. Returns a new array; never mutates the input.
 */
export function sortWithinBucket<T extends { priority: FindingPriority | null; created_at: string }>(
  rows: readonly T[],
): T[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const byPriority = priorityRank(a.row.priority) - priorityRank(b.row.priority);
      if (byPriority !== 0) return byPriority;
      const byAge = a.row.created_at.localeCompare(b.row.created_at);
      if (byAge !== 0) return byAge;
      return a.index - b.index; // stable
    })
    .map((entry) => entry.row);
}

// ---------------------------------------------------------------------------
// Greedy 5-row allocator across the ready buckets
// ---------------------------------------------------------------------------

/** A partition of ready rows keyed by bucket (each side already sorted). */
export type RowsByBucket<T> = Record<FindingTagBucket, readonly T[]>;

/** The result of the greedy allocator — visible rows + the hidden tally. */
export interface ReadyAllocation<T> {
  /** Only buckets that received >=1 visible row appear here. */
  visibleByBucket: Partial<Record<FindingTagBucket, T[]>>;
  /** Total rows across ALL buckets (independent of the allocation budget). */
  totalRows: number;
  /** Rows actually shown (<= budget). */
  visibleRows: number;
  /** totalRows - visibleRows — labels the "Show N more" toggle. */
  hiddenCount: number;
  /** Whether any row was hidden by the budget. */
  anyHidden: boolean;
}

/**
 * PURE greedy allocator: iterate READY_BUCKETS in order, filling each bucket's
 * rows until `budget` rows are consumed, then stop. A bucket appears in
 * `visibleByBucket` only if it received >=1 row. `budget = Infinity` (expanded)
 * shows everything. `hiddenCount = totalRows - visibleRows` so the toggle can
 * label "Show {hiddenCount} more" (a boolean alone could not). Bucket header
 * full counts come from the raw input, NOT this allocation.
 */
export function allocateReadyRows<T>(rowsByBucket: RowsByBucket<T>, budget = 5): ReadyAllocation<T> {
  const visibleByBucket: Partial<Record<FindingTagBucket, T[]>> = {};
  let totalRows = 0;
  let visibleRows = 0;
  let remaining = budget;

  for (const bucket of READY_BUCKETS) {
    const rows = rowsByBucket[bucket];
    totalRows += rows.length;

    if (remaining <= 0 || rows.length === 0) {
      continue;
    }

    const take = Math.min(rows.length, remaining);
    if (take > 0) {
      visibleByBucket[bucket] = rows.slice(0, take);
      visibleRows += take;
      remaining -= take;
    }
  }

  return {
    visibleByBucket,
    totalRows,
    visibleRows,
    hiddenCount: totalRows - visibleRows,
    anyHidden: totalRows - visibleRows > 0,
  };
}

// ---------------------------------------------------------------------------
// Compounding-tray tally pluralization
// ---------------------------------------------------------------------------

/** Per-bucket SELECTED counts + the grand total feeding the tray tally. */
export interface TallyCounts {
  count: number;
  quick: number;
  doc: number;
  task: number;
}

/** Singular/plural noun phrase for a bucket count, e.g. 1 -> 'quick fix'. */
function bucketPhrase(bucket: FindingTagBucket, n: number): string {
  const singular: Record<FindingTagBucket, string> = {
    quick: 'quick fix',
    doc: 'doc update',
    task: 'task',
  };
  const plural: Record<FindingTagBucket, string> = {
    quick: 'quick fixes',
    doc: 'doc updates',
    task: 'tasks',
  };
  return `${n} ${n === 1 ? singular[bucket] : plural[bucket]}`;
}

/**
 * Render the compounding-tray tally, e.g.
 * 'Compounding 6 findings → 2 quick fixes · 2 doc updates · 2 tasks'
 * (singular 'quick fix'/'doc update'/'task'). Buckets with a 0 count are
 * omitted from the breakdown. Returns 'nothing selected' when count === 0.
 */
export function pluralizeTally(counts: TallyCounts): string {
  if (counts.count === 0) {
    return 'nothing selected';
  }

  const findingsWord = counts.count === 1 ? 'finding' : 'findings';
  const breakdown = READY_BUCKETS.filter((bucket) => counts[bucket] > 0).map((bucket) =>
    bucketPhrase(bucket, counts[bucket]),
  );

  return `Compounding ${counts.count} ${findingsWord} → ${breakdown.join(' · ')}`;
}

export { findingBucket };
export type { FindingTagBucket, FindingPriority };
