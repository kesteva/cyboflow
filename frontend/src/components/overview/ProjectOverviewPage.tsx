/**
 * ProjectOverviewPage — the center-pane surface for a project, shown when the
 * user clicks a project row in the sidebar (navigationStore.projectOverviewOpen).
 *
 * Three sections, always in this order and always present in SOME form (the
 * design keeps the page's shape in every state, swapping bodies for dashed
 * empty wells rather than dropping headings):
 *   1. {@link OverviewActiveAgents}       — what is live in this project now.
 *   2. {@link OverviewRecommendedActions} — what to do next.
 *   3. {@link OverviewBacklogSection}     — the planning pipeline + the two
 *      launch surfaces (ideas → planner, tasks → sprint).
 *
 * ## Data
 * Live data comes from the EXISTING stores, each wired per its own contract:
 *   - backlogStore / reviewQueueStore / activeRunsStore are APP-OWNED
 *     singletons: App.tsx init()s each at the app-shell level for the app's
 *     lifetime, so this page only READS them (plus a per-project
 *     activeRunsStore.refresh). Their init() returns the ONE cached global
 *     teardown, so a page-scoped init effect here would hand React the app's
 *     own unsubscribe and sever live updates app-wide on unmount.
 *   - quickSessionsStore.init() (genuinely ref-counted 3s poll — the one
 *     store this page does own a mount/unmount pair for)
 *
 * The three RECOMMENDATION inputs that no store owns (workflow run stats, the
 * verification setup rows, the project's tracker connections) are plain
 * cancellable one-shot queries re-fired on project change. Each failure is
 * logged and degrades that ONE input to its neutral value, which simply drops
 * the card it would have produced — the page never blanks on a failed sub-fetch.
 *
 * ## Loading
 * No spinner wall: until the backlog store's first sync commits, the page
 * renders its header and the section headings over empty bodies, which is the
 * same skeleton the empty states use.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { GitBranch } from 'lucide-react';
import { TaskBatchPickerModal } from '../cyboflow/TaskBatchPickerModal';
import { DEFAULT_SUBSTRATE } from '../../../../shared/types/substrate';
import { OverviewActiveAgents } from './OverviewActiveAgents';
import { OverviewRecommendedActions, readDismissed } from './OverviewRecommendedActions';
import { OverviewBacklogSection } from './OverviewBacklogSection';
import { useOverviewLaunch } from './useOverviewLaunch';
import {
  deriveOverviewBacklog,
  deriveRecommendedActions,
  selectOverviewPageState,
  type DerivedRecommendedActions,
  type OverviewPageState,
} from './overviewModel';
import { filterTasks } from '../Backlog/backlogSelectors';
import { useBacklogStore } from '../../stores/backlogStore';
import { useActiveRunsStore } from '../../stores/activeRunsStore';
import { useQuickSessionsStore } from '../../stores/quickSessionsStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { trpc } from '../../trpc/client';
import { ViewSurface } from '../../customViews/ViewSurface';
import type { BacklogTaskItem, BoardStage } from '../../../../shared/types/tasks';
import type { WorkflowRunStats } from '../../../../shared/types/insights';
import type { VerifyProjectSetupRow } from '../../../../shared/types/visualVerification';
import type { TrackerProvider } from '../../../../shared/types/trackerSync';

// ---------------------------------------------------------------------------
// Recommendation inputs that no store owns
// ---------------------------------------------------------------------------

/** The tracker facts the recommendation model needs, folded from the project's connections. */
interface TrackerSnapshot {
  conflictCount: number;
  provider: TrackerProvider | null;
  lastSyncAt: string | null;
}

const NO_TRACKER: TrackerSnapshot = { conflictCount: 0, provider: null, lastSyncAt: null };

export interface ProjectOverviewPageProps {
  projectId: number;
}

