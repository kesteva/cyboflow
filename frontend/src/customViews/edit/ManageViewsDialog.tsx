/**
 * ManageViewsDialog — rename / delete saved views (docs/proposals/CUSTOM-VIEWS.md
 * §6). Opened from the switcher's "Manage views…" footer. Default is not a
 * stored row, so it is never listed here — there is nothing to rename or
 * delete. A CORRUPT view (an unparsable `layout_json`, flagged by the store
 * per §3.3) cannot be renamed (there is no revision-safe way to send it a
 * `name` without a layout the server can round-trip), but it CAN be deleted —
 * this is the one place that ever becomes possible, matching the store's
 * "offer to delete rather than hide" policy for corrupt rows.
 */
import React, { useState } from 'react';
import { Modal, ModalBody, ModalHeader } from '../../components/ui/Modal';
import { EmptyStrip, GhostButton, SecondaryButton } from '../../components/landing/QueuePrimitives';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { isUsableView, useCustomViewsStore, type ViewEntry } from '../../stores/customViewsStore';
import type { CustomViewSurface } from '../../../../shared/types/customViews';

export interface ManageViewsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  surface: CustomViewSurface;
}

/** ManageViewsDialog — see {@link ManageViewsDialogProps}. */
export function ManageViewsDialog({ isOpen, onClose, surface }: ManageViewsDialogProps): React.JSX.Element {
  const views = useCustomViewsStore((s) => s.viewsBySurface[surface]);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const startRename = (view: ViewEntry): void => {
    if (!isUsableView(view)) return;
    setRenamingId(view.id);
    setRenameValue(view.name);
    setRenameError(null);
  };

  const submitRename = async (): Promise<void> => {
    if (renamingId === null) return;
    const trimmed = renameValue.trim();
    if (trimmed.length === 0) {
      setRenameError('Name is required.');
      return;
    }
    const duplicate = views.some(
      (v) => v.id !== renamingId && isUsableView(v) && v.name.toLowerCase() === trimmed.toLowerCase(),
    );
    if (duplicate) {
      setRenameError('A view with that name already exists.');
      return;
    }
    const result = await useCustomViewsStore.getState().renameView(renamingId, trimmed);
    if (result.ok) {
      setRenamingId(null);
      setRenameError(null);
    } else {
      setRenameError(result.error === 'name_taken' ? 'A view with that name already exists.' : result.error);
    }
  };

  const confirmDelete = async (): Promise<void> => {
    if (deletingId === null) return;
    await useCustomViewsStore.getState().deleteView(deletingId);
    setDeletingId(null);
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="sm" showCloseButton={false}>
      <ModalHeader title="Manage views" onClose={onClose} />
      <ModalBody>
        {views.length === 0 ? (
          <EmptyStrip testId="manage-views-empty">No saved views yet.</EmptyStrip>
        ) : (
          <div className="flex flex-col gap-2">
            {views.map((view) => (
              <div
                key={view.id}
                className="flex items-center gap-2 border border-border-primary px-2.5 py-1.5"
                data-testid={`manage-view-row-${view.id}`}
              >
                {renamingId === view.id ? (
                  <>
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void submitRename();
                        if (e.key === 'Escape') setRenamingId(null);
                      }}
                      className="flex-1 border border-border-primary bg-surface-primary px-2 py-1 text-[12px]"
                      data-testid="manage-view-rename-input"
                    />
                    <SecondaryButton onClick={() => void submitRename()} data-testid="manage-view-rename-submit">
                      Save
                    </SecondaryButton>
                    <GhostButton onClick={() => setRenamingId(null)}>Cancel</GhostButton>
                  </>
                ) : (
                  <>
                    <span className="min-w-0 flex-1 truncate text-[12px] text-text-primary">
                      {isUsableView(view) ? view.name : `${view.name} (corrupt)`}
                    </span>
                    {isUsableView(view) && (
                      <GhostButton onClick={() => startRename(view)} data-testid={`manage-view-rename-${view.id}`}>
                        Rename
                      </GhostButton>
                    )}
                    <GhostButton onClick={() => setDeletingId(view.id)} data-testid={`manage-view-delete-${view.id}`}>
                      Delete
                    </GhostButton>
                  </>
                )}
              </div>
            ))}
            {renamingId !== null && renameError !== null && (
              <p className="text-[11px] text-status-error" data-testid="manage-view-rename-error">
                {renameError}
              </p>
            )}
          </div>
        )}
      </ModalBody>
      <ConfirmDialog
        isOpen={deletingId !== null}
        onClose={() => setDeletingId(null)}
        onConfirm={() => void confirmDelete()}
        title="Delete view?"
        message="This cannot be undone."
        confirmText="Delete"
      />
    </Modal>
  );
}
