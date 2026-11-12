/**
 * VerifyToolHandlers — the verify/eval tool family split out of McpQueryHandler
 * (issue #19). The family's full behaviour is still driven end-to-end through
 * the handler in mcpQueryHandler.test.ts; these tests pin the SEAM instead:
 * every reader the handler hands over as a closure is what the family actually
 * consults, and the replies it writes go through the injected `writeResponse`.
 */
import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import type * as net from 'net';
import { REMOTE_HOST_VERIFY_SKIP_REASON, VerifyToolHandlers, type VerifyToolContext } from '../handlers/verifyToolHandlers';
import type { McpQueryResponse } from '../mcpQueryMessages';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';

function makeCtx(overrides: Partial<VerifyToolContext> = {}): {
  ctx: VerifyToolContext;
  writes: McpQueryResponse[];
  db: Database.Database;
} {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE verification_requests (id TEXT PRIMARY KEY, run_id TEXT NOT NULL)`);
  const writes: McpQueryResponse[] = [];
  const ctx: VerifyToolContext = {
    db: dbAdapter(db),
    deps: {},
    writeResponse: (_client, response) => {
      writes.push(response);
    },
    resolveReviewItemRunContext: (runId) =>
      runId === 'run-ok' ? { ok: true, projectId: 1, actor: 'agent:test' } : { ok: false, error: `run_not_active:${runId}` },
    resolveRunWorktree: () => null,
    resolveProjectPath: () => null,
    readExecutionModel: () => null,
    ...overrides,
  };
  return { ctx, writes, db };
}

const client = {} as net.Socket;

describe('VerifyToolHandlers — context seam', () => {
  it('a run the injected run-context reader rejects is refused with that reader’s error, before any scheduler lookup', () => {
    const resolveReviewItemRunContext = vi.fn(() => ({ ok: false as const, error: 'run_not_active:run-x' }));
    const { ctx, writes } = makeCtx({ resolveReviewItemRunContext });
    const tools = new VerifyToolHandlers(ctx);

    tools.handleGetVerifications({ type: 'mcp-get-verifications', requestId: 'r1', runId: 'run-x' }, client);

    expect(resolveReviewItemRunContext).toHaveBeenCalledWith('run-x');
    expect(writes).toEqual([{ type: 'mcp-query-response', requestId: 'r1', ok: false, error: 'run_not_active:run-x' }]);
  });

  it('with no scheduler singleton initialised, a get-verifications read for a live run replies verification_unavailable through the injected writer', () => {
    const { ctx, writes } = makeCtx();
    const tools = new VerifyToolHandlers(ctx);

    tools.handleGetVerifications({ type: 'mcp-get-verifications', requestId: 'r2', runId: 'run-ok' }, client);

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ requestId: 'r2', ok: false, error: 'verification_unavailable' });
  });

  it('await-verification reads ownership through the injected db: a request id nobody owns is verification_request_not_found', async () => {
    const { ctx, writes, db } = makeCtx();
    db.prepare(`INSERT INTO verification_requests (id, run_id) VALUES ('vr-other', 'run-someone-else')`).run();
    const tools = new VerifyToolHandlers(ctx);

    await tools.handleAwaitVerification(
      { type: 'mcp-await-verification', requestId: 'r3', runId: 'run-ok', verificationRequestId: 'vr-missing' },
      client,
    );
    await tools.handleAwaitVerification(
      { type: 'mcp-await-verification', requestId: 'r4', runId: 'run-ok', verificationRequestId: '' },
      client,
    );

    expect(writes.map((w) => (w.ok ? 'ok' : w.error))).toEqual([
      'verification_request_not_found',
      'invalid_arguments: request_id must be a non-empty verification request id',
    ]);
  });
});

describe('VerifyToolHandlers — remote environment skip (M2)', () => {
  function withRunsTable(db: Database.Database, hostId: string | null): void {
    db.exec(`CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, host_id TEXT, verify_enabled INTEGER, verify_type TEXT)`);
    db.prepare(`INSERT INTO workflow_runs (id, host_id, verify_enabled, verify_type) VALUES ('run-ok', ?, 1, 'static-render-snapshot')`).run(hostId);
  }

  it('a run on a remote host skips with the remote-host reason before any worktree, config or execution-model read', async () => {
    const resolveRunWorktree = vi.fn(() => '/home/u/cf-remote/wt/k');
    const resolveProjectPath = vi.fn(() => '/Users/me/proj');
    const readExecutionModel = vi.fn(() => 'programmatic');
    const { ctx, writes, db } = makeCtx({ resolveRunWorktree, resolveProjectPath, readExecutionModel });
    withRunsTable(db, 'h-remote');
    const tools = new VerifyToolHandlers(ctx);

    await tools.handleRequestVerification(
      { type: 'mcp-request-verification', requestId: 'r5', runId: 'run-ok', intent: 'the page renders' },
      client,
    );

    expect(writes).toEqual([
      { type: 'mcp-query-response', requestId: 'r5', ok: true, data: { skipped: true, reason: REMOTE_HOST_VERIFY_SKIP_REASON } },
    ]);
    expect(REMOTE_HOST_VERIFY_SKIP_REASON.startsWith('remote-host: ')).toBe(true);
    expect(resolveRunWorktree).not.toHaveBeenCalled();
    expect(resolveProjectPath).not.toHaveBeenCalled();
    expect(readExecutionModel).not.toHaveBeenCalled();
  });

  it.each([[null], ['local']])('a local run (host_id %s) is not skipped as remote', async (hostId) => {
    const readExecutionModel = vi.fn(() => null);
    const { ctx, writes, db } = makeCtx({ readExecutionModel });
    withRunsTable(db, hostId);
    db.prepare(`UPDATE workflow_runs SET verify_enabled = 0`).run();
    const tools = new VerifyToolHandlers(ctx);

    await tools.handleRequestVerification(
      { type: 'mcp-request-verification', requestId: 'r6', runId: 'run-ok', intent: 'the page renders' },
      client,
    );

    expect(readExecutionModel).toHaveBeenCalledWith('run-ok');
    expect(writes).toHaveLength(1);
    const data = writes[0].ok ? (writes[0].data as { skipped: boolean; reason: string }) : null;
    expect(data?.skipped).toBe(true);
    expect(data?.reason).not.toMatch(/^remote-host/);
  });

  it('a run-context rejection still wins over the host check', async () => {
    const { ctx, writes, db } = makeCtx();
    withRunsTable(db, 'h-remote');
    const tools = new VerifyToolHandlers(ctx);
    await tools.handleRequestVerification(
      { type: 'mcp-request-verification', requestId: 'r7', runId: 'run-x', intent: 'x' },
      client,
    );
    expect(writes).toEqual([{ type: 'mcp-query-response', requestId: 'r7', ok: false, error: 'run_not_active:run-x' }]);
  });
});
