import { useCallback, useState } from 'react';
import { API } from '../../../utils/api';
import { basename, useGuidedProjectCreate } from './useGuidedProjectCreate';

interface ExistingProjectPickerProps {
  onBack: () => void;
}

/**
 * Guided step 2 of 8 (tour step 8), 'existing' branch — point Cyboflow at a
 * folder that already exists.
 *
 * The project NAME is derived from the folder, not asked for (Settings renames
 * it later). The summary card deliberately claims nothing about the repo's
 * contents: `projects:detect-branch` answers 'main' for non-repos too, so there
 * is no honest branch/stack/commit detection to show — only the derived name
 * and a note about what `projects:create` does when the folder is not a repo.
 */
export function ExistingProjectPicker({ onBack }: ExistingProjectPickerProps): React.JSX.Element {
  const [pickedPath, setPickedPath] = useState<string | null>(null);
  const { creating, error, create } = useGuidedProjectCreate();

  const handleBrowse = useCallback(async () => {
    const res = await API.dialog.openDirectory({
      title: 'Select Project Folder',
      buttonLabel: 'Select',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.success && typeof res.data === 'string' && res.data) setPickedPath(res.data);
  }, []);

  const handleAdd = useCallback(() => {
    if (pickedPath === null) return;
    void create({ name: basename(pickedPath), path: pickedPath });
  }, [pickedPath, create]);

  return (
    <div className="flex flex-col">
      <div className="mb-[18px] flex items-center gap-2.5">
        <span className="text-[9px] font-bold tracking-[.14em] text-text-tertiary">GUIDED SET-UP</span>
        <span aria-hidden="true" className="flex-1 border-t border-dashed border-border-primary" />
        <span className="text-[9px] tracking-[.14em] text-text-tertiary">STEP 2 OF 8</span>
      </div>

      <h1 className="text-[24px] font-extrabold tracking-[-.01em] text-text-primary">
        Pick the folder
      </h1>
      <p className="mb-5 mt-2 text-[12px] leading-[1.6] text-text-secondary">
        The project name comes from the folder — rename it later in Settings.
      </p>

      <div className="mb-3.5 flex gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2.5 border-[1.4px] border-border-emphasized bg-surface-primary px-3.5 py-[11px]">
          <FolderIcon />
          <span className="min-w-0 flex-1 truncate text-[12px] text-text-primary">
            {pickedPath ?? <span className="text-text-tertiary">Choose a folder…</span>}
          </span>
        </div>
        <button
          type="button"
          onClick={() => void handleBrowse()}
          className="flex items-center border border-border-primary bg-surface-primary px-3.5 text-[10px] font-semibold uppercase tracking-[.12em] text-text-secondary transition-colors hover:border-interactive hover:text-interactive"
        >
          Browse…
        </button>
      </div>

      {pickedPath !== null && (
        <>
          <div className="flex items-center gap-3 border border-border-primary bg-[var(--paper-3)] px-3.5 py-3">
            <span className="text-[9px] font-bold tracking-[.14em] text-text-tertiary">NAME</span>
            <span className="min-w-0 flex-1 truncate text-[11px] text-text-primary">
              {basename(pickedPath)}
            </span>
          </div>
          <p className="mt-2 text-[10px] leading-[1.55] text-text-tertiary">
            Not a git repo yet? Cyboflow initializes one on main.
          </p>
        </>
      )}

      {error !== null && (
        <p role="alert" className="mt-3 text-[10px] leading-[1.55] text-status-error">
          {error}
        </p>
      )}

      <div className="mt-[22px] flex items-center">
        <button
          type="button"
          onClick={onBack}
          className="border border-border-primary bg-transparent px-3 py-[9px] text-[10px] font-semibold uppercase tracking-[.12em] text-text-secondary transition-colors hover:border-border-emphasized hover:text-text-primary"
        >
          ← Back
        </button>
        <span className="flex-1" />
        <button
          type="button"
          disabled={pickedPath === null || creating}
          onClick={handleAdd}
          className={
            pickedPath === null || creating
              ? 'cursor-not-allowed border border-border-primary bg-[var(--paper-3)] px-4 py-[9px] text-[10px] font-bold uppercase tracking-[.12em] text-text-disabled'
              : 'border border-border-emphasized bg-[var(--ink)] px-4 py-[9px] text-[10px] font-bold uppercase tracking-[.12em] text-[var(--paper)] transition-colors hover:border-interactive hover:bg-interactive'
          }
        >
          Add project →
        </button>
      </div>
    </div>
  );
}

/** The design's folder glyph, inline so it inherits the token stroke colour. */
function FolderIcon(): React.JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className="flex-shrink-0 text-text-secondary"
    >
      <path
        d="M3 6.5 V19 H21 V8.5 H12 L9.8 6.5 H3 Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="miter"
      />
    </svg>
  );
}
