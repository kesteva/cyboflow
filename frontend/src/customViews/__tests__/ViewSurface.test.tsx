/**
 * ViewSurface — the guarantee the whole Custom Views refactor rests on: the
 * DEFAULT view is the current page, in the current order, with the current
 * conditional gaps (docs/proposals/CUSTOM-VIEWS.md §5.2, §10's "Default view is
 * the current page").
 *
 * The order is asserted for BOTH surfaces by reading the rendered test ids back
 * in DOM order, so a reordering of the canonical arrays fails here rather than
 * in a screenshot. The custom-view cases then pin the three behaviours a layout
 * can produce that Default never does: a widget mounted from a spec ref, a
 * section from the OTHER surface rendered as the "not available" chip, and a
 * hidden item rendering nothing at all.
 *
 * The store is the REAL one, driven through a mocked tRPC client — mocking the
 * store would have let the surface and the store drift on exactly the seed /
 * active-view semantics these tests exist to pin.
 */
import '@testing-library/jest-dom';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import type { CustomView, LayoutItem } from '../../../../shared/types/customViews';

// ---------------------------------------------------------------------------
// Mutable tRPC responses
// ---------------------------------------------------------------------------

let mockViews: CustomView[] = [];
let mockActiveViewId = 'default';
const runWidget = vi.fn();

vi.mock('../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      customViews: {
        listViews: { query: vi.fn(() => Promise.resolve(mockViews)) },
        getActiveView: { query: vi.fn(() => Promise.resolve({ viewId: mockActiveViewId })) },
        listWidgets: { query: vi.fn(() => Promise.resolve([])) },
        onWidgetDraft: { subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })) },
        runWidget: { query: (input: unknown) => runWidget(input) },
        resetBreaker: { mutate: vi.fn() },
      },
    },
  },
}));

import { ViewSurface } from '../ViewSurface';
import { useCustomViewsStore } from '../../stores/customViewsStore';
import { OVERVIEW_SECTION_ORDER, QUEUE_SECTION_ORDER } from '../catalog';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A `sections` map whose every entry is a tagged marker node. */
function markers(ids: readonly string[], nulls: string[] = []): Record<string, ReactNode | null> {
  const out: Record<string, ReactNode | null> = {};
  for (const id of ids) {
    out[id] = nulls.includes(id) ? null : <div data-testid={`sec:${id}`} />;
  }
  return out;
}

/** Every `sec:*` / `chrome:*` marker in DOM order. */
function renderedOrder(): string[] {
  return [...document.querySelectorAll('[data-testid^="sec:"], [data-testid^="chrome:"]')].map(
    (el) => el.getAttribute('data-testid') ?? '',
  );
}

function view(items: LayoutItem[], surface: CustomView['surface'] = 'review-queue'): CustomView {
  return {
    id: 'v1',
    surface,
    name: 'Mine',
    layout: { version: 1, items },
    revision: 3,
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
  };
}

function item(partial: Partial<LayoutItem> & Pick<LayoutItem, 'instanceId' | 'widget'>): LayoutItem {
  return { settings: {}, ...partial };
}

beforeEach(() => {
  mockViews = [];
  mockActiveViewId = 'default';
  runWidget.mockReset();
  runWidget.mockResolvedValue({
    sources: { tokens: { columns: ['totalTokens'], rows: [{ totalTokens: 5 }], truncated: false, tookMs: 1 } },
    warnings: [],
    computedAt: new Date().toISOString(),
  });
  useCustomViewsStore.setState({
    viewsBySurface: { 'review-queue': [], 'project-overview': [] },
    activeViewIdBySurface: { 'review-queue': 'default', 'project-overview': 'default' },
    widgets: [],
    loadedSurfaces: { 'review-queue': false, 'project-overview': false },
    authoring: null,
  });
});

// ---------------------------------------------------------------------------
// Default mode
// ---------------------------------------------------------------------------

