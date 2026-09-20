/**
 * Unit tests for monitorActionSinks — the composition-root sinks for the
 * supervisor's autonomous actions. A fake router captures every create op, so
 * the suite pins the SHAPE of what reaches the review queue (actor, source,
 * title, category, severity) without a DB, a router singleton, or Electron.
 *
 * The set-aside sink's shape is the load-bearing one: it must be byte-compatible
 * with the accepted-risk finding `gateSideEffects` files for the same `AR-n`
 * entry, or the gate stops deduping and one defect reaches the human twice.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  buildLaneTriageActions,
  buildMonitorFindingSink,
  buildSetAsideFindingSink,
  type MonitorActionSinkDeps,
} from '../monitorActionSinks';
import { ADVERSARIAL_FINDING_SOURCE } from '../gateSideEffects';
import type { AdversarialFinding } from '../../../../shared/types/adversarialReview';
import type { DatabaseLike } from '../types';
import type { TaskMutationDeps } from '../taskMutationHandler';

/** The change is captured as a plain record so a test can read any field off it. */
type CreateOp = { projectId: number; change: Record<string, unknown> };

function makeDeps(overrides: Partial<MonitorActionSinkDeps> = {}): {
  deps: MonitorActionSinkDeps;
  ops: CreateOp[];
} {
  const ops: CreateOp[] = [];
  const db = { prepare: vi.fn(), transaction: vi.fn() } as unknown as DatabaseLike;
  const deps: MonitorActionSinkDeps = {
    db,
    runProjectId: () => 7,
    applyReviewItem: async (projectId, change) => {
      ops.push({ projectId, change: { ...(change as object) } as Record<string, unknown> });
      return { reviewItemId: 'ri-1', event: { id: 1, seq: 1 } };
    },
    taskMutations: {} as TaskMutationDeps,
    describeTaskFailure: () => 'refused',
    ...overrides,
  };
  return { deps, ops };
}

const ENTRY: AdversarialFinding = {
  id: 'AR-3',
  title: 'Copy nit',
  severity: 'advisory',
  what: 'the button says Submit',
  why: 'the rest of the app says Save',
  fix: 'rename it',
  area: 'prototype',
};

describe('buildMonitorFindingSink', () => {
  it('files a non-blocking finding as the MONITOR, carrying the category', async () => {
    const { deps, ops } = makeDeps();

    await buildMonitorFindingSink(deps)('run-1', {
      title: 'Review loop — adversarial-review round 2: loop',
      body: 'because',
      category: 'review-loop',
    });

    expect(ops).toHaveLength(1);
    expect(ops[0].projectId).toBe(7);
    expect(ops[0].change).toEqual({
      op: 'create',
      // The supervisor accounting for its OWN judgement, not a mechanical
      // orchestrator write.
      actor: 'monitor',
      kind: 'finding',
      title: 'Review loop — adversarial-review round 2: loop',
      body: 'because',
      severity: 'info',
      blocking: false,
      source: 'monitor',
      runId: 'run-1',
      payload: { kind: 'finding', category: 'review-loop' },
    });
  });

  it('omits the payload entirely when no category is given', async () => {
    const { deps, ops } = makeDeps();
    await buildMonitorFindingSink(deps)('run-1', { title: 't', body: 'b' });
    expect(ops[0].change.payload).toBeUndefined();
  });

  it('files nothing for a run with no resolvable project', async () => {
    const { deps, ops } = makeDeps({ runProjectId: () => undefined });
    await buildMonitorFindingSink(deps)('run-gone', { title: 't', body: 'b' });
    expect(ops).toHaveLength(0);
  });
});

describe('buildSetAsideFindingSink', () => {
  it('files the entry exactly as the approve-design gate would, prefixed with the reason', async () => {
    const { deps, ops } = makeDeps();

    await buildSetAsideFindingSink(deps)('run-1', { entry: ENTRY, reason: 'not worth a design lap', round: 2 });

    const change = ops[0].change;
    // The title prefix IS the idempotence key gateSideEffects.filedAdversarialIds
    // reads back — it must be the `AR-n — title` shape, character for character.
    expect(change.title).toBe('AR-3 — Copy nit');
    expect(change.source).toBe(ADVERSARIAL_FINDING_SOURCE);
    expect(change.actor).toBe('orchestrator');
    expect(change.blocking).toBe(false);
    // advisory → info, via the shared severity mapping.
    expect(change.severity).toBe('info');
    expect(change.payload).toEqual({
      kind: 'finding',
      category: 'design-review',
      suggestedFix: 'rename it',
      proposedTarget: 'backlog',
    });
    const body = change.body as string;
    expect(body.startsWith('Set aside by the supervisor on round 2: not worth a design lap')).toBe(true);
    // …then the reviewer's own words, from the SHARED renderer.
    expect(body).toContain('the button says Submit');
    expect(body).toContain('**Why it matters:** the rest of the app says Save');
    expect(body).toContain('**Fix:** rename it');
  });

  it('maps a blocking entry’s severity up and omits suggestedFix when the entry has none', async () => {
    const { deps, ops } = makeDeps();

    await buildSetAsideFindingSink(deps)('run-1', {
      entry: { id: 'AR-1', title: 'Real defect', severity: 'blocker' },
      reason: 'a product call',
      round: 1,
    });

    const change = ops[0].change;
    expect(change.severity).toBe('error');
    expect(change.payload).toEqual({ kind: 'finding', category: 'design-review', proposedTarget: 'backlog' });
  });
});

describe('buildLaneTriageActions', () => {
  it('files the rescue audit note through the SAME chokepoint, non-blocking', async () => {
    const { deps, ops } = makeDeps();

    await buildLaneTriageActions(deps).fileFinding('run-1', { title: 'rescued TASK-014', body: 'why' });

    expect(ops[0].change).toEqual({
      op: 'create',
      actor: 'orchestrator',
      kind: 'finding',
      title: 'rescued TASK-014',
      body: 'why',
      severity: 'info',
      blocking: false,
      source: 'monitor',
      runId: 'run-1',
    });
  });

  it('reports a refused task adjust as ok:false with the injected message, never a throw', async () => {
    const { deps } = makeDeps({ describeTaskFailure: () => 'the lane is already running' });
    // adjustRunTaskForLaneTriage refuses before touching the router when the run
    // row cannot be loaded, which a bare fake DB guarantees.
    const failingDb = {
      prepare: () => ({ run: () => ({ changes: 0, lastInsertRowid: 0 }), get: () => undefined, all: () => [] }),
      transaction: (fn: (...a: unknown[]) => unknown) => fn,
    } as unknown as DatabaseLike;

    const result = await buildLaneTriageActions({
      ...deps,
      taskMutations: { ...deps.taskMutations, db: failingDb } as TaskMutationDeps,
    }).adjustTask('run-1', { taskRef: 'TASK-014', body: '## New' });

    expect(result).toEqual({ ok: false, reason: 'the lane is already running' });
  });
});
