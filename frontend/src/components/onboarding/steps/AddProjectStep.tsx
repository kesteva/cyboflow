/**
 * Step 3 — add a project. New-user path: a repository-path row (Browse… picks a
 * directory) + the "No projects yet" empty panel; the footer "Add project →"
 * creates it and the real 'project-created' event advances the tour. Replay /
 * resumed installs already have a project, so a summary row shows instead and
 * the footer falls back to a plain Next.
 */
interface AddProjectStepProps {
  hasExistingProject: boolean;
  firstProjectName: string | null;
  firstProjectPath: string | null;
  /** Directory picked via Browse… (null until picked). */
  pickedPath: string | null;
  onBrowse: () => void;
}

export function AddProjectStep({
  hasExistingProject,
  firstProjectName,
  firstProjectPath,
  pickedPath,
  onBrowse,
}: AddProjectStepProps): React.JSX.Element {
  if (hasExistingProject) {
    return (
      <div className="px-6 pb-2 pt-5">
        <div className="mb-4 text-[12px] leading-[1.6] text-text-primary">
          You already have a project — every session Cyboflow runs gets its own worktree off this repo.
        </div>
        <div className="flex items-center gap-3 border border-border-primary bg-surface-primary px-[15px] py-3.5">
          <span className="flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center border-[1.4px] border-border-emphasized bg-bg-primary text-[15px] font-bold text-interactive">
            ▸
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12px] font-bold text-text-primary">
              {firstProjectName ?? 'Project'}
            </span>
            {firstProjectPath && (
              <span className="mt-px block truncate text-[10px] text-text-tertiary">{firstProjectPath}</span>
            )}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="px-6 pb-2 pt-5">
      <div className="mb-4 text-[12px] leading-[1.6] text-text-primary">
        Point Cyboflow at any local git repo — or a new folder, and it'll initialize one. Each session it runs gets its
        own worktree off this repo.
      </div>
      <div className="mb-2 text-[9px] uppercase tracking-[.16em] text-text-tertiary">Repository path</div>
      <div className="mb-4 flex gap-2">
        <span className="flex-1 truncate border border-border-emphasized bg-surface-primary px-3 py-2.5 text-[11px] text-text-primary">
          {pickedPath ?? <span className="text-text-tertiary">Choose a repository…</span>}
        </span>
        <button
          type="button"
          onClick={onBrowse}
          className="flex items-center border border-border-emphasized bg-surface-primary px-[13px] text-[10px] font-bold uppercase tracking-[.12em] text-text-primary transition-colors hover:border-interactive hover:text-interactive"
        >
          Browse…
        </button>
      </div>
      <div className="border border-dashed border-border-primary bg-[var(--paper-3)] px-4 py-[15px] text-center">
        <div className="mb-[3px] text-[11px] font-bold text-text-primary">No projects yet</div>
        <div className="text-[10px] leading-[1.55] text-text-secondary">
          The repo you add becomes your first — every session nests under it in the rail.
        </div>
      </div>
    </div>
  );
}