describe('ViewSurface — default mode', () => {
  it('renders the review queue sections in canonical order', async () => {
    render(
      <ViewSurface
        surface="review-queue"
        sections={markers(QUEUE_SECTION_ORDER)}
        context={{ projectId: null }}
      />,
    );
    await waitFor(() => expect(useCustomViewsStore.getState().loadedSurfaces['review-queue']).toBe(true));
    expect(renderedOrder()).toEqual(QUEUE_SECTION_ORDER.map((id) => `sec:${id}`));
  });

  it('renders the project overview sections in canonical order', async () => {
    render(
      <ViewSurface
        surface="project-overview"
        sections={markers(OVERVIEW_SECTION_ORDER)}
        context={{ projectId: 7 }}
      />,
    );
    await waitFor(() =>
      expect(useCustomViewsStore.getState().loadedSurfaces['project-overview']).toBe(true),
    );
    expect(renderedOrder()).toEqual(OVERVIEW_SECTION_ORDER.map((id) => `sec:${id}`));
  });

  it('renders nothing for a null section and keeps the rest in order', async () => {
    const off = ['queue.needs-input', 'queue.blocked-runs', 'queue.human-tasks'];
    render(
      <ViewSurface
        surface="review-queue"
        sections={markers(QUEUE_SECTION_ORDER, off)}
        context={{ projectId: null }}
      />,
    );
    await waitFor(() => expect(useCustomViewsStore.getState().loadedSurfaces['review-queue']).toBe(true));
    expect(renderedOrder()).toEqual(
      QUEUE_SECTION_ORDER.filter((id) => !off.includes(id)).map((id) => `sec:${id}`),
    );
  });

  it('places afterHeader first and each afterSection chrome immediately after its section', async () => {
    render(
      <ViewSurface
        surface="review-queue"
        sections={markers(QUEUE_SECTION_ORDER)}
        context={{ projectId: null }}
        chrome={{
          afterHeader: <div data-testid="chrome:header" />,
          afterSection: { 'queue.usage-cards': <div data-testid="chrome:caught-up" /> },
        }}
      />,
    );
    await waitFor(() => expect(useCustomViewsStore.getState().loadedSurfaces['review-queue']).toBe(true));
    const order = renderedOrder();
    expect(order[0]).toBe('chrome:header');
    expect(order[1]).toBe('sec:queue.usage-cards');
    expect(order[2]).toBe('chrome:caught-up');
  });

  it('stays in default mode while the surface has not loaded (no flash of empty)', async () => {
    render(
      <ViewSurface
        surface="review-queue"
        sections={markers(QUEUE_SECTION_ORDER)}
        context={{ projectId: null }}
      />,
    );
    // Asserted BEFORE the seed resolves — the point is that the pre-load render
    // is already the full page, not an empty surface waiting for a view.
    expect(useCustomViewsStore.getState().loadedSurfaces['review-queue']).toBe(false);
    expect(renderedOrder()).toEqual(QUEUE_SECTION_ORDER.map((id) => `sec:${id}`));
    await waitFor(() => expect(useCustomViewsStore.getState().loadedSurfaces['review-queue']).toBe(true));
  });
});

// ---------------------------------------------------------------------------
// Custom mode
// ---------------------------------------------------------------------------

