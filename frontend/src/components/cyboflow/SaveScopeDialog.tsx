/**
 * SaveScopeDialog — the editor's two-way Save-scope choice (migration 029).
 *
 * When the user saves an EDITED flow, they decide whether the edit applies
 * globally (to the shared `wf-global-*` row, visible across all projects) or
 * forks into a NEW project-scoped copy (`createCustom` with a target project):
 *
 *   - "Save globally"               → `onConfirm({ scope: 'global' })`
 *   - "Create a project-specific copy" → `onConfirm({ scope: 'project', projectId })`
 *
 * Save globally is the DEFAULT / primary action. For the project-copy path a
 * target project is required: when a project is already in context (a gallery
 * project-filter, or a single enumerated project) it is preselected; in the
 * cross-project "All projects" view a `<select>` picker is shown (mirroring
 * {@link WorkflowsProjectFilter}). The picker uses a plain styled native
 * `<select>` over Radix to inherit the surrounding mono font, like the gallery's
 * own filter. Follows FlowNameDialog's Modal pattern (portal to body, paper
 * theme, Enter/Esc handled by Modal).
 */
import { useEffect, useState } from 'react';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '../ui/Modal';

/** A project the copy can target — the minimal shape the picker needs. */
export interface SaveScopeProject {
  id: number;
  name: string;
}

/** The chosen save scope returned to the editor. */
export type SaveScopeChoice =
  | { scope: 'global' }
  | { scope: 'project'; projectId: number };

export interface SaveScopeDialogProps {
  isOpen: boolean;
  /**
   * Projects available as a fork target. When this has 0 entries the
   * project-copy path is disabled (only "Save globally" is selectable).
   */
  projects: SaveScopeProject[];
  /**
   * The project preselected for the copy path: the active gallery filter, or the
   * lone enumerated project. `null` ⇒ no project in context (All-projects view),
   * so the picker opens unselected and the user must choose.
   */
  defaultProjectId: number | null;
  onConfirm: (choice: SaveScopeChoice) => void;
  onClose: () => void;
}

export function SaveScopeDialog({
  isOpen,
  projects,
  defaultProjectId,
  onConfirm,
  onClose,
}: SaveScopeDialogProps): React.JSX.Element {
  const [scope, setScope] = useState<'global' | 'project'>('global');
  const [projectId, setProjectId] = useState<number | null>(defaultProjectId);

  // Re-seed each time the dialog (re)opens so a stale prior selection never
  // leaks into a fresh open. Default = Save globally (the product decision).
  useEffect(() => {
    if (isOpen) {
      setScope('global');
      setProjectId(defaultProjectId);
    }
  }, [isOpen, defaultProjectId]);

  const canCopy = projects.length > 0;
  // The project-copy path needs a resolved target. With no project in context
  // (All-projects) the user must pick one in the select before confirming.
  const projectChoiceValid = projectId !== null && projects.some((p) => p.id === projectId);
  const confirmDisabled = scope === 'project' && !projectChoiceValid;

  const handleConfirm = (): void => {
    if (scope === 'global') {
      onConfirm({ scope: 'global' });
      return;
    }
    if (projectId === null) return;
    onConfirm({ scope: 'project', projectId });
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="sm">
      <ModalHeader>Save workflow</ModalHeader>
      <ModalBody>
        <div className="flex flex-col gap-3">
          {/* Option 1 — Save globally (default / primary). */}
          <label
            className="flex cursor-pointer items-start gap-2.5 rounded-input border border-border-primary bg-bg-primary p-2.5"
            data-testid="save-scope-global-option"
          >
            <input
              type="radio"
              name="save-scope"
              checked={scope === 'global'}
              onChange={() => setScope('global')}
              className="mt-0.5"
              data-testid="save-scope-global-radio"
            />
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-medium text-text-primary">Save globally</span>
              <span className="text-xs text-text-tertiary">
                Update the shared flow for all projects.
              </span>
            </span>
          </label>

          {/* Option 2 — Create a project-specific copy. */}
          <label
            className={
              'flex items-start gap-2.5 rounded-input border border-border-primary bg-bg-primary p-2.5 ' +
              (canCopy ? 'cursor-pointer' : 'cursor-not-allowed opacity-50')
            }
            data-testid="save-scope-project-option"
          >
            <input
              type="radio"
              name="save-scope"
              checked={scope === 'project'}
              disabled={!canCopy}
              onChange={() => setScope('project')}
              className="mt-0.5"
              data-testid="save-scope-project-radio"
            />
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm font-medium text-text-primary">
                Create a project-specific copy
              </span>
              <span className="text-xs text-text-tertiary">
                Fork into a new flow scoped to one project; the global flow is left
                unchanged.
              </span>
              {scope === 'project' && canCopy && (
                <select
                  aria-label="Target project for the copy"
                  data-testid="save-scope-project-select"
                  value={projectId === null ? '' : String(projectId)}
                  onChange={(e) =>
                    setProjectId(e.target.value === '' ? null : Number(e.target.value))
                  }
                  className="mt-1 rounded-button border border-border-primary bg-bg-primary px-2.5 py-1 font-mono text-xs text-text-secondary transition-colors hover:border-border-emphasized hover:text-text-primary focus:border-border-emphasized focus:outline-none"
                >
                  <option value="">Choose a project…</option>
                  {projects.map((project) => (
                    <option key={project.id} value={String(project.id)}>
                      {project.name}
                    </option>
                  ))}
                </select>
              )}
            </span>
          </label>
        </div>
      </ModalBody>
      <ModalFooter>
        <button
          type="button"
          onClick={onClose}
          className="rounded-button border border-border-primary bg-bg-primary px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-bg-hover"
          data-testid="save-scope-cancel"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleConfirm}
          disabled={confirmDisabled}
          className="rounded-button bg-interactive px-3 py-1.5 text-sm font-medium text-text-on-interactive hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="save-scope-confirm"
        >
          Save
        </button>
      </ModalFooter>
    </Modal>
  );
}
