/**
 * NeedsInputSection — the red band: everything that has actually halted on a
 * human answer.
 *
 * Three sources land here, in this order, because they are three shapes of the
 * same fact ("an agent stopped and is waiting for you"):
 *   1. blocked quick sessions   — the ask is `waitingOn`, answered in-session;
 *   2. decision review items — the ask is the item title, with the body
 *      available inline behind "Details ▸". These carry no session identity of
 *      their own, so it is resolved from the item's run via `runSessionMap` —
 *      two "Human gate: Human review" cards are otherwise distinguishable only
 *      by project. NOTE: `notification` items are deliberately NOT here — an FYI
 *      has no answer, so it lives in the grey NotificationsSection rather than
 *      under an "Asked you" kicker. A SYSTEMIC-PAUSE decision (a step's agent
 *      hit a usage / session limit — `gate:systemic-pause:<stepId>`) is the one
 *      decision this row can settle itself: it offers the same Retry now /
 *      Switch & retry… / Stop waiting trio the in-session ReviewItemCard does,
 *      with the switch routing INTO the session (the runtime/model form lives
 *      there) and withheld for a triage-origin pause that no switch can move;
 *   3. real-time permission approvals — the only rows with two real verdicts,
 *      so they get Approve/Reject inline rather than an "Answer →" jump.
 *
 * Every row is one card: an "ASKED YOU" kicker + quiet clock, the ask itself as
 * the bold headline, then a metadata line (project · session · branch · summary)
 * with the actions right-aligned.
 *
 * Only quick-session rows carry a Dismiss action (a ✕ in the card's top-right
 * plus a "Dismiss" button) — TASK-225. It clears the session's stale
 * summarizer ask (`session_summaries.state`/`waiting_on`) via
 * `cyboflow.sessions.dismissAsk` and stamps a dismissal hash so the SAME
 * question doesn't resurface on the next summary; a genuinely different
 * question still does. Decision review items and permission approvals already
 * have their own resolve paths (Answer → / Approve·Reject) and are
 * deliberately left untouched.
 */
import React from 'react';
import { trpc } from '../../trpc/client';
import { useErrorStore } from '../../stores/errorStore';
import { trackEvent } from '../../utils/telemetry';
import { useReviewItemActions } from '../../hooks/useReviewItemActions';
import { isSystemicPauseItem, systemicPauseOrigin } from '../../utils/systemicPause';
import type { QuickSessionRow } from '../../../../shared/types/quickSessions';
import type { ReviewItem } from '../../../../shared/types/reviews';
import type { QueueItem } from '../../utils/reviewQueueSelectors';
import type { RunSessionIdentity } from '../../stores/landingStore';
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

