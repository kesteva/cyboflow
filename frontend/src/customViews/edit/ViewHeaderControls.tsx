/**
 * ViewHeaderControls — the header-right cluster on both landing-family pages
 * (docs/proposals/CUSTOM-VIEWS.md §6, the "View switcher" artboard). Renders
 * the view switcher + Customize button OUTSIDE customize mode, and hands off
 * to `SaveDiscardControls` (Save / Save as… / Discard) once a draft is open —
 * the same slot, so the cluster never jumps position when entering/leaving
 * customize mode.
 *
 * This is the instance that owns the Escape-to-discard shortcut
 * (`SaveDiscardControls`'s `ownsEscapeShortcut`): both pages always mount this
 * component in their header (it's what opens customize mode in the first
 * place), so it is guaranteed to be alive for the whole time a draft can
 * exist — `DraftBanner`, mounted only conditionally under the header, is not.
 */
import React, { useState } from 'react';
import { ChevronDown, Layers } from 'lucide-react';
import { SecondaryButton } from '../../components/landing/QueuePrimitives';
import { Dropdown, type DropdownItem } from '../../components/ui/Dropdown';
import { isUsableView, useCustomViewsStore, useIsCustomizing } from '../../stores/customViewsStore';
import { DEFAULT_VIEW_ID, type CustomViewSurface } from '../../../../shared/types/customViews';
import { SaveDiscardControls } from './SaveDiscardControls';
import { ManageViewsDialog } from './ManageViewsDialog';

export interface ViewHeaderControlsProps {
  surface: CustomViewSurface;
}

/** ViewHeaderControls — see {@link ViewHeaderControlsProps}. */
export function ViewHeaderControls({ surface }: ViewHeaderControlsProps): React.JSX.Element {
  const isCustomizing = useIsCustomizing(surface);

  if (isCustomizing) {
    return <SaveDiscardControls surface={surface} ownsEscapeShortcut />;
  }

  return <ViewSwitcherAndCustomize surface={surface} />;
}

function ViewSwitcherAndCustomize({ surface }: { surface: CustomViewSurface }): React.JSX.Element {
  const views = useCustomViewsStore((s) => s.viewsBySurface[surface]);
  const activeViewId = useCustomViewsStore((s) => s.activeViewIdBySurface[surface]);
  const [manageOpen, setManageOpen] = useState(false);

  const activeEntry = views.find((v) => v.id === activeViewId);
  const activeLabel =
    activeViewId === DEFAULT_VIEW_ID || activeEntry === undefined || !isUsableView(activeEntry)
      ? 'Default'
      : activeEntry.name;

  const items: DropdownItem[] = [
    {
      id: DEFAULT_VIEW_ID,
      label: 'Default',
      onClick: () => void useCustomViewsStore.getState().setActive(surface, DEFAULT_VIEW_ID),
    },
    ...views.map(
      (view): DropdownItem => ({
        id: view.id,
        label: isUsableView(view) ? view.name : `${view.name} (corrupt)`,
        disabled: !isUsableView(view),
        variant: isUsableView(view) ? 'default' : 'danger',
        onClick: () => void useCustomViewsStore.getState().setActive(surface, view.id),
      }),
    ),
  ];

  return (
    <div className="flex items-center gap-2">
      <Dropdown
        trigger={
          <SecondaryButton onClick={() => {}} data-testid="view-switcher-trigger">
            <span className="flex items-center gap-1.5">
              <Layers className="h-3 w-3" />
              {activeLabel}
              <ChevronDown className="h-3 w-3" />
            </span>
          </SecondaryButton>
        }
        items={items}
        selectedId={activeViewId}
        width="md"
        footer={
          <button
            type="button"
            className="w-full px-3 py-2 text-left text-[11px] text-text-secondary transition-colors hover:text-text-primary"
            onClick={() => setManageOpen(true)}
            data-testid="manage-views-open"
          >
            Manage views…
          </button>
        }
      />
      <SecondaryButton
        onClick={() => useCustomViewsStore.getState().enterCustomize(surface)}
        data-testid="customize-button"
      >
        Customize
      </SecondaryButton>
      <ManageViewsDialog isOpen={manageOpen} onClose={() => setManageOpen(false)} surface={surface} />
    </div>
  );
}
