/**
 * EmptyState — the landing leaf shown when no projects exist yet.
 *
 * A centered, single-column prompt to add the first project. The dashed drop
 * card opens the shared {@link CreateProjectDialog}; on a successful create it
 * hands off to the new-flow wizard locked to the freshly-created project (quick
 * escape hatch allowed) via the navigation store.
 */
import { useState } from 'react';
import { Folder } from 'lucide-react';
import { CreateProjectDialog } from '../CreateProjectDialog';
import { useNavigationStore } from '../../stores/navigationStore';

/** EmptyState takes no props — it is a self-contained landing leaf. */
export function EmptyState() {
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <div className="flex min-h-full w-full items-center justify-center bg-bg-primary px-7 py-16 font-mono">
      <div className="flex w-full max-w-[440px] flex-col items-center text-center">
        <div className="eyebrow mb-5 text-text-tertiary">No projects yet</div>

        <button
          type="button"
          onClick={() => setDialogOpen(true)}
          className="flex w-full flex-col items-center gap-3 border border-dashed border-border-primary bg-surface-secondary px-7 py-10 text-center transition-colors hover:border-border-hover"
        >
          <Folder className="h-8 w-8 text-text-tertiary" strokeWidth={1.5} />
          <h1 className="text-lg font-bold tracking-tight text-text-primary">
            Add your first project
          </h1>
          <p className="max-w-[320px] text-sm leading-relaxed text-text-secondary">
            Point Cyboflow at a local git repository to start running agents over it.
          </p>
          <span className="mt-2 inline-flex items-center bg-text-primary px-4 py-2 text-xs font-bold uppercase tracking-wide text-text-on-interactive">
            Browse for a folder
          </span>
        </button>

        <p className="mt-5 text-xs text-text-muted">
          Reads the repo in place · detects branch from .git/HEAD
        </p>
      </div>

      <CreateProjectDialog
        isOpen={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onCreated={(project) => {
          useNavigationStore
            .getState()
            .goToWizard({ lockProjectId: project.id, allowQuick: true });
        }}
      />
    </div>
  );
}