describe('ViewSurface — custom view', () => {
  it('renders the layout order, mounts a WidgetHost for a spec ref, and skips hidden items', async () => {
    mockViews = [
      view([
        item({ instanceId: 'i1', widget: { type: 'catalog', catalogId: 'queue.backlog' } }),
        item({ instanceId: 'i2', widget: { type: 'catalog', catalogId: 'stats.tokens-today' } }),
        item({ instanceId: 'i3', widget: { type: 'catalog', catalogId: 'queue.working' }, hidden: true }),
        item({ instanceId: 'i4', widget: { type: 'catalog', catalogId: 'queue.usage-cards' } }),
      ]),
    ];
    mockActiveViewId = 'v1';

    render(
      <ViewSurface
        surface="review-queue"
        sections={markers(QUEUE_SECTION_ORDER)}
        context={{ projectId: null }}
      />,
    );

    await screen.findByTestId('sec:queue.backlog');
    expect(renderedOrder()).toEqual(['sec:queue.backlog', 'sec:queue.usage-cards']);
    expect(screen.queryByTestId('sec:queue.working')).toBeNull();
    // The spec ref became a real widget host, which ran its query.
    expect(await screen.findByTestId('widget-frame-i2')).toBeInTheDocument();
    await waitFor(() => expect(runWidget).toHaveBeenCalled());
  });

  it('renders the "not available" chip for a section owned by the other surface', async () => {
    mockViews = [
      view(
        [
          item({ instanceId: 'i1', widget: { type: 'catalog', catalogId: 'overview.backlog' } }),
          item({ instanceId: 'i2', widget: { type: 'catalog', catalogId: 'queue.needs-input' } }),
        ],
        'project-overview',
      ),
    ];
    mockActiveViewId = 'v1';

    render(
      <ViewSurface
        surface="project-overview"
        sections={markers(OVERVIEW_SECTION_ORDER)}
        context={{ projectId: 4 }}
      />,
    );

    await screen.findByTestId('sec:overview.backlog');
    const chip = await screen.findByTestId('widget-unavailable');
    expect(chip).toHaveTextContent('Not available on this page');
    // It renders inside a titled frame, so the user can tell WHAT is missing.
    expect(screen.getByTestId('widget-frame-i2')).toHaveTextContent('Needs your input');
  });

  it('floats chrome whose anchor section the layout dropped up to the top block', async () => {
    mockViews = [
      view([item({ instanceId: 'i1', widget: { type: 'catalog', catalogId: 'queue.backlog' } })]),
    ];
    mockActiveViewId = 'v1';

    render(
      <ViewSurface
        surface="review-queue"
        sections={markers(QUEUE_SECTION_ORDER)}
        context={{ projectId: null }}
        chrome={{
          afterHeader: <div data-testid="chrome:header" />,
          afterSection: { 'queue.usage-cards': <div data-testid="chrome:caught-up" /> },
        }}
      />,
    );

    await screen.findByTestId('sec:queue.backlog');
    expect(renderedOrder()).toEqual(['chrome:header', 'chrome:caught-up', 'sec:queue.backlog']);
  });

  it('keeps anchored chrome attached to its section when the layout does place it', async () => {
    mockViews = [
      view([
        item({ instanceId: 'i1', widget: { type: 'catalog', catalogId: 'queue.backlog' } }),
        item({ instanceId: 'i2', widget: { type: 'catalog', catalogId: 'queue.usage-cards' } }),
      ]),
    ];
    mockActiveViewId = 'v1';

    render(
      <ViewSurface
        surface="review-queue"
        sections={markers(QUEUE_SECTION_ORDER)}
        context={{ projectId: null }}
        chrome={{ afterSection: { 'queue.usage-cards': <div data-testid="chrome:caught-up" /> } }}
      />,
    );

    await screen.findByTestId('sec:queue.backlog');
    expect(renderedOrder()).toEqual([
      'sec:queue.backlog',
      'sec:queue.usage-cards',
      'chrome:caught-up',
    ]);
  });

  it('falls back to the default order when the active view is corrupt', async () => {
    mockViews = [
      {
        id: 'v1',
        surface: 'review-queue',
        name: 'Broken',
        revision: 1,
        layout: null,
        corrupt: true,
        createdAt: '2026-09-10T00:00:00.000Z',
        updatedAt: '2026-09-10T00:00:00.000Z',
      } as unknown as CustomView,
    ];
    mockActiveViewId = 'v1';

    render(
      <ViewSurface
        surface="review-queue"
        sections={markers(QUEUE_SECTION_ORDER)}
        context={{ projectId: null }}
      />,
    );
    await waitFor(() => expect(useCustomViewsStore.getState().loadedSurfaces['review-queue']).toBe(true));
    expect(renderedOrder()).toEqual(QUEUE_SECTION_ORDER.map((id) => `sec:${id}`));
  });
});
