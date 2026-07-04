/**
 * WorkflowPicker — dropdown of the cyboflow workflows (Planner + Sprint + Ship +
 * any custom flows) + Start Run button.
 *
 * Accepts a `projectId` prop; on mount it calls `trpc.cyboflow.workflows.list`
 * and populates a `<select>`.  Clicking "Start Run" calls
 * `trpc.cyboflow.runs.start.mutate` and stores the returned runId in
 * `cyboflowStore`.
 *
 * Also provides a "Quick Session" button that creates a quick session via
 * `sessions:create-quick` IPC, bootstraps both Claude and Terminal panels via
 * `panelApi.createPanel`, and navigates via `setActiveQuickSession`.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { trpc } from '../../trpc/client';
import { useCyboflowStore } from '../../stores/cyboflowStore';
import { ensureSessionForLaunch } from '../../utils/ensureSessionForLaunch';
import { useQuickSession } from '../../hooks/useQuickSession';
import { useAgentPermissionMode } from '../../hooks/useAgentPermissionMode';
import { WorkflowEditorModal } from './WorkflowEditorModal';
import { IdeaPickerModal } from './IdeaPickerModal';
import { AgentPermissionModeSelector } from './AgentPermissionModeSelector';
import { SubstrateSelector } from './SubstrateSelector';
import { ModelSelector, DEFAULT_WORKFLOW_MODEL } from './ModelSelector';
import { TaskBatchPickerModal } from './TaskBatchPickerModal';
import { VariantSelector } from './VariantSelector';
import { variantSelectionToStartInput, type VariantSelection } from './variantSelectorLogic';
import { type WorkflowRow, CYBOFLOW_WORKFLOW_NAMES } from '../../../../shared/types/workflows';
import { type CliSubstrate, DEFAULT_SUBSTRATE } from '../../../../shared/types/substrate';
import { trackEvent } from '../../utils/telemetry';
import type { TelemetryFlow } from '../../../../shared/types/telemetry';

interface WorkflowPickerProps {
  projectId: number;
  onWorkflowStarted?: (runId: string) => void;
  /**
   * Force the launch into a brand-new session, never reusing the current
   * selection. Set by the "Add a workflow" flow on an interactive (PTY) session,
   * where a second workflow is descoped from the live-REPL session and must run
   * in its own separate session. Threaded into {@link ensureSessionForLaunch}.
   */
  forceNewSession?: boolean;
}

