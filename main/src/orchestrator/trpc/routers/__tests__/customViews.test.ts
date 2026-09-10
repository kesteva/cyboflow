/**
 * Unit tests for the cyboflow.customViews router (docs/proposals/CUSTOM-VIEWS.md
 * §4.6, §9 row S3).
 *
 * Exercised via appRouter.createCaller(createContext({...})) with a FAKE
 * `CustomViewsServiceLike` — the same createCaller idiom agentThread.test.ts
 * uses in this same folder (including createCaller for the subscription;
 * that idiom is already proven there).
 *
 * Covers: PRECONDITION_FAILED without the dep; listViews/createView/updateView
 * happy paths; a store error mapping to CONFLICT with message = code;
 * runWidget passing refreshSec/settings through unchanged; executeAction
 * returning the service result unchanged; the onWidgetDraft subscription
 * delivering an event the fake service emits.
 */
import { describe, it, expect } from 'vitest';
import { TRPCError } from '@trpc/server';
import { appRouter } from '../../router';
import { createContext } from '../../context';
import { CustomViewsStoreError, type StoredCustomView } from '../../../customViews/types';
import type {
  CustomViewsServiceLike,
  RunWidgetInput,
  ResetBreakerInput,
  WidgetDraftEvent,
  CustomViewsDbSchemaTable,
} from '../../../customViews/customViewsService';
import type { WidgetActionPreview, ExecuteWidgetActionResult, WidgetActionTarget } from '../../../customViews/widgetActionService';
import type { CustomView, CustomViewSurface, CustomWidget, ViewLayout, WidgetDataPayload } from '../../../../../../shared/types/customViews';

// ---------------------------------------------------------------------------
// Fake CustomViewsServiceLike
// ---------------------------------------------------------------------------

function makeView(overrides: Partial<CustomView> = {}): CustomView {
  return {
    id: overrides.id ?? 'view-1',
    surface: overrides.surface ?? 'review-queue',
    name: overrides.name ?? 'Ship week',
    layout: overrides.layout ?? { version: 1, items: [] },
    revision: overrides.revision ?? 1,
    createdAt: overrides.createdAt ?? '2026-01-01T00:00:00Z',
    updatedAt: overrides.updatedAt ?? '2026-01-01T00:00:00Z',
  };
}

class FakeCustomViewsService implements CustomViewsServiceLike {
  views = new Map<string, StoredCustomView>();
  widgets = new Map<string, CustomWidget>();

  /** Set by a test to make the next createView call throw. */
  createViewError: Error | null = null;

  lastRunWidgetInput: RunWidgetInput | null = null;
  runWidgetResult: WidgetDataPayload = { sources: {}, warnings: [], computedAt: '2026-01-01T00:00:00Z' };

  lastResetBreakerInput: ResetBreakerInput | null = null;

  previewResult: WidgetActionPreview = { label: 'Open', kind: 'navigate', resolvedParams: null };
  executeResult: ExecuteWidgetActionResult = { ok: true, navigation: { target: 'backlog' } };

  dbSchemaResult: CustomViewsDbSchemaTable[] = [];

  private draftCb: ((evt: WidgetDraftEvent) => void) | null = null;

  listViews(surface: CustomViewSurface): StoredCustomView[] {
    return [...this.views.values()].filter((v) => v.surface === surface);
  }

  getActiveView(): { viewId: string } {
    return { viewId: 'default' };
  }

  setActiveView(): void {
    // no-op for this fake
  }

  createView(input: { surface: CustomViewSurface; name: string; layout: ViewLayout }): CustomView {
    if (this.createViewError) throw this.createViewError;
    const view = makeView({ surface: input.surface, name: input.name, layout: input.layout });
    this.views.set(view.id, view);
    return view;
  }

