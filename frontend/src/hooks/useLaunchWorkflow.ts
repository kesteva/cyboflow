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
 * — but with no Configure screen, since the canvas is a fast lane; the full
 * WorkflowPicker ("Browse all") still offers per-run control. Launch settings
 * come from `resolveRunTypeLaunchDefaults` (the saved `workflow:<id>` defaults,
 * then the global config default, then the floor).
 *
 * `seed.ideaId` threads the Planner's single-select pre-launch seed idea
 * (migration 017); `seed.ideaIds` threads its multi-select batch (IDEA-009);
 * `seed.taskIds` threads the Sprint's pre-launch task batch; `seed.seedPrompt`
 * threads the Launch flow's pre-launch free-text answer. The canvas opens the
 * matching picker/modal (IdeaPickerModal / TaskBatchPickerModal /
 * LaunchPromptModal) first and MUST pass the corresponding seed; other
 * workflows launch seedless.
 */
import { useCallback, useRef, useState } from 'react';
import { trpc } from '../trpc/client';
import { useCyboflowStore } from '../stores/cyboflowStore';
import { useConfigStore } from '../stores/configStore';
import { ensureSessionForLaunch } from '../utils/ensureSessionForLaunch';
import { useForcedSubstrate } from './useForcedSubstrate';
import {
  resolveRunTypeLaunchDefaults,
  workflowRunTypeKey,
} from '../../../shared/types/sessionDefaults';
import { launchRuntimeForPickers, workflowRuntimeForLaunch } from '../components/cyboflow/agentRuntimeUi';
import { trackEvent } from '../utils/telemetry';
import type { PermissionMode } from '../../../shared/types/workflows';

/**
 * Pre-launch seed — at most one of ideaId (planner, single-select) / ideaIds
 * (planner, multi-select batch, IDEA-009 — a 1-element batch should be
 * normalized to the singular `ideaId` by the caller) / taskIds (sprint) /
 * seedPrompt (launch).
 *
 * `originIdeaId` is NOT a seed — it composes WITH taskIds (the idea canvas's
 * "Launch sprint" tile) to stamp the host session's origin_idea_id lineage
 * (sidebar nesting + busy guard) without any `# Selected idea` prompt block.
 * Redundant next to `ideaId`, whose seed path already stamps.
 */
export interface LaunchSeed {
  ideaId?: string;
  ideaIds?: string[];
  taskIds?: string[];
  seedPrompt?: string;
  originIdeaId?: string;
}

export interface UseLaunchWorkflowResult {
  /**
   * Fire the launch. Resolves to the new runId, or null on failure.
   *
   * `launchOpts.forceNewSession` makes THIS call create a fresh worktree-backed
   * host session instead of reusing the current selection — required for the
   * "Plan separately" peeled launches (IDEA-009): the batch launch just occupied
   * the current session, and the busy-check in ensureSessionForLaunch reads
   * `activeRunsStore`, which learns about that run only via an ASYNC re-fetch —
   * a sequential peeled launch would re-select the now-busy session and be
   * rejected by the backend's one-running-per-session guard.
   *
   * `launchOpts.hostSessionId`, when provided, SKIPS `ensureSessionForLaunch`
   * entirely and uses the given id verbatim as the run's host session (e.g. a
   * Design Mode session continuing the planner in place). The caller vouches
   * that the session is worktree-backed and free — the backend's guards
   * (no runs on an in-place/main-repo session, one-active-workflow-per-session)
   * remain the backstop and surface as this hook's normal `error` on rejection.
   * Takes precedence over `forceNewSession` when both are set.
   *
   * `launchOpts.permissionMode` overrides the global default for the run's
   * permission snapshot. A same-session launch passes the host session's live
   * `agentPermissionMode` so the run keeps behaving like the session it lands
   * in (e.g. a "Don't ask" design session doesn't park on a permission gate
   * seconds after "In this session").
   */
  launch: (
    workflowId: string,
    seed?: LaunchSeed,
    launchOpts?: {
      forceNewSession?: boolean;
      hostSessionId?: string;
      permissionMode?: PermissionMode;
    },
  ) => Promise<string | null>;
  isLaunching: boolean;
  error: string | null;
}

