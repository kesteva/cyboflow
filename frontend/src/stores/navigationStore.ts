import { create } from 'zustand';
import { trackEvent } from '../utils/telemetry';

/** Fire a `view_opened` usage event for a center-pane panel (open-edge only). */
function fireViewOpened(view: 'human_review' | 'backlog' | 'insights' | 'workflows' | 'verify_queue'): void {
  trackEvent('view_opened', { view });
}

/**
 * Options carried into the new-flow wizard when it becomes the center surface.
 * `lockProjectId` pins the wizard to a project (rail "+ NEW FLOW" on a project);
 * `fromAgentId` records the agent the launch originated from; `allowQuick`
 * permits the quick-session escape hatch. All optional — a bare goToWizard()
 * stores {}.
 */
export interface WizardOpts {
  lockProjectId?: number;
  fromAgentId?: string;
  allowQuick?: boolean;
  /**
   * Preselect the workflow with this `meta.name` (e.g. `'compound'`) when the
   * wizard's workflow list loads, and auto-advance to the ③ Configure step ONCE
   * so the caller lands directly on the launch surface. Unlike the implicit
   * default-workflow preselect (which only sets selection state), this explicit
   * preselect performs the one-shot ② → ③ advance. Used by the Insights "Run
   * compounding session" CTA to drop the user straight into a `/compound`
   * launch.
   */
  preselectWorkflowName?: string;
  /**
   * Preselect the workflow with this ROW id (the `workflows` table id, e.g.
   * `'wf-3-planner'`) when the wizard loads. Used by the Workflows gallery's
   * per-card Run action, which knows the concrete workflow row it wants to launch
   * (distinct from {@link preselectWorkflowName}, which preselects by built-in
   * name and is used by name-keyed CTAs like the Insights "Run compounding
   * session" button).
   */
  preselectWorkflowId?: string;
  /**
   * Selected finding ids (`review_items.id`) carried by the Insights triage
   * tray's "Run compounding session" CTA. The wizard threads these into
   * `runs.start` as `findingIds` — but ONLY when the launched workflow is
   * `compound` (the seed is compound-only). Ignored for every other flow.
   */
  selectedFindingIds?: string[];
}

interface NavigationState {
  /**
   * Which center surface is showing. The home view hosts the rail-driven
   * overlays (`humanReviewOpen` / `backlogOpen`); the wizard hosts the new-flow
   * launcher; the session view hosts an open run/session. Distinct from the
   * `home` overlays so the App can route the center on a single discriminant.
   */
  view: 'home' | 'wizard' | 'session';
  /** Options for the wizard view; null when not in (or never were in) the wizard. */
  wizardOpts: WizardOpts | null;
  activeView: 'sessions' | 'project';
  activeProjectId: number | null;
  /**
   * Whether the full-width human-review pane is the active center surface
   * (App swaps it in over CyboflowRoot — see docs/SHELL-LAYOUT.md). Lives here
   * rather than in App-local state so the rail navigation handlers in
   * DraggableProjectTreeView can dismiss it when the user picks a project /
   * session / run — including re-clicking the already-active one, which a
   * store-selection watcher would miss.
   */
  humanReviewOpen: boolean;
  /**
   * Whether the full-width task-backlog pane is the active center surface
   * (App swaps it in over CyboflowRoot — mirrors `humanReviewOpen`). Lives here
   * so the rail navigation handlers can dismiss it when the user picks a
   * project / session / run. Mutually exclusive with `humanReviewOpen` — opening
   * one closes the other so the center never tries to render both.
   */
  backlogOpen: boolean;
  /**
   * Whether the full-width Insights pane is the active center surface (App swaps
   * it in over the home surface — third sibling alongside `humanReviewOpen` /
   * `backlogOpen`). Lives here so the rail navigation handlers can dismiss it on
   * any nav away. Mutually exclusive with BOTH overlays — opening insights closes
   * human review + the backlog, and opening either of those (or any project /
   * session nav) closes insights, so the center only ever hosts one full-width
   * pane at a time.
   */
  insightsOpen: boolean;
  /**
   * Whether the full-width Workflows gallery is the active center surface (App
   * swaps it in over the home surface — fourth sibling alongside
   * `humanReviewOpen` / `backlogOpen` / `insightsOpen`). Mutually exclusive with
   * all three: opening it closes the others, and any other overlay/nav clears it,
   * so the center only ever hosts one full-width pane at a time.
   */
  workflowsOpen: boolean;
  /**
   * The experiment whose pairwise comparison is the active center surface (A/B
   * testing slice C), or null when none is open. App.tsx renders
   * ExperimentComparisonView for this id with PRIORITY BEFORE `insightsOpen` (and
   * every other overlay), so a "View comparison" CTA always wins over whatever
   * else is showing. Mutually exclusive with all sibling overlays, mirroring
   * `workflowsOpen`'s conventions exactly: opening it closes the others, and
   * every nav action / sibling-open action below clears it in turn.
   */
  experimentComparisonId: string | null;
  /**
   * Whether the full-width Verify-Queue pane is the active center surface (App
   * swaps it in over the home surface — sibling alongside
   * `humanReviewOpen` / `backlogOpen` / `insightsOpen` / `workflowsOpen`).
   * Mutually exclusive with all the others: opening it closes them, and any
   * other overlay/nav clears it, so the center only ever hosts one full-width
   * pane at a time.
   */
  verifyQueueOpen: boolean;

