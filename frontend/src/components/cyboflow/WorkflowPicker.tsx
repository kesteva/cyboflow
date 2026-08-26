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
import { useConfigStore } from '../../stores/configStore';
import { ensureSessionForLaunch } from '../../utils/ensureSessionForLaunch';
import { useQuickSession } from '../../hooks/useQuickSession';
import { useSeededSelection } from '../../hooks/useSeededSelection';
import { useSaveRunTypeDefault, SAVE_DEFAULT_TOAST_MS } from '../../hooks/useSaveRunTypeDefault';
import { WorkflowEditorModal } from './WorkflowEditorModal';
import { IdeaPickerModal } from './IdeaPickerModal';
import { SessionActionToast } from './SessionActionToast';
import { workflowTitleForName } from './wizard/workflowMeta';
import { AgentPermissionModeSelector } from './AgentPermissionModeSelector';
import { SubstrateSelector } from './SubstrateSelector';
import { ModelSelector, DEFAULT_CODEX_MODEL, DEFAULT_WORKFLOW_MODEL } from './ModelSelector';
import { TaskBatchPickerModal } from './TaskBatchPickerModal';
import { LaunchPromptModal } from './LaunchPromptModal';
import { VariantSelector } from './VariantSelector';
import { variantSelectionToStartInput, type VariantSelection } from './variantSelectorLogic';
import { Button } from '../ui/Button';
import {
  type PermissionMode,
  type WorkflowRow,
  CYBOFLOW_WORKFLOW_NAMES,
} from '../../../../shared/types/workflows';
import { DEFAULT_SUBSTRATE } from '../../../../shared/types/substrate';
import { normalizeAgentModelSelection } from '../../../../shared/types/agentModels';
import {
  DEFAULT_SESSION_AGENT_RUNTIME,
  claudeRuntimeFromSubstrate,
  isSessionAgentRuntime,
  type AgentProvider,
} from '../../../../shared/types/agentRuntime';
import {
  DEFAULT_PERMISSION_MODE,
  QUICK_RUN_TYPE_KEY,
  resolveRunTypeLaunchDefaults,
  workflowRunTypeKey,
  type RunTypeLaunchGlobals,
} from '../../../../shared/types/sessionDefaults';
import type { LaunchAgentRuntime } from './agentRuntimeUi';
import {
  launchRuntimeForPickers,
  providerForRuntime,
  quickSessionRuntimeForLaunch,
  substrateForRuntime,
  workflowRuntimeForLaunch,
} from './agentRuntimeUi';
import { trackEvent } from '../../utils/telemetry';
import type { TelemetryFlow } from '../../../../shared/types/telemetry';
import { notifyWorkflowRunStarted } from '../../utils/onboarding';

/**
 * The model this picker falls back to when the current selection belongs to
 * another provider's family. Exhaustive over `AgentProvider`, so a provider
 * added to the union cannot ship without someone choosing its floor.
 *
 * Codex's floor is its `'auto'` sentinel ("let the runtime pick"). OMP has no
 * such sentinel — its catalogue is concrete `provider/model` ids and the ABSENCE
 * of a selection already means "runtime default" everywhere in the app — so its
 * floor is the empty selection, which the launch seam sends as no model pin.
 */
const PROVIDER_MODEL_FLOOR: Readonly<Record<AgentProvider, string>> = {
  claude: DEFAULT_WORKFLOW_MODEL,
  codex: DEFAULT_CODEX_MODEL,
  omp: '',
  // Empty selection, for OMP's reason: pi has no "let the runtime pick"
  // sentinel row.
  pi: '',
};

/**
 * Does `model` belong to `provider`? — the one family test this surface uses,
 * for the runtime-coercion effect and the quick-launch guard alike. Delegates to
 * the shared predicates `createRun` normalizes with, so the picker and the
 * launch never disagree about which provider owns an id. The empty selection
 * belongs to nobody: it is "no pin", which each caller resolves for itself.
 */
