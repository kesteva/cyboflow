/**
 * proposalExecutorReviewDeps — the triage-findings closures forward each
 * change to ReviewItemRouter.applyReviewItem verbatim and read live state
 * scoped to the project.
 */
import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { buildProposalExecutorReviewDeps } from './proposalExecutorReviewDeps';

describe('buildProposalExecutorReviewDeps', () => {
  it('applyReviewItemChange forwards the change to the chokepoint unchanged', async () => {
    const applyReviewItem = vi.fn(async () => ({ reviewItemId: 'r1', event: { id: 1, seq: 1 } }));
    const db = new Database(':memory:');
    const deps = buildProposalExecutorReviewDeps({ reviewItemRouter: { applyReviewItem }, db: dbAdapter(db) });
    await deps.applyReviewItemChange(3, { op: 'dismiss', actor: 'user', reviewItemId: 'r1', resolution: 'noise' });
    expect(applyReviewItem).toHaveBeenCalledWith(3, { op: 'dismiss', actor: 'user', reviewItemId: 'r1', resolution: 'noise' });
    db.close();
  });

  it('readReviewItemState reads status/staged/selected scoped to the project', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE review_items (id TEXT PRIMARY KEY, project_id INTEGER, status TEXT, staged_at TEXT, selected INTEGER DEFAULT 0)`);
    db.prepare(`INSERT INTO review_items VALUES ('r1', 3, 'pending', NULL, 0), ('r2', 3, 'resolved', '2026-09-01', 1)`).run();
    const deps = buildProposalExecutorReviewDeps({ reviewItemRouter: { applyReviewItem: vi.fn() }, db: dbAdapter(db) });
    expect(deps.readReviewItemState(3, 'r1')).toEqual({ status: 'pending', stagedAt: null, selected: false });
    expect(deps.readReviewItemState(3, 'r2')).toEqual({ status: 'resolved', stagedAt: '2026-09-01', selected: true });
    expect(deps.readReviewItemState(4, 'r1')).toBeNull();
    expect(deps.readReviewItemState(3, 'nope')).toBeNull();
    db.close();
  });
});
