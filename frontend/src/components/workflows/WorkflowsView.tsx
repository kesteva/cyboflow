/**
 * WorkflowsView — the "Workflows" center-pane surface: a cross-project gallery
 * of workflow cards stacked over agent cards (the design reference's
 * `GalleryStacked`). NO `projectId` prop — it is cross-project and mirrors
 * {@link InsightsView}: it owns the layout shell + a one-shot {@link
 * useWorkflowsStore} `init()` on mount + a {@link WorkflowsProjectFilter} scope
 * control + a first-load skeleton + a NON-FATAL stale-on-error banner with a
 * retry button.
 *
 * Edge / empty states:
 *   - NO PROJECTS — a one-shot project-count load drives a centered CTA to
 *     create the first project (reusing {@link CreateProjectDialog}); the
 *     gallery is hidden until a project exists.
 *   - BUILTIN-ONLY project — never truly empty: the store always yields the 3
 *     builtin flow cards, and {@link GalleryStacked} always appends the New
 *     card, so the Workflows section renders even with zero custom flows.
 *   - PARTIAL fan-out failure — the store records the FIRST failure message and
 *     keeps the prior (stale) slices; we surface it in the banner and keep the
 *     gallery rendered (mirrors insightsStore's first-failure behavior).
 *   - AGENTS unavailable — forwarded to GalleryStacked, which renders the agent
 *     section's empty-state rather than a broken grid.
 *
 * Init is idempotent (the store's first call fetches + subscribes); a remount
 * reuses the live subscription.
 */
import { useEffect, useRef, useState } from 'react';
import { useWorkflowsStore } from '../../stores/workflowsStore';
import { API } from '../../utils/api';
import { trpc } from '../../trpc/client';
import type { Project } from '../../types/project';
import { useNavigationStore } from '../../stores/navigationStore';
import { CreateProjectDialog } from '../CreateProjectDialog';
import { GalleryStacked } from './GalleryStacked';
import { GalleryNew, type GalleryNewTemplate } from './GalleryNew';
import { WorkflowsProjectFilter } from './WorkflowsProjectFilter';
import { WorkflowEditorModal } from '../cyboflow/WorkflowEditorModal';
import { AgentEditorModal } from '../cyboflow/agents/AgentEditorModal';
import type { WorkflowGalleryEntry, AgentGalleryEntry } from '../../stores/workflowsStore';
import type { WorkflowDefinition, PermissionMode } from '../../../../shared/types/workflows';

