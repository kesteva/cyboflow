/**
 * SaveDiscardControls — the Save / Save as… / Discard cluster customize mode
 * shows in place of the switcher + Customize button
 * (docs/proposals/CUSTOM-VIEWS.md §6). Shared by `ViewHeaderControls` (the
 * header slot) and `DraftBanner` (the strip under it, "for tall pages") so
 * the two never drift on what each button does.
 *
 * **Save** (primary): when the draft has a `baseViewId` (customizing an
 * existing view), it CAS-updates that view in place under its current name —
 * no dialog, exactly like an ordinary save button. When the draft started
 * from Default (`baseViewId === null`) there is nothing to update in place,
 * so Save opens the same naming dialog as **Save as…**.
 *
 * **Discard**: a `ConfirmDialog` (own local state, so two mounted instances —
 * header + banner — never share one open/closed flag). Only ONE instance
 * should own the global Escape-to-discard shortcut (`ownsEscapeShortcut`),
 * because Escape is a single keypress: two listeners would both react to it
 * and open two confirm dialogs. `ViewHeaderControls` is the one that is
 * always mounted whenever a draft exists (it is what opens customize mode),
 * so it is the one that sets the flag.
 */
import React, { useEffect, useState } from 'react';
import { GhostButton, PrimaryButton, SecondaryButton } from '../../components/landing/QueuePrimitives';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { isUsableView, useCustomViewsStore, useDraft } from '../../stores/customViewsStore';
import type { CustomViewSurface } from '../../../../shared/types/customViews';
import { SaveViewDialog } from './SaveViewDialog';

export interface SaveDiscardControlsProps {
  surface: CustomViewSurface;
  /** Registers the document-level "Escape with no dialog open → prompt Discard" shortcut. */
  ownsEscapeShortcut?: boolean;
}

/** SaveDiscardControls — see {@link SaveDiscardControlsProps}. */
export function SaveDiscardControls({ surface, ownsEscapeShortcut = false }: SaveDiscardControlsProps): React.JSX.Element | null {
  const draft = useDraft(surface);
  const views = useCustomViewsStore((s) => s.viewsBySurface[surface]);
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const baseView = draft?.baseViewId !== undefined && draft?.baseViewId !== null ? views.find((v) => v.id === draft.baseViewId) : undefined;
  const baseName = baseView !== undefined && isUsableView(baseView) ? baseView.name : null;

  // Escape-to-discard: only while THIS instance owns the shortcut, only while
  // customizing, and only when no other Custom Views dialog (all portaled
  // `Modal`s, which render `role="dialog"`) is currently on top.
  useEffect(() => {
    if (!ownsEscapeShortcut || draft === null) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      if (confirmDiscardOpen || saveAsOpen) return;
      if (document.querySelector('[role="dialog"]') !== null) return;
      setConfirmDiscardOpen(true);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [ownsEscapeShortcut, draft, confirmDiscardOpen, saveAsOpen]);

  if (draft === null) return null;

  const handleSave = async (): Promise<void> => {
    if (draft.baseViewId === null || baseName === null) {
      setSaveAsOpen(true);
      return;
    }
    setSaving(true);
    await useCustomViewsStore.getState().save({ mode: 'update', name: baseName, setActive: true });
    setSaving(false);
  };

  return (
    <div className="flex items-center gap-2">
      {draft.saveError !== null && (
        <span className="text-[11px] text-status-error" data-testid="draft-save-error">
          {draft.saveError === 'concurrency'
            ? 'This view changed elsewhere — save as new or discard.'
            : `Could not save (${draft.saveError}).`}
        </span>
      )}
      <PrimaryButton onClick={() => void handleSave()} disabled={saving} data-testid="draft-save">
        Save
      </PrimaryButton>
      {draft.baseViewId !== null && (
        <SecondaryButton onClick={() => setSaveAsOpen(true)} data-testid="draft-save-as">
          Save as…
        </SecondaryButton>
      )}
      <GhostButton onClick={() => setConfirmDiscardOpen(true)} data-testid="draft-discard">
        Discard
      </GhostButton>

      <SaveViewDialog
        isOpen={saveAsOpen}
        onClose={() => setSaveAsOpen(false)}
        surface={surface}
        initialName={baseName !== null ? `${baseName} copy` : ''}
      />
      <ConfirmDialog
        isOpen={confirmDiscardOpen}
        onClose={() => setConfirmDiscardOpen(false)}
        onConfirm={() => useCustomViewsStore.getState().discard()}
        title="Discard changes?"
        message="Your unsaved customization will be lost."
        confirmText="Discard"
      />
    </div>
  );
}
