/**
 * Unit tests for WidgetActionService (docs/proposals/CUSTOM-VIEWS.md §4.4 /
 * §10 "Actions never bypass the executor and never trust the client").
 *
 * The store, the proposal writer and the executor are fakes so the assertions
 * are about THIS class's decisions; the data service is real, over a temp-file
 * database, because server-side row resolution is one of the guarantees under
 * test and a fake would assert nothing about it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentProposal,
  AgentProposalPayload,
  AgentProposalPreconditions,
} from '../../../../../shared/types/agentThread';
import type { CustomView, CustomWidget, WidgetSpec } from '../../../../../shared/types/customViews';
import type { ExecuteProposalResult } from '../../agentThread/proposalExecutor';
import type { PrepareProposalResult } from '../../agentThread/prepareProposal';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import { closeReadonlySiblings } from '../../readOnlyQuery';
import type { CustomViewsStoreLike, StoredCustomView } from '../types';
import { WidgetDataService } from '../widgetDataService';
import { WidgetActionService, type WidgetActionServiceDeps } from '../widgetActionService';
import type { DatabaseLike } from '../../types';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const ROW_SPEC: WidgetSpec = {
  version: 1,
  sources: { rows: { type: 'sql', sql: 'SELECT id, label FROM items ORDER BY id' } },
  render: { type: 'shape', shape: 'table', source: 'rows', columns: [{ field: 'label' }] },
  actions: [
    {
      id: 'bump',
      label: 'Bump',
      kind: 'reprioritize-backlog',
      placement: 'row',
      rowKey: 'id',
      params: { projectId: '{context.projectId}', taskId: '{row.label}' },
    },
    {
      id: 'header-launch',
      label: 'Launch',
      kind: 'launch-run',
      placement: 'header',
      params: { projectId: '{context.projectId}', workflowName: 'sprint' },
    },
    {
      id: 'go',
      label: 'Go',
      kind: 'navigate',
      placement: 'header',
      params: {},
      navigation: { target: 'backlog', projectId: '{context.projectId}' } as never,
    },
    {
      id: 'open',
      label: 'Open',
      kind: 'open-session',
      placement: 'row',
      rowKey: 'id',
      params: { target: 'run', runId: '{row.label}' },
    },
    {
      id: 'broken-template',
      label: 'Broken',
      kind: 'launch-run',
      placement: 'header',
      params: { workflowName: '{row.label}' },
    },
    { id: 'keyless-row', label: 'Keyless', kind: 'launch-run', placement: 'row', params: {} },
  ],
};

const VIEW: CustomView = {
  id: 'view-1',
  surface: 'review-queue',
  name: 'Mine',
  revision: 3,
  layout: {
    version: 1,
    items: [
      { instanceId: 'inst-1', widget: { type: 'custom', widgetId: 'w-1' }, settings: {} },
      { instanceId: 'inst-section', widget: { type: 'catalog', catalogId: 'queue.backlog' }, settings: {} },
    ],
  },
  createdAt: '2026-09-10T00:00:00.000Z',
  updatedAt: '2026-09-10T00:00:00.000Z',
};

const TARGET = {
  viewId: 'view-1',
  viewRevision: 3,
  instanceId: 'inst-1',
  actionId: 'bump',
  rowKeyValue: 2 as number,
  context: { projectId: 7 },
};

let tmpDir: string;
let rawDb: Database.Database;
let db: DatabaseLike;
let views: Map<string, StoredCustomView>;
let widgets: Map<string, CustomWidget>;
let proposals: Map<string, AgentProposal>;
let createProposal: ReturnType<typeof vi.fn>;
let execute: ReturnType<typeof vi.fn>;
let prepare: ReturnType<typeof vi.fn>;
let idCounter: number;
let service: WidgetActionService;

function makeWidget(spec: WidgetSpec | null, draft: WidgetSpec | null = null): CustomWidget {
  return {
    id: 'w-1',
    name: 'Items',
    description: null,
    publishedSpec: spec,
    draftSpec: draft,
    authoringSessionId: null,
    revision: 1,
    threadId: null,
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
  };
}

function storeDouble(): CustomViewsStoreLike {
  const unsupported = () => {
    throw new Error('not used by these tests');
  };
  return {
    listViews: () => [...views.values()],
    getView: (id: string) => views.get(id) ?? null,
    createView: unsupported,
    updateView: unsupported,
    deleteView: unsupported,
    listWidgets: () => [...widgets.values()],
    getWidget: (id: string) => widgets.get(id) ?? null,
    saveDraft: unsupported,
    publishDraft: unsupported,
    discardDraft: unsupported,
    deleteWidget: unsupported,
    getActiveViewId: () => null,
    setActiveViewId: () => undefined,
  } as unknown as CustomViewsStoreLike;
}

const EXECUTED: ExecuteProposalResult = {
  ok: true,
  proposalId: 'p-1',
  kind: 'reprioritize-backlog',
  status: 'executed',
  result: { kind: 'reprioritize-backlog', applied: [], failed: [] } as never,
};

function makeService(overrides: Partial<WidgetActionServiceDeps> = {}): WidgetActionService {
  const deps: WidgetActionServiceDeps = {
    store: storeDouble(),
    data: new WidgetDataService({ db }),
    catalogSpecs: {},
    db,
    ensureGlobalThreadId: () => 'thread-global',
    createProposal: createProposal as unknown as WidgetActionServiceDeps['createProposal'],
    prepare: prepare as unknown as WidgetActionServiceDeps['prepare'],
    execute: execute as unknown as WidgetActionServiceDeps['execute'],
    getProposal: (id: string) => proposals.get(id) ?? null,
    newId: () => `p-${++idCounter}`,
    ...overrides,
  };
  return new WidgetActionService(deps);
}

beforeEach(() => {
  idCounter = 0;
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-widget-action-'));
  rawDb = new Database(join(tmpDir, 'test.db'));
  rawDb.exec(`
    CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT);
    CREATE TABLE agent_proposals (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, kind TEXT NOT NULL);
    CREATE TABLE widget_action_log (
      proposal_id TEXT PRIMARY KEY REFERENCES agent_proposals(id) ON DELETE CASCADE,
      operation_id TEXT NOT NULL UNIQUE,
      view_id TEXT NOT NULL,
      view_revision INTEGER NOT NULL,
      instance_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  rawDb.prepare('INSERT INTO items (id, label) VALUES (1, ?)').run('TASK-001');
  rawDb.prepare('INSERT INTO items (id, label) VALUES (2, ?)').run('TASK-002');
  db = dbAdapter(rawDb);

  views = new Map([[VIEW.id, VIEW]]);
  widgets = new Map([['w-1', makeWidget(ROW_SPEC)]]);
  proposals = new Map();

  createProposal = vi.fn((input: { id: string; threadId: string; payload: AgentProposalPayload; preconditions: AgentProposalPreconditions | null }) => {
    // Mirror the real store: the proposal row must exist before the log row's
    // foreign key can point at it.
    rawDb.prepare('INSERT INTO agent_proposals (id, thread_id, kind) VALUES (?, ?, ?)').run(
      input.id,
      input.threadId,
      input.payload.kind,
    );
    const proposal = { id: input.id, threadId: input.threadId, kind: input.payload.kind } as unknown as AgentProposal;
    proposals.set(input.id, proposal);
    return proposal;
  });
  prepare = vi.fn(
    (raw: unknown): PrepareProposalResult => ({
      ok: true,
      payload: raw as AgentProposalPayload,
      preconditions: null,
    }),
  );
  execute = vi.fn(async (): Promise<ExecuteProposalResult> => EXECUTED);

  service = makeService();
});

afterEach(() => {
  closeReadonlySiblings();
  rawDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// resolve / refusals
// ---------------------------------------------------------------------------

describe('WidgetActionService — refusals', () => {
  it('refuses a stale viewRevision with stale_view', async () => {
    const result = await service.resolve({ ...TARGET, viewRevision: 2 });
    expect(result).toEqual({ ok: false, error: 'stale_view' });
  });

  it('refuses an unknown view with not_found', async () => {
    expect(await service.resolve({ ...TARGET, viewId: 'nope' })).toEqual({ ok: false, error: 'not_found' });
  });

  it('refuses a corrupt view with not_found', async () => {
    views.set('view-1', { ...VIEW, layout: null, corrupt: true } as unknown as StoredCustomView);
    expect(await service.resolve(TARGET)).toEqual({ ok: false, error: 'not_found' });
  });

  it('refuses an unknown instanceId with not_found', async () => {
    expect(await service.resolve({ ...TARGET, instanceId: 'nope' })).toEqual({ ok: false, error: 'not_found' });
  });

  it('refuses a catalog SECTION (no spec) with not_found', async () => {
    expect(await service.resolve({ ...TARGET, instanceId: 'inst-section' })).toEqual({
      ok: false,
      error: 'not_found',
    });
  });

  it('refuses an unknown actionId with invalid_action', async () => {
    expect(await service.resolve({ ...TARGET, actionId: 'nope' })).toEqual({ ok: false, error: 'invalid_action' });
  });

  it('refuses a widget with only a draft spec with draft_only', async () => {
    widgets.set('w-1', makeWidget(null, ROW_SPEC));
    expect(await service.resolve(TARGET)).toEqual({ ok: false, error: 'draft_only' });
  });

  it('refuses a row action whose spec declares no rowKey with invalid_action', async () => {
    expect(await service.resolve({ ...TARGET, actionId: 'keyless-row' })).toEqual({
      ok: false,
      error: 'invalid_action',
    });
  });

  it('refuses a rowKeyValue that matches no row with stale_row', async () => {
    expect(await service.resolve({ ...TARGET, rowKeyValue: 999 })).toEqual({ ok: false, error: 'stale_row' });
  });

  it('refuses a row action with no rowKeyValue at all with stale_row', async () => {
    expect(await service.resolve({ ...TARGET, rowKeyValue: undefined })).toEqual({ ok: false, error: 'stale_row' });
  });

  it('refuses a template that names a field no row supplies', async () => {
    const result = await service.resolve({ ...TARGET, actionId: 'broken-template', rowKeyValue: undefined });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/^invalid_params:/);
  });
});

// ---------------------------------------------------------------------------
// resolve / preview
// ---------------------------------------------------------------------------

describe('WidgetActionService — resolution', () => {
  it('substitutes templates from the SERVER-resolved row, matched as strings', async () => {
    const result = await service.resolve({ ...TARGET, rowKeyValue: '2' });
    expect(result.ok).toBe(true);
    expect(result.ok === true && result.resolvedParams).toEqual({ projectId: 7, taskId: 'TASK-002' });
  });

  it('preview returns the label, kind and resolved arguments', async () => {
    const preview = await service.preview(TARGET);
    expect(preview).toEqual({
      ok: true,
      preview: { label: 'Bump', kind: 'reprioritize-backlog', resolvedParams: { projectId: 7, taskId: 'TASK-002' } },
    });
  });

  it('preview creates no proposal', async () => {
    await service.preview(TARGET);
    expect(createProposal).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// executeAction
// ---------------------------------------------------------------------------

describe('WidgetActionService — executeAction', () => {
  it('returns navigation for kind navigate without minting a proposal', async () => {
    const result = await service.executeAction({
      ...TARGET,
      actionId: 'go',
      rowKeyValue: undefined,
      operationId: 'op-nav',
    });
    expect(result).toEqual({ ok: true, navigation: { target: 'backlog', projectId: 7 } });
    expect(createProposal).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns the resolved params AS the navigation for kind open-session', async () => {
    const result = await service.executeAction({ ...TARGET, actionId: 'open', operationId: 'op-open' });
    expect(result).toEqual({ ok: true, navigation: { target: 'run', runId: 'TASK-002' } });
    expect(createProposal).not.toHaveBeenCalled();
  });

  it('writes the proposal and the log row BEFORE calling the executor', async () => {
    let rowsAtExecute = -1;
    execute.mockImplementation(async () => {
      rowsAtExecute = (rawDb.prepare('SELECT COUNT(*) AS n FROM widget_action_log').get() as { n: number }).n;
      return EXECUTED;
    });
    await service.executeAction({ ...TARGET, operationId: 'op-1' });
    expect(rowsAtExecute).toBe(1);
    const logged = rawDb.prepare('SELECT * FROM widget_action_log').get() as Record<string, unknown>;
    expect(logged.operation_id).toBe('op-1');
    expect(logged.view_id).toBe('view-1');
    expect(logged.view_revision).toBe(3);
    expect(logged.instance_id).toBe('inst-1');
    expect(logged.action_id).toBe('bump');
    expect(logged.proposal_id).toBe('p-1');
  });

  it('passes the prepared payload to the shared proposal preparation', async () => {
    await service.executeAction({ ...TARGET, operationId: 'op-prep' });
    expect(prepare).toHaveBeenCalledWith({
      kind: 'reprioritize-backlog',
      projectId: 7,
      taskId: 'TASK-002',
    });
  });

  it('passes a prepare refusal straight back as the error', async () => {
    prepare.mockReturnValue({ ok: false, error: 'task_not_found:TASK-002' });
    const result = await service.executeAction({ ...TARGET, operationId: 'op-bad' });
    expect(result).toEqual({ ok: false, error: 'task_not_found:TASK-002' });
    expect(createProposal).not.toHaveBeenCalled();
  });

  it('returns the executor result unchanged', async () => {
    const result = await service.executeAction({ ...TARGET, operationId: 'op-2' });
    expect(result).toEqual({ ok: true, result: EXECUTED });
  });

  it("passes through an ok:true status:'failed' result without reinterpreting it", async () => {
    const failed: ExecuteProposalResult = {
      ok: true,
      proposalId: 'p-1',
      kind: 'reprioritize-backlog',
      status: 'failed',
      result: { kind: 'reprioritize-backlog', applied: [], failed: [{ taskId: 'TASK-002', error: 'boom' }] } as never,
    };
    execute.mockResolvedValue(failed);
    const result = await service.executeAction({ ...TARGET, operationId: 'op-3' });
    expect(result).toEqual({ ok: true, result: failed });
  });

  it('passes through an ok:false superseded loopback unchanged', async () => {
    const superseded: ExecuteProposalResult = { ok: false, reason: 'superseded', loopbackTurn: 'retry please' };
    execute.mockResolvedValue(superseded);
    const result = await service.executeAction({ ...TARGET, operationId: 'op-4' });
    expect(result).toEqual({ ok: true, result: superseded });
  });

  it('replays the FIRST proposal for a repeated operationId, minting nothing new', async () => {
    const first = await service.executeAction({ ...TARGET, operationId: 'op-same' });
    expect(first).toEqual({ ok: true, result: EXECUTED });
    expect(createProposal).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);

    const replay = await service.executeAction({ ...TARGET, operationId: 'op-same' });
    expect(replay).toEqual({ ok: true, replay: true, proposal: proposals.get('p-1') });
    expect(createProposal).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect((rawDb.prepare('SELECT COUNT(*) AS n FROM widget_action_log').get() as { n: number }).n).toBe(1);
  });

  it('mints a separate proposal for a different operationId', async () => {
    await service.executeAction({ ...TARGET, operationId: 'op-a' });
    await service.executeAction({ ...TARGET, operationId: 'op-b' });
    expect(createProposal).toHaveBeenCalledTimes(2);
    expect((rawDb.prepare('SELECT COUNT(*) AS n FROM widget_action_log').get() as { n: number }).n).toBe(2);
  });

  it('refuses without touching the executor when the view is stale', async () => {
    const result = await service.executeAction({ ...TARGET, viewRevision: 99, operationId: 'op-stale' });
    expect(result).toEqual({ ok: false, error: 'stale_view' });
    expect(createProposal).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Catalog specs
// ---------------------------------------------------------------------------

describe('WidgetActionService — catalog spec entries', () => {
  it('resolves an action against a catalog SPEC entry', async () => {
    views.set('view-1', {
      ...VIEW,
      layout: {
        version: 1,
        items: [{ instanceId: 'inst-cat', widget: { type: 'catalog', catalogId: 'sessions.recent' }, settings: {} }],
      },
    });
    const withCatalog = makeService({ catalogSpecs: { 'sessions.recent': ROW_SPEC } });
    const result = await withCatalog.resolve({ ...TARGET, instanceId: 'inst-cat' });
    expect(result.ok).toBe(true);
    expect(result.ok === true && result.resolvedParams).toEqual({ projectId: 7, taskId: 'TASK-002' });
  });
});