function modelFitsProvider(provider: AgentProvider, model: string | undefined): boolean {
  return model !== undefined && model !== '' &&
    normalizeAgentModelSelection(provider, model) !== undefined;
}

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
   * The user's global quick-session substrate preference (floors to 'interactive',
   * the PTY). This surface's runtime selector is keyed to the SELECTED WORKFLOW
   * (it primarily governs WORKFLOW launches) — but the "Quick Session" escape
   * hatch below is a real quick session and must honor the quick preference,
   * exactly like the Session Start Wizard and keyboard shortcut. When the user
   * hasn't touched the selector the quick launch resolves the quick key's own
   * defaults; an explicit selector change is a real per-launch choice and wins.
   */
  const quickDefaultSubstrate = useConfigStore(
    (s) => s.config?.quickSessionDefaultSubstrate ?? 'interactive',
  );

  /**
   * The Configure controls are ALL seeded from the user's stored per-run-type
   * default for the SELECTED workflow, through the one canonical resolver every
   * launch seam uses (`resolveRunTypeLaunchDefaults`: stored → globals → floor).
   * Seeding only the model — while still WRITING all four fields on "Save as
   * default" — silently rewrote a stored `permissionMode`/`agentRuntime` back to
   * the global values the screen happened to display, i.e. lost data on ordinary
   * use. Every control the save CTA captures must therefore also seed from it.
   *
   * `model`'s global rung is `config.defaultLaunchModel` — the user's global
   * launch model, NOT the legacy `config.defaultModel` (that one feeds the
   * assistant fallback and must never reach a launch; it is exactly what
   * DEFAULT_RUN_TYPE_MODEL_FLOORS exists to prevent). Unset/blank ⇒ the
   * per-kind floor (Opus for a workflow key), i.e. unchanged.
   *
   * Keyed on the selected workflow (`selectedId` is null until the list loads,
   * hence the '' key), so switching flows re-seeds every control to the NEW
   * flow's defaults and the prior flow's values never leak — and each flow keeps
   * its own per-control touched flag.
   *
   * The workflow runtime default rides the resolver's SUBSTRATE rung, NOT its
   * `agentRuntime` rung — the same rung-ordering rule `handleQuickSession` and
   * the wizard follow. `substrate` resolves `stored ?? implied ?? global ??
   * floor`, so a stored substrate outranks the global one; `agentRuntime`
   * resolves `stored ?? global` with NO stored-substrate rung above it. Feeding
   * a synthesized runtime into that rung therefore produced a self-contradictory
   * pair from the opposite side: a `workflow:<id>` entry carrying only
   * `{ substrate: 'interactive' }` came back as `agentRuntime: 'claude-sdk'`
   * (synthetic global) + `substrate: 'interactive'` (stored), and `runtimeSeed`
   * below then seeded the picker to a runtime the launch would not use.
   *
   * The one thing that DOES belong on the `agentRuntime` rung is the user's
   * genuine global runtime (`config.defaultAgentRuntime`) — coerced for THIS
   * key's launch kind first: these seeds drive a WORKFLOW launch, so a global
   * `codex-pty` (quick-session-only) is dropped and the seed falls back to the
   * substrate rung, rather than seeding a runtime that would block Start Run.
   */
  const runTypeKey = workflowRunTypeKey(selectedId ?? '');
  const runTypeDefaults = useConfigStore((s) => s.config?.runTypeDefaults);
  const globalPermissionMode = useConfigStore((s) => s.config?.defaultAgentPermissionMode);
  // Normalized the same way main's configManager.getGlobalLaunchModel does it —
  // trimmed, blank ⇒ unset — so a hand-edited config.json cannot resolve
  // differently in the renderer than it does on the main side.
  const globalLaunchModel = useConfigStore((s) => s.config?.defaultLaunchModel)?.trim() || undefined;
  const globalAgentRuntime = useConfigStore((s) => s.config?.defaultAgentRuntime);
  // Workflow-scoped view of the global runtime (null ⇒ this surface's workflow
  // launches ignore it). A runtime no picker may offer (`codex-exec`, per
  // RUNTIME_CAPABILITIES) is outside LaunchAgentRuntime entirely.
  const offerableGlobalRuntime = launchRuntimeForPickers(globalAgentRuntime);
  const globalWorkflowRuntime =
    offerableGlobalRuntime !== undefined
      ? workflowRuntimeForLaunch(offerableGlobalRuntime)
      : null;
  const launchGlobals: RunTypeLaunchGlobals = {
    ...(globalLaunchModel !== undefined ? { model: globalLaunchModel } : {}),
    ...(globalPermissionMode !== undefined ? { permissionMode: globalPermissionMode } : {}),
    ...(globalWorkflowRuntime !== null ? { agentRuntime: globalWorkflowRuntime } : {}),
    substrate: substrateForRuntime(DEFAULT_SESSION_AGENT_RUNTIME),
  };
  const launchDefaults = resolveRunTypeLaunchDefaults(runTypeKey, runTypeDefaults, launchGlobals);
  // No stored session runtime — including a stored 'codex-exec', which is not a
  // launchable runtime on any picker (it is the headless exec runtime, never
  // offered here) — seeds from the RESOLVED substrate's owning runtime, so the
  // control always agrees with the transport the launch will use. With nothing
  // stored this is `DEFAULT_SESSION_AGENT_RUNTIME`, exactly as before.
  const runtimeSeed: LaunchAgentRuntime = isSessionAgentRuntime(launchDefaults.agentRuntime)
    ? launchDefaults.agentRuntime
    : claudeRuntimeFromSubstrate(launchDefaults.substrate);
  // The other two seeds, named so the "Save as default" dirty check below can
  // compare against EXACTLY what each control was seeded with. Comparing against
  // the raw resolver output field-by-field would be wrong for `agentRuntime` (it
  // resolves to `undefined` when nothing is stored, while the control always
  // holds a concrete runtime — a permanent false "dirty"), so every control's
  // comparison goes through the seed it was actually given.
  const modelSeed = launchDefaults.model;
  const permissionModeSeed = launchDefaults.permissionMode;

  /**
   * The per-run Claude model choice (Configure model dropdown). Threaded into
   * runs.start.mutate as `model` → workflow_runs.model (migration 037) for
   * workflow launches, and into useQuickSession.start for the Quick Session button.
   */
  const {
    value: model,
    setByUser: setModelByUser,
    reseed: reseedModel,
    isTouched: isModelTouched,
  } = useSeededSelection<string>({
    key: runTypeKey,
    seed: modelSeed,
    fallback: DEFAULT_WORKFLOW_MODEL,
  });

  /**
   * The per-run agent permission choice. Threaded into runs.start.mutate as
   * `permissionMode` (the AppRouter-inferred input). The seed already carries the
   * global default (the middle rung of the resolver ladder), so an untouched
   * picker still forwards exactly what the launch would otherwise inherit — and
   * a config fetch that resolves AFTER mount re-seeds it.
   */
  const {
    value: permissionMode,
    setByUser: setPermissionModeByUser,
    isTouched: isPermissionModeTouched,
  } = useSeededSelection<PermissionMode>({
    key: runTypeKey,
    seed: permissionModeSeed,
    fallback: DEFAULT_PERMISSION_MODE,
  });

  /**
   * The per-launch agent runtime choice. Claude runtimes project onto the legacy
   * substrate field (the substrate is DERIVED from the runtime at every launch
   * seam below — never resolved independently, which is how a stored
   * `claude-interactive` used to end up paired with an 'sdk' substrate). On this
   * mixed launch surface, Codex SDK can launch workflows or quick sessions;
   * Codex PTY is quick-session-only and disables Start Run.
   */
  const {
    value: agentRuntime,
    setByUser: setAgentRuntimeByUser,
    isTouched: isAgentRuntimeTouched,
  } = useSeededSelection<LaunchAgentRuntime>({
    key: runTypeKey,
    seed: runtimeSeed,
    fallback: DEFAULT_SESSION_AGENT_RUNTIME,
  });

  /**
   * Every Configure control is live from first mount, but `selectedId` is null
   * until workflows.list resolves — so a pick made in that window lands under the
   * transient `workflow:` key. useSeededSelection's touched map is per-key, so
   * once the real id arrives the new key looks UNTOUCHED and the user's choice is
   * silently re-seeded away. Park pre-load picks here and re-apply them under the
   * real key on the first settle; the ref is cleared immediately after, so every
   * later flow switch keeps normal per-key semantics.
   */
  const preLoadPicksRef = useRef<{
    model?: string;
    permissionMode?: PermissionMode;
    agentRuntime?: LaunchAgentRuntime;
  }>({});
  const handleModelChange = useCallback(
    (next: string) => {
      if (selectedId === null) preLoadPicksRef.current.model = next;
      setModelByUser(next);
    },
    [selectedId, setModelByUser],
  );
  const handlePermissionModeChange = useCallback(
    (next: PermissionMode) => {
      if (selectedId === null) preLoadPicksRef.current.permissionMode = next;
      setPermissionModeByUser(next);
    },
    [selectedId, setPermissionModeByUser],
  );
  const handleAgentRuntimeChange = useCallback(
    (next: LaunchAgentRuntime) => {
      if (selectedId === null) preLoadPicksRef.current.agentRuntime = next;
      setAgentRuntimeByUser(next);
    },
    [selectedId, setAgentRuntimeByUser],
  );
  useEffect(() => {
    if (selectedId === null) return;
    const pending = preLoadPicksRef.current;
    preLoadPicksRef.current = {};
    // Runs AFTER useSeededSelection's own key-change effects (the hooks are
    // declared earlier in this component), so these re-applications win over the
    // new key's seeds.
    if (pending.model !== undefined) setModelByUser(pending.model);
    if (pending.permissionMode !== undefined) setPermissionModeByUser(pending.permissionMode);
    if (pending.agentRuntime !== undefined) setAgentRuntimeByUser(pending.agentRuntime);
  }, [selectedId, setModelByUser, setPermissionModeByUser, setAgentRuntimeByUser]);
  // Runtime-family coercion: one provider's runtime cannot run another's model,
  // so flipping the runtime picker rewrites an incompatible selection.
  // This goes through `reseed`, NOT `setByUser`: it is a PROGRAMMATIC coercion,
  // and marking the model touched here would permanently freeze reactive
  // re-seeding for a control the user never actually touched (a mere
  // Claude→Codex→Claude round trip on the runtime picker would kill the stored
  // per-workflow default for the rest of the mount). The re-seed prefers the
  // stored default so that round trip survives intact — but ONLY when the stored
  // default itself belongs to the new provider: a stale cross-family entry (a
  // Codex id saved under a workflow key) must not be re-applied here, or the
  // coercion would hand a Claude runtime a Codex model and then no-op forever
  // (setValue with the same value bails out).
  //
  // "Belongs" is `normalizeAgentModelSelection`, the same shared family
  // predicates `createRun` normalizes the launch payload with — not a
  // Codex-vs-Claude pair of tests, which left an OMP runtime showing a Claude
  // alias the launch then silently dropped.
  const runtimeProvider: AgentProvider = providerForRuntime(agentRuntime);
  useEffect(() => {
    if (modelFitsProvider(runtimeProvider, model)) return;
    const seededModel = launchDefaults.model;
    reseedModel(
      modelFitsProvider(runtimeProvider, seededModel)
        ? seededModel
        : PROVIDER_MODEL_FLOOR[runtimeProvider],
    );
  }, [runtimeProvider, model, launchDefaults.model, reseedModel]);

  /**
   * The per-run A/B variant choice (migration 048, VariantSelector). Defaults to
   * 'rotation' — a no-op selection ({@link variantSelectionToStartInput} sends
   * neither `variantId` nor `baseline`) so a workflow with zero (or no eligible)
   * variants launches exactly as before. VariantSelector re-seeds this to the
   * architect-specified default once its list resolves; reset to 'rotation'
   * whenever the selected workflow changes so a stale variant id from a
   * PREVIOUS workflow selection is never sent to a different workflow's launch
   * (variant ids are workflow-scoped — the resolver rejects a foreign pin).
   */
  const [variantSelection, setVariantSelection] = useState<VariantSelection>({ mode: 'rotation' });

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

  // Launch pre-launch seed-prompt gate: the interview-driven super-planner
  // needs a free-text "what are you building?" answer before its first turn,
  // so "Start Run" opens this modal first; the trimmed answer is threaded
  // into runs.start.mutate({ seedPrompt }).
  const [launchPromptOpen, setLaunchPromptOpen] = useState(false);

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
   * Fire the actual runs.start mutation. `ideaSeed.ideaId` is the Planner's
   * single-select pre-launch seed idea (migration 017); `ideaSeed.ideaIds` is
   * its multi-select batch (IDEA-009) — mutually exclusive, both undefined for
   * Sprint (and any free Planner launch). `seedPrompt` is the Launch flow's
   * pre-launch free-text answer (LaunchPromptModal) — undefined for every
   * other flow. The synchronous in-flight latch flips HERE (at the real
   * mutate), NOT on modal open, so opening a gate picker/modal is freely
   * cancellable.
   */
  const launchRun = useCallback(
    async (
      workflowId: string,
      ideaSeed?: { ideaId?: string; ideaIds?: string[] },
      seedPrompt?: string,
    ): Promise<void> => {
      if (startInFlightRef.current) return;
      startInFlightRef.current = true;
      setError(null);
      setIsStarting(true);
      try {
        const workflowRuntime = workflowRuntimeForLaunch(agentRuntime);
        if (workflowRuntime === null) {
          throw new Error('Codex (CLI) is only available for quick sessions.');
        }
        const launchSubstrate = substrateForRuntime(workflowRuntime);
        // Ensure the run executes INSIDE a session (active one if selected, else
        // a freshly created session). The id is threaded into runs.start so the
        // run runs in that session's worktree, and used to nest the run under
        // the session in the store (setActiveRun's parentSessionId). forceNew
        // bypasses reuse for the PTY add-workflow flow (separate session).
        const sessionId = await ensureSessionForLaunch(projectId, {
          forceNew: forceNewSession,
          agentProvider: providerForRuntime(workflowRuntime),
          agentRuntime: workflowRuntime,
          agentModel: model,
        });
        const result = await trpc.cyboflow.runs.start.mutate({
          workflowId,
          projectId,
          ...(launchSubstrate ? { substrate: launchSubstrate } : {}),
          agentProvider: providerForRuntime(workflowRuntime),
          agentRuntime: workflowRuntime,
          sessionId,
          permissionMode,
          model,
          ...(ideaSeed?.ideaIds !== undefined
            ? { ideaIds: ideaSeed.ideaIds }
            : ideaSeed?.ideaId !== undefined
              ? { ideaId: ideaSeed.ideaId }
              : {}),
          ...(seedPrompt !== undefined ? { seedPrompt } : {}),
          ...variantSelectionToStartInput(variantSelection),
        });
        useCyboflowStore.getState().setActiveRun(result.runId, sessionId);
        trackEvent('workflow_run_started', {
          launch_surface: 'topbar',
          flow: flowOf(workflowId),
          ...(launchSubstrate ? { substrate: launchSubstrate } : {}),
          permission_mode: permissionMode,
        });
        notifyWorkflowRunStarted({ runId: result.runId, launchSurface: 'topbar' });
        onWorkflowStarted?.(result.runId);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to start run');
      } finally {
        setIsStarting(false);
        startInFlightRef.current = false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId, agentRuntime, permissionMode, model, variantSelection, onWorkflowStarted, forceNewSession, workflows],
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
        const workflowRuntime = workflowRuntimeForLaunch(agentRuntime);
        if (workflowRuntime === null) {
          throw new Error('Codex (CLI) is only available for quick sessions.');
        }
        const launchSubstrate = substrateForRuntime(workflowRuntime);
        const sessionId = await ensureSessionForLaunch(projectId, {
          forceNew: forceNewSession,
          agentProvider: providerForRuntime(workflowRuntime),
          agentRuntime: workflowRuntime,
          agentModel: model,
        });
        const result = await trpc.cyboflow.runs.start.mutate({
          workflowId,
          projectId,
          ...(launchSubstrate ? { substrate: launchSubstrate } : {}),
          agentProvider: providerForRuntime(workflowRuntime),
          agentRuntime: workflowRuntime,
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
          ...(launchSubstrate ? { substrate: launchSubstrate } : {}),
          permission_mode: permissionMode,
        });
        notifyWorkflowRunStarted({ runId: result.runId, launchSurface: 'topbar' });
        onWorkflowStarted?.(result.runId);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to start sprint run');
      } finally {
        setIsStarting(false);
        startInFlightRef.current = false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId, agentRuntime, permissionMode, model, variantSelection, onWorkflowStarted, forceNewSession, workflows],
  );

  const handleStartRun = async () => {
    if (selectedId === null || startInFlightRef.current) return;
    // Planner is gated behind the idea picker, Sprint behind the batch picker,
    // Launch behind the seed-prompt modal. Workflow `name` is the lowercase
    // CyboflowWorkflowName seeded by WorkflowRegistry — compare to 'planner' /
    // 'sprint' / 'launch'. Ship (planner ⊕ sprint in one run) is IDEA-seeded
    // like the planner, so it shares the idea gate.
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
    if (selected?.name === 'launch') {
      setError(null);
      setLaunchPromptOpen(true);
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
    (ideaIds: string[], opts?: { separateIdeaIds: string[] }): void => {
      setIdeaPickerOpen(false);
      if (selectedId === null) return;
      const workflowId = selectedId;
      void (async () => {
        // A 1-element batch and a single-idea launch are behaviorally identical
        // downstream, but the singular `ideaId` path is the well-trodden one —
        // normalize down to it rather than sending a 1-element `ideaIds` array.
        if (ideaIds.length === 1) {
          await launchRun(workflowId, { ideaId: ideaIds[0] });
        } else if (ideaIds.length > 1) {
          await launchRun(workflowId, { ideaIds });
        }
        // "Plan separately" picks (planner multi-select only, IDEA-009): fire one
        // additional single-idea planner launch per peeled idea, sequentially,
        // after the batch launch. Safe here — launchRun's in-flight latch resets
        // unconditionally in its `finally`, and this surface never navigates away.
        for (const id of opts?.separateIdeaIds ?? []) {
          await launchRun(workflowId, { ideaId: id });
        }
      })();
    },
    [selectedId, launchRun],
  );

  const handleLaunchPromptSubmit = useCallback(
    (seedPrompt: string): void => {
      setLaunchPromptOpen(false);
      if (selectedId === null) return;
      void launchRun(selectedId, undefined, seedPrompt);
    },
    [selectedId, launchRun],
  );

  const handleQuickSession = useCallback(() => {
    // Shared-control ambiguity, resolved the same way for EVERY control: this
    // panel has ONE control set driving TWO run types, and the controls key to
    // `workflow:<selectedId>`. A TOUCHED control is a real per-launch choice and
    // is forwarded verbatim; an UNTOUCHED one is re-resolved for THIS launch
    // against the synthetic 'quick' key through the same canonical resolver the
    // dedicated quick-session seams use (read imperatively via getState(),
    // consistent with useQuickSession.startWithDefaults). With nothing stored
    // under 'quick' that ladder lands exactly where this surface landed before:
    // the global permission default, and the quick-session substrate preference
    // projected onto a Claude runtime.
    //
    // The quick-session substrate preference rides the resolver's SUBSTRATE rung
    // ONLY — never also as a synthesized `agentRuntime` global. `agentRuntime` is
    // the rung that makes a runtime OWN its substrate, so injecting a runtime
    // derived from the global preference outranked a stored substrate that
    // carried no runtime of its own (reachable from Settings: pick a substrate,
    // then set Agent runtime back to "Follow defaults"). `resolved.substrate` is
    // now taken verbatim rather than re-derived from the runtime, so this seam
    // and `useQuickSession.startWithDefaults` resolve the SAME transport.
    //
    // The user's GENUINE global runtime does ride the `agentRuntime` rung — and
    // this is a QUICK launch, so the whole SessionAgentRuntime set is accepted
    // (including `codex-pty`, which the workflow seeds above drop). Only
    // 'codex-exec' is filtered, matching useQuickSession.startWithDefaults.
    const quickDefaults = resolveRunTypeLaunchDefaults(
      QUICK_RUN_TYPE_KEY,
      useConfigStore.getState().config?.runTypeDefaults,
      {
        // Unread today — the launch model comes from the `model` control below,
        // whose own seed already carries this same global rung — but passed so
        // the quick ladder resolved here is the one a quick launch really uses.
        ...(globalLaunchModel !== undefined ? { model: globalLaunchModel } : {}),
        ...(globalPermissionMode !== undefined ? { permissionMode: globalPermissionMode } : {}),
        ...(isSessionAgentRuntime(globalAgentRuntime) ? { agentRuntime: globalAgentRuntime } : {}),
        substrate: quickDefaultSubstrate,
      },
    );
    // With no stored runtime the launch runtime follows the RESOLVED substrate,
    // so the pair is consistent by construction (and, with nothing stored at all,
    // identical to the old `quickDefaultSubstrate`-derived value).
    const quickDefaultRuntime: LaunchAgentRuntime = isSessionAgentRuntime(
      quickDefaults.agentRuntime,
    )
      ? quickDefaults.agentRuntime
      : claudeRuntimeFromSubstrate(quickDefaults.substrate);
    const effectiveRuntime: LaunchAgentRuntime = isAgentRuntimeTouched
      ? agentRuntime
      : quickDefaultRuntime;
    const quickPermissionMode = isPermissionModeTouched
      ? permissionMode
      : quickDefaults.permissionMode;
    const sessionRuntime = quickSessionRuntimeForLaunch(effectiveRuntime);
    // A TOUCHED runtime pick is a real per-launch choice and owns its transport;
    // a NON-CLAUDE runtime has no Claude substrate to send at all (it names its
    // own transport in the runtime id). Otherwise the resolver's answer is
    // authoritative.
    const quickProvider = providerForRuntime(sessionRuntime);
    const quickSubstrate =
      isAgentRuntimeTouched || quickProvider !== 'claude'
        ? substrateForRuntime(sessionRuntime)
        : quickDefaults.substrate;
    // The model follows the same touched/untouched rule, with one extra guard.
    //
    // The family guard is load-bearing: the 'quick' default is stored without
    // regard to this launch's runtime, so an untouched non-Claude-runtime quick
    // session could otherwise be handed a Claude model (and vice versa). When
    // the stored value is incompatible we fall back to the live control value —
    // which must itself be family-checked against THIS launch's runtime, not
    // trusted as-is.
    //
    // That fallback is the panel's single, WORKFLOW-keyed model control, and the
    // runtime-coercion effect above only keeps it in step with the WORKFLOW
    // runtime picker. An UNTOUCHED runtime resolves the 'quick' key separately
    // (a stored `quick.agentRuntime`, or a global `defaultAgentRuntime`), so the
    // two can legitimately disagree — and a Claude-seeded control handed to a
    // non-Claude quick session is exactly the combination no launch can honour.
    // That provider's floor is used instead, matching what the effect would have
    // done had the runtime picker itself been flipped.
    const fallbackModel = modelFitsProvider(quickProvider, model)
      ? model
      : PROVIDER_MODEL_FLOOR[quickProvider];
    const storedQuickModel = useConfigStore.getState().config?.runTypeDefaults?.quick?.model;
    const quickModel =
      isModelTouched || storedQuickModel === undefined
        ? fallbackModel
        : modelFitsProvider(quickProvider, storedQuickModel)
          ? storedQuickModel
          : fallbackModel;
    void startQuickSession(
      quickPermissionMode,
      quickSubstrate,
      undefined,
      quickModel,
      undefined,
      undefined,
      undefined,
      undefined,
      providerForRuntime(sessionRuntime),
      sessionRuntime,
    );
  }, [
    agentRuntime,
    isAgentRuntimeTouched,
    model,
    isModelTouched,
    permissionMode,
    isPermissionModeTouched,
    globalPermissionMode,
    globalLaunchModel,
    globalAgentRuntime,
    startQuickSession,
    quickDefaultSubstrate,
  ]);

  const selectedWorkflowTitle = workflowTitleForName(
    workflows.find((wf) => wf.id === selectedId)?.name ?? '',
  );

  /**
   * "Save as default" — persist the Configure knobs as the stored default for
   * the SELECTED workflow's key. Independent of launching in BOTH directions:
   * this never starts a run, and Start Run never writes a default. It must never
   * touch the live launch controls, so the in-flight launch payload is identical
   * before and after a save. (The store's post-write fetchConfig does refresh
   * `runTypeDefaults`, which feeds useSeededSelection's seed — harmless, since
   * the value just stored IS the live value.)
   */
  const {
    save: saveDefault,
    undo: undoSaveDefault,
    canUndo: canUndoSaveDefault,
    isSaving: isSavingDefault,
    toast: saveToast,
    dismissToast: dismissSaveToast,
  } = useSaveRunTypeDefault({
    key: selectedId === null ? null : workflowRunTypeKey(selectedId),
    label: selectedWorkflowTitle,
  });

  const handleSaveDefault = useCallback(() => {
    saveDefault({
      model,
      permissionMode,
      agentRuntime,
      // `?? null` (delete), NOT undefined (leave untouched): a Codex runtime has
      // no substrate projection, and leaving a previously-stored Claude
      // substrate behind would pair a stale 'sdk'/'interactive' with a Codex
      // agentRuntime in the same entry.
      substrate: substrateForRuntime(agentRuntime) ?? null,
      // Variant is deliberately NOT captured: the selection resets on every
      // workflow change and VariantSelector re-seeds it, and a variant row can
      // be deleted with no referential integrity from config — a stored pin
      // would ride runs.start as an explicit (possibly dangling) choice.
    });
  }, [saveDefault, model, permissionMode, agentRuntime]);

  /**
   * Whether the Configure controls currently differ from what they were SEEDED
   * with — the sole visibility condition for the save CTA (there is nothing to
   * save while the screen already shows the stored default).
   *
   * Compared against the seeds, never against `isTouched`: `setByUser` latches on
   * ANY user pick, including one that sets a control straight back to the value
   * it already held, which would strand the CTA on screen with nothing to write.
   * Seed-comparison instead makes the affordance self-correcting — reverting a
   * change hides it again, a successful save re-seeds the controls to the values
   * just stored (so it hides itself), and an Undo re-seeds them back (so it
   * returns).
   *
   * The compared set is exactly the set `handleSaveDefault` writes, minus
   * `substrate` (derived from the runtime, so the runtime comparison covers it).
   * `reasoningEffort` is quick-key-only and this surface has no effort control.
   */
  const isSaveDefaultDirty =
    model !== modelSeed ||
    permissionMode !== permissionModeSeed ||
    agentRuntime !== runtimeSeed;

  const combinedError = error ?? quickError;
  const workflowRuntimeBlocked = workflowRuntimeForLaunch(agentRuntime) === null;
  const selectedSubstrate = substrateForRuntime(agentRuntime);
  const selectedProvider = providerForRuntime(agentRuntime);

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

      {/* Agent runtime selector + interactive v1 caveats (IDEA-013 / TASK-812). */}
      <SubstrateSelector
        value={agentRuntime}
        // A real per-launch choice — after this the Quick Session button uses the
        // explicit runtime's substrate instead of the quick-session default, and
        // the control stops re-seeding from the stored per-workflow default.
        onChange={handleAgentRuntimeChange}
        id="workflow-picker-substrate"
        caveatsTestId="workflow-picker-substrate-caveats"
        runtimeScope="mixed"
      />

      {/* Session permission selector — an explicit choice permanently sets the
          host session's mode (the sole execution authority), affecting later chat
          and later flows in that session; the launch still stamps the audit-only
          permission_mode_snapshot. Omitted → the session mode is left untouched. */}
      <AgentPermissionModeSelector
        value={permissionMode}
        onChange={handlePermissionModeChange}
        agentProvider={selectedProvider}
        agentRuntime={agentRuntime}
      />

      {/* Per-run model selector — pins the model a workflow run (or quick session)
          spawns with (default Opus). Workflow: threaded into runs.start as `model`
          → workflow_runs.model (migration 037). Quick: into useQuickSession. */}
      <ModelSelector
        value={model}
        onChange={handleModelChange}
        id="workflow-picker-model"
        agentProvider={selectedProvider}
        agentRuntime={agentRuntime}
      />
      {/* Per-run A/B variant selector (migration 048) — hidden entirely for a
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
          disabled={selectedId === null || isLoading || isStarting || isQuickStarting || workflowRuntimeBlocked}
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

      {/* Offered ONLY once the controls diverge from their seeds (see
          isSaveDefaultDirty): with the screen already showing the stored default
          there is nothing to write, so the affordance stays out of the way. Sits
          BELOW the primary "Start Run" row so the reading order matches the
          priority — launching is the point of this panel, saving a default is
          the aside. */}
      {selectedId !== null && isSaveDefaultDirty && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          fullWidth
          onClick={handleSaveDefault}
          disabled={isSavingDefault}
          data-testid="workflow-picker-save-default"
        >
          Save as default for {selectedWorkflowTitle}
        </Button>
      )}

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
          // Multi-select batch (IDEA-009) is a Planner-only affordance — Ship
          // stays single-select (it consumes exactly one idea per run).
          multi={workflows.find((wf) => wf.id === selectedId)?.name === 'planner'}
        />
      )}

      {batchPickerOpen && (
        <TaskBatchPickerModal
          isOpen
          projectId={projectId}
          substrate={selectedSubstrate ?? DEFAULT_SUBSTRATE}
          onClose={() => setBatchPickerOpen(false)}
          onPicked={handleBatchPicked}
        />
      )}

      {launchPromptOpen && (
        <LaunchPromptModal
          open
          onCancel={() => setLaunchPromptOpen(false)}
          onSubmit={handleLaunchPromptSubmit}
        />
      )}

      <div className="mt-2 flex flex-col gap-2 border-t border-border-primary pt-3">
        <p className="text-xs text-text-secondary">Or start without a workflow:</p>
        <button
          onClick={handleQuickSession}
          disabled={isQuickStarting || isStarting}
          className="rounded-button border border-interactive bg-bg-primary px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="quick-session-button"
        >
          Quick Session
        </button>
      </div>

      {/* Save-as-default outcome. Undo is offered ONLY for a write the store
          confirmed landed — a failure toast carries no Undo, because replaying
          it would delete a default the failed write never overwrote. */}
      {saveToast !== null && (
        <div
          className="fixed bottom-4 right-4 z-50"
          data-testid="workflow-picker-save-toast"
          data-tone={saveToast.tone}
        >
          <SessionActionToast
            message={saveToast.message}
            isVisible
            onDismiss={dismissSaveToast}
            durationMs={SAVE_DEFAULT_TOAST_MS}
            tone={saveToast.tone}
            {...(canUndoSaveDefault ? { actionLabel: 'Undo', onAction: undoSaveDefault } : {})}
          />
        </div>
      )}
    </div>
  );
}
