/**
 * ReadyForReviewSection — the green band: finished work waiting on a verdict.
 *
 * Two row sources share one list because they are the same decision from the
 * user's side — a quick session that has rested, and a flow run that drained to
 * `awaiting_review`. Only quick sessions can be merged or dismissed inline (a
 * flow run's close-out lives in its own session), so a run row offers "Open →"
 * and nothing else.
 *
 * A row is a summary line until you click it; expanding swaps in the project
 * chip, the full summary, the git facts, and the action row. Past three rows the
 * list collapses behind a dashed toggle so a long backlog of finished sessions
 * never buries the sections below.
 */
import React from 'react';
import type { QuickSessionRow } from '../../../../shared/types/quickSessions';
import type { ActiveRunRow } from '../../stores/activeRunsStore';
import { describeReadyState } from '../../utils/quickSessionTriage';
import { formatElapsedMinutes } from '../../utils/homeClassify';
import { Chip, DashedToggle, GhostButton, PrimaryButton, SecondaryButton, SectionHeader } from './QueuePrimitives';

/** How many rows show before the dashed "View N more" toggle. */
const COLLAPSED_ROW_COUNT = 3;

/** One row of the section — a rested quick session or a drained flow run. */
export type ReadyRow =
  | {
      kind: 'quick';
      id: string;
      row: QuickSessionRow;
      /**
       * TASK-226: the session's finished FLOW run, when it hosted one (see
       * `significantFlowRunBySession`). Drives the status label — the run that
       * finished, not the chat it interrupted, is what the row describes.
       * Absent — even for a session that once hosted a flow run — once that
       * run is older than the session's own chat activity ("most recent
       * activity wins", product decision 2026-09-25): `significantFlowRunBySession`
       * leaves a stale terminal run out of its map entirely, so the row falls
       * through to `describeReadyState`'s own row-signal branch below.
       */
      flowRun?: ActiveRunRow;
    }
  | { kind: 'run'; id: string; run: ActiveRunRow };

interface RowFacts {
  name: string;
  projectId: number;
  summary: string | null;
  statusLabel: string;
  statusTone: 'success' | 'warning' | 'neutral';
  quiet: string;
  /** Muted "13 commits ahead · tree clean · behind base by 2" line, or null. */
  gitFacts: string | null;
}

function readFacts(entry: ReadyRow, nowMs: number): RowFacts {
  if (entry.kind === 'run') {
    const run = entry.run;
    return {
      name: run.workflowName,
      projectId: run.project_id,
      summary: run.branch_name,
      statusLabel: 'awaiting review',
      statusTone: 'neutral',
      quiet: formatElapsedMinutes(run.updated_at, nowMs),
      gitFacts: null,
    };
  }

  const row = entry.row;
  const ready = describeReadyState(row, entry.flowRun);
  // The dot/label tone mirrors describeReadyState, with "behind base" pulled out
  // as amber: it is the one neutral-toned state that needs an action before merge.
  const tone: RowFacts['statusTone'] =
    row.git?.isReadyToMerge === true
      ? 'success'
      : row.git !== null && row.git.behind > 0
        ? 'warning'
        : 'neutral';

  const parts: string[] = [];
  if (row.git !== null) {
    parts.push(`${row.git.ahead} ${row.git.ahead === 1 ? 'commit' : 'commits'} ahead`);
    parts.push(
      row.git.hasUncommittedChanges || row.git.hasUntrackedFiles ? 'uncommitted changes' : 'tree clean',
    );
    if (row.git.behind > 0) parts.push(`behind base by ${row.git.behind}`);
  }

  return {
    name: row.name,
    projectId: row.projectId,
    summary: row.summary,
    statusLabel: ready.label,
    statusTone: tone,
    quiet: formatElapsedMinutes(row.idleSince ?? row.restedAtIso, nowMs),
    gitFacts: parts.length > 0 ? parts.join(' · ') : null,
  };
}

const DOT_CLASS: Record<RowFacts['statusTone'], string> = {
  success: 'bg-status-success',
  warning: 'bg-status-warning',
  neutral: 'bg-text-muted',
};

const LABEL_CLASS: Record<RowFacts['statusTone'], string> = {
  success: 'text-status-success',
  warning: 'text-status-warning',
  neutral: 'text-text-secondary',
};

function CollapsedRow({
  facts,
  onExpand,
  onOpen,
}: {
  facts: RowFacts;
  onExpand: () => void;
  onOpen: () => void;
}): React.JSX.Element {
  return (
    <div
      role="button"
      tabIndex={0}
      data-testid="rq-ready-row"
      onClick={onExpand}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onExpand();
        }
      }}
      className="flex w-full cursor-pointer items-center gap-2.5 border border-border-primary bg-surface-raised px-3.5 py-2 text-left transition-colors hover:border-border-hover"
    >
      <span aria-hidden="true" className={`h-[7px] w-[7px] shrink-0 rounded-full ${DOT_CLASS[facts.statusTone]}`} />
      <span className="shrink-0 text-[12px] font-bold text-text-primary">{facts.name}</span>
      {facts.summary !== null ? (
        <span className="min-w-0 flex-1 truncate text-[11px] text-text-secondary" title={facts.summary}>
          {facts.summary}
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate text-[11px] italic text-text-tertiary">no summary yet</span>
      )}
      {facts.statusLabel !== '' && (
        <span className={`shrink-0 text-[10px] font-bold ${LABEL_CLASS[facts.statusTone]}`}>
          {facts.statusLabel}
        </span>
      )}
      <span className="shrink-0 text-[10px] text-text-tertiary">quiet {facts.quiet}</span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onOpen();
        }}
        className="shrink-0 text-[11px] text-interactive hover:text-interactive-hover"
      >
        Open →
      </button>
    </div>
  );
}