export function useLaunchWorkflow(
  projectId: number,
  opts?: {
    onLaunched?: (runId: string) => void;
    /**
     * Always create a fresh worktree-backed session for the run rather than
     * reusing the current selection. Set by the QuickSessionCanvas when its
     * session is in-place (works directly in the checkout) or the main repo — a
     * workflow can never run on the raw checkout, so it must land in a new
     * isolated session. Threaded to ensureSessionForLaunch.
     */
    forceNew?: boolean;
  },
): UseLaunchWorkflowResult {
  const [isLaunching, setIsLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Synchronous in-flight latch — guards against a double-submit firing two
  // runs.start (each spinning up a worktree) before the disabled attr applies.
  // Mirrors WorkflowPicker's startInFlightRef.
  const inFlightRef = useRef(false);

  const onLaunched = opts?.onLaunched;
  const forceNew = opts?.forceNew ?? false;
  const globalPermissionMode =
    useConfigStore((state) => state.config?.defaultAgentPermissionMode) ?? 'default';
  // Global forced-substrate pin (demo 'sdk' wins, else PTY-only lock
  // 'interactive', else null). Sent so the payload matches what the backend
  // would stamp anyway (getForcedSubstrate overrides regardless).
  const forced = useForcedSubstrate();

  const launch = useCallback(
    async (
      workflowId: string,
      seed?: LaunchSeed,
      launchOpts?: {
        forceNewSession?: boolean;
        hostSessionId?: string;
        permissionMode?: PermissionMode;
      },
    ): Promise<string | null> => {
      if (inFlightRef.current) return null;
      inFlightRef.current = true;
      setError(null);
      setIsLaunching(true);
      try {
        // `hostSessionId` bypasses session resolution entirely — the caller
        // already knows which (worktree-backed, free) session should host the
        // run. Otherwise launch INTO the active session (the resting quick
        // session), reusing its worktree — ensureSessionForLaunch returns
        // selectedSessionId when set. `forceNew` (in-place / main-repo host
        // session) and the per-call `forceNewSession` (a "Plan separately"
        // peeled launch) skip that reuse and create a fresh worktree-backed
        // session instead.
        const sessionId =
          launchOpts?.hostSessionId !== undefined
            ? launchOpts.hostSessionId
            : await ensureSessionForLaunch(projectId, {
                forceNew: forceNew || launchOpts?.forceNewSession === true,
              });
        // Read the config INSIDE the callback, keyed off THIS call's
        // workflowId — a hook-level selector would capture the wrong (or a
        // stale) workflow's defaults, since `launch` is generic over any id.
        const config = useConfigStore.getState().config;
        const resolved = resolveRunTypeLaunchDefaults(
          workflowRunTypeKey(workflowId),
          config?.runTypeDefaults,
          {
            permissionMode: globalPermissionMode,
            // The GLOBAL launch model — the middle rung, below a stored
            // `workflow:<id>` model and above DEFAULT_WORKFLOW_MODEL. Trimmed,
            // blank ⇒ unset, matching main's configManager.getDefaultLaunchModel.
            model: config?.defaultLaunchModel?.trim() || undefined,
            // The GLOBAL agent runtime rides the `agentRuntime` rung VERBATIM —
            // it is a genuine user-set runtime, the only thing this rung is for.
            // Nothing synthesized from a substrate preference may go here (a
            // resolved runtime OWNS its implied substrate and would outrank a
            // stored substrate). Workflow-invalid values are dropped below,
            // exactly like a workflow-invalid STORED value.
            agentRuntime: config?.defaultAgentRuntime,
          },
        );
        // A runtime a workflow simply cannot run on (codex-pty, and anything
        // RUNTIME_CAPABILITIES marks unofferable — 'codex-exec', which never
        // reaches a launch surface) is dropped, never sent; the launch proceeds
        // on the backend's default. This is the one coercion point for BOTH the
        // stored and the global rung, so a global `codex-pty` degrades to the
        // workflow floor rather than blocking the launch.
        const offerableRuntime = launchRuntimeForPickers(resolved.agentRuntime);
        const agentRuntime =
          offerableRuntime !== undefined
            ? (workflowRuntimeForLaunch(offerableRuntime) ?? undefined)
            : undefined;
        const base = {
          workflowId,
          projectId,
          // `forced` is a hard global pin (demo 'sdk' / PTY-only lock), so it
          // outranks a saved per-workflow substrate; the backend stamps it
          // regardless, and sending it keeps the payload honest.
          substrate: forced ?? resolved.substrate,
          sessionId,
          permissionMode: launchOpts?.permissionMode ?? resolved.permissionMode,
          model: resolved.model,
          ...(agentRuntime !== undefined ? { agentRuntime } : {}),
        };
        const result = await trpc.cyboflow.runs.start.mutate({
          ...(seed?.ideaIds !== undefined
            ? { ...base, ideaIds: seed.ideaIds }
            : seed?.ideaId !== undefined
              ? { ...base, ideaId: seed.ideaId }
              : seed?.taskIds !== undefined
                ? { ...base, taskIds: seed.taskIds }
                : seed?.seedPrompt !== undefined
                  ? { ...base, seedPrompt: seed.seedPrompt }
                  : base),
          // Composes with (not instead of) the seed above — see LaunchSeed.
          ...(seed?.originIdeaId !== undefined ? { originIdeaId: seed.originIdeaId } : {}),
        });
        useCyboflowStore.getState().setActiveRun(result.runId, sessionId);
        trackEvent('workflow_run_started', {
          launch_surface: 'in_session',
          substrate: base.substrate,
          permission_mode: base.permissionMode,
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
    [projectId, globalPermissionMode, forced, onLaunched, forceNew],
  );

  return { launch, isLaunching, error };
}
