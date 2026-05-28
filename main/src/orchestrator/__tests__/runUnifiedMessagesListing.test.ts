/**
 * Unit tests for selectRunUnifiedMessages (chat-unification Phase 1, backend).
 *
 * These tests use a PURE-JS mock DatabaseLike (no real better-sqlite3) so they
 * run under the host Node ABI without a NODE_MODULE_VERSION rebuild. The mock's
 * `.all()` returns canned raw_events rows in the order the real SQL ORDER BY
 * would emit them (created_at ASC, id ASC) — selectRunUnifiedMessages does not
 * re-sort, so the fixture provides rows pre-ordered.
 *
 * Core behaviour under test: a tool_use block on an assistant event and the
 * matching tool_result block on a later user event must fold into a SINGLE
 * correlated UnifiedMessage (the assistant message), with the tool_call's
 * status/result populated from the tool_result — exactly the projection
 * fidelity the quick-session path provides.
 */
import { describe, it, expect } from 'vitest';
import { selectRunUnifiedMessages } from '../runUnifiedMessagesListing';
import type { DatabaseLike, PreparedStatement } from '../types';
import { makeSpyLogger } from '../__test_fixtures__/loggerLikeSpy';

// ---------------------------------------------------------------------------
// Pure-JS mock DatabaseLike
// ---------------------------------------------------------------------------

interface MockRawRow {
  id: number;
  payloadJson: string;
  runId: string;
  createdAt: string;
}

/**
 * Build a DatabaseLike whose prepare().all(runId) returns the supplied rows
 * filtered to the requested runId. Rows must be supplied pre-ordered
 * (created_at ASC, id ASC) since the production SQL does the ordering.
 */
function makeMockDb(rows: MockRawRow[]): DatabaseLike {
  const stmt: PreparedStatement = {
    run: () => ({ changes: 0, lastInsertRowid: 0 }),
    get: () => undefined,
    all: (...params: unknown[]) => {
      const runId = params[0] as string;
      return rows.filter((r) => r.runId === runId);
    },
  };
  return {
    prepare: () => stmt,
    transaction: <T>(fn: (...args: unknown[]) => T) => fn,
  };
}

// ---------------------------------------------------------------------------
// Payload builders (wire format matching claudeStream.ts)
// ---------------------------------------------------------------------------

function assistantToolUsePayload(messageId: string, toolUseId: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      id: messageId,
      model: 'claude-opus-4',
      role: 'assistant',
      content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: 'ls' } }],
    },
  });
}

function userToolResultPayload(toolUseId: string, output: string): string {
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: toolUseId, content: output, is_error: false },
      ],
    },
  });
}

function assistantTextPayload(messageId: string, text: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      id: messageId,
      model: 'claude-opus-4',
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('selectRunUnifiedMessages', () => {
  it('returns [] when there are no raw_events for the run', () => {
    const db = makeMockDb([]);
    expect(selectRunUnifiedMessages(db, 'run-empty')).toEqual([]);
  });

  it('folds a tool_use + matching tool_result into a single correlated message', () => {
    const runId = 'run-corr';
    const toolUseId = 'toolu_abc';

    // Ordered: assistant tool_use first, then the user tool_result.
    const rows: MockRawRow[] = [
      {
        id: 1,
        runId,
        payloadJson: assistantToolUsePayload('asst-msg-1', toolUseId),
        createdAt: '2026-01-01T00:00:01Z',
      },
      {
        id: 2,
        runId,
        payloadJson: userToolResultPayload(toolUseId, 'file-a\nfile-b\n'),
        createdAt: '2026-01-01T00:00:02Z',
      },
    ];

    const db = makeMockDb(rows);
    const result = selectRunUnifiedMessages(db, runId);

    // The tool_result user event projects to null and is absorbed — so we get
    // exactly ONE message (the assistant tool_call), not two.
    expect(result).toHaveLength(1);

    const msg = result[0];
    expect(msg.role).toBe('assistant');
    expect(msg.id).toBe('asst-msg-1');
    // Persisted timestamp is used, not MessageProjection's new Date().
    expect(msg.timestamp).toBe(new Date('2026-01-01T00:00:01Z').toISOString());

    // The single segment is the tool_call, and it carries the correlated result.
    expect(msg.segments).toHaveLength(1);
    const seg = msg.segments[0];
    expect(seg.type).toBe('tool_call');
    if (seg.type !== 'tool_call') throw new Error('expected tool_call segment');
    expect(seg.tool.id).toBe(toolUseId);
    expect(seg.tool.name).toBe('Bash');
    expect(seg.tool.status).toBe('success');
    expect(seg.tool.result).toEqual({ content: 'file-a\nfile-b\n', isError: false });
  });

  it('emits a plain assistant text message and preserves run-time ordering', () => {
    const runId = 'run-text';
    const rows: MockRawRow[] = [
      {
        id: 1,
        runId,
        payloadJson: assistantTextPayload('asst-text-1', 'All done.'),
        createdAt: '2026-01-01T00:00:05Z',
      },
    ];

    const result = selectRunUnifiedMessages(makeMockDb(rows), runId);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('assistant');
    expect(result[0].segments[0]).toEqual({ type: 'text', content: 'All done.' });
    expect(result[0].timestamp).toBe(new Date('2026-01-01T00:00:05Z').toISOString());
  });

  it('only projects events for the requested runId (isolation)', () => {
    const rows: MockRawRow[] = [
      {
        id: 1,
        runId: 'run-x',
        payloadJson: assistantTextPayload('msg-x', 'Message for run X'),
        createdAt: '2026-01-01T00:00:01Z',
      },
      {
        id: 2,
        runId: 'run-y',
        payloadJson: assistantTextPayload('msg-y', 'Message for run Y'),
        createdAt: '2026-01-01T00:00:02Z',
      },
    ];
    const db = makeMockDb(rows);

    const x = selectRunUnifiedMessages(db, 'run-x');
    expect(x).toHaveLength(1);
    expect(x[0].id).toBe('msg-x');

    const y = selectRunUnifiedMessages(db, 'run-y');
    expect(y).toHaveLength(1);
    expect(y[0].id).toBe('msg-y');
  });

  it('threads the logger into the projection pipeline (verbose on unknown variant)', () => {
    const runId = 'run-log';
    // An unrecognized event variant makes TypedEventNarrowing emit a verbose log
    // (adapted to logger.debug). This proves the logger is actually threaded
    // rather than silently omitted.
    const rows: MockRawRow[] = [
      {
        id: 1,
        runId,
        payloadJson: JSON.stringify({ type: 'totally_unknown_variant', foo: 'bar' }),
        createdAt: '2026-01-01T00:00:01Z',
      },
    ];

    const logger = makeSpyLogger();
    const result = selectRunUnifiedMessages(makeMockDb(rows), runId, logger);

    // Unknown variant projects to null → no messages.
    expect(result).toEqual([]);
    // verbose was adapted to debug — confirm the diagnostic was NOT swallowed.
    expect(logger.debug).toHaveBeenCalled();
    expect(logger.calls.some((c) => c.level === 'debug')).toBe(true);
  });
});
