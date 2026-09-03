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
import { useConfigStore } from '../../stores/configStore';
import { ensureSessionForLaunch } from '../../utils/ensureSessionForLaunch';
import { trackEvent } from '../../utils/telemetry';
import {
  resolveRunTypeLaunchDefaults,
  workflowRunTypeKey,
} from '../../../../shared/types/sessionDefaults';
import { launchRuntimeForPickers, workflowRuntimeForLaunch } from '../cyboflow/agentRuntimeUi';
import type { TaskType } from '../../../../shared/types/tasks';
import type { PermissionMode } from '../../../../shared/types/workflows';

/**
 * The launch settings for a resolved workflow: the saved `workflow:<id>`
 * defaults, then the global config default, then the floor. Reads the store's
 * LIVE state because `workflowId` is only known after the async workflows.list
 * lookup — a hook-level selector would be keyed wrong.
 *
 * Exported so `guided/launchFirstSession.ts` (the onboarding first-session
 * launcher) can reuse the exact same ladder rather than reimplementing it.
 */
export function resolveLaunchDefaults(workflowId: string, globalPermissionMode: PermissionMode) {
  const config = useConfigStore.getState().config;
  const resolved = resolveRunTypeLaunchDefaults(
    workflowRunTypeKey(workflowId),
    config?.runTypeDefaults,
    {
      permissionMode: globalPermissionMode,
      // The GLOBAL launch model — the middle rung, below a stored
      // `workflow:<id>` model and above DEFAULT_WORKFLOW_MODEL. Trimmed, blank
      // ⇒ unset, matching main's configManager.getDefaultLaunchModel.
      model: config?.defaultLaunchModel?.trim() || undefined,
      // The GLOBAL agent runtime rides the `agentRuntime` rung VERBATIM — that
      // rung is for a genuine user-set runtime and nothing else (a resolved
      // runtime OWNS its implied substrate, so anything synthesized from a
      // substrate preference would outrank a stored substrate). A
      // workflow-invalid value is dropped below, like a stored one.
      agentRuntime: config?.defaultAgentRuntime,
    },
  );
  // A runtime a workflow cannot run on (codex-pty, and anything
  // RUNTIME_CAPABILITIES marks unofferable — 'codex-exec', which never reaches a
  // launch surface) is dropped rather than sent; the launch still proceeds on
  // the backend's default. One coercion point for BOTH the stored and the
  // global rung.
  const offerableRuntime = launchRuntimeForPickers(resolved.agentRuntime);
  const agentRuntime =
    offerableRuntime !== undefined
      ? (workflowRuntimeForLaunch(offerableRuntime) ?? undefined)
      : undefined;
  return {
    model: resolved.model,
    permissionMode: resolved.permissionMode,
    substrate: resolved.substrate,
    ...(agentRuntime !== undefined ? { agentRuntime } : {}),
  };
}

export interface TaskRunLaunchState {
  /** Task id currently being launched, or null when idle. */
  launchingTaskId: string | null;
  /** Last launch error message, or null. */
  error: string | null;
  /** Launch a run for `taskId` (of `type`) in `projectId`. Resolves to the new runId or null. */
  launch: (taskId: string, projectId: number, type: TaskType) => Promise<string | null>;
  /**
   * Launch a parallel **Sprint** over an explicit batch of task ids — e.g. the
   * ready-for-development child tasks of an epic, confirmed in the batch picker.
   * `spinnerId` drives the card spinner (the epic's id); `taskIds` seeds the
   * sprint batch. Resolves to the new runId or null (no-op on an empty batch).
   */
  launchSprintBatch: (spinnerId: string, taskIds: string[], projectId: number) => Promise<string | null>;
  /**
   * Launch a **Planner** seeded with an explicit set of ideas — the review
   * queue's multi-idea pick-list. Mirrors {@link launchSprintBatch}, but seeds
   * `ideaIds` (planner-only; `runs.start` rejects it for any other flow and
   * caps it at {@link MAX_PLANNER_SEED_IDEAS}, so the batch is truncated here
   * rather than round-tripped for a rejection). Resolves to the new runId or
   * null (no-op on an empty batch).
   */
  launchPlannerBatch: (spinnerId: string, ideaIds: string[], projectId: number) => Promise<string | null>;
}

/** `runs.start`'s server-side cap on planner seed ideas (`ideaIds` is `.max(4)`). */
export const MAX_PLANNER_SEED_IDEAS = 4;