/** First-load skeleton — two placeholder section blocks under the header. */
function LoadingSkeleton(): React.JSX.Element {
  return (
    <div className="space-y-8 px-6 pt-6" data-testid="workflows-loading">
      {[0, 1].map((section) => (
        <div key={section} className="space-y-4">
          <div className="h-5 w-40 animate-pulse rounded-card bg-bg-secondary" />
          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((card) => (
              <div
                key={card}
                className="h-48 w-full animate-pulse rounded-card border border-border-primary bg-bg-secondary"
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** No-projects leaf — a centered CTA opening the shared CreateProjectDialog. */
function NoProjects(): React.JSX.Element {
  const [dialogOpen, setDialogOpen] = useState(false);
  return (
    <div
      className="flex min-h-full w-full items-center justify-center bg-bg-primary px-7 py-16 font-mono"
      data-testid="workflows-no-projects"
    >
      <div className="flex w-full max-w-[440px] flex-col items-center text-center">
        <div className="eyebrow mb-5 text-text-tertiary">No projects yet</div>
        <button
          type="button"
          onClick={() => setDialogOpen(true)}
          data-testid="workflows-create-project"
          className="flex w-full flex-col items-center gap-3 border border-dashed border-border-primary bg-surface-secondary px-7 py-10 text-center transition-colors hover:border-border-hover"
        >
          <h1 className="text-lg font-bold tracking-tight text-text-primary">
            Add a project to see its workflows
          </h1>
          <p className="max-w-[320px] text-sm leading-relaxed text-text-secondary">
            Point Cyboflow at a local git repository — its built-in flows and
            agents appear here.
          </p>
          <span className="mt-2 inline-flex items-center bg-text-primary px-4 py-2 text-xs font-bold uppercase tracking-wide text-text-on-interactive">
            Browse for a folder
          </span>
        </button>
      </div>
      <CreateProjectDialog
        isOpen={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onCreated={(project: Project) => {
          useNavigationStore
            .getState()
            .goToWizard({ lockProjectId: project.id, allowQuick: true });
        }}
      />
    </div>
  );
}

/** WorkflowsView — see the file header. Named export, no props. */
export function WorkflowsView(): React.JSX.Element {
  const initialized = useWorkflowsStore((s) => s.initialized);
  const loading = useWorkflowsStore((s) => s.loading);
  const error = useWorkflowsStore((s) => s.error);
  const projectFilter = useWorkflowsStore((s) => s.projectFilter);
  const workflows = useWorkflowsStore((s) => s.workflows);
  const agents = useWorkflowsStore((s) => s.agents);

  // One-shot store init on mount (idempotent — first call fetches + subscribes).
  useEffect(() => {
    void useWorkflowsStore.getState().init();
  }, []);

  // One-shot project-count probe for the no-projects empty-state. `null` while
  // unknown so we never flash the CTA before the count resolves.
  const [hasProjects, setHasProjects] = useState<boolean | null>(null);
  useEffect(() => {
    let active = true;
    void API.projects
      .getAll()
      .then((res) => {
        if (!active) return;
        if (res.success && Array.isArray(res.data)) {
          setHasProjects(res.data.length > 0);
        } else {
          // A list error should not strand the user on the CTA — assume projects
          // exist and let the gallery's own error banner surface the failure.
          setHasProjects(true);
        }
      })
      .catch(() => {
        if (active) setHasProjects(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const showSkeleton = (loading && !initialized) || hasProjects === null;

  // ── Locally-hosted editor/picker modal state ──────────────────────────────
  // All open/close state lives in this view; the gallery cards stay purely
  // presentational. After any create/edit/duplicate/agent-save we refresh the
  // workflows store so the gallery reflects the change.

  /** Workflow blueprint editor — `mode` + seeds drive edit vs create. */
  interface WfEditorState {
    mode: 'edit' | 'create';
    projectId: number;
    /** Edit mode: the row to edit. Create mode: '' (ignored). */
    workflowId: string;
    initialDefinition?: WorkflowDefinition;
    initialPermissionMode?: PermissionMode;
    initialName?: string;
  }
  const [wfEditor, setWfEditor] = useState<WfEditorState | null>(null);

  /** "New workflow" template picker; carries the project the new flow lands in. */
  const [newWorkflowProjectId, setNewWorkflowProjectId] = useState<number | null>(null);

  /** Agent editor — edit (existing key) vs create (blank key). */
  interface AgentEditorOpen {
    mode: 'edit' | 'create';
    projectId: number;
    agentKey: string;
  }
  const [agentEditor, setAgentEditor] = useState<AgentEditorOpen | null>(null);

  // Synchronous in-flight latch for the direct-duplicate action: the `disabled`
  // attribute on a card isn't involved here, so two clicks in the same tick
  // would both fire createCustom. A ref flips synchronously and rejects the
  // second invocation before it can issue a duplicate create.
  const duplicateInFlightRef = useRef(false);

  /**
   * Resolve the project the New / cross-project actions target (v1):
   * the active `projectFilter` when set, else the single/first enumerated
   * project. Returns null when there are no projects (the New cards become
   * no-ops). Derived from the store's already-fetched slices — no extra fetch.
   */
  const resolveTargetProjectId = (): number | null => {
    if (projectFilter !== null) return projectFilter;
    // The gallery slices carry the owning project id per workflow row; use the
    // first one as the lone/first enumerated project. (Agents alone don't carry
    // a project id, so workflows are the source of truth here.)
    const first = workflows[0]?.row.project_id;
    return first ?? null;
  };

  /**
   * Resolve the project that owns an agent for the Edit-agent action (v1):
   * agents are deduped across projects by key, so the AgentGalleryEntry carries
   * no project id. We use the active `projectFilter` when set, else fall back to
   * the first enumerated project (the same target the New actions use). The
   * agent catalogue reconciles built-ins per project, so the first project is a
   * safe default; a precise per-key project map is out of scope for v1.
   */
  const resolveAgentProjectId = (_entry: AgentGalleryEntry): number | null => {
    return resolveTargetProjectId();
  };

  const onRunWorkflow = (entry: WorkflowGalleryEntry): void => {
    // Land the start-session wizard locked to this workflow's project with the
    // flow preselected BY ROW ID. goToWizard's nav mutual-exclusion closes the
    // Workflows pane.
    useNavigationStore.getState().goToWizard({
      lockProjectId: entry.row.project_id,
      preselectWorkflowId: entry.row.id,
    });
  };

  const onEditWorkflow = (entry: WorkflowGalleryEntry): void => {
    setWfEditor({
      mode: 'edit',
      projectId: entry.row.project_id,
      workflowId: entry.row.id,
    });
  };

  const onDuplicateWorkflow = (entry: WorkflowGalleryEntry): void => {
    if (duplicateInFlightRef.current) return;
    duplicateInFlightRef.current = true;
    void (async () => {
      const isConflict = (err: unknown): boolean =>
        err instanceof Error && err.message.includes('already exists');
      try {
        try {
          await trpc.cyboflow.workflows.createCustom.mutate({
            projectId: entry.row.project_id,
            name: entry.row.name + '-copy',
            definition: entry.definition,
            permissionMode: entry.row.permission_mode,
          });
        } catch (err: unknown) {
          // Retry ONCE with a distinct name on a name-collision conflict.
          if (!isConflict(err)) throw err;
          await trpc.cyboflow.workflows.createCustom.mutate({
            projectId: entry.row.project_id,
            name: entry.row.name + '-copy-2',
            definition: entry.definition,
            permissionMode: entry.row.permission_mode,
          });
        }
        await useWorkflowsStore.getState().refresh();
      } catch (err: unknown) {
        console.warn('[WorkflowsView] Duplicate workflow failed', err);
      } finally {
        duplicateInFlightRef.current = false;
      }
    })();
  };

  const onNewWorkflow = (): void => {
    const targetProjectId = resolveTargetProjectId();
    if (targetProjectId === null) return; // No projects — no-op.
    setNewWorkflowProjectId(targetProjectId);
  };

  const onEditAgent = (entry: AgentGalleryEntry): void => {
    const agentProjectId = resolveAgentProjectId(entry);
    if (agentProjectId === null) return; // No projects — no-op.
    setAgentEditor({ mode: 'edit', projectId: agentProjectId, agentKey: entry.id });
  };

  const onNewAgent = (): void => {
    const targetProjectId = resolveTargetProjectId();
    if (targetProjectId === null) return; // No projects — no-op.
    setAgentEditor({ mode: 'create', projectId: targetProjectId, agentKey: '' });
  };

  // Template list for the New-workflow picker — the store's workflows, deduped
  // by name (GalleryNew dedupes again defensively, but we pre-thin so the picker
  // never receives an entry per project).
  const newWorkflowTemplates: GalleryNewTemplate[] = (() => {
    const seen = new Set<string>();
    const out: GalleryNewTemplate[] = [];
    for (const w of workflows) {
      if (seen.has(w.row.name)) continue;
      seen.add(w.row.name);
      out.push({ row: w.row, definition: w.definition });
    }
    return out;
  })();

  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden bg-bg-primary"
      data-testid="workflows-view"
    >
      <div className="flex-shrink-0 border-b border-border-primary bg-bg-secondary px-7 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="eyebrow text-text-tertiary">Reusable agent pipelines · roles</div>
            <h2 className="mt-1 text-[22px] font-bold tracking-[-0.01em] text-text-primary">
              Workflows
            </h2>
          </div>
          <div className="flex-shrink-0 pt-1 font-mono">
            <WorkflowsProjectFilter />
          </div>
        </div>
      </div>

      {error !== null && (
        <div
          className="flex flex-shrink-0 items-center gap-3 border-b border-border-primary bg-status-warning/10 px-7 py-1.5 text-xs text-status-warning"
          role="alert"
          data-testid="workflows-error"
        >
          <span className="flex-1">
            Could not refresh workflows ({error}). Showing the last loaded data.
          </span>
          <button
            type="button"
            data-testid="workflows-retry"
            onClick={() => void useWorkflowsStore.getState().refresh()}
            className="shrink-0 border border-status-warning px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-status-warning transition-colors hover:bg-status-warning hover:text-text-on-status-warning"
          >
            Retry
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto font-mono">
        {showSkeleton ? (
          <LoadingSkeleton />
        ) : hasProjects === false ? (
          <NoProjects />
        ) : (
          <GalleryStacked
            workflows={workflows}
            agents={agents}
            showProjectChip={projectFilter === null}
            agentsUnavailable={agents.length === 0}
            onRunWorkflow={onRunWorkflow}
            onEditWorkflow={onEditWorkflow}
            onDuplicateWorkflow={onDuplicateWorkflow}
            onNewWorkflow={onNewWorkflow}
            onEditAgent={onEditAgent}
            onNewAgent={onNewAgent}
          />
        )}
      </div>

      {/* ── Locally-hosted modals ──────────────────────────────────────────── */}

      {/* New-workflow template picker. Choosing a template opens the editor in
          create mode seeded with that template; "blank canvas" opens it with no
          seed (the editor's own skeleton). */}
      {newWorkflowProjectId !== null && (
        <GalleryNew
          isOpen
          templates={newWorkflowTemplates}
          onClose={() => setNewWorkflowProjectId(null)}
          onSelect={(def, pm, name) => {
            const projectId = newWorkflowProjectId;
            setNewWorkflowProjectId(null);
            setWfEditor({
              mode: 'create',
              projectId,
              workflowId: '',
              initialDefinition: def,
              initialPermissionMode: pm,
              initialName: name,
            });
          }}
        />
      )}

      {/* Workflow blueprint editor (edit or create). */}
      {wfEditor !== null && (
        <WorkflowEditorModal
          isOpen
          mode={wfEditor.mode}
          workflowId={wfEditor.workflowId}
          projectId={wfEditor.projectId}
          initialDefinition={wfEditor.initialDefinition}
          initialPermissionMode={wfEditor.initialPermissionMode}
          initialName={wfEditor.initialName}
          onClose={() => setWfEditor(null)}
          onSaved={() => {
            setWfEditor(null);
            void useWorkflowsStore.getState().refresh();
          }}
        />
      )}

      {/* Agent editor (edit or create). */}
      {agentEditor !== null && (
        <AgentEditorModal
          isOpen
          mode={agentEditor.mode}
          projectId={agentEditor.projectId}
          agentKey={agentEditor.agentKey}
          onClose={() => setAgentEditor(null)}
          onSaved={() => {
            setAgentEditor(null);
            void useWorkflowsStore.getState().refresh();
          }}
        />
      )}
    </div>
  );
}
