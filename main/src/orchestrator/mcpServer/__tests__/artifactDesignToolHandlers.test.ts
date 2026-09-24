/**
 * ArtifactDesignToolHandlers — the run-artifact + Design Mode tool family split
 * out of McpQueryHandler (issue #19). The family's full behaviour is still
 * driven end-to-end through the handler in mcpQueryHandler.test.ts and
 * mcpQueryHandler.designScope.test.ts; these tests pin the SEAM instead: the
 * artifact writes consult the write guard the handler hands over as a closure,
 * and replies go through the injected `writeResponse`.
 */
import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import type * as net from 'net';
import {
  ArtifactDesignToolHandlers,
  type ArtifactDesignToolContext,
} from '../handlers/artifactDesignToolHandlers';
import type { McpQueryResponse } from '../mcpQueryMessages';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';

function makeCtx(overrides: Partial<ArtifactDesignToolContext> = {}): {
  ctx: ArtifactDesignToolContext;
  writes: McpQueryResponse[];
} {
  const writes: McpQueryResponse[] = [];
  const ctx: ArtifactDesignToolContext = {
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

describe('ArtifactDesignToolHandlers — context seam', () => {
  it('report-artifact and commit-artifact refuse a run the injected write guard rejects, with its error', async () => {
    const resolveReviewItemRunContext = vi.fn((runId: string) => ({ ok: false as const, error: `run_not_active:${runId}` }));
    const { ctx, writes } = makeCtx({ resolveReviewItemRunContext });
    const tools = new ArtifactDesignToolHandlers(ctx);

    await tools.handleReportArtifact(
      { type: 'mcp-report-artifact', requestId: 'r1', runId: 'run-a', atype: 'generic', label: 'l' },
      client,
    );
    await tools.handleCommitArtifact(
      { type: 'mcp-commit-artifact', requestId: 'r2', runId: 'run-b', artifactId: 'art-1' },
      client,
    );

    expect(resolveReviewItemRunContext.mock.calls.map((c) => c[0])).toEqual(['run-a', 'run-b']);
    expect(writes.map((w) => ({ requestId: w.requestId, ok: w.ok, error: w.error }))).toEqual([
      { requestId: 'r1', ok: false, error: 'run_not_active:run-a' },
      { requestId: 'r2', ok: false, error: 'run_not_active:run-b' },
    ]);
  });
});
