/**
 * useTaskRunLauncher — launches a workflow run for a backlog task via the
 * EXISTING run-launch entrypoint (`cyboflow.runs.start`), passing the contract's
 * launch-task param `taskId`.
 *
 * The run-launch entrypoint requires a workflowId. The backlog card has no
 * workflow picker of its own, so we resolve the built-in flow BY NAME from the
 * entity type — resolving by name keeps a newly-added flow that lands first in
 * the list (e.g. `compound`) from hijacking the one-click Run. Falls back to the
 * first workflow when the chosen flow doesn't exist (e.g. a custom-only project):
 *   - idea / epic → **Planner**  (an idea is decomposed; an epic is elaborated)
 *   - task        → **Sprint**   (Sprint is the task-execution flow)
 *
 * SEED PARAM by entity type:
 *   - idea → `ideaId`        — the run records `seed_idea_id`; RunExecutor
 *                              .getPrompt injects a `# Selected idea` block,
 *                              including any attachment paths.
 *   - task → `taskIds:[id]`  — Sprint seeds from a batch; a single-task run is a
 *                              batch of one (creates the lane + `batch_id`).
 *   - epic → `taskId`        — links the run for execution-stage derivation.
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
        // Resolve the flow BY NAME from the entity type (NOT workflows[0] —
        // built-in ordering is not a contract; `compound` now lands first).
        // Tasks → Sprint, ideas/epics → Planner. Fall back to the first flow.
        const wantName = type === 'task' ? 'sprint' : 'planner';
        const workflowId = workflows.find((w) => w.name === wantName)?.id ?? workflows[0]?.id;
        if (!workflowId) {
          setError('No workflow available to run');
          return null;
        }
        // Phase 3 (session<->run restructure): a backlog "Run" must be session-hosted
        // like every other launch surface — ensure a session (the active one, else a
        // fresh one) so the run executes in the session worktree and Diff/File-Explorer
        // can follow it. Without this the run takes the legacy parentless path.
        const sessionId = await ensureSessionForLaunch(projectId);
        // Seed by entity type: idea → ideaId (`# Selected idea` block + attachment
        // paths); task → Sprint batch of one (taskIds); epic → taskId link.
        const seed =
          type === 'idea'
            ? { ideaId: taskId }
            : type === 'task'
              ? { taskIds: [taskId] }
              : { taskId };
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