function CardTop({
  quiet,
  onDismiss,
  dismissDisabled = false,
}: {
  quiet: string | null;
  /** Small ✕ in the top-right corner — quick-session rows only (TASK-225). */
  onDismiss?: () => void;
  /** Disabled while a dismiss is in flight, so a double-click can't fire a second mutation. */
  dismissDisabled?: boolean;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <span className="eyebrow text-status-error">Asked you</span>
      {quiet !== null && (
        <span className="ml-auto shrink-0 text-[10px] text-text-tertiary">quiet {quiet}</span>
      )}
      {onDismiss !== undefined && (
        <button
          type="button"
          aria-label="Dismiss ask"
          title="Dismiss"
          data-testid="rq-needs-input-dismiss-x"
          onClick={onDismiss}
          disabled={dismissDisabled}
          className={`shrink-0 text-[12px] leading-none text-text-tertiary transition-colors hover:text-text-primary disabled:opacity-50 ${quiet === null ? 'ml-auto' : ''}`}
        >
          ✕
        </button>
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
  onDismissed,
}: {
  row: QuickSessionRow;
  projectName: string | null;
  nowMs: number;
  onOpen: (row: QuickSessionRow) => void;
  /** Called once the dismiss mutation settles (success or failure — see `dismiss` below). */
  onDismissed: () => void;
}): React.JSX.Element {
  const [busy, setBusy] = React.useState(false);

  // Dismiss only clears the SUMMARIZER's ask (session_summaries.state /
  // waiting_on). A live `blocked` row is a real in-flight AskUserQuestion /
  // permission gate the mutation cannot clear — the card would survive the
  // click — so the affordance is offered only for the idle + needs_input
  // (summary-derived) ask it can actually remove.
  const canDismiss = row.state !== 'blocked';

  // TASK-225: clears session_summaries.state/waiting_on server-side and stamps
  // a dismissal hash so a future summarizer run repeating the SAME question
  // stays suppressed (quickSessionListing.ts's read-time filter) — a
  // genuinely different question still resurfaces. `onDismissed` kicks an
  // immediate board refresh so the card drops out right away rather than
  // waiting for the next 3s poll tick. Guarded on `busy` (and both controls
  // disable while in flight) so a double-click never issues a second dismiss
  // that would re-stamp over the first one's suppression hash.
  const dismiss = (): void => {
    if (busy) return;
    setBusy(true);
    void trpc.cyboflow.sessions.dismissAsk
      .mutate({ sessionId: row.sessionId })
      .then((result) => {
        // dismissAsk RESOLVES (never throws) with { success: false, error }
        // on a validation/not-found failure — only a truthy success should
        // fire the board refresh; a resolved failure must still leave the
        // card in place and surface the error, like the rejection branch.
        if (result.success) {
          onDismissed();
        } else {
          useErrorStore.getState().showError({ title: 'Dismiss failed', error: result.error });
        }
      })
      .catch((err: unknown) => {
        useErrorStore.getState().showError({
          title: 'Dismiss failed',
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => setBusy(false));
  };

  return (
    <AskCard>
      <CardTop
        quiet={formatElapsedMinutes(row.restedAtIso, nowMs)}
        {...(canDismiss ? { onDismiss: dismiss, dismissDisabled: busy } : {})}
      />
      <Headline>{row.waitingOn ?? row.summary ?? 'Waiting for your answer'}</Headline>
      <MetaRow
        projectName={projectName}
        sessionName={row.name}
        branchName={row.worktreeName}
        context={row.waitingOn !== null ? row.summary : null}
        actions={
          <>
            {canDismiss && (
              <GhostButton onClick={dismiss} disabled={busy}>
                Dismiss
              </GhostButton>
            )}
            <PrimaryButton onClick={() => onOpen(row)}>Answer →</PrimaryButton>
          </>
        }
      />
    </AskCard>
  );
}

/**
 * The queue-side actions for a systemic-pause item — the same trio the
 * in-session ReviewItemCard renders, minus the inline switch form: Retry now
 * resolves WITHOUT an outcome (the pause gate reads any resolve as 'retry'),
 * Switch & retry… opens the session (the runtime/model form lives there), and
 * Stop waiting DISMISSES (the gate's giveup) — never outcome 'reject'.
 */
function SystemicPauseActions({
  item,
  onOpen,
  onActed,
}: {
  item: ReviewItem;
  onOpen: (item: ReviewItem) => void;
  onActed: () => void;
}): React.JSX.Element {
  const { pendingItemId, resolve, dismiss } = useReviewItemActions();
  const busy = pendingItemId === item.id;
  // A triage-origin pause: only the run's Claude-only supervisor hit the
  // limit — no step-agent switch moves it (the backend refuses one), so the
  // row offers Retry now / Stop waiting only, like the card.
  const switchable = systemicPauseOrigin(item) !== 'triage';

  const retryNow = (): void => {
    void resolve(item.project_id, item.id, { surface: 'queue' }).then((r) => {
      if (r !== null) {
        trackEvent('review_item_resolved', { kind: item.kind, action: 'retry', blocking: item.blocking });
        onActed();
      }
    });
  };
  const stopWaiting = (): void => {
    void dismiss(item.project_id, item.id).then((ok) => {
      if (ok) {
        trackEvent('review_item_resolved', { kind: item.kind, action: 'stop_waiting', blocking: item.blocking });
        onActed();
      }
    });
  };

  return (
    <>
      <PrimaryButton onClick={retryNow} disabled={busy} data-testid="pause-retry">
        Retry now
      </PrimaryButton>
      {switchable && (
        <SecondaryButton onClick={() => onOpen(item)} disabled={item.run_id === null} data-testid="pause-switch-open">
          Switch &amp; retry…
        </SecondaryButton>
      )}
      <GhostButton onClick={stopWaiting} disabled={busy} data-testid="pause-stop">
        Stop waiting
      </GhostButton>
    </>
  );
}

function ReviewItemAsk({
  item,
  projectName,
  identity,
  nowMs,
  onOpen,
  onActed,
}: {
  item: ReviewItem;
  projectName: string | null;
  /** Who halted on this item, resolved from its run; null for a manual/triage item. */
  identity: RunSessionIdentity | null;
  nowMs: number;
  onOpen: (item: ReviewItem) => void;
  /** Fired after a systemic-pause row settles its own item (Retry now / Stop waiting). */
  onActed: () => void;
}): React.JSX.Element {
  const [expanded, setExpanded] = React.useState(false);
  const hasBody = item.body !== null && item.body !== '';
  const isPause = isSystemicPauseItem(item);
  return (
    <AskCard>
      <CardTop quiet={formatElapsedMinutes(item.created_at, nowMs)} />
      <Headline>{item.title}</Headline>
      <MetaRow
        projectName={projectName}
        sessionName={identity?.sessionName ?? null}
        branchName={identity?.branchName ?? null}
        context={hasBody && !expanded ? item.body : null}
        actions={
          <>
            {hasBody && (
              <GhostButton className="text-[11px]" onClick={() => setExpanded((v) => !v)}>
                Details {expanded ? '▾' : '▸'}
              </GhostButton>
            )}
            {isPause ? (
              <SystemicPauseActions item={item} onOpen={onOpen} onActed={onActed} />
            ) : (
              <PrimaryButton onClick={() => onOpen(item)}>Answer →</PrimaryButton>
            )}
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
  worktreeName: string | null;
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
      worktreeName: a.worktreeName,
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
    worktreeName: first.worktreeName,
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
        branchName={facts.worktreeName}
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
  /** runId → session identity, so a review item can name the agent that halted. */
  runSessionMap: Record<string, RunSessionIdentity>;
  nowMs: number;
  /** Render an empty dashed strip instead of hiding the section (the all-idle state). */
  showWhenEmpty: boolean;
  /** True while the section is flash-highlighted by a Recommended-actions jump. */
  flashing: boolean;
  onOpenQuickSession: (row: QuickSessionRow) => void;
  onOpenReviewItem: (item: ReviewItem) => void;
  /**
   * Fired after a systemic-pause row settles its own item (Retry now / Stop
   * waiting) — refresh the board, exactly as {@link onApprovalDecided} does.
   * Optional: the landing's aggregated items also catch up on their own.
   */
  onReviewItemActed?: () => void;
  onApprovalDecided: () => void;
  /** Fired after a quick-session ask is dismissed (TASK-225) — refresh the board. */
  onQuickSessionAskDismissed: () => void;
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
      runSessionMap,
      nowMs,
      showWhenEmpty,
      flashing,
      onOpenQuickSession,
      onOpenReviewItem,
      onReviewItemActed,
      onApprovalDecided,
      onQuickSessionAskDismissed,
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
                onDismissed={onQuickSessionAskDismissed}
              />
            ))}
            {reviewItems.map((item) => (
              <ReviewItemAsk
                key={item.id}
                item={item}
                projectName={nameOf(item.project_id)}
                identity={item.run_id !== null ? (runSessionMap[item.run_id] ?? null) : null}
                nowMs={nowMs}
                onOpen={onOpenReviewItem}
                onActed={onReviewItemActed ?? (() => undefined)}
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
