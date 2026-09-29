/**
 * systemicPauseGateWiring — the production composition of the systemic-pause
 * gate (extracted from index.ts) and the two adapters the "Switch runtime &
 * retry" handler reuses. Driven against the real singletons over a
 * migration-backed review-inbox DB.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';
import {
  buildReviewInboxDb,
  seedBlockingReviewItem,
  seedInboxRun,
} from '../__test_fixtures__/reviewInboxTestDb';
import { HumanStepManager } from '../humanStepManager';
import { ReviewItemRouter } from '../reviewItemRouter';
import {
  buildSystemicPauseGate,
  findPendingSystemicPause,
  resolveSystemicPauseItem,
} from '../systemicPauseGateWiring';

let db: Database.Database;

beforeEach(() => {
  db = buildReviewInboxDb();
  HumanStepManager.initialize(db);
  ReviewItemRouter.initialize(db);
  seedInboxRun(db, 'run-1');
});

afterEach(() => {
  HumanStepManager._resetForTesting();
  ReviewItemRouter._resetForTesting();
  db.close();
});

const PAYLOAD = JSON.stringify({
  kind: 'decision',
  gate: 'systemic-pause',
  stepId: 'implement',
  agentKeys: ['implement'],
  blockedProvider: 'claude',
});

describe('findPendingSystemicPause', () => {
  it('returns the pending pause item with its parsed payload', async () => {
    seedBlockingReviewItem(db, {
      id: 'rvw_p',
      runId: 'run-1',
      kind: 'decision',
      source: 'gate:systemic-pause:implement',
      payloadJson: PAYLOAD,
    });
    await expect(findPendingSystemicPause('run-1')).resolves.toEqual({
      reviewItemId: 'rvw_p',
      projectId: 1,
      payload: JSON.parse(PAYLOAD),
    });
  });

  it('a NULL / malformed / non-decision payload reads as null (pre-feature item)', async () => {
    seedBlockingReviewItem(db, {
      id: 'rvw_p',
      runId: 'run-1',
      kind: 'decision',
      source: 'gate:systemic-pause:implement',
      payloadJson: '{"kind":"finding"}',
    });
    const hit = await findPendingSystemicPause('run-1');
    expect(hit?.payload).toBeNull();
  });

  it('null when no pause is pending', async () => {
    await expect(findPendingSystemicPause('run-1')).resolves.toBeNull();
  });
});

describe('resolveSystemicPauseItem', () => {
  it("resolves a pending item, then reports a second resolve as 'already_settled' (never throws)", async () => {
    seedBlockingReviewItem(db, {
      id: 'rvw_p',
      runId: 'run-1',
      kind: 'decision',
      source: 'gate:systemic-pause:implement',
    });
    await expect(
      resolveSystemicPauseItem({ projectId: 1, reviewItemId: 'rvw_p', resolution: 'retry: switched' }),
    ).resolves.toBe('resolved');
    const row = db.prepare('SELECT status, resolution FROM review_items WHERE id = ?').get('rvw_p') as {
      status: string;
      resolution: string;
    };
    expect(row).toEqual({ status: 'resolved', resolution: 'retry: switched' });
    await expect(
      resolveSystemicPauseItem({ projectId: 1, reviewItemId: 'rvw_p', resolution: 'retry: again' }),
    ).resolves.toBe('already_settled');
  });

  it('rethrows anything other than invalid_status', async () => {
    await expect(
      resolveSystemicPauseItem({ projectId: 1, reviewItemId: 'rvw_missing', resolution: 'x' }),
    ).rejects.toThrow();
  });
});

describe('buildSystemicPauseGate', () => {
  it('mints the pause item through the router with the gate-composed payload', async () => {
    const events = new EventEmitter();
    const gate = buildSystemicPauseGate({ events, channelFor: (p) => `ch-${p}` });
    const ac = new AbortController();
    const verdict = gate.awaitClear({
      runId: 'run-1',
      projectId: 1,
      step: { id: 'implement', name: 'Implement', agent: 'implement', mcps: [], retries: 0 },
      error: 'usage limit reached',
      info: { blockedAgentKeys: ['implement'], blockedProvider: 'claude', origin: 'step', fanOut: false },
      signal: ac.signal,
    });
    for (let i = 0; i < 20; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
      if (await findPendingSystemicPause('run-1')) break;
    }
    const hit = await findPendingSystemicPause('run-1');
    expect(hit?.payload).toMatchObject({
      kind: 'decision',
      gate: 'systemic-pause',
      stepId: 'implement',
      agentKeys: ['implement'],
      blockedProvider: 'claude',
      origin: 'step',
      fanOut: false,
    });
    const row = db.prepare('SELECT source, blocking FROM review_items WHERE id = ?').get(hit?.reviewItemId) as {
      source: string;
      blocking: number;
    };
    expect(row).toEqual({ source: 'gate:systemic-pause:implement', blocking: 1 });
    ac.abort();
    await expect(verdict).resolves.toBe('canceled');
  });
});
