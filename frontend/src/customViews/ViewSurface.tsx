/**
 * ViewSurface — the render tail both landing-family pages hand their sections
 * to (docs/proposals/CUSTOM-VIEWS.md §5.2).
 *
 * The page keeps everything it already owned: its early returns, its header,
 * its dialogs, every section component and every prop and callback those
 * components take. What changes is only the ORDER those section nodes are
 * emitted in, and whether extra widgets are interleaved. That is the whole
 * refactor, and it is why the page passes a `Record<sectionId, ReactNode|null>`
 * rather than JSX: a map can be reordered, JSX cannot.
 *
 * ## Default mode is the page, not a reconstruction of it
 *
 * With no custom view active — and equally while the store has not loaded yet,
 * so there is never a flash of empty — the surface emits `chrome.afterHeader`,
 * then the canonical section order from the catalog, each `null` entry
 * rendering nothing exactly as the page's own conditional did. Section nodes
 * are emitted BARE, inside fragments: no wrapper element, so the flex column's
 * `gap` and every existing DOM query keep working.
 *
 * ## Chrome: two slots, and why
 *
 * The plan sketched a single `afterHeader` slot for the page's state wells. The
 * queue's wells are not all adjacent to the header: the caught-up / all-idle
 * strips sit BELOW the usage cards, and the "no sessions" well sits between
 * Recommended actions and the session sections. Collapsing them into
 * `afterHeader` would silently reorder the Default view, which is precisely the
 * thing §5.2 forbids. So chrome has a second slot, `afterSection`, keyed by the
 * section id the chrome currently follows:
 *
 *   - `afterHeader` renders once, first, always.
 *   - `afterSection[id]` renders immediately after section `id`.
 *
 * In a CUSTOM view a chrome anchor may not be placed at all. Page state wells
 * are not decoration — "you are all caught up" is the page's answer to its own
 * question — so they are never dropped: anchored chrome whose section is absent
 * from the layout (or hidden) falls back into the top block, right after
 * `afterHeader`, in canonical section order. Anchored chrome whose section IS
 * placed still trails it.
 *
 * ## Custom mode
 *
 * Layout items render in order. `hidden` renders nothing. A catalog SECTION ref
 * pulls its node from `sections`; a ref this surface does not own (a `queue.*`
 * id on the overview page, or a catalog id this build dropped) renders the
 * "not available" chip rather than vanishing, so the user can see why their
 * view looks short. Everything else mounts a `WidgetHost`.
 */
import React, { Fragment, useEffect, useMemo, type ReactNode } from 'react';
import type { CustomViewSurface, LayoutItem } from '../../../shared/types/customViews';
import { catalogEntry, sectionOrderFor } from './catalog';
import { useActiveView, useCustomViewsStore, useSurfaceLoaded } from '../stores/customViewsStore';
import { ViewIdentityContext, type ViewIdentity } from './viewContext';
import { WidgetFrame, UnavailableBody } from './WidgetFrame';
import { WidgetHost } from './WidgetHost';

export interface ViewSurfaceChrome {
  /** Page chrome rendered once, before every section. */
  afterHeader?: ReactNode;
  /** Page chrome rendered immediately after the named section. */
  afterSection?: Record<string, ReactNode | null | undefined>;
}

export interface ViewSurfaceProps {
  surface: CustomViewSurface;
  /** Every section this page can render, by catalog id. `null` = "off right now". */
  sections: Record<string, ReactNode | null>;
  /** Run context handed to every widget's query and action. */
  context: { projectId: number | null };
  chrome?: ViewSurfaceChrome;
}

/** True when the page declared this section id at all (a `null` value counts). */
function declares(sections: Record<string, ReactNode | null>, id: string): boolean {
  return Object.prototype.hasOwnProperty.call(sections, id);
}

