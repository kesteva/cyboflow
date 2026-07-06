/**
 * Unit tests for selectRunContextUsage (Chat meta-strip ticker backfill).
 *
 * Pure-JS mock DatabaseLike (no real better-sqlite3) so these run under the
 * host Node ABI. The mock's `prepare()` inspects the SQL for the event_type
 * literal and `.all()` returns canned rows newest-first (the real SQL orders
 * by id DESC) — the helper takes the FIRST qualifying row per side.
 */
import { describe, it, expect } from 'vitest';
import { selectRunContextUsage } from '../runContextUsageListing';
import type { DatabaseLike, PreparedStatement } from '../types';

interface MockRow {
  payloadJson: string;
}

/** Mock db: prepare() routes on the event_type literal baked into the SQL. */
function makeMockDb(assistantRowsNewestFirst: MockRow[], resultRowsNewestFirst: MockRow[]): DatabaseLike {
  const stmtFor = (rows: MockRow[]): PreparedStatement => ({
    run: () => ({ changes: 0, lastInsertRowid: 0 }),
    get: () => undefined,
    all: () => rows,
  });
  return {
    prepare: (sql: string) =>
      sql.includes("'assistant'") ? stmtFor(assistantRowsNewestFirst) : stmtFor(resultRowsNewestFirst),
    transaction: <T>(fn: (...args: unknown[]) => T) => fn,
  };
}

const assistantRow = (usage: Record<string, unknown> | undefined): MockRow => ({
  payloadJson: JSON.stringify({
    type: 'assistant',
    message: { id: 'm1', role: 'assistant', content: [], ...(usage ? { usage } : {}) },
  }),
});

const resultRow = (modelUsage: Record<string, unknown> | undefined): MockRow => ({
  payloadJson: JSON.stringify({
    type: 'result',
    ...(modelUsage ? { modelUsage } : {}),
  }),
});

describe('selectRunContextUsage', () => {
  it('returns both nulls when the run has no raw_events', () => {
    expect(selectRunContextUsage(makeMockDb([], []), 'r')).toEqual({
      usedTokens: null,
      contextWindow: null,
    });
  });

  it('recovers usedTokens from the newest assistant usage (disjoint-partition sum)', () => {
    const db = makeMockDb(
      [
        assistantRow({ input_tokens: 131, cache_read_input_tokens: 61546, cache_creation_input_tokens: 4314 }),
        assistantRow({ input_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 }),
      ],
      [],
    );
    expect(selectRunContextUsage(db, 'r')).toEqual({
      usedTokens: 131 + 61546 + 4314,
      contextWindow: null,
    });
  });

  it('skips newer assistant rows without usable usage and falls back to an older one', () => {
    const db = makeMockDb(
      [
        assistantRow(undefined),
        assistantRow({ input_tokens: 0, cache_read_input_tokens: 0 }),
        assistantRow({ input_tokens: 5, cache_read_input_tokens: 500 }),
      ],
      [],
    );
    expect(selectRunContextUsage(db, 'r').usedTokens).toBe(505);
  });

  it('recovers contextWindow from the newest result modelUsage, ignoring cumulative token counts', () => {
    const db = makeMockDb(
      [],
      [
        resultRow({
          'claude-fable-5': {
            inputTokens: 7112,
            cacheReadInputTokens: 496607,
            contextWindow: 1000000,
          },
        }),
      ],
    );
    expect(selectRunContextUsage(db, 'r')).toEqual({
      usedTokens: null,
      contextWindow: 1000000,
    });
  });

  it('skips malformed payloads and results without a positive contextWindow', () => {
    const db = makeMockDb(
      [{ payloadJson: 'not-json' }],
      [
        { payloadJson: 'also-not-json' },
        resultRow({ 'some-model': { contextWindow: 0 } }),
        resultRow({ 'some-model': { contextWindow: 200000 } }),
      ],
    );
    expect(selectRunContextUsage(db, 'r')).toEqual({
      usedTokens: null,
      contextWindow: 200000,
    });
  });

  it('returns both facts when both event kinds are present', () => {
    const db = makeMockDb(
      [assistantRow({ input_tokens: 1000, cache_read_input_tokens: 61000 })],
      [resultRow({ m: { contextWindow: 200000 } })],
    );
    expect(selectRunContextUsage(db, 'r')).toEqual({
      usedTokens: 62000,
      contextWindow: 200000,
    });
  });
});
