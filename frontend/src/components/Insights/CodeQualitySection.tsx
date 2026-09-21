/**
 * CodeQualitySection — Insights mockup section 03 (TASK-291 tally-first redesign).
 *
 * "03 CODE QUALITY — flagged in-flow · caught at verify · found after merge."
 *
 * Was: every {@link QualityFinding} rendered as a row across three bucket
 * columns — an unbounded scroll on any project with more than a couple dozen
 * open findings, with the column count badge as the only aggregate number.
 *
 * Now: the DEFAULT render is tallies, not rows — no per-finding DOM node is
 * mounted until a human clicks one. All aggregation is the pure, unit-tested
 * {@link computeCodeQualityTally} helper (`shared/insights/codeQualityTally.ts`
 * — kept dependency-free and outside `frontend/src/` so a backend test can
 * reuse the exact same counting logic this component renders):
 *
 *   - bucket × status counts (open/fixed/triaged/promoted/resolved/dismissed
 *     per column) — clicking a cell drills down.
 *   - category / severity / source tallies — clicking a bar drills down.
 *   - top recurring finding titles (normalized: the "Shared build break (N
 *     lanes): " prefix and embedded run ids stripped so the SAME underlying
 *     issue counts once) — clicking a title drills down.
 *   - a weekly opened/resolved trend sparkline over the last 30 days.
 *
 * Clicking any tally cell opens a FILTERED, PAGED (page size ≤ 50) list —
 * the original row rendering (severity dot / meta line / status chip),
 * unchanged, scoped by {@link filterQualityFindings}. From there, "Seed
 * compounding with these" hands the WHOLE filtered set (not just the current
 * page) to the CompoundingTray's selection via the store's
 * {@link InsightsState.seedCompoundingFromFindingIds} — approving any
 * still-untriaged row into READY and selecting every eligible row, so a human
 * never has to one-by-one pick a filtered batch. Ids with no matching
 * `triageFindings` row (already resolved/dismissed, or from a
 * non-delivered-session run) are silently skipped — they are not
 * triage-eligible.
 *
 * Row-level triage actions (Approve / Dismiss / promote) are OUT of scope
 * here: the pre-existing flat list this section replaces never wired any —
 * it has always been a read-only historical view (unlike FindingsSection's
 * UntriagedRow, which owns the actual triage menu). This redesign keeps that
 * read-only row exactly as it was.
 *
 * Bucket classification uses the SHARED {@link classifyQualityFinding} helper
 * (imported, never reimplemented) and the tally's per-bucket status axis uses
 * the SHARED {@link classifyTallyStatus} (mirrors this file's own chipLabel()
 * exactly), so a tally count can never drift from what a drilled-down row
 * would show for the same finding.
 *
 * Label maps (column titles, status chips, tally axis labels) are keyed on
 * the shared discriminants so a new bucket / status breaks the map at
 * compile time (per CODE-PATTERNS "Label maps for shared-type discriminants").
 */
import { useMemo, useState } from 'react';
import { useInsightsStore } from '../../stores/insightsStore';
import {
  classifyQualityFinding,
  POST_MERGE_FINDING_CATEGORY,
  type QualityBucket,
  type QualityFinding,
} from '../../../../shared/types/insights';
import { parseResolutionKind } from '../../../../shared/types/reviews';
import {
  computeCodeQualityTally,
  filterQualityFindings,
  paginate,
  CATEGORY_UNSET,
  SEVERITY_UNSET,
  SOURCE_UNKNOWN,
  QUALITY_DRILLDOWN_PAGE_SIZE,
  type QualityTallyStatus,
  type QualitySeverityKey,
  type QualityFindingFilter,
  type TallyEntry,
} from '../../../../shared/insights/codeQualityTally';
import { BarRow } from './charts/BarRow';
import { Sparkline } from './charts/Sparkline';

// ---------------------------------------------------------------------------
// Discriminant-keyed label maps — exhaustive over the shared unions.
// ---------------------------------------------------------------------------

const BUCKET_ORDER: readonly QualityBucket[] = ['in_workflow', 'verification', 'post_merge'];

const BUCKET_LABEL: Record<QualityBucket, string> = {
  in_workflow: 'In-workflow',
  verification: 'Found during verification',
  post_merge: 'Post-merge',
};

const TALLY_STATUS_ORDER: readonly QualityTallyStatus[] = [
  'open',
  'fixed',
  'triaged',
  'promoted',
  'resolved',
  'dismissed',
];

