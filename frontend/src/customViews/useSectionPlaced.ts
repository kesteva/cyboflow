/**
 * useSectionPlaced — "will this page actually render section X right now?"
 * (docs/proposals/CUSTOM-VIEWS.md §5.2's scroll guards).
 *
 * A page's jump-to-section affordances used to be total: the section always
 * existed, so a null ref just meant "the data has not arrived yet, wait for the
 * next render". Under a custom view a null ref is ambiguous — the section may
 * be absent from the layout entirely, in which case waiting is waiting forever.
 * This hook resolves the ambiguity from the same store `ViewSurface` reads, so
 * the page never has to guess and the two can never disagree.
 *
 * Default mode (including "not loaded yet") answers TRUE for every canonical
 * section: that is the page as it has always been.
 */
import { DEFAULT_VIEW_ID, type CustomViewSurface } from '../../../shared/types/customViews';
import { useCustomViewsStore, isUsableView } from '../stores/customViewsStore';

/** True when the surface's active view places `sectionId` and has not hidden it. */
export function useSectionPlaced(surface: CustomViewSurface, sectionId: string): boolean {
  return useCustomViewsStore((s) => {
    if (!s.loadedSurfaces[surface]) return true;
    const activeId = s.activeViewIdBySurface[surface];
    if (activeId === DEFAULT_VIEW_ID) return true;
    const entry = s.viewsBySurface[surface].find((v) => v.id === activeId);
    if (entry === undefined || !isUsableView(entry)) return true; // falls back to Default
    return entry.layout.items.some(
      (item) =>
        item.hidden !== true && item.widget.type === 'catalog' && item.widget.catalogId === sectionId,
    );
  });
}
