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

const publishDraftMutate = vi.fn((_input: { id: string; authoringSessionId: string }) =>
  Promise.resolve({ id: 'w-1' }),
);
const discardDraftMutate = vi.fn((_input: { id: string; authoringSessionId: string }) => Promise.resolve(null));

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      customViews: {
        listViews: { query: vi.fn(() => Promise.resolve([])) },
        getActiveView: { query: vi.fn(() => Promise.resolve({ viewId: 'default' })) },
        listWidgets: { query: vi.fn(() => Promise.resolve([])) },
        onWidgetDraft: { subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })) },
        publishDraft: { mutate: (input: { id: string; authoringSessionId: string }) => publishDraftMutate(input) },
        discardDraft: { mutate: (input: { id: string; authoringSessionId: string }) => discardDraftMutate(input) },
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
  publishDraftMutate.mockClear();
  discardDraftMutate.mockClear();
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

// ---------------------------------------------------------------------------
// S6 — the Draft chip (docs/proposals/CUSTOM-VIEWS.md §7.3)
// ---------------------------------------------------------------------------

const CUSTOM_ITEM: LayoutItem = { instanceId: 'c1', widget: { type: 'custom', widgetId: 'w-1' }, settings: {} };

describe('EditableBlock — Draft chip', () => {
  it('renders no Draft chip when this item is not the open authoring slot', () => {
    render(
      <EditableBlock item={CUSTOM_ITEM} index={0} total={1} payload={null}>
        <div>body</div>
      </EditableBlock>,
    );
    expect(screen.queryByText('Draft')).toBeNull();
    expect(screen.queryByTestId('editable-draft-publish-c1')).toBeNull();
  });

  it('renders the Draft chip + Publish/Discard buttons while this item is the authoring slot and unpublished', () => {
    useCustomViewsStore.setState({
      authoring: { sessionId: 's1', instanceId: 'c1', mode: 'create', widgetId: 'w-1', draftPreview: true },
    });
    render(
      <EditableBlock item={CUSTOM_ITEM} index={0} total={1} payload={null}>
        <div>body</div>
      </EditableBlock>,
    );
    expect(screen.getByText('Draft')).toBeInTheDocument();
    expect(screen.getByTestId('editable-draft-publish-c1')).toBeInTheDocument();
    expect(screen.getByTestId('editable-draft-discard-c1')).toBeInTheDocument();
  });

  it('hides the chip once draftPreview flips false (published)', () => {
    useCustomViewsStore.setState({
      authoring: { sessionId: 's1', instanceId: 'c1', mode: 'create', widgetId: 'w-1', draftPreview: false },
    });
    render(
      <EditableBlock item={CUSTOM_ITEM} index={0} total={1} payload={null}>
        <div>body</div>
      </EditableBlock>,
    );
    expect(screen.queryByText('Draft')).toBeNull();
  });

  it('Publish calls publishDraft (via publishAuthoringDraft)', async () => {
    const user = userEvent.setup();
    useCustomViewsStore.setState({
      authoring: { sessionId: 's1', instanceId: 'c1', mode: 'create', widgetId: 'w-1', draftPreview: true },
    });
    render(
      <EditableBlock item={CUSTOM_ITEM} index={0} total={1} payload={null}>
        <div>body</div>
      </EditableBlock>,
    );
    await user.click(screen.getByTestId('editable-draft-publish-c1'));
    expect(publishDraftMutate).toHaveBeenCalledWith({ id: 'w-1', authoringSessionId: 's1' });
  });

  it('Discard draft calls discardDraft (via discardAuthoringDraft) and closes the slot', async () => {
    const user = userEvent.setup();
    useCustomViewsStore.setState({
      authoring: { sessionId: 's1', instanceId: 'c1', mode: 'create', widgetId: 'w-1', draftPreview: true },
    });
    render(
      <EditableBlock item={CUSTOM_ITEM} index={0} total={1} payload={null}>
        <div>body</div>
      </EditableBlock>,
    );
    await user.click(screen.getByTestId('editable-draft-discard-c1'));
    expect(discardDraftMutate).toHaveBeenCalledWith({ id: 'w-1', authoringSessionId: 's1' });
    expect(useCustomViewsStore.getState().authoring).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// S6 — "Edit with assistant" wiring (docs/proposals/CUSTOM-VIEWS.md §7.1)
// ---------------------------------------------------------------------------

describe('EditableBlock — "Edit with assistant"', () => {
  it('hides the footer button when surface/viewName are omitted (this component\'s own unit tests)', async () => {
    const user = userEvent.setup();
    render(
      <EditableBlock item={CUSTOM_ITEM} index={0} total={1} payload={null}>
        <div>body</div>
      </EditableBlock>,
    );
    await user.click(screen.getByTestId('editable-gear-c1'));
    expect(screen.queryByTestId('widget-settings-edit-assistant')).toBeNull();
  });

  it('shows the footer button and kicks off an edit-mode authoring session when surface/viewName are supplied', async () => {
    const user = userEvent.setup();
    render(
      <EditableBlock item={CUSTOM_ITEM} index={0} total={1} payload={null} surface="review-queue" viewName="Ship week" projectId={7}>
        <div>body</div>
      </EditableBlock>,
    );
    await user.click(screen.getByTestId('editable-gear-c1'));
    await user.click(screen.getByTestId('widget-settings-edit-assistant'));

    const authoring = useCustomViewsStore.getState().authoring;
    expect(authoring).toMatchObject({ mode: 'edit', instanceId: 'c1', widgetId: 'w-1' });
  });
});
