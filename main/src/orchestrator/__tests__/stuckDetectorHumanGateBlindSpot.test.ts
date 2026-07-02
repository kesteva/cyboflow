/**
 * B2 — StuckDetector human-gate blind-spot pin (documented intentional gap).
 *
 * StuckDetector.scan() reads the `approvals` table ONLY: it classifies stale
 * PENDING APPROVALS and transitions their run to 'stuck'. A run parked at a
 * programmatic HUMAN-GATE decision (a blocking `review_items` row, NO approvals
 * row) is therefore INVISIBLE to the detector — it can sit awaiting_review past
 * the stale threshold and never transition to 'stuck', never emit 'runs:stuck'.
 *
 * This is the current, intentional behavior (human gates pause the run on
 * purpose; the user resolves them via the review queue). These tests PIN that
 * blind spot as a regression guard: if a future change wires the detector to
 * scan review_items, this pin must be revisited.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { StuckDetector, type ClaudeManagerLike } from '../stuckDetector';
import type { StuckDetectedEvent } from '../../../../shared/types/stuckDetection';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { makeSpyLogger } from '../__test_fixtures__/loggerLikeSpy';
import { buildReviewInboxDb, seedInboxRun, seedBlockingReviewItem, runStatus } from '../__test_fixtures__/reviewInboxTestDb';

afterEach(() => {
  vi.restoreAllMocks();
});

const TEN_MIN_AGO = new Date(Date.now() - 10 * 60 * 1000).toISOString();

function makeClaudeManager(active: Set<string> = new Set()): ClaudeManagerLike {
  return { hasActiveRunForId: (runId) => active.has(runId) };
}

describe('StuckDetector — human-gate blind spot', () => {
  it('does NOT transition a run parked at a stale human-gate decision item (no approvals row)', async () => {
    const db = buildReviewInboxDb();
    seedInboxRun(db, 'run-h', 'awaiting_review');
    // Only a blocking human-gate decision review_item, created 10 min ago (past
    // the 5-min stale threshold). NO approvals row exists for this run.
    seedBlockingReviewItem(db, {
      id: 'rvw_gate',
      runId: 'run-h',
      kind: 'decision',
      source: 'gate:human-step:plan-review',
      createdAt: TEN_MIN_AGO,
    });

    const emitter = new EventEmitter();
    const events: StuckDetectedEvent[] = [];
    emitter.on('runs:stuck', (e: StuckDetectedEvent) => events.push(e));

    const detector = new StuckDetector({
      db: dbAdapter(db),
      // No active claude run — an APPROVAL here would classify orphan_pty; the
      // point is there is no approval to classify at all.
      claudeManager: makeClaudeManager(),
      emitter,
      logger: makeSpyLogger(),
    });

    await detector.scan();

    // Current behavior: the run is untouched — still awaiting_review, no stuck
    // reason, and no 'runs:stuck' event fired.
    expect(runStatus(db, 'run-h')).toBe('awaiting_review');
    const row = db
      .prepare('SELECT status, stuck_reason FROM workflow_runs WHERE id = ?')
      .get('run-h') as { status: string; stuck_reason: string | null };
    expect(row.stuck_reason).toBeNull();
    expect(events).toHaveLength(0);
  });

  it('CONTRAST: the same run DOES transition once it has a stale pending approval', async () => {
    // Proves the detector is approval-scoped, not review_item-scoped: swap the
    // gate item for a stale approvals row and the run transitions to stuck.
    const db = buildReviewInboxDb();
    seedInboxRun(db, 'run-h', 'awaiting_review');
    db.prepare(
      `INSERT INTO approvals (id, run_id, tool_name, tool_input_json, tool_use_id, status, created_at)
       VALUES ('appr-1', 'run-h', 'Bash', '{}', 'appr-1', 'pending', ?)`,
    ).run(TEN_MIN_AGO);

    const emitter = new EventEmitter();
    const events: StuckDetectedEvent[] = [];
    emitter.on('runs:stuck', (e: StuckDetectedEvent) => events.push(e));

    const detector = new StuckDetector({
      db: dbAdapter(db),
      claudeManager: makeClaudeManager(), // no active run → orphan_pty
      emitter,
      logger: makeSpyLogger(),
    });

    await detector.scan();

    expect(runStatus(db, 'run-h')).toBe('stuck');
    expect(events).toHaveLength(1);
    expect(events[0].reason.kind).toBe('orphan_pty');
  });
});
