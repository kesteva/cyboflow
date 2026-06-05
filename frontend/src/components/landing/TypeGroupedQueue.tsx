/**
 * TypeGroupedQueue — the landing-home review inbox, grouped by item TYPE.
 *
 * Three groups, always in this fixed order, each rendered only when it holds at
 * least one item:
 *   1. PERMISSION  (amber swatch) — real-time PreToolUse/approval gates. These
 *      come from the APPROVAL path (useReviewQueueView blocking+normal), rendered
 *      via the existing PendingApprovalCard. All approvals are permission-kind.
 *   2. DECISION    (rust swatch)  — approve-idea / approve-plan gates from the
 *      review_items inbox (kind === 'decision'), rendered via ReviewItemCard.
 *   3. HUMAN TASK  (blue swatch)  — free-form action items (kind === 'human_task'),
 *      rendered via ReviewItemCard.
 *
 * Findings are intentionally DROPPED here — the landing aggregation
 * (useAggregatedReviewItems) only surfaces decision + human_task, and findings
 * never count toward any group.
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
import type { ReviewItem } from '../../../../shared/types/reviews';
import type { WorkflowRunStatus } from '../../../../shared/types/cyboflow';
import { useAggregatedReviewItems, useRunProjectMap } from '../../stores/landingStore';
import { useCyboflowStore } from '../../stores/cyboflowStore';
import { useNavigationStore } from '../../stores/navigationStore';

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
  const humanTaskItems = React.useMemo(
    () => reviewItems.filter((it) => it.kind === 'human_task'),
    [reviewItems],
  );

  const hasAny =
    permissionItems.length > 0 || decisionItems.length > 0 || humanTaskItems.length > 0;

  if (!hasAny) {
    return (
      <div className="py-16 text-center text-sm text-text-muted">
        <b className="mb-1.5 block text-base text-text-primary">No pending reviews</b>
        New checkpoints land here as agents pause for permission, a decision, or a task.
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
    </div>
  );
}
