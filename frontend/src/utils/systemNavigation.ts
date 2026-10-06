/**
 * Session/run activation for the System view's "Open session" / "Open run".
 *
 * The one place the canonical three-call sequence lives for this view — the same
 * trio OverviewActiveAgents (`openQuickSession` / `openRunSession`) and
 * useIdeaSessionOpener run: activate the session/run in the cyboflow store, pin
 * the project, then leave the current overlay for the session surface
 * (`goToSession` also clears `systemOpen`). Call order matters: the project must
 * be set before the session surface mounts.
 */
import { useCyboflowStore } from '../stores/cyboflowStore';
import { useNavigationStore } from '../stores/navigationStore';

/** Open a quick/CLI session: setActiveQuickSession → setActiveProjectId → goToSession. */
export function openSystemSession(sessionId: string, projectId: number): void {
  useCyboflowStore.getState().setActiveQuickSession(sessionId);
  useNavigationStore.getState().setActiveProjectId(projectId);
  useNavigationStore.getState().goToSession();
}

/** Open a workflow run: setActiveRun → setActiveProjectId → goToSession. */
export function openSystemRun(runId: string, projectId: number): void {
  useCyboflowStore.getState().setActiveRun(runId);
  useNavigationStore.getState().setActiveProjectId(projectId);
  useNavigationStore.getState().goToSession();
}
