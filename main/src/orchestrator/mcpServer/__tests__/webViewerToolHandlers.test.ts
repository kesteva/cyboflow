/**
 * webViewerToolHandlers — who is asking. The session comes from the run row,
 * never from the agent; a finished run never reaches the seam.
 */
import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import type * as net from 'net';
import { handleWebViewerTool, resolveWebCaller, type WebViewerToolContext } from '../handlers/webViewerToolHandlers';
import type { McpQueryResponse } from '../mcpQueryMessages';
import type { WebViewerAgentLike } from '../../trpc/contracts/webViewerOps';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, session_id TEXT, status TEXT NOT NULL)`);
  const ins = db.prepare('INSERT INTO workflow_runs (id, session_id, status) VALUES (?, ?, ?)');
  ins.run('run-a', 'sess-1', 'running');
  ins.run('run-orphan', null, 'running');
  ins.run('run-done', 'sess-1', 'completed');
  return db;
}

function makeAgent(): WebViewerAgentLike & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    listTabs: vi.fn(async (caller) => {
      calls.push(['list', caller]);
      return { ok: true as const, tabs: [] };
    }),
    readTab: vi.fn(async (caller, args) => {
      calls.push(['read', caller, args]);
      return { ok: false as const, error: 'consent_denied' };
    }),
    openTab: vi.fn(async (caller, args) => {
      calls.push(['open', caller, args]);
      return {
        ok: true as const,
        tab: {
          tabId: 'web:1',
          state: 'hidden' as const,
          openedBy: 'agent' as const,
          ownedByCaller: true,
          access: 'free' as const,
          origin: 'http://localhost:5173',
          url: 'http://localhost:5173/',
          title: null,
        },
      };
    }),
    driveTab: vi.fn(async (caller, args) => {
      calls.push(['drive', caller, args]);
      return { ok: false as const, error: 'origin_changed' };
    }),
    openForUser: vi.fn(async (caller, args) => {
      calls.push(['open-for-user', caller, args]);
      return { ok: true as const, tabId: 'web:u1' };
    }),
  };
}

function makeCtx(agent: WebViewerAgentLike | undefined): { ctx: WebViewerToolContext; writes: McpQueryResponse[] } {
  const writes: McpQueryResponse[] = [];
  return {
    ctx: {
      db: dbAdapter(makeDb()),
      deps: agent ? { webViewerAgent: agent } : {},
      writeResponse: (_c, r) => writes.push(r),
    },
    writes,
  };
}

const client = {} as net.Socket;

describe('resolveWebCaller', () => {
  const db = dbAdapter(makeDb());

  it('keys the caller by the run’s session', () => {
    expect(resolveWebCaller(db, 'run-a')).toEqual({ ok: true, caller: { runId: 'run-a', sessionKey: 'sess-1' } });
  });

  it('falls back to the run id for a run with no session — the key the run pane files its tabs under', () => {
    expect(resolveWebCaller(db, 'run-orphan')).toEqual({
      ok: true,
      caller: { runId: 'run-orphan', sessionKey: 'run-orphan' },
    });
  });

  it('refuses a terminal run, an unknown run and the orchestrator sentinel', () => {
    expect(resolveWebCaller(db, 'run-done')).toEqual({ ok: false, error: 'run_not_active' });
    expect(resolveWebCaller(db, 'nope')).toEqual({ ok: false, error: 'run_not_found' });
    expect(resolveWebCaller(db, 'orchestrator')).toEqual({ ok: false, error: 'web_tools_require_real_run' });
  });
});

describe('handleWebViewerTool', () => {
  it('passes every drive field through to the seam', async () => {
    const agent = makeAgent();
    const { ctx, writes } = makeCtx(agent);
    await handleWebViewerTool(
      ctx,
      { type: 'mcp-drive-web-tab', requestId: 'd1', runId: 'run-a', tabId: 'web:1', action: 'type', selector: '#q', text: 'hi', frame: '2:7' },
      client,
    );
    expect(agent.calls[0]).toEqual([
      'drive',
      { runId: 'run-a', sessionKey: 'sess-1' },
      { tabId: 'web:1', action: 'type', url: undefined, selector: '#q', text: 'hi', expression: undefined, frame: '2:7', reason: undefined },
    ]);
    expect(writes[0]).toMatchObject({ ok: false, error: 'origin_changed' });
  });

  it('replies viewer_unavailable when no seam is wired', async () => {
    const { ctx, writes } = makeCtx(undefined);
    await handleWebViewerTool(ctx, { type: 'mcp-web-tabs', requestId: 'r1', runId: 'run-a' }, client);
    expect(writes).toEqual([{ type: 'mcp-query-response', requestId: 'r1', ok: false, error: 'viewer_unavailable' }]);
  });

  it('never reaches the seam for a finished run', async () => {
    const agent = makeAgent();
    const { ctx, writes } = makeCtx(agent);
    await handleWebViewerTool(ctx, { type: 'mcp-read-web-tab', requestId: 'r2', runId: 'run-done', tabId: 'web:1' }, client);
    expect(agent.calls).toEqual([]);
    expect(writes[0]).toMatchObject({ ok: false, error: 'run_not_active' });
  });

  it('passes the resolved caller and the envelope fields through; strips `ok` from the data', async () => {
    const agent = makeAgent();
    const { ctx, writes } = makeCtx(agent);
    await handleWebViewerTool(
      ctx,
      { type: 'mcp-open-web-tab', requestId: 'r3', runId: 'run-a', url: 'http://localhost:5173/', waitForLoad: true },
      client,
    );
    expect(agent.calls[0]).toEqual([
      'open',
      { runId: 'run-a', sessionKey: 'sess-1' },
      { url: 'http://localhost:5173/', reason: undefined, waitForLoad: true },
    ]);
    expect(writes[0]).toMatchObject({ requestId: 'r3', ok: true, data: { tab: { tabId: 'web:1' } } });
    expect((writes[0] as { data: Record<string, unknown> }).data).not.toHaveProperty('ok');
  });

  it('relays a seam error verbatim', async () => {
    const agent = makeAgent();
    const { ctx, writes } = makeCtx(agent);
    await handleWebViewerTool(
      ctx,
      { type: 'mcp-read-web-tab', requestId: 'r4', runId: 'run-a', tabId: 'web:1', include: ['text'], frame: 'all' },
      client,
    );
    expect(agent.calls[0]).toEqual([
      'read',
      { runId: 'run-a', sessionKey: 'sess-1' },
      { tabId: 'web:1', since: undefined, include: ['text'], frame: 'all', reason: undefined },
    ]);
    expect(writes[0]).toEqual({ type: 'mcp-query-response', requestId: 'r4', ok: false, error: 'consent_denied' });
  });

  it('hands a $BROWSER open to the seam under the run’s session, never the agent-open path', async () => {
    const agent = makeAgent();
    const { ctx, writes } = makeCtx(agent);
    await handleWebViewerTool(
      ctx,
      { type: 'web-open-url', requestId: 'u1', runId: 'run-a', url: 'https://claude.ai/code/artifact/x' },
      client,
    );
    expect(agent.calls).toEqual([
      ['open-for-user', { runId: 'run-a', sessionKey: 'sess-1' }, { url: 'https://claude.ai/code/artifact/x' }],
    ]);
    expect(writes[0]).toEqual({ type: 'mcp-query-response', requestId: 'u1', ok: true, data: { tabId: 'web:u1' } });
  });
});
