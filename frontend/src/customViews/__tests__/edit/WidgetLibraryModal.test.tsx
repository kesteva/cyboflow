/**
 * WidgetLibraryModal — the "+ Add widget" library
 * (docs/proposals/CUSTOM-VIEWS.md §6, the "Widget library" artboard).
 *
 * Pins: a singleton section already placed in the draft renders its card's
 * Add disabled/"Added" while another section stays enabled; clicking an
 * enabled card's Add both inserts the item at the given index and closes the
 * modal; the "Mine" section lists only published custom widgets (a
 * draft-only one has nothing to run) and falls back to the empty strip; and
 * the "Create a custom widget" footer CTA only exists when `onCreateCustom`
 * is supplied.
 */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CustomWidget, LayoutItem, WidgetSpec } from '../../../../../shared/types/customViews';

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      customViews: {
        listViews: { query: vi.fn(() => Promise.resolve([])) },
        getActiveView: { query: vi.fn(() => Promise.resolve({ viewId: 'default' })) },
        listWidgets: { query: vi.fn(() => Promise.resolve([])) },
        onWidgetDraft: { subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })) },
      },
    },
  },
}));

import { WidgetLibraryModal } from '../../edit/WidgetLibraryModal';
import { useCustomViewsStore } from '../../../stores/customViewsStore';
import { QUEUE_SECTION_ORDER } from '../../catalog';

function draftWithItems(items: LayoutItem[]): void {
  useCustomViewsStore.setState({
    viewsBySurface: { 'review-queue': [], 'project-overview': [] },
    activeViewIdBySurface: { 'review-queue': 'default', 'project-overview': 'default' },
    widgets: [],
    loadedSurfaces: { 'review-queue': false, 'project-overview': false },
    authoring: null,
    draft: {
      surface: 'review-queue',
      layout: { version: 1, items },
      baseViewId: null,
      baseRevision: null,
      dirty: false,
      saveError: null,
    },
  });
}

function widget(partial: Partial<CustomWidget> & Pick<CustomWidget, 'id'>): CustomWidget {
  return {
    name: 'W',
    description: null,
    publishedSpec: null,
    draftSpec: null,
    authoringSessionId: null,
    revision: 1,
    threadId: null,
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
    ...partial,
  };
}

const PLACED_SECTION_ID = QUEUE_SECTION_ORDER[0]; // 'queue.usage-cards'
const OTHER_SECTION_ID = QUEUE_SECTION_ORDER[1]; // 'queue.recommended'

beforeEach(() => {
  draftWithItems([
    { instanceId: 'i1', widget: { type: 'catalog', catalogId: PLACED_SECTION_ID }, settings: {} },
  ]);
});

describe('WidgetLibraryModal — singleton sections', () => {
  it('disables Add ("Added") for an already-placed singleton and leaves another section enabled', () => {
    render(
      <WidgetLibraryModal isOpen surface="review-queue" insertAt={1} onClose={() => {}} />,
    );

    const placedAdd = screen.getByTestId(`library-card-${PLACED_SECTION_ID}-add`);
    expect(placedAdd).toBeDisabled();
    expect(placedAdd).toHaveTextContent('Added');

    const otherAdd = screen.getByTestId(`library-card-${OTHER_SECTION_ID}-add`);
    expect(otherAdd).not.toBeDisabled();
    expect(otherAdd).toHaveTextContent('Add');
  });
});

describe('WidgetLibraryModal — adding a widget', () => {
  it('clicking an enabled card inserts the catalog ref at insertAt and closes', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <WidgetLibraryModal isOpen surface="review-queue" insertAt={1} onClose={onClose} />,
    );

    await user.click(screen.getByTestId(`library-card-${OTHER_SECTION_ID}-add`));

    expect(useCustomViewsStore.getState().draft?.layout.items[1].widget).toEqual({
      type: 'catalog',
      catalogId: OTHER_SECTION_ID,
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('WidgetLibraryModal — Mine section', () => {
  it('lists only published custom widgets', () => {
    const spec: WidgetSpec = {
      version: 1,
      sources: { x: { type: 'sql', sql: 'select 1 as x' } },
      render: { type: 'shape', shape: 'stat', source: 'x', value: 'x' },
    };
    useCustomViewsStore.setState({
      widgets: [
        widget({ id: 'w-published', name: 'Published widget', publishedSpec: spec }),
        widget({ id: 'w-draft', name: 'Draft-only widget', publishedSpec: null }),
      ],
    });

    render(
      <WidgetLibraryModal isOpen surface="review-queue" insertAt={1} onClose={() => {}} />,
    );

    expect(screen.getByTestId('library-card-custom-w-published')).toBeInTheDocument();
    expect(screen.queryByTestId('library-card-custom-w-draft')).toBeNull();
    expect(screen.queryByTestId('library-mine-empty')).toBeNull();
  });

  it('renders the empty strip when there are no widgets', () => {
    useCustomViewsStore.setState({ widgets: [] });

    render(
      <WidgetLibraryModal isOpen surface="review-queue" insertAt={1} onClose={() => {}} />,
    );

    expect(screen.getByTestId('library-mine-empty')).toBeInTheDocument();
  });
});

describe('WidgetLibraryModal — create-custom CTA', () => {
  it('renders only when onCreateCustom is supplied, and calls it with insertAt on click', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <WidgetLibraryModal isOpen surface="review-queue" insertAt={2} onClose={() => {}} />,
    );
    expect(screen.queryByTestId('library-create-custom')).toBeNull();

    const onCreateCustom = vi.fn();
    rerender(
      <WidgetLibraryModal
        isOpen
        surface="review-queue"
        insertAt={2}
        onClose={() => {}}
        onCreateCustom={onCreateCustom}
      />,
    );
    const cta = screen.getByTestId('library-create-custom');
    await user.click(cta);
    expect(onCreateCustom).toHaveBeenCalledWith(2);
  });
});
