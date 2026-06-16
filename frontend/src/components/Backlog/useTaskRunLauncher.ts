/**
 * useTaskRunLauncher — launches a workflow run for a backlog task via the
 * EXISTING run-launch entrypoint (`cyboflow.runs.start`), passing the contract's
 * launch-task param `taskId`.
 *
 * The run-launch entrypoint requires a workflowId. The backlog card has no
 * workflow picker of its own, so we resolve the project's workflow list and pick
 * the built-in **Planner** flow BY NAME — ideas are decomposed by the Planner,
 * and that was the historical default before `compound` was added as a built-in.
 * Resolving by name keeps a newly-added flow that lands first in the list from
 * hijacking the one-click Run. Falls back to the first workflow when no
 * `planner` exists (e.g. a custom-only project).
 *
 * SEED PARAM by entity type: an IDEA seeds the Planner via `ideaId` (the run
 * records `seed_idea_id`; RunExecutor.getPrompt injects a `# Selected idea`
 * block, including any attachment paths). Other entities link via `taskId` so
 * the task's execution stage derives once the run is wired through the
 * orchestrator.
 */
import { useCallback, useState } from 'react';
import { trpc } from '../../trpc/client';
import { ensureSessionForLaunch } from '../../utils/ensureSessionForLaunch';
import type { TaskType } from '../../../../shared/types/tasks';

export interface TaskRunLaunchState {
  /** Task id currently being launched, or null when idle. */
  launchingTaskId: string | null;
  /** Last launch error message, or null. */
  error: string | null;
  /** Launch a run for `taskId` (of `type`) in `projectId`. Resolves to the new runId or null. */
  launch: (taskId: string, projectId: number, type: TaskType) => Promise<string | null>;
}

export function useTaskRunLauncher(): TaskRunLaunchState {
  const [launchingTaskId, setLaunchingTaskId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const launch = useCallback(
    async (taskId: string, projectId: number, type: TaskType): Promise<string | null> => {
      setError(null);
      setLaunchingTaskId(taskId);
      try {
        const workflows = await trpc.cyboflow.workflows.list.query({ projectId });
        // Resolve the Planner by name (NOT workflows[0] — built-in ordering is not
        // a contract; `compound` now lands first). Fall back to the first flow.
        const workflowId = workflows.find((w) => w.name === 'planner')?.id ?? workflows[0]?.id;
        if (!workflowId) {
          setError('No workflow available to run');
          return null;
        }
        // Phase 3 (session<->run restructure): a backlog "Run" must be session-hosted
        // like every other launch surface — ensure a session (the active one, else a
        // fresh one) so the run executes in the session worktree and Diff/File-Explorer
        // can follow it. Without this the run takes the legacy parentless path.
        const sessionId = await ensureSessionForLaunch(projectId);
        // Ideas seed the Planner via ideaId (→ `# Selected idea` block + attachment
        // paths); other entities link via taskId for execution-stage derivation.
        const seed = type === 'idea' ? { ideaId: taskId } : { taskId };
        const result = await trpc.cyboflow.runs.start.mutate({
          workflowId,
          projectId,
          sessionId,
          ...seed,
        });
        return result.runId;
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to launch run');
        return null;
      } finally {
        setLaunchingTaskId(null);
      }
    },
    [],
  );

  return { launchingTaskId, error, launch };
}
