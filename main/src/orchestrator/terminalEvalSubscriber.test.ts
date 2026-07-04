/**
 * handleTerminalStatusEvent — the workflow-agnostic auto-eval / pairwise trigger
 * (slice C), against an in-memory DB + spy closures. Pins: untagged runs are a
 * no-op; auto-eval fires ONLY on healthy statuses + only when no run_evals row
 * exists (never the refire path); experiment-tagged runs reconcile + pairwise on
 * ALL four settled statuses; non-settled statuses are ignored.
 */
import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { dbAdapter } from './__test_fixtures__/dbAdapter';
import { handleTerminalStatusEvent, type TerminalEvalSubscriberDeps } from './terminalEvalSubscriber';
import type { RunStatusChangedEvent } from '../../../shared/types/cyboflow';

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(
    'CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, experiment_id TEXT, variant_id TEXT);',
  );
  return db;
}

function seedRun(raw: Database.Database, id: string, experimentId: string | null, variantId: string | null): void {
  raw
    .prepare('INSERT INTO workflow_runs (id, experiment_id, variant_id) VALUES (?, ?, ?)')
    .run(id, experimentId, variantId);
}

function makeDeps(
  raw: Database.Database,
  over: Partial<TerminalEvalSubscriberDeps> = {},
): {
  deps: TerminalEvalSubscriberDeps;
  evalSnapshot: ReturnType<typeof vi.fn>;
  reconcile: ReturnType<typeof vi.fn>;
  pairwiseMaybe: ReturnType<typeof vi.fn>;
} {
  const evalSnapshot = vi.fn();
  const reconcile = vi.fn();
  const pairwiseMaybe = vi.fn();
  const deps: TerminalEvalSubscriberDeps = {
    db: dbAdapter(raw),
    hasRunEvalRow: () => false,
    evalSnapshot,
    reconcile,
    pairwiseMaybe,
    ...over,
  };
  return { deps, evalSnapshot, reconcile, pairwiseMaybe };
}

const ev = (runId: string, status: RunStatusChangedEvent['status']): RunStatusChangedEvent => ({
  runId,
  status,
});

describe('handleTerminalStatusEvent', () => {
  it('untagged run => complete no-op (no eval, no reconcile, no pairwise)', () => {
    const raw = buildDb();
    seedRun(raw, 'r1', null, null);
    const { deps, evalSnapshot, reconcile, pairwiseMaybe } = makeDeps(raw);
    handleTerminalStatusEvent(ev('r1', 'awaiting_review'), deps);
    expect(evalSnapshot).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
    expect(pairwiseMaybe).not.toHaveBeenCalled();
  });

  it('non-settled status (running) => ignored even for a tagged run', () => {
    const raw = buildDb();
    seedRun(raw, 'r1', 'exp-1', null);
    const { deps, evalSnapshot, pairwiseMaybe } = makeDeps(raw);
    handleTerminalStatusEvent(ev('r1', 'running'), deps);
    expect(evalSnapshot).not.toHaveBeenCalled();
    expect(pairwiseMaybe).not.toHaveBeenCalled();
  });

  it('variant-tagged healthy status + no run_evals row => auto-eval fires; no experiment work', () => {
    const raw = buildDb();
    seedRun(raw, 'r1', null, 'var-1');
    const { deps, evalSnapshot, reconcile, pairwiseMaybe } = makeDeps(raw);
    handleTerminalStatusEvent(ev('r1', 'completed'), deps);
    expect(evalSnapshot).toHaveBeenCalledWith('r1');
    expect(reconcile).not.toHaveBeenCalled(); // no experiment_id
    expect(pairwiseMaybe).not.toHaveBeenCalled();
  });

  it('tagged run with an EXISTING run_evals row => auto-eval NEVER fires (no refire path)', () => {
    const raw = buildDb();
    seedRun(raw, 'r1', null, 'var-1');
    const { deps, evalSnapshot } = makeDeps(raw, { hasRunEvalRow: () => true });
    handleTerminalStatusEvent(ev('r1', 'awaiting_review'), deps);
    expect(evalSnapshot).not.toHaveBeenCalled();
  });

  it('failed status => NO auto-eval (not healthy) but experiment reconcile + pairwise still fire', () => {
    const raw = buildDb();
    seedRun(raw, 'r1', 'exp-1', 'var-1');
    const { deps, evalSnapshot, reconcile, pairwiseMaybe } = makeDeps(raw);
    handleTerminalStatusEvent(ev('r1', 'failed'), deps);
    expect(evalSnapshot).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledWith('exp-1');
    expect(pairwiseMaybe).toHaveBeenCalledWith('exp-1');
  });

  it('canceled status => reconcile + pairwise fire (settled), no auto-eval', () => {
    const raw = buildDb();
    seedRun(raw, 'r1', 'exp-1', null);
    const { deps, evalSnapshot, reconcile, pairwiseMaybe } = makeDeps(raw);
    handleTerminalStatusEvent(ev('r1', 'canceled'), deps);
    expect(evalSnapshot).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledWith('exp-1');
    expect(pairwiseMaybe).toHaveBeenCalledWith('exp-1');
  });

  it('stepTransitionOwnsEval=true => auto-eval SUPPRESSED (path A owns it) but experiment work still fires', () => {
    const raw = buildDb();
    seedRun(raw, 'r1', 'exp-1', 'var-1');
    const { deps, evalSnapshot, reconcile, pairwiseMaybe } = makeDeps(raw, {
      stepTransitionOwnsEval: () => true,
    });
    handleTerminalStatusEvent(ev('r1', 'awaiting_review'), deps);
    expect(evalSnapshot).not.toHaveBeenCalled(); // path A (human-review step) owns the snapshot
    expect(reconcile).toHaveBeenCalledWith('exp-1');
    expect(pairwiseMaybe).toHaveBeenCalledWith('exp-1');
  });

  it('stepTransitionOwnsEval=false (path A never covers this run) => auto-eval still fires', () => {
    const raw = buildDb();
    seedRun(raw, 'r1', null, 'var-1');
    const { deps, evalSnapshot } = makeDeps(raw, { stepTransitionOwnsEval: () => false });
    handleTerminalStatusEvent(ev('r1', 'completed'), deps);
    expect(evalSnapshot).toHaveBeenCalledWith('r1');
  });

  it('stepTransitionOwnsEval throws => treated as NOT owned, auto-eval fires (fail-soft)', () => {
    const raw = buildDb();
    seedRun(raw, 'r1', null, 'var-1');
    const { deps, evalSnapshot } = makeDeps(raw, {
      stepTransitionOwnsEval: () => {
        throw new Error('resolve blew up');
      },
    });
    handleTerminalStatusEvent(ev('r1', 'awaiting_review'), deps);
    expect(evalSnapshot).toHaveBeenCalledWith('r1');
  });

  it('experiment-tagged healthy status => auto-eval AND reconcile AND pairwise all fire', () => {
    const raw = buildDb();
    seedRun(raw, 'r1', 'exp-1', 'var-1');
    const { deps, evalSnapshot, reconcile, pairwiseMaybe } = makeDeps(raw);
    handleTerminalStatusEvent(ev('r1', 'awaiting_review'), deps);
    expect(evalSnapshot).toHaveBeenCalledWith('r1');
    expect(reconcile).toHaveBeenCalledWith('exp-1');
    expect(pairwiseMaybe).toHaveBeenCalledWith('exp-1');
  });
});
