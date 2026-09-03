import { useCallback, useState } from 'react';
import { API } from '../../../utils/api';
import {
  composeProjectPath,
  isValidProjectName,
  useGuidedProjectCreate,
} from './useGuidedProjectCreate';

interface NewProjectFormProps {
  onBack: () => void;
}

/**
 * Guided step 2 of 8 (tour step 8), 'new' branch — name a project and pick the
 * parent directory; `projects:create` makes the folder and bootstraps git.
 *
 * The badges on the WILL CREATE card describe what that handler ATTEMPTS for a
 * non-repo path (git init on `main`, then a first commit); it swallows a failed
 * bootstrap and still reports success, which is pre-existing behaviour and why
 * the prose says "creates the folder with git initialized" rather than
 * promising the commit.
 */
export function NewProjectForm({ onBack }: NewProjectFormProps): React.JSX.Element {
  const [name, setName] = useState('');
  const [location, setLocation] = useState<string | null>(null);
  const { creating, error, create } = useGuidedProjectCreate();

  const nameValid = isValidProjectName(name);
  // Only complain once the user has typed something — an empty field is the
  // starting state, not a mistake.
  const nameError = name !== '' && !nameValid;
  const composedPath = location !== null && nameValid ? composeProjectPath(location, name) : null;

  const handleBrowse = useCallback(async () => {
    const res = await API.dialog.openDirectory({
      title: 'Select Parent Folder',
      buttonLabel: 'Select',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.success && typeof res.data === 'string' && res.data) setLocation(res.data);
  }, []);

  const handleCreate = useCallback(() => {
    if (composedPath === null) return;
    void create({ name: name.trim(), path: composedPath });
  }, [composedPath, name, create]);

  return (
    <div className="flex flex-col">
      <div className="mb-[18px] flex items-center gap-2.5">
        <span className="text-[9px] font-bold tracking-[.14em] text-text-tertiary">GUIDED SET-UP</span>
        <span aria-hidden="true" className="flex-1 border-t border-dashed border-border-primary" />
        <span className="text-[9px] tracking-[.14em] text-text-tertiary">STEP 2 OF 8</span>
      </div>

      <h1 className="text-[24px] font-extrabold tracking-[-.01em] text-text-primary">
        Create a project
      </h1>
      <p className="mb-5 mt-2 text-[12px] leading-[1.6] text-text-secondary">
        Name it and pick where it lives — Cyboflow creates the folder with git initialized.
      </p>

      <label
        htmlFor="guided-project-name"
        className="mb-[5px] text-[9px] font-bold tracking-[.14em] text-text-tertiary"
      >
        NAME
      </label>
      <input
        id="guided-project-name"
        type="text"
        value={name}
        autoFocus
        spellCheck={false}
        placeholder="my-project"
        onChange={(e) => setName(e.target.value)}
        className="mb-3.5 border-[1.4px] border-border-emphasized bg-surface-primary px-3.5 py-[11px] text-[12px] text-text-primary caret-interactive outline-none placeholder:text-text-tertiary"
      />
      {nameError && (
        <p className="-mt-2 mb-3.5 text-[10px] leading-[1.55] text-status-error">
          A project name can't contain / or \.
        </p>
      )}

      <div className="mb-[5px] text-[9px] font-bold tracking-[.14em] text-text-tertiary">LOCATION</div>
      <div className="mb-3.5 flex gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2.5 border border-border-primary bg-surface-primary px-3.5 py-[11px]">
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
          <span className="min-w-0 flex-1 truncate text-[12px] text-text-primary">
            {location ?? <span className="text-text-tertiary">Choose a folder…</span>}
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

      {composedPath !== null && (
        <div className="flex items-center gap-3 border border-border-primary bg-[var(--paper-3)] px-3.5 py-3">
          <span className="text-[9px] font-bold tracking-[.14em] text-text-tertiary">WILL CREATE</span>
          <span className="min-w-0 flex-1 truncate text-[11px] text-text-primary">{composedPath}</span>
          <span className="flex-shrink-0 border border-status-success px-[7px] py-[3px] text-[8.5px] font-bold tracking-[.1em] text-status-success">
            GIT INIT · MAIN
          </span>
          <span className="flex-shrink-0 border border-border-primary px-[7px] py-[3px] text-[8.5px] font-bold tracking-[.1em] text-text-secondary">
            FIRST COMMIT
          </span>
        </div>
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
          disabled={composedPath === null || creating}
          onClick={handleCreate}
          className={
            composedPath === null || creating
              ? 'cursor-not-allowed border border-border-primary bg-[var(--paper-3)] px-4 py-[9px] text-[10px] font-bold uppercase tracking-[.12em] text-text-disabled'
              : 'border border-border-emphasized bg-[var(--ink)] px-4 py-[9px] text-[10px] font-bold uppercase tracking-[.12em] text-[var(--paper)] transition-colors hover:border-interactive hover:bg-interactive'
          }
        >
          Create project →
        </button>
      </div>
    </div>
  );
}
