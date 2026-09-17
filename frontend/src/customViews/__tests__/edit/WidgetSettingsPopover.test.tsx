/**
 * WidgetSettingsPopover — one widget's inspector
 * (docs/proposals/CUSTOM-VIEWS.md §6, the "Widget settings" artboard).
 *
 * Pins: a spec widget's declared `settings` each render an inspector knob
 * alongside the always-present Title and Refresh controls; changing a knob
 * or the title applies immediately to the DRAFT via `updateItemSettings`
 * (clearing the title removes the override rather than storing an empty
 * string); a live `payload`'s warnings surface in the Reads row; and the
 * footer's assistant hookup differs by widget kind — a custom widget's
 * `onEditWithAssistant` callback fires from its own button.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LayoutItem, WidgetDataPayload } from '../../../../../shared/types/customViews';

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

import { WidgetSettingsPopover } from '../../edit/WidgetSettingsPopover';
import { useCustomViewsStore } from '../../../stores/customViewsStore';
import { catalogEntry } from '../../catalog';

const CATALOG_ID = 'insights.daily-usage'; // settings: groupBy (select), days (number), project (project)
const CATALOG_ENTRY = catalogEntry(CATALOG_ID);
if (CATALOG_ENTRY === null) throw new Error('fixture: expected catalog entry to exist');
const CATALOG_SPEC = CATALOG_ENTRY.spec ?? null;
if (CATALOG_SPEC === null) throw new Error('fixture: expected a spec entry');

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

const CATALOG_ITEM: LayoutItem = {
  instanceId: 'w-catalog',
  widget: { type: 'catalog', catalogId: CATALOG_ID },
  settings: {},
};

const CUSTOM_ITEM: LayoutItem = {
  instanceId: 'w-custom',
  widget: { type: 'custom', widgetId: 'widget-1' },
  settings: {},
};

beforeEach(() => {
  draftWithItems([CATALOG_ITEM, CUSTOM_ITEM]);
});

describe('WidgetSettingsPopover — declared knobs', () => {
  it('renders a knob per declared setting plus Title and Refresh', () => {
    render(
      <WidgetSettingsPopover
        isOpen
        onClose={() => {}}
        item={CATALOG_ITEM}
        spec={CATALOG_SPEC}
        entry={CATALOG_ENTRY}
        payload={null}
      />,
    );

    expect(screen.getByTestId('widget-settings-title')).toBeInTheDocument();
    expect(screen.getByTestId('widget-settings-refresh')).toBeInTheDocument();
    expect(screen.getByTestId('widget-settings-field-groupBy')).toBeInTheDocument();
    expect(screen.getByTestId('widget-settings-field-days')).toBeInTheDocument();
    expect(screen.getByTestId('widget-settings-field-project')).toBeInTheDocument();
  });
});

describe('WidgetSettingsPopover — changing a knob', () => {
  it('a select knob change applies to the draft item settings', async () => {
    const user = userEvent.setup();
    render(
      <WidgetSettingsPopover
        isOpen
        onClose={() => {}}
        item={CATALOG_ITEM}
        spec={CATALOG_SPEC}
        entry={CATALOG_ENTRY}
        payload={null}
      />,
    );

    await user.click(screen.getByText('Weekly'));

    const stored = useCustomViewsStore
      .getState()
      .draft?.layout.items.find((it) => it.instanceId === 'w-catalog');
    expect(stored?.settings.groupBy).toBe('week');
  });

  it('a number knob change applies to the draft item settings', async () => {
    const user = userEvent.setup();
    render(
      <WidgetSettingsPopover
        isOpen
        onClose={() => {}}
        item={CATALOG_ITEM}
        spec={CATALOG_SPEC}
        entry={CATALOG_ENTRY}
        payload={null}
      />,
    );

    await user.click(screen.getByTestId('widget-settings-field-days-inc'));

    const stored = useCustomViewsStore
      .getState()
      .draft?.layout.items.find((it) => it.instanceId === 'w-catalog');
    expect(stored?.settings.days).toBe(31);
  });
});

describe('WidgetSettingsPopover — title', () => {
  it('changing the title updates the draft item, clearing it removes the override', () => {
    render(
      <WidgetSettingsPopover
        isOpen
        onClose={() => {}}
        item={CATALOG_ITEM}
        spec={CATALOG_SPEC}
        entry={CATALOG_ENTRY}
        payload={null}
      />,
    );

    const input = screen.getByTestId('widget-settings-title');
    fireEvent.change(input, { target: { value: 'My usage chart' } });
    fireEvent.blur(input);

    let stored = useCustomViewsStore.getState().draft?.layout.items.find((it) => it.instanceId === 'w-catalog');
    expect(stored?.title).toBe('My usage chart');

    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);

    stored = useCustomViewsStore.getState().draft?.layout.items.find((it) => it.instanceId === 'w-catalog');
    expect(stored?.title).toBeUndefined();
  });
});

describe('WidgetSettingsPopover — reads + warnings', () => {
  it('renders the live payload sources and surfaces its warnings', () => {
    const payload: WidgetDataPayload = {
      sources: {
        usage: { columns: ['bucket', 'model', 'totalTokens'], rows: [], truncated: false, tookMs: 4 },
      },
      warnings: ['slow query: usage took 2100ms'],
      computedAt: '2026-09-11T00:00:00.000Z',
    };

    render(
      <WidgetSettingsPopover
        isOpen
        onClose={() => {}}
        item={CATALOG_ITEM}
        spec={CATALOG_SPEC}
        entry={CATALOG_ENTRY}
        payload={payload}
      />,
    );

    expect(screen.getByTestId('widget-settings-reads')).toHaveTextContent('usage');
    expect(screen.getByTestId('widget-settings-warnings')).toHaveTextContent('slow query: usage took 2100ms');
  });
});

describe('WidgetSettingsPopover — footer', () => {
  it('a custom widget calls onEditWithAssistant from its own footer button', async () => {
    const user = userEvent.setup();
    const onEditWithAssistant = vi.fn();
    render(
      <WidgetSettingsPopover
        isOpen
        onClose={() => {}}
        item={CUSTOM_ITEM}
        spec={null}
        entry={null}
        payload={null}
        onEditWithAssistant={onEditWithAssistant}
      />,
    );

    await user.click(screen.getByTestId('widget-settings-edit-assistant'));
    expect(onEditWithAssistant).toHaveBeenCalledTimes(1);
  });

  it('a custom widget with no onEditWithAssistant renders no footer button', () => {
    render(
      <WidgetSettingsPopover
        isOpen
        onClose={() => {}}
        item={CUSTOM_ITEM}
        spec={null}
        entry={null}
        payload={null}
      />,
    );

    expect(screen.queryByTestId('widget-settings-edit-assistant')).toBeNull();
    expect(screen.queryByTestId('widget-settings-ask-assistant')).toBeNull();
  });
});
