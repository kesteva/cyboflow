/**
 * LandingHome — the Human Review Queue: the app's landing surface.
 *
 * One page that answers, in order, "what is waiting on me", "what can I merge",
 * "what is still running", and "what should I start next". It owns the store
 * wiring, the derived {@link QueuePageState}, every navigation/launch side
 * effect, and the two session-lifecycle dialogs; the section components under
 * `landing/` are presentational and take what they render as props.
 *
 * ## State → layout
 *
 * {@link deriveQueuePageState} picks exactly one arrangement:
 *   - `error`       — header + the load-error panel. Nothing below it can be
 *                     trusted, so nothing below it renders.
 *   - `no-accounts` — connect CTAs replace the usage cards and the queue; the
 *                     backlog still renders, because browsing it needs no agent.
 *   - `no-projects` — usage cards + the add-a-project well. No backlog: there is
 *                     no project for one to belong to.
 *   - `no-sessions` — bootstrap. The three session sections collapse into one
 *                     "Sessions" well, and the recommended actions are the
 *                     where-to-start cards.
 *   - `caught-up`   — the "All caught up" well replaces the session sections,
 *                     but Working still lists live agents and the backlog
 *                     collapses to its funnel strip.
 *   - `all-idle`    — a green "nothing is blocked" strip, then the ordinary
 *                     sections with dashed wells where they are empty.
 *   - `normal`      — every section.
 *
 * ## Counts
 *
 * `waitingCount` keeps the composition the previous landing used, including the
 * raw `awaiting_review` run count: a clean drain mints no review item, so
 * without it a finished run could not keep the page off `caught-up`. The
 * RENDERED ready-for-review rows use the gate-aware
 * {@link selectReadyToReviewRuns} instead, so a run parked at an intermediate
 * human gate stays in its blocking group rather than being offered for merge.
 */
import React from 'react';
import {
  useAggregatedBlockingFindings,
  useAggregatedBlockingRunIds,
  useAggregatedReviewItems,
  useAggregatedRuns,
  useLandingProjects,
  useLandingStore,
  useProjectsCount,
  useRunProjectMap,
  useRunSessionMap,
} from '../../stores/landingStore';
import { useReviewQueueStore, useReviewQueueView } from '../../stores/reviewQueueStore';
import { useActiveDynamicWorkflows, useDynamicWorkflowStore } from '../../stores/dynamicWorkflowStore';
import { useQuickSessionRows, useQuickSessionsStore, needsAttention } from '../../stores/quickSessionsStore';
import { useBacklogStore } from '../../stores/backlogStore';
import { useCyboflowStore } from '../../stores/cyboflowStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useErrorStore } from '../../stores/errorStore';
import { useAgentProviderAccess } from '../../hooks/useAgentProviderAccess';
import { trpc } from '../../trpc/client';
import { classifyRun } from '../../utils/homeClassify';
import { deriveQuickSessionTriage } from '../../utils/quickSessionTriage';
import { deriveQueuePageState } from '../../utils/reviewQueuePageState';
import { deriveRecommendedActions, type RecommendedAction } from '../../utils/recommendedActions';
import { readDismissals, recordDismissal, type DismissalMap } from '../../utils/recommendedActionDismissals';
import { findGuardedExperimentForSession } from '../../utils/armDismissGuard';
import { AGENT_PROVIDERS } from '../../../../shared/types/agentRuntime';
import { IDLE_REVIEW_SOURCE_PREFIX, type ReviewItem } from '../../../../shared/types/reviews';
import type { QuickSessionRow } from '../../../../shared/types/quickSessions';
import type { ExperimentRow } from '../../../../shared/types/experiments';
import type { SessionSettleState } from '../../../../shared/types/cyboflow';
import { countApprovals, selectReadyToReviewRuns } from './queueSelectors';
import { useTaskRunLauncher } from '../Backlog/useTaskRunLauncher';
import { ProviderUsageCards } from '../ReviewQueue/ProviderUsageCards';
import { SessionMergeDialog } from '../cyboflow/SessionMergeDialog';
import { SessionDismissDialog } from '../cyboflow/SessionDismissDialog';
import { AddIdeaModal } from './AddIdeaModal';
import { QueueHeader } from './QueueHeader';
import { RecommendedActionsSection } from './RecommendedActionsSection';
import { NeedsInputSection } from './NeedsInputSection';
import { NotificationsSection } from './NotificationsSection';
import { HumanTasksSection } from './HumanTasksSection';
import { ReadyForReviewSection, type ReadyRow } from './ReadyForReviewSection';
import { WorkingSection, type WorkingRow } from './WorkingSection';
import { BacklogSection } from './BacklogSection';
import {
  AllIdleStrip,
  CaughtUpWell,
  LoadErrorPanel,
  NoAccountsPanel,
  NoProjectsPanel,
  NoSessionsWell,
} from './QueueStateWells';

