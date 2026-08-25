/**
 * ABTestLaunchModal — thin side-by-side A/B experiment launcher (Slice B).
 *
 * Collects variant A + variant B for each arm. Each arm is either one of the
 * workflow's pickable variants (the SAME active+draft set VariantSelector offers,
 * reusing {@link pickableVariants} from variantSelectorLogic) OR the "Current
 * workflow (baseline)" sentinel ({@link BASELINE_VARIANT_SENTINEL}) — so a
 * workflow with a SINGLE variant can be tested head-to-head against the live
 * workflow (the primary use case; one variant seeds A=baseline, B=variant).
 * A !== B is enforced with a disabled submit button + an inline hint (both arms
 * cannot be the baseline).
 *
 * SEED, by workflow kind:
 *   - The task-driven `sprint` workflow REQUIRES seed tasks: an inline multi-select
 *     task checklist (SAME data source + eligibility filter as TaskBatchPickerModal
 *     — approved + Ready-for-dev-or-later, non-terminal, not archived; experiment-
 *     tagged rows are already hidden server-side) submits `seedTaskIds`. Each arm
 *     clones the selection so the normal sprint machinery runs in the sandbox. At
 *     least one task is required (a task-less sprint arm is meaningless).
 *   - Every OTHER workflow keeps the OPTIONAL seed idea (via the shared
 *     {@link IdeaPickerModal}), submitting `seedIdeaId`.
 *
 * On success: navigates straight to arm A's session/run (mirrors
 * SessionStartWizard's launch → setActiveRun → setActiveProjectId → goToSession
 * path) after bootstrapping arm A's renderer panels via
 * {@link bootstrapArmSessionPanels} — the arm session was created server-side
 * WITHOUT panels, unlike `sessions:create-quick`. Arm B stays headless; slice
 * C's compare view is where it surfaces.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '../ui/Modal';
import { trpc } from '../../trpc/client';
import { useWorkflowVariants } from '../../stores/variantsStore';
import { pickableVariants } from './variantSelectorLogic';
import { BASELINE_VARIANT_SENTINEL, QUICK_ARM_SENTINEL } from '../../../../shared/types/experiments';
import { resolveSprintMaxTasks } from '../../../../shared/types/sprintBatch';
import { useConfigStore } from '../../stores/configStore';
import type { BacklogTaskItem, Board } from '../../../../shared/types/tasks';
import type { PermissionMode } from '../../../../shared/types/workflows';
import { effortLevelsForProvider, type ReasoningEffort } from '../../../../shared/types/reasoningEffort';
import type { WorkflowAgentRuntime } from '../../../../shared/types/agentRuntime';
import type { EpicTaskGroup } from './taskGrouping';
import { flattenGroups, groupTasksByEpic } from './taskGrouping';
import { EpicGroupedTaskList } from './EpicGroupedTaskList';
import { IdeaPickerModal } from './IdeaPickerModal';
import { bootstrapArmSessionPanels } from '../../utils/bootstrapArmSessionPanels';
import { useCyboflowStore } from '../../stores/cyboflowStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { SubstrateSelector } from './SubstrateSelector';
import { ModelSelector, DEFAULT_QUICK_MODEL, DEFAULT_CODEX_MODEL } from './ModelSelector';
import { AgentPermissionModeSelector } from './AgentPermissionModeSelector';
import { providerForRuntime, type LaunchAgentRuntime } from './agentRuntimeUi';
import type { AgentProvider, WorkflowRunStorableRuntime } from '../../../../shared/types/agentRuntime';
import { runtimeSupportsEffort } from '../../../../shared/types/agentCapabilities';

/**
 * Per-arm quick-session config, local to the modal. Mirrors the subset of the
 * backend's `ExperimentArmQuickConfig` wire shape a user can pin from this modal
 * (substrate/agentProvider are DERIVED from `runtime`, not stored separately).
 */
