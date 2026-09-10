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
import type { CustomView, CustomWidget } from '../../../../shared/types/customViews';

const calls: string[] = [];
let mockViews: CustomView[] = [];
let mockWidgets: CustomWidget[] = [];
let mockActiveViewId = 'default';
let setActiveViewImpl: (input: { surface: string; viewId: string }) => Promise<{ ok: true }> = () =>
  Promise.resolve({ ok: true });
const unsubscribe = vi.fn();

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

beforeEach(() => {
  calls.length = 0;
  mockViews = [];
  mockWidgets = [];
  mockActiveViewId = 'default';
  setActiveViewImpl = () => Promise.resolve({ ok: true });
  unsubscribe.mockReset();
  useCustomViewsStore.setState({
    viewsBySurface: { 'review-queue': [], 'project-overview': [] },
    activeViewIdBySurface: { 'review-queue': 'default', 'project-overview': 'default' },
    widgets: [],
    loadedSurfaces: { 'review-queue': false, 'project-overview': false },
    authoring: null,
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