/** Mirrors chipLabel()'s return strings exactly — never let the two drift. */
const TALLY_STATUS_LABEL: Record<QualityTallyStatus, string> = {
  open: 'Open',
  fixed: 'Fixed',
  triaged: 'Triaged',
  promoted: 'Promoted',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
};

const SEVERITY_LABEL: Record<QualitySeverityKey, string> = {
  error: 'Error',
  warning: 'Warning',
  info: 'Info',
  unset: 'No severity',
};

const CATEGORY_UNSET_LABEL = 'Uncategorized';
const SOURCE_UNKNOWN_LABEL = 'Unknown source';

/** Fixed render order for the severity tally panel, keyed on the shared severity axis. */
const SEVERITY_KEYS: readonly QualitySeverityKey[] = ['error', 'warning', 'info', SEVERITY_UNSET];

type FindingStatus = QualityFinding['status'];

/** Status chip color — open stands out (interactive), triaged recede. */
const STATUS_CHIP_CLASS: Record<FindingStatus, string> = {
  pending: 'border-interactive/40 bg-interactive-surface text-interactive',
  resolved: 'border-status-success/40 bg-status-success/10 text-status-success',
  dismissed: 'border-border-primary bg-bg-secondary text-text-tertiary',
};

/**
 * Chip TEXT for a finding. Pending → OPEN and dismissed → DISMISSED key on status
 * alone; a resolved item refines RESOLVED by its resolution prefix (parsed via the
 * shared parseResolutionKind, never re-implemented) so the queue distinguishes a
 * fix-in-place from a triage or a promote-to-task. The chip COLOR stays per status
 * ({@link STATUS_CHIP_CLASS}) — all resolved variants share the success styling.
 */
function chipLabel(finding: QualityFinding): string {
  switch (finding.status) {
    case 'pending':
      return 'Open';
    case 'dismissed':
      return 'Dismissed';
    case 'resolved':
      switch (parseResolutionKind(finding.resolution)) {
        case 'fixed':
          return 'Fixed';
        case 'triaged':
          return 'Triaged';
        case 'promoted':
          return 'Promoted';
        // 'other' (free-text) and null (no resolution recorded) → generic.
        default:
          return 'Resolved';
      }
  }
}

/** Severity dot color — null/info are the quietest. */
function severityDotClass(severity: QualityFinding['severity']): string {
  switch (severity) {
    case 'error':
      return 'bg-status-error';
    case 'warning':
      return 'bg-status-warning';
    case 'info':
    default:
      return 'bg-text-muted';
  }
}

/**
 * Build the meta line from the parts that are present, joined with ' · '. The
 * first location's path, the source step, and the workflow name are each
 * optional; a finding with none of them renders no meta line.
 */
function metaParts(f: QualityFinding): string[] {
  const parts: string[] = [];
  const firstPath = f.locations[0]?.path;
  if (firstPath !== undefined) parts.push(firstPath);
  if (f.sourceStep !== null) parts.push(f.sourceStep);
  if (f.workflowName !== null) parts.push(f.workflowName);
  return parts;
}

