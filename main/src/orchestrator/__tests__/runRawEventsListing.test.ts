/**
 * Unit tests for selectRunRawStreamEvents (Data Stream backfill helper).
 *
 * Pure-JS mock DatabaseLike (no real better-sqlite3) so these run under the
 * host Node ABI without a NODE_MODULE_VERSION rebuild. The mock's `.all()`
 * returns canned raw_events rows in the order the real SQL ORDER BY would emit
 * them (created_at ASC, id ASC); the helper does not re-sort.
 *
 * Core behaviour under test: unlike selectRunUnifiedMessages (which FOLDS
 * events into correlated chat messages), this helper preserves EVERY persisted
 * event 1:1 — including stream_event deltas and user/tool_result rows — and
 * classifies each into the same { type, payload, timestamp } envelope the live
 * IPC bridge publishes.
 */
import { describe, it, expect } from 'vitest';
import { selectRunRawStreamEvents } from '../runRawEventsListing';
import type { DatabaseLike, PreparedStatement } from '../types';

interface MockRawRow {
  id: number;
  payloadJson: string;
  runId: string;
  createdAt: string;
}

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

describe('selectRunRawStreamEvents', () => {
  it('returns [] when there are no raw_events for the run', () => {
    expect(selectRunRawStreamEvents(makeMockDb([]), 'run-empty')).toEqual([]);
  });

  it('preserves every event 1:1 (no folding) and classifies each into an envelope', () => {
    const runId = 'run-raw';
    const rows: MockRawRow[] = [
      {
        id: 1,
        runId,
        createdAt: '2026-01-01T00:00:01Z',
        payloadJson: JSON.stringify({
          type: 'assistant',
          message: { id: 'm1', model: 'claude-opus-4', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_x', name: 'Bash', input: { command: 'ls' } }] },
        }),
      },
      {
        id: 2,
        runId,
        createdAt: '2026-01-01T00:00:02Z',
        payloadJson: JSON.stringify({
          type: 'user',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'a\nb\n', is_error: false }] },
        }),
      },
      {
        id: 3,
        runId,
        createdAt: '2026-01-01T00:00:03Z',
        payloadJson: JSON.stringify({
          type: 'stream_event',
          event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
        }),
      },
    ];

    const result = selectRunRawStreamEvents(makeMockDb(rows), runId);

    // All three events are preserved (the user/tool_result row is NOT absorbed,
    // unlike the chat-history projection) and ordered as stored.
    expect(result).toHaveLength(3);
    expect(result.map((e) => e.type)).toEqual(['assistant', 'user', 'stream_event']);
    // Persisted timestamp is used (not a live new Date()).
    expect(result[0].timestamp).toBe(new Date('2026-01-01T00:00:01Z').toISOString());
  });

  it('classifies a retired/unknown variant into the unknown envelope arm', () => {
    const runId = 'run-unknown';
    const rows: MockRawRow[] = [
      {
        id: 1,
        runId,
        createdAt: '2026-01-01T00:00:01Z',
        payloadJson: JSON.stringify({ type: 'totally_unknown_variant', foo: 'bar' }),
      },
    ];

    const result = selectRunRawStreamEvents(makeMockDb(rows), runId);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('unknown');
  });

  it('skips unparseable payloads defensively without throwing', () => {
    const runId = 'run-bad';
    const rows: MockRawRow[] = [
      { id: 1, runId, createdAt: '2026-01-01T00:00:01Z', payloadJson: '{not valid json' },
      {
        id: 2,
        runId,
        createdAt: '2026-01-01T00:00:02Z',
        payloadJson: JSON.stringify({ type: 'assistant', message: { id: 'm', model: 'claude-opus-4', role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }),
      },
    ];

    const result = selectRunRawStreamEvents(makeMockDb(rows), runId);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('assistant');
  });

  it('only projects events for the requested runId (isolation)', () => {
    const rows: MockRawRow[] = [
      { id: 1, runId: 'run-x', createdAt: '2026-01-01T00:00:01Z', payloadJson: JSON.stringify({ type: 'assistant', message: { id: 'mx', model: 'claude-opus-4', role: 'assistant', content: [{ type: 'text', text: 'X' }] } }) },
      { id: 2, runId: 'run-y', createdAt: '2026-01-01T00:00:02Z', payloadJson: JSON.stringify({ type: 'assistant', message: { id: 'my', model: 'claude-opus-4', role: 'assistant', content: [{ type: 'text', text: 'Y' }] } }) },
    ];
    const db = makeMockDb(rows);
    expect(selectRunRawStreamEvents(db, 'run-x')).toHaveLength(1);
    expect(selectRunRawStreamEvents(db, 'run-y')).toHaveLength(1);
  });
});
