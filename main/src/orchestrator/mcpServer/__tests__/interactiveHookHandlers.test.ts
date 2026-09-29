/**
 * InteractiveHookHandlers — the interactive-substrate hook family split out of
 * McpQueryHandler (issue #19). The family's full behaviour is still driven
 * end-to-end through the handler in shellApprovalRouting.test.ts and
 * ompDeferredApproval.test.ts; these tests pin the SEAM instead: the verdicts
 * and acks go through the injected `writeResponse`, the permission-mode read
 * goes through the injected db, and the notify deps are the ones consulted.
 */
import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import type * as net from 'net';
import {
  InteractiveHookHandlers,
  type InteractiveHookContext,
} from '../handlers/interactiveHookHandlers';
import type { McpQueryResponse } from '../mcpQueryMessages';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';

function makeCtx(overrides: Partial<InteractiveHookContext> = {}): {
  ctx: InteractiveHookContext;
  writes: McpQueryResponse[];
  db: Database.Database;
} {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_permission_mode TEXT);
    CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, session_id TEXT, worktree_path TEXT);
  `);
  const writes: McpQueryResponse[] = [];
  const ctx: InteractiveHookContext = {
    db: dbAdapter(db),
    deps: {},
    writeResponse: (_client, response) => {
      writes.push(response);
    },
    resolveRunWorktree: () => null,
    ...overrides,
  };
  return { ctx, writes, db };
}

const client = {} as net.Socket;

describe('InteractiveHookHandlers — context seam', () => {
  it('the orchestrator sentinel is denied through the injected writer without consulting the worktree reader', () => {
    const resolveRunWorktree = vi.fn(() => null);
    const { ctx, writes } = makeCtx({ resolveRunWorktree });
    const hooks = new InteractiveHookHandlers(ctx);

    hooks.handleShellApprovalRequest(
      { type: 'shell-approval-request', requestId: 'r1', runId: 'orchestrator', toolName: 'Bash', toolInput: {} },
      client,
    );

    expect(resolveRunWorktree).not.toHaveBeenCalled();
    expect(writes).toEqual([
      { type: 'mcp-query-response', requestId: 'r1', ok: true, data: { permissionDecision: 'deny' } },
    ]);
  });

  it('the acceptEdits fast-path reads the run’s session mode through the injected db and auto-allows an Edit', () => {
    const resolveRunWorktree = vi.fn(() => null);
    const { ctx, writes, db } = makeCtx({ resolveRunWorktree });
    db.prepare(`INSERT INTO sessions (id, agent_permission_mode) VALUES ('s1', 'acceptEdits')`).run();
    db.prepare(`INSERT INTO workflow_runs (id, session_id, worktree_path) VALUES ('run-1', 's1', '/tmp/wt')`).run();
    const hooks = new InteractiveHookHandlers(ctx);

    hooks.handleShellApprovalRequest(
      { type: 'shell-approval-request', requestId: 'r2', runId: 'run-1', toolName: 'Edit', toolInput: { file_path: 'a.ts' } },
      client,
    );

    // Allowed BEFORE the allow-list rung, so the worktree is never resolved.
    expect(resolveRunWorktree).not.toHaveBeenCalled();
    expect(writes).toEqual([
      { type: 'mcp-query-response', requestId: 'r2', ok: true, data: { permissionDecision: 'allow' } },
    ]);
  });

  it('interactive-turn-end acks through the injected writer and reports turn_end_unavailable when no dep is wired', () => {
    const { ctx, writes } = makeCtx();
    const hooks = new InteractiveHookHandlers(ctx);

    hooks.handleInteractiveTurnEnd({ type: 'interactive-turn-end', requestId: 'r3', runId: 'run-1' }, client);

    expect(writes).toEqual([
      { type: 'mcp-query-response', requestId: 'r3', ok: false, error: 'turn_end_unavailable' },
    ]);
  });

  it('interactive-turn-end and interactive-question-open route to the injected deps', () => {
    const onInteractiveTurnEnd = vi.fn(() => true);
    const onInteractiveQuestionOpen = vi.fn();
    const { ctx, writes } = makeCtx({ deps: { onInteractiveTurnEnd, onInteractiveQuestionOpen } });
    const hooks = new InteractiveHookHandlers(ctx);

    hooks.handleInteractiveTurnEnd({ type: 'interactive-turn-end', requestId: 'r4', runId: 'run-1' }, client);
    hooks.handleInteractiveQuestionOpen({ type: 'interactive-question-open', requestId: 'r5', runId: 'run-1' }, client);

    expect(onInteractiveTurnEnd).toHaveBeenCalledWith('run-1');
    expect(onInteractiveQuestionOpen).toHaveBeenCalledWith('run-1');
    expect(writes).toEqual([
      { type: 'mcp-query-response', requestId: 'r4', ok: true },
      { type: 'mcp-query-response', requestId: 'r5', ok: true },
    ]);
  });

  it('cancelInFlightShellApprovals is idempotent with nothing in flight', () => {
    const { ctx, writes } = makeCtx();
    const hooks = new InteractiveHookHandlers(ctx);

    expect(hooks.cancelInFlightShellApprovals('run-none')).toBe(0);
    expect(writes).toEqual([]);
  });
});
