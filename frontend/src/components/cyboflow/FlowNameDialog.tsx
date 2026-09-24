/**
 * FlowNameDialog — a small in-app name-entry dialog for the workflow editor.
 *
 * Replaces window.prompt() (which throws "prompt() is not supported." in
 * Electron's renderer) with a controlled-text-input Modal. Follows the
 * NewTaskDialog pattern: managed name/error state, trim + non-empty validation
 * with an inline error. Enter = confirm / Esc = cancel are handled by Modal's
 * keyboard handling.
 *
 * Optional SCOPE selector (TASK-220): when `scopeProjects` is passed, an
 * inline Global/project `<select>` (mirroring {@link GalleryNew}'s scope
 * control) sits alongside the name input, and `onConfirm`'s second argument
 * carries the chosen target (`null` ⇒ global). Without `scopeProjects` the
 * selector is omitted and the second argument is always `null` — the create-
 * mode "Run with modifications" name prompt doesn't need it (its scope was
 * already decided in GalleryNew).
 */
import { useEffect, useState } from 'react';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '../ui/Modal';

/** A project the new flow can be scoped to — the minimal shape the picker needs. */
export interface FlowNameDialogScopeProject {
  id: number;
  name: string;
}

interface FlowNameDialogProps {
  isOpen: boolean;
  title: string;
  defaultValue: string;
  confirmLabel: string;
  /**
   * Projects offered by the scope selector. `undefined` ⇒ no selector is
   * shown (the caller doesn't need a scope choice); an array (even empty)
   * shows the selector with Global plus these project options.
   */
  scopeProjects?: FlowNameDialogScopeProject[];
  /** Preselected scope for the selector — typically the source flow's own scope. */
  defaultScopeProjectId?: number | null;
  /**
   * Called with the trimmed, validated (non-empty) name and the chosen scope
   * (`null` ⇒ global). The scope is always `null` when no selector is shown.
   */
  onConfirm: (name: string, scopeProjectId: number | null) => void;
  onClose: () => void;
  /**
   * A failure reported by the caller AFTER `onConfirm` (e.g. the `createCustom`
   * reserved-name / name-collision guards, TASK-220). Rendered inside the
   * dialog — which stays open with the typed name and chosen scope intact —
   * since this modal's overlay covers any error banner the host renders
   * behind it. Hidden again as soon as the user edits the name or scope; a
   * retry that fails with the same text re-shows it because the caller
   * clears and re-sets it around each attempt.
   */
  serverError?: string | null;
}

/** Sentinel `<option>` value for the GLOBAL (null scope) choice. */
const GLOBAL_SCOPE_VALUE = 'global';

export function FlowNameDialog({
  isOpen,
  title,
  defaultValue,
  confirmLabel,
  scopeProjects,
  defaultScopeProjectId = null,
  onConfirm,
  onClose,
  serverError = null,
}: FlowNameDialogProps): React.JSX.Element {
  const [name, setName] = useState(defaultValue);
  const [error, setError] = useState<string | null>(null);
  const [scopeProjectId, setScopeProjectId] = useState<number | null>(defaultScopeProjectId);
  // Whether the caller's `serverError` is still shown: an edit to the name or
  // scope hides it (the user is acting on it); a NEW serverError value re-shows.
  const [showServerError, setShowServerError] = useState(true);

  useEffect(() => {
    setShowServerError(true);
  }, [serverError]);

  // Re-seed the input each time the dialog (re)opens, so a fresh open never
  // shows the previous entry.
  useEffect(() => {
    if (isOpen) {
      setName(defaultValue);
      setError(null);
      setScopeProjectId(defaultScopeProjectId);
    }
  }, [isOpen, defaultValue, defaultScopeProjectId]);

  const handleConfirm = (): void => {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setError('A workflow name is required.');
      return;
    }
    // Clear a stale local validation error from an earlier empty-name attempt
    // so a corrected, now-valid submission doesn't permanently mask a later
    // server-side rejection (the render guard below is `!error && ...`).
    setError(null);
    onConfirm(trimmed, scopeProjectId);
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="sm">
      <ModalHeader>{title}</ModalHeader>
      <ModalBody>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
            Name
            <input
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
                setShowServerError(false);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleConfirm();
                }
              }}
              placeholder="flow name"
              className="rounded-input border border-border-primary bg-input-bg px-2 py-1.5 text-sm text-input-text placeholder:text-input-placeholder"
              aria-label="Workflow name"
              data-testid="flow-name-input"
              autoFocus
            />
          </label>

          {scopeProjects !== undefined && (
            <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
              Scope
              <select
                aria-label="Scope for the new workflow"
                data-testid="flow-name-scope-select"
                value={scopeProjectId === null ? GLOBAL_SCOPE_VALUE : String(scopeProjectId)}
                onChange={(e) => {
                  setScopeProjectId(
                    e.target.value === GLOBAL_SCOPE_VALUE ? null : Number(e.target.value),
                  );
                  setShowServerError(false);
                }}
                className="rounded-button border border-border-primary bg-bg-primary px-2.5 py-1.5 font-mono text-xs text-text-secondary transition-colors hover:border-border-emphasized hover:text-text-primary focus:border-border-emphasized focus:outline-none"
              >
                <option value={GLOBAL_SCOPE_VALUE}>All projects (global)</option>
                {scopeProjects.map((project) => (
                  <option key={project.id} value={String(project.id)}>
                    Only {project.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          {error && (
            <p className="text-xs text-status-error" role="alert">
              {error}
            </p>
          )}

          {!error && showServerError && serverError && (
            <p
              className="text-xs text-status-error"
              role="alert"
              data-testid="flow-name-server-error"
            >
              {serverError}
            </p>
          )}
        </div>
      </ModalBody>
      <ModalFooter>
        <button
          type="button"
          onClick={onClose}
          className="rounded-button border border-border-primary bg-bg-primary px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-bg-hover"
          data-testid="flow-name-cancel"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleConfirm}
          disabled={name.trim().length === 0}
          className="rounded-button bg-interactive px-3 py-1.5 text-sm font-medium text-text-on-interactive hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="flow-name-confirm"
        >
          {confirmLabel}
        </button>
      </ModalFooter>
    </Modal>
  );
}
