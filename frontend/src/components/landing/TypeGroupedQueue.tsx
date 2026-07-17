/**
 * TypeGroupedQueue — the landing-home review inbox, grouped by item TYPE.
 *
 * Groups, always in this fixed order, each rendered only when it holds at least
 * one item:
 *   1. PERMISSION    (amber swatch)   — real-time PreToolUse/approval gates. These
 *      come from the APPROVAL path (useReviewQueueView blocking+normal), rendered
 *      via the existing PendingApprovalCard. All approvals are permission-kind.
 *   2. DECISION      (rust swatch)    — approve-idea / approve-design /
 *      approve-plan gates from the review_items inbox (kind === 'decision'),
 *      rendered via ReviewItemCard.
 *   3. HUMAN TASK    (blue swatch)    — free-form action items (kind === 'human_task'),
 *      EXCLUDING idle-session items, rendered via ReviewItemCard.
 *   4. IDLE SESSIONS (rust swatch)    — idle-quick-session items (kind === 'human_task'
 *      with source `idle-session:*`), split out of Human task and sorted oldest-idle
 *      first so the longest-quiet sessions sit at the top.
 *   5. BLOCKING FINDING (red swatch)  — defects that parked a programmatic run;
 *      rendered with the existing resolve-and-resume controls.
 *   6. READY TO REVIEW (green swatch) — clean-drained runs awaiting_review with
 *      no blocking gate.
 *   7. NOTIFICATION  (neutral swatch) — informational FYIs (kind === 'notification');
 *      nothing is blocked, so this group renders LAST.
 *
 * Non-blocking findings remain in Insights. Blocking findings must be actionable
 * here because resolving or dismissing them is what resumes the parked run.
 *
 * Cards are REUSED verbatim — this component owns only the grouping chrome and a
 * per-row "Open session →" affordance that switches the session workspace to the
 * run that produced the item. The cards themselves are never modified.
 */
import React from 'react';
import { useReviewQueueView } from '../../stores/reviewQueueStore';
import { useReviewQueueSlice } from '../../stores/reviewQueueSlice';
import { PendingApprovalCard } from '../ReviewQueue/PendingApprovalCard';
import { ReviewItemCard } from '../ReviewQueue/ReviewItemCard';
import type { QueueItem } from '../../utils/reviewQueueSelectors';
import { IDLE_REVIEW_SOURCE_PREFIX, type ReviewItem } from '../../../../shared/types/reviews';
import type { QuickSessionRow } from '../../../../shared/types/quickSessions';
import type { WorkflowRunStatus } from '../../../../shared/types/cyboflow';
import type { ActiveRunRow } from '../../stores/activeRunsStore';
import {
  useAggregatedBlockingFindings,
  useAggregatedBlockingRunIds,
  useAggregatedReviewItems,
  useAggregatedRuns,
  useRunProjectMap,
} from '../../stores/landingStore';
import { useCyboflowStore } from '../../stores/cyboflowStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { formatElapsed } from '../../utils/homeClassify';
import { QuickSessionsTable } from './QuickSessionsTable';
import { useQuickSessionRows, needsAttention } from '../../stores/quickSessionsStore';

// ---------------------------------------------------------------------------
// QueueItem id/runId helpers (mirrors ReviewQueueView)
// ---------------------------------------------------------------------------

function itemId(item: QueueItem): string {
  return item.kind === 'single' ? item.approval.id : item.items[0].id;
}

function itemRunId(item: QueueItem): string {
  return item.kind === 'single' ? item.approval.runId : item.runId;
}

/**
 * Select runs that are genuinely ready for post-workflow review.
 *
 * `awaiting_review` is also used while a programmatic workflow is parked at an
 * intermediate human gate. Those runs already have a blocking decision (or
 * permission) in the queue and must not be duplicated as finished work.
 */
export function selectReadyToReviewRuns(
  runs: ActiveRunRow[],
  reviewItems: ReviewItem[],
  permissionItems: QueueItem[],
  landingBlockingRunIds: ReadonlySet<string> = new Set(),
): ActiveRunRow[] {
  const blockedRunIds = new Set(landingBlockingRunIds);

  for (const item of permissionItems) blockedRunIds.add(itemRunId(item));
  for (const item of reviewItems) {
    if (item.blocking && item.run_id !== null) blockedRunIds.add(item.run_id);
  }

  return runs.filter(
    (run) => run.status === 'awaiting_review' && !blockedRunIds.has(run.id),
  );
}

// ---------------------------------------------------------------------------
// Navigation helper — open the run that produced an item as the session
// workspace. No-op (link hidden) when the runId is unknown.
// ---------------------------------------------------------------------------

