/**
 * DraftBanner — the thin "Customizing · <view> — unsaved" strip under the
 * header while a draft is open (docs/proposals/CUSTOM-VIEWS.md §6). Repeats
 * `SaveDiscardControls` for tall pages, where the header's cluster can scroll
 * out of view before the user is done editing — this strip does not scroll
 * with the content (it sits right under the header, inside the same
 * `chrome.afterHeader`-adjacent slot the page renders it in).
 *
 * Does NOT own the Escape-to-discard shortcut — see `SaveDiscardControls`'s
 * header comment for why only `ViewHeaderControls` does.
 */
import React from 'react';
import { useDraft, useIsCustomizing } from '../../stores/customViewsStore';
import { isUsableView, useCustomViewsStore } from '../../stores/customViewsStore';
import type { CustomViewSurface } from '../../../../shared/types/customViews';
import { SaveDiscardControls } from './SaveDiscardControls';

export interface DraftBannerProps {
  surface: CustomViewSurface;
}

/** DraftBanner — see {@link DraftBannerProps}. `null` outside customize mode. */
export function DraftBanner({ surface }: DraftBannerProps): React.JSX.Element | null {
  const isCustomizing = useIsCustomizing(surface);
  const draft = useDraft(surface);
  const views = useCustomViewsStore((s) => s.viewsBySurface[surface]);

  if (!isCustomizing || draft === null) return null;

  const baseView = draft.baseViewId !== null ? views.find((v) => v.id === draft.baseViewId) : undefined;
  const label =
    baseView !== undefined && isUsableView(baseView) ? baseView.name : draft.baseViewId === null ? 'Default' : 'this view';

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 border border-dashed border-interactive bg-interactive/5 px-3 py-2"
      data-testid="draft-banner"
    >
      <span className="text-[11px] font-semibold text-interactive">Customizing · {label} — unsaved</span>
      <SaveDiscardControls surface={surface} />
    </div>
  );
}