/** Parse an ISO timestamp to ms, or null when absent/unparseable (NaN-guard). */
function isoToMs(iso: string | null): number | null {
  if (iso === null) return null;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The POST-MERGE meta annotation, mirroring the mockup's "2d after merge".
 *
 * Computes the merge-to-discovery lag (`runEndedAt` → `createdAt`) ONLY when the
 * finding lands in post_merge via the TIME rule — i.e. the run merged and both
 * stamps are present + valid + ordered (createdAt after the merge). Sub-24h lags
 * read '<N>h after merge'; ≥24h read '<N>d after merge' (matching the formatAge
 * bucketing, floored). Invalid/missing dates and the not-actually-after case
 * return null so the meta line renders nothing rather than NaN.
 *
 * For a category-tagged post-merge finding WITHOUT usable run linkage, we have no
 * merge instant to subtract from, so this returns null and the caller falls back
 * to the category chip text — no lag is fabricated.
 */
function postMergeLagAnnotation(f: QualityFinding): string | null {
  if (f.runOutcome !== 'merged') return null;
  const mergedMs = isoToMs(f.runEndedAt);
  const discoveredMs = isoToMs(f.createdAt);
  if (mergedMs === null || discoveredMs === null) return null;

  const lagMs = discoveredMs - mergedMs;
  if (lagMs <= 0) return null; // discovered at/before the merge — not a post-merge lag.

  const lagHours = Math.floor(lagMs / (1000 * 60 * 60));
  if (lagHours < 24) return `${lagHours}h after merge`;
  return `${Math.floor(lagHours / 24)}d after merge`;
}

/**
 * Extra meta annotation for a finding in the POST-MERGE column. The merge-lag
 * label wins when the time rule produced it; otherwise a category-tagged
 * post-merge finding (no run linkage) shows the category text so the column
 * still explains why the item sits here. Findings in other buckets get null.
 */
function postMergeMeta(f: QualityFinding, bucket: QualityBucket): string | null {
  if (bucket !== 'post_merge') return null;
  const lag = postMergeLagAnnotation(f);
  if (lag !== null) return lag;
  if (f.category === POST_MERGE_FINDING_CATEGORY) return f.category;
  return null;
}

/** One finding row — UNCHANGED from the pre-redesign flat list, now rendered only inside a drill-down. */
function FindingRow({
  finding,
  bucket,
}: {
  finding: QualityFinding;
  bucket: QualityBucket;
}): React.JSX.Element {
  const meta = metaParts(finding);
  const postMerge = postMergeMeta(finding, bucket);
  if (postMerge !== null) meta.push(postMerge);
  return (
    <div
      className="flex items-start gap-2 border-b border-border-tertiary py-2 last:border-b-0"
      data-testid="quality-finding-row"
      data-finding-id={finding.id}
    >
      <span
        className={`mt-1 h-2 w-2 flex-shrink-0 rounded-full ${severityDotClass(finding.severity)}`}
        aria-hidden
        data-testid="quality-severity-dot"
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-semibold text-text-primary">{finding.title}</div>
        {meta.length > 0 && (
          <div className="mt-0.5 truncate text-[10px] text-text-tertiary">{meta.join(' · ')}</div>
        )}
      </div>
      <span
        className={`flex-shrink-0 rounded-full border px-1.5 py-px text-[9px] font-bold uppercase tracking-wider ${STATUS_CHIP_CLASS[finding.status]}`}
        data-testid="quality-status-chip"
      >
        {chipLabel(finding)}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tally overview — the DEFAULT render. No per-finding row is mounted here.
// ---------------------------------------------------------------------------

/** One clickable tally row: a label, a count, and a click target that opens the drill-down. */
function TallyRow({
  label,
  count,
  onClick,
  testId,
}: {
  label: string;
  count: number;
  onClick: () => void;
  testId: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={count === 0}
      data-testid={testId}
      className="flex w-full items-center justify-between gap-2 rounded-button px-1.5 py-1 text-left text-xs transition-colors hover:bg-bg-hover disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
    >
      <span className="truncate text-text-secondary">{label}</span>
      <span className="flex-shrink-0 rounded-full border border-border-primary bg-bg-secondary px-1.5 py-px text-[10px] font-bold tabular-nums text-text-primary">
        {count}
      </span>
    </button>
  );
}

/** One bucket column of the tally grid — header badge (matches today's) + its status breakdown. */
function BucketTallyColumn({
  bucket,
  total,
  byStatus,
  onDrill,
}: {
  bucket: QualityBucket;
  total: number;
  byStatus: Record<QualityTallyStatus, number>;
  onDrill: (filter: QualityFindingFilter) => void;
}): React.JSX.Element {
  return (
    <div
      className="rounded-card border border-border-primary bg-surface-primary p-3"
      data-testid={`quality-column-${bucket}`}
    >
      <div className="flex items-center justify-between border-b border-border-primary pb-2">
        <span className="eyebrow text-text-tertiary">{BUCKET_LABEL[bucket]}</span>
        <span
          className="rounded-full border border-border-primary bg-bg-secondary px-1.5 py-px text-[10px] font-bold tabular-nums text-text-secondary"
          data-testid="quality-column-count"
        >
          {total}
        </span>
      </div>
      <div className="mt-1">
        {total === 0 ? (
          <p className="py-6 text-center text-[11px] text-text-muted" data-testid="quality-column-empty">
            Nothing here.
          </p>
        ) : (
          TALLY_STATUS_ORDER.filter((status) => byStatus[status] > 0).map((status) => (
            <TallyRow
              key={status}
              label={TALLY_STATUS_LABEL[status]}
              count={byStatus[status]}
              testId={`quality-tally-${bucket}-${status}`}
              onClick={() => onDrill({ bucket, status })}
            />
          ))
        )}
      </div>
    </div>
  );
}

/** A generic "key → count" tally panel (category / severity / source), rendered as clickable bars. */
function TallyBarPanel({
  title,
  entries,
  labelFor,
  testId,
  onDrill,
}: {
  title: string;
  entries: TallyEntry[];
  /** Human-readable label for a raw tally key (e.g. the CATEGORY_UNSET sentinel -> "Uncategorized"). */
  labelFor: (key: string) => string;
  testId: string;
  onDrill: (key: string) => void;
}): React.JSX.Element {
  const max = entries.reduce((m, e) => Math.max(m, e.count), 0);
  return (
    <div data-testid={testId}>
      <div className="eyebrow mb-2 text-text-tertiary">{title}</div>
      {entries.length === 0 ? (
        <p className="text-[11px] text-text-muted">No data yet.</p>
      ) : (
        <div className="space-y-1.5">
          {entries.map((entry) => (
            <button
              key={entry.key}
              type="button"
              onClick={() => onDrill(entry.key)}
              data-testid={`${testId}-${entry.key}`}
              className="block w-full rounded-button text-left transition-colors hover:bg-bg-hover"
            >
              <BarRow label={labelFor(entry.key)} value={entry.count} max={max} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drill-down — the filtered, paged list a tally click opens.
// ---------------------------------------------------------------------------

/** Human-readable description of an active drill-down filter (for the panel header). */
function describeFilter(filter: QualityFindingFilter): string {
  const parts: string[] = [];
  if (filter.bucket !== undefined) parts.push(BUCKET_LABEL[filter.bucket]);
  if (filter.status !== undefined) parts.push(TALLY_STATUS_LABEL[filter.status]);
  if (filter.category !== undefined) {
    parts.push(filter.category === CATEGORY_UNSET ? CATEGORY_UNSET_LABEL : filter.category);
  }
  if (filter.severity !== undefined) parts.push(SEVERITY_LABEL[filter.severity]);
  if (filter.source !== undefined) {
    parts.push(filter.source === SOURCE_UNKNOWN ? SOURCE_UNKNOWN_LABEL : filter.source);
  }
  if (filter.normalizedTitle !== undefined) parts.push(`"${filter.normalizedTitle}"`);
  return parts.length > 0 ? parts.join(' · ') : 'All findings';
}

function DrillDownPanel({
  filter,
  findings,
  page,
  onPageChange,
  onBack,
}: {
  filter: QualityFindingFilter;
  findings: QualityFinding[];
  page: number;
  onPageChange: (page: number) => void;
  onBack: () => void;
}): React.JSX.Element {
  const pageResult = useMemo(
    () => paginate(findings, page, QUALITY_DRILLDOWN_PAGE_SIZE),
    [findings, page],
  );

  const handleSeedCompounding = (): void => {
    void useInsightsStore
      .getState()
      .seedCompoundingFromFindingIds(findings.map((f) => f.id));
  };

  return (
    <div data-testid="quality-drilldown" className="mt-3 rounded-card border border-border-primary bg-surface-primary p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-primary pb-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onBack}
            data-testid="quality-drilldown-back"
            className="text-[11px] text-text-tertiary transition-colors hover:text-text-secondary"
          >
            ← Back to tallies
          </button>
          <span className="text-xs font-semibold text-text-primary">{describeFilter(filter)}</span>
          <span
            className="rounded-full border border-border-primary bg-bg-secondary px-1.5 py-px text-[10px] font-bold tabular-nums text-text-secondary"
            data-testid="quality-drilldown-count"
          >
            {pageResult.total}
          </span>
        </div>
        <button
          type="button"
          onClick={handleSeedCompounding}
          disabled={pageResult.total === 0}
          data-testid="quality-drilldown-seed"
          className="rounded-button border border-interactive/40 bg-interactive-surface px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-interactive transition-colors hover:bg-interactive/10 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Seed compounding with these
        </button>
      </div>

      <div className="mt-1">
        {pageResult.total === 0 ? (
          <p className="py-6 text-center text-[11px] text-text-muted" data-testid="quality-drilldown-empty">
            Nothing matches this filter.
          </p>
        ) : (
          pageResult.items.map((f) => (
            <FindingRow key={f.id} finding={f} bucket={classifyQualityFinding(f)} />
          ))
        )}
      </div>

      {pageResult.pageCount > 1 && (
        <div className="mt-2 flex items-center justify-center gap-3 border-t border-border-tertiary pt-2 text-[11px]">
          <button
            type="button"
            onClick={() => onPageChange(pageResult.page - 1)}
            disabled={pageResult.page === 0}
            data-testid="quality-drilldown-prev"
            className="text-text-tertiary transition-colors hover:text-text-secondary disabled:cursor-not-allowed disabled:opacity-40"
          >
            ← Prev
          </button>
          <span className="text-text-tertiary" data-testid="quality-drilldown-page">
            Page {pageResult.page + 1} of {pageResult.pageCount}
          </span>
          <button
            type="button"
            onClick={() => onPageChange(pageResult.page + 1)}
            disabled={pageResult.page >= pageResult.pageCount - 1}
            data-testid="quality-drilldown-next"
            className="text-text-tertiary transition-colors hover:text-text-secondary disabled:cursor-not-allowed disabled:opacity-40"
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section root
// ---------------------------------------------------------------------------

const EMPTY_FINDINGS: QualityFinding[] = [];

export function CodeQualitySection(): React.JSX.Element {
  const qualityFindings = useInsightsStore((s) => s.qualityFindings);

  const [filter, setFilter] = useState<QualityFindingFilter | null>(null);
  const [page, setPage] = useState(0);

  const tally = useMemo(() => computeCodeQualityTally(qualityFindings), [qualityFindings]);

  // Only computed when a drill-down is open — the default (tally) render never
  // maps the full findings array into DOM rows, however large the project.
  const filteredFindings = useMemo(
    () => (filter === null ? EMPTY_FINDINGS : filterQualityFindings(qualityFindings, filter)),
    [qualityFindings, filter],
  );

  const openDrilldown = (next: QualityFindingFilter): void => {
    setFilter(next);
    setPage(0);
  };

  return (
    <div data-testid="code-quality-section">
      <header className="flex flex-wrap items-baseline gap-2 border-b border-border-primary pb-2">
        <span className="eyebrow text-text-tertiary">03 Code quality</span>
        <span className="text-xs text-text-secondary">
          — flagged in-flow · caught at verify · found after merge
        </span>
      </header>

      {filter !== null ? (
        <DrillDownPanel
          filter={filter}
          findings={filteredFindings}
          page={page}
          onPageChange={setPage}
          onBack={() => setFilter(null)}
        />
      ) : (
        <div data-testid="quality-tally-overview">
          <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
            {BUCKET_ORDER.map((bucket) => (
              <BucketTallyColumn
                key={bucket}
                bucket={bucket}
                total={tally.byBucket[bucket]}
                byStatus={tally.byBucketStatus[bucket]}
                onDrill={openDrilldown}
              />
            ))}
          </div>

          <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-3">
            <TallyBarPanel
              title="By category"
              entries={tally.byCategory}
              labelFor={(key) => (key === CATEGORY_UNSET ? CATEGORY_UNSET_LABEL : key)}
              testId="quality-categories"
              onDrill={(category) => openDrilldown({ category })}
            />
            <TallyBarPanel
              title="By severity"
              entries={SEVERITY_KEYS.map((key) => ({ key, count: tally.bySeverity[key] }))}
              labelFor={(key) => SEVERITY_LABEL[key as QualitySeverityKey]}
              testId="quality-severities"
              onDrill={(severity) => openDrilldown({ severity: severity as QualitySeverityKey })}
            />
            <TallyBarPanel
              title="By source"
              entries={tally.bySource}
              labelFor={(key) => (key === SOURCE_UNKNOWN ? SOURCE_UNKNOWN_LABEL : key)}
              testId="quality-sources"
              onDrill={(source) => openDrilldown({ source })}
            />
          </div>

          <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
            <div data-testid="quality-recurring-titles">
              <div className="eyebrow mb-2 text-text-tertiary">Recurring titles</div>
              {tally.recurringTitles.length === 0 ? (
                <p className="text-[11px] text-text-muted">No repeat findings yet.</p>
              ) : (
                <div className="space-y-1">
                  {tally.recurringTitles.map((entry, index) => (
                    <TallyRow
                      key={entry.normalizedTitle}
                      label={entry.normalizedTitle}
                      count={entry.count}
                      testId={`quality-recurring-title-${index}`}
                      onClick={() => openDrilldown({ normalizedTitle: entry.normalizedTitle })}
                    />
                  ))}
                </div>
              )}
            </div>

            <div data-testid="quality-trend">
              <div className="eyebrow mb-2 text-text-tertiary">Opened vs resolved · last 30 days</div>
              <div className="flex items-center gap-4">
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-text-tertiary">Opened</div>
                  <Sparkline
                    points={tally.weeklyTrend.map((p) => p.opened)}
                    strokeClass="text-interactive"
                  />
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-text-tertiary">Resolved</div>
                  <Sparkline
                    points={tally.weeklyTrend.map((p) => p.resolved)}
                    strokeClass="stroke-status-success"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