  updateView(input: { id: string; expectedRevision: number; name?: string; layout?: ViewLayout }): CustomView {
    const existing = this.views.get(input.id);
    if (!existing || 'corrupt' in existing) throw new CustomViewsStoreError('not_found', input.id);
    if (existing.revision !== input.expectedRevision) throw new CustomViewsStoreError('concurrency', input.id);
    const updated: CustomView = {
      ...existing,
      name: input.name ?? existing.name,
      layout: input.layout ?? existing.layout,
      revision: existing.revision + 1,
    };
    this.views.set(updated.id, updated);
    return updated;
  }

  deleteView(id: string): void {
    if (!this.views.delete(id)) throw new CustomViewsStoreError('not_found', id);
  }

  listWidgets(): CustomWidget[] {
    return [...this.widgets.values()];
  }

  getWidget(id: string): CustomWidget | null {
    return this.widgets.get(id) ?? null;
  }

  publishDraft(input: { id: string; authoringSessionId: string }): CustomWidget {
    const widget = this.widgets.get(input.id);
    if (!widget) throw new CustomViewsStoreError('not_found', input.id);
    return widget;
  }

  discardDraft(): CustomWidget | null {
    return null;
  }

  deleteWidget(id: string): void {
    if (!this.widgets.delete(id)) throw new CustomViewsStoreError('not_found', id);
  }

  async runWidget(input: RunWidgetInput): Promise<WidgetDataPayload> {
    this.lastRunWidgetInput = input;
    return this.runWidgetResult;
  }

  resetBreaker(input: ResetBreakerInput): void {
    this.lastResetBreakerInput = input;
  }

  async previewAction(_target: WidgetActionTarget): Promise<WidgetActionPreview> {
    return this.previewResult;
  }

  async executeAction(_input: WidgetActionTarget & { operationId: string }): Promise<ExecuteWidgetActionResult> {
    return this.executeResult;
  }

  dbSchema(): CustomViewsDbSchemaTable[] {
    return this.dbSchemaResult;
  }

  onWidgetDraft(cb: (evt: WidgetDraftEvent) => void): () => void {
    this.draftCb = cb;
    return () => {
      if (this.draftCb === cb) this.draftCb = null;
    };
  }

