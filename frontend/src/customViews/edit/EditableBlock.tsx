/**
 * EditableBlock — the direct-manipulation wrapper every layout item renders
 * inside while customizing (docs/proposals/CUSTOM-VIEWS.md §6).
 *
 * A thin chrome strip (grip / title / hidden pill / eye / gear / trash) over
 * whatever `ViewSurface` would have rendered anyway (a section, a
 * `WidgetHost`, or nothing when hidden). Reordering is native HTML5
 * drag-and-drop on the grip, with ↑/↓ on the same grip as the keyboard
 * equivalent — both call the store's `moveItem` with the same semantics, so a
 * screen-reader user and a mouse user end up at the same place.
 *
 * The block resolves its own title and spec from the store (`item.widget` is
 * enough) rather than having `ViewSurface` compute and thread them down —
 * `ViewSurface` only has to hand over the item, its position, and the live
 * payload (which ONLY it can see, via `WidgetHost`'s `onPayload`).
 */
import React, { useState } from 'react';
import { Eye, EyeOff, GripVertical, Settings, Trash2 } from 'lucide-react';
import { Chip, GhostButton } from '../../components/landing/QueuePrimitives';
import { useCustomViewsStore } from '../../stores/customViewsStore';
import { catalogEntry } from '../catalog';
import { WidgetSettingsPopover } from './WidgetSettingsPopover';
import type { LayoutItem, WidgetDataPayload } from '../../../../shared/types/customViews';

export interface EditableBlockProps {
  item: LayoutItem;
  index: number;
  total: number;
  /** The item's latest run payload (from `WidgetHost`'s `onPayload`), or `null` for a section / not-yet-loaded. */
  payload: WidgetDataPayload | null;
  /** The item's rendered body — `null` while hidden (the collapsed strip replaces it). */
  children: React.ReactNode;
}

/** EditableBlock — see {@link EditableBlockProps}. */
export function EditableBlock({ item, index, total, payload, children }: EditableBlockProps): React.JSX.Element {
  const resolveWidgetSpec = useCustomViewsStore((s) => s.resolveWidgetSpec);
  const widgets = useCustomViewsStore((s) => s.widgets);
  const spec = resolveWidgetSpec(item.widget);
  const entry = item.widget.type === 'catalog' ? catalogEntry(item.widget.catalogId) : null;
  const hidden = item.hidden === true;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const customRef = item.widget.type === 'custom' ? item.widget : null;
  const title =
    item.title ??
    entry?.title ??
    (customRef !== null ? (widgets.find((w) => w.id === customRef.widgetId)?.name ?? 'Custom widget') : 'Widget');

  const move = (from: number, to: number): void => {
    if (to < 0 || to >= total) return;
    useCustomViewsStore.getState().moveItem(from, to);
  };

  const onDragStart = (e: React.DragEvent<HTMLButtonElement>): void => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
  };
  const onDragOver = (e: React.DragEvent<HTMLDivElement>): void => {
    if (!e.dataTransfer.types.includes('text/plain')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOver(true);
  };
  const onDragLeave = (): void => setDragOver(false);
  const onDrop = (e: React.DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setDragOver(false);
    const from = Number(e.dataTransfer.getData('text/plain'));
    if (!Number.isNaN(from)) move(from, index);
  };
  const onGripKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(index, index - 1);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(index, index + 1);
    }
  };

  return (
    <div
      data-testid={`editable-block-${item.instanceId}`}
      className={`flex flex-col gap-1.5 border border-dashed p-2 transition-colors ${
        dragOver ? 'border-interactive bg-interactive/5' : 'border-border-primary'
      }`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          aria-label="Reorder"
          draggable
          onDragStart={onDragStart}
          onKeyDown={onGripKeyDown}
          className="cursor-grab text-text-tertiary hover:text-text-primary focus:outline-none focus:ring-1 focus:ring-interactive"
          data-testid={`editable-grip-${item.instanceId}`}
        >
          <GripVertical className="h-3.5 w-3.5" />
        </button>
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-text-secondary">{title}</span>
        {hidden && <Chip>Hidden</Chip>}
        <GhostButton
          onClick={() => useCustomViewsStore.getState().toggleHidden(item.instanceId)}
          title={hidden ? 'Show' : 'Hide'}
          data-testid={`editable-eye-${item.instanceId}`}
        >
          {hidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </GhostButton>
        <GhostButton onClick={() => setSettingsOpen(true)} title="Settings" data-testid={`editable-gear-${item.instanceId}`}>
          <Settings className="h-3.5 w-3.5" />
        </GhostButton>
        <GhostButton
          onClick={() => useCustomViewsStore.getState().removeItem(item.instanceId)}
          title="Remove"
          data-testid={`editable-trash-${item.instanceId}`}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </GhostButton>
      </div>

      {hidden ? (
        <div className="border border-dashed border-border-primary bg-surface-sunken px-3 py-2 text-[11px] text-text-tertiary">
          Hidden — click the eye to show it again.
        </div>
      ) : (
        children
      )}

      <WidgetSettingsPopover
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        item={item}
        spec={spec}
        entry={entry}
        payload={payload}
      />
    </div>
  );
}
