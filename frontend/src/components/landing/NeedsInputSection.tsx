/**
 * NeedsInputSection — the red band: everything that has actually halted on a
 * human answer.
 *
 * Three sources land here, in this order, because they are three shapes of the
 * same fact ("an agent stopped and is waiting for you"):
 *   1. blocked quick sessions   — the ask is `waitingOn`, answered in-session;
 *   2. decision + notification review items — the ask is the item title, with
 *      the body available inline behind "Details ▸";
 *   3. real-time permission approvals — the only rows with two real verdicts,
 *      so they get Approve/Reject inline rather than an "Answer →" jump.
 *
 * Every row is one card: an "ASKED YOU" kicker + quiet clock, the ask itself as
 * the bold headline, then a metadata line (project · session · branch · summary)
 * with the actions right-aligned.
 */
import React from 'react';
import { trpc } from '../../trpc/client';
import type { QuickSessionRow } from '../../../../shared/types/quickSessions';
import type { ReviewItem } from '../../../../shared/types/reviews';
import type { QueueItem } from '../../utils/reviewQueueSelectors';
import { formatElapsedMinutes } from '../../utils/homeClassify';
import { Chip, EmptyStrip, GhostButton, PrimaryButton, SecondaryButton, SectionHeader } from './QueuePrimitives';

/** Shared card chrome: white card, 1px border, a red bar inset down the left edge. */
function AskCard({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div
      data-testid="rq-needs-input-row"
      className="flex flex-col gap-[7px] border border-border-primary bg-surface-raised px-3.5 py-[11px] shadow-[inset_3px_0_0_var(--color-status-error)]"
    >
      {children}
    </div>
  );
}

function CardTop({ quiet }: { quiet: string | null }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <span className="eyebrow text-status-error">Asked you</span>
      {quiet !== null && (
        <span className="ml-auto shrink-0 text-[10px] text-text-tertiary">quiet {quiet}</span>
      )}
    </div>
  );
}

