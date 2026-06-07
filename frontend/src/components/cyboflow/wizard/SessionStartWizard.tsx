/**
 * SessionStartWizard — the center-pane "Start a new session" index-card wizard.
 *
 * Two flows, switched on `wizardOpts.lockProjectId`:
 *   - UNLOCKED (no lockProjectId): a 2-step flow — ① pick a project from a grid
 *     of {@link ProjectFilingCard}s (+ an "Add project" card), then ② pick a
 *     workflow.
 *   - LOCKED (lockProjectId set): the project is pinned; the wizard opens
 *     directly on the workflow step. When `allowQuick` is also set, a featured
 *     {@link QuickSessionCard} is offered above the workflow list.
 *
 * Launch paths:
 *   - workflow: `trpc.cyboflow.runs.start.mutate` → setActiveRun → goToSession.
 *     The Planner ('planner') is gated behind {@link IdeaPickerModal}; the chosen
 *     idea id is threaded into runs.start.mutate({ ideaId }).
 *   - quick: the {@link useQuickSession} hook (bound to the locked project) — it
 *     creates the session + both panels and calls setActiveQuickSession itself.
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
import { IdeaPickerModal } from '../IdeaPickerModal';
import { CreateProjectDialog } from '../../CreateProjectDialog';
import { WizardStepHeader } from './WizardStepHeader';
import { ProjectFilingCard } from './ProjectFilingCard';
import { WorkflowListRow } from './WorkflowListRow';
import { QuickSessionCard } from './QuickSessionCard';
import { buildWorkflowMeta, DEFAULT_WORKFLOW_NAME } from './workflowMeta';
import type { WorkflowCardMeta } from './workflowMeta';

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

  // Step state (unlocked only). Locked mode is always "on the workflow step".
  const [step, setStep] = useState<1 | 2>(locked ? 2 : 1);

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

  // Planner pre-launch idea gate.
  const [ideaPickerOpen, setIdeaPickerOpen] = useState(false);
  const [pendingWorkflowId, setPendingWorkflowId] = useState<string | null>(null);

  // Launch state.
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [isLaunching, setIsLaunching] = useState(false);
  const startInFlightRef = useRef(false);

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
      setToast(`Starting interactive session on ${banner.name}`);
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
  useEffect(() => {
    if (selectedProjectId === null) return;
    const projectId = selectedProjectId;
    setWorkflowsLoading(true);
    setWorkflowsError(null);
    Promise.all([
      trpc.cyboflow.workflows.list.query({ projectId }),
      trpc.cyboflow.runs.list.query({ projectId }),
    ])
      .then(([rows, runs]) => {
        const metas = buildWorkflowMeta(rows, runs);
        setWorkflowMetas(metas);
        // Pre-select the default workflow if present and nothing chosen yet.
        setSelection((prev) => {
          if (prev !== null) return prev;
          const def = metas.find((m) => m.name === DEFAULT_WORKFLOW_NAME);
          return def ? { kind: 'workflow', workflowId: def.id } : null;
        });
      })
      .catch((err: unknown) => {
        setWorkflowsError(err instanceof Error ? err.message : 'Failed to load workflows');
      })
      .finally(() => {
        setWorkflowsLoading(false);
      });
  }, [selectedProjectId]);

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

  const handleSelectProject = useCallback((projectId: number) => {
    setSelectedProjectId(projectId);
    setSelection(null);
    setStep(2);
  }, []);

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
        const result: RunStartResult = await trpc.cyboflow.runs.start.mutate(
          ideaId === undefined
            ? { workflowId, projectId: selectedProjectId }
            : { workflowId, projectId: selectedProjectId, ideaId },
        );
        useCyboflowStore.getState().setActiveRun(result.runId);
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
    [selectedProjectId, workflowMetas, banner.name],
  );

  const handleStart = useCallback(() => {
    if (selection === null || startInFlightRef.current) return;

    if (selection.kind === 'quick') {
      void startQuickSession();
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
    void launchRun(selection.workflowId);
  }, [selection, workflowMetas, startQuickSession, launchRun]);

  const handleIdeaPicked = useCallback(
    (ideaId: string) => {
      setIdeaPickerOpen(false);
      if (pendingWorkflowId === null) return;
      void launchRun(pendingWorkflowId, ideaId);
    },
    [pendingWorkflowId, launchRun],
  );

  // ── CTA label / disabled ─────────────────────────────────────────────────
  const ctaBusy = isLaunching || isQuickStarting;
  let ctaLabel: string;
  if (selection === null) {
    ctaLabel = 'Select a workflow';
  } else if (selection.kind === 'quick') {
    ctaLabel = 'Start interactive session';
  } else {
    const meta = workflowMetas.find((m) => m.id === selection.workflowId);
    ctaLabel = `Run ${meta?.slashCommand ?? '/workflow'}`;
  }

  const combinedError = launchError ?? quickError;

  return (
    <div className="relative h-full w-full overflow-y-auto" style={GRID_BG_STYLE}>
      <div className="mx-auto flex max-w-[720px] flex-col gap-4 px-6 py-8">
        <WizardStepHeader
          locked={locked}
          step={step}
          onBackToQueue={handleBackToQueue}
          onChangeProject={handleChangeProject}
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
            {/* Selected-project banner */}
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

            {/* Quick session (featured, allowQuick only) */}
            {allowQuick && (
              <>
                <QuickSessionCard
                  selected={selection?.kind === 'quick'}
                  onSelect={() => setSelection({ kind: 'quick' })}
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
                  onSelect={() => setSelection({ kind: 'workflow', workflowId: meta.id })}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Sticky CTA (workflow step) ── */}
      {step === 2 && selectedProjectId !== null && (
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

      {/* ── Add-project dialog ── */}
      {createOpen && (
        <CreateProjectDialog
          isOpen
          onClose={() => setCreateOpen(false)}
          onCreated={handleProjectCreated}
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