interface ArmQuickConfig {
  runtime: WorkflowAgentRuntime;
  model: string;
  reasoningEffort: ReasoningEffort | null;
  permissionMode: PermissionMode;
}

const DEFAULT_QUICK_ARM_CONFIG: ArmQuickConfig = {
  runtime: 'claude-sdk',
  model: DEFAULT_QUICK_MODEL,
  reasoningEffort: null,
  permissionMode: 'default',
};

/**
 * The modal's `ArmQuickConfig.runtime` is the workflow-LAUNCHABLE set — it
 * excludes `codex-pty`/`omp-pty` (PTY transport, unreachable for a quick arm)
 * and `omp-fleet` (v1 offers the fleet supervisor as a quick-session runtime
 * only, never to A/B arms); the wire schema's `agentRuntime` enum is the wider
 * STORABLE set (see the router's `experimentArmQuickConfigSchema`).
 * `QuickArmConfigForm`'s `SubstrateSelector` uses `runtimeScope="workflow"`,
 * so the disabled options can never be picked through the UI; this clamps
 * anyway — each PTY transport to its provider's SDK equivalent, `omp-fleet`
 * to the `claude-sdk` launch default — as defense-in-depth and to satisfy the
 * narrower type.
 */
function quickArmAgentRuntime(runtime: LaunchAgentRuntime): WorkflowAgentRuntime {
  if (runtime === 'codex-pty') return 'codex-sdk';
  if (runtime === 'omp-pty') return 'omp-sdk';
  if (runtime === 'omp-fleet') return 'claude-sdk';
  return runtime;
}

function substrateForQuickArm(runtime: WorkflowAgentRuntime): 'sdk' | 'interactive' | undefined {
  if (runtime === 'claude-sdk') return 'sdk';
  if (runtime === 'claude-interactive') return 'interactive';
  return undefined;
}

/**
 * The model an arm resets to when its runtime crosses into `provider`.
 * Exhaustive over `AgentProvider`, so a provider added to the union cannot ship
 * without someone choosing its reset value.
 *
 * `''` for OMP means NO PIN: unlike Codex's `'auto'` sentinel, OMP advertises no
 * "let the runtime pick" row — its catalogue is concrete `provider/model` ids —
 * and {@link buildQuickConfigPayload} omits the wire field entirely for it, so
 * the arm launches on the runtime's own default.
 */
const QUICK_ARM_MODEL_RESET: Readonly<Record<AgentProvider, string>> = {
  claude: DEFAULT_QUICK_MODEL,
  codex: DEFAULT_CODEX_MODEL,
  omp: '',
};

/**
 * Fold a runtime change into an arm's quick config. When the change crosses the
 * PROVIDER boundary, reset `model` + `reasoningEffort` to the new provider's
 * defaults: the model catalogs and effort scales (Claude low..max vs Codex
 * none..xhigh vs OMP's own) are disjoint, so carrying the prior provider's
 * selection across would submit an invalid cross-provider value (e.g.
 * `opus`/`max` into a Codex arm). A same-provider runtime flip (claude-sdk ↔
 * claude-interactive) keeps the model/effort — the catalog + scale are
 * identical. Mirrors SessionStartWizard's reset-on-provider-transition
 * behaviour.
 */
function applyQuickArmRuntimeChange(
  config: ArmQuickConfig,
  runtime: LaunchAgentRuntime,
): ArmQuickConfig {
  const armRuntime = quickArmAgentRuntime(runtime);
  if (armRuntime === config.runtime) return config;
  if (providerForRuntime(armRuntime) === providerForRuntime(config.runtime)) {
    return { ...config, runtime: armRuntime };
  }
  return {
    ...config,
    runtime: armRuntime,
    model: QUICK_ARM_MODEL_RESET[providerForRuntime(armRuntime)],
    reasoningEffort: null,
  };
}

