import { describe, it, expect, vi } from 'vitest';
import { drainLegacyIdleReviewItems } from '../drainLegacyIdleReviewItems';
import type { DatabaseLike, LoggerLike, PreparedStatement } from '../types';

const silentLogger: LoggerLike = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

function fakeDb(rows: unknown[] | (() => never)): DatabaseLike {
  const stmt: PreparedStatement = {
    run: () => ({ changes: 0, lastInsertRowid: 0 }),
    get: () => undefined,
    all: () => (typeof rows === 'function' ? rows() : rows),
  };
  return { prepare: () => stmt } as unknown as DatabaseLike;
}

describe('drainLegacyIdleReviewItems', () => {
  it('resolves every pending idle item through the chokepoint', async () => {
    const applyReviewItem = vi.fn().mockResolvedValue({ reviewItemId: 'x', event: { id: 1, seq: 1 } });
    const resolved = await drainLegacyIdleReviewItems({
      db: fakeDb([
        { id: 'ri-1', project_id: 3 },
        { id: 'ri-2', project_id: 5 },
      ]),
      applyReviewItem,
      logger: silentLogger,
    });
    expect(resolved).toBe(2);
    expect(applyReviewItem).toHaveBeenCalledTimes(2);
    expect(applyReviewItem).toHaveBeenCalledWith(3, expect.objectContaining({ op: 'resolve', reviewItemId: 'ri-1' }));
    expect(applyReviewItem).toHaveBeenCalledWith(5, expect.objectContaining({ op: 'resolve', reviewItemId: 'ri-2' }));
  });

  it('returns 0 and never throws when the review_items table is absent', async () => {
    const applyReviewItem = vi.fn();
    const resolved = await drainLegacyIdleReviewItems({
      db: fakeDb(() => {
        throw new Error('no such table: review_items');
      }),
      applyReviewItem,
      logger: silentLogger,
    });
    expect(resolved).toBe(0);
    expect(applyReviewItem).not.toHaveBeenCalled();
  });

  it('a per-item resolve failure does not abort the rest', async () => {
    const applyReviewItem = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ reviewItemId: 'x', event: { id: 1, seq: 1 } });
    const resolved = await drainLegacyIdleReviewItems({
      db: fakeDb([
        { id: 'ri-1', project_id: 3 },
        { id: 'ri-2', project_id: 5 },
      ]),
      applyReviewItem,
      logger: silentLogger,
    });
    expect(resolved).toBe(1);
    expect(applyReviewItem).toHaveBeenCalledTimes(2);
  });
});
