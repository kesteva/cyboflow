/**
 * LandingHome — the composed cross-project home surface.
 *
 * This is the single orchestrating component for the landing experience. It
 * reads the aggregated cross-project signals (projects, the review_items inbox,
 * the real-time approval queue, active runs, and passively detected dynamic
 * workflows), derives the coarse {@link HomeState}, and renders the matching
 * arrangement of the now-existing leaf components. Each leaf is self-contained and reads its own slice of the
 * stores — LandingHome only owns the state derivation, the layout shell, and
 * the optional `focusQueue` scroll-into-view behaviour.
 *
 * State → layout:
 *   - `empty`      → {@link EmptyState} (self-centering).
 *   - `reviews`    → scroll column: {@link SubHeader} (reviews) +
 *                    {@link TypeGroupedQueue} + {@link ActiveAgents} + {@link EndCta}.
 *   - `caught-up`  → centered {@link CaughtUpHero}.
 *   - `some-idle`  → {@link SubHeader} (none, not-all-active) + {@link ActiveAgents}
 *                    + {@link IdleStartList} + {@link EndCta}.
 *   - `all-active` → {@link SubHeader} (none, all-active) + {@link ActiveAgents}
 *                    + {@link EndCta}.
 */
import { useEffect, useMemo, useRef } from 'react';
import {
  useProjectsCount,
  useLandingProjects,
  useAggregatedReviewItems,
  useAggregatedRuns,
} from '../../stores/landingStore';
import { useReviewQueueStore, useReviewQueueView } from '../../stores/reviewQueueStore';
import { useDynamicWorkflowStore, useActiveDynamicWorkflows } from '../../stores/dynamicWorkflowStore';
import { classifyRun, deriveHomeState } from '../../utils/homeClassify';
import type { QueueItem } from '../../utils/reviewQueueSelectors';
import { EmptyState } from './EmptyState';
import { SubHeader } from './SubHeader';
import { TypeGroupedQueue } from './TypeGroupedQueue';
import { ActiveAgents } from './ActiveAgents';
import { IdleStartList } from './IdleStartList';
import { CaughtUpHero } from './CaughtUpHero';
import { EndCta } from './EndCta';

/**
 * Faint graph-paper grid backdrop for loaded (non-empty) states. Applied as an
 * inline style because the grid is a literal visual detail with no semantic
 * Tailwind token — the same inline-backgroundImage pattern CaughtUpHero uses
 * for its hazard stripe. The hairline color matches the design border (#d8cfb8).
 */
const GRAPH_PAPER_STYLE: React.CSSProperties = {
  backgroundImage:
    'linear-gradient(to right, rgba(216,207,184,0.35) 1px, transparent 1px),' +
    'linear-gradient(to bottom, rgba(216,207,184,0.35) 1px, transparent 1px)',
  backgroundSize: '24px 24px',
};

export interface LandingHomeProps {
  /**
   * When true, the review-queue section is scrolled into view on mount — used
   * when the user arrives here from a "review queue" rail affordance.
   */
  focusQueue?: boolean;
}

/** Count the underlying approvals represented by a list of grouped queue items. */
function countApprovals(items: QueueItem[]): number {
  let total = 0;
  for (const item of items) {
    total += item.kind === 'single' ? 1 : item.items.length;
  }
  return total;
}

/** LandingHome — see {@link LandingHomeProps}. */
export default function LandingHome({ focusQueue = false }: LandingHomeProps): React.JSX.Element {
  const projectsCount = useProjectsCount();
  const projects = useLandingProjects();
  const reviewItems = useAggregatedReviewItems();
  const runs = useAggregatedRuns();

  // Real-time approval queue length (permission-kind gates).
  const approvalsCount = useReviewQueueStore((s) => s.queue.length);
  // Grouped approval view → blocking subset (age-thresholded) for the count.
  const { blocking: blockingApprovalItems } = useReviewQueueView();

  // Dynamic-workflow store — idempotent init (the same discard-the-return
  // pattern landingStore uses for activeRunsStore.init) so every landing visit
  // is subscribed to passively detected dynamic workflows.
  useEffect(() => {
    useDynamicWorkflowStore.getState().init();
  }, []);
  const activeDynamicWorkflows = useActiveDynamicWorkflows();

  // Run-activity splits. Sessions with a detected dynamic workflow in flight
  // count as activity too: the `__quick__` sentinel runs backing quick sessions
  // are filtered out of activeRunsStore, so without this the home would claim
  // 'caught-up' while a dynamic workflow is running.
  const activeRunCount = useMemo(
    () => runs.filter((run) => classifyRun(run.status) === 'active').length,
    [runs],
  );
  const activeCount = activeRunCount + activeDynamicWorkflows.length;

  // Idle projects: projects with no active OR blocked run in flight.
  const idleCount = useMemo(() => {
    const busy = new Set<number>();
    for (const run of runs) {
      const activity = classifyRun(run.status);
      if (activity === 'active' || activity === 'blocked') busy.add(run.project_id);
    }
    return projects.filter((project) => !busy.has(project.id)).length;
  }, [runs, projects]);

  const waitingCount = approvalsCount + reviewItems.length;
  const blockingCount =
    countApprovals(blockingApprovalItems) +
    reviewItems.filter((it) => it.blocking).length;

  const reviewsExist = waitingCount > 0;
  const anyActive = activeCount > 0;
  const anyIdle = idleCount > 0;

  const state = deriveHomeState({ projectsCount, reviewsExist, anyActive, anyIdle });

  // focusQueue: scroll the queue section into view once mounted.
  const queueRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusQueue && state === 'reviews' && queueRef.current !== null) {
      queueRef.current.scrollIntoView({ block: 'start' });
    }
  }, [focusQueue, state]);

  if (state === 'empty') {
    return (
      <div className="h-full w-full overflow-y-auto">
        <EmptyState />
      </div>
    );
  }

  if (state === 'caught-up') {
    return (
      <div
        className="flex h-full w-full items-center justify-center overflow-y-auto px-7 py-10 font-mono"
        style={GRAPH_PAPER_STYLE}
      >
        <CaughtUpHero />
      </div>
    );
  }

  if (state === 'reviews') {
    return (
      <div className="h-full w-full overflow-y-auto" style={GRAPH_PAPER_STYLE}>
        <div className="mx-auto w-full max-w-[860px] px-7 py-4 font-mono">
          <SubHeader
            mode="reviews"
            waitingCount={waitingCount}
            blockingCount={blockingCount}
            workingCount={activeCount}
            idleCount={idleCount}
            allActive={!anyIdle}
          />
          <div ref={queueRef}>
            <TypeGroupedQueue />
          </div>
          <ActiveAgents />
          <EndCta />
        </div>
      </div>
    );
  }

  // 'some-idle' | 'all-active' — both render the all-clear summary header.
  const allActive = state === 'all-active';
  return (
    <div className="h-full w-full overflow-y-auto" style={GRAPH_PAPER_STYLE}>
      <div className="mx-auto w-full max-w-[860px] px-7 py-4 font-mono">
        <SubHeader
          mode="none"
          waitingCount={waitingCount}
          blockingCount={blockingCount}
          workingCount={activeCount}
          idleCount={idleCount}
          allActive={allActive}
        />
        <ActiveAgents />
        {!allActive && <IdleStartList />}
        <EndCta />
      </div>
    </div>
  );
}