function openRunSession(runId: string, projectId: number): void {
  useCyboflowStore.getState().setActiveRun(runId);
  useNavigationStore.getState().setActiveProjectId(projectId);
  useNavigationStore.getState().goToSession();
}

/**
 * Open an idle QUICK session by its sessionId. Idle-session review items carry a
 * `__quick__` sentinel run whose workflow definition can't resolve, so routing
 * them through the flow-run host (setActiveRun) hangs the center pane forever on
 * "Loading workflow…". Quick sessions must instead render the QuickSessionCenterPane
 * via setActiveQuickSession, which never resolves a workflow definition.
 */
function openQuickSession(sessionId: string, runId: string | null, projectId: number): void {
  useCyboflowStore.getState().setActiveQuickSession(sessionId, runId ?? undefined);
  useNavigationStore.getState().setActiveProjectId(projectId);
  useNavigationStore.getState().goToSession();
}

/**
 * Right-aligned ghost link that jumps to the originating run's session. Rendered
 * only when both a runId and a resolved projectId are available.
 *
 * When `quickSessionId` is set (an idle-session item), the click opens the quick
 * session host instead of the flow-run host — see {@link openQuickSession}.
 */
function OpenSessionLink({
  runId,
  projectId,
  quickSessionId,
}: {
  runId: string | null;
  projectId: number | undefined;
  quickSessionId?: string | null;
}): React.JSX.Element | null {
  if (projectId === undefined) return null;
  // A quick-session item can open even with a null runId; a flow-run item needs one.
  if (quickSessionId == null && runId === null) return null;
  const onClick =
    quickSessionId != null
      ? () => openQuickSession(quickSessionId, runId, projectId)
      : () => openRunSession(runId as string, projectId);
  return (
    <div className="flex justify-end px-4 pb-2">
      <button
        type="button"
        onClick={onClick}
        className="eyebrow text-text-tertiary hover:text-interactive"
      >
        Open session →
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Group header — sticky, with a color swatch + name + count + descriptor.
// ---------------------------------------------------------------------------

function GroupHeader({
  swatchClass,
  name,
  count,
  descriptor,
}: {
  swatchClass: string;
  name: string;
  count: number;
  descriptor: string;
}): React.JSX.Element {
  return (
    <div className="sticky top-0 z-10 flex items-center gap-2.5 bg-bg-primary px-4 py-2 border-b border-border-primary">
      <span
        aria-hidden="true"
        className={`inline-block h-[14px] w-[8px] flex-shrink-0 ${swatchClass}`}
      />
      <span className="text-[12px] font-bold text-text-primary">{name}</span>
      <span className="eyebrow text-text-tertiary">{count} pending</span>
      <span className="ml-auto text-[11px] text-text-muted">{descriptor}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row wrappers — wrap a reused card and append the "Open session →" affordance.
// Extracted as components so per-row hook lookups (runStatus) never run inside a
// .map() callback (Rules of Hooks), matching ReviewQueueView's QueueRow pattern.
// ---------------------------------------------------------------------------

function PermissionRow({
  item,
  runStatus,
  projectId,
}: {
  item: QueueItem;
  runStatus: WorkflowRunStatus | undefined;
  projectId: number | undefined;
}): React.JSX.Element {
  return (
    <div>
      <PendingApprovalCard item={item} runStatus={runStatus} />
      <OpenSessionLink runId={itemRunId(item)} projectId={projectId} />
    </div>
  );
}

function ReviewItemRow({ item }: { item: ReviewItem }): React.JSX.Element {
  // An idle-session item's source is `idle-session:<sessionId>`; its run_id is a
  // `__quick__` sentinel that has no resolvable workflow definition, so open it as
  // a quick session rather than through the flow-run host.
  const quickSessionId = item.source?.startsWith(IDLE_REVIEW_SOURCE_PREFIX)
    ? item.source.slice(IDLE_REVIEW_SOURCE_PREFIX.length)
    : null;
  return (
    <div>
      <ReviewItemCard item={item} />
      <OpenSessionLink
        runId={item.run_id}
        projectId={item.project_id}
        quickSessionId={quickSessionId}
      />
    </div>
  );
}

/** Wall-clock refresh cadence for the "waiting" elapsed counter (mirrors ActiveAgentCard). */
const ELAPSED_TICK_MS = 30_000;

/**
 * A single clean-drained run — finished work waiting for the user to merge or
 * dismiss. Unlike the permission/decision/human_task rows no agent is halted, so
 * the card is a calm "ready" state (steady green dot, no pulse) rather than a
 * blocked one. Elapsed is measured from `updated_at` (when the run transitioned
 * to awaiting_review) via a per-row ~30s clock, matching the ActiveAgentCard
 * pattern so the count stays deterministic/testable.
 */
function ReadyToReviewRow({ run }: { run: ActiveRunRow }): React.JSX.Element {
  const [nowMs, setNowMs] = React.useState<number>(() => Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), ELAPSED_TICK_MS);
    return () => clearInterval(id);
  }, []);

  const waiting = formatElapsed(run.updated_at, nowMs);

  return (
    <div>
      <div className="border border-border-primary bg-surface-primary p-3 transition-colors hover:border-border-emphasized">
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-status-success"
          />
          <span
            className="truncate font-bold text-text-primary"
            style={{ fontSize: '13px' }}
            title={run.workflowName}
          >
            {run.workflowName}
          </span>
          <span className="eyebrow ml-auto shrink-0 border border-border-emphasized px-1.5 py-0.5 text-status-success">
            ready
          </span>
        </div>
        <div
          className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-text-tertiary"
          style={{ fontSize: '11px' }}
        >
          {run.branch_name !== null && (
            <span className="truncate text-status-success" title={run.branch_name}>
              ⌥ {run.branch_name}
            </span>
          )}
          <span>waiting {waiting}</span>
        </div>
      </div>
      <OpenSessionLink runId={run.id} projectId={run.project_id} />
    </div>
  );
}

/**
 * A single BLOCKED quick session, surfaced as a full-width card among the other
 * waiting-on-input items rather than as a compact board row. The session parked
 * on an AskUserQuestion / permission gate in its PTY, so there is no structured
 * question to render here (unlike a PendingApprovalCard) — the card is an
 * attention prompt whose "Open session →" jumps into the session to answer.
 * Opening routes through the quick-session host (setActiveQuickSession), never
 * the flow-run host, since a quick session has no resolvable workflow definition.
 */
function BlockedQuickSessionRow({ row }: { row: QuickSessionRow }): React.JSX.Element {
  return (
    <div>
      <div className="border border-status-error/40 bg-surface-primary p-3 transition-colors hover:border-status-error">
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-status-error" />
          <span
            className="truncate font-bold text-text-primary"
            style={{ fontSize: '13px' }}
            title={row.name}
          >
            {row.name}
          </span>
          <span className="eyebrow ml-auto shrink-0 border border-status-error px-1.5 py-0.5 text-status-error">
            blocked
          </span>
        </div>
        <div className="mt-2 text-text-tertiary" style={{ fontSize: '11px' }}>
          Waiting on your answer — open the session to respond.
        </div>
      </div>
      <OpenSessionLink runId={row.runId} projectId={row.projectId} quickSessionId={row.sessionId} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

/**
 * TypeGroupedQueue — self-contained, no props. Reads:
 *   - useReviewQueueView()      (approval/permission path) + useReviewQueueSlice
 *     (per-run status map) from the approval stores.
 *   - useAggregatedReviewItems() + useRunProjectMap() from the landingStore.
 *     useAggregatedBlockingRunIds() supplies hidden blocking findings for the
 *     Ready-to-review classification without rendering them as queue items.
 *   - useCyboflowStore / useNavigationStore (imperatively, on click) to open a
 *     run as the session workspace.
 */
export function TypeGroupedQueue(): React.JSX.Element {
  // Permission group: the approval path. blocking + normal are both permission-kind.
  const { blocking, normal } = useReviewQueueView();
  const permissionItems = React.useMemo(() => [...blocking, ...normal], [blocking, normal]);
  const runStatusMap = useReviewQueueSlice((s) => s.runStatusMap);

  // runId → projectId for approvals (review_items carry project_id directly).
  const runProjectMap = useRunProjectMap();

  // Decision + human_task groups: the cross-project review_items inbox.
  const reviewItems = useAggregatedReviewItems();
  const blockingFindingItems = useAggregatedBlockingFindings();
  const landingBlockingRunIds = useAggregatedBlockingRunIds();
  const decisionItems = React.useMemo(
    () => reviewItems.filter((it) => it.kind === 'decision'),
    [reviewItems],
  );
  // Idle quick sessions no longer mint review_items — the live QuickSessionsTable
  // (below) is the source of truth for quick-session state. Any LEGACY
  // `idle-session:<id>` human_task rows (from before the switch, pending until the
  // one-time startup drain resolves them) are still filtered OUT of the generic
  // human-task bucket here so they never render as a stray "Human task".
  const isIdleItem = (it: ReviewItem) => it.source?.startsWith(IDLE_REVIEW_SOURCE_PREFIX) ?? false;
  const humanTaskItems = React.useMemo(
    () => reviewItems.filter((it) => it.kind === 'human_task' && !isIdleItem(it)),
    [reviewItems],
  );
  const notificationItems = React.useMemo(
    () => reviewItems.filter((it) => it.kind === 'notification'),
    [reviewItems],
  );

  // Ready-to-review group: clean drains to `awaiting_review` — finished work
  // waiting for the user to merge or dismiss. Intermediate human gates use the
  // same status but are kept in their blocking decision/permission group.
  const runs = useAggregatedRuns();
  const readyToReviewRuns = React.useMemo(
    () => selectReadyToReviewRuns(runs, reviewItems, permissionItems, landingBlockingRunIds),
    [runs, reviewItems, permissionItems, landingBlockingRunIds],
  );

  // Quick sessions needing attention (blocked, or idle+unviewed) keep the queue
  // mounted even when nothing else is pending — the live replacement for the old
  // idle-session review items that used to hold this slot.
  const quickRows = useQuickSessionRows();
  const hasAttentionQuick = React.useMemo(() => quickRows.some(needsAttention), [quickRows]);
  // Blocked quick sessions are lifted OUT of the compact board and rendered as
  // full-width cards up here with the other waiting-on-input items (the board
  // filters them out to avoid a duplicate row).
  const blockedQuickRows = React.useMemo(
    () => quickRows.filter((row) => row.state === 'blocked'),
    [quickRows],
  );

  const hasAny =
    permissionItems.length > 0 ||
    decisionItems.length > 0 ||
    humanTaskItems.length > 0 ||
    hasAttentionQuick ||
    blockingFindingItems.length > 0 ||
    readyToReviewRuns.length > 0 ||
    notificationItems.length > 0;

  if (!hasAny) {
    return (
      <div className="py-16 text-center text-sm text-text-muted">
        <b className="mb-1.5 block text-base text-text-primary">No pending reviews</b>
        New checkpoints land here as agents pause for permission, a decision, or a task —
        or finish and wait for your review.
      </div>
    );
  }

  return (
    <div role="list" className="w-full">
      {permissionItems.length > 0 && (
        <section data-testid="queue-group-permission">
          <GroupHeader
            swatchClass="bg-status-warning"
            name="Permission"
            count={permissionItems.length}
            descriptor="Agents blocked on a tool or command"
          />
          {permissionItems.map((item) => (
            <PermissionRow
              key={itemId(item)}
              item={item}
              runStatus={runStatusMap[itemRunId(item)]}
              projectId={runProjectMap[itemRunId(item)]}
            />
          ))}
        </section>
      )}

      {decisionItems.length > 0 && (
        <section data-testid="queue-group-decision">
          <GroupHeader
            swatchClass="bg-interactive"
            name="Decision"
            count={decisionItems.length}
            descriptor="Approve, refine, or reject agent output"
          />
          {decisionItems.map((it) => (
            <ReviewItemRow key={it.id} item={it} />
          ))}
        </section>
      )}

      {blockedQuickRows.length > 0 && (
        <section data-testid="queue-group-quick-session-blocked">
          <GroupHeader
            swatchClass="bg-status-error"
            name="Quick session"
            count={blockedQuickRows.length}
            descriptor="Blocked on your answer — open to respond"
          />
          {blockedQuickRows.map((row) => (
            <BlockedQuickSessionRow key={row.sessionId} row={row} />
          ))}
        </section>
      )}

      {humanTaskItems.length > 0 && (
        <section data-testid="queue-group-human-task">
          <GroupHeader
            swatchClass="bg-status-info"
            name="Human task"
            count={humanTaskItems.length}
            descriptor="Work assigned to you"
          />
          {humanTaskItems.map((it) => (
            <ReviewItemRow key={it.id} item={it} />
          ))}
        </section>
      )}

      {/* Live quick-session status board — replaces the old idle-session group. */}
      <QuickSessionsTable />

      {blockingFindingItems.length > 0 && (
        <section data-testid="queue-group-blocking-finding">
          <GroupHeader
            swatchClass="bg-status-error"
            name="Blocking finding"
            count={blockingFindingItems.length}
            descriptor="Resolve or dismiss to resume the workflow"
          />
          {blockingFindingItems.map((it) => (
            <ReviewItemRow key={it.id} item={it} />
          ))}
        </section>
      )}

      {readyToReviewRuns.length > 0 && (
        <section data-testid="queue-group-ready-to-review">
          <GroupHeader
            swatchClass="bg-status-success"
            name="Ready to review"
            count={readyToReviewRuns.length}
            descriptor="Runs finished — merge or dismiss the work"
          />
          {readyToReviewRuns.map((run) => (
            <ReadyToReviewRow key={run.id} run={run} />
          ))}
        </section>
      )}

      {notificationItems.length > 0 && (
        <section data-testid="queue-group-notification">
          <GroupHeader
            swatchClass="bg-text-muted"
            name="Notification"
            count={notificationItems.length}
            descriptor="FYI — nothing is blocked"
          />
          {notificationItems.map((it) => (
            <ReviewItemRow key={it.id} item={it} />
          ))}
        </section>
      )}
    </div>
  );
}
