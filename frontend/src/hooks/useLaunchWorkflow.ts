/**
 * useLaunchWorkflow — launch a workflow run INTO the current session.
 *
 * The one-click counterpart to the full WorkflowPicker: the "Add a workflow"
 * affordance on the QuickSessionCanvas promotes a resting session into a
 * structured run. It reuses the exact launch path the picker uses —
 *
 *   ensureSessionForLaunch(projectId)  // active session, else a fresh one
 *     → trpc.cyboflow.runs.start.mutate({ workflowId, sessionId, … })
 *     → cyboflowStore.setActiveRun(runId, sessionId)
 *
 * — but with the run's substrate / permission-mode left at their defaults
 * (DEFAULT_SUBSTRATE + the global Agent-Permission-Mode), since the canvas is a
 * fast lane; the full WorkflowPicker ("Browse all") still offers per-run control.
 *
 * `ideaId` threads the Planner's pre-launch seed idea (migration 017). Planner
 * launches MUST pass one (the canvas opens the IdeaPickerModal first); Sprint
 * passes undefined.
 */
import { useCallback, useRef, useState } from 'react';
import { trpc } from '../trpc/client';
import { useCyboflowStore } from '../stores/cyboflowStore';
import { useConfigStore } from '../stores/configStore';
import { ensureSessionForLaunch } from '../utils/ensureSessionForLaunch';
import { DEFAULT_SUBSTRATE } from '../../../shared/types/substrate';

export interface UseLaunchWorkflowResult {
  /** Fire the launch. Resolves to the new runId, or null on failure. */
  launch: (workflowId: string, ideaId?: string) => Promise<string | null>;
  isLaunching: boolean;
  error: string | null;
}

export function useLaunchWorkflow(
  projectId: number,
  opts?: { onLaunched?: (runId: string) => void },
): UseLaunchWorkflowResult {
  const [isLaunching, setIsLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Synchronous in-flight latch — guards against a double-submit firing two
  // runs.start (each spinning up a worktree) before the disabled attr applies.
  // Mirrors WorkflowPicker's startInFlightRef.
  const inFlightRef = useRef(false);

  const onLaunched = opts?.onLaunched;
  const globalPermissionMode =
    useConfigStore((state) => state.config?.defaultAgentPermissionMode) ?? 'default';

  const launch = useCallback(
    async (workflowId: string, ideaId?: string): Promise<string | null> => {
      if (inFlightRef.current) return null;
      inFlightRef.current = true;
      setError(null);
      setIsLaunching(true);
      try {
        // Launch INTO the active session (the resting quick session), reusing
        // its worktree — ensureSessionForLaunch returns selectedSessionId when set.
        const sessionId = await ensureSessionForLaunch(projectId);
        const result = await trpc.cyboflow.runs.start.mutate(
          ideaId === undefined
            ? { workflowId, projectId, substrate: DEFAULT_SUBSTRATE, sessionId, permissionMode: globalPermissionMode }
            : { workflowId, projectId, substrate: DEFAULT_SUBSTRATE, sessionId, permissionMode: globalPermissionMode, ideaId },
        );
        useCyboflowStore.getState().setActiveRun(result.runId, sessionId);
        onLaunched?.(result.runId);
        return result.runId;
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to start run');
        return null;
      } finally {
        setIsLaunching(false);
        inFlightRef.current = false;
      }
    },
    [projectId, globalPermissionMode, onLaunched],
  );

  return { launch, isLaunching, error };
}