/**
 * Faint graph-paper grid backdrop. Inline because the grid is a literal visual
 * detail with no semantic Tailwind token; the hairline matches the design border.
 */
const GRAPH_PAPER_STYLE: React.CSSProperties = {
  backgroundImage:
    'linear-gradient(to right, rgba(216,207,184,0.35) 1px, transparent 1px),' +
    'linear-gradient(to bottom, rgba(216,207,184,0.35) 1px, transparent 1px)',
  backgroundSize: '24px 24px',
};

/** Wall-clock cadence for the shared "quiet for N" labels (minutes resolution). */
const ELAPSED_TICK_MS = 30_000;

/** How long a Recommended-actions jump keeps its target section ringed. */
const FLASH_MS = 2000;

export interface LandingHomeProps {
  /**
   * When true, the "Needs your input" section is scrolled into view on mount —
   * used when the user arrives here from a "review queue" rail affordance.
   */
  focusQueue?: boolean;
}

/** Open a quick session AND mark it viewed, then refresh so its row updates promptly. */
function openQuickSession(row: Pick<QuickSessionRow, 'sessionId' | 'runId' | 'projectId'>): void {
  useCyboflowStore.getState().setActiveQuickSession(row.sessionId, row.runId ?? undefined);
  useNavigationStore.getState().setActiveProjectId(row.projectId);
  useNavigationStore.getState().goToSession();
  void useSessionStore
    .getState()
    .markSessionAsViewed(row.sessionId)
    .finally(() => {
      void useQuickSessionsStore.getState().refresh();
    });
}

/** Open a FLOW run as the session workspace. Never route a quick session here. */
function openRunSession(runId: string, projectId: number): void {
  useCyboflowStore.getState().setActiveRun(runId);
  useNavigationStore.getState().setActiveProjectId(projectId);
  useNavigationStore.getState().goToSession();
}

