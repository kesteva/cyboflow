/**
 * useTaskRunLauncher — launches a workflow run for a backlog task via the
 * EXISTING run-launch entrypoint (`cyboflow.runs.start`), passing the contract's
 * launch-task param `taskId`.
 *
 * The run-launch entrypoint requires a workflowId. The backlog card has no
 * workflow picker of its own, so we resolve the project's workflow list and use
 * the first workflow as the default. This keeps the Phase-1 "Run" affordance a
 * one-click action that exercises the live overlays (the task transitions into
 * the derived `In development` stage once the run is wired through the
 * orchestrator), while leaving full workflow selection to the run surface.
 *
 * NOTE: `taskId` is forwarded to `runs.start.mutate`. The runs router input is
 * owned by a sibling consumer/integration step; until it accepts `taskId` the
 * field is simply ignored at the wire boundary. This is the agreed seam — see
 * the FOUNDATION CONTRACT `launch_task_param` note.
 */
import { useCallback, useState } from 'react';
import { trpc } from '../../trpc/client';
import { ensureSessionForLaunch } from '../../utils/ensureSessionForLaunch';

export interface TaskRunLaunchState {
  /** Task id currently being launched, or null when idle. */
  launchingTaskId: string | null;
  /** Last launch error message, or null. */
  error: string | null;
  /** Launch a run for `taskId` in `projectId`. Resolves to the new runId or null. */
  launch: (taskId: string, projectId: number) => Promise<string | null>;
}

export function useTaskRunLauncher(): TaskRunLaunchState {
  const [launchingTaskId, setLaunchingTaskId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const launch = useCallback(async (taskId: string, projectId: number): Promise<string | null> => {
    setError(null);
    setLaunchingTaskId(taskId);
    try {
      const workflows = await trpc.cyboflow.workflows.list.query({ projectId });
      const workflowId = workflows[0]?.id;
      if (!workflowId) {
        setError('No workflow available to run');
        return null;
      }
      // Phase 3 (session<->run restructure): a backlog "Run" must be session-hosted
      // like every other launch surface — ensure a session (the active one, else a
      // fresh one) so the run executes in the session worktree and Diff/File-Explorer
      // can follow it. Without this the run takes the legacy parentless path.
      const sessionId = await ensureSessionForLaunch(projectId);
      // taskId is the new contract launch param; forwarded through runs.start.
      const result = await trpc.cyboflow.runs.start.mutate({ workflowId, projectId, taskId, sessionId });
      return result.runId;
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to launch run');
      return null;
    } finally {
      setLaunchingTaskId(null);
    }
  }, []);

  return { launchingTaskId, error, launch };
}