export function useTaskRunLauncher(): TaskRunLaunchState {
  const [launchingTaskId, setLaunchingTaskId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // This launcher has no Configure screen, so every launch setting comes from
  // resolveLaunchDefaults: a saved per-workflow default, else this global
  // Agent-Permission-Mode default (permission only), else the floor.
  const globalPermissionMode =
    useConfigStore((state) => state.config?.defaultAgentPermissionMode) ?? 'default';

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
        // like every other launch surface — ensure a session so the run executes in
        // the session worktree and Diff/File-Explorer can follow it. forceNew: a
        // backlog run is an explicit NEW launch, not an "add a workflow to the session
        // I'm viewing" — it must never silently absorb the selected quick session
        // (only the in-session useLaunchWorkflow affordance reuses the selection).
        const sessionId = await ensureSessionForLaunch(projectId, { forceNew: true });
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
          // Pinning `model` (rather than omitting it) is what makes the run's
          // read-only model pill render instead of a NULL no-pin.
          ...resolveLaunchDefaults(workflowId, globalPermissionMode),
          ...seed,
        });
        trackEvent('workflow_run_started', { launch_surface: 'backlog', flow: wantName });
        return result.runId;
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to launch run');
        return null;
      } finally {
        setLaunchingTaskId(null);
      }
    },
    [globalPermissionMode],
  );

  const launchSprintBatch = useCallback(
    async (spinnerId: string, taskIds: string[], projectId: number): Promise<string | null> => {
      if (taskIds.length === 0) return null;
      setError(null);
      setLaunchingTaskId(spinnerId);
      try {
        const workflows = await trpc.cyboflow.workflows.list.query({ projectId });
        // Sprint is the task-execution flow; resolve it by name (built-in
        // ordering is not a contract). Fall back to the first flow.
        const workflowId = workflows.find((w) => w.name === 'sprint')?.id ?? workflows[0]?.id;
        if (!workflowId) {
          setError('No workflow available to run');
          return null;
        }
        // Session-hosted like every other launch surface; forceNew so the batch
        // run never silently absorbs the selected quick session (mirrors `launch`).
        const sessionId = await ensureSessionForLaunch(projectId, { forceNew: true });
        const result = await trpc.cyboflow.runs.start.mutate({
          workflowId,
          projectId,
          sessionId,
          taskIds,
          ...resolveLaunchDefaults(workflowId, globalPermissionMode),
        });
        trackEvent('workflow_run_started', { launch_surface: 'backlog', flow: 'sprint' });
        return result.runId;
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to launch sprint');
        return null;
      } finally {
        setLaunchingTaskId(null);
      }
    },
    [globalPermissionMode],
  );

  const launchPlannerBatch = useCallback(
    async (spinnerId: string, ideaIds: string[], projectId: number): Promise<string | null> => {
      if (ideaIds.length === 0) return null;
      setError(null);
      setLaunchingTaskId(spinnerId);
      try {
        const workflows = await trpc.cyboflow.workflows.list.query({ projectId });
        // Planner is the idea-decomposition flow; resolve it by name (built-in
        // ordering is not a contract). Fall back to the first flow.
        const workflowId = workflows.find((w) => w.name === 'planner')?.id ?? workflows[0]?.id;
        if (!workflowId) {
          setError('No workflow available to run');
          return null;
        }
        // Session-hosted like every other launch surface; forceNew so the batch
        // run never silently absorbs the selected quick session (mirrors `launch`).
        const sessionId = await ensureSessionForLaunch(projectId, { forceNew: true });
        const result = await trpc.cyboflow.runs.start.mutate({
          workflowId,
          projectId,
          sessionId,
          // `ideaIds` and the singular `ideaId` are mutually exclusive server-side —
          // seed only the plural form here.
          ideaIds: ideaIds.slice(0, MAX_PLANNER_SEED_IDEAS),
          ...resolveLaunchDefaults(workflowId, globalPermissionMode),
        });
        trackEvent('workflow_run_started', { launch_surface: 'backlog', flow: 'planner' });
        return result.runId;
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to launch planner');
        return null;
      } finally {
        setLaunchingTaskId(null);
      }
    },
    [globalPermissionMode],
  );

  return { launchingTaskId, error, launch, launchSprintBatch, launchPlannerBatch };
}
