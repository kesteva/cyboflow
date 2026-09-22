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
import { VerifyToolHandlers, type VerifyToolContext } from '../handlers/verifyToolHandlers';
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
