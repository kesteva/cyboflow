/**
 * ReviewItemToolHandlers — the review-queue tool family split out of
 * McpQueryHandler (issue #19). The family's full behaviour is still driven
 * end-to-end through the handler in mcpQueryHandler.test.ts and the
 * reviewItemChokepoint integration test; these tests pin the SEAM instead:
 * the write guard the handler hands over as a closure is what the write tools
 * consult, and replies go through the injected `writeResponse`.
 */
import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import type * as net from 'net';
import { ReviewItemToolHandlers, type ReviewItemToolContext } from '../handlers/reviewItemToolHandlers';
import type { McpQueryResponse } from '../mcpQueryMessages';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';

function makeCtx(overrides: Partial<ReviewItemToolContext> = {}): {
  ctx: ReviewItemToolContext;
  writes: McpQueryResponse[];
} {
  const writes: McpQueryResponse[] = [];
  const ctx: ReviewItemToolContext = {
    db: dbAdapter(new Database(':memory:')),
    deps: {},
    writeResponse: (_client, response) => {
      writes.push(response);
    },
    resolveReviewItemRunContext: (runId) => ({ ok: false, error: `run_not_active:${runId}` }),
    ...overrides,
  };
  return { ctx, writes };
}

const client = {} as net.Socket;

describe('ReviewItemToolHandlers — context seam', () => {
  it('report-finding and get-selected-findings refuse a run the injected write guard rejects, with its error', () => {
    const resolveReviewItemRunContext = vi.fn((runId: string) => ({ ok: false as const, error: `run_not_active:${runId}` }));
    const { ctx, writes } = makeCtx({ resolveReviewItemRunContext });
    const tools = new ReviewItemToolHandlers(ctx);

    tools.handleReportFinding(
      { type: 'mcp-report-finding', requestId: 'r1', runId: 'run-a', title: 't', body: 'b' },
      client,
    );
    tools.handleGetSelectedFindings({ type: 'mcp-get-selected-findings', requestId: 'r2', runId: 'run-b' }, client);

    expect(resolveReviewItemRunContext.mock.calls.map((c) => c[0])).toEqual(['run-a', 'run-b']);
    expect(writes).toEqual([
      { type: 'mcp-query-response', requestId: 'r1', ok: false, error: 'run_not_active:run-a' },
      { type: 'mcp-query-response', requestId: 'r2', ok: false, error: 'run_not_active:run-b' },
    ]);
  });
});
