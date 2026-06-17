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
import { useEffect, useState } from 'react';
import { useWorkflowsStore } from '../../stores/workflowsStore';
import { API } from '../../utils/api';
import type { Project } from '../../types/project';
import { useNavigationStore } from '../../stores/navigationStore';
import { CreateProjectDialog } from '../CreateProjectDialog';
import { GalleryStacked } from './GalleryStacked';
import { WorkflowsProjectFilter } from './WorkflowsProjectFilter';
import type { WorkflowGalleryEntry, AgentGalleryEntry } from '../../stores/workflowsStore';

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

  // Thin action props — handler bodies wired in P4 / the editor integration.
  const onRunWorkflow = (entry: WorkflowGalleryEntry): void => {
    // TODO(P4): launch a run of entry.row via the start-session wizard.
    console.warn('[WorkflowsView] Run not yet wired', entry.row.id);
  };
  const onEditWorkflow = (entry: WorkflowGalleryEntry): void => {
    // TODO(P4): open entry.row in the workflow editor.
    console.warn('[WorkflowsView] Edit workflow not yet wired', entry.row.id);
  };
  const onDuplicateWorkflow = (entry: WorkflowGalleryEntry): void => {
    // TODO(P4): duplicate entry.row into a new editable draft.
    console.warn('[WorkflowsView] Duplicate workflow not yet wired', entry.row.id);
  };
  const onNewWorkflow = (): void => {
    // TODO(P4): open the create-workflow gallery.
    console.warn('[WorkflowsView] New workflow not yet wired');
  };
  const onEditAgent = (entry: AgentGalleryEntry): void => {
    // TODO(editor): open the agent editor for entry.id.
    console.warn('[WorkflowsView] Edit agent not yet wired', entry.id);
  };
  const onNewAgent = (): void => {
    // TODO(editor): open the create-agent editor.
    console.warn('[WorkflowsView] New agent not yet wired');
  };

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
    </div>
  );
}