/** LandingHome — see {@link LandingHomeProps}. */
export default function LandingHome({ focusQueue = false }: LandingHomeProps): React.JSX.Element {
  // -------------------------------------------------------------------------
  // Store wiring
  // -------------------------------------------------------------------------
  const projectsCount = useProjectsCount();
  const projects = useLandingProjects();
  const reviewItems = useAggregatedReviewItems();
  const blockingFindings = useAggregatedBlockingFindings();
  const landingBlockingRunIds = useAggregatedBlockingRunIds();
  const runs = useAggregatedRuns();
  const runProjectMap = useRunProjectMap();
  const runSessionMap = useRunSessionMap();
  const loadError = useLandingStore((s) => s.loadError);
  const retryLanding = useLandingStore((s) => s.retry);

  const approvalsCount = useReviewQueueStore((s) => s.queue.length);
  const { blocking: blockingApprovalItems, normal: normalApprovalItems } = useReviewQueueView();
  const approvals = React.useMemo(
    () => [...blockingApprovalItems, ...normalApprovalItems],
    [blockingApprovalItems, normalApprovalItems],
  );

  // Idempotent inits — each store ref-counts or caches its own wiring, so a
  // remount joins the live subscription rather than starting a second one.
  React.useEffect(() => {
    useDynamicWorkflowStore.getState().init();
  }, []);
  React.useEffect(() => useQuickSessionsStore.getState().init(), []);
  React.useEffect(() => useBacklogStore.getState().init(), []);

  const activeDynamicWorkflows = useActiveDynamicWorkflows();
  const quickRows = useQuickSessionRows();
  const backlogTasks = useBacklogStore((s) => s.tasks);
  const backlogBoards = useBacklogStore((s) => s.boards);

  const providerAccess = useAgentProviderAccess();
  const providersConnected = React.useMemo(
    () => AGENT_PROVIDERS.some((provider) => providerAccess[provider] === true),
    [providerAccess],
  );

  const { launchingTaskId, launch, launchSprintBatch, launchPlannerBatch } = useTaskRunLauncher();

  // -------------------------------------------------------------------------
  // Shared clock — one interval for every elapsed label, paused when hidden.
  // -------------------------------------------------------------------------
  const [nowMs, setNowMs] = React.useState<number>(() => Date.now());
  React.useEffect(() => {
    const tick = (): void => setNowMs(Date.now());
    let id: number | null = null;
    const start = (): void => {
      if (id !== null) return;
      tick();
      id = window.setInterval(tick, ELAPSED_TICK_MS);
    };
    const stop = (): void => {
      if (id === null) return;
      window.clearInterval(id);
      id = null;
    };
    const onVisibility = (): void => {
      if (document.hidden) stop();
      else start();
    };
    if (document.hidden) tick();
    else start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stop();
    };
  }, []);

  // -------------------------------------------------------------------------
  // Derivations
  // -------------------------------------------------------------------------
  const activeWorkflowSessionIds = React.useMemo(
    () => new Set(activeDynamicWorkflows.map((w) => w.sessionId)),
    [activeDynamicWorkflows],
  );
  const triage = React.useMemo(
    () => deriveQuickSessionTriage(quickRows, activeWorkflowSessionIds, nowMs),
    [quickRows, activeWorkflowSessionIds, nowMs],
  );

  const projectNameById = React.useMemo(() => {
    const map: Record<number, string> = {};
    for (const project of projects) map[project.id] = project.name;
    return map;
  }, [projects]);

  const activeRunCount = React.useMemo(
    () => runs.filter((run) => classifyRun(run.status) === 'active').length,
    [runs],
  );
  const readyToReviewCount = React.useMemo(
    () => runs.filter((run) => run.status === 'awaiting_review').length,
    [runs],
  );
  const attentionQuickCount = React.useMemo(() => quickRows.filter(needsAttention).length, [quickRows]);

  // Decisions are asks (red band); notifications are FYIs (grey band). They were
  // one list until a finished dynamic workflow started reading as "Asked you —
  // Answer →", claiming a reply nobody was waiting for.
  const decisionItems = React.useMemo(
    () => reviewItems.filter((it) => it.kind === 'decision'),
    [reviewItems],
  );
  const notificationItems = React.useMemo(
    () => reviewItems.filter((it) => it.kind === 'notification'),
    [reviewItems],
  );
  const humanTaskItems = React.useMemo(
    () =>
      reviewItems.filter(
        (it) => it.kind === 'human_task' && !(it.source?.startsWith(IDLE_REVIEW_SOURCE_PREFIX) ?? false),
      ),
    [reviewItems],
  );

  const waitingCount =
    approvalsCount + reviewItems.length + readyToReviewCount + attentionQuickCount;
  const blockedCount =
    countApprovals(blockingApprovalItems) +
    reviewItems.filter((it) => it.blocking).length +
    quickRows.filter((r) => r.state === 'blocked').length;
  const workingCount = activeRunCount + activeDynamicWorkflows.length + triage.working.length;
  const sessionsCount =
    quickRows.length + runs.filter((run) => classifyRun(run.status) !== 'terminal').length;

  const state = deriveQueuePageState({
    loadError,
    providersConnected,
    projectsCount,
    sessionsCount,
    waitingCount,
    blockedCount,
    workingCount,
  });

  // -------------------------------------------------------------------------
  // Recommended actions
  // -------------------------------------------------------------------------
  const [dismissals, setDismissals] = React.useState<DismissalMap>(() => readDismissals());
  const recommended = React.useMemo(
    () =>
      deriveRecommendedActions({
        nowMs,
        quickSessionTriage: triage,
        activeRuns: runs,
        // The engine's blocking-finding detector reads findings, which the
        // aggregated inbox deliberately excludes — feed it both lists.
        reviewItems: [...reviewItems, ...blockingFindings],
        tasks: backlogTasks,
        projects,
        dismissedSignatures: dismissals,
      }),
    [nowMs, triage, runs, reviewItems, blockingFindings, backlogTasks, projects, dismissals],
  );

  const recommendedSubtitle =
    state === 'no-sessions' || state === 'no-projects'
      ? 'Where to start on a fresh project'
      : state === 'all-idle'
        ? 'Clear the idle pile'
        : state === 'caught-up'
          ? 'Queue is clear — start the next thing'
          : undefined;

  // -------------------------------------------------------------------------
  // Ready-for-review rows + the live-experiment-arm guard
  // -------------------------------------------------------------------------
  const readyRuns = React.useMemo(
    () => selectReadyToReviewRuns(runs, reviewItems, approvals, landingBlockingRunIds),
    [runs, reviewItems, approvals, landingBlockingRunIds],
  );
  const readyRows = React.useMemo<ReadyRow[]>(
    () => [
      ...triage.readyForReview.map((row) => ({ kind: 'quick' as const, id: row.sessionId, row })),
      ...readyRuns.map((run) => ({ kind: 'run' as const, id: run.id, run })),
    ],
    [triage.readyForReview, readyRuns],
  );

  // A session that is one arm of a LIVE A/B experiment must not be merged or
  // dismissed from here — accepting one arm strands the experiment undecided
  // (the same reason SessionLifecycleActionBar guards those actions). We hide
  // the inline actions rather than prompting, leaving "Open session" as the way
  // in. Any read failure leaves the set empty, i.e. fails OPEN, matching the
  // action bar's "never block on a failed guard read" contract.
  const readyProjectKey = React.useMemo(
    () => [...new Set(triage.readyForReview.map((r) => r.projectId))].sort().join(','),
    [triage.readyForReview],
  );
  const [experiments, setExperiments] = React.useState<ExperimentRow[]>([]);
  React.useEffect(() => {
    const projectIds = readyProjectKey === '' ? [] : readyProjectKey.split(',').map(Number);
    if (projectIds.length === 0) {
      setExperiments([]);
      return;
    }
    let cancelled = false;
    void Promise.all(
      projectIds.map((projectId) =>
        trpc.cyboflow.experiments.listForProject
          .query({ projectId })
          .catch((): ExperimentRow[] => []),
      ),
    ).then((lists) => {
      if (!cancelled) setExperiments(lists.flat());
    });
    return () => {
      cancelled = true;
    };
  }, [readyProjectKey]);

  const guardedSessionIds = React.useMemo(() => {
    const guarded = new Set<string>();
    for (const row of triage.readyForReview) {
      if (findGuardedExperimentForSession(row.sessionId, experiments) !== null) {
        guarded.add(row.sessionId);
      }
    }
    return guarded;
  }, [triage.readyForReview, experiments]);

  // -------------------------------------------------------------------------
  // Working rows
  // -------------------------------------------------------------------------
  const workingRows = React.useMemo<WorkingRow[]>(() => {
    const quickSessionIds = new Set(quickRows.map((r) => r.sessionId));
    return [
      ...runs
        .filter((run) => classifyRun(run.status) === 'active')
        .map((run) => ({ kind: 'run' as const, id: run.id, run })),
      ...triage.working.map((row) => ({ kind: 'quick' as const, id: row.sessionId, row })),
      // A dynamic workflow on a known quick session is already represented by
      // that session's row (the triage promotes it to `running`), so only
      // orphans — a workflow on a session the board doesn't list — appear here.
      ...activeDynamicWorkflows
        .filter((w) => !quickSessionIds.has(w.sessionId))
        .map((workflow) => ({ kind: 'dynamic' as const, id: workflow.wfRunId, workflow })),
    ];
  }, [runs, triage.working, activeDynamicWorkflows, quickRows]);

  // -------------------------------------------------------------------------
  // Section refs, focus + flash
  // -------------------------------------------------------------------------
  const needsInputRef = React.useRef<HTMLElement>(null);
  const readyRef = React.useRef<HTMLDivElement>(null);
  const [flashing, setFlashing] = React.useState(false);
  const flashTimer = React.useRef<number | null>(null);

  React.useEffect(
    () => () => {
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    },
    [],
  );

  // Scroll to the queue ONCE, the first render on which the section actually
  // exists. The data arrives async, so a mount-only effect would fire while the
  // section is still unmounted and silently do nothing; the latch lets later
  // renders satisfy the request without re-scrolling on every state change.
  const focusHandled = React.useRef(false);
  React.useEffect(() => {
    if (!focusQueue || focusHandled.current || needsInputRef.current === null) return;
    focusHandled.current = true;
    needsInputRef.current.scrollIntoView({ block: 'start' });
  });

  const jumpToNeedsInput = (): void => {
    needsInputRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    setFlashing(true);
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlashing(false), FLASH_MS);
  };

  const jumpToReady = (): void => {
    readyRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };

  // -------------------------------------------------------------------------
  // Session lifecycle — merge / dismiss, both gated
  // -------------------------------------------------------------------------
  const [mergeTargetId, setMergeTargetId] = React.useState<string | null>(null);
  const [dismissTargetId, setDismissTargetId] = React.useState<string | null>(null);

  // The simplified "Add an idea" capture — opened by the capture-first-idea
  // card and the empty-backlog well, both of which only exist with no ideas.
  const [addIdeaOpen, setAddIdeaOpen] = React.useState(false);

  /**
   * Open the merge dialog only once nothing is actively driving the session's
   * worktree. Mirrors SessionLifecycleActionBar's `runSettleGatedAction`: the
   * persisted session status wedges at `running` for flow sessions with chats,
   * so the live read is the only reliable answer — and a FAILED read must never
   * block the action, hence the fail-open catch arms.
   */
  const requestMerge = (sessionId: string): void => {
    let settlePromise: Promise<SessionSettleState>;
    try {
      settlePromise = trpc.cyboflow.runs.sessionSettleState.query({ sessionId });
    } catch {
      setMergeTargetId(sessionId);
      return;
    }
    void settlePromise
      .then((settle) => {
        if (settle.flowBusy || settle.chatTurnInFlight) {
          useErrorStore.getState().showError({
            title: 'Merge is waiting on live work',
            error: settle.flowBusy
              ? 'A workflow run on this session is still executing. Let it finish (or cancel it) before accepting the work.'
              : 'A chat on this session has an agent turn in flight. Wait for the turn to finish before accepting the work.',
          });
          return;
        }
        setMergeTargetId(sessionId);
      })
      .catch(() => setMergeTargetId(sessionId));
  };

  const afterLifecycleAction = (): void => {
    setMergeTargetId(null);
    setDismissTargetId(null);
    void useQuickSessionsStore.getState().refresh();
  };

  // -------------------------------------------------------------------------
  // Recommended-action dispatch
  // -------------------------------------------------------------------------
  const openReviewItem = (item: ReviewItem): void => {
    const quickSessionId = item.source?.startsWith(IDLE_REVIEW_SOURCE_PREFIX)
      ? item.source.slice(IDLE_REVIEW_SOURCE_PREFIX.length)
      : null;
    if (quickSessionId !== null) {
      openQuickSession({ sessionId: quickSessionId, runId: item.run_id, projectId: item.project_id });
      return;
    }
    if (item.run_id !== null) openRunSession(item.run_id, item.project_id);
  };

  const runAction = (action: RecommendedAction): void => {
    switch (action.kind) {
      case 'review-blocked':
        jumpToNeedsInput();
        return;
      case 'merge-clean': {
        // One clean session has an unambiguous next click — open it so the work
        // can actually be reviewed before merging; the merge dialog lives in the
        // session workspace. Several sessions have no single target, so the card
        // hands you the list instead of picking for you.
        if (action.sessionIds.length === 1) {
          const row = triage.readyForReview.find((r) => r.sessionId === action.sessionIds[0]);
          if (row !== undefined) openQuickSession(row);
          else jumpToReady();
        } else jumpToReady();
        return;
      }
      case 'rebase-behind': {
        const row = triage.readyForReview.find((r) => r.sessionId === action.sessionIds[0]);
        if (row !== undefined) openQuickSession(row);
        return;
      }
      case 'wrap-up-stale':
        jumpToReady();
        return;
      case 'blocking-finding':
        openRunSession(action.runId, action.projectId);
        return;
      case 'launch-sprint':
        void launchSprintBatch(action.id, action.taskIds, action.projectId);
        return;
      case 'launch-planner':
        void launch(action.ideaId, action.projectId, 'idea');
        return;
      case 'capture-first-idea':
        setAddIdeaOpen(true);
        return;
      case 'run-launch-flow':
        useNavigationStore
          .getState()
          .goToWizard({ preselectWorkflowName: 'launch', lockProjectId: action.projectId });
        return;
    }
  };

  const dismissAction = (action: RecommendedAction): void => {
    recordDismissal(action.id, action.signature);
    setDismissals((prev) => ({ ...prev, [action.id]: action.signature }));
  };

  const startSession = (): void => useNavigationStore.getState().goToWizard({ allowQuick: true });
  const openBacklog = (): void => useNavigationStore.getState().openBacklog();
  const openAddIdea = (): void => setAddIdeaOpen(true);

  // Rendered by every branch that offers an "Add an idea" affordance (the main
  // page and the no-accounts one, which still shows the backlog).
  const addIdeaModal = (
    <AddIdeaModal
      isOpen={addIdeaOpen}
      onClose={() => setAddIdeaOpen(false)}
      projects={projects}
      onLaunchPlanner={(ideaId, projectId) => launch(ideaId, projectId, 'idea')}
    />
  );

  // The launcher reports ONE in-flight id. The backlog columns claim synthetic
  // ids; the recommended cards mostly pass their own action id, except
  // launch-planner, which goes through the single-idea `launch()` and so reports
  // the idea id — hence the second arm of the match.
  const launchingColumn =
    launchingTaskId === 'rq-ideas' ? 'ideas' : launchingTaskId === 'rq-tasks' ? 'tasks' : null;
  const busyActionId = React.useMemo(() => {
    if (launchingTaskId === null) return null;
    const all = [...recommended.visible, ...recommended.hidden];
    const match = all.find(
      (a) => a.id === launchingTaskId || (a.kind === 'launch-planner' && a.ideaId === launchingTaskId),
    );
    return match?.id ?? null;
  }, [launchingTaskId, recommended]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  const showSessionSections = state !== 'no-sessions' && state !== 'caught-up';
  const showEmptyWells = state === 'all-idle';

  const page = (children: React.ReactNode): React.JSX.Element => (
    <div className="h-full w-full overflow-y-auto" style={GRAPH_PAPER_STYLE}>
      <div className="mx-auto w-full max-w-[1120px] px-6 py-8">
        <div className="flex flex-col gap-7 border border-border-primary bg-surface-primary px-11 py-9 font-mono shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
          {children}
        </div>
      </div>
    </div>
  );

  if (state === 'error') {
    return page(
      <>
        <QueueHeader waitingCount={waitingCount} state={state} />
        <LoadErrorPanel onRetry={retryLanding} />
      </>,
    );
  }

  if (state === 'no-accounts') {
    return page(
      <>
        <QueueHeader waitingCount={waitingCount} state={state} />
        <NoAccountsPanel />
        <BacklogSection
          tasks={backlogTasks}
          boards={backlogBoards}
          projectNameById={projectNameById}
          projectCount={projectsCount}
          variant="full"
          launchingColumn={launchingColumn}
          onOpenBacklog={openBacklog}
          onAddIdea={openAddIdea}
          onLaunchPlanner={(ideaIds, projectId) => void launchPlannerBatch('rq-ideas', ideaIds, projectId)}
          onLaunchSprint={(taskIds, projectId) => void launchSprintBatch('rq-tasks', taskIds, projectId)}
        />
        {addIdeaModal}
      </>,
    );
  }

  if (state === 'no-projects') {
    return page(
      <>
        <QueueHeader waitingCount={waitingCount} state={state} />
        <ProviderUsageCards />
        <NoProjectsPanel />
      </>,
    );
  }

  return page(
    <>
      <QueueHeader waitingCount={waitingCount} state={state} />
      <ProviderUsageCards />

      {state === 'caught-up' && (
        <CaughtUpWell workingCount={workingCount} onStartSession={startSession} />
      )}
      {state === 'all-idle' && <AllIdleStrip sessionCount={sessionsCount} />}

      <RecommendedActionsSection
        visible={recommended.visible}
        hidden={recommended.hidden}
        subtitle={recommendedSubtitle}
        onAct={runAction}
        onDismiss={dismissAction}
        busyActionId={busyActionId}
      />

      {state === 'no-sessions' && <NoSessionsWell onStartSession={startSession} />}

      {showSessionSections && (
        <>
          <NeedsInputSection
            ref={needsInputRef}
            quickRows={triage.needsInput}
            reviewItems={decisionItems}
            approvals={approvals}
            projectNameById={projectNameById}
            runProjectMap={runProjectMap}
            runSessionMap={runSessionMap}
            nowMs={nowMs}
            showWhenEmpty={showEmptyWells}
            flashing={flashing}
            onOpenQuickSession={openQuickSession}
            onOpenReviewItem={openReviewItem}
            onApprovalDecided={afterLifecycleAction}
          />

          <HumanTasksSection
            items={humanTaskItems}
            projectNameById={projectNameById}
            nowMs={nowMs}
            onResolved={afterLifecycleAction}
          />

          <div ref={readyRef} className="scroll-mt-4">
            <ReadyForReviewSection
              rows={readyRows}
              projectNameById={projectNameById}
              guardedSessionIds={guardedSessionIds}
              nowMs={nowMs}
              onOpenQuickSession={openQuickSession}
              onOpenRun={(run) => openRunSession(run.id, run.project_id)}
              onMergeSession={requestMerge}
              onDismissSession={setDismissTargetId}
            />
          </div>

          <NotificationsSection
            items={notificationItems}
            projectNameById={projectNameById}
            nowMs={nowMs}
            onOpen={openReviewItem}
            onDismissed={afterLifecycleAction}
          />
        </>
      )}

      <WorkingSection
        rows={workingRows}
        showWhenEmpty={showEmptyWells}
        onOpenQuickSession={openQuickSession}
        onOpenRun={(run) => openRunSession(run.id, run.project_id)}
        onOpenDynamicWorkflow={(workflow) =>
          openQuickSession({
            sessionId: workflow.sessionId,
            runId: workflow.runId,
            projectId: workflow.projectId,
          })
        }
      />

      <BacklogSection
        tasks={backlogTasks}
        boards={backlogBoards}
        projectNameById={projectNameById}
        projectCount={projectsCount}
        variant={state === 'caught-up' ? 'funnel-only' : 'full'}
        launchingColumn={launchingColumn}
        onOpenBacklog={openBacklog}
        onAddIdea={openAddIdea}
        onLaunchPlanner={(ideaIds, projectId) => void launchPlannerBatch('rq-ideas', ideaIds, projectId)}
        onLaunchSprint={(taskIds, projectId) => void launchSprintBatch('rq-tasks', taskIds, projectId)}
      />

      {mergeTargetId !== null && (
        <SessionMergeDialog
          isOpen
          onClose={() => setMergeTargetId(null)}
          sessionId={mergeTargetId}
          onSuccess={afterLifecycleAction}
        />
      )}
      {dismissTargetId !== null && (
        <SessionDismissDialog
          isOpen
          onClose={() => setDismissTargetId(null)}
          sessionId={dismissTargetId}
          onSuccess={afterLifecycleAction}
        />
      )}
      {addIdeaModal}
    </>,
  );
}