  // Actions
  goHome: () => void;
  goToWizard: (opts?: WizardOpts) => void;
  goToSession: () => void;
  setActiveView: (view: 'sessions' | 'project') => void;
  setActiveProjectId: (projectId: number | null) => void;
  navigateToProject: (projectId: number) => void;
  navigateToSessions: () => void;
  openHumanReview: () => void;
  closeHumanReview: () => void;
  toggleHumanReview: () => void;
  openBacklog: () => void;
  closeBacklog: () => void;
  toggleBacklog: () => void;
  openInsights: () => void;
  closeInsights: () => void;
  toggleInsights: () => void;
  openWorkflows: () => void;
  closeWorkflows: () => void;
  toggleWorkflows: () => void;
  /** Open the comparison overlay for `experimentId`, closing every sibling overlay. */
  openExperimentComparison: (experimentId: string) => void;
  closeExperimentComparison: () => void;
  openVerifyQueue: () => void;
  closeVerifyQueue: () => void;
  toggleVerifyQueue: () => void;
}

export const useNavigationStore = create<NavigationState>((set) => ({
  view: 'home',
  wizardOpts: null,
  activeView: 'sessions',
  activeProjectId: null,
  humanReviewOpen: false,
  backlogOpen: false,
  insightsOpen: false,
  workflowsOpen: false,
  experimentComparisonId: null,
  verifyQueueOpen: false,

  // Center-surface state machine. goHome returns to the rail-overlay surface
  // (clearing any wizard opts + all five overlays); goToWizard swaps in the
  // new-flow launcher; goToSession is called by the run/session OPEN handlers.
  // Each transition also clears `insightsOpen` / `workflowsOpen` /
  // `experimentComparisonId` / `verifyQueueOpen` so navigating away always tears
  // those panes down (mirrors the human-review / backlog clears).
  goHome: () => set({ view: 'home', wizardOpts: null, humanReviewOpen: false, backlogOpen: false, insightsOpen: false, workflowsOpen: false, experimentComparisonId: null, verifyQueueOpen: false }),
  goToWizard: (opts) => set({ view: 'wizard', wizardOpts: opts ?? {}, humanReviewOpen: false, backlogOpen: false, insightsOpen: false, workflowsOpen: false, experimentComparisonId: null, verifyQueueOpen: false }),
  goToSession: () => set({ view: 'session', humanReviewOpen: false, backlogOpen: false, insightsOpen: false, workflowsOpen: false, experimentComparisonId: null, verifyQueueOpen: false }),

  setActiveView: (view) => set({ activeView: view }),

  setActiveProjectId: (projectId) => set({ activeProjectId: projectId }),

  // Navigating to a project dismisses the full-width center panes (task backlog
  // / human review) — any rail nav away from the task view must clear it, and
  // centralizing here means individual rail handlers can't forget one pane.
  navigateToProject: (projectId) => set({
    view: 'home',
    activeView: 'project',
    activeProjectId: projectId,
    humanReviewOpen: false,
    backlogOpen: false,
    insightsOpen: false,
    workflowsOpen: false,
    experimentComparisonId: null,
    verifyQueueOpen: false
  }),

  // Navigating to sessions likewise dismisses all full-width center panes.
  navigateToSessions: () => set({
    view: 'home',
    activeView: 'sessions',
    activeProjectId: null,
    humanReviewOpen: false,
    backlogOpen: false,
    insightsOpen: false,
    workflowsOpen: false,
    experimentComparisonId: null,
    verifyQueueOpen: false
  }),

  // Opening human review closes the backlog, insights, workflows, the experiment
  // comparison, AND the verify queue (the center hosts one full-width pane at a
  // time) and forces the home view — the overlays only ever render over the home
  // surface. Closing/toggling leave the sibling flags untouched (toggle still
  // clears them on the open transition).
  openHumanReview: () => set({ view: 'home', humanReviewOpen: true, backlogOpen: false, insightsOpen: false, workflowsOpen: false, experimentComparisonId: null, verifyQueueOpen: false }),
  closeHumanReview: () => set({ humanReviewOpen: false }),
  toggleHumanReview: () => set((s) => {
    if (!s.humanReviewOpen) fireViewOpened('human_review');
    return { view: 'home', humanReviewOpen: !s.humanReviewOpen, backlogOpen: false, insightsOpen: false, workflowsOpen: false, experimentComparisonId: null, verifyQueueOpen: false };
  }),

  // Symmetric with the human-review actions — opening/toggling the backlog
  // closes the other overlays and forces home so the center never tries
  // to render two panes.
  openBacklog: () => set({ view: 'home', backlogOpen: true, humanReviewOpen: false, insightsOpen: false, workflowsOpen: false, experimentComparisonId: null, verifyQueueOpen: false }),
  closeBacklog: () => set({ backlogOpen: false }),
  toggleBacklog: () => set((s) => {
    if (!s.backlogOpen) fireViewOpened('backlog');
    return { view: 'home', backlogOpen: !s.backlogOpen, humanReviewOpen: false, insightsOpen: false, workflowsOpen: false, experimentComparisonId: null, verifyQueueOpen: false };
  }),

  // Third sibling — opening/toggling insights closes the other overlays and
  // forces home, so the mutual-exclusion invariant holds in every direction.
  openInsights: () => set({ view: 'home', insightsOpen: true, humanReviewOpen: false, backlogOpen: false, workflowsOpen: false, experimentComparisonId: null, verifyQueueOpen: false }),
  closeInsights: () => set({ insightsOpen: false }),
  toggleInsights: () => set((s) => {
    if (!s.insightsOpen) fireViewOpened('insights');
    return { view: 'home', insightsOpen: !s.insightsOpen, humanReviewOpen: false, backlogOpen: false, workflowsOpen: false, experimentComparisonId: null, verifyQueueOpen: false };
  }),

  // Fourth sibling — opening/toggling the Workflows gallery closes the other
  // overlays + the experiment comparison + verify queue and forces home,
  // mirroring the insights actions exactly.
  openWorkflows: () => set({ view: 'home', workflowsOpen: true, humanReviewOpen: false, backlogOpen: false, insightsOpen: false, experimentComparisonId: null, verifyQueueOpen: false }),
  closeWorkflows: () => set({ workflowsOpen: false }),
  toggleWorkflows: () => set((s) => {
    if (!s.workflowsOpen) fireViewOpened('workflows');
    return { view: 'home', workflowsOpen: !s.workflowsOpen, humanReviewOpen: false, backlogOpen: false, insightsOpen: false, experimentComparisonId: null, verifyQueueOpen: false };
  }),

  // Fifth sibling — opening/toggling the Verify Queue closes the other overlays
  // + the experiment comparison and forces home, mirroring the workflows actions exactly.
  openVerifyQueue: () => set({ view: 'home', verifyQueueOpen: true, humanReviewOpen: false, backlogOpen: false, insightsOpen: false, workflowsOpen: false, experimentComparisonId: null }),
  closeVerifyQueue: () => set({ verifyQueueOpen: false }),
  toggleVerifyQueue: () => set((s) => {
    if (!s.verifyQueueOpen) fireViewOpened('verify_queue');
    return { view: 'home', verifyQueueOpen: !s.verifyQueueOpen, humanReviewOpen: false, backlogOpen: false, insightsOpen: false, workflowsOpen: false, experimentComparisonId: null };
  }),

  // Sixth sibling (A/B testing slice C) — opening the experiment comparison
  // closes all the other overlays and forces home, mirroring the workflows
  // actions exactly. No toggle: the comparison is always opened with a specific
  // experimentId (from a run banner / dashboard row / review-queue card), never
  // from a rail affordance that would need a bare toggle.
  openExperimentComparison: (experimentId) => set({
    view: 'home',
    experimentComparisonId: experimentId,
    humanReviewOpen: false,
    backlogOpen: false,
    insightsOpen: false,
    workflowsOpen: false,
    verifyQueueOpen: false,
  }),
  closeExperimentComparison: () => set({ experimentComparisonId: null }),
}));