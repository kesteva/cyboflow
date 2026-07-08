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
import { trackEvent } from '../../utils/telemetry';
import type { Project } from '../../types/project';
import { useNavigationStore } from '../../stores/navigationStore';
import { CreateProjectDialog } from '../CreateProjectDialog';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '../ui/Modal';
import { GalleryStacked } from './GalleryStacked';
import { GalleryNew, type GalleryNewTemplate } from './GalleryNew';
import { WorkflowsProjectFilter } from './WorkflowsProjectFilter';
import { WorkflowEditorModal } from '../cyboflow/WorkflowEditorModal';
import { AgentEditorModal } from '../cyboflow/agents/AgentEditorModal';
import { ABTestLaunchModal } from '../cyboflow/ABTestLaunchModal';
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
  const mcps = useWorkflowsStore((s) => s.mcps);
  const plugins = useWorkflowsStore((s) => s.plugins);

  // One-shot store init on mount (idempotent — first call fetches + subscribes).
  useEffect(() => {
    void useWorkflowsStore.getState().init();
  }, []);

  // One-shot project probe for the no-projects empty-state + the Save-scope /
  // new-flow-scope pickers' project options. `hasProjects` is null while
  // unknown so we never flash the CTA before the probe resolves; `projectList`
  // (id + name) feeds the scope pickers (migration 030).
  const [hasProjects, setHasProjects] = useState<boolean | null>(null);
  const [projectList, setProjectList] = useState<{ id: number; name: string }[]>([]);
  useEffect(() => {
    let active = true;
    void API.projects
      .getAll()
      .then((res) => {
        if (!active) return;
        if (res.success && Array.isArray(res.data)) {
          const list = res.data as Project[];
          setHasProjects(list.length > 0);
          setProjectList(list.map((p) => ({ id: p.id, name: p.name })));
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
    /** The launch project + fallback save target (always a concrete project). */
    projectId: number;
    /** Edit mode: the row to edit. Create mode: '' (ignored). */
    workflowId: string;
    initialDefinition?: WorkflowDefinition;
    initialPermissionMode?: PermissionMode;
    initialName?: string;
    /**
     * Create mode: the chosen scope for the new flow (migration 030) — null ⇒
     * GLOBAL (the default), an integer ⇒ project-scoped. Ignored in edit mode.
     */
    createScopeProjectId?: number | null;
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

  // ── Delete-workflow confirm state ───────────────────────────────────────────
  // The card pending deletion (null = no dialog), plus busy/error for the
  // in-dialog mutation. A synchronous latch rejects a double-confirm before the
  // disabled button re-renders (same pattern as duplicate).
  const [deleteTarget, setDeleteTarget] = useState<WorkflowGalleryEntry | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deleteInFlightRef = useRef(false);

  // ── A/B test launcher (Slice B thin launch UI) ──────────────────────────────
  // The card's target workflow + the resolved launch project (mirrors
  // onEditWorkflow's fallback for a GLOBAL flow with no project of its own).
  const [abTestTarget, setAbTestTarget] = useState<{ projectId: number; workflowId: string; workflowName: string } | null>(
    null,
  );

  /**
   * Resolve the project the New / cross-project actions target (v1):
   * the active `projectFilter` when set, else the first enumerated project.
   * Returns null when there are no projects (the New cards become no-ops).
   *
   * Migration 030: a workflow row's `project_id` is now NULL for global flows
   * (and globals sort to the top of the deduped list), so we can no longer read
   * the target off `workflows[0]`. Use the probed `projectList` instead, falling
   * back to a project-scoped workflow row only if the probe has not yet resolved.
   */
  const resolveTargetProjectId = (): number | null => {
    if (projectFilter !== null) return projectFilter;
    if (projectList.length > 0) return projectList[0].id;
    // Probe not yet resolved — fall back to any project-scoped workflow row.
    const scoped = workflows.find((w) => w.row.project_id !== null);
    return scoped?.row.project_id ?? null;
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
    // Workflows pane. A GLOBAL flow (project_id NULL, migration 030) carries no
    // project of its own, so the wizard collects one (lockProjectId left
    // undefined — the launch phase refines this preselect path).
    useNavigationStore.getState().goToWizard({
      lockProjectId: entry.row.project_id ?? undefined,
      preselectWorkflowId: entry.row.id,
    });
  };

  const onEditWorkflow = (entry: WorkflowGalleryEntry): void => {
    // The editor's projectId is the launch / fallback project for "Run with
    // modifications" and the project-copy save target. For a GLOBAL flow
    // (project_id NULL, migration 030) it falls back to the resolved target
    // project; the actual scope decision is the editor's Save-scope dialog (Save
    // globally vs a project copy). With no project resolvable the editor cannot
    // open, so no-op (mirrors the New cards' no-project no-op).
    const editorProjectId = entry.row.project_id ?? resolveTargetProjectId();
    if (editorProjectId === null) return;
    setWfEditor({
      mode: 'edit',
      projectId: editorProjectId,
      workflowId: entry.row.id,
    });
  };

  const onDuplicateWorkflow = (entry: WorkflowGalleryEntry): void => {
    if (duplicateInFlightRef.current) return;
    // Duplicate PRESERVES the source flow's scope (migration 030): a GLOBAL flow
    // (project_id NULL) forks to another global copy; a project-scoped flow forks
    // within the same project. createCustom accepts a null projectId for the
    // global case, so no project resolution is needed.
    const duplicateProjectId = entry.row.project_id;
    duplicateInFlightRef.current = true;
    void (async () => {
      const isConflict = (err: unknown): boolean =>
        err instanceof Error && err.message.includes('already exists');
      try {
        try {
          await trpc.cyboflow.workflows.createCustom.mutate({
            projectId: duplicateProjectId,
            name: entry.row.name + '-copy',
            definition: entry.definition,
            permissionMode: entry.row.permission_mode,
          });
        } catch (err: unknown) {
          // Retry ONCE with a distinct name on a name-collision conflict.
          if (!isConflict(err)) throw err;
          await trpc.cyboflow.workflows.createCustom.mutate({
            projectId: duplicateProjectId,
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

  // Open the delete confirm for a card. The card only offers Delete for a
  // deletable flow (WorkflowCard.deletable), so we never receive a global
  // built-in / __quick__ here; the server enforces the same guard regardless.
  const onDeleteWorkflow = (entry: WorkflowGalleryEntry): void => {
    setDeleteError(null);
    setDeleteTarget(entry);
  };

  // Confirm the delete: mutate then refresh the store. A "has run history"
  // CONFLICT (or any failure) surfaces inline in the dialog rather than closing
  // it, so the user understands why the flow could not be removed.
  const confirmDeleteWorkflow = (): void => {
    if (deleteTarget === null || deleteInFlightRef.current) return;
    const entry = deleteTarget;
    deleteInFlightRef.current = true;
    setDeleteBusy(true);
    setDeleteError(null);
    void (async () => {
      try {
        await trpc.cyboflow.workflows.delete.mutate({ workflowId: entry.row.id });
        trackEvent('workflow_deleted');
        await useWorkflowsStore.getState().refresh();
        setDeleteTarget(null);
      } catch (err: unknown) {
        setDeleteError(err instanceof Error ? err.message : 'Could not delete the workflow');
      } finally {
        setDeleteBusy(false);
        deleteInFlightRef.current = false;
      }
    })();
  };

  // Open the A/B test launcher for a card. The launch project mirrors
  // onEditWorkflow's fallback for a GLOBAL flow (project_id null, migration
  // 030): the card's own project, else the resolved target project. With no
  // project resolvable the launcher cannot open, so no-op (mirrors the New
  // cards' no-project no-op).
  const onAbTestWorkflow = (entry: WorkflowGalleryEntry): void => {
    const targetProjectId = entry.row.project_id ?? resolveTargetProjectId();
    if (targetProjectId === null) return;
    setAbTestTarget({ projectId: targetProjectId, workflowId: entry.row.id, workflowName: entry.row.name });
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
            mcps={mcps}
            plugins={plugins}
            showProjectChip={projectFilter === null}
            agentsUnavailable={agents.length === 0}
            onRunWorkflow={onRunWorkflow}
            onEditWorkflow={onEditWorkflow}
            onDuplicateWorkflow={onDuplicateWorkflow}
            onDeleteWorkflow={onDeleteWorkflow}
            onAbTestWorkflow={onAbTestWorkflow}
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
          projects={projectList}
          // A new flow defaults to GLOBAL (null) unless a gallery project filter
          // is active, in which case that project is preselected (migration 030).
          defaultScopeProjectId={projectFilter}
          onClose={() => setNewWorkflowProjectId(null)}
          onSelect={(def, pm, name, scopeProjectId) => {
            const projectId = newWorkflowProjectId;
            setNewWorkflowProjectId(null);
            setWfEditor({
              mode: 'create',
              // The editor still launches / falls back to a concrete project; the
              // chosen scope (null = global) is threaded separately.
              projectId,
              workflowId: '',
              initialDefinition: def,
              initialPermissionMode: pm,
              initialName: name,
              createScopeProjectId: scopeProjectId ?? null,
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
          // Save-scope dialog inputs (migration 030): the gallery's active filter
          // defaults the project-copy target; the project list feeds its picker.
          activeProjectFilter={projectFilter}
          projects={projectList}
          initialDefinition={wfEditor.initialDefinition}
          initialPermissionMode={wfEditor.initialPermissionMode}
          initialName={wfEditor.initialName}
          createScopeProjectId={wfEditor.createScopeProjectId}
          onClose={() => setWfEditor(null)}
          onSaved={() => {
            setWfEditor(null);
            void useWorkflowsStore.getState().refresh();
          }}
        />
      )}

      {/* Delete-workflow confirm. A small danger dialog built from the shared
          Modal primitives; the actual guard (reserved built-ins, run history)
          lives server-side and surfaces here on failure. */}
      {deleteTarget !== null && (
        <Modal
          isOpen
          onClose={() => {
            if (!deleteBusy) setDeleteTarget(null);
          }}
          size="sm"
          showCloseButton={false}
        >
          <div data-testid="workflow-delete-dialog">
            <ModalHeader title="Delete workflow" />
            <ModalBody>
              <p className="text-sm leading-relaxed text-text-secondary">
                Delete <b className="text-text-primary">{deleteTarget.row.name}</b>? This
                can&rsquo;t be undone. A workflow with run history can&rsquo;t be deleted.
              </p>
              {deleteError !== null && (
                <p
                  role="alert"
                  data-testid="workflow-delete-error"
                  className="mt-3 text-xs text-status-error"
                >
                  {deleteError}
                </p>
              )}
            </ModalBody>
            <ModalFooter>
              <button
                type="button"
                data-testid="workflow-delete-cancel"
                onClick={() => setDeleteTarget(null)}
                disabled={deleteBusy}
                className="rounded-button border border-border-primary bg-bg-primary px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="workflow-delete-confirm"
                onClick={confirmDeleteWorkflow}
                disabled={deleteBusy}
                className="rounded-button bg-status-error px-3 py-1.5 text-xs font-medium text-text-on-status-error hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Delete
              </button>
            </ModalFooter>
          </div>
        </Modal>
      )}

      {/* A/B test launcher (Slice B thin launch UI). */}
      {abTestTarget !== null && (
        <ABTestLaunchModal
          isOpen
          projectId={abTestTarget.projectId}
          projects={projectList}
          workflowId={abTestTarget.workflowId}
          workflowName={abTestTarget.workflowName}
          onClose={() => setAbTestTarget(null)}
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
