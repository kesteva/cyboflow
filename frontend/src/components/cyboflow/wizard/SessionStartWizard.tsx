/**
 * SessionStartWizard — the center-pane "Start a new session" index-card wizard.
 *
 * Three steps (① Project · ② Workflow · ③ Configure), switched on
 * `wizardOpts.lockProjectId`:
 *   - UNLOCKED (no lockProjectId): ① pick a project from a grid of
 *     {@link ProjectFilingCard}s (+ an "Add project" card), ② pick a workflow
 *     (or the featured {@link QuickSessionCard}), then ③ configure session
 *     settings and launch.
 *   - LOCKED (lockProjectId set): the project is pinned; the wizard opens
 *     directly on ② Workflow. When `allowQuick` is set, the quick card is offered.
 *
 * Workflow preselect (`wizardOpts.preselectWorkflowName`): the Insights "Run
 * compounding session" CTA opens the wizard with an explicit workflow name (e.g.
 * `'compound'`). When the workflow list loads, the matching flow is preselected
 * BY NAME and the wizard auto-advances ② → ③ EXACTLY ONCE (latched by
 * `preselectConsumedRef`) so the caller lands directly on the launch surface
 * without fighting later list reloads or user back-navigation. In unlocked mode
 * the advance naturally fires once the user picks a project (loadWorkflows runs
 * on step ②). This is distinct from the implicit DEFAULT_WORKFLOW_NAME preselect,
 * which only sets selection state and NEVER auto-advances.
 *
 * Step ③ (Configure) is the launch surface and adapts to the selection:
 *   - workflow: agent-permission override + CLI substrate (+ caveats) + workflow
 *     blueprint editor access + a launch summary.
 *   - quick: agent-permission override + CLI substrate (+ caveats) + launch
 *     summary (there is no workflow to edit, so the blueprint editor is omitted).
 *
 * Launch paths (all fire from step ③):
 *   - workflow: `trpc.cyboflow.runs.start.mutate` (threading substrate +
 *     permissionMode) → setActiveRun → goToSession. The Planner ('planner') is
 *     gated behind {@link IdeaPickerModal}; the chosen idea id is threaded as
 *     runs.start.mutate({ ideaId }).
 *   - sprint: gated behind {@link TaskBatchPickerModal} — a sprint is ONE
 *     session-hosted run seeded with the multi-selected task ids (single-run
 *     lane model; the orchestrator agent fans the tasks out as subagents in the
 *     shared session worktree), so it follows the same runs.start → setActiveRun
 *     → goToSession path with `taskIds` threaded.
 *   - quick: the {@link useQuickSession} hook — it creates the session + panels
 *     (passing the chosen agentPermissionMode + substrate) and calls
 *     setActiveQuickSession itself.
 *
 * A synchronous in-flight latch (`startInFlightRef`) guards every launch against
 * the double-submit duplicate-run bug (mirrors WorkflowPicker).
 *
 * The whole surface is monospace, mostly square-cornered, on a faint graph-paper
 * grid; UI labels are UPPERCASE wide-tracked.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '../../../../../shared/types/trpc';
import { trpc } from '../../../trpc/client';
import { API } from '../../../utils/api';
import type { Project } from '../../../types/project';
import { useNavigationStore } from '../../../stores/navigationStore';
import { useCyboflowStore } from '../../../stores/cyboflowStore';
import { useQuickSession } from '../../../hooks/useQuickSession';
import { useAgentPermissionMode } from '../../../hooks/useAgentPermissionMode';
import { ensureSessionForLaunch } from '../../../utils/ensureSessionForLaunch';
import { IdeaPickerModal } from '../IdeaPickerModal';
import { TaskBatchPickerModal } from '../TaskBatchPickerModal';
import { CreateProjectDialog } from '../../CreateProjectDialog';
import { AgentPermissionModeSelector, PERMISSION_MODE_OPTIONS } from '../AgentPermissionModeSelector';
import { SubstrateSelector } from '../SubstrateSelector';
import { WorkflowEditorModal } from '../WorkflowEditorModal';
import { WizardStepHeader } from './WizardStepHeader';
import type { WizardStep } from './WizardStepHeader';
import { ProjectFilingCard } from './ProjectFilingCard';
import { WorkflowListRow } from './WorkflowListRow';
import { QuickSessionCard } from './QuickSessionCard';
import { buildWorkflowMeta, DEFAULT_WORKFLOW_NAME } from './workflowMeta';
import type { WorkflowCardMeta } from './workflowMeta';
import { type CliSubstrate, DEFAULT_SUBSTRATE } from '../../../../../shared/types/substrate';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RouterOutputs = inferRouterOutputs<AppRouter>;
/** The result of `cyboflow.runs.start` — inferred, never a local mirror. */
type RunStartResult = RouterOutputs['cyboflow']['runs']['start'];

