/**
 * TypeGroupedQueue — the landing-home review inbox, grouped by item TYPE.
 *
 * Groups, always in this fixed order, each rendered only when it holds at least
 * one item:
 *   1. PERMISSION    (amber swatch)   — real-time PreToolUse/approval gates. These
 *      come from the APPROVAL path (useReviewQueueView blocking+normal), rendered
 *      via the existing PendingApprovalCard. All approvals are permission-kind.
 *   2. DECISION      (rust swatch)    — approve-idea / approve-plan gates from the
 *      review_items inbox (kind === 'decision'), rendered via ReviewItemCard.
 *   3. HUMAN TASK    (blue swatch)    — free-form action items (kind === 'human_task'),
 *      EXCLUDING idle-session items, rendered via ReviewItemCard.
 *   4. IDLE SESSIONS (rust swatch)    — idle-quick-session items (kind === 'human_task'
 *      with source `idle-session:*`), split out of Human task and sorted oldest-idle
 *      first so the longest-quiet sessions sit at the top.
 *   5. READY TO REVIEW (green swatch) — runs drained to awaiting_review.
 *   6. NOTIFICATION  (neutral swatch) — informational FYIs (kind === 'notification');
 *      nothing is blocked, so this group renders LAST.
 *
 * Findings are intentionally DROPPED here — the landing aggregation
 * (useAggregatedReviewItems) only surfaces decision + human_task + notification,
 * and findings never count toward any group.
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
import type { WorkflowRunStatus } from '../../../../shared/types/cyboflow';
import type { ActiveRunRow } from '../../stores/activeRunsStore';
import {
  useAggregatedReviewItems,
  useAggregatedRuns,
  useRunProjectMap,
} from '../../stores/landingStore';
import { useCyboflowStore } from '../../stores/cyboflowStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { formatElapsed } from '../../utils/homeClassify';

// ---------------------------------------------------------------------------
// QueueItem id/runId helpers (mirrors ReviewQueueView)
// ---------------------------------------------------------------------------

function itemId(item: QueueItem): string {
  return item.kind === 'single' ? item.approval.id : item.items[0].id;
}

function itemRunId(item: QueueItem): string {
  return item.kind === 'single' ? item.approval.runId : item.runId;
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
 * Right-aligned ghost link that jumps to the originating run's session. Rendered
 * only when both a runId and a resolved projectId are available.
 */
function OpenSessionLink({
  runId,
  projectId,
}: {
  runId: string | null;
  projectId: number | undefined;
}): React.JSX.Element | null {
  if (runId === null || projectId === undefined) return null;
  return (
    <div className="flex justify-end px-4 pb-2">
      <button
        type="button"
        onClick={() => openRunSession(runId, projectId)}
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
  return (
    <div>
      <ReviewItemCard item={item} />
      <OpenSessionLink runId={item.run_id} projectId={item.project_id} />
    </div>
  );
}

/** Wall-clock refresh cadence for the "waiting" elapsed counter (mirrors ActiveAgentCard). */
const ELAPSED_TICK_MS = 30_000;

/**
 * A single run that has drained to `awaiting_review` — finished work waiting for
 * the user to merge or dismiss. Unlike the permission/decision/human_task rows no
 * agent is halted, so the card is a calm "ready" state (steady green dot, no
 * pulse) rather than a blocked one. Elapsed is measured from `updated_at` (when
 * the run transitioned to awaiting_review) via a per-row ~30s clock, matching the
 * ActiveAgentCard pattern so the count stays deterministic/testable.
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

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

/**
 * TypeGroupedQueue — self-contained, no props. Reads:
 *   - useReviewQueueView()      (approval/permission path) + useReviewQueueSlice
 *     (per-run status map) from the approval stores.
 *   - useAggregatedReviewItems() + useRunProjectMap() from the landingStore.
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
  const decisionItems = React.useMemo(
    () => reviewItems.filter((it) => it.kind === 'decision'),
    [reviewItems],
  );
  // Idle-quick-session items (source `idle-session:<id>`) get their own section,
  // sorted oldest-idle first (earliest created_at at the top) so the longest-quiet
  // sessions surface at the top of the group. They are split OUT of the generic
  // human-task bucket so a burst of idle sessions doesn't drown the real tasks.
  const isIdleItem = (it: ReviewItem) => it.source?.startsWith(IDLE_REVIEW_SOURCE_PREFIX) ?? false;
  const idleItems = React.useMemo(
    () =>
      reviewItems
        .filter((it) => it.kind === 'human_task' && isIdleItem(it))
        .sort((a, b) => a.created_at.localeCompare(b.created_at)),
    [reviewItems],
  );
  const humanTaskItems = React.useMemo(
    () => reviewItems.filter((it) => it.kind === 'human_task' && !isIdleItem(it)),
    [reviewItems],
  );
  const notificationItems = React.useMemo(
    () => reviewItems.filter((it) => it.kind === 'notification'),
    [reviewItems],
  );

  // Ready-to-review group: runs that have drained to `awaiting_review` — finished
  // work waiting for the user to merge or dismiss. A clean drain mints no
  // review_item, so this is the ONLY landing surface that catches such runs.
  const runs = useAggregatedRuns();
  const readyToReviewRuns = React.useMemo(
    () => runs.filter((run) => run.status === 'awaiting_review'),
    [runs],
  );

  const hasAny =
    permissionItems.length > 0 ||
    decisionItems.length > 0 ||
    humanTaskItems.length > 0 ||
    idleItems.length > 0 ||
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

      {idleItems.length > 0 && (
        <section data-testid="queue-group-idle">
          <GroupHeader
            swatchClass="bg-interactive"
            name="Idle sessions"
            count={idleItems.length}
            descriptor="Quick sessions gone quiet — reopen or wrap up (oldest first)"
          />
          {idleItems.map((it) => (
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
