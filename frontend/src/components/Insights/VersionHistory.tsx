/**
 * VersionHistory — Insights mockup section 06 ("VERSION HISTORY").
 *
 * A compact monospace panel listing one workflow's recorded spec revisions
 * (newest first) from the store's `revisionHistory[workflowId]` slice. Each row
 * shows the short spec_hash (first 7 chars), relative age, success %, avg tokens
 * (k-formatted), and a green/red token DELTA against the NEXT-OLDER revision —
 * tokens going DOWN reads green (cheaper revision), UP reads red. A 'LIVE' badge
 * marks the `isCurrent` revision (the spec a new run would freeze).
 *
 * The delta is intentionally computed HERE (not in the query helper): the helper
 * emits per-revision absolutes ordered newest-first, and the "vs the next-older
 * revision" comparison is a pure presentation concern over that ordering. The
 * oldest revision has no older sibling, so it carries no delta.
 *
 * Mounted by {@link StatsSection} beside the token-by-step panel for the same
 * selected (busiest) workflow; the parent hides this whole block when the
 * workflow has < 1 revision, so the component itself renders nothing for an empty
 * list as a defensive second gate.
 */
import { formatAge } from '../../utils/approvalFormatters';
import type { WorkflowRevisionStats } from '../../../../shared/types/insights';

// ---------------------------------------------------------------------------
// Presentation formatters — section-local (display contract, not domain logic).
// Mirrors StatsSection.compactTokens (>= 1000 → 'Nk', else the raw integer); kept
// local rather than shared because it is the presentation contract for THIS panel.
// ---------------------------------------------------------------------------

/** Compact token figure: >= 1000 → 'Nk' (rounded), else the raw integer; '—' for null. */
function compactTokens(n: number | null): string {
  if (n === null) return '—';
  if (n >= 1000) return `${(n / 1000).toFixed(0)}k`;
  return `${Math.round(n)}`;
}

/**
 * The signed token delta for a revision vs the NEXT-OLDER one, plus its display
 * sign + color intent. Returns null when either side lacks an avgTotalTokens (a
 * delta is meaningless without two numbers) or there is no older sibling.
 *
 * Sign convention: a DROP in tokens (newer < older) is an improvement → 'down'
 * (rendered green); a RISE is 'up' (rendered red). delta carries the absolute
 * magnitude; the arrow/sign comes from `direction`.
 */
function tokenDelta(
  newer: WorkflowRevisionStats,
  older: WorkflowRevisionStats | undefined,
): { magnitude: number; direction: 'up' | 'down' } | null {
  if (older === undefined) return null;
  if (newer.avgTotalTokens === null || older.avgTotalTokens === null) return null;
  const diff = newer.avgTotalTokens - older.avgTotalTokens;
  if (diff === 0) return null; // no change → no delta chip
  return { magnitude: Math.abs(diff), direction: diff < 0 ? 'down' : 'up' };
}

/** One revision row: hash · age · success% · avg tokens · delta chip · LIVE badge. */
function RevisionRow({
  revision,
  older,
}: {
  revision: WorkflowRevisionStats;
  older: WorkflowRevisionStats | undefined;
}): React.JSX.Element {
  const delta = tokenDelta(revision, older);
  return (
    <div
      className="grid grid-cols-[auto_auto_1fr_auto_auto] items-center gap-2 border-b border-border-tertiary py-1.5 font-mono text-xs last:border-b-0"
      data-testid={`revision-row-${revision.specHash}`}
    >
      {/* Short hash + LIVE badge. */}
      <span className="flex items-center gap-1.5 text-text-secondary">
        <span title={revision.specHash}>{revision.specHash.slice(0, 7)}</span>
        {revision.isCurrent && (
          <span
            className="rounded-full border border-status-success px-1 py-px text-[9px] font-bold tracking-wide text-status-success"
            data-testid="revision-live-badge"
          >
            LIVE
          </span>
        )}
      </span>

      {/* Relative age (reuses the review-card formatAge util). */}
      <span className="text-text-tertiary" title={revision.firstSeenAt}>
        {formatAge(revision.firstSeenAt)}
      </span>

      {/* Success rate. */}
      <span className="tabular-nums text-text-secondary">
        {revision.successRatePct}% ok
      </span>

      {/* Avg tokens (k-format). */}
      <span className="tabular-nums text-text-primary" data-testid="revision-avg-tokens">
        {compactTokens(revision.avgTotalTokens)}
      </span>

      {/* Token delta vs the next-older revision — green when tokens dropped. */}
      {delta === null ? (
        <span className="w-12 text-right text-text-muted">—</span>
      ) : (
        <span
          className={`w-12 text-right tabular-nums ${
            delta.direction === 'down' ? 'text-status-success' : 'text-status-error'
          }`}
          data-testid="revision-delta"
        >
          {delta.direction === 'down' ? '↓' : '↑'}
          {compactTokens(delta.magnitude)}
        </span>
      )}
    </div>
  );
}

/**
 * The VERSION HISTORY panel for one workflow. Renders nothing when `revisions` is
 * empty (the parent already hides it; this is a defensive second gate). Rows are
 * already newest-first from the query; each row compares against the next array
 * element (the next-older revision).
 */
export function VersionHistory({
  workflowName,
  revisions,
}: {
  workflowName: string;
  revisions: WorkflowRevisionStats[];
}): React.JSX.Element | null {
  if (revisions.length < 1) return null;

  return (
    <div data-testid="version-history">
      <div className="eyebrow mb-2 text-text-tertiary">
        Version history · {workflowName}
      </div>
      <div className="rounded-card border border-border-primary bg-surface-primary p-3">
        {revisions.map((revision, i) => (
          <RevisionRow
            key={revision.specHash}
            revision={revision}
            older={revisions[i + 1]}
          />
        ))}
      </div>
    </div>
  );
}
