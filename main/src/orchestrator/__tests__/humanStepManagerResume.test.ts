/**
 * B2 — HumanStepManager.maybeResumeRun + findPendingGate seams.
 *
 * maybeResumeRun is the resume HALF of the human-gate lifecycle, driven by the
 * `reviewItems.resolve` tRPC mutation AFTER the item has already been resolved
 * through the ReviewItemRouter chokepoint (so the chokepoint owns the audit +
 * emit, and this call only owns the awaiting_review -> running transition subject
 * to aggregate-unblock). reviewItemFold.test.ts covers openHumanGate /
 * resolveHumanGate / clearPendingForRun; this file pins the maybeResumeRun and
 * findPendingGate paths those tests do not exercise.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { HumanStepManager } from '../humanStepManager';
import { runStatusEvents } from '../trpc/routers/events';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { createTestDb } from '../__test_fixtures__/orchestratorTestDb';
import {
  buildReviewInboxDb,
  seedInboxRun,
  seedBlockingReviewItem,
  runStatus,
} from '../__test_fixtures__/reviewInboxTestDb';

afterEach(() => {
  HumanStepManager._resetForTesting();
});

/** Resolve a review_item DIRECTLY (simulating the ReviewItemRouter chokepoint the
 * reviewItems.resolve mutation drives, BEFORE it calls maybeResumeRun). */
function chokepointResolve(db: ReturnType<typeof buildReviewInboxDb>, id: string): void {
  db.prepare(
    `UPDATE review_items SET status = 'resolved', resolved_by = 'user', resolution = 'approved',
       updated_at = ? WHERE id = ? AND status = 'pending'`,
  ).run(new Date().toISOString(), id);
}

/** Capture runStatusEvents 'changed' deltas for a run over the duration of `fn`. */
async function captureStatusEvents(
  runId: string,
  fn: () => Promise<void>,
): Promise<Array<{ runId: string; status: string }>> {
  const seen: Array<{ runId: string; status: string }> = [];
  const listener = (evt: { runId: string; status: string }): void => {
    if (evt.runId === runId) seen.push(evt);
  };
  runStatusEvents.on('changed', listener);
  try {
    await fn();
  } finally {
    runStatusEvents.off('changed', listener);
  }
  return seen;
}

describe('HumanStepManager.maybeResumeRun (reviewItems.resolve drive path)', () => {
  it('auto-resumes awaiting_review -> running + emits changed when the last blocking item is already resolved', async () => {
    const db = buildReviewInboxDb();
    const mgr = HumanStepManager.initialize(dbAdapter(db));
    seedInboxRun(db, 'run-r', 'awaiting_review');
    // A single blocking permission item, resolved by the chokepoint just BEFORE
    // maybeResumeRun runs (the reviewItems.resolve sequence).
    const itemId = seedBlockingReviewItem(db, { id: 'rvw_a', runId: 'run-r', kind: 'permission' });
    chokepointResolve(db, itemId);

    const events = await captureStatusEvents('run-r', async () => {
      const resumed = await mgr.maybeResumeRun('run-r');
      expect(resumed).toBe(true);
    });

    expect(runStatus(db, 'run-r')).toBe('running');
    expect(events).toEqual([{ runId: 'run-r', status: 'running' }]);
  });

  it('leaves the run awaiting_review and returns false when a second blocking item is still pending', async () => {
    const db = buildReviewInboxDb();
    const mgr = HumanStepManager.initialize(dbAdapter(db));
    seedInboxRun(db, 'run-r', 'awaiting_review');
    const first = seedBlockingReviewItem(db, { id: 'rvw_a', runId: 'run-r', kind: 'permission' });
    seedBlockingReviewItem(db, { id: 'rvw_b', runId: 'run-r', kind: 'decision' });
    // Only the first item was resolved by the chokepoint; a sibling is still pending.
    chokepointResolve(db, first);

    const events = await captureStatusEvents('run-r', async () => {
      const resumed = await mgr.maybeResumeRun('run-r');
      expect(resumed).toBe(false);
    });

    expect(runStatus(db, 'run-r')).toBe('awaiting_review');
    expect(events).toEqual([]);
  });

  it('is a no-op (returns false, no emit) when the run is not awaiting_review', async () => {
    const db = buildReviewInboxDb();
    const mgr = HumanStepManager.initialize(dbAdapter(db));
    // Run is 'running' with zero blocking items — the guarded UPDATE matches 0 rows.
    seedInboxRun(db, 'run-r', 'running');

    const events = await captureStatusEvents('run-r', async () => {
      const resumed = await mgr.maybeResumeRun('run-r');
      expect(resumed).toBe(false);
    });

    expect(runStatus(db, 'run-r')).toBe('running');
    expect(events).toEqual([]);
  });

  it('returns false without touching the run when the review_items table is absent', async () => {
    // GATE_SCHEMA DB carries no review_items table — the table-existence guard
    // short-circuits maybeResumeRun to false (legacy no-inbox path).
    const rawDb = createTestDb();
    rawDb
      .prepare(`INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', 1, 'sprint', '{}')`)
      .run();
    rawDb
      .prepare(
        `INSERT INTO workflow_runs (id, workflow_id, project_id, worktree_path, status, policy_json)
         VALUES ('run-r', 'wf-1', 1, '/tmp/t', 'awaiting_review', '{}')`,
      )
      .run();
    const mgr = HumanStepManager.initialize(dbAdapter(rawDb));

    const resumed = await mgr.maybeResumeRun('run-r');
    expect(resumed).toBe(false);
    expect(
      (rawDb.prepare('SELECT status FROM workflow_runs WHERE id = ?').get('run-r') as { status: string }).status,
    ).toBe('awaiting_review');
  });
});

