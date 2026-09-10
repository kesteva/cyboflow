/**
 * Unit tests for the S6 custom-widget-authoring global-agent tools
 * (mcp-db-schema / mcp-widget-preview / mcp-widget-save) on McpQueryHandler —
 * docs/proposals/CUSTOM-VIEWS.md §7.2 / §9 row S6.
 *
 * Modeled on mcpDbQuery.test.ts's structure (happy path / validation
 * rejections / scope guard / unavailable-dep) but, unlike that file, these
 * handlers never touch `this.db` directly — they delegate entirely to the
 * injected `customViews: CustomViewsServiceLike` dep, so a plain in-memory
 * sqlite handle (no migrations) is enough for the constructor's mandatory
 * `db` argument, and the service itself is a hand-rolled fake (same idiom as
 * `orchestrator/trpc/routers/__tests__/customViews.test.ts`'s
 * FakeCustomViewsService).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { McpQueryHandler, type McpQueryResponse } from '../mcpQueryHandler';
import type * as net from 'net';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import { CustomViewsStoreError, type StoredCustomView } from '../../customViews/types';
import type {
  CustomViewsServiceLike,
  CustomViewsDbSchemaTable,
  ResetBreakerInput,
  RunWidgetInput,
  WidgetDraftEvent,
} from '../../customViews/customViewsService';
import type { ExecuteWidgetActionResult, WidgetActionPreview } from '../../customViews/widgetActionService';
import type { CustomView, CustomViewSurface, CustomWidget, ViewLayout, WidgetDataPayload } from '../../../../../shared/types/customViews';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSocketDouble(): { socket: net.Socket; writes: string[] } {
  const writes: string[] = [];
  const socket = {
    write: (chunk: string | Buffer) => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      return true;
    },
  } as unknown as net.Socket;
  return { socket, writes };
}

function parseLastWrite(writes: string[]): McpQueryResponse {
  return JSON.parse(writes[writes.length - 1]) as McpQueryResponse;
}

const AGENT_RUN_ID = 'agent:thread-widget-test';

const VALID_SPEC_JSON = JSON.stringify({
  version: 1,
  sources: { s: { type: 'sql', sql: 'SELECT 1 AS n' } },
  render: { type: 'shape', shape: 'stat', source: 's', value: 'n' },
});

// The `render.source` names an undeclared source — a cross-field rule
// (widgetSpecSchema's superRefine), not a shape error, so the issue path is
// ['render', 'source'].
const INVALID_SPEC_JSON = JSON.stringify({
  version: 1,
  sources: { s: { type: 'sql', sql: 'SELECT 1 AS n' } },
  render: { type: 'shape', shape: 'stat', source: 'missing', value: 'n' },
});

type SaveWidgetInput = Parameters<CustomViewsServiceLike['saveWidget']>[0];

// ---------------------------------------------------------------------------
// Fake CustomViewsServiceLike
// ---------------------------------------------------------------------------

class FakeCustomViewsService implements CustomViewsServiceLike {
  dbSchemaRows: CustomViewsDbSchemaTable[] = [];
  runWidgetImpl: (input: RunWidgetInput) => Promise<WidgetDataPayload> = async () => ({
    sources: {},
    warnings: [],
    computedAt: '2026-01-01T00:00:00Z',
  });
  saveWidgetImpl: (input: SaveWidgetInput) => CustomWidget = (input) => ({
    id: input.id ?? 'widget-1',
    name: input.name,
    description: input.description ?? null,
    publishedSpec: input.publish ? input.spec : null,
    draftSpec: input.publish ? null : input.spec,
    authoringSessionId: input.publish ? null : input.authoringSessionId,
    revision: 1,
    threadId: input.threadId ?? null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  });

  lastRunWidgetInput: RunWidgetInput | null = null;
  lastSaveWidgetInput: SaveWidgetInput | null = null;
  saveWidgetCallCount = 0;
  draftEvents: WidgetDraftEvent[] = [];
  private draftCb: ((evt: WidgetDraftEvent) => void) | null = null;

  listViews(): StoredCustomView[] {
    return [];
  }
  getActiveView(): { viewId: string } {
    return { viewId: 'default' };
  }
  setActiveView(): void {
    // no-op
  }
  createView(input: { surface: CustomViewSurface; name: string; layout: ViewLayout }): CustomView {
    throw new Error(`not implemented: createView(${JSON.stringify(input)})`);
  }
  updateView(): CustomView {
    throw new Error('not implemented: updateView');
  }
  deleteView(): void {
    // no-op
  }

  listWidgets(): CustomWidget[] {
    return [];
  }
  getWidget(): CustomWidget | null {
    return null;
  }
  saveWidget(input: SaveWidgetInput): CustomWidget {
    this.saveWidgetCallCount += 1;
    this.lastSaveWidgetInput = input;
    const widget = this.saveWidgetImpl(input);
    this.emitWidgetDraft({
      widgetId: widget.id,
      authoringSessionId: input.authoringSessionId,
      kind: input.publish ? 'published' : 'draft',
    });
    return widget;
  }
  publishDraft(): CustomWidget {
    throw new Error('not implemented: publishDraft');
  }
  discardDraft(): CustomWidget | null {
    return null;
  }
  deleteWidget(): void {
    // no-op
  }

  async runWidget(input: RunWidgetInput): Promise<WidgetDataPayload> {
    this.lastRunWidgetInput = input;
    return this.runWidgetImpl(input);
  }
  resetBreaker(_input: ResetBreakerInput): void {
    // no-op
  }
  async previewAction(): Promise<WidgetActionPreview> {
    throw new Error('not implemented: previewAction');
  }
  async executeAction(): Promise<ExecuteWidgetActionResult> {
    throw new Error('not implemented: executeAction');
  }

  dbSchema(): CustomViewsDbSchemaTable[] {
    return this.dbSchemaRows;
  }

  onWidgetDraft(cb: (evt: WidgetDraftEvent) => void): () => void {
    this.draftCb = cb;
    return () => {
      if (this.draftCb === cb) this.draftCb = null;
    };
  }
  emitWidgetDraft(evt: WidgetDraftEvent): void {
    this.draftEvents.push(evt);
    this.draftCb?.(evt);
  }
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let memDb: Database.Database;
let fakeCustomViews: FakeCustomViewsService;
let handler: McpQueryHandler;
let handlerNoDep: McpQueryHandler;

beforeEach(() => {
  memDb = new Database(':memory:');
  fakeCustomViews = new FakeCustomViewsService();
  handler = new McpQueryHandler(dbAdapter(memDb), undefined, { customViews: fakeCustomViews });
  handlerNoDep = new McpQueryHandler(dbAdapter(memDb));
});

// ---------------------------------------------------------------------------
// mcp-db-schema
// ---------------------------------------------------------------------------

describe('mcp-db-schema', () => {
  it('returns every table when no table filter is given', async () => {
    fakeCustomViews.dbSchemaRows = [
      { table: 'widgets', columns: [{ name: 'id', type: 'INTEGER', pk: true, notnull: true }], rowEstimate: 3 },
      { table: 'views', columns: [{ name: 'id', type: 'TEXT', pk: true, notnull: true }], rowEstimate: 1 },
    ];
    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage({ type: 'mcp-db-schema', requestId: 'r1', runId: AGENT_RUN_ID }, socket);
    const resp = parseLastWrite(writes);
    expect(resp.ok).toBe(true);
    const data = resp.data as { tables: CustomViewsDbSchemaTable[] };
    expect(data.tables.map((t) => t.table)).toEqual(['widgets', 'views']);
  });

  it('filters to one table when `table` is given', async () => {
    fakeCustomViews.dbSchemaRows = [
      { table: 'widgets', columns: [], rowEstimate: 3 },
      { table: 'views', columns: [], rowEstimate: 1 },
    ];
    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage({ type: 'mcp-db-schema', requestId: 'r2', runId: AGENT_RUN_ID, table: 'views' }, socket);
    const resp = parseLastWrite(writes);
    expect(resp.ok).toBe(true);
    const data = resp.data as { tables: CustomViewsDbSchemaTable[] };
    expect(data.tables.map((t) => t.table)).toEqual(['views']);
  });

  it('fails closed with custom_views_unavailable when the dep is absent', async () => {
    const { socket, writes } = makeSocketDouble();
    await handlerNoDep.handleMessage({ type: 'mcp-db-schema', requestId: 'r3', runId: AGENT_RUN_ID }, socket);
    const resp = parseLastWrite(writes);
    expect(resp.ok).toBe(false);
    expect(resp.error).toBe('custom_views_unavailable');
  });

  it('rejects a run-scoped (non agent:) runId', async () => {
    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage({ type: 'mcp-db-schema', requestId: 'r4', runId: 'not-an-agent-run-id' }, socket);
    const resp = parseLastWrite(writes);
    expect(resp.ok).toBe(false);
    expect(resp.error).toBe('not_a_global_agent_run');
  });
});

// ---------------------------------------------------------------------------
// mcp-widget-preview
// ---------------------------------------------------------------------------

describe('mcp-widget-preview', () => {
  it('rejects malformed JSON with invalid_json', async () => {
    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage(
      { type: 'mcp-widget-preview', requestId: 'r5', runId: AGENT_RUN_ID, specJson: '{not json' },
      socket,
    );
    const resp = parseLastWrite(writes);
    expect(resp.ok).toBe(false);
    expect(resp.error).toBe('invalid_json');
  });

  it('rejects an invalid spec with invalid_spec and a path in detail', async () => {
    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage(
      { type: 'mcp-widget-preview', requestId: 'r6', runId: AGENT_RUN_ID, specJson: INVALID_SPEC_JSON },
      socket,
    );
    const resp = parseLastWrite(writes);
    expect(resp.ok).toBe(false);
    expect(resp.error).toBe('invalid_spec');
    const data = resp.data as { detail: string[] };
    expect(data.detail.some((line) => line.startsWith('render.source'))).toBe(true);
  });

  it('rejects malformed settings_json with invalid_settings', async () => {
    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage(
      {
        type: 'mcp-widget-preview',
        requestId: 'r7',
        runId: AGENT_RUN_ID,
        specJson: VALID_SPEC_JSON,
        settingsJson: '{not json',
      },
      socket,
    );
    const resp = parseLastWrite(writes);
    expect(resp.ok).toBe(false);
    expect(resp.error).toBe('invalid_settings');
  });

  it('happy path: runs the resolved spec through customViews.runWidget and caps rows at 50', async () => {
    fakeCustomViews.runWidgetImpl = async () => ({
      sources: {
        s: {
          columns: ['n'],
          rows: Array.from({ length: 60 }, (_, i) => ({ n: i })),
          truncated: false,
          tookMs: 4,
        },
      },
      warnings: [],
      computedAt: '2026-01-01T00:00:00Z',
    });

    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage(
      { type: 'mcp-widget-preview', requestId: 'r8', runId: AGENT_RUN_ID, specJson: VALID_SPEC_JSON, projectId: 7 },
      socket,
    );
    const resp = parseLastWrite(writes);
    expect(resp.ok).toBe(true);
    const data = resp.data as { sources: Record<string, { rows: unknown[]; truncatedForTranscript?: boolean }> };
    expect(data.sources.s.rows).toHaveLength(50);
    expect(data.sources.s.truncatedForTranscript).toBe(true);

    // The spec was resolved as `{inline}` and projectId threaded through.
    expect(fakeCustomViews.lastRunWidgetInput?.context).toEqual({ projectId: 7 });
    expect(fakeCustomViews.lastRunWidgetInput?.widget).toMatchObject({ inline: { version: 1 } });
  });

  it('never saves — the fake exposes no save call on the preview path', async () => {
    const { socket } = makeSocketDouble();
    await handler.handleMessage(
      { type: 'mcp-widget-preview', requestId: 'r9', runId: AGENT_RUN_ID, specJson: VALID_SPEC_JSON },
      socket,
    );
    expect(fakeCustomViews.saveWidgetCallCount).toBe(0);
  });

  it('fails closed with custom_views_unavailable when the dep is absent', async () => {
    const { socket, writes } = makeSocketDouble();
    await handlerNoDep.handleMessage(
      { type: 'mcp-widget-preview', requestId: 'r10', runId: AGENT_RUN_ID, specJson: VALID_SPEC_JSON },
      socket,
    );
    const resp = parseLastWrite(writes);
    expect(resp.ok).toBe(false);
    expect(resp.error).toBe('custom_views_unavailable');
  });

  it('rejects a run-scoped (non agent:) runId', async () => {
    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage(
      { type: 'mcp-widget-preview', requestId: 'r11', runId: 'not-an-agent-run-id', specJson: VALID_SPEC_JSON },
      socket,
    );
    const resp = parseLastWrite(writes);
    expect(resp.ok).toBe(false);
    expect(resp.error).toBe('not_a_global_agent_run');
  });

  it('a bad source (agent-authored SQL) is logged at WARN, never ERROR', async () => {
    fakeCustomViews.runWidgetImpl = async () => {
      throw new Error('no such column: bogus');
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage(
        { type: 'mcp-widget-preview', requestId: 'r12', runId: AGENT_RUN_ID, specJson: VALID_SPEC_JSON },
        socket,
      );
      const resp = parseLastWrite(writes);
      expect(resp.ok).toBe(false);
      expect(resp.error).toContain('no such column');

      expect(error).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0][0]);
      expect(line).toContain('mcp-widget-preview');
      expect(line).toContain('no such column');
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// mcp-widget-save
// ---------------------------------------------------------------------------

describe('mcp-widget-save', () => {
  it('draft save (publish:false) emits onWidgetDraft with kind "draft" and returns { widgetId, revision }', async () => {
    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage(
      {
        type: 'mcp-widget-save',
        requestId: 'r13',
        runId: AGENT_RUN_ID,
        sessionId: 'sess-1',
        name: 'My widget',
        specJson: VALID_SPEC_JSON,
        publish: false,
      },
      socket,
    );
    const resp = parseLastWrite(writes);
    expect(resp.ok).toBe(true);
    expect(resp.data).toEqual({ widgetId: 'widget-1', revision: 1 });

    expect(fakeCustomViews.saveWidgetCallCount).toBe(1);
    expect(fakeCustomViews.lastSaveWidgetInput).toMatchObject({
      name: 'My widget',
      authoringSessionId: 'sess-1',
      publish: false,
      threadId: 'thread-widget-test',
    });
    expect(fakeCustomViews.draftEvents).toEqual([{ widgetId: 'widget-1', authoringSessionId: 'sess-1', kind: 'draft' }]);
  });

  it('publish:true emits onWidgetDraft with kind "published"', async () => {
    const { socket } = makeSocketDouble();
    await handler.handleMessage(
      {
        type: 'mcp-widget-save',
        requestId: 'r14',
        runId: AGENT_RUN_ID,
        sessionId: 'sess-1',
        widgetId: 'w-42',
        name: 'My widget',
        specJson: VALID_SPEC_JSON,
        publish: true,
      },
      socket,
    );
    expect(fakeCustomViews.lastSaveWidgetInput).toMatchObject({ id: 'w-42', publish: true });
    expect(fakeCustomViews.draftEvents).toEqual([{ widgetId: 'w-42', authoringSessionId: 'sess-1', kind: 'published' }]);
  });

  it('rejects malformed JSON with invalid_json', async () => {
    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage(
      {
        type: 'mcp-widget-save',
        requestId: 'r15',
        runId: AGENT_RUN_ID,
        sessionId: 'sess-1',
        name: 'x',
        specJson: '{not json',
        publish: false,
      },
      socket,
    );
    expect(parseLastWrite(writes).error).toBe('invalid_json');
    expect(fakeCustomViews.saveWidgetCallCount).toBe(0);
  });

  it('rejects an invalid spec with invalid_spec and a path in detail', async () => {
    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage(
      {
        type: 'mcp-widget-save',
        requestId: 'r16',
        runId: AGENT_RUN_ID,
        sessionId: 'sess-1',
        name: 'x',
        specJson: INVALID_SPEC_JSON,
        publish: false,
      },
      socket,
    );
    const resp = parseLastWrite(writes);
    expect(resp.error).toBe('invalid_spec');
    const data = resp.data as { detail: string[] };
    expect(data.detail.some((line) => line.startsWith('render.source'))).toBe(true);
    expect(fakeCustomViews.saveWidgetCallCount).toBe(0);
  });

  it('passes a CustomViewsStoreError code (e.g. session_mismatch) through unchanged', async () => {
    fakeCustomViews.saveWidgetImpl = () => {
      throw new CustomViewsStoreError('session_mismatch', 'w-1');
    };
    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage(
      {
        type: 'mcp-widget-save',
        requestId: 'r17',
        runId: AGENT_RUN_ID,
        sessionId: 'sess-1',
        widgetId: 'w-1',
        name: 'x',
        specJson: VALID_SPEC_JSON,
        publish: false,
      },
      socket,
    );
    const resp = parseLastWrite(writes);
    expect(resp.ok).toBe(false);
    expect(resp.error).toBe('session_mismatch');
  });

  it('fails closed with custom_views_unavailable when the dep is absent', async () => {
    const { socket, writes } = makeSocketDouble();
    await handlerNoDep.handleMessage(
      {
        type: 'mcp-widget-save',
        requestId: 'r18',
        runId: AGENT_RUN_ID,
        sessionId: 'sess-1',
        name: 'x',
        specJson: VALID_SPEC_JSON,
        publish: false,
      },
      socket,
    );
    const resp = parseLastWrite(writes);
    expect(resp.ok).toBe(false);
    expect(resp.error).toBe('custom_views_unavailable');
  });

  it('rejects a run-scoped (non agent:) runId without calling saveWidget (scope denial)', async () => {
    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage(
      {
        type: 'mcp-widget-save',
        requestId: 'r19',
        runId: 'not-an-agent-run-id',
        sessionId: 'sess-1',
        name: 'x',
        specJson: VALID_SPEC_JSON,
        publish: false,
      },
      socket,
    );
    const resp = parseLastWrite(writes);
    expect(resp.ok).toBe(false);
    expect(resp.error).toBe('not_a_global_agent_run');
    expect(fakeCustomViews.saveWidgetCallCount).toBe(0);
  });
});
