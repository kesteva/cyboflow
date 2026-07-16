/**
 * mcpQueryHandler — interactive-question-open dispatch (INTERACTIVE substrate
 * AskUserQuestion notify hook, questionShellHook.ts).
 *
 * Fire-and-ack: the handler always replies ok:true (the hook never gates the
 * question) and forwards the runId to the injected onInteractiveQuestionOpen dep
 * (interactiveClaudeManager.notifyQuestionOpen, which flips the quick-session
 * board to `blocked`). In its OWN file — modeled on mcpQueryHandler.workflowConfig
 * (no global electron/autoMint mocks) — so it never perturbs the delicate mock
 * ordering of the main mcpQueryHandler.test.ts suite.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { McpQueryHandler, type McpQueryResponse } from '../mcpQueryHandler';
import type * as net from 'net';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import { createTestDb } from '../../__test_fixtures__/orchestratorTestDb';

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

describe('mcpQueryHandler — interactive-question-open', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb({ disableForeignKeys: true });
  });

  afterEach(() => {
    db.close();
  });

  it('ok:true and forwards runId to the injected dep', async () => {
    const onInteractiveQuestionOpen = vi.fn();
    const handler = new McpQueryHandler(dbAdapter(db), undefined, { onInteractiveQuestionOpen });
    const { socket, writes } = makeSocketDouble();

    await handler.handleMessage(
      { type: 'interactive-question-open', requestId: 'iqo-1', runId: 'run-1' },
      socket,
    );

    expect(onInteractiveQuestionOpen).toHaveBeenCalledWith('run-1');
    const response = parseLastWrite(writes);
    expect(response.type).toBe('mcp-query-response');
    expect(response.requestId).toBe('iqo-1');
    expect(response.ok).toBe(true);
    expect(response.error).toBeUndefined();
  });

  it('ok:true even when no dep is wired (best-effort — the board just misses it)', async () => {
    const handler = new McpQueryHandler(dbAdapter(db));
    const { socket, writes } = makeSocketDouble();

    await handler.handleMessage(
      { type: 'interactive-question-open', requestId: 'iqo-2', runId: 'run-1' },
      socket,
    );

    expect(parseLastWrite(writes).ok).toBe(true);
  });

  it('does not call the dep for an empty runId, and still replies ok:true exactly once', async () => {
    const onInteractiveQuestionOpen = vi.fn();
    const handler = new McpQueryHandler(dbAdapter(db), undefined, { onInteractiveQuestionOpen });
    const { socket, writes } = makeSocketDouble();

    await expect(
      handler.handleMessage({ type: 'interactive-question-open', requestId: 'iqo-3', runId: '' }, socket),
    ).resolves.toBeUndefined();

    expect(onInteractiveQuestionOpen).not.toHaveBeenCalled();
    expect(writes).toHaveLength(1);
    expect(parseLastWrite(writes).ok).toBe(true);
  });
});