  emitWidgetDraft(evt: WidgetDraftEvent): void {
    this.draftCb?.(evt);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cyboflow.customViews precondition guard', () => {
  it('throws PRECONDITION_FAILED when the service is unwired', async () => {
    const caller = appRouter.createCaller(createContext({}));
    await expect(caller.cyboflow.customViews.listViews({ surface: 'review-queue' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
  });
});

describe('cyboflow.customViews views', () => {
  it('listViews/createView/updateView happy paths', async () => {
    const service = new FakeCustomViewsService();
    const caller = appRouter.createCaller(createContext({ customViews: service }));

    const created = await caller.cyboflow.customViews.createView({
      surface: 'review-queue',
      name: 'Ship week',
      layout: { version: 1, items: [] },
    });
    expect(created.name).toBe('Ship week');
    expect(created.revision).toBe(1);

    const listed = await caller.cyboflow.customViews.listViews({ surface: 'review-queue' });
    expect(listed.map((v) => v.id)).toContain(created.id);

    const updated = await caller.cyboflow.customViews.updateView({
      id: created.id,
      expectedRevision: created.revision,
      name: 'Ship week (renamed)',
    });
    expect(updated.name).toBe('Ship week (renamed)');
    expect(updated.revision).toBe(2);
  });

  it('maps a CustomViewsStoreError to CONFLICT with message = code', async () => {
    const service = new FakeCustomViewsService();
    service.createViewError = new CustomViewsStoreError('name_taken', "a view named 'Ship week' already exists");
    const caller = appRouter.createCaller(createContext({ customViews: service }));

    await expect(
      caller.cyboflow.customViews.createView({ surface: 'review-queue', name: 'Ship week', layout: { version: 1, items: [] } }),
    ).rejects.toMatchObject({ code: 'CONFLICT', message: 'name_taken' } as Partial<TRPCError>);
  });

  it('maps a not_found CustomViewsStoreError to NOT_FOUND', async () => {
    const service = new FakeCustomViewsService();
    const caller = appRouter.createCaller(createContext({ customViews: service }));

    await expect(
      caller.cyboflow.customViews.updateView({ id: 'missing', expectedRevision: 1, name: 'x' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'not_found' } as Partial<TRPCError>);
  });
});

describe('cyboflow.customViews.runWidget / resetBreaker', () => {
  it('passes settings and refreshSec through to the service unchanged', async () => {
    const service = new FakeCustomViewsService();
    const caller = appRouter.createCaller(createContext({ customViews: service }));

    const result = await caller.cyboflow.customViews.runWidget({
      widget: { type: 'catalog', catalogId: 'stats.tokens-today' },
      settings: { project: 7, groupBy: 'week' },
      refreshSec: 120,
      context: { projectId: 7 },
    });

    expect(result).toEqual(service.runWidgetResult);
    expect(service.lastRunWidgetInput).toEqual({
      widget: { type: 'catalog', catalogId: 'stats.tokens-today' },
      settings: { project: 7, groupBy: 'week' },
      refreshSec: 120,
      context: { projectId: 7 },
    });
  });

  it('runWidget omits refreshSec from the service call when not supplied', async () => {
    const service = new FakeCustomViewsService();
    const caller = appRouter.createCaller(createContext({ customViews: service }));

    await caller.cyboflow.customViews.runWidget({
      widget: { draftOf: 'widget-1' },
      settings: {},
      context: { projectId: null },
    });

    expect(service.lastRunWidgetInput?.refreshSec).toBeUndefined();
  });

  it('resetBreaker forwards the same key inputs (no refreshSec)', async () => {
    const service = new FakeCustomViewsService();
    const caller = appRouter.createCaller(createContext({ customViews: service }));

    await caller.cyboflow.customViews.resetBreaker({
      widget: { type: 'custom', widgetId: 'w-1' },
      settings: { limit: 10 },
      context: { projectId: null },
    });

    expect(service.lastResetBreakerInput).toEqual({
      widget: { type: 'custom', widgetId: 'w-1' },
      settings: { limit: 10 },
      context: { projectId: null },
    });
  });
});

describe('cyboflow.customViews.executeAction', () => {
  it('returns the service result unchanged (navigation arm)', async () => {
    const service = new FakeCustomViewsService();
    service.executeResult = { ok: true, navigation: { target: 'quick-session', sessionId: 's-1' } };
    const caller = appRouter.createCaller(createContext({ customViews: service }));

    const result = await caller.cyboflow.customViews.executeAction({
      operationId: 'op-1',
      viewId: 'view-1',
      viewRevision: 1,
      instanceId: 'item-1',
      actionId: 'open',
      context: { projectId: null },
    });

    expect(result).toEqual(service.executeResult);
  });

  it('returns the service result unchanged (resolve-failure arm)', async () => {
    const service = new FakeCustomViewsService();
    service.executeResult = { ok: false, error: 'stale_view' };
    const caller = appRouter.createCaller(createContext({ customViews: service }));

    const result = await caller.cyboflow.customViews.executeAction({
      operationId: 'op-2',
      viewId: 'view-1',
      viewRevision: 99,
      instanceId: 'item-1',
      actionId: 'open',
      context: { projectId: null },
    });

    expect(result).toEqual({ ok: false, error: 'stale_view' });
  });
});

describe('cyboflow.customViews.onWidgetDraft', () => {
  it('delivers an event emitted on the underlying service', async () => {
    const service = new FakeCustomViewsService();
    const caller = appRouter.createCaller(createContext({ customViews: service }));
    const subscription = await caller.cyboflow.customViews.onWidgetDraft();

    const resultPromise = (async () => {
      for await (const ev of subscription as AsyncIterable<WidgetDraftEvent>) {
        return ev;
      }
      return undefined;
    })();

    const payload: WidgetDraftEvent = { widgetId: 'w-1', authoringSessionId: 'sess-1', kind: 'draft' };
    setImmediate(() => service.emitWidgetDraft(payload));

    expect(await resultPromise).toEqual(payload);
  });
});