/**
 * What the user has chosen on the workflow step. `null` until a row (or the
 * quick card) is selected. The union is explicit so the CTA + launch dispatch
 * narrow exhaustively.
 */
type WizardSelection =
  | { kind: 'workflow'; workflowId: string }
  | { kind: 'quick' };

/** The faint graph-paper grid backing the wizard surface. */
const GRID_BG_STYLE: React.CSSProperties = {
  backgroundImage:
    'linear-gradient(to right, #d8cfb8 1px, transparent 1px), linear-gradient(to bottom, #d8cfb8 1px, transparent 1px)',
  backgroundSize: '24px 24px',
};

/** The dashed "add project" tile fill cue. */
function AddProjectCard({ onClick }: { onClick: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="wizard-add-project"
      className="flex min-h-[96px] items-center justify-center border border-dashed border-border-emphasized bg-surface-secondary text-text-secondary transition-colors hover:border-interactive hover:text-interactive"
    >
      <span className="eyebrow">＋ Add project</span>
    </button>
  );
}

/** A label/value row in the step-③ launch summary. */
function SummaryRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="eyebrow text-text-muted">{label}</span>
      <span className="truncate font-mono text-xs text-text-primary" title={value}>
        {value}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function SessionStartWizard(): React.JSX.Element {
  const opts = useNavigationStore((s) => s.wizardOpts);
  const locked = opts?.lockProjectId != null;
  // Quick session is offered whenever the caller opts in — in BOTH locked mode
  // (rail "+ NEW FLOW", pinned project) and the unlocked center-pane flow (home /
  // review-queue "Start a new session"), where the card appears in step 2 once a
  // project is chosen. Not tied to `locked`, so the unlocked path can offer it.
  const allowQuick = opts?.allowQuick === true;

  // Step state. Locked mode opens on ② Workflow (project pinned); unlocked opens
  // on ① Project. ③ Configure is the shared launch step.
  const [step, setStep] = useState<WizardStep>(locked ? 2 : 1);

  // ── Project step (unlocked) ──────────────────────────────────────────────
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  // The active project: pinned (locked) or chosen on step 1 (unlocked).
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(
    locked ? (opts?.lockProjectId ?? null) : null,
  );

  // ── Workflow step ────────────────────────────────────────────────────────
  const [workflowMetas, setWorkflowMetas] = useState<WorkflowCardMeta[]>([]);
  const [workflowsLoading, setWorkflowsLoading] = useState(false);
  const [workflowsError, setWorkflowsError] = useState<string | null>(null);
  const [selection, setSelection] = useState<WizardSelection | null>(null);

  // ── Step ③ Configure ─────────────────────────────────────────────────────
  // Per-run/per-session agent permission (seeded from the global default, race-
  // guarded by the shared hook) + per-launch CLI substrate. Substrate is
  // threaded into runs.start for workflow launches and into useQuickSession
  // (→ sessions.substrate) for quick launches.
  const { mode: permissionMode, setMode: setPermissionMode } = useAgentPermissionMode();
  const [substrate, setSubstrate] = useState<CliSubstrate>(DEFAULT_SUBSTRATE);
  // Blueprint editor (workflow path only) — 'edit' (selected flow) or 'create'.
  const [editorMode, setEditorMode] = useState<'edit' | 'create' | null>(null);

  // Planner pre-launch idea gate.
  const [ideaPickerOpen, setIdeaPickerOpen] = useState(false);
  const [pendingWorkflowId, setPendingWorkflowId] = useState<string | null>(null);

  // Sprint pre-launch task-batch gate. A sprint run is seeded with the
  // multi-selected task ids (single-run lane model), so its launch goes through
  // the batch picker → runs.start({ taskIds }), mirroring the Planner idea gate.
  const [batchPickerOpen, setBatchPickerOpen] = useState(false);

  // Launch state.
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [isLaunching, setIsLaunching] = useState(false);
  const startInFlightRef = useRef(false);

  // One-shot latch for the explicit `preselectWorkflowName` auto-advance. Set
  // the moment the preselect resolves and drives ② → ③ once, so later
  // loadWorkflows reruns (e.g. blueprint-editor saves) and user back-navigation
  // (handleBackToWorkflow / handleChangeProject) are never fought back.
  const preselectConsumedRef = useRef(false);

  // Bottom-center slide-up toast.
  const [toast, setToast] = useState<string | null>(null);

  // The currently-active project banner. In locked mode `projects` is empty, so
  // the hook fetches name/path/branch itself. Declared BEFORE useQuickSession so
  // the success toast can read the resolved project name.
  const banner = useActiveProjectBanner(selectedProjectId, projects);

  // ── Quick session hook (bound to the locked project) ─────────────────────
  // Constructed unconditionally at top level (rules of hooks); only USED when
  // allowQuick. setActiveQuickSession is performed inside the hook.
  const {
    start: startQuickSession,
    isStarting: isQuickStarting,
    error: quickError,
  } = useQuickSession({
    projectId: allowQuick ? selectedProjectId : null,
    onSuccess: () => {
      setToast(`Starting quick session on ${banner.name}`);
      useNavigationStore.getState().goToSession();
    },
  });

  // Auto-dismiss the launch toast (it normally outlives this component only
  // briefly, since the launch handlers navigate away — but if the wizard stays
  // mounted the toast must clear itself).
  useEffect(() => {
    if (toast === null) return;
    const timer = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(timer);
  }, [toast]);

  // ── Load projects on the project step (unlocked) ─────────────────────────
  useEffect(() => {
    if (locked) return;
    setProjectsLoading(true);
    setProjectsError(null);
    void API.projects
      .getAll()
      .then((res) => {
        if (res.success && Array.isArray(res.data)) {
          setProjects(res.data as Project[]);
        } else {
          setProjectsError(res.error ?? 'Failed to load projects');
        }
      })
      .catch((err: unknown) => {
        setProjectsError(err instanceof Error ? err.message : 'Failed to load projects');
      })
      .finally(() => {
        setProjectsLoading(false);
      });
  }, [locked]);

  // ── Load workflows + runs once a project is active ───────────────────────
  // Refactored out of the mount effect into a callable so the blueprint editor
  // (step ③) can re-invoke it after saving a new/edited flow. `preferId` selects
  // a just-saved flow; otherwise the current pick is preserved or the default is
  // chosen.
  const loadWorkflows = useCallback(
    (preferId?: string): Promise<void> => {
      if (selectedProjectId === null) return Promise.resolve();
      const projectId = selectedProjectId;
      setWorkflowsLoading(true);
      setWorkflowsError(null);
      return Promise.all([
        trpc.cyboflow.workflows.list.query({ projectId }),
        trpc.cyboflow.runs.list.query({ projectId }),
      ])
        .then(([rows, runs]) => {
          const metas = buildWorkflowMeta(rows, runs);
          setWorkflowMetas(metas);
          // Resolve the explicit `preselectWorkflowName` target up-front (no side
          // effects inside the setSelection updater). It only takes effect when a
          // matching flow exists AND it has not already been consumed — the
          // one-shot latch keeps later reruns / back-navigation from re-forcing it.
          const preselectName = opts?.preselectWorkflowName;
          const preselectTarget =
            preselectName !== undefined && !preselectConsumedRef.current
              ? metas.find((m) => m.name === preselectName) ?? null
              : null;
          // Selection priority: a just-saved flow (preferId, editor save) >
          // the existing pick > the EXPLICIT name preselect > the default flow.
          setSelection((prev) => {
            if (preferId && metas.some((m) => m.id === preferId)) {
              return { kind: 'workflow', workflowId: preferId };
            }
            if (prev !== null) return prev;
            if (preselectTarget !== null) {
              return { kind: 'workflow', workflowId: preselectTarget.id };
            }
            const def = metas.find((m) => m.name === DEFAULT_WORKFLOW_NAME);
            return def ? { kind: 'workflow', workflowId: def.id } : null;
          });
          // Auto-advance ② → ③ EXACTLY ONCE when the explicit preselect resolved.
          // Latched so a later loadWorkflows rerun or user back-nav is not fought.
          // (The implicit DEFAULT_WORKFLOW_NAME preselect above is selection-only —
          // it never advances; see the WorkflowListRow onSelect comment.)
          if (preselectTarget !== null) {
            preselectConsumedRef.current = true;
            setStep((s) => (s === 2 ? 3 : s));
          }
        })
        .catch((err: unknown) => {
          setWorkflowsError(err instanceof Error ? err.message : 'Failed to load workflows');
        })
        .finally(() => {
          setWorkflowsLoading(false);
        });
    },
    [selectedProjectId, opts?.preselectWorkflowName],
  );

  useEffect(() => {
    void loadWorkflows();
  }, [loadWorkflows]);

  // ── Navigation handlers ──────────────────────────────────────────────────
  const handleBackToQueue = useCallback(() => {
    useNavigationStore.getState().goHome();
  }, []);

  const handleChangeProject = useCallback(() => {
    setStep(1);
    setSelectedProjectId(null);
    setSelection(null);
    setWorkflowMetas([]);
  }, []);

  const handleBackToWorkflow = useCallback(() => {
    setStep(2);
  }, []);

  const handleSelectProject = useCallback((projectId: number) => {
    setSelectedProjectId(projectId);
    setSelection(null);
    setStep(2);
  }, []);

  const handleEditorSaved = useCallback(
    (savedId: string) => {
      setEditorMode(null);
      void loadWorkflows(savedId);
    },
    [loadWorkflows],
  );

  const handleProjectCreated = useCallback((project: Project) => {
    setCreateOpen(false);
    useNavigationStore.getState().goToWizard({ lockProjectId: project.id, allowQuick: true });
  }, []);

  // ── Launch ───────────────────────────────────────────────────────────────
  const launchRun = useCallback(
    async (workflowId: string, ideaId?: string): Promise<void> => {
      if (startInFlightRef.current) return;
      if (selectedProjectId === null) return;
      startInFlightRef.current = true;
      setLaunchError(null);
      setIsLaunching(true);
      try {
        // Ensure the run executes INSIDE a session (the active one if selected,
        // else a freshly created session) — mirrors WorkflowPicker / the backlog
        // launcher. Without this the wizard took the legacy PARENTLESS path
        // (workflow_runs.session_id null), leaving the run with no session to bind
        // the close-out (Merge / PR / Dismiss) or the File Explorer / Diff to.
        const sessionId = await ensureSessionForLaunch(selectedProjectId);
        const result: RunStartResult = await trpc.cyboflow.runs.start.mutate(
          ideaId === undefined
            ? { workflowId, projectId: selectedProjectId, sessionId, substrate, permissionMode }
            : { workflowId, projectId: selectedProjectId, sessionId, substrate, permissionMode, ideaId },
        );
        // Nest the run under its session so the close-out + panels resolve
        // (setActiveRun's parentSessionId sets selectedSessionId).
        useCyboflowStore.getState().setActiveRun(result.runId, sessionId);
        useNavigationStore.getState().setActiveProjectId(selectedProjectId);

        const meta = workflowMetas.find((m) => m.id === workflowId);
        const slash = meta?.slashCommand ?? '/workflow';
        setToast(`Launching ${slash} on ${banner.name} ⌥ ${result.branchName}`);

        useNavigationStore.getState().goToSession();
      } catch (err: unknown) {
        setLaunchError(err instanceof Error ? err.message : 'Failed to start run');
        startInFlightRef.current = false;
      } finally {
        setIsLaunching(false);
      }
    },
    [selectedProjectId, workflowMetas, banner.name, substrate, permissionMode],
  );

  // Sprint launch — ONE session-hosted run seeded with the multi-selected task
  // ids (single-run lane model). Follows launchRun exactly
  // (ensureSessionForLaunch → runs.start → setActiveRun → goToSession);
  // `taskIds` makes the launcher create the lane batch and stamp
  // workflow_runs.batch_id, and per-task progress renders as lanes in the run
  // progress rail. Mirrors WorkflowPicker.launchBatch.
  const launchBatch = useCallback(
    async (workflowId: string, taskIds: string[]): Promise<void> => {
      if (startInFlightRef.current) return;
      if (selectedProjectId === null) return;
      startInFlightRef.current = true;
      setLaunchError(null);
      setIsLaunching(true);
      try {
        const sessionId = await ensureSessionForLaunch(selectedProjectId);
        const result: RunStartResult = await trpc.cyboflow.runs.start.mutate({
          workflowId,
          projectId: selectedProjectId,
          sessionId,
          substrate,
          permissionMode,
          taskIds,
        });
        useCyboflowStore.getState().setActiveRun(result.runId, sessionId);
        useNavigationStore.getState().setActiveProjectId(selectedProjectId);

        const meta = workflowMetas.find((m) => m.id === workflowId);
        const slash = meta?.slashCommand ?? '/sprint';
        setToast(`Launching ${slash} (${taskIds.length} tasks) on ${banner.name} ⌥ ${result.branchName}`);

        useNavigationStore.getState().goToSession();
      } catch (err: unknown) {
        setLaunchError(err instanceof Error ? err.message : 'Failed to start sprint run');
        startInFlightRef.current = false;
      } finally {
        setIsLaunching(false);
      }
    },
    [selectedProjectId, workflowMetas, banner.name, substrate, permissionMode],
  );

  const handleStart = useCallback(() => {
    if (selection === null || startInFlightRef.current) return;

    if (selection.kind === 'quick') {
      void startQuickSession(permissionMode, substrate);
      return;
    }

    // selection.kind === 'workflow'
    const meta = workflowMetas.find((m) => m.id === selection.workflowId);
    if (meta?.name === 'planner') {
      // Gate behind the idea picker — do NOT flip the latch yet.
      setLaunchError(null);
      setPendingWorkflowId(selection.workflowId);
      setIdeaPickerOpen(true);
      return;
    }
    if (meta?.name === 'sprint') {
      // Gate behind the task batch picker — a sprint launches ONE session-hosted
      // run seeded with the picked task ids. Do NOT flip the latch yet (opening
      // the picker stays freely cancellable).
      setLaunchError(null);
      setBatchPickerOpen(true);
      return;
    }
    void launchRun(selection.workflowId);
  }, [selection, workflowMetas, startQuickSession, launchRun, permissionMode, substrate]);

  const handleIdeaPicked = useCallback(
    (ideaId: string) => {
      setIdeaPickerOpen(false);
      if (pendingWorkflowId === null) return;
      void launchRun(pendingWorkflowId, ideaId);
    },
    [pendingWorkflowId, launchRun],
  );

  const handleBatchPicked = useCallback(
    (taskIds: string[]) => {
      setBatchPickerOpen(false);
      if (taskIds.length === 0) return;
      // The sprint workflow id is the current selection (handleStart resolved it
      // before opening the picker, and the modal blocks re-selection meanwhile).
      if (selection?.kind !== 'workflow') return;
      void launchBatch(selection.workflowId, taskIds);
    },
    [selection, launchBatch],
  );

  // ── CTA label / disabled ─────────────────────────────────────────────────
  const ctaBusy = isLaunching || isQuickStarting;
  const selectedMeta =
    selection?.kind === 'workflow'
      ? workflowMetas.find((m) => m.id === selection.workflowId)
      : undefined;
  let ctaLabel: string;
  if (selection === null) {
    ctaLabel = 'Select a workflow';
  } else if (selection.kind === 'quick') {
    ctaLabel = 'Start quick session';
  } else {
    ctaLabel = `Run ${selectedMeta?.slashCommand ?? '/workflow'}`;
  }

  // Human-readable agent-permission label for the launch summary.
  const permissionLabel =
    PERMISSION_MODE_OPTIONS.find((o) => o.id === permissionMode)?.label ?? permissionMode;

  const combinedError = launchError ?? quickError;

  // Selected-project banner card — shared by the workflow step (②) and the
  // configure step (③).
  const projectBannerCard = (
    <div className="flex flex-col gap-1 border border-border-emphasized bg-surface-primary p-3">
      <div className="flex items-center gap-2">
        <span aria-hidden="true">📁</span>
        <span
          className="truncate text-text-primary"
          style={{ fontSize: '14px', fontWeight: 700 }}
        >
          {banner.name}
        </span>
        <span className="ml-auto truncate font-mono text-xs text-status-success">
          ⌥ {banner.branch ?? '—'}
        </span>
      </div>
      <span className="truncate font-mono text-xs text-text-secondary" title={banner.path ?? undefined}>
        {banner.path ?? '—'}
      </span>
    </div>
  );

  return (
    <div className="relative h-full w-full overflow-y-auto" style={GRID_BG_STYLE}>
      <div className="mx-auto flex max-w-[720px] flex-col gap-4 px-6 py-8">
        <WizardStepHeader
          locked={locked}
          step={step}
          onBackToQueue={handleBackToQueue}
          onChangeProject={handleChangeProject}
          onBackToWorkflow={handleBackToWorkflow}
        />

        {/* ── Step 1: project grid (unlocked only) ── */}
        {!locked && step === 1 && (
          <div className="flex flex-col gap-3">
            <span className="eyebrow text-text-secondary">Choose a project</span>
            {projectsLoading && (
              <p className="text-xs text-text-secondary">Loading projects…</p>
            )}
            {projectsError !== null && (
              <p className="text-xs text-status-error" role="alert">
                {projectsError}
              </p>
            )}
            <div className="grid grid-cols-2 gap-3">
              {projects.map((project) => (
                <ProjectFilingCard
                  key={project.id}
                  project={project}
                  selected={selectedProjectId === project.id}
                  onSelect={() => handleSelectProject(project.id)}
                />
              ))}
              <AddProjectCard onClick={() => setCreateOpen(true)} />
            </div>
          </div>
        )}

        {/* ── Step 2: workflow list ── */}
        {step === 2 && selectedProjectId !== null && (
          <div className="flex flex-col gap-4 pb-24">
            {projectBannerCard}

            {/* Quick session (featured, allowQuick only) */}
            {allowQuick && (
              <>
                <QuickSessionCard
                  selected={selection?.kind === 'quick'}
                  onSelect={() => {
                    setSelection({ kind: 'quick' });
                    setStep(3);
                  }}
                />
                <div className="flex items-center gap-3" aria-hidden="true">
                  <span className="h-px flex-1 border-t border-dashed border-border-primary" />
                  <span className="eyebrow text-text-muted">or run a workflow</span>
                  <span className="h-px flex-1 border-t border-dashed border-border-primary" />
                </div>
              </>
            )}

            {/* Workflow list */}
            {workflowsLoading && (
              <p className="text-xs text-text-secondary">Loading workflows…</p>
            )}
            {workflowsError !== null && (
              <p className="text-xs text-status-error" role="alert">
                {workflowsError}
              </p>
            )}
            <div className="flex flex-col gap-2">
              {workflowMetas.map((meta) => (
                <WorkflowListRow
                  key={meta.id}
                  meta={meta}
                  selected={
                    selection?.kind === 'workflow' && selection.workflowId === meta.id
                  }
                  onSelect={() => {
                    // Selecting a workflow auto-advances to ③ Configure. The
                    // initial default pre-selection (in loadWorkflows) only sets
                    // state — it never calls setStep — so the wizard does NOT
                    // auto-jump on load; only a user click advances.
                    setSelection({ kind: 'workflow', workflowId: meta.id });
                    setStep(3);
                  }}
                />
              ))}
            </div>
          </div>
        )}

        {/* ── Step 3: configure session settings + launch ── */}
        {step === 3 && selectedProjectId !== null && selection !== null && (
          <div className="flex flex-col gap-4 pb-24" data-testid="wizard-step3">
            {projectBannerCard}

            {/* Agent permission — shown for BOTH workflow and quick launches. */}
            <AgentPermissionModeSelector value={permissionMode} onChange={setPermissionMode} />

            {/* CLI substrate — shown for BOTH workflow and quick launches
                (workflow: threaded into runs.start; quick: threaded into
                useQuickSession → sessions.substrate). */}
            <SubstrateSelector
              value={substrate}
              onChange={setSubstrate}
              id="wizard-substrate"
              caveatsTestId="wizard-substrate-caveats"
            />

            {/* Workflow-only control: blueprint-editor access (there is no
                workflow to edit for a quick session). */}
            {selection.kind === 'workflow' && (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setEditorMode('edit')}
                  data-testid="wizard-edit-flow"
                  className="flex-1 rounded-button border border-border-primary bg-bg-primary px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-bg-hover"
                >
                  Edit blueprint
                </button>
                <button
                  type="button"
                  onClick={() => setEditorMode('create')}
                  data-testid="wizard-new-flow"
                  className="flex-1 rounded-button border border-border-primary bg-bg-primary px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-bg-hover"
                >
                  New flow
                </button>
              </div>
            )}

            {/* Launch summary */}
            <div
              data-testid="wizard-launch-summary"
              className="flex flex-col gap-1.5 border border-border-primary bg-surface-secondary p-3"
            >
              <span className="eyebrow text-text-secondary">Launch summary</span>
              <SummaryRow label="Project" value={banner.name} />
              <SummaryRow label="Branch" value={banner.branch ?? '—'} />
              <SummaryRow
                label="Mode"
                value={
                  selection.kind === 'quick'
                    ? 'Quick session'
                    : selectedMeta?.slashCommand ?? '/workflow'
                }
              />
              <SummaryRow label="Permission" value={permissionLabel} />
              <SummaryRow
                label="Substrate"
                value={substrate === 'interactive' ? 'Interactive (PTY)' : 'SDK'}
              />
            </div>
          </div>
        )}
      </div>

      {/* ── Sticky launch CTA (configure step). Step ② auto-advances on
            selection, so it has no CTA of its own. ── */}
      {step === 3 && selectedProjectId !== null && (
        <div className="sticky bottom-0 left-0 right-0 border-t border-border-primary bg-bg-primary/95 px-6 py-3 backdrop-blur">
          <div className="mx-auto flex max-w-[720px] flex-col gap-2">
            {combinedError !== null && combinedError !== undefined && (
              <p className="text-xs text-status-error" role="alert">
                {combinedError}
              </p>
            )}
            <button
              type="button"
              onClick={handleStart}
              disabled={selection === null || ctaBusy}
              data-testid="wizard-cta"
              className="w-full bg-interactive px-4 py-2 text-sm font-medium text-text-on-interactive hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {ctaLabel}
            </button>
          </div>
        </div>
      )}

      {/* ── Bottom-center slide-up launch toast ── */}
      {toast !== null && (
        <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center">
          <div
            data-testid="wizard-launch-toast"
            className="animate-slideDown border border-border-emphasized px-4 py-2 font-mono text-sm text-text-on-interactive shadow-lg motion-reduce:animate-none"
            style={{ backgroundColor: '#1a1815' }}
          >
            {toast}
          </div>
        </div>
      )}

      {/* ── Planner idea gate ── */}
      {ideaPickerOpen && selectedProjectId !== null && (
        <IdeaPickerModal
          isOpen
          projectId={selectedProjectId}
          onClose={() => setIdeaPickerOpen(false)}
          onPicked={handleIdeaPicked}
        />
      )}

      {/* ── Sprint task-batch gate ── */}
      {batchPickerOpen && selectedProjectId !== null && (
        <TaskBatchPickerModal
          isOpen
          projectId={selectedProjectId}
          substrate={substrate}
          onClose={() => setBatchPickerOpen(false)}
          onPicked={handleBatchPicked}
        />
      )}

      {/* ── Add-project dialog ── */}
      {createOpen && (
        <CreateProjectDialog
          isOpen
          onClose={() => setCreateOpen(false)}
          onCreated={handleProjectCreated}
        />
      )}

      {/* ── Workflow blueprint editor (step ③, workflow path) ── */}
      {editorMode !== null && selectedProjectId !== null && selection?.kind === 'workflow' && (
        <WorkflowEditorModal
          isOpen
          mode={editorMode}
          workflowId={editorMode === 'edit' ? selection.workflowId : ''}
          projectId={selectedProjectId}
          onClose={() => setEditorMode(null)}
          onSaved={handleEditorSaved}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Banner helper — resolves name/path/branch for the selected-project banner.
// In locked mode `projects` is not loaded, so name/path come from a one-shot
// projects fetch and the branch from detectBranch.
// ---------------------------------------------------------------------------

interface ProjectBanner {
  name: string;
  path: string | null;
  branch: string | null;
}

function useActiveProjectBanner(
  projectId: number | null,
  loadedProjects: Project[],
): ProjectBanner {
  const [resolved, setResolved] = useState<Project | null>(null);
  const [branch, setBranch] = useState<string | null>(null);

  // Prefer an already-loaded project (unlocked flow); else fetch it once
  // (locked flow, where the project grid was never loaded).
  const fromLoaded =
    projectId === null ? null : loadedProjects.find((p) => p.id === projectId) ?? null;

  useEffect(() => {
    if (projectId === null) {
      setResolved(null);
      return;
    }
    if (fromLoaded !== null) {
      setResolved(fromLoaded);
      return;
    }
    let cancelled = false;
    void API.projects
      .getAll()
      .then((res) => {
        if (cancelled) return;
        if (res.success && Array.isArray(res.data)) {
          const match = (res.data as Project[]).find((p) => p.id === projectId) ?? null;
          setResolved(match);
        }
      })
      .catch(() => {
        /* leave resolved null — banner shows em dashes */
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, fromLoaded]);

  const effective = fromLoaded ?? resolved;
  const path = effective?.path ?? null;

  useEffect(() => {
    if (path === null) {
      setBranch(null);
      return;
    }
    let cancelled = false;
    void API.projects
      .detectBranch(path)
      .then((res) => {
        if (cancelled) return;
        if (res.success && typeof res.data === 'string') setBranch(res.data);
      })
      .catch(() => {
        /* branch stays null */
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  return {
    name: effective?.name ?? 'Project',
    path,
    branch,
  };
}