export function ProjectOverviewPage({ projectId }: ProjectOverviewPageProps): React.JSX.Element {
  // -- Store wiring ---------------------------------------------------------
  // backlogStore / reviewQueueStore / activeRunsStore are deliberately NOT
  // init()'d here: App.tsx owns their app-lifetime init, and their idempotent
  // init() returns the same cached GLOBAL unsubscribe — returning it from a
  // page effect would tear down app-wide subscriptions when this page unmounts
  // (e.g. on opening a run). quickSessionsStore is ref-counted, so its
  // mount/unmount pair is safe.
  useEffect(() => useQuickSessionsStore.getState().init(), []);
  useEffect(() => {
    void useActiveRunsStore.getState().refresh(projectId);
  }, [projectId]);

  const tasks = useBacklogStore((s) => s.tasks);
  const boards = useBacklogStore((s) => s.boards);
  const projectName = useBacklogStore(
    (s) => s.projects.find((p) => p.id === projectId)?.name ?? null,
  );

  // -- One-shot recommendation inputs --------------------------------------
  const [workflowStats, setWorkflowStats] = useState<WorkflowRunStats[]>([]);
  const [verifySetup, setVerifySetup] = useState<VerifyProjectSetupRow | undefined>(undefined);
  const [tracker, setTracker] = useState<TrackerSnapshot>(NO_TRACKER);

  useEffect(() => {
    let cancelled = false;

    // Reset to neutral so a project switch never shows the previous project's
    // recommendation inputs while the new ones are in flight.
    setWorkflowStats([]);
    setVerifySetup(undefined);
    setTracker(NO_TRACKER);

    void trpc.cyboflow.insights.workflowStats
      .query({ projectId })
      .then((rows) => {
        if (!cancelled) setWorkflowStats(rows);
      })
      .catch((err: unknown) => {
        console.warn('[ProjectOverviewPage] workflowStats failed:', err);
      });

    void trpc.cyboflow.verificationRequests.setupByProject
      .query()
      .then((rows) => {
        if (!cancelled) setVerifySetup(rows.find((r) => r.projectId === projectId));
      })
      .catch((err: unknown) => {
        console.warn('[ProjectOverviewPage] setupByProject failed:', err);
      });

    void trpc.cyboflow.tracker.connections
      .query({ projectId })
      .then((rows) => {
        if (cancelled) return;
        if (rows.length === 0) {
          setTracker(NO_TRACKER);
          return;
        }
        // `openConflictCount` rides the connection summary, so the conflict
        // count needs no per-connection fan-out. Provider / last-sync come from
        // the first connection — the copy names "your tracker", not each one.
        setTracker({
          conflictCount: rows.reduce((sum, c) => sum + c.openConflictCount, 0),
          provider: rows[0].provider,
          lastSyncAt: rows[0].lastSyncAt,
        });
      })
      .catch((err: unknown) => {
        console.warn('[ProjectOverviewPage] tracker connections failed:', err);
      });

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // -- Dismissed recommendations (per project, localStorage) ----------------
  // `actionId → fingerprint`: a dismissal holds only while the card's trigger
  // state is unchanged (see RecommendedAction.fingerprint).
  const [dismissed, setDismissed] = useState<Record<string, string>>(() =>
    readDismissed(projectId),
  );
  useEffect(() => {
    setDismissed(readDismissed(projectId));
  }, [projectId]);

  // -- Derivations ----------------------------------------------------------

  /**
   * The project's board-visible items — the same narrowing BacklogPane applies
   * (`filterTasks(tasks, projectId, showArchived=false)`), so the Overview's
   * counts can never disagree with the board the user clicks through to.
   */
  const projectItems = useMemo<BacklogTaskItem[]>(
    () => filterTasks(tasks, projectId, false),
    [tasks, projectId],
  );

  const stages = useMemo<BoardStage[]>(
    () => boards.filter((b) => b.project_id === projectId).flatMap((b) => b.stages),
    [boards, projectId],
  );

  // codebaseFresh is `null` (unknown) — no freshness probe exists yet, and the
  // model maps unknown to the 'existing codebase' empty state rather than
  // guessing a fresh one.
  const pageState: OverviewPageState = useMemo(
    () => selectOverviewPageState({ items: projectItems, codebaseFresh: null }),
    [projectItems],
  );

  const backlog = useMemo(
    () => deriveOverviewBacklog(projectItems, stages),
    [projectItems, stages],
  );

  /** id → raw row, for the idea "Open" handler and the display refs. */
  const itemsById = useMemo(() => {
    const map = new Map<string, BacklogTaskItem>();
    for (const item of projectItems) {
      map.set(item.id, item);
      for (const child of item.children ?? []) map.set(child.id, child);
    }
    return map;
  }, [projectItems]);

  // `nowIso` is captured once per data change rather than per render: the only
  // thing it feeds is a "N days ago" phrase, which does not need a live clock.
  const actions = useMemo<DerivedRecommendedActions>(
    () =>
      deriveRecommendedActions({
        backlog,
        workflowStats,
        verifySetup,
        trackerConflictCount: tracker.conflictCount,
        trackerProvider: tracker.provider,
        trackerLastSyncAt: tracker.lastSyncAt,
        dismissed,
        nowIso: new Date().toISOString(),
      }),
    [backlog, workflowStats, verifySetup, tracker, dismissed],
  );

  // -- Navigation callbacks -------------------------------------------------

  // "Select tasks" opens the SAME pre-launch batch picker the backlog's Run
  // button uses (TaskBatchPickerModal) — selection, eligibility, and the
  // substrate cap all live there, so the CTA and the backlog can never
  // diverge on what is launchable.
  const [batchPickerOpen, setBatchPickerOpen] = useState(false);
  const onSelectTasks = useCallback(() => {
    setBatchPickerOpen(true);
  }, []);

  const onRunFlow = useCallback(
    (workflowName: 'compound' | 'verify-setup' | 'launch' | 'planner') => {
      useNavigationStore.getState().goToWizard({
        preselectWorkflowName: workflowName,
        lockProjectId: projectId,
      });
    },
    [projectId],
  );

  const onReviewTrackerConflicts = useCallback(() => {
    useNavigationStore.getState().openSettings('integrations');
  }, []);

  const onOpenBacklog = useCallback(() => {
    useBacklogStore.getState().setFilterProject(projectId);
    useNavigationStore.getState().openBacklog();
  }, [projectId]);

  // "Plan the next idea" launches the planner DIRECTLY on the top open idea —
  // the same light path (`useOverviewLaunch`) the ideas selection bar uses, so
  // the CTA and the bar can never diverge. When every top idea is already in
  // flow there is nothing to seed, so it falls back to the wizard (which owns
  // its own idea picker) rather than launching an unseeded planner.
  const {
    launchPlanner: launchTopIdeaPlanner,
    launchSprint,
    error: launchError,
    launching: topIdeaLaunching,
  } = useOverviewLaunch();
  const topIdeaId = backlog.topIdeas.find((i) => !i.inFlow)?.id ?? null;
  const onLaunchTopIdea = useCallback(() => {
    if (topIdeaLaunching !== null) return;
    if (topIdeaId === null) {
      onRunFlow('planner');
      return;
    }
    void launchTopIdeaPlanner([topIdeaId], projectId);
  }, [launchTopIdeaPlanner, onRunFlow, projectId, topIdeaId, topIdeaLaunching]);

  // The view-aware tail (docs/proposals/CUSTOM-VIEWS.md §5.2) — same treatment
  // as the review queue: the three sections keep their components and props,
  // and only their ORDER becomes data.
  const sections: Record<string, React.ReactNode | null> = {
    'overview.active-agents': <OverviewActiveAgents projectId={projectId} pageState={pageState} />,
    'overview.recommended': (
      <OverviewRecommendedActions
        projectId={projectId}
        pageState={pageState}
        actions={actions}
        dismissed={dismissed}
        onDismissedChange={setDismissed}
        onSelectTasks={onSelectTasks}
        onLaunchTopIdea={onLaunchTopIdea}
        onRunFlow={onRunFlow}
        onReviewTrackerConflicts={onReviewTrackerConflicts}
        onAddIdea={onOpenBacklog}
      />
    ),
    'overview.backlog': (
      <OverviewBacklogSection
        projectId={projectId}
        pageState={pageState}
        backlog={backlog}
        itemsById={itemsById}
        onOpenBacklog={onOpenBacklog}
        onRunPlannerFlow={() => onRunFlow('planner')}
      />
    ),
  };

  // The launch-error row is page chrome, and it sits BETWEEN active agents and
  // recommended actions — not directly under the header. Anchoring it to the
  // section it follows is what keeps the Default view identical to today's
  // page; a `chrome.afterHeader` slot would have moved it up one position.
  const chrome = {
    afterSection: {
      // Errors from BOTH light launch paths (top-idea planner CTA, the batch
      // picker's sprint launch) surface here.
      'overview.active-agents':
        launchError !== null ? (
          <p className="text-status-error" role="alert" style={{ fontSize: '11px' }}>
            {launchError}
          </p>
        ) : null,
    },
  };

  return (
    <div
      className="h-full overflow-y-auto bg-bg-primary"
      data-scroll-container
      data-testid="project-overview-page"
    >
      <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-7 px-11 pb-12 pt-9">
        {/* Page header — git-branch mark + project name. No eyebrow, no counts
            line: the sections carry their own counts. S5 adds the view switcher
            + Customize cluster to the right of the title. */}
        <header className="flex items-center gap-2.5">
          <GitBranch className="h-[18px] w-[18px] shrink-0 text-text-secondary" strokeWidth={1.8} />
          <h1
            className="truncate font-bold tracking-tight text-text-primary"
            style={{ fontSize: '24px' }}
          >
            {projectName ?? 'Project'}
          </h1>
        </header>

        <ViewSurface
          surface="project-overview"
          sections={sections}
          context={{ projectId }}
          chrome={chrome}
        />
      </div>

      {/* Sprint batch picker — the same modal the backlog's Run button opens;
          it owns eligibility + the substrate cap, `launchSprint` is the same
          light runs.start path the inline selection bar uses. */}
      {batchPickerOpen && (
        <TaskBatchPickerModal
          isOpen
          projectId={projectId}
          substrate={DEFAULT_SUBSTRATE}
          onClose={() => setBatchPickerOpen(false)}
          onPicked={(taskIds) => {
            setBatchPickerOpen(false);
            void launchSprint(taskIds, projectId);
          }}
        />
      )}
    </div>
  );
}

export default ProjectOverviewPage;