describe('HumanStepManager.parkForBlockingReview + hasPendingBlockingItems', () => {
  it('parks a RUNNING run in awaiting_review when a blocking finding is pending + emits changed', async () => {
    const db = buildReviewInboxDb();
    const mgr = HumanStepManager.initialize(dbAdapter(db));
    seedInboxRun(db, 'run-p', 'running');
    seedBlockingReviewItem(db, { id: 'rvw_f', runId: 'run-p', kind: 'finding' });

    expect(mgr.hasPendingBlockingItems('run-p')).toBe(true);
    const events = await captureStatusEvents('run-p', async () => {
      const parked = await mgr.parkForBlockingReview('run-p');
      expect(parked).toBe(true);
    });
    expect(runStatus(db, 'run-p')).toBe('awaiting_review');
    expect(events).toEqual([{ runId: 'run-p', status: 'awaiting_review' }]);
  });

  it('is a no-op (false, no emit) when the run has no pending blocking items', async () => {
    const db = buildReviewInboxDb();
    const mgr = HumanStepManager.initialize(dbAdapter(db));
    seedInboxRun(db, 'run-p', 'running');

    expect(mgr.hasPendingBlockingItems('run-p')).toBe(false);
    const events = await captureStatusEvents('run-p', async () => {
      const parked = await mgr.parkForBlockingReview('run-p');
      expect(parked).toBe(false);
    });
    expect(runStatus(db, 'run-p')).toBe('running');
    expect(events).toEqual([]);
  });

  it('does NOT park a run that is not running (guarded WHERE status=running)', async () => {
    const db = buildReviewInboxDb();
    const mgr = HumanStepManager.initialize(dbAdapter(db));
    seedInboxRun(db, 'run-p', 'awaiting_review');
    seedBlockingReviewItem(db, { id: 'rvw_f', runId: 'run-p', kind: 'finding' });

    const parked = await mgr.parkForBlockingReview('run-p');
    expect(parked).toBe(false);
    expect(runStatus(db, 'run-p')).toBe('awaiting_review');
  });
});

