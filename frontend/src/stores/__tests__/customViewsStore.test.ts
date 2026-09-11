/**
 * customViewsStore — the read path's three contracts
 * (docs/proposals/CUSTOM-VIEWS.md §5.5).
 *
 *   - The `onWidgetDraft` subscription opens BEFORE the seed queries. S4 drops
 *     every event, but the ORDER is the point: a draft landing between the
 *     seeds and a late subscribe would be lost, and S6 binds to this channel.
 *   - `init` is refcounted, so both landing pages can mount and unmount
 *     independently without either tearing the other's subscription down.
 *   - `setActive` is optimistic and REVERTS on a failed mutation, so a rejected
 *     switch cannot leave the UI showing a view the backend did not accept.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CustomView, CustomWidget, ViewLayout } from '../../../../shared/types/customViews';

const calls: string[] = [];
let mockViews: CustomView[] = [];
let mockWidgets: CustomWidget[] = [];
let mockActiveViewId = 'default';
let setActiveViewImpl: (input: { surface: string; viewId: string }) => Promise<{ ok: true }> = () =>
  Promise.resolve({ ok: true });
let updateViewImpl: (input: {
  id: string;
  expectedRevision: number;
  name?: string;
  layout?: ViewLayout;
}) => Promise<CustomView> = () => Promise.reject(new Error('not configured'));
let createViewImpl: (input: { surface: string; name: string; layout: ViewLayout }) => Promise<CustomView> = () =>
  Promise.reject(new Error('not configured'));
let deleteViewImpl: (input: { id: string }) => Promise<{ ok: true }> = () => Promise.resolve({ ok: true });
let publishDraftImpl: (input: { id: string; authoringSessionId: string }) => Promise<CustomWidget> = () =>
  Promise.reject(new Error('not configured'));
let discardDraftImpl: (input: { id: string; authoringSessionId: string }) => Promise<CustomWidget | null> = () =>
  Promise.resolve(null);
const unsubscribe = vi.fn();
const publishDraftMock = vi.fn((input: { id: string; authoringSessionId: string }) => publishDraftImpl(input));
const discardDraftMock = vi.fn((input: { id: string; authoringSessionId: string }) => discardDraftImpl(input));

vi.mock('../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      customViews: {
        listViews: {
          query: vi.fn(() => {
            calls.push('listViews');
            return Promise.resolve(mockViews);
          }),
        },
        getActiveView: {
          query: vi.fn(() => {
            calls.push('getActiveView');
            return Promise.resolve({ viewId: mockActiveViewId });
          }),
        },
        listWidgets: {
          query: vi.fn(() => {
            calls.push('listWidgets');
            return Promise.resolve(mockWidgets);
          }),
        },
        setActiveView: { mutate: (input: { surface: string; viewId: string }) => setActiveViewImpl(input) },
        updateView: {
          mutate: (input: { id: string; expectedRevision: number; name?: string; layout?: ViewLayout }) =>
            updateViewImpl(input),
        },
        createView: {
          mutate: (input: { surface: string; name: string; layout: ViewLayout }) => createViewImpl(input),
        },
        deleteView: { mutate: (input: { id: string }) => deleteViewImpl(input) },
        publishDraft: {
          mutate: (input: { id: string; authoringSessionId: string }) => publishDraftMock(input),
        },
        discardDraft: {
          mutate: (input: { id: string; authoringSessionId: string }) => discardDraftMock(input),
        },
        onWidgetDraft: {
          subscribe: vi.fn(() => {
            calls.push('subscribe');
            return { unsubscribe };
          }),
        },
      },
    },
  },
}));

import { useCustomViewsStore } from '../customViewsStore';
import { useAgentThreadStore } from '../agentThreadStore';
import { QUEUE_SECTION_ORDER } from '../../customViews/catalog';

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

function makeView(partial: Partial<CustomView> & Pick<CustomView, 'id' | 'name' | 'surface'>): CustomView {
  return {
    layout: { version: 1, items: [] },
    revision: 1,
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
    ...partial,
  };
}

beforeEach(() => {
  calls.length = 0;
  mockViews = [];
  mockWidgets = [];
  mockActiveViewId = 'default';
  setActiveViewImpl = () => Promise.resolve({ ok: true });
  updateViewImpl = () => Promise.reject(new Error('not configured'));
  createViewImpl = () => Promise.reject(new Error('not configured'));
  deleteViewImpl = () => Promise.resolve({ ok: true });
  publishDraftImpl = () => Promise.reject(new Error('not configured'));
  discardDraftImpl = () => Promise.resolve(null);
  unsubscribe.mockReset();
  publishDraftMock.mockClear();
  discardDraftMock.mockClear();
  useCustomViewsStore.setState({
    viewsBySurface: { 'review-queue': [], 'project-overview': [] },
    activeViewIdBySurface: { 'review-queue': 'default', 'project-overview': 'default' },
    widgets: [],
    loadedSurfaces: { 'review-queue': false, 'project-overview': false },
    authoring: null,
    draft: null,
  });
});

describe('customViewsStore.init', () => {
  it('subscribes before firing the seed queries, then commits them', async () => {
    const release = useCustomViewsStore.getState().init('review-queue');
    expect(calls[0]).toBe('subscribe');
    expect(calls.slice(1).sort()).toEqual(['getActiveView', 'listViews', 'listWidgets']);

    await vi.waitFor(() => expect(useCustomViewsStore.getState().loadedSurfaces['review-queue']).toBe(true));
    release();
  });

  it('shares one subscription across co-mounted consumers and tears down at zero', async () => {
    const a = useCustomViewsStore.getState().init('review-queue');
    const b = useCustomViewsStore.getState().init('review-queue');
    expect(calls.filter((c) => c === 'subscribe')).toHaveLength(1);

    a();
    expect(unsubscribe).not.toHaveBeenCalled();
    b();
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    // A second release is a no-op, not a second teardown.
    b();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(calls).toContain('listViews'));
  });

  it('wires each surface independently', () => {
    const a = useCustomViewsStore.getState().init('review-queue');
    const b = useCustomViewsStore.getState().init('project-overview');
    expect(calls.filter((c) => c === 'subscribe')).toHaveLength(2);
    a();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    b();
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });

  it('leaves the surface on Default when the queries fail', async () => {
    const store = useCustomViewsStore.getState();
    const release = store.init('review-queue');
    await vi.waitFor(() => expect(useCustomViewsStore.getState().loadedSurfaces['review-queue']).toBe(true));
    expect(useCustomViewsStore.getState().activeViewIdBySurface['review-queue']).toBe('default');
    release();
  });
});

describe('customViewsStore.setActive', () => {
  it('switches optimistically and keeps the switch when the mutation resolves', async () => {
    await useCustomViewsStore.getState().setActive('review-queue', 'v9');
    expect(useCustomViewsStore.getState().activeViewIdBySurface['review-queue']).toBe('v9');
  });

  it('reverts when the mutation rejects', async () => {
    setActiveViewImpl = () => Promise.reject(new Error('not_found'));
    await useCustomViewsStore.getState().setActive('review-queue', 'v9');
    expect(useCustomViewsStore.getState().activeViewIdBySurface['review-queue']).toBe('default');
  });

  it('does not revert a switch that moved on again while the mutation was in flight', async () => {
    let reject!: (err: Error) => void;
    setActiveViewImpl = () => new Promise((_, r) => { reject = r; });
    const pending = useCustomViewsStore.getState().setActive('review-queue', 'v9');
    useCustomViewsStore.setState((s) => ({
      activeViewIdBySurface: { ...s.activeViewIdBySurface, 'review-queue': 'v10' },
    }));
    reject(new Error('not_found'));
    await pending;
    expect(useCustomViewsStore.getState().activeViewIdBySurface['review-queue']).toBe('v10');
  });
});

describe('customViewsStore.resolveWidgetSpec', () => {
  it('resolves a catalog ref against the shared built-in specs', () => {
    const spec = useCustomViewsStore
      .getState()
      .resolveWidgetSpec({ type: 'catalog', catalogId: 'stats.tokens-today' });
    expect(spec?.render).toMatchObject({ type: 'shape', shape: 'stat' });
  });

  it('returns null for an unknown catalog id', () => {
    expect(
      useCustomViewsStore.getState().resolveWidgetSpec({ type: 'catalog', catalogId: 'nope' }),
    ).toBeNull();
  });

  it('resolves a custom ref to its PUBLISHED spec only', () => {
    const published = {
      version: 1 as const,
      sources: { a: { type: 'sql' as const, sql: 'SELECT 1 AS n' } },
      render: { type: 'shape' as const, shape: 'stat' as const, source: 'a', value: 'n' },
    };
    useCustomViewsStore.setState({
      widgets: [
        widget({ id: 'w-pub', publishedSpec: published }),
        widget({ id: 'w-draft', publishedSpec: null, draftSpec: published }),
      ],
    });
    expect(useCustomViewsStore.getState().resolveWidgetSpec({ type: 'custom', widgetId: 'w-pub' })).toBe(
      published,
    );
    // A draft renders only in the authoring slot — never through a plain ref.
    expect(
      useCustomViewsStore.getState().resolveWidgetSpec({ type: 'custom', widgetId: 'w-draft' }),
    ).toBeNull();
    expect(useCustomViewsStore.getState().resolveWidgetSpec({ type: 'custom', widgetId: 'gone' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Customize mode (S5) — the draft lifecycle
// (docs/proposals/CUSTOM-VIEWS.md §5.5, §9 row S5)
// ---------------------------------------------------------------------------

describe('customViewsStore.enterCustomize', () => {
  it('seeds the draft from the canonical catalog order when Default is active', () => {
    useCustomViewsStore.getState().enterCustomize('review-queue');
    const draft = useCustomViewsStore.getState().draft;
    expect(draft).not.toBeNull();
    expect(draft?.surface).toBe('review-queue');
    expect(draft?.baseViewId).toBeNull();
    expect(draft?.baseRevision).toBeNull();
    expect(draft?.dirty).toBe(false);
    expect(draft?.layout.items.map((it) => (it.widget.type === 'catalog' ? it.widget.catalogId : null))).toEqual([
      ...QUEUE_SECTION_ORDER,
    ]);
    // Fresh, distinct instance ids.
    const ids = draft?.layout.items.map((it) => it.instanceId) ?? [];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('seeds the draft from the active view layout, with its own copies of the items', () => {
    const view = makeView({
      id: 'v1',
      name: 'Mine',
      surface: 'review-queue',
      revision: 4,
      layout: {
        version: 1,
        items: [{ instanceId: 'i1', widget: { type: 'catalog', catalogId: 'queue.backlog' }, settings: {} }],
      },
    });
    useCustomViewsStore.setState({
      viewsBySurface: { 'review-queue': [view], 'project-overview': [] },
      activeViewIdBySurface: { 'review-queue': 'v1', 'project-overview': 'default' },
    });

    useCustomViewsStore.getState().enterCustomize('review-queue');
    const draft = useCustomViewsStore.getState().draft;
    expect(draft?.baseViewId).toBe('v1');
    expect(draft?.baseRevision).toBe(4);
    expect(draft?.layout.items).toHaveLength(1);
    expect(draft?.layout.items[0].instanceId).toBe('i1');

    // Mutating the draft must never alias the saved view's items.
    useCustomViewsStore.getState().toggleHidden('i1');
    expect(view.layout.items[0].hidden).toBeUndefined();
  });
});

describe('customViewsStore draft editing actions', () => {
  beforeEach(() => {
    useCustomViewsStore.getState().enterCustomize('review-queue');
  });

  it('moveItem reorders the draft', () => {
    const before = useCustomViewsStore.getState().draft?.layout.items.map((it) => it.instanceId) ?? [];
    useCustomViewsStore.getState().moveItem(0, 2);
    const after = useCustomViewsStore.getState().draft?.layout.items.map((it) => it.instanceId) ?? [];
    expect(after[2]).toBe(before[0]);
    expect(useCustomViewsStore.getState().draft?.dirty).toBe(true);
  });

  it('toggleHidden flips one item and leaves the others alone', () => {
    const id = useCustomViewsStore.getState().draft?.layout.items[0].instanceId as string;
    useCustomViewsStore.getState().toggleHidden(id);
    expect(useCustomViewsStore.getState().draft?.layout.items[0].hidden).toBe(true);
    useCustomViewsStore.getState().toggleHidden(id);
    expect(useCustomViewsStore.getState().draft?.layout.items[0].hidden).toBe(false);
  });

  it('removeItem drops the item', () => {
    const id = useCustomViewsStore.getState().draft?.layout.items[0].instanceId as string;
    const countBefore = useCustomViewsStore.getState().draft?.layout.items.length ?? 0;
    useCustomViewsStore.getState().removeItem(id);
    const items = useCustomViewsStore.getState().draft?.layout.items ?? [];
    expect(items).toHaveLength(countBefore - 1);
    expect(items.some((it) => it.instanceId === id)).toBe(false);
  });

  it('insertItem inserts at the given index, seeding settings from the spec defaults', () => {
    useCustomViewsStore.getState().insertItem(1, { type: 'catalog', catalogId: 'insights.daily-usage' });
    const items = useCustomViewsStore.getState().draft?.layout.items ?? [];
    expect(items).toHaveLength(QUEUE_SECTION_ORDER.length + 1);
    const inserted = items[1];
    expect(inserted.widget).toEqual({ type: 'catalog', catalogId: 'insights.daily-usage' });
    // Declared defaults (groupBy/days/project) were seeded, not left empty.
    expect(inserted.settings.groupBy).toBe('day');
    expect(inserted.settings.days).toBe(30);
  });

  it('updateItemSettings merges settings and sets/clears title + refreshSec', () => {
    const id = useCustomViewsStore.getState().draft?.layout.items[0].instanceId as string;
    useCustomViewsStore.getState().updateItemSettings(id, { title: 'Renamed', refreshSec: 120 });
    let item = useCustomViewsStore.getState().draft?.layout.items[0];
    expect(item?.title).toBe('Renamed');
    expect(item?.refreshSec).toBe(120);

    useCustomViewsStore.getState().updateItemSettings(id, { settings: { foo: 'bar' } });
    item = useCustomViewsStore.getState().draft?.layout.items[0];
    expect(item?.settings.foo).toBe('bar');

    useCustomViewsStore.getState().updateItemSettings(id, { title: null, refreshSec: null });
    item = useCustomViewsStore.getState().draft?.layout.items[0];
    expect(item?.title).toBeUndefined();
    expect(item?.refreshSec).toBeUndefined();
  });

  it('editing actions are a no-op without a draft', () => {
    useCustomViewsStore.setState({ draft: null });
    useCustomViewsStore.getState().moveItem(0, 1);
    useCustomViewsStore.getState().toggleHidden('nope');
    useCustomViewsStore.getState().removeItem('nope');
    expect(useCustomViewsStore.getState().draft).toBeNull();
  });
});

describe('customViewsStore.save', () => {
  it('mode "update" calls updateView with the draft baseRevision, refreshes, and clears the draft', async () => {
    const view = makeView({ id: 'v1', name: 'Mine', surface: 'review-queue', revision: 4 });
    useCustomViewsStore.setState({
      viewsBySurface: { 'review-queue': [view], 'project-overview': [] },
      activeViewIdBySurface: { 'review-queue': 'v1', 'project-overview': 'default' },
    });
    useCustomViewsStore.getState().enterCustomize('review-queue');

    const saved = makeView({ id: 'v1', name: 'Mine', surface: 'review-queue', revision: 5 });
    let receivedInput: { id: string; expectedRevision: number; name?: string } | null = null;
    updateViewImpl = (input) => {
      receivedInput = input;
      mockViews = [saved];
      mockActiveViewId = 'v1';
      return Promise.resolve(saved);
    };

    await useCustomViewsStore.getState().save({ mode: 'update', name: 'Mine', setActive: true });

    expect(receivedInput).not.toBeNull();
    expect((receivedInput as unknown as { id: string }).id).toBe('v1');
    expect((receivedInput as unknown as { expectedRevision: number }).expectedRevision).toBe(4);
    expect(useCustomViewsStore.getState().draft).toBeNull();
    expect(useCustomViewsStore.getState().viewsBySurface['review-queue']).toEqual([saved]);
  });

  it('strips an unpublished authoring placeholder (widgetId "") from the layout it sends', async () => {
    const view = makeView({ id: 'v1', name: 'Mine', surface: 'review-queue', revision: 4 });
    useCustomViewsStore.setState({
      viewsBySurface: { 'review-queue': [view], 'project-overview': [] },
      activeViewIdBySurface: { 'review-queue': 'v1', 'project-overview': 'default' },
    });
    useCustomViewsStore.getState().enterCustomize('review-queue');
    useCustomViewsStore.getState().openAuthoring({ surface: 'review-queue', mode: 'create', at: 0 });
    expect(useCustomViewsStore.getState().draft?.layout.items[0]?.widget).toEqual({ type: 'custom', widgetId: '' });

    let sentLayout: { items: { widget: { type: string } }[] } | null = null;
    updateViewImpl = (input) => {
      sentLayout = (input as unknown as { layout: { items: { widget: { type: string } }[] } }).layout;
      return Promise.resolve(makeView({ id: 'v1', name: 'Mine', surface: 'review-queue', revision: 5 }));
    };

    await useCustomViewsStore.getState().save({ mode: 'update', name: 'Mine', setActive: false });

    expect(sentLayout).not.toBeNull();
    const items = (sentLayout as unknown as { items: { widget: { type: string; widgetId?: string } }[] }).items;
    expect(items.some((it) => it.widget.type === 'custom' && it.widget.widgetId === '')).toBe(false);
    expect(items.length).toBe(view.layout.items.length);
  });

  it('a concurrency failure keeps the draft and records saveError', async () => {
    const view = makeView({
      id: 'v1',
      name: 'Mine',
      surface: 'review-queue',
      revision: 4,
      layout: {
        version: 1,
        items: [{ instanceId: 'i1', widget: { type: 'catalog', catalogId: 'queue.backlog' }, settings: {} }],
      },
    });
    useCustomViewsStore.setState({
      viewsBySurface: { 'review-queue': [view], 'project-overview': [] },
      activeViewIdBySurface: { 'review-queue': 'v1', 'project-overview': 'default' },
    });
    useCustomViewsStore.getState().enterCustomize('review-queue');
    updateViewImpl = () => Promise.reject(new Error('concurrency'));

    await useCustomViewsStore.getState().save({ mode: 'update', name: 'Mine', setActive: true });

    const draft = useCustomViewsStore.getState().draft;
    expect(draft).not.toBeNull();
    expect(draft?.saveError).toBe('concurrency');
    // Nothing about the working layout was thrown away.
    expect(draft?.layout.items.length).toBeGreaterThan(0);
  });

  it('mode "new" calls createView and activates the result when asked', async () => {
    useCustomViewsStore.getState().enterCustomize('review-queue');
    const created = makeView({ id: 'v2', name: 'Ship week', surface: 'review-queue', revision: 1 });
    let receivedInput: { surface: string; name: string } | null = null;
    createViewImpl = (input) => {
      receivedInput = input;
      mockViews = [created];
      return Promise.resolve(created);
    };
    setActiveViewImpl = (input) => {
      mockActiveViewId = input.viewId;
      return Promise.resolve({ ok: true });
    };

    await useCustomViewsStore.getState().save({ mode: 'new', name: 'Ship week', setActive: true });

    expect(receivedInput).toEqual(expect.objectContaining({ surface: 'review-queue', name: 'Ship week' }));
    expect(useCustomViewsStore.getState().draft).toBeNull();
    expect(useCustomViewsStore.getState().activeViewIdBySurface['review-queue']).toBe('v2');
  });
});

describe('customViewsStore.discard', () => {
  it('clears the draft without saving', () => {
    useCustomViewsStore.getState().enterCustomize('review-queue');
    expect(useCustomViewsStore.getState().draft).not.toBeNull();
    useCustomViewsStore.getState().discard();
    expect(useCustomViewsStore.getState().draft).toBeNull();
  });

  it('discards the pending draft widget when the authoring session owns an UNPUBLISHED draft', () => {
    useCustomViewsStore.getState().enterCustomize('review-queue');
    const sessionId = useCustomViewsStore.getState().openAuthoring({ surface: 'review-queue', mode: 'create', at: 0 });
    useCustomViewsStore.getState().onDraftEvent({ widgetId: 'w-1', authoringSessionId: sessionId, kind: 'draft' });

    useCustomViewsStore.getState().discard();

    expect(discardDraftMock).toHaveBeenCalledWith({ id: 'w-1', authoringSessionId: sessionId });
    expect(useCustomViewsStore.getState().draft).toBeNull();
    expect(useCustomViewsStore.getState().authoring).toBeNull();
  });

  it('clears the pending kickoff contextHint for the closed authoring session, leaving other hints alone', () => {
    useCustomViewsStore.getState().enterCustomize('review-queue');
    const sessionId = useCustomViewsStore.getState().openAuthoring({ surface: 'review-queue', mode: 'create', at: 0 });
    useAgentThreadStore.getState().setPendingContextHint(`[custom-widget-session]\nsessionId=${sessionId} surface=review-queue`);

    useCustomViewsStore.getState().discard();
    expect(useAgentThreadStore.getState().pendingContextHint).toBeNull();

    // A hint for some OTHER session is not this slot's to clear.
    useCustomViewsStore.getState().enterCustomize('review-queue');
    useCustomViewsStore.getState().openAuthoring({ surface: 'review-queue', mode: 'create', at: 0 });
    useAgentThreadStore.getState().setPendingContextHint('[custom-widget-session]\nsessionId=someone-else');
    useCustomViewsStore.getState().finishAuthoring();
    expect(useAgentThreadStore.getState().pendingContextHint).toBe('[custom-widget-session]\nsessionId=someone-else');
    useAgentThreadStore.getState().setPendingContextHint(null);
  });

  it('does NOT call discardDraft once the draft was published', () => {
    useCustomViewsStore.getState().enterCustomize('review-queue');
    const sessionId = useCustomViewsStore.getState().openAuthoring({ surface: 'review-queue', mode: 'create', at: 0 });
    useCustomViewsStore.getState().onDraftEvent({ widgetId: 'w-1', authoringSessionId: sessionId, kind: 'draft' });
    useCustomViewsStore.getState().onDraftEvent({ widgetId: 'w-1', authoringSessionId: sessionId, kind: 'published' });

    useCustomViewsStore.getState().discard();

    expect(discardDraftMock).not.toHaveBeenCalled();
    expect(useCustomViewsStore.getState().draft).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Authoring (S6) — the placeholder slot + drafts vs published (§7.1, §7.3)
// ---------------------------------------------------------------------------

describe('customViewsStore.openAuthoring', () => {
  beforeEach(() => {
    useCustomViewsStore.getState().enterCustomize('review-queue');
  });

  it('mode "create" inserts a placeholder item at `at` and opens the slot', () => {
    const before = useCustomViewsStore.getState().draft?.layout.items.length ?? 0;
    const sessionId = useCustomViewsStore.getState().openAuthoring({ surface: 'review-queue', mode: 'create', at: 1 });

    const draft = useCustomViewsStore.getState().draft;
    expect(draft?.layout.items).toHaveLength(before + 1);
    expect(draft?.layout.items[1].widget).toEqual({ type: 'custom', widgetId: '' });
    expect(draft?.dirty).toBe(true);

    const authoring = useCustomViewsStore.getState().authoring;
    expect(authoring).toEqual({
      sessionId,
      instanceId: draft?.layout.items[1].instanceId,
      mode: 'create',
      widgetId: null,
      draftPreview: false,
    });
  });

  it('mode "edit" marks the existing item without touching the draft\'s items', () => {
    const items = useCustomViewsStore.getState().draft?.layout.items ?? [];
    const before = items.length;
    const targetInstanceId = items[0].instanceId;

    const sessionId = useCustomViewsStore
      .getState()
      .openAuthoring({ surface: 'review-queue', mode: 'edit', instanceId: targetInstanceId, widgetId: 'w-1' });

    expect(useCustomViewsStore.getState().draft?.layout.items).toHaveLength(before);
    expect(useCustomViewsStore.getState().authoring).toEqual({
      sessionId,
      instanceId: targetInstanceId,
      mode: 'edit',
      widgetId: 'w-1',
      draftPreview: false,
    });
  });
});

describe('customViewsStore.onDraftEvent', () => {
  beforeEach(() => {
    useCustomViewsStore.getState().enterCustomize('review-queue');
  });

  it('ignores an event for a different (stale/superseded) session', () => {
    const sessionId = useCustomViewsStore.getState().openAuthoring({ surface: 'review-queue', mode: 'create', at: 0 });
    useCustomViewsStore.getState().onDraftEvent({ widgetId: 'w-x', authoringSessionId: 'someone-else', kind: 'draft' });

    expect(useCustomViewsStore.getState().authoring).toEqual(
      expect.objectContaining({ sessionId, widgetId: null, draftPreview: false }),
    );
  });

  it('a "draft" event binds the widgetId, marks the item, flips draftPreview, and refreshes the library', async () => {
    const sessionId = useCustomViewsStore.getState().openAuthoring({ surface: 'review-queue', mode: 'create', at: 0 });
    const instanceId = useCustomViewsStore.getState().authoring?.instanceId as string;
    mockWidgets = [widget({ id: 'w-1', draftSpec: null })];
    calls.length = 0;

    useCustomViewsStore.getState().onDraftEvent({ widgetId: 'w-1', authoringSessionId: sessionId, kind: 'draft' });

    const authoring = useCustomViewsStore.getState().authoring;
    expect(authoring?.widgetId).toBe('w-1');
    expect(authoring?.draftPreview).toBe(true);
    const item = useCustomViewsStore.getState().draft?.layout.items.find((it) => it.instanceId === instanceId);
    expect(item?.widget).toEqual({ type: 'custom', widgetId: 'w-1' });
    await vi.waitFor(() => expect(calls).toContain('listWidgets'));
  });

  it('a "published" event flips draftPreview off, keeps the widgetId, and refreshes the library', async () => {
    const sessionId = useCustomViewsStore.getState().openAuthoring({ surface: 'review-queue', mode: 'create', at: 0 });
    useCustomViewsStore.getState().onDraftEvent({ widgetId: 'w-1', authoringSessionId: sessionId, kind: 'draft' });
    calls.length = 0;

    useCustomViewsStore.getState().onDraftEvent({ widgetId: 'w-1', authoringSessionId: sessionId, kind: 'published' });

    expect(useCustomViewsStore.getState().authoring?.widgetId).toBe('w-1');
    expect(useCustomViewsStore.getState().authoring?.draftPreview).toBe(false);
    await vi.waitFor(() => expect(calls).toContain('listWidgets'));
  });

  it('ignores an event whose widgetId conflicts with an already-bound slot', () => {
    const sessionId = useCustomViewsStore.getState().openAuthoring({ surface: 'review-queue', mode: 'create', at: 0 });
    useCustomViewsStore.getState().onDraftEvent({ widgetId: 'w-1', authoringSessionId: sessionId, kind: 'draft' });
    useCustomViewsStore.getState().onDraftEvent({ widgetId: 'w-2', authoringSessionId: sessionId, kind: 'draft' });
    expect(useCustomViewsStore.getState().authoring?.widgetId).toBe('w-1');
  });
});

describe('customViewsStore.publishAuthoringDraft / discardAuthoringDraft / finishAuthoring', () => {
  beforeEach(() => {
    useCustomViewsStore.getState().enterCustomize('review-queue');
  });

  it('publishAuthoringDraft calls publishDraft, then applies the published state locally (no wait on the subscription)', async () => {
    const sessionId = useCustomViewsStore.getState().openAuthoring({ surface: 'review-queue', mode: 'create', at: 0 });
    useCustomViewsStore.getState().onDraftEvent({ widgetId: 'w-1', authoringSessionId: sessionId, kind: 'draft' });
    publishDraftImpl = () => Promise.resolve(widget({ id: 'w-1', publishedSpec: null }));

    await useCustomViewsStore.getState().publishAuthoringDraft();

    expect(publishDraftMock).toHaveBeenCalledWith({ id: 'w-1', authoringSessionId: sessionId });
    expect(useCustomViewsStore.getState().authoring?.draftPreview).toBe(false);
    expect(useCustomViewsStore.getState().authoring?.widgetId).toBe('w-1');
    // Kept open — the assistant may keep iterating (§7.3).
    expect(useCustomViewsStore.getState().authoring).not.toBeNull();
  });

  it('discardAuthoringDraft calls discardDraft, drops the placeholder item (mode "create"), and closes the slot', () => {
    const before = useCustomViewsStore.getState().draft?.layout.items.length ?? 0;
    const sessionId = useCustomViewsStore.getState().openAuthoring({ surface: 'review-queue', mode: 'create', at: 0 });
    const instanceId = useCustomViewsStore.getState().authoring?.instanceId as string;
    useCustomViewsStore.getState().onDraftEvent({ widgetId: 'w-1', authoringSessionId: sessionId, kind: 'draft' });

    useCustomViewsStore.getState().discardAuthoringDraft();

    expect(discardDraftMock).toHaveBeenCalledWith({ id: 'w-1', authoringSessionId: sessionId });
    expect(useCustomViewsStore.getState().authoring).toBeNull();
    const items = useCustomViewsStore.getState().draft?.layout.items ?? [];
    expect(items).toHaveLength(before);
    expect(items.some((it) => it.instanceId === instanceId)).toBe(false);
  });

  it('discardAuthoringDraft in mode "edit" closes the slot without touching the draft\'s items', () => {
    const items = useCustomViewsStore.getState().draft?.layout.items ?? [];
    const before = items.length;
    const targetInstanceId = items[0].instanceId;
    const sessionId = useCustomViewsStore
      .getState()
      .openAuthoring({ surface: 'review-queue', mode: 'edit', instanceId: targetInstanceId, widgetId: 'w-1' });
    useCustomViewsStore.getState().onDraftEvent({ widgetId: 'w-1', authoringSessionId: sessionId, kind: 'draft' });

    useCustomViewsStore.getState().discardAuthoringDraft();

    expect(discardDraftMock).toHaveBeenCalledWith({ id: 'w-1', authoringSessionId: sessionId });
    expect(useCustomViewsStore.getState().authoring).toBeNull();
    expect(useCustomViewsStore.getState().draft?.layout.items).toHaveLength(before);
  });

  it('finishAuthoring closes the slot without calling discardDraft or touching the draft', () => {
    const before = useCustomViewsStore.getState().draft?.layout.items.length ?? 0;
    useCustomViewsStore.getState().openAuthoring({ surface: 'review-queue', mode: 'create', at: 0 });

    useCustomViewsStore.getState().finishAuthoring();

    expect(discardDraftMock).not.toHaveBeenCalled();
    expect(useCustomViewsStore.getState().authoring).toBeNull();
    expect(useCustomViewsStore.getState().draft?.layout.items).toHaveLength(before + 1);
  });
});

describe('customViewsStore.renameView / deleteView', () => {
  it('renameView looks up the revision itself and refreshes on success', async () => {
    const view = makeView({ id: 'v1', name: 'Old', surface: 'review-queue', revision: 2 });
    useCustomViewsStore.setState({ viewsBySurface: { 'review-queue': [view], 'project-overview': [] } });
    const renamed = makeView({ id: 'v1', name: 'New', surface: 'review-queue', revision: 3 });
    let receivedRevision: number | null = null;
    updateViewImpl = (input) => {
      receivedRevision = input.expectedRevision;
      mockViews = [renamed];
      return Promise.resolve(renamed);
    };

    const result = await useCustomViewsStore.getState().renameView('v1', 'New');
    expect(result).toEqual({ ok: true });
    expect(receivedRevision).toBe(2);
    expect(useCustomViewsStore.getState().viewsBySurface['review-queue']).toEqual([renamed]);
  });

  it('renameView reports failure without throwing', async () => {
    const view = makeView({ id: 'v1', name: 'Old', surface: 'review-queue', revision: 2 });
    useCustomViewsStore.setState({ viewsBySurface: { 'review-queue': [view], 'project-overview': [] } });
    updateViewImpl = () => Promise.reject(new Error('name_taken'));
    const result = await useCustomViewsStore.getState().renameView('v1', 'Dup');
    expect(result).toEqual({ ok: false, error: 'name_taken' });
  });

  it('deleteView deletes and refreshes the owning surface', async () => {
    const view = makeView({ id: 'v1', name: 'Gone soon', surface: 'review-queue', revision: 1 });
    useCustomViewsStore.setState({ viewsBySurface: { 'review-queue': [view], 'project-overview': [] } });
    let deletedId: string | null = null;
    deleteViewImpl = (input) => {
      deletedId = input.id;
      mockViews = [];
      return Promise.resolve({ ok: true });
    };

    const result = await useCustomViewsStore.getState().deleteView('v1');
    expect(result).toEqual({ ok: true });
    expect(deletedId).toBe('v1');
    expect(useCustomViewsStore.getState().viewsBySurface['review-queue']).toEqual([]);
  });
});

describe('customViewsStore.isCustomizing', () => {
  it('is true only for the surface with an open draft', () => {
    useCustomViewsStore.getState().enterCustomize('review-queue');
    expect(useCustomViewsStore.getState().isCustomizing('review-queue')).toBe(true);
    expect(useCustomViewsStore.getState().isCustomizing('project-overview')).toBe(false);
  });
});