function Headline({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="text-[13px] font-bold leading-[1.5] text-text-primary">{children}</div>;
}

/** The metadata line: project chip, session identity, truncated context, actions. */
function MetaRow({
  projectName,
  sessionName,
  branchName,
  context,
  actions,
}: {
  projectName: string | null;
  /** The session's display name (`sessions.name`) — what a rename actually changes. */
  sessionName: string | null;
  /**
   * The session's worktree branch, rendered with the green ⌥ prefix — the app's
   * marker for a session branch.
   *
   * Kept SEPARATE from {@link sessionName} because the two only coincide until
   * the session is renamed: an untouched session is named after its worktree, so
   * showing one field looked complete, but after a rename the card showed the
   * name and lost the branch (or, before this split, showed the branch and lost
   * the name). Both are shown; when they are still identical the branch alone is
   * rendered, so an unrenamed session does not read as "tidy-valley ⌥ tidy-valley".
   */
  branchName: string | null;
  context: string | null;
  actions: React.ReactNode;
}): React.JSX.Element {
  const showName = sessionName !== null && sessionName !== branchName;
  return (
    <div className="flex items-center gap-2.5 text-[11px]">
      {projectName !== null && <Chip title={projectName}>{projectName}</Chip>}
      {showName && (
        <span className="shrink-0 truncate font-medium text-text-secondary" title={sessionName}>
          {sessionName}
        </span>
      )}
      {branchName !== null && (
        <span className="shrink-0 truncate text-status-success" title={branchName}>
          ⌥ {branchName}
        </span>
      )}
      {context !== null && (
        <span className="min-w-0 flex-1 truncate text-text-tertiary" title={context}>
          {context}
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-2.5">{actions}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row variants
// ---------------------------------------------------------------------------

function QuickSessionAsk({
  row,
  projectName,
  nowMs,
  onOpen,
}: {
  row: QuickSessionRow;
  projectName: string | null;
  nowMs: number;
  onOpen: (row: QuickSessionRow) => void;
}): React.JSX.Element {
  return (
    <AskCard>
      <CardTop quiet={formatElapsedMinutes(row.restedAtIso, nowMs)} />
      <Headline>{row.waitingOn ?? row.summary ?? 'Waiting for your answer'}</Headline>
      <MetaRow
        projectName={projectName}
        sessionName={row.name}
        branchName={row.worktreeName}
        context={row.waitingOn !== null ? row.summary : null}
        actions={<PrimaryButton onClick={() => onOpen(row)}>Answer →</PrimaryButton>}
      />
    </AskCard>
  );
}

function ReviewItemAsk({
  item,
  projectName,
  nowMs,
  onOpen,
}: {
  item: ReviewItem;
  projectName: string | null;
  nowMs: number;
  onOpen: (item: ReviewItem) => void;
}): React.JSX.Element {
  const [expanded, setExpanded] = React.useState(false);
  const hasBody = item.body !== null && item.body !== '';
  return (
    <AskCard>
      <CardTop quiet={formatElapsedMinutes(item.created_at, nowMs)} />
      <Headline>{item.title}</Headline>
      <MetaRow
        projectName={projectName}
        sessionName={null}
        branchName={null}
        context={hasBody && !expanded ? item.body : null}
        actions={
          <>
            {hasBody && (
              <GhostButton className="text-[11px]" onClick={() => setExpanded((v) => !v)}>
                Details {expanded ? '▾' : '▸'}
              </GhostButton>
            )}
            <PrimaryButton onClick={() => onOpen(item)}>Answer →</PrimaryButton>
          </>
        }
      />
      {expanded && hasBody && (
        <p className="whitespace-pre-wrap border-t border-dashed border-border-primary pt-2 text-[11px] leading-relaxed text-text-secondary">
          {item.body}
        </p>
      )}
    </AskCard>
  );
}

/** Read a QueueItem's identity without re-deriving the union at every call site. */
function approvalFacts(item: QueueItem): {
  id: string;
  runId: string;
  toolName: string;
  preview: string;
  sessionName: string | null;
  createdAt: string;
  count: number;
} {
  if (item.kind === 'single') {
    const a = item.approval;
    return {
      id: a.id,
      runId: a.runId,
      toolName: a.toolName,
      preview: a.payloadPreview,
      sessionName: a.sessionName,
      createdAt: a.createdAt,
      count: 1,
    };
  }
  const first = item.items[0];
  return {
    id: first.id,
    runId: item.runId,
    toolName: item.toolName,
    preview: first.payloadPreview,
    sessionName: first.sessionName,
    createdAt: first.createdAt,
    count: item.items.length,
  };
}

/**
 * A permission gate. Approve/Reject fire the same mutations PendingApprovalCard
 * uses — a group approves the rest of its run in one call and rejects member by
 * member, exactly as the card does.
 */
function ApprovalAsk({
  item,
  projectName,
  nowMs,
  onDecided,
}: {
  item: QueueItem;
  projectName: string | null;
  nowMs: number;
  onDecided: () => void;
}): React.JSX.Element {
  const [busy, setBusy] = React.useState(false);
  const facts = approvalFacts(item);

  const settle = (p: Promise<unknown>): void => {
    setBusy(true);
    void p
      .then(() => {
        onDecided();
      })
      .catch(() => {
        // Leave the card in place on error — the gate is still open.
      })
      .finally(() => setBusy(false));
  };

  const approve = (): void =>
    settle(
      item.kind === 'group'
        ? trpc.cyboflow.approvals.approveRestOfRun.mutate({ runId: item.runId })
        : trpc.cyboflow.approvals.approve.mutate({ approvalId: item.approval.id }),
    );

  const reject = (): void =>
    settle(
      item.kind === 'group'
        ? Promise.all(item.items.map((a) => trpc.cyboflow.approvals.reject.mutate({ approvalId: a.id })))
        : trpc.cyboflow.approvals.reject.mutate({ approvalId: item.approval.id }),
    );

  return (
    <AskCard>
      <CardTop quiet={formatElapsedMinutes(facts.createdAt, nowMs)} />
      <Headline>
        {facts.preview !== '' ? facts.preview : `${facts.toolName} needs your approval`}
      </Headline>
      <MetaRow
        projectName={projectName}
        sessionName={facts.sessionName}
        // An approval row carries no worktree: `Approval` joins `sessions.name`
        // only, so there is no branch to show rather than one being dropped.
        branchName={null}
        context={facts.count > 1 ? `${facts.toolName} · ${facts.count} identical requests` : facts.toolName}
        actions={
          <>
            <PrimaryButton onClick={approve} disabled={busy}>
              Approve
            </PrimaryButton>
            <SecondaryButton onClick={reject} disabled={busy}>
              Reject
            </SecondaryButton>
          </>
        }
      />
    </AskCard>
  );
}

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

export interface NeedsInputSectionProps {
  quickRows: QuickSessionRow[];
  reviewItems: ReviewItem[];
  approvals: QueueItem[];
  projectNameById: Record<number, string>;
  /** runId → projectId, so an approval can name its project. */
  runProjectMap: Record<string, number>;
  nowMs: number;
  /** Render an empty dashed strip instead of hiding the section (the all-idle state). */
  showWhenEmpty: boolean;
  /** True while the section is flash-highlighted by a Recommended-actions jump. */
  flashing: boolean;
  onOpenQuickSession: (row: QuickSessionRow) => void;
  onOpenReviewItem: (item: ReviewItem) => void;
  onApprovalDecided: () => void;
}

/** NeedsInputSection — see {@link NeedsInputSectionProps}. */
export const NeedsInputSection = React.forwardRef<HTMLElement, NeedsInputSectionProps>(
  function NeedsInputSection(props, ref): React.JSX.Element | null {
    const {
      quickRows,
      reviewItems,
      approvals,
      projectNameById,
      runProjectMap,
      nowMs,
      showWhenEmpty,
      flashing,
      onOpenQuickSession,
      onOpenReviewItem,
      onApprovalDecided,
    } = props;

    const total = quickRows.length + reviewItems.length + approvals.length;
    if (total === 0 && !showWhenEmpty) return null;

    const nameOf = (projectId: number | undefined): string | null =>
      projectId === undefined ? null : (projectNameById[projectId] ?? null);

    return (
      <section
        ref={ref}
        data-testid="rq-needs-input-section"
        className={`flex flex-col gap-2.5 scroll-mt-4 transition-shadow ${
          flashing ? 'shadow-[0_0_0_2px_var(--color-interactive-primary)]' : ''
        }`}
      >
        <SectionHeader
          dotClass="bg-status-error"
          title="Needs your input"
          count={total}
          countMuted={total === 0}
        />
        {total === 0 ? (
          <EmptyStrip>Nothing needs your answer.</EmptyStrip>
        ) : (
          <>
            {quickRows.map((row) => (
              <QuickSessionAsk
                key={row.sessionId}
                row={row}
                projectName={nameOf(row.projectId)}
                nowMs={nowMs}
                onOpen={onOpenQuickSession}
              />
            ))}
            {reviewItems.map((item) => (
              <ReviewItemAsk
                key={item.id}
                item={item}
                projectName={nameOf(item.project_id)}
                nowMs={nowMs}
                onOpen={onOpenReviewItem}
              />
            ))}
            {approvals.map((item) => {
              const facts = approvalFacts(item);
              return (
                <ApprovalAsk
                  key={facts.id}
                  item={item}
                  projectName={nameOf(runProjectMap[facts.runId])}
                  nowMs={nowMs}
                  onDecided={onApprovalDecided}
                />
              );
            })}
          </>
        )}
      </section>
    );
  },
);