describe('HumanStepManager.findPendingGate', () => {
  it('round-trips the pending gate id for (runId, stepId)', async () => {
    const db = buildReviewInboxDb();
    const mgr = HumanStepManager.initialize(dbAdapter(db));
    seedInboxRun(db, 'run-g', 'running');

    const opened = await mgr.openHumanGate('run-g', 'plan-review', 'Plan review');
    expect(opened).not.toBeNull();

    const found = await mgr.findPendingGate('run-g', 'plan-review');
    expect(found).toBe(opened);
  });

  it('returns null when no gate is open for that step', async () => {
    const db = buildReviewInboxDb();
    const mgr = HumanStepManager.initialize(dbAdapter(db));
    seedInboxRun(db, 'run-g', 'running');
    await mgr.openHumanGate('run-g', 'plan-review', 'Plan review');

    // Different step id — no matching pending source.
    expect(await mgr.findPendingGate('run-g', 'decompose')).toBeNull();
    // Never-opened run.
    expect(await mgr.findPendingGate('run-none', 'plan-review')).toBeNull();
  });

  it('returns null when the review_items table is absent', async () => {
    const rawDb = createTestDb();
    const mgr = HumanStepManager.initialize(dbAdapter(rawDb));
    expect(await mgr.findPendingGate('run-x', 'plan-review')).toBeNull();
  });
});

describe('HumanStepManager.findPendingItemBySource (source-generic gate lookup)', () => {
  it('round-trips a pending decision item id for an arbitrary source (e.g. systemic-pause)', async () => {
    const db = buildReviewInboxDb();
    const mgr = HumanStepManager.initialize(dbAdapter(db));
    seedInboxRun(db, 'run-s', 'awaiting_review');
    const id = seedBlockingReviewItem(db, {
      id: 'rvw_sys',
      runId: 'run-s',
      kind: 'decision',
      source: 'gate:systemic-pause:build-epics',
    });

    expect(await mgr.findPendingItemBySource('run-s', 'gate:systemic-pause:build-epics')).toBe(id);
    // A non-matching source (or run) finds nothing.
    expect(await mgr.findPendingItemBySource('run-s', 'gate:systemic-pause:other')).toBeNull();
    expect(await mgr.findPendingItemBySource('run-none', 'gate:systemic-pause:build-epics')).toBeNull();
  });

  it('findPendingGate delegates to it (unchanged human-gate behavior)', async () => {
    const db = buildReviewInboxDb();
    const mgr = HumanStepManager.initialize(dbAdapter(db));
    seedInboxRun(db, 'run-g', 'running');
    const opened = await mgr.openHumanGate('run-g', 'plan-review', 'Plan review');

    expect(await mgr.findPendingItemBySource('run-g', 'gate:human-step:plan-review')).toBe(opened);
  });
});

describe('HumanStepManager.clearPendingForRun (systemic-pause cleanup)', () => {
  it('dismisses a pending systemic-pause decision row on the cancel path', async () => {
    const db = buildReviewInboxDb();
    const mgr = HumanStepManager.initialize(dbAdapter(db));
    seedInboxRun(db, 'run-c', 'awaiting_review');
    seedBlockingReviewItem(db, {
      id: 'rvw_sys',
      runId: 'run-c',
      kind: 'decision',
      source: 'gate:systemic-pause:a',
    });

    const dismissed = await mgr.clearPendingForRun('run-c');

    expect(dismissed).toBe(1);
    const row = db.prepare('SELECT status FROM review_items WHERE id = ?').get('rvw_sys') as { status: string };
    expect(row.status).toBe('dismissed');
  });

  it('dismisses BOTH human-gate and systemic-pause decision rows in one clear', async () => {
    const db = buildReviewInboxDb();
    const mgr = HumanStepManager.initialize(dbAdapter(db));
    seedInboxRun(db, 'run-c', 'awaiting_review');
    // A human gate + a systemic pause both pending for the same run.
    seedBlockingReviewItem(db, { id: 'rvw_gate', runId: 'run-c', kind: 'decision', source: 'gate:human-step:plan-review' });
    seedBlockingReviewItem(db, { id: 'rvw_sys', runId: 'run-c', kind: 'decision', source: 'gate:systemic-pause:a' });

    expect(await mgr.clearPendingForRun('run-c')).toBe(2);
    expect((db.prepare('SELECT status FROM review_items WHERE id = ?').get('rvw_gate') as { status: string }).status).toBe('dismissed');
    expect((db.prepare('SELECT status FROM review_items WHERE id = ?').get('rvw_sys') as { status: string }).status).toBe('dismissed');
  });
});
