/**
 * The TITLE a human gate opens with — HumanStepManager.openHumanGate's
 * `gateHeader` seam.
 *
 * The flow markdown asks each gate with an AskUserQuestion header ("Approve
 * plan"), while the programmatic plane titled the same decision after the step
 * NAME ("Approve task plan"), so one decision wore two titles depending on the
 * plane. A step's `gateHeader` now titles the item when present; callers that
 * only have the name (demo scripts, the legacy hook) keep the fallback.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { HumanStepManager } from '../humanStepManager';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { buildReviewInboxDb, seedInboxRun } from '../__test_fixtures__/reviewInboxTestDb';

afterEach(() => {
  HumanStepManager._resetForTesting();
});

function gateTitle(db: Database.Database, reviewItemId: string): string {
  return (db.prepare('SELECT title FROM review_items WHERE id = ?').get(reviewItemId) as { title: string })
    .title;
}

describe('openHumanGate — review-item title', () => {
  it('titles the gate with gateHeader when the step carries one', async () => {
    const db = buildReviewInboxDb();
    const mgr = HumanStepManager.initialize(dbAdapter(db));
    seedInboxRun(db, 'run-t', 'running');

    const id = await mgr.openHumanGate('run-t', 'approve-plan', 'Approve task plan', 'Approve plan');
    expect(id).not.toBeNull();
    expect(gateTitle(db, id!)).toBe('Human gate: Approve plan');
  });

  it('falls back to the step name when no gateHeader is given', async () => {
    const db = buildReviewInboxDb();
    const mgr = HumanStepManager.initialize(dbAdapter(db));
    seedInboxRun(db, 'run-t', 'running');

    const id = await mgr.openHumanGate('run-t', 'approve-plan', 'Approve task plan');
    expect(id).not.toBeNull();
    expect(gateTitle(db, id!)).toBe('Human gate: Approve task plan');
  });
});
