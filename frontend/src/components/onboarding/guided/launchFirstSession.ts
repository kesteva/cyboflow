/**
 * launchFirstSession — pure async launcher for the two FLOW kinds guided step
 * 13 ("Launch your first session") can start: Planner and Ship. Mirrors
 * useTaskRunLauncher's launchPlannerBatch/launch (same workflow-resolve →
 * ensureSessionForLaunch → runs.start.mutate shape), reusing its exported
 * `resolveLaunchDefaults` rather than re-deriving the settings ladder.
 *
 * Quick sessions are NOT launched here — `useQuickSession` is a hook (it needs
 * component lifecycle for its `isStarting`/`error` state), so FirstSessionStep
 * calls it directly for the 'quick' choice.
 */
import { trpc } from '../../../trpc/client';
import { ensureSessionForLaunch } from '../../../utils/ensureSessionForLaunch';
import { trackEvent } from '../../../utils/telemetry';
import { resolveLaunchDefaults, MAX_PLANNER_SEED_IDEAS } from '../../Backlog/useTaskRunLauncher';
import type { LaunchedSession } from '../../../stores/onboardingStore';
import type { PermissionMode } from '../../../../../shared/types/workflows';

export { MAX_PLANNER_SEED_IDEAS };

export interface LaunchFirstFlowInput {
  kind: 'planner' | 'ship';
  projectId: number;
  /** Idea ids selected in the seed block — truncated to MAX_PLANNER_SEED_IDEAS for planner, and exactly one required for ship. */
  ideaIds: string[];
  permissionMode: PermissionMode;
}

/**
 * Launches a Planner or Ship run for the guided set-up's own project, seeded
 * with the ideas the user picked on step 13. Throws (rather than returning an
 * error string) when the flow is unavailable or ship has no idea selected —
 * the caller (FirstSessionStep) catches and renders the message.
 */
export async function launchFirstFlow(input: LaunchFirstFlowInput): Promise<LaunchedSession> {
  const { kind, projectId, ideaIds, permissionMode } = input;

  const workflows = await trpc.cyboflow.workflows.list.query({ projectId });
  const workflowId = workflows.find((w) => w.name === kind)?.id;
  if (workflowId === undefined) {
    throw new Error(`The ${kind} flow is not available for this project`);
  }

  const sessionId = await ensureSessionForLaunch(projectId, { forceNew: true });
  const defaults = resolveLaunchDefaults(workflowId, permissionMode);

  const result =
    kind === 'ship'
      ? await (async () => {
          const ideaId = ideaIds[0];
          if (ideaId === undefined) {
            throw new Error('Pick one idea to ship');
          }
          return trpc.cyboflow.runs.start.mutate({
            workflowId,
            projectId,
            sessionId,
            ideaId,
            ...defaults,
          });
        })()
      : await trpc.cyboflow.runs.start.mutate({
          workflowId,
          projectId,
          sessionId,
          ...(ideaIds.length > 0 ? { ideaIds: ideaIds.slice(0, MAX_PLANNER_SEED_IDEAS) } : {}),
          ...defaults,
        });

  trackEvent('workflow_run_started', { launch_surface: 'onboarding', flow: kind });

  return { kind, sessionId, runId: result.runId };
}
