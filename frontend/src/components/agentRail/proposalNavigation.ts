/**
 * proposalNavigation — the `open-session` proposal's Confirm action: pure
 * renderer navigation, no server side effect beyond the status transition the
 * tRPC router already performs (docs/proposals/GLOBAL-AGENT-PLAN.md §2.5 /
 * main/src/orchestrator/trpc/routers/agentThread.ts's `confirmProposal`).
 *
 * The discriminant is load-bearing, not cosmetic: an idle quick session has no
 * live workflow_runs row a flow-host can resolve, so routing it through
 * setActiveRun hangs the center pane forever on "Loading workflow…" — the same
 * trap documented at frontend/src/components/landing/TypeGroupedQueue.tsx:102-112
 * for the review queue's "Open session →" link. This mirrors that file's
 * openRunSession / openQuickSession helpers.
 *
 * DEVIATION (flagged for the parent session — see the S1.3 final report):
 * {@link AgentNavigationTarget} carries no projectId, so unlike
 * TypeGroupedQueue's helpers (and ReviewItemCard's handleAnswerInSession) this
 * cannot call `useNavigationStore.setActiveProjectId`. CyboflowRoot resolves
 * the active run via `runsByProject[projectId]` keyed off whatever project is
 * CURRENTLY active in navigationStore — if the target run/session belongs to a
 * different project, the session pane can fail to find it. A full fix needs a
 * projectId added to the shared-types navigation payload
 * (shared/types/agentThread.ts) and threaded through the propose/execute path,
 * which is outside this task's frontend-only surface.
 */
import { useCyboflowStore } from '../../stores/cyboflowStore';
import { useNavigationStore } from '../../stores/navigationStore';
import type { AgentNavigationTarget } from '../../../../shared/types/agentThread';

export function navigateToProposalTarget(navigation: AgentNavigationTarget): void {
  if (navigation.target === 'run') {
    useCyboflowStore.getState().setActiveRun(navigation.runId);
  } else {
    useCyboflowStore.getState().setActiveQuickSession(navigation.sessionId, navigation.runId);
  }
  useNavigationStore.getState().goToSession();
}