export function WorkflowPicker({ projectId, onWorkflowStarted, forceNewSession = false }: WorkflowPickerProps) {
  const [workflows, setWorkflows] = useState<WorkflowRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * The per-launch CLI substrate choice. Defaults to DEFAULT_SUBSTRATE ('sdk') —
   * the global ConfigManager.defaultSubstrate floor — and is threaded into
   * runs.start.mutate for workflow launches AND into useQuickSession.start
   * (→ sessions.substrate) for the Quick Session button, since both share this
   * surface's selector. The mutate input type is AppRouter-inferred (no local
   * mirror of the substrate field), and CliSubstrate is imported from the S1
   * shared type, never re-declared here.
   */
  const [substrate, setSubstrate] = useState<CliSubstrate>(DEFAULT_SUBSTRATE);

  /**
   * The per-run Claude model choice (Configure model dropdown). Defaults to Opus
   * (DEFAULT_WORKFLOW_MODEL) like the Session Start Wizard; threaded into
   * runs.start.mutate as `model` → workflow_runs.model (migration 037) for workflow
   * launches, and into useQuickSession.start for the Quick Session button.
   */
  const [model, setModel] = useState<string>(DEFAULT_WORKFLOW_MODEL);

  /**
   * The per-run A/B variant choice (migration 046, VariantSelector). Defaults to
   * 'rotation' — a no-op selection ({@link variantSelectionToStartInput} sends
   * neither `variantId` nor `baseline`) so a workflow with zero (or no eligible)
   * variants launches exactly as before. VariantSelector re-seeds this to the
   * architect-specified default once its list resolves; reset to 'rotation'
   * whenever the selected workflow changes so a stale variant id from a
   * PREVIOUS workflow selection is never sent to a different workflow's launch
   * (variant ids are workflow-scoped — the resolver rejects a foreign pin).
   */
  const [variantSelection, setVariantSelection] = useState<VariantSelection>({ mode: 'rotation' });

  /**
   * The per-run agent permission choice — seeded from the global default and
   * guarded against the config-load race by {@link useAgentPermissionMode}.
   * Threaded into runs.start.mutate as `permissionMode` (the AppRouter-inferred
   * input).
   */
  const { mode: permissionMode, setMode: setPermissionMode } = useAgentPermissionMode();

  // Blueprint editor — opened in 'edit' (selected flow) or 'create' (new flow) mode.
  const [editorMode, setEditorMode] = useState<'edit' | 'create' | null>(null);

  // Planner pre-launch idea-selection gate (migration 017). When the selected
  // workflow is the Planner, "Start Run" opens this picker first; the chosen
  // idea id is threaded into runs.start.mutate({ ideaId }).
  const [ideaPickerOpen, setIdeaPickerOpen] = useState(false);

  // Sprint pre-launch multi-task selector (feat/parallel-sprint). When the
  // selected workflow is the Sprint, "Start Run" opens this picker first; the
  // multi-selected task ids are threaded into runs.start as `taskIds` — ONE
  // session-hosted run whose orchestrator agent fans the tasks out as subagents
  // (per-task progress renders as lanes in the run progress rail).
  const [batchPickerOpen, setBatchPickerOpen] = useState(false);

  /**
   * Synchronous in-flight latch for "Start Run". The `isStarting` STATE guard is
   * insufficient against a double-submit: two clicks fired in the same tick both
   * read isStarting=false and both fire runs.start (each spinning up a worktree),
   * and the `disabled` attribute only applies after the next render. A ref flips
   * synchronously so the second click is rejected. (Prevents the duplicate-run bug.)
   */
  const startInFlightRef = useRef(false);

  const {
    start: startQuickSession,
    isStarting: isQuickStarting,
    error: quickError,
  } = useQuickSession({
    projectId,
    onSuccess: (sessionId) => {
      onWorkflowStarted?.(sessionId);
    },
  });

  /**
   * Fetch the project's workflow list. Refactored out of the mount effect into a
   * callable so it can be re-invoked after the editor saves a new/edited flow.
   * `preferId`, when set, is selected after the refresh (used to focus a flow the
   * user just created/edited); otherwise selection is preserved or defaults to
   * the first row.
   */
  const loadWorkflows = useCallback(
    (preferId?: string): Promise<void> => {
      setIsLoading(true);
      setError(null);
      return trpc.cyboflow.workflows.list
        .query({ projectId })
        .then((rows) => {
          setWorkflows(rows);
          setSelectedId((prev) => {
            if (preferId && rows.some((r) => r.id === preferId)) return preferId;
            if (prev !== null && rows.some((r) => r.id === prev)) return prev;
            return rows.length > 0 ? rows[0].id : null;
          });
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : 'Failed to load workflows');
        })
        .finally(() => {
          setIsLoading(false);
        });
    },
    [projectId],
  );

  // Load workflows on mount (or when projectId changes).
  useEffect(() => {
    void loadWorkflows();
  }, [loadWorkflows]);

  // A variant id is workflow-scoped — reset to the no-op 'rotation' selection
  // whenever the selected workflow changes so a PRIOR workflow's variant pin is
  // never sent to a different workflow's launch (VariantSelector re-seeds the
  // real default for the new workflow once its list resolves).
  useEffect(() => {
    setVariantSelection({ mode: 'rotation' });
  }, [selectedId]);

  const handleEditorSaved = useCallback(
    (savedId: string) => {
      setEditorMode(null);
      void loadWorkflows(savedId);
    },
    [loadWorkflows],
  );

  // Map a workflow row id to its telemetry flow key (built-in name, else 'custom').
  const flowOf = (workflowId: string): TelemetryFlow => {
    const name = workflows.find((w) => w.id === workflowId)?.name;
    return name && (CYBOFLOW_WORKFLOW_NAMES as readonly string[]).includes(name)
      ? (name as TelemetryFlow)
      : 'custom';
  };

  /**
   * Fire the actual runs.start mutation. `ideaId` is the Planner's pre-launch
   * seed idea (migration 017) — undefined for Sprint (and any free Planner
   * launch). The synchronous in-flight latch flips HERE (at the real mutate),
   * NOT on modal open, so opening the picker is freely cancellable.
   */
  const launchRun = useCallback(
    async (workflowId: string, ideaId?: string): Promise<void> => {
      if (startInFlightRef.current) return;
      startInFlightRef.current = true;
      setError(null);
      setIsStarting(true);
      try {
        // Ensure the run executes INSIDE a session (active one if selected, else
        // a freshly created session). The id is threaded into runs.start so the
        // run runs in that session's worktree, and used to nest the run under
        // the session in the store (setActiveRun's parentSessionId). forceNew
        // bypasses reuse for the PTY add-workflow flow (separate session).
        const sessionId = await ensureSessionForLaunch(projectId, { forceNew: forceNewSession });
        const result = await trpc.cyboflow.runs.start.mutate({
          workflowId,
          projectId,
          substrate,
          sessionId,
          permissionMode,
          model,
          ...(ideaId !== undefined ? { ideaId } : {}),
          ...variantSelectionToStartInput(variantSelection),
        });
        useCyboflowStore.getState().setActiveRun(result.runId, sessionId);
        trackEvent('workflow_run_started', {
          launch_surface: 'topbar',
          flow: flowOf(workflowId),
          substrate,
          permission_mode: permissionMode,
        });
        onWorkflowStarted?.(result.runId);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to start run');
      } finally {
        setIsStarting(false);
        startInFlightRef.current = false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId, substrate, permissionMode, model, variantSelection, onWorkflowStarted, forceNewSession, workflows],
  );

  /**
   * Fire the parallel-sprint launch — ONE session-hosted sprint run seeded with
   * the multi-selected task ids (single-run lane model). Mirrors launchRun
   * exactly (ensureSessionForLaunch → runs.start → setActiveRun →
   * onWorkflowStarted); `taskIds` makes the launcher create the lane batch and
   * stamp workflow_runs.batch_id. The substrate-keyed cap N is enforced both in
   * the picker and server-side in runs.start (defense in depth). The synchronous
   * in-flight latch flips HERE (at the real mutate), so opening the picker stays
   * freely cancellable — mirrors launchRun.
   */
  const launchBatch = useCallback(
    async (workflowId: string, taskIds: string[]): Promise<void> => {
      if (startInFlightRef.current) return;
      startInFlightRef.current = true;
      setError(null);
      setIsStarting(true);
      try {
        const sessionId = await ensureSessionForLaunch(projectId, { forceNew: forceNewSession });
        const result = await trpc.cyboflow.runs.start.mutate({
          workflowId,
          projectId,
          substrate,
          sessionId,
          permissionMode,
          model,
          taskIds,
          ...variantSelectionToStartInput(variantSelection),
        });
        useCyboflowStore.getState().setActiveRun(result.runId, sessionId);
        trackEvent('workflow_run_started', {
          launch_surface: 'topbar',
          flow: flowOf(workflowId),
          substrate,
          permission_mode: permissionMode,
        });
        onWorkflowStarted?.(result.runId);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to start sprint run');
      } finally {
        setIsStarting(false);
        startInFlightRef.current = false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId, substrate, permissionMode, model, variantSelection, onWorkflowStarted, forceNewSession, workflows],
  );

  const handleStartRun = async () => {
    if (selectedId === null || startInFlightRef.current) return;
    // Planner is gated behind the idea picker, Sprint behind the batch picker.
    // Workflow `name` is the lowercase CyboflowWorkflowName seeded by
    // WorkflowRegistry — compare to 'planner' / 'sprint'. Ship (planner ⊕ sprint
    // in one run) is IDEA-seeded like the planner, so it shares the idea gate.
    const selected = workflows.find((wf) => wf.id === selectedId);
    if (selected?.name === 'planner' || selected?.name === 'ship') {
      setError(null);
      setIdeaPickerOpen(true);
      return;
    }
    if (selected?.name === 'sprint') {
      setError(null);
      setBatchPickerOpen(true);
      return;
    }
    await launchRun(selectedId);
  };

  const handleBatchPicked = useCallback(
    (taskIds: string[]): void => {
      setBatchPickerOpen(false);
      if (taskIds.length === 0) return;
      // The sprint workflow id is the current selection (handleStartRun resolved
      // it before opening the picker; the modal blocks re-selection meanwhile).
      if (selectedId === null) return;
      void launchBatch(selectedId, taskIds);
    },
    [selectedId, launchBatch],
  );

  const handleIdeaPicked = useCallback(
    (ideaId: string): void => {
      setIdeaPickerOpen(false);
      if (selectedId === null) return;
      void launchRun(selectedId, ideaId);
    },
    [selectedId, launchRun],
  );

  const combinedError = error ?? quickError;

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-text-primary">Workflow</h2>

      {isLoading && (
        <p className="text-xs text-text-secondary">Loading workflows…</p>
      )}

      {!isLoading && workflows.length > 0 && (
        <select
          value={selectedId ?? ''}
          onChange={(e) => {
            setSelectedId(e.target.value);
            trackEvent('flow_selected', { flow: flowOf(e.target.value) });
          }}
          className="w-full rounded-input border border-border-primary bg-bg-primary px-2 py-1 text-sm text-text-primary"
          aria-label="Select workflow"
        >
          {workflows.map((wf) => (
            <option key={wf.id} value={wf.id}>
              {wf.name}
            </option>
          ))}
        </select>
      )}

      {/* Substrate selector + interactive v1 caveats (IDEA-013 / TASK-812). */}
      <SubstrateSelector
        value={substrate}
        onChange={setSubstrate}
        id="workflow-picker-substrate"
        caveatsTestId="workflow-picker-substrate-caveats"
      />

      {/* Session permission selector — an explicit choice permanently sets the
          host session's mode (the sole execution authority), affecting later chat
          and later flows in that session; the launch still stamps the audit-only
          permission_mode_snapshot. Omitted → the session mode is left untouched. */}
      <AgentPermissionModeSelector value={permissionMode} onChange={setPermissionMode} />

      {/* Per-run model selector — pins the model a workflow run (or quick session)
          spawns with (default Opus). Workflow: threaded into runs.start as `model`
          → workflow_runs.model (migration 037). Quick: into useQuickSession. */}
      <ModelSelector value={model} onChange={setModel} id="workflow-picker-model" />

      {/* Per-run A/B variant selector (migration 046) — hidden entirely for a
          workflow with zero variants. Threaded into runs.start as variantId /
          baseline (never both); rotation sends neither field. */}
      {selectedId !== null && (
        <VariantSelector
          workflowId={selectedId}
          value={variantSelection}
          onChange={setVariantSelection}
          id="workflow-picker-variant"
        />
      )}

      {combinedError && (
        <p className="text-xs text-status-error" role="alert">
          {combinedError}
        </p>
      )}

      <div className="flex gap-2">
        <button
          onClick={handleStartRun}
          disabled={selectedId === null || isLoading || isStarting || isQuickStarting}
          className="flex-1 rounded-button bg-interactive px-3 py-1.5 text-sm font-medium text-text-on-interactive hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          Start Run
        </button>
        <button
          onClick={() => setEditorMode('edit')}
          disabled={selectedId === null || isLoading}
          className="rounded-button border border-border-primary bg-bg-primary px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="workflow-picker-edit"
        >
          Edit
        </button>
        <button
          onClick={() => setEditorMode('create')}
          disabled={isLoading}
          className="rounded-button border border-border-primary bg-bg-primary px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="workflow-picker-new-flow"
        >
          New flow
        </button>
      </div>

      {editorMode !== null && (
        <WorkflowEditorModal
          isOpen
          mode={editorMode}
          workflowId={selectedId ?? ''}
          projectId={projectId}
          onClose={() => setEditorMode(null)}
          onSaved={handleEditorSaved}
        />
      )}

      {ideaPickerOpen && (
        <IdeaPickerModal
          isOpen
          projectId={projectId}
          onClose={() => setIdeaPickerOpen(false)}
          onPicked={handleIdeaPicked}
        />
      )}

      {batchPickerOpen && (
        <TaskBatchPickerModal
          isOpen
          projectId={projectId}
          substrate={substrate}
          onClose={() => setBatchPickerOpen(false)}
          onPicked={handleBatchPicked}
        />
      )}

      <div className="mt-2 flex flex-col gap-2 border-t border-border-primary pt-3">
        <p className="text-xs text-text-secondary">Or start without a workflow:</p>
        <button
          onClick={() => void startQuickSession(permissionMode, substrate, undefined, model)}
          disabled={isQuickStarting || isStarting}
          className="rounded-button border border-interactive bg-bg-primary px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="quick-session-button"
        >
          Quick Session
        </button>
      </div>
    </div>
  );
}
