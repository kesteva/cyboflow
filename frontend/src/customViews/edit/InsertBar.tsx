/**
 * InsertBar — the "+ Add widget" bar between (and around) editable blocks
 * (docs/proposals/CUSTOM-VIEWS.md §6). Opens `WidgetLibraryModal` pinned to
 * this bar's insertion index; the modal itself calls `insertItem(at, ref)`
 * and closes on a successful add.
 */
import React, { useState } from 'react';
import { Plus } from 'lucide-react';
import type { CustomViewSurface } from '../../../../shared/types/customViews';
import { WidgetLibraryModal } from './WidgetLibraryModal';

export interface InsertBarProps {
  surface: CustomViewSurface;
  /** The layout index a widget added here lands at. */
  at: number;
  /** Optional S6 hook — see `WidgetLibraryModal`'s `onCreateCustom`. */
  onCreateCustom?: (at: number) => void;
}

/** InsertBar — see {@link InsertBarProps}. */
export function InsertBar({ surface, at, onCreateCustom }: InsertBarProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div data-testid={`insert-bar-${at}`}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center justify-center gap-1.5 border border-dashed border-border-primary py-1 text-[10px] font-semibold uppercase tracking-[0.06em] text-text-tertiary transition-colors hover:border-interactive hover:text-interactive"
      >
        <Plus className="h-3 w-3" /> Add widget
      </button>
      <WidgetLibraryModal
        isOpen={open}
        onClose={() => setOpen(false)}
        surface={surface}
        insertAt={at}
        onCreateCustom={onCreateCustom}
      />
    </div>
  );
}
