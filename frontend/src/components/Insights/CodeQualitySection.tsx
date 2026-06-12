/**
 * CodeQualitySection — Insights mockup section 03.
 *
 * "03 CODE QUALITY — flagged in-flow · caught at verify · found after merge."
 * Buckets the store's {@link QualityFinding}s into three columns using the SHARED
 * {@link classifyQualityFinding} helper (imported, never reimplemented — so the
 * backend tests and this rendering cannot drift on the bucketing rule):
 *
 *   in_workflow   → "IN-WORKFLOW"
 *   verification  → "FOUND DURING VERIFICATION"
 *   post_merge    → "POST-MERGE"
 *
 * Each column header carries a count badge. An item row shows a severity dot
 * (error → status-error, warning → status-warning, info/null → text-muted), the
 * finding title, a meta line ('<location path> · <sourceStep> · <workflowName>'
 * with the missing parts elided), and a right-aligned status chip. The chip text
 * keys on status AND — for resolved items — the resolution prefix, parsed through
 * the shared {@link parseResolutionKind}: pending → OPEN, dismissed → DISMISSED,
 * and resolved → FIXED ('fixed:') / TRIAGED ('triaged:') / PROMOTED ('promoted:')
 * / else RESOLVED. Empty columns render a quiet placeholder so the three-column
 * rhythm holds.
 *
 * Label maps (column titles, status chips) are keyed on the shared discriminants
 * so a new bucket / status breaks the map at compile time (per CODE-PATTERNS
 * "Label maps for shared-type discriminants").
 */
import { useMemo } from 'react';
import { useInsightsStore } from '../../stores/insightsStore';
import {
  classifyQualityFinding,
  type QualityBucket,
  type QualityFinding,
} from '../../../../shared/types/insights';
import { parseResolutionKind } from '../../../../shared/types/reviews';

// ---------------------------------------------------------------------------
// Discriminant-keyed label maps — exhaustive over the shared unions.
// ---------------------------------------------------------------------------

const BUCKET_ORDER: readonly QualityBucket[] = ['in_workflow', 'verification', 'post_merge'];

const BUCKET_LABEL: Record<QualityBucket, string> = {
  in_workflow: 'In-workflow',
  verification: 'Found during verification',
  post_merge: 'Post-merge',
};

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

/** One finding row inside a column. */
function FindingRow({ finding }: { finding: QualityFinding }): React.JSX.Element {
  const meta = metaParts(finding);
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

/** One bucket column — header with count badge over its finding rows. */
function QualityColumn({
  bucket,
  findings,
}: {
  bucket: QualityBucket;
  findings: QualityFinding[];
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
          {findings.length}
        </span>
      </div>
      <div className="mt-1">
        {findings.length === 0 ? (
          <p className="py-6 text-center text-[11px] text-text-muted" data-testid="quality-column-empty">
            Nothing here.
          </p>
        ) : (
          findings.map((f) => <FindingRow key={f.id} finding={f} />)
        )}
      </div>
    </div>
  );
}

export function CodeQualitySection(): React.JSX.Element {
  const qualityFindings = useInsightsStore((s) => s.qualityFindings);

  // Bucket via the SHARED helper so backend + UI cannot drift on the rule.
  const byBucket = useMemo(() => {
    const buckets: Record<QualityBucket, QualityFinding[]> = {
      in_workflow: [],
      verification: [],
      post_merge: [],
    };
    for (const f of qualityFindings) {
      buckets[classifyQualityFinding(f)].push(f);
    }
    return buckets;
  }, [qualityFindings]);

  return (
    <div data-testid="code-quality-section">
      <header className="flex flex-wrap items-baseline gap-2 border-b border-border-primary pb-2">
        <span className="eyebrow text-text-tertiary">03 Code quality</span>
        <span className="text-xs text-text-secondary">
          — flagged in-flow · caught at verify · found after merge
        </span>
      </header>

      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
        {BUCKET_ORDER.map((bucket) => (
          <QualityColumn key={bucket} bucket={bucket} findings={byBucket[bucket]} />
        ))}
      </div>
    </div>
  );
}
