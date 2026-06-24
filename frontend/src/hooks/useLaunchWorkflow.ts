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
 * `seed.ideaId` threads the Planner's pre-launch seed idea (migration 017);
 * `seed.taskIds` threads the Sprint's pre-launch task batch. The canvas opens
 * the matching picker (IdeaPickerModal / TaskBatchPickerModal) first and MUST
 * pass the corresponding seed; other workflows launch seedless.
 */
import { useCallback, useRef, useState } from 'react';
import { trpc } from '../trpc/client';
import { useCyboflowStore } from '../stores/cyboflowStore';
import { useConfigStore } from '../stores/configStore';
import { ensureSessionForLaunch } from '../utils/ensureSessionForLaunch';
import { useForcedSubstrate } from './useForcedSubstrate';
import { DEFAULT_SUBSTRATE } from '../../../shared/types/substrate';
import { trackEvent } from '../utils/telemetry';

/** Pre-launch seed — at most one of ideaId (planner) / taskIds (sprint). */
export interface LaunchSeed {
  ideaId?: string;
  taskIds?: string[];
}

export interface UseLaunchWorkflowResult {
  /** Fire the launch. Resolves to the new runId, or null on failure. */
  launch: (workflowId: string, seed?: LaunchSeed) => Promise<string | null>;
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
  // Global forced-substrate pin (demo 'sdk' wins, else PTY-only lock 'interactive',
  // else null). Send it so the payload matches what the backend would stamp
  // anyway (getForcedSubstrate overrides regardless); floors to the SDK default.
  const forced = useForcedSubstrate();

  const launch = useCallback(
    async (workflowId: string, seed?: LaunchSeed): Promise<string | null> => {
      if (inFlightRef.current) return null;
      inFlightRef.current = true;
      setError(null);
      setIsLaunching(true);
      try {
        // Launch INTO the active session (the resting quick session), reusing
        // its worktree — ensureSessionForLaunch returns selectedSessionId when set.
        const sessionId = await ensureSessionForLaunch(projectId);
        const base = {
          workflowId,
          projectId,
          substrate: forced ?? DEFAULT_SUBSTRATE,
          sessionId,
          permissionMode: globalPermissionMode,
        };
        const result = await trpc.cyboflow.runs.start.mutate(
          seed?.ideaId !== undefined
            ? { ...base, ideaId: seed.ideaId }
            : seed?.taskIds !== undefined
              ? { ...base, taskIds: seed.taskIds }
              : base,
        );
        useCyboflowStore.getState().setActiveRun(result.runId, sessionId);
        trackEvent('workflow_run_started', {
          launch_surface: 'in_session',
          substrate: base.substrate,
          permission_mode: globalPermissionMode,
        });
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
    [projectId, globalPermissionMode, forced, onLaunched],
  );

  return { launch, isLaunching, error };
}
