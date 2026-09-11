/**
 * EditableBlock — keyboard reorder (docs/proposals/CUSTOM-VIEWS.md §6, §9 row
 * S5). The grip is a plain focusable button; ArrowUp/ArrowDown on it call the
 * store's `moveItem` with the same semantics a drag would, so a screen-reader
 * user reaches the same place a mouse user does. Also pins the hide/remove/
 * settings affordances, since they're cheap to cover alongside reorder.
 */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LayoutItem } from '../../../../../shared/types/customViews';

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

import { EditableBlock } from '../../edit/EditableBlock';
import { useCustomViewsStore } from '../../../stores/customViewsStore';

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

const ITEMS: LayoutItem[] = [
  { instanceId: 'i1', widget: { type: 'catalog', catalogId: 'queue.usage-cards' }, settings: {} },
  { instanceId: 'i2', widget: { type: 'catalog', catalogId: 'queue.recommended' }, settings: {} },
  { instanceId: 'i3', widget: { type: 'catalog', catalogId: 'queue.working' }, settings: {} },
];

beforeEach(() => {
  draftWithItems(ITEMS);
});

describe('EditableBlock — keyboard reorder', () => {
  it('ArrowDown on the grip actually reorders the draft', async () => {
    const user = userEvent.setup();
    render(
      <EditableBlock item={ITEMS[0]} index={0} total={ITEMS.length} payload={null}>
        <div>body</div>
      </EditableBlock>,
    );
    screen.getByTestId('editable-grip-i1').focus();
    await user.keyboard('{ArrowDown}');
    expect(useCustomViewsStore.getState().draft?.layout.items.map((it) => it.instanceId)).toEqual([
      'i2',
      'i1',
      'i3',
    ]);
  });

  it('calls moveItem(index, index-1) on ArrowUp and moveItem(index, index+1) on ArrowDown', async () => {
    const user = userEvent.setup();
    const moveItem = vi.fn(useCustomViewsStore.getState().moveItem);
    useCustomViewsStore.setState({ moveItem });

    render(
      <EditableBlock item={ITEMS[1]} index={1} total={ITEMS.length} payload={null}>
        <div>body</div>
      </EditableBlock>,
    );
    const grip = screen.getByTestId('editable-grip-i2');
    grip.focus();

    await user.keyboard('{ArrowUp}');
    expect(moveItem).toHaveBeenLastCalledWith(1, 0);

    await user.keyboard('{ArrowDown}');
    expect(moveItem).toHaveBeenLastCalledWith(1, 2);
  });

  it('does not move past the ends', async () => {
    const user = userEvent.setup();
    const moveItem = vi.fn(useCustomViewsStore.getState().moveItem);
    useCustomViewsStore.setState({ moveItem });

    render(
      <EditableBlock item={ITEMS[0]} index={0} total={ITEMS.length} payload={null}>
        <div>body</div>
      </EditableBlock>,
    );
    screen.getByTestId('editable-grip-i1').focus();
    await user.keyboard('{ArrowUp}');
    expect(moveItem).not.toHaveBeenCalled();
  });

  it('eye toggles hidden and trash removes the item', async () => {
    const user = userEvent.setup();
    render(
      <EditableBlock item={ITEMS[0]} index={0} total={ITEMS.length} payload={null}>
        <div data-testid="body">body</div>
      </EditableBlock>,
    );
    await user.click(screen.getByTestId('editable-eye-i1'));
    expect(useCustomViewsStore.getState().draft?.layout.items[0].hidden).toBe(true);

    await user.click(screen.getByTestId('editable-trash-i1'));
    expect(useCustomViewsStore.getState().draft?.layout.items.some((it) => it.instanceId === 'i1')).toBe(false);
  });

  it('hidden items render the collapsed strip instead of children', () => {
    const hiddenItem: LayoutItem = { ...ITEMS[0], hidden: true };
    render(
      <EditableBlock item={hiddenItem} index={0} total={ITEMS.length} payload={null}>
        {null}
      </EditableBlock>,
    );
    expect(screen.getByText('Hidden')).toBeInTheDocument();
    expect(screen.queryByTestId('body')).toBeNull();
  });
});
