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
 * CROSS-PROJECT GAP (was a DEVIATION flagged in the S1.3 final report — now
 * closed): {@link AgentNavigationTarget} carries an optional `projectId`,
 * resolved server-side at propose time (never trusted from a caller) by
 * cyboflow_propose_action's open-session handler
 * (main/src/orchestrator/mcpServer/mcpQueryHandler.ts). CyboflowRoot resolves
 * the active run via `runsByProject[projectId]` keyed off whatever project is
 * CURRENTLY active in navigationStore, so when the target carries a
 * projectId, we activate that project FIRST — same as TypeGroupedQueue's
 * openRunSession / openQuickSession and ReviewItemCard's
 * handleAnswerInSession — before dispatching setActiveRun /
 * setActiveQuickSession. A target with no projectId (e.g. an older proposal
 * persisted before this enrichment shipped) falls back to today's
 * behavior: dispatch against whatever project is already active.
 */
import { useCyboflowStore } from '../../stores/cyboflowStore';
import { useNavigationStore } from '../../stores/navigationStore';
import type { AgentNavigationTarget } from '../../../../shared/types/agentThread';

export function navigateToProposalTarget(navigation: AgentNavigationTarget): void {
  if (navigation.projectId !== undefined) {
    useNavigationStore.getState().setActiveProjectId(navigation.projectId);
  }
  if (navigation.target === 'run') {
    useCyboflowStore.getState().setActiveRun(navigation.runId);
  } else {
    useCyboflowStore.getState().setActiveQuickSession(navigation.sessionId, navigation.runId);
  }
  useNavigationStore.getState().goToSession();
}
