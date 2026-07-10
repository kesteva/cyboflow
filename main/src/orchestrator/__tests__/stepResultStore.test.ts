import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StepResultStore } from '../stepResultStore';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { setSeamErrorSink } from '../telemetrySink';

function buildDb(withTable = true): Database.Database {
  const db = new Database(':memory:');
  if (withTable) {
    const sql = readFileSync(join(__dirname, '..', '..', 'database', 'migrations', '033_step_results.sql'), 'utf-8');
    db.exec(sql);
  }
  return db;
}

describe('StepResultStore', () => {
  it('records and lists per-step results in insertion order', () => {
    const store = new StepResultStore(dbAdapter(buildDb()));
    store.record({ runId: 'r', stepId: 'context', phaseId: 'plan', outcome: 'done', attempts: 1 });
    store.record({ runId: 'r', stepId: 'epics', phaseId: 'refine', outcome: 'failed', attempts: 2, error: 'boom' });

    const rows = store.listForRun('r');
    expect(rows.map((x) => x.stepId)).toEqual(['context', 'epics']);
    expect(rows[1]).toMatchObject({ outcome: 'failed', attempts: 2, error: 'boom' });
  });

  it('INSERT OR REPLACEs a re-run step by (runId, stepId) — latest settle wins', () => {
    const store = new StepResultStore(dbAdapter(buildDb()));
    store.record({ runId: 'r', stepId: 'a', outcome: 'failed', attempts: 1, error: 'first' });
    store.record({ runId: 'r', stepId: 'a', outcome: 'done', attempts: 2 });

    const rows = store.listForRun('r');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'done', attempts: 2 });
  });

  it('completedStepIds returns only done/skipped steps', () => {
    const store = new StepResultStore(dbAdapter(buildDb()));
    store.record({ runId: 'r', stepId: 'a', outcome: 'done', attempts: 1 });
    store.record({ runId: 'r', stepId: 'b', outcome: 'skipped', attempts: 1 });
    store.record({ runId: 'r', stepId: 'c', outcome: 'failed', attempts: 1 });
    store.record({ runId: 'r', stepId: 'd', outcome: 'canceled', attempts: 1 });

    expect(store.completedStepIds('r').sort()).toEqual(['a', 'b']);
  });

  it('scopes results to the run', () => {
    const store = new StepResultStore(dbAdapter(buildDb()));
    store.record({ runId: 'r1', stepId: 'a', outcome: 'done', attempts: 1 });
    store.record({ runId: 'r2', stepId: 'b', outcome: 'done', attempts: 1 });
    expect(store.listForRun('r1').map((x) => x.stepId)).toEqual(['a']);
  });

  it('is fail-soft (no throw) when the step_results table is absent', () => {
    const store = new StepResultStore(dbAdapter(buildDb(false)));
    expect(() => store.record({ runId: 'r', stepId: 'a', outcome: 'done', attempts: 1 })).not.toThrow();
    expect(store.listForRun('r')).toEqual([]);
    expect(store.completedStepIds('r')).toEqual([]);
  });
});

describe('StepResultStore seam-error telemetry (seam G)', () => {
  afterEach(() => setSeamErrorSink(undefined as never));

  function withSink(): Array<{ seam: string; message: string; tags?: Record<string, string> }> {
    const calls: Array<{ seam: string; message: string; tags?: Record<string, string> }> = [];
    setSeamErrorSink((seam, error, tags) =>
      calls.push({ seam, message: error instanceof Error ? error.message : String(error), tags }),
    );
    return calls;
  }

  it('reports a failed step with stepOutcome + classified errorClass', () => {
    const calls = withSink();
    const store = new StepResultStore(dbAdapter(buildDb()));
    store.record({ runId: 'r', stepId: 'implement', outcome: 'failed', attempts: 3, error: 'API Error: 429 Too Many Requests' });

    const reports = calls.filter((c) => c.seam === 'programmatic-step-failed');
    expect(reports).toHaveLength(1);
    expect(reports[0].tags).toEqual({ stepOutcome: 'failed', errorClass: 'http-429' });
  });

  it('reports a skipped step ONLY when it carries an error', () => {
    const calls = withSink();
    const store = new StepResultStore(dbAdapter(buildDb()));
    // Optional step that exhausted retries → skipped WITH error → reported.
    store.record({ runId: 'r', stepId: 'ui-prototype', outcome: 'skipped', attempts: 2, error: 'Stream closed' });
    // Plain skip of a not-needed step (no error) → NOT reported.
    store.record({ runId: 'r', stepId: 'architecture', outcome: 'skipped', attempts: 0 });

    const reports = calls.filter((c) => c.seam === 'programmatic-step-failed');
    expect(reports).toHaveLength(1);
    expect(reports[0].tags).toMatchObject({ stepOutcome: 'skipped', errorClass: 'stream-closed' });
  });

  it('does NOT report done or canceled (intentional) outcomes', () => {
    const calls = withSink();
    const store = new StepResultStore(dbAdapter(buildDb()));
    store.record({ runId: 'r', stepId: 'a', outcome: 'done', attempts: 1 });
    store.record({ runId: 'r', stepId: 'b', outcome: 'canceled', attempts: 1, error: 'user canceled' });

    expect(calls.filter((c) => c.seam === 'programmatic-step-failed')).toHaveLength(0);
  });

  it('keeps the raw step error and stepId OUT of the Sentry message (privacy — Codex [high])', () => {
    const calls = withSink();
    const store = new StepResultStore(dbAdapter(buildDb()));
    store.record({
      runId: 'r',
      stepId: 'my-secret-custom-step',
      outcome: 'failed',
      attempts: 1,
      error: 'Command failed: eslint /Users/me/proj/src/Secret.tsx\n<source code snippet here>',
    });
    const rep = calls.find((c) => c.seam === 'programmatic-step-failed');
    expect(rep).toBeDefined();
    expect(rep!.message).not.toContain('my-secret-custom-step');
    expect(rep!.message).not.toContain('Secret.tsx');
    expect(rep!.message).not.toContain('source code');
    expect(rep!.message).toBe('programmatic step failed (other)');
  });
});
