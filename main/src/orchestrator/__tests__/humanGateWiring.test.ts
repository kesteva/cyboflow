/**
 * Composition-root wiring for the programmatic human-gate resolver.
 *
 * `buildReviewQueueHumanGate` is pure wiring extracted out of `index.ts` (which
 * sits at its size-ratchet cap and has no unit test at all), so this file is the
 * only thing that proves the opener it hands the resolver is actually complete:
 * the `readGateItem` read-back that closes the lost-event window is present, and
 * the `onGateResolved` seam still maps a DISMISSED gate to a 'reject' decision
 * rather than letting a null resolution note sniff its way to 'approve'.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { buildReviewQueueHumanGate } from '../humanGateWiring';
import { HumanStepManager } from '../humanStepManager';
import { GateSideEffects } from '../gateSideEffects';
import type { GateSideEffectArgs } from '../gateSideEffects';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import {
  buildReviewInboxDb,
  seedInboxRun,
  seedBlockingReviewItem,
} from '../__test_fixtures__/reviewInboxTestDb';
import type { WorkflowStep } from '../../../../shared/types/workflows';

const channelFor = (projectId: number): string => `review-project-${projectId}`;

function step(id: string, name = id): WorkflowStep {
  return { id, name, agent: 'human', mcps: [], retries: 0, human: true };
}

afterEach(() => {
  HumanStepManager._resetForTesting();
  GateSideEffects._resetForTesting();
  vi.restoreAllMocks();
});

/**
 * Stand the two singletons the wiring looks up at call time, on one in-memory
 * inbox DB holding a run parked at an already-open gate (the resume path, which
 * needs no `running` run to mint a fresh item).
 */
function boot(): {
  db: ReturnType<typeof buildReviewInboxDb>;
  applied: GateSideEffectArgs[];
} {
  const db = buildReviewInboxDb();
  HumanStepManager.initialize(dbAdapter(db));
  GateSideEffects.initialize({
    db: dbAdapter(db),
    snapshotBaseDir: '/tmp/cyboflow-test-snapshots',
    loadPrototypeHtml: async () => null,
  });
  const applied: GateSideEffectArgs[] = [];
  vi.spyOn(GateSideEffects.prototype, 'apply').mockImplementation(async (args: GateSideEffectArgs) => {
    applied.push(args);
  });

  seedInboxRun(db, 'run-w', 'awaiting_review');
  seedBlockingReviewItem(db, {
    id: 'rvw_gate',
    runId: 'run-w',
    kind: 'decision',
    source: 'gate:human-step:approve-design',
  });
  db.prepare('UPDATE review_items SET body = ? WHERE id = ?').run('The gate body.', 'rvw_gate');
  return { db, applied };
}

describe('buildReviewQueueHumanGate', () => {
  it('wires readGateItem, so the gate-open hook sees the item title + body', async () => {
    const { db } = boot();
    const events = new EventEmitter();
    const gate = buildReviewQueueHumanGate({ events, channelFor });

    const seen: Array<{ reviewItemId: string; title: string; body: string; resumed: boolean }> = [];
    const pending = gate.resolve({
      runId: 'run-w',
      projectId: 1,
      step: step('approve-design', 'Approve design'),
      onOpened: (snapshot) => {
        seen.push(snapshot);
      },
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(seen).toEqual([
      { reviewItemId: 'rvw_gate', title: 'item rvw_gate', body: 'The gate body.', resumed: true },
    ]);

    events.emit('review-project-1', {
      reviewItemId: 'rvw_gate',
      action: 'resolved',
      item: { resolution: 'approve' },
    });
    await expect(pending).resolves.toBe('approve');
    db.close();
  });

  it('settles straight off the read-back when the human answered before the target was armed', async () => {
    const { db } = boot();
    // THE RACE, staged exactly as production hits it: findPendingGate saw the
    // item while it was still pending, the human resolved it during that awaited
    // round-trip, and the only 'resolved' event fired before targetId existed.
    vi.spyOn(HumanStepManager.prototype, 'openHumanGate').mockResolvedValue(null);
    vi.spyOn(HumanStepManager.prototype, 'findPendingGate').mockResolvedValue('rvw_gate');
    db.prepare(`UPDATE review_items SET status = 'resolved', resolution = ? WHERE id = ?`).run(
      'revise: only AR-2 matters',
      'rvw_gate',
    );
    const events = new EventEmitter();
    const gate = buildReviewQueueHumanGate({ events, channelFor });

    // No event is ever emitted; without readGateItem this would hang forever.
    await expect(
      gate.resolve({ runId: 'run-w', projectId: 1, step: step('approve-design') }),
    ).resolves.toBe('revise');
    db.close();
  });

  it("still maps a DISMISSED gate to a 'reject' side-effect decision", async () => {
    const { db, applied } = boot();
    const events = new EventEmitter();
    const gate = buildReviewQueueHumanGate({ events, channelFor });

    const pending = gate.resolve({ runId: 'run-w', projectId: 1, step: step('approve-design') });
    await new Promise((r) => setTimeout(r, 0));
    events.emit('review-project-1', { reviewItemId: 'rvw_gate', action: 'dismissed', item: {} });

    await expect(pending).resolves.toBe('reject');
    expect(applied).toEqual([
      { runId: 'run-w', stepId: 'approve-design', decision: 'reject', resolution: null },
    ]);
    db.close();
  });
});