/** ViewSurface — see {@link ViewSurfaceProps}. */
export function ViewSurface({
  surface,
  sections,
  context,
  chrome,
}: ViewSurfaceProps): React.JSX.Element {
  // Ref-counted: both landing pages may be mounted at once and each holds its
  // own release.
  useEffect(() => useCustomViewsStore.getState().init(surface), [surface]);

  const activeView = useActiveView(surface);
  const loaded = useSurfaceLoaded(surface);
  const order = sectionOrderFor(surface);

  const identity: ViewIdentity = useMemo(
    () => ({
      viewId: activeView?.id ?? null,
      viewRevision: activeView?.revision ?? null,
      editing: false, // S5 flips this in customize mode.
    }),
    [activeView],
  );

  // Not loaded yet, Default selected, or the active view turned out corrupt →
  // the page as it has always been.
  const items = loaded && activeView !== null ? activeView.layout.items : null;

  const body =
    items === null
      ? renderDefault(order, sections, chrome)
      : renderCustom(items, order, sections, context, chrome);

  return <ViewIdentityContext.Provider value={identity}>{body}</ViewIdentityContext.Provider>;
}

// ---------------------------------------------------------------------------
// Default mode
// ---------------------------------------------------------------------------

function renderDefault(
  order: readonly string[],
  sections: Record<string, ReactNode | null>,
  chrome: ViewSurfaceChrome | undefined,
): React.JSX.Element {
  const afterSection = chrome?.afterSection;
  return (
    <>
      {chrome?.afterHeader}
      {order.map((id) => {
        const node = sections[id] ?? null;
        const trailing = afterSection?.[id] ?? null;
        if (node === null && trailing === null) return null;
        return (
          <Fragment key={id}>
            {node}
            {trailing}
          </Fragment>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// Custom mode
// ---------------------------------------------------------------------------

function renderCustom(
  items: LayoutItem[],
  order: readonly string[],
  sections: Record<string, ReactNode | null>,
  context: { projectId: number | null },
  chrome: ViewSurfaceChrome | undefined,
): React.JSX.Element {
  const afterSection = chrome?.afterSection;

  // Which chrome anchors this layout actually places (visible section refs).
  const placedAnchors = new Set<string>();
  for (const item of items) {
    if (item.hidden === true) continue;
    if (item.widget.type !== 'catalog') continue;
    if (!declares(sections, item.widget.catalogId)) continue;
    placedAnchors.add(item.widget.catalogId);
  }

  const orphanedChrome = order.filter(
    (id) => !placedAnchors.has(id) && (afterSection?.[id] ?? null) !== null,
  );

  return (
    <>
      {chrome?.afterHeader}
      {orphanedChrome.map((id) => (
        <Fragment key={`chrome:${id}`}>{afterSection?.[id]}</Fragment>
      ))}
      {items.map((item) => {
        const anchorId =
          item.hidden !== true && item.widget.type === 'catalog' && placedAnchors.has(item.widget.catalogId)
            ? item.widget.catalogId
            : null;
        return (
          <Fragment key={item.instanceId}>
            {renderItem(item, sections, context)}
            {anchorId !== null ? (afterSection?.[anchorId] ?? null) : null}
          </Fragment>
        );
      })}
    </>
  );
}

function renderItem(
  item: LayoutItem,
  sections: Record<string, ReactNode | null>,
  context: { projectId: number | null },
): ReactNode {
  if (item.hidden === true) return null;

  if (item.widget.type === 'catalog') {
    const id = item.widget.catalogId;
    const entry = catalogEntry(id);
    // Tier-2 spec widget: run it.
    if (entry !== null && entry.spec !== undefined) {
      return <WidgetHost item={item} context={context} />;
    }
    // Tier-1 section this page renders (a declared `null` means "off in this
    // page state" — same as the page's own conditional).
    if (declares(sections, id)) return sections[id];
    // A section from the other surface, or an id this build dropped.
    return unavailable(item, entry?.title ?? id);
  }

  return <WidgetHost item={item} context={context} />;
}

function unavailable(item: LayoutItem, title: string): React.JSX.Element {
  return (
    <WidgetFrame title={item.title ?? title} testId={`widget-frame-${item.instanceId}`}>
      <UnavailableBody reason="Not available on this page" />
    </WidgetFrame>
  );
}
