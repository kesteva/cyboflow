import { create } from 'zustand';

interface NavigationState {
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
  activeView: 'sessions',
  activeProjectId: null,
  humanReviewOpen: false,
  backlogOpen: false,

  setActiveView: (view) => set({ activeView: view }),

  setActiveProjectId: (projectId) => set({ activeProjectId: projectId }),

  navigateToProject: (projectId) => set({
    activeView: 'project',
    activeProjectId: projectId
  }),

  navigateToSessions: () => set({
    activeView: 'sessions',
    activeProjectId: null
  }),

  // Opening human review closes the backlog (the center hosts one full-width
  // pane at a time); closing/toggling leave the backlog flag untouched.
  openHumanReview: () => set({ humanReviewOpen: true, backlogOpen: false }),
  closeHumanReview: () => set({ humanReviewOpen: false }),
  toggleHumanReview: () => set((s) => ({ humanReviewOpen: !s.humanReviewOpen, backlogOpen: false })),

  // Symmetric with the human-review actions — opening/toggling the backlog
  // closes human review so the center never tries to render both panes.
  openBacklog: () => set({ backlogOpen: true, humanReviewOpen: false }),
  closeBacklog: () => set({ backlogOpen: false }),
  toggleBacklog: () => set((s) => ({ backlogOpen: !s.backlogOpen, humanReviewOpen: false })),
}));