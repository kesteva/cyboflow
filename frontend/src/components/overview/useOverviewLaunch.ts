/**
 * useOverviewLaunch — the Project Overview page's direct Planner / Sprint
 * launches, mirroring {@link useTaskRunLauncher}'s shape and light launch path
 * exactly:
 *
 *   resolve the flow BY NAME (`workflows.list` → 'planner' / 'sprint', falling
 *   back to the first flow) → `ensureSessionForLaunch(projectId, {forceNew})` →
 *   `runs.start.mutate({ workflowId, projectId, sessionId, <seed>, ...defaults })`
 *   → setActiveRun + setActiveProjectId + goToSession.
 *
 * Two differences from useTaskRunLauncher, both because the Overview launches
 * from a MULTI-selection rather than one card:
 *   - the planner arm seeds `ideaIds` (the multi-idea planner seed, capped at 4
 *     server-side) instead of the singular `ideaId`;
 *   - the in-flight guard is a single `launching` discriminant ('planner' |
 *     'sprint' | null) rather than a task id, since the CTA lives on a
 *     selection bar and not on a row.
 *
 * Errors are surfaced VERBATIM on `error` (e.g. the launcher's `idea_busy`
 * rejection message) for the caller to render as small status-error text beside
 * the CTA — never thrown.
 */
import { useCallback, useState } from 'react';
import { trpc } from '../../trpc/client';
import { useConfigStore } from '../../stores/configStore';
import { useCyboflowStore } from '../../stores/cyboflowStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { ensureSessionForLaunch } from '../../utils/ensureSessionForLaunch';
import { trackEvent } from '../../utils/telemetry';
import {
  resolveRunTypeLaunchDefaults,
  workflowRunTypeKey,
} from '../../../../shared/types/sessionDefaults';
import { launchRuntimeForPickers, workflowRuntimeForLaunch } from '../cyboflow/agentRuntimeUi';
import type { PermissionMode } from '../../../../shared/types/workflows';

/** Which launch is currently in flight, if any. */
export type OverviewLaunchKind = 'planner' | 'sprint';

export interface OverviewLaunchState {
  /** The launch currently in flight, or null when idle. */
  launching: OverviewLaunchKind | null;
  /** Last launch error message (verbatim from the backend), or null. */
  error: string | null;
  /**
   * Which arm produced {@link error} — so a page hosting BOTH selection bars
   * renders the message under the one the user actually clicked, rather than
   * under both.
   */
  errorKind: OverviewLaunchKind | null;
  /** Clear the inline error (e.g. when the selection changes). */
  clearError: () => void;
  /** Launch a Planner run seeded with `ideaIds`. Resolves to the new runId or null. */
  launchPlanner: (ideaIds: string[], projectId: number) => Promise<string | null>;
  /** Launch a Sprint run over the `taskIds` batch. Resolves to the new runId or null. */
  launchSprint: (taskIds: string[], projectId: number) => Promise<string | null>;
}

/**
 * The launch settings for a resolved workflow — the saved `workflow:<id>`
 * defaults, then the global config default, then the floor. Reads the store's
 * LIVE state because `workflowId` is only known after the async workflows.list
 * lookup. Byte-identical to useTaskRunLauncher's private helper of the same
 * name (that one is not exported; duplicating the four lines beats widening a
 * sibling hook's surface for one extra caller).
 */
function resolveLaunchDefaults(workflowId: string, globalPermissionMode: PermissionMode) {
  const config = useConfigStore.getState().config;
  const resolved = resolveRunTypeLaunchDefaults(workflowRunTypeKey(workflowId), config?.runTypeDefaults, {
    permissionMode: globalPermissionMode,
    model: config?.defaultLaunchModel?.trim() || undefined,
    agentRuntime: config?.defaultAgentRuntime,
  });
  const offerableRuntime = launchRuntimeForPickers(resolved.agentRuntime);
  const agentRuntime =
    offerableRuntime !== undefined ? (workflowRuntimeForLaunch(offerableRuntime) ?? undefined) : undefined;
  return {
    model: resolved.model,
    permissionMode: resolved.permissionMode,
    substrate: resolved.substrate,
    ...(agentRuntime !== undefined ? { agentRuntime } : {}),
  };
}

export function useOverviewLaunch(): OverviewLaunchState {
  const [launching, setLaunching] = useState<OverviewLaunchKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<OverviewLaunchKind | null>(null);
  const globalPermissionMode =
    useConfigStore((state) => state.config?.defaultAgentPermissionMode) ?? 'default';

  const clearError = useCallback(() => {
    setError(null);
    setErrorKind(null);
  }, []);

  /**
   * Shared body for both arms: resolve → ensure session → start → navigate.
   * `seed` is the arm's launch-seed fragment (`{ideaIds}` / `{taskIds}`).
   */
  const run = useCallback(
    async (
      kind: OverviewLaunchKind,
      wantName: 'planner' | 'sprint',
      projectId: number,
      seed: { ideaIds: string[] } | { taskIds: string[] },
    ): Promise<string | null> => {
      setError(null);
      setErrorKind(null);
      setLaunching(kind);
      const fail = (message: string): null => {
        setError(message);
        setErrorKind(kind);
        return null;
      };
      try {
        const workflows = await trpc.cyboflow.workflows.list.query({ projectId });
        const workflowId = workflows.find((w) => w.name === wantName)?.id ?? workflows[0]?.id;
        if (!workflowId) {
          return fail('No workflow available to run');
        }
        // An Overview launch is an explicit NEW run — never absorb whatever
        // quick session happens to be selected (mirrors useTaskRunLauncher).
        const sessionId = await ensureSessionForLaunch(projectId, { forceNew: true });
        const result = await trpc.cyboflow.runs.start.mutate({
          workflowId,
          projectId,
          sessionId,
          ...resolveLaunchDefaults(workflowId, globalPermissionMode),
          ...seed,
        });
        trackEvent('workflow_run_started', { launch_surface: 'backlog', flow: wantName });
        useCyboflowStore.getState().setActiveRun(result.runId);
        useNavigationStore.getState().setActiveProjectId(projectId);
        useNavigationStore.getState().goToSession();
        return result.runId;
      } catch (err: unknown) {
        return fail(err instanceof Error ? err.message : `Failed to launch ${wantName}`);
      } finally {
        setLaunching(null);
      }
    },
    [globalPermissionMode],
  );

  const launchPlanner = useCallback(
    async (ideaIds: string[], projectId: number): Promise<string | null> => {
      if (ideaIds.length === 0) return null;
      return run('planner', 'planner', projectId, { ideaIds });
    },
    [run],
  );

  const launchSprint = useCallback(
    async (taskIds: string[], projectId: number): Promise<string | null> => {
      if (taskIds.length === 0) return null;
      return run('sprint', 'sprint', projectId, { taskIds });
    },
    [run],
  );

  return { launching, error, errorKind, clearError, launchPlanner, launchSprint };
}
