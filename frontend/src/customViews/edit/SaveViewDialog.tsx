/**
 * SaveViewDialog — names a NEW view for the open draft (docs/proposals/CUSTOM-VIEWS.md
 * §6, the "Save view" artboard). Always saves `mode:'new'`: an in-place update
 * of an existing view has no name to pick, so it never opens this dialog (see
 * `SaveDiscardControls`'s primary Save button).
 *
 * Validates client-side (non-empty, ≤60 chars, not a case-insensitive
 * duplicate among the surface's existing view names) before ever calling the
 * store, so the common mistakes never round-trip to the server; a duplicate
 * the client missed (a save elsewhere landed between the check and the click)
 * still surfaces because the store's `save` keeps the draft and sets
 * `draft.saveError` on failure, which this dialog also renders.
 */
import React, { useEffect, useState } from 'react';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../../components/ui/Modal';
import { PrimaryButton, SecondaryButton } from '../../components/landing/QueuePrimitives';
import { Toggle } from '../../components/ui/Toggle';
import { isUsableView, useCustomViewsStore, useDraft } from '../../stores/customViewsStore';
import type { CustomViewSurface } from '../../../../shared/types/customViews';

export interface SaveViewDialogProps {
  isOpen: boolean;
  onClose: () => void;
  surface: CustomViewSurface;
  /** Pre-filled name — e.g. "<current view> copy" when saving a variant of an existing view. */
  initialName?: string;
}

/** SaveViewDialog — see {@link SaveViewDialogProps}. */
export function SaveViewDialog({ isOpen, onClose, surface, initialName = '' }: SaveViewDialogProps): React.JSX.Element {
  const draft = useDraft(surface);
  const views = useCustomViewsStore((s) => s.viewsBySurface[surface]);

  const [name, setName] = useState(initialName);
  const [setActive, setSetActive] = useState(true);
  const [localError, setLocalError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setName(initialName);
      setLocalError(null);
    }
  }, [isOpen, initialName]);

  const submit = async (): Promise<void> => {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setLocalError('Name is required.');
      return;
    }
    if (trimmed.length > 60) {
      setLocalError('Name must be at most 60 characters.');
      return;
    }
    const duplicate = views.some((v) => isUsableView(v) && v.name.toLowerCase() === trimmed.toLowerCase());
    if (duplicate) {
      setLocalError('A view with that name already exists.');
      return;
    }
    setLocalError(null);
    setSaving(true);
    await useCustomViewsStore.getState().save({ mode: 'new', name: trimmed, setActive });
    setSaving(false);
    if (useCustomViewsStore.getState().draft === null) {
      onClose();
    }
  };

  const serverError = draft?.saveError ?? null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="sm">
      <ModalHeader title="Save view" onClose={onClose} />
      <ModalBody>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-[11px] text-text-tertiary">
            Name
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit();
              }}
              className="border border-border-primary bg-surface-primary px-2 py-1.5 text-[12px] text-text-primary"
              data-testid="save-view-name"
            />
          </label>
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-text-tertiary">Set as active view</span>
            <Toggle checked={setActive} onChange={setSetActive} size="sm" aria-label="Set as active view" />
          </div>
          {(localError ?? serverError) !== null && (
            <p className="text-[11px] text-status-error" data-testid="save-view-error">
              {localError ?? describeSaveError(serverError as string)}
            </p>
          )}
        </div>
      </ModalBody>
      <ModalFooter>
        <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        <PrimaryButton onClick={() => void submit()} disabled={saving} data-testid="save-view-submit">
          Save
        </PrimaryButton>
      </ModalFooter>
    </Modal>
  );
}

function describeSaveError(code: string): string {
  if (code === 'name_taken') return 'A view with that name already exists.';
  if (code === 'concurrency') return 'This view changed elsewhere — try again.';
  return `Could not save (${code}).`;
}
