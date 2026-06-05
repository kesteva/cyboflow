import { create } from 'zustand';

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
}

export const useNavigationStore = create<NavigationState>((set) => ({
  view: 'home',
  wizardOpts: null,
  activeView: 'sessions',
  activeProjectId: null,
  humanReviewOpen: false,
  backlogOpen: false,

  // Center-surface state machine. goHome returns to the rail-overlay surface
  // (clearing any wizard opts + both overlays); goToWizard swaps in the
  // new-flow launcher; goToSession is called by the run/session OPEN handlers.
  goHome: () => set({ view: 'home', wizardOpts: null, humanReviewOpen: false, backlogOpen: false }),
  goToWizard: (opts) => set({ view: 'wizard', wizardOpts: opts ?? {}, humanReviewOpen: false, backlogOpen: false }),
  goToSession: () => set({ view: 'session', humanReviewOpen: false, backlogOpen: false }),

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
    backlogOpen: false
  }),

  // Navigating to sessions likewise dismisses both full-width center panes.
  navigateToSessions: () => set({
    view: 'home',
    activeView: 'sessions',
    activeProjectId: null,
    humanReviewOpen: false,
    backlogOpen: false
  }),

  // Opening human review closes the backlog (the center hosts one full-width
  // pane at a time) and forces the home view — the overlays only ever render
  // over the home surface. Closing/toggling leave the backlog flag untouched.
  openHumanReview: () => set({ view: 'home', humanReviewOpen: true, backlogOpen: false }),
  closeHumanReview: () => set({ humanReviewOpen: false }),
  toggleHumanReview: () => set((s) => ({ view: 'home', humanReviewOpen: !s.humanReviewOpen, backlogOpen: false })),

  // Symmetric with the human-review actions — opening/toggling the backlog
  // closes human review and forces home so the center never tries to render
  // both panes.
  openBacklog: () => set({ view: 'home', backlogOpen: true, humanReviewOpen: false }),
  closeBacklog: () => set({ backlogOpen: false }),
  toggleBacklog: () => set((s) => ({ view: 'home', backlogOpen: !s.backlogOpen, humanReviewOpen: false })),
}));