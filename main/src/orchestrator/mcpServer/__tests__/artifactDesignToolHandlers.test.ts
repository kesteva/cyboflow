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
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ArtifactRouter } from '../../artifactRouter';
import { RemoteArtifactFetchError, setRemoteArtifactFetcher } from '../../hosts/remoteArtifactPull';
import { getCyboflowDirectory, getCyboflowSubdirectory, setCyboflowDirectory } from '../../../utils/cyboflowDirectory';

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

describe('ArtifactDesignToolHandlers — remote run pull-back (M2)', () => {
  function remoteCtx() {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, host_id TEXT, session_id TEXT)');
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, host_id TEXT, design_idea_id TEXT)');
    db.prepare('INSERT INTO workflow_runs VALUES (?, ?, ?)').run('run-r', 'host-a', null);
    return makeCtx({
      db: dbAdapter(db),
      resolveReviewItemRunContext: () => ({ ok: true, projectId: 1, actor: 'agent:test' }),
    });
  }

  it('pulls the prototype from the environment BEFORE validating it, then reports it', async () => {
    const previous = getCyboflowDirectory();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-art-pull-'));
    setCyboflowDirectory(tmp);
    const apply = vi.fn(async () => ({ artifactId: 'art-1' }));
    const router = vi.spyOn(ArtifactRouter, 'getInstance').mockReturnValue({ apply } as unknown as ArtifactRouter);
    setRemoteArtifactFetcher({
      fetch: async (req) => {
        expect(req).toMatchObject({ hostId: 'host-a', runKey: 'run-r', relPaths: ['prototype/index.html'] });
        fs.mkdirSync(path.join(req.localDir, 'prototype'), { recursive: true });
        fs.writeFileSync(path.join(req.localDir, 'prototype', 'index.html'), '<!doctype html><p>remote</p>');
      },
    });
    try {
      const { ctx, writes } = remoteCtx();
      await new ArtifactDesignToolHandlers(ctx).handleReportArtifact(
        { type: 'mcp-report-artifact', requestId: 'r1', runId: 'run-r', atype: 'ui-prototype', label: 'Proto' },
        client,
      );
      expect(writes).toEqual([
        { type: 'mcp-query-response', requestId: 'r1', ok: true, data: { artifactId: 'art-1', atype: 'ui-prototype' } },
      ]);
      expect(fs.existsSync(path.join(getCyboflowSubdirectory('artifacts', 'runs', 'run-r'), 'prototype', 'index.html'))).toBe(true);
    } finally {
      setRemoteArtifactFetcher(null);
      router.mockRestore();
      setCyboflowDirectory(previous);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('a file missing on the environment fails the report readably and writes nothing', async () => {
    const apply = vi.fn();
    const router = vi.spyOn(ArtifactRouter, 'getInstance').mockReturnValue({ apply } as unknown as ArtifactRouter);
    setRemoteArtifactFetcher({
      fetch: async () => {
        throw new RemoteArtifactFetchError("prototype/index.html was not found in this run's artifacts folder on the environment");
      },
    });
    try {
      const { ctx, writes } = remoteCtx();
      await new ArtifactDesignToolHandlers(ctx).handleReportArtifact(
        { type: 'mcp-report-artifact', requestId: 'r2', runId: 'run-r', atype: 'ui-prototype', label: 'Proto' },
        client,
      );
      expect(writes.map((w) => w.error)).toEqual([
        "invalid_payload: remote_artifact_unavailable: prototype/index.html was not found in this run's artifacts folder on the environment",
      ]);
      expect(apply).not.toHaveBeenCalled();
    } finally {
      setRemoteArtifactFetcher(null);
      router.mockRestore();
    }
  });
});