/** One arm's quick-session config sub-form — reused for A and B. */
function QuickArmConfigForm({
  arm,
  config,
  onChange,
}: {
  arm: 'a' | 'b';
  config: ArmQuickConfig;
  onChange: (config: ArmQuickConfig) => void;
}): React.JSX.Element {
  const provider = providerForRuntime(config.runtime);
  const testIdPrefix = `ab-test-quick-config-${arm}`;
  return (
    <div
      data-testid={testIdPrefix}
      className="flex flex-col gap-2 rounded-button border border-dashed border-border-primary p-2"
    >
      <span className="text-xs font-semibold text-text-primary">Quick session config</span>
      <SubstrateSelector
        value={config.runtime}
        onChange={(runtime) => onChange(applyQuickArmRuntimeChange(config, runtime))}
        id={`${testIdPrefix}-runtime`}
        runtimeScope="workflow"
      />
      <ModelSelector
        value={config.model}
        onChange={(model) => onChange({ ...config, model })}
        id={`${testIdPrefix}-model`}
        agentProvider={provider}
        agentRuntime={config.runtime}
      />
      {/* Reasoning-effort select — excluded for a runtime that drops the flag
          (RUNTIME_CAPABILITIES.supportsEffort; mirrors SessionStartWizard), moot
          here since the runtime choice above already disables every effort-less
          runtime for a quick arm. */}
      {runtimeSupportsEffort(config.runtime) && (
        <div className="flex flex-col gap-1">
          <label
            htmlFor={`${testIdPrefix}-effort`}
            className="text-xs font-medium text-text-secondary"
          >
            Reasoning effort
          </label>
          <select
            id={`${testIdPrefix}-effort`}
            value={config.reasoningEffort ?? ''}
            onChange={(e) =>
              onChange({
                ...config,
                reasoningEffort: e.target.value === '' ? null : (e.target.value as ReasoningEffort),
              })
            }
            className="w-full rounded-input border border-border-primary bg-bg-primary px-2 py-1 text-sm text-input-text"
            aria-label={`Select reasoning effort for arm ${arm.toUpperCase()}`}
            data-testid={`${testIdPrefix}-effort`}
          >
            <option value="">Default</option>
            {effortLevelsForProvider(provider).map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </div>
      )}
      <AgentPermissionModeSelector
        value={config.permissionMode}
        onChange={(permissionMode) => onChange({ ...config, permissionMode })}
        agentProvider={provider}
        agentRuntime={config.runtime}
        label="Permission mode"
      />
    </div>
  );
}

export interface ABTestLaunchModalProps {
  isOpen: boolean;
  /**
   * The default launch project. For a GLOBAL flow (e.g. the built-in `sprint`)
   * the caller can only guess a project, so the modal renders a project picker
   * (when {@link projects} has >1 entry) letting the user pick the project whose
   * backlog the seed tasks/ideas come from. The picked project is threaded into
   * both the seed query and the experiment submit.
   */
  projectId: number;
  /**
   * All selectable projects (id + name). When more than one is supplied the
   * modal shows a project picker seeded to {@link projectId}; with 0–1 it stays
   * hidden and the modal uses {@link projectId} directly.
   */
  projects?: { id: number; name: string }[];
  workflowId: string;
  /**
   * The workflow's built-in name. `sprint` is the only task-driven flow (v1): it
   * swaps the seed-idea picker for the required seed-task multi-select.
   */
  workflowName: string;
  onClose: () => void;
}

export function ABTestLaunchModal({
  isOpen,
  projectId,
  projects,
  workflowId,
  workflowName,
  onClose,
}: ABTestLaunchModalProps): React.JSX.Element {
  const isSprint = workflowName === 'sprint';
  /**
   * The A/B seed-task cap. The experiment defaults to the 'sdk' substrate (the
   * modal has no substrate picker), so the cap is the sdk rung of the user's
   * Settings override layered over the built-in default — the SAME value
   * startExperiment enforces server-side; the picker disables checkboxes past it
   * (defense in depth).
   */
  const sprintMaxTasks = useConfigStore((state) => state.config?.sprintMaxTasks);
  const seedTaskCap = resolveSprintMaxTasks(sprintMaxTasks, 'sdk');
  // The project whose backlog seeds this experiment. Defaults to the caller's
  // `projectId` (for a GLOBAL flow, a guess); a >1-project picker lets the user
  // correct it. The modal unmounts on close, so this re-initialises per open.
  const [selectedProjectId, setSelectedProjectId] = useState<number>(projectId);
  const showProjectPicker = (projects?.length ?? 0) > 1;
  const { variants, loaded } = useWorkflowVariants(workflowId);
  const options = pickableVariants(variants);

  const [variantAId, setVariantAId] = useState<string>('');
  const [variantBId, setVariantBId] = useState<string>('');
  // Per-arm quick-session config, only read/sent when that arm is the
  // `__quick__` sentinel. Kept even when the arm switches away so a user's
  // in-progress config isn't lost if they flip back.
  const [quickConfigA, setQuickConfigA] = useState<ArmQuickConfig>(DEFAULT_QUICK_ARM_CONFIG);
  const [quickConfigB, setQuickConfigB] = useState<ArmQuickConfig>(DEFAULT_QUICK_ARM_CONFIG);
  const [seedIdeaId, setSeedIdeaId] = useState<string | null>(null);
  const [seedIdeaLabel, setSeedIdeaLabel] = useState<string | null>(null);
  const [ideaPickerOpen, setIdeaPickerOpen] = useState(false);
  // Sprint seed-task multi-select (mirrors TaskBatchPickerModal's data + filter),
  // grouped by parent epic for rendering. The flat eligible list is derived.
  const [seedGroups, setSeedGroups] = useState<EpicTaskGroup[]>([]);
  const seedTasks = useMemo(() => flattenGroups(seedGroups), [seedGroups]);
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set());
  const [tasksLoading, setTasksLoading] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startInFlightRef = useRef(false);

  // One-shot default seeding per workflow: once the variant list resolves, seed a
  // valid arm pair (mirrors VariantSelector's seeding effect) so an untouched modal
  // is ready to submit. With EXACTLY one pickable variant — the primary use case —
  // seed arm A = the current workflow (baseline) and arm B = that variant, so a
  // one-variant workflow can be tested head-to-head against the live workflow. With
  // >=2 variants, seed the first two distinct variants. Guarded per-workflowId so it
  // re-seeds for a newly targeted workflow without ever overwriting a later choice.
  const seededForWorkflowId = useRef<string | null>(null);
  useEffect(() => {
    if (!isOpen || !loaded) return;
    if (seededForWorkflowId.current === workflowId) return;
    seededForWorkflowId.current = workflowId;
    if (options.length === 0) {
      // No variants at all: the only valid pairs involve the quick sentinel
      // (baseline-vs-quick / quick-vs-quick), so seed the former — the modal is
      // still submit-ready without a single variant row.
      setVariantAId(BASELINE_VARIANT_SENTINEL);
      setVariantBId(QUICK_ARM_SENTINEL);
    } else if (options.length === 1) {
      setVariantAId(BASELINE_VARIANT_SENTINEL);
      setVariantBId(options[0].id);
    } else {
      setVariantAId(options[0]?.id ?? '');
      setVariantBId(options[1]?.id ?? '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, loaded, workflowId]);

  // Sprint seed-task load (only for the task-driven sprint workflow). Loads the
  // project's tasks + boards and keeps ONLY the sprint-eligible ones, EXACTLY as
  // TaskBatchPickerModal + the runs.start pre-check do: type==='task', approved
  // (approved_at !== null), NOT archived, at a ready-or-later NON-terminal stage
  // (stage_position >= 6 && the stage is not terminal). Experiment-tagged clones
  // are already excluded server-side by the backlog list.
  useEffect(() => {
    if (!isOpen || !isSprint) return;
    let cancelled = false;
    setTasksLoading(true);
    setError(null);
    Promise.all([
      trpc.cyboflow.tasks.list.query({ projectId: selectedProjectId }),
      trpc.cyboflow.tasks.boardsForProject.query({ projectId: selectedProjectId }),
    ])
      .then(([rows, boards]) => {
        if (cancelled) return;
        const terminalStageIds = new Set<string>(
          boards.flatMap((b: Board) => b.stages.filter((s) => s.is_terminal).map((s) => s.id)),
        );
        // Tasks with a parent epic are nested under the epic's `children`; group
        // by epic (retaining the association) and keep ONLY sprint-eligible tasks.
        const isEligible = (r: BacklogTaskItem): boolean =>
          r.type === 'task' &&
          r.approved_at !== null &&
          r.archived_at === null &&
          r.stage_position >= 6 &&
          !terminalStageIds.has(r.stage_id);
        const groups = groupTasksByEpic(rows, isEligible);
        setSeedGroups(groups);
        // Prune any prior selection to what's still eligible + not in-flight.
        const eligibleSet = new Set(
          flattenGroups(groups)
            .filter((t) => t.inFlow.length === 0)
            .map((t) => t.id),
        );
        setSelectedTaskIds((prev) => new Set(Array.from(prev).filter((id) => eligibleSet.has(id))));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load tasks');
      })
      .finally(() => {
        if (!cancelled) setTasksLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, isSprint, selectedProjectId]);

  const reset = (): void => {
    setSeedIdeaId(null);
    setSeedIdeaLabel(null);
    setSelectedTaskIds(new Set());
    setError(null);
    setIsStarting(false);
    seededForWorkflowId.current = null;
  };

  // Eligible (selectable) seed tasks: not already in-flight in another run.
  const selectableTasks = useMemo(() => seedTasks.filter((t) => t.inFlow.length === 0), [seedTasks]);
  const atTaskCap = selectedTaskIds.size >= seedTaskCap;

  const toggleTask = (taskId: string): void => {
    setSelectedTaskIds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else if (next.size < seedTaskCap) next.add(taskId);
      return next;
    });
  };

  const selectAllTasks = (): void => {
    setSelectedTaskIds(new Set(selectableTasks.slice(0, seedTaskCap).map((t) => t.id)));
  };

  // Select/deselect a whole epic group's tasks, honoring the seed-task cap.
  const toggleSeedGroup = (taskIds: string[], select: boolean): void => {
    setSelectedTaskIds((prev) => {
      const next = new Set(prev);
      if (!select) {
        taskIds.forEach((id) => next.delete(id));
        return next;
      }
      for (const id of taskIds) {
        if (next.size >= seedTaskCap) break;
        next.add(id);
      }
      return next;
    });
  };

  // One seed-task row — preserves the modal's own markup + test ids while the
  // shared list owns the epic-group chrome around it.
  const renderSeedTaskRow = (t: BacklogTaskItem): React.ReactNode => {
    const inFlight = t.inFlow.length > 0;
    const checked = selectedTaskIds.has(t.id);
    const disabled = inFlight || (!checked && atTaskCap);
    return (
      <label
        data-testid={`ab-test-seed-task-item-${t.id}`}
        className={`flex items-start gap-2 rounded-button border px-2 py-1.5 text-sm ${
          disabled
            ? 'cursor-not-allowed border-border-primary bg-bg-secondary opacity-60'
            : 'cursor-pointer border-border-primary bg-bg-primary hover:bg-bg-hover'
        }`}
      >
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={() => toggleTask(t.id)}
          aria-label={`Select ${t.ref}`}
          className="mt-0.5"
        />
        <span className="flex flex-1 items-center gap-2">
          <span className="font-medium text-text-primary">{t.ref}</span>
          <span className="truncate text-text-secondary">{t.title}</span>
          {inFlight && (
            <span className="rounded-full bg-bg-tertiary px-1.5 py-0.5 text-[10px] font-medium text-text-tertiary">
              in flight
            </span>
          )}
        </span>
      </label>
    );
  };

  const handleClose = (): void => {
    if (isStarting) return;
    reset();
    onClose();
  };

  // Switching the project invalidates any prior seed selection (task ids + seed
  // idea belong to the previous project's backlog); the seed-task effect reloads
  // for the new project on the next tick.
  const handleProjectChange = (nextProjectId: number): void => {
    if (nextProjectId === selectedProjectId) return;
    setSelectedProjectId(nextProjectId);
    setSelectedTaskIds(new Set());
    setSeedGroups([]);
    setSeedIdeaId(null);
    setSeedIdeaLabel(null);
  };

  const handleIdeaPicked = (ideaIds: string[]): void => {
    const ideaId = ideaIds[0];
    setIdeaPickerOpen(false);
    setSeedIdeaId(ideaId);
    setSeedIdeaLabel(ideaId);
    // Best-effort friendly label — falls back to the raw id if the lookup fails.
    void trpc.cyboflow.tasks.get
      .query({ taskId: ideaId })
      .then((row) => {
        if (row) setSeedIdeaLabel(`${row.ref} — ${row.title}`);
      })
      .catch(() => {});
  };

  // A sprint experiment additionally REQUIRES >=1 seed task (a task-less sprint arm
  // has nothing to run); every other workflow's seed idea stays optional. A===B is
  // blocked UNLESS the shared value is the quick sentinel — two independently
  // configured quick sessions are a valid (quick-vs-quick) head-to-head.
  const sameVariantChosen =
    variantAId !== '' && variantAId === variantBId && variantAId !== QUICK_ARM_SENTINEL;
  const canSubmit =
    variantAId !== '' &&
    variantBId !== '' &&
    !sameVariantChosen &&
    !isStarting &&
    (!isSprint || selectedTaskIds.size > 0);

  const buildQuickConfigPayload = (config: ArmQuickConfig): {
    substrate?: 'sdk' | 'interactive';
    agentProvider: AgentProvider;
    agentRuntime: WorkflowRunStorableRuntime;
    model?: string;
    reasoningEffort?: ReasoningEffort;
    permissionMode: PermissionMode;
  } => {
    const substrate = substrateForQuickArm(config.runtime);
    return {
      ...(substrate ? { substrate } : {}),
      agentProvider: providerForRuntime(config.runtime),
      agentRuntime: quickArmAgentRuntime(config.runtime),
      // OMITTED when empty — "no pin", the reset value for a provider with no
      // "let the runtime pick" sentinel. The wire schema takes `model` as
      // `.min(1).optional()`, so sending `''` would fail validation where
      // sending nothing correctly means the runtime default.
      ...(config.model !== '' ? { model: config.model } : {}),
      ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
      permissionMode: config.permissionMode,
    };
  };

  const handleStart = async (): Promise<void> => {
    if (!canSubmit || startInFlightRef.current) return;
    startInFlightRef.current = true;
    setIsStarting(true);
    setError(null);
    try {
      const aIsQuick = variantAId === QUICK_ARM_SENTINEL;
      const bIsQuick = variantBId === QUICK_ARM_SENTINEL;
      const result = await trpc.cyboflow.experiments.startSideBySide.mutate({
        projectId: selectedProjectId,
        workflowId,
        variantAId,
        variantBId,
        ...(isSprint
          ? { seedTaskIds: Array.from(selectedTaskIds) }
          : seedIdeaId !== null
            ? { seedIdeaId }
            : {}),
        ...(aIsQuick ? { quickConfigA: buildQuickConfigPayload(quickConfigA) } : {}),
        ...(bIsQuick ? { quickConfigB: buildQuickConfigPayload(quickConfigB) } : {}),
      });

      // Navigate to whichever arm is the quick one when exactly one is quick;
      // arm A otherwise (quick-vs-quick and the non-quick default both land on A).
      const targetArm = bIsQuick && !aIsQuick ? result.armB : result.armA;
      // By that selection rule the target is a quick arm exactly when ANY arm is.
      const targetIsQuick = aIsQuick || bIsQuick;

      // Bootstrap the target arm's panels (server created the session headless),
      // then navigate straight to it.
      await bootstrapArmSessionPanels(targetArm.sessionId);
      if (targetIsQuick) {
        // A quick arm is a CHAT session, not a workflow run: its runId is the
        // `__quick__` sentinel, which resolves no workflow (activeRunsStore
        // drops it and workflows.list excludes it) — setActiveRun would render
        // the workflow-only pane with a disabled composer. Route through the
        // quick-session host instead (activeRunId stays null, chat composer live).
        useCyboflowStore.getState().setActiveQuickSession(targetArm.sessionId, targetArm.runId);
      } else {
        useCyboflowStore.getState().setActiveRun(targetArm.runId, targetArm.sessionId);
      }
      useNavigationStore.getState().setActiveProjectId(selectedProjectId);
      useNavigationStore.getState().goToSession();

      reset();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to start the A/B experiment');
    } finally {
      setIsStarting(false);
      startInFlightRef.current = false;
    }
  };

  // No variant rows exist. NOT a blocker: baseline-vs-quick and quick-vs-quick
  // are valid server-side, so the pickers still render — this only gates an
  // informational hint about creating variants.
  const noVariants = loaded && options.length < 1;

  return (
    <Modal isOpen={isOpen} onClose={handleClose} size="md">
      <ModalHeader>Run an A/B test</ModalHeader>
      <ModalBody>
        <div className="flex flex-col gap-3">
          {showProjectPicker && (
            <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
              Project
              <select
                value={selectedProjectId}
                onChange={(e) => handleProjectChange(Number(e.target.value))}
                className="rounded-input border border-border-primary bg-input-bg px-2 py-1.5 text-sm text-input-text"
                aria-label="Select project"
                data-testid="ab-test-project"
              >
                {projects?.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          {!loaded && <p className="text-xs text-text-secondary">Loading variants…</p>}

          {noVariants && (
            <p className="text-xs text-text-secondary" data-testid="ab-test-insufficient-variants">
              This workflow has no variants yet — you can still compare the current
              workflow (baseline) against a quick session, or two quick sessions.
              Create a variant from the Workflows editor to test workflow-spec
              changes head-to-head.
            </p>
          )}

          {loaded && (
            <>
              <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
                Variant A
                <select
                  value={variantAId}
                  onChange={(e) => setVariantAId(e.target.value)}
                  className="rounded-input border border-border-primary bg-input-bg px-2 py-1.5 text-sm text-input-text"
                  aria-label="Select variant A"
                  data-testid="ab-test-variant-a"
                >
                  <option value={BASELINE_VARIANT_SENTINEL}>Current workflow (baseline)</option>
                  {options.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.status === 'draft' ? `${v.label} (draft)` : v.label}
                    </option>
                  ))}
                  <option value={QUICK_ARM_SENTINEL}>Quick session</option>
                </select>
              </label>
              {variantAId === QUICK_ARM_SENTINEL && (
                <QuickArmConfigForm arm="a" config={quickConfigA} onChange={setQuickConfigA} />
              )}
              <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
                Variant B
                <select
                  value={variantBId}
                  onChange={(e) => setVariantBId(e.target.value)}
                  className="rounded-input border border-border-primary bg-input-bg px-2 py-1.5 text-sm text-input-text"
                  aria-label="Select variant B"
                  data-testid="ab-test-variant-b"
                >
                  <option value={BASELINE_VARIANT_SENTINEL}>Current workflow (baseline)</option>
                  {options.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.status === 'draft' ? `${v.label} (draft)` : v.label}
                    </option>
                  ))}
                  <option value={QUICK_ARM_SENTINEL}>Quick session</option>
                </select>
              </label>
              {variantBId === QUICK_ARM_SENTINEL && (
                <QuickArmConfigForm arm="b" config={quickConfigB} onChange={setQuickConfigB} />
              )}
              {sameVariantChosen && (
                <p
                  className="text-xs text-status-error"
                  role="alert"
                  data-testid="ab-test-same-variant-hint"
                >
                  Pick two different variants to compare.
                </p>
              )}

              {isSprint ? (
                <div
                  className="flex flex-col gap-1.5 border-t border-dashed border-border-primary pt-3"
                  data-testid="ab-test-seed-tasks"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-text-secondary">
                      Seed tasks (required) · selected{' '}
                      <span className="font-semibold text-text-primary">{selectedTaskIds.size}</span>/{seedTaskCap}
                    </span>
                    <button
                      type="button"
                      onClick={selectAllTasks}
                      disabled={selectableTasks.length === 0}
                      data-testid="ab-test-select-all-tasks"
                      className="rounded-button border border-border-primary bg-bg-primary px-2 py-1 text-xs font-medium text-text-primary hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Select all eligible
                    </button>
                  </div>
                  <p className="text-xs text-text-tertiary">
                    Each arm runs a private copy of the selected tasks; the winner's
                    outcome folds back onto your originals.
                  </p>
                  {tasksLoading && <p className="text-xs text-text-secondary">Loading tasks…</p>}
                  {!tasksLoading && seedTasks.length === 0 && (
                    <p className="text-xs text-text-secondary" data-testid="ab-test-no-seed-tasks">
                      No sprint-eligible tasks. Each task must be approved and at "Ready for
                      development" or later (not archived, done, or won't-do).
                    </p>
                  )}
                  {!tasksLoading && seedTasks.length > 0 && (
                    <EpicGroupedTaskList
                      groups={seedGroups}
                      selectedIds={selectedTaskIds}
                      isSelectable={(t) => t.inFlow.length === 0}
                      onToggleGroup={toggleSeedGroup}
                      renderTask={renderSeedTaskRow}
                      testIdPrefix="ab-test-seed-task"
                    />
                  )}
                  {!tasksLoading && seedTasks.length > 0 && selectedTaskIds.size === 0 && (
                    <p className="text-xs text-status-error" role="alert" data-testid="ab-test-seed-task-required-hint">
                      Select at least one task to compare.
                    </p>
                  )}
                </div>
              ) : (
                <div className="flex flex-col gap-1.5 border-t border-dashed border-border-primary pt-3">
                  <span className="text-xs font-medium text-text-secondary">Seed idea (optional)</span>
                  {seedIdeaId === null ? (
                    <button
                      type="button"
                      onClick={() => setIdeaPickerOpen(true)}
                      data-testid="ab-test-add-seed-idea"
                      className="self-start rounded-button border border-border-primary bg-bg-primary px-2.5 py-1 text-xs font-medium text-text-primary hover:bg-bg-hover"
                    >
                      Add a seed idea
                    </button>
                  ) : (
                    <div className="flex items-center gap-2 text-xs text-text-secondary">
                      <span className="truncate" data-testid="ab-test-seed-idea-label">
                        {seedIdeaLabel}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setSeedIdeaId(null);
                          setSeedIdeaLabel(null);
                        }}
                        data-testid="ab-test-clear-seed-idea"
                        className="text-text-tertiary underline hover:text-text-primary"
                      >
                        Remove
                      </button>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {error && (
            <p className="text-xs text-status-error" role="alert">
              {error}
            </p>
          )}
        </div>
      </ModalBody>
      <ModalFooter>
        <button
          type="button"
          onClick={handleClose}
          disabled={isStarting}
          className="rounded-button border border-border-primary bg-bg-primary px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void handleStart()}
          disabled={!canSubmit}
          data-testid="ab-test-submit"
          className="rounded-button bg-interactive px-3 py-1.5 text-sm font-medium text-text-on-interactive hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isStarting ? 'Starting…' : 'Start A/B test'}
        </button>
      </ModalFooter>

      {ideaPickerOpen && (
        <IdeaPickerModal
          isOpen
          projectId={selectedProjectId}
          onClose={() => setIdeaPickerOpen(false)}
          onPicked={handleIdeaPicked}
        />
      )}
    </Modal>
  );
}