function ExpandedRow({
  facts,
  projectName,
  canAccept,
  onCollapse,
  onOpen,
  onMerge,
  onDismiss,
}: {
  facts: RowFacts;
  projectName: string | null;
  /** False for flow runs and for live experiment arms — Open is the only safe action. */
  canAccept: boolean;
  onCollapse: () => void;
  onOpen: () => void;
  onMerge: () => void;
  onDismiss: () => void;
}): React.JSX.Element {
  return (
    <div
      data-testid="rq-ready-expanded"
      className="flex flex-col gap-2.5 border border-interactive bg-surface-raised px-3.5 py-[11px]"
    >
      <div className="flex items-center gap-2.5">
        <span aria-hidden="true" className={`h-[7px] w-[7px] shrink-0 rounded-full ${DOT_CLASS[facts.statusTone]}`} />
        {projectName !== null && <Chip title={projectName}>{projectName}</Chip>}
        <span className="shrink-0 text-[12px] font-bold text-text-primary">{facts.name}</span>
        {facts.statusLabel !== '' && (
          <span className={`ml-auto shrink-0 text-[10px] font-bold ${LABEL_CLASS[facts.statusTone]}`}>
            {facts.statusLabel}
          </span>
        )}
        <span className={`shrink-0 text-[10px] text-text-tertiary ${facts.statusLabel === '' ? 'ml-auto' : ''}`}>
          quiet {facts.quiet}
        </span>
        <button
          type="button"
          onClick={onCollapse}
          className="shrink-0 text-[11px] text-interactive hover:text-interactive-hover"
        >
          Collapse ▴
        </button>
      </div>
      <p className="text-[11.5px] leading-relaxed text-text-primary">
        {facts.summary ?? <span className="italic text-text-tertiary">no summary yet</span>}
      </p>
      {facts.gitFacts !== null && (
        <div className="text-[10px] text-text-tertiary">{facts.gitFacts}</div>
      )}
      <div className="flex items-center gap-2">
        {canAccept && <PrimaryButton onClick={onMerge}>Merge</PrimaryButton>}
        <SecondaryButton onClick={onOpen}>Open session</SecondaryButton>
        {canAccept && (
          <GhostButton className="ml-auto" onClick={onDismiss}>
            Dismiss session
          </GhostButton>
        )}
      </div>
    </div>
  );
}

export interface ReadyForReviewSectionProps {
  rows: ReadyRow[];
  projectNameById: Record<number, string>;
  /** Quick sessions that are a live A/B arm — inline accept/dismiss is withheld. */
  guardedSessionIds: ReadonlySet<string>;
  nowMs: number;
  onOpenQuickSession: (row: QuickSessionRow) => void;
  onOpenRun: (run: ActiveRunRow) => void;
  onMergeSession: (sessionId: string) => void;
  onDismissSession: (sessionId: string) => void;
}

/** ReadyForReviewSection — see {@link ReadyForReviewSectionProps}. */
export function ReadyForReviewSection({
  rows,
  projectNameById,
  guardedSessionIds,
  nowMs,
  onOpenQuickSession,
  onOpenRun,
  onMergeSession,
  onDismissSession,
}: ReadyForReviewSectionProps): React.JSX.Element | null {
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [showAll, setShowAll] = React.useState(false);

  if (rows.length === 0) return null;
  const shown = showAll ? rows : rows.slice(0, COLLAPSED_ROW_COUNT);
  const remaining = rows.length - COLLAPSED_ROW_COUNT;

  return (
    <section data-testid="rq-ready-section" className="flex flex-col gap-2">
      <SectionHeader
        dotClass="bg-status-success"
        title="Ready for review"
        count={rows.length}
        subtitle="Finished — review, merge, or wrap up"
      />
      {shown.map((entry) => {
        const facts = readFacts(entry, nowMs);
        const open = (): void =>
          entry.kind === 'quick' ? onOpenQuickSession(entry.row) : onOpenRun(entry.run);
        if (expandedId !== entry.id) {
          return (
            <CollapsedRow
              key={entry.id}
              facts={facts}
              onExpand={() => setExpandedId(entry.id)}
              onOpen={open}
            />
          );
        }
        const sessionId = entry.kind === 'quick' ? entry.row.sessionId : null;
        return (
          <ExpandedRow
            key={entry.id}
            facts={facts}
            projectName={projectNameById[facts.projectId] ?? null}
            canAccept={sessionId !== null && !guardedSessionIds.has(sessionId)}
            onCollapse={() => setExpandedId(null)}
            onOpen={open}
            onMerge={() => sessionId !== null && onMergeSession(sessionId)}
            onDismiss={() => sessionId !== null && onDismissSession(sessionId)}
          />
        );
      })}
      {remaining > 0 && (
        <DashedToggle onClick={() => setShowAll((v) => !v)}>
          {showAll ? `Collapse to ${COLLAPSED_ROW_COUNT} ▴` : `View ${remaining} more ▾`}
        </DashedToggle>
      )}
    </section>
  );
}
