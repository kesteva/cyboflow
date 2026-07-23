/**
 * Unit tests for createFinalGateHandover — the LAZY chat-at-final-gate conversion
 * of a programmatic run to a full orchestrated agent.
 *
 * Covers the applicability matrix (`attempt` returns null = "route to the monitor"
 * vs a delivery result = "consumed by an auto-handover"): the parked-at-final-gate
 * fire, the drained-rest fire (incl. a skipped optional step), and every refusal —
 * mid-run gate, systemic-pause gate, orchestrated run, non-resting status, disabled
 * kill switch, rejected final gate. Also the inject ordering (user turn + '▶' marker
 * BEFORE the handover call) and the refusal path (handover noOp → '⚠' marker +
 * { delivered: true, handedOver: false }).
 *
 * Standalone: no electron / services imports. Real in-memory SQLite via createTestDb
 * (with a minimal review_items table layered on for the gate query); the handover fn
 * and inject bridge are lightweight fakes. Style mirrors handoverRunHandler.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb, seedRun } from '../__test_fixtures__/orchestratorTestDb';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { createFinalGateHandover, type FinalGateHandoverDeps } from '../finalGateHandover';
import type { FinalGateHandoverContext, HandoverRunResult } from '../handoverRunHandler';
import type { StepResultRow } from '../stepResultStore';
import type { ClaudeStreamEvent } from '../../../../shared/types/claudeStream';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Two plain steps — 'step-b' is the definition's LAST (final-gate) step. */
const BASIC_SPEC = JSON.stringify({
  id: 'test-wf',
  phases: [
    {
      id: 'phase-1',
      label: 'Phase 1',
      color: '#111111',
      steps: [
        { id: 'step-a', name: 'Step A', agent: 'agent-a' },
        { id: 'step-b', name: 'Step B', agent: 'human' },
      ],
    },
  ],
});

/**
 * FROZEN spec (Fix 2): its LAST step is 'frozen-final'. Seeded as a workflow_revisions
 * row so resolveRunFrozenSpec resolves this graph — even though the LIVE workflow row
 * points at LIVE_SPEC (a different graph whose last step is 'live-final').
 */
const FROZEN_SPEC = JSON.stringify({
  id: 'test-wf',
  phases: [
    {
      id: 'phase-1',
      label: 'Phase 1',
      color: '#111111',
      steps: [
        { id: 'step-a', name: 'Step A', agent: 'agent-a' },
        { id: 'frozen-final', name: 'Frozen Final', agent: 'human' },
      ],
    },
  ],
});

/** LIVE spec — a DIFFERENT graph (extra step): its last step 'live-final' is mid-run in FROZEN_SPEC. */
const LIVE_SPEC = JSON.stringify({
  id: 'test-wf',
  phases: [
    {
      id: 'phase-1',
      label: 'Phase 1',
      color: '#111111',
      steps: [
        { id: 'step-a', name: 'Step A', agent: 'agent-a' },
        { id: 'frozen-final', name: 'Frozen Final', agent: 'agent-x' },
        { id: 'live-final', name: 'Live Final', agent: 'human' },
      ],
    },
  ],
});

function makeDb(): Database.Database {
  const db = createTestDb({ includeSubstrate: true, includeWorkflowRunTaskColumns: true });
  // Minimal review_items surface for the pending-gate query (not part of GATE_SCHEMA).
  db.exec(
    `CREATE TABLE review_items (
       id TEXT PRIMARY KEY,
       run_id TEXT,
       kind TEXT,
       status TEXT,
       blocking INTEGER,
       source TEXT
     )`,
  );
  // Frozen-spec resolution surface (migrations 026/048): spec_hash on workflow_runs +
  // the workflow_revisions table. Additive — a run with a NULL spec_hash degrades to
  // the live workflows.spec_json (resolveRunFrozenSpec), so tests that never seed a
  // revision keep the live spec they set. See seedFrozenSpec.
  db.exec('ALTER TABLE workflow_runs ADD COLUMN spec_hash TEXT');
  db.exec(
    `CREATE TABLE workflow_revisions (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       workflow_id TEXT NOT NULL,
       spec_hash TEXT NOT NULL,
       spec_json TEXT NOT NULL,
       UNIQUE(workflow_id, spec_hash)
     )`,
  );
  return db;
}

/** Freeze `specJson` as the run's revision so resolveRunFrozenSpec returns it over the live row. */
function seedFrozenSpec(
  db: Database.Database,
  runId: string,
  workflowId: string,
  specJson: string,
): void {
  const hash = `hash-${Math.random().toString(36).slice(2)}`;
  db.prepare('UPDATE workflow_runs SET spec_hash = ? WHERE id = ?').run(hash, runId);
  db.prepare(
    'INSERT INTO workflow_revisions (workflow_id, spec_hash, spec_json) VALUES (?, ?, ?)',
  ).run(workflowId, hash, specJson);
}

function seedProgrammaticRun(
  db: Database.Database,
  overrides?: {
    status?: 'awaiting_review' | 'running' | 'failed' | 'completed';
    executionModel?: 'orchestrated' | 'programmatic';
    specJson?: string;
  },
): { runId: string; workflowId: string } {
  const { runId, workflowId } = seedRun(db, { status: overrides?.status ?? 'awaiting_review' });
  db.prepare('UPDATE workflow_runs SET execution_model = ? WHERE id = ?').run(
    overrides?.executionModel ?? 'programmatic',
    runId,
  );
  db.prepare('UPDATE workflows SET spec_json = ? WHERE id = ?').run(
    overrides?.specJson ?? BASIC_SPEC,
    workflowId,
  );
  return { runId, workflowId };
}

function seedGateItem(db: Database.Database, runId: string, source: string): string {
  const id = `ri-${Math.random().toString(36).slice(2)}`;
  db.prepare(
    `INSERT INTO review_items (id, run_id, kind, status, blocking, source)
     VALUES (?, ?, 'decision', 'pending', 1, ?)`,
  ).run(id, runId, source);
  return id;
}

type EventLogEntry = { type: 'user' | 'assistant'; text: string };

/** Collect injected events + a monotonic call-order log shared with the handover fn. */
function makeHarness(
  db: Database.Database,
  opts?: {
    isEnabled?: boolean;
    listStepResults?: (runId: string) => StepResultRow[];
    handoverResult?: HandoverRunResult;
    /** When true the handover fn REJECTS (post-inject throw path, Fix 4). */
    handoverThrows?: boolean;
  },
): {
  deps: FinalGateHandoverDeps;
  events: EventLogEntry[];
  order: string[];
  handover: ReturnType<typeof vi.fn>;
} {
  const events: EventLogEntry[] = [];
  const order: string[] = [];
  const inject = (event: ClaudeStreamEvent): void => {
    // UnknownStreamEvent keys off `kind`, so guard `type` presence before narrowing.
    if (!('type' in event)) return;
    if (event.type === 'user') {
      const block = event.message.content[0];
      events.push({ type: 'user', text: block && block.type === 'text' ? block.text : '' });
      order.push('inject-user');
    } else if (event.type === 'assistant') {
      const block = event.message.content[0];
      events.push({ type: 'assistant', text: block && block.type === 'text' ? block.text : '' });
      order.push('inject-assistant');
    }
  };
  const handover = vi
    .fn<(runId: string, reason: string, ctx: FinalGateHandoverContext) => Promise<HandoverRunResult>>()
    .mockImplementation(async () => {
      order.push('handover');
      if (opts?.handoverThrows) throw new Error('handover boom');
      return opts?.handoverResult ?? { delivered: true };
    });
  const deps: FinalGateHandoverDeps = {
    db: dbAdapter(db),
    isEnabled: () => opts?.isEnabled ?? true,
    listStepResults: opts?.listStepResults ?? (() => []),
    getInjectEvent: () => inject,
    handover,
  };
  return { deps, events, order, handover };
}

beforeEach(() => vi.clearAllMocks());

// ---------------------------------------------------------------------------
// Fires
// ---------------------------------------------------------------------------

describe('createFinalGateHandover — fires', () => {
  it('parked-at-final-gate: programmatic + awaiting_review + pending gate at the LAST step', async () => {
    const db = makeDb();
    const { runId } = seedProgrammaticRun(db);
    const gateId = seedGateItem(db, runId, 'gate:human-step:step-b');
    const { deps, events, order, handover } = makeHarness(db);

    const result = await createFinalGateHandover(deps).attempt(runId, 'one more tweak please');

    expect(result).toEqual({ delivered: true, handedOver: true });
    // The raw user text is the handover reason + the final-gate context (incl. the
    // detected gate's review_items.id, threaded through for re-validation — Fix 1).
    expect(handover).toHaveBeenCalledTimes(1);
    const [handoverRunId, reason, ctx] = handover.mock.calls[0];
    expect(handoverRunId).toBe(runId);
    expect(reason).toBe('one more tweak please');
    expect(ctx).toEqual({
      kind: 'parked-at-final-gate',
      stepId: 'step-b',
      stepName: 'Step B',
      reviewItemId: gateId,
    });
    // User turn + '▶' marker injected, in order, BEFORE the handover call.
    expect(events[0]).toEqual({ type: 'user', text: 'one more tweak please' });
    expect(events[1].type).toBe('assistant');
    expect(events[1].text).toContain('▶ Handing this run over');
    expect(order).toEqual(['inject-user', 'inject-assistant', 'handover']);
    db.close();
  });

  it('drained-rest: no gate rows, final step done + others done/skipped', async () => {
    const db = makeDb();
    const { runId } = seedProgrammaticRun(db);
    const listStepResults = (): StepResultRow[] => [
      { runId, stepId: 'step-a', phaseId: 'phase-1', outcome: 'skipped', attempts: 1, summary: null, error: null },
      { runId, stepId: 'step-b', phaseId: 'phase-1', outcome: 'done', attempts: 1, summary: null, error: null },
    ];
    const { deps, handover } = makeHarness(db, { listStepResults });

    const result = await createFinalGateHandover(deps).attempt(runId, 'add a test');

    expect(result).toEqual({ delivered: true, handedOver: true });
    const [, , ctx] = handover.mock.calls[0];
    expect(ctx).toEqual({ kind: 'drained-rest', stepId: 'step-b', stepName: 'Step B' });
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Refuses (returns null → route to the monitor)
// ---------------------------------------------------------------------------

describe('createFinalGateHandover — returns null', () => {
  it('a mid-run gate (pending gate at a NON-last step)', async () => {
    const db = makeDb();
    const { runId } = seedProgrammaticRun(db);
    seedGateItem(db, runId, 'gate:human-step:step-a');
    const { deps, handover } = makeHarness(db);

    expect(await createFinalGateHandover(deps).attempt(runId, 'x')).toBeNull();
    expect(handover).not.toHaveBeenCalled();
    db.close();
  });

  it('a systemic-pause gate is pending (failure pause — monitor owns it)', async () => {
    const db = makeDb();
    const { runId } = seedProgrammaticRun(db);
    seedGateItem(db, runId, 'gate:systemic-pause:step-b');
    const { deps, handover } = makeHarness(db);

    expect(await createFinalGateHandover(deps).attempt(runId, 'x')).toBeNull();
    expect(handover).not.toHaveBeenCalled();
    db.close();
  });

  it('the final gate outcome is rejected (drained-rest refuses a rejected run)', async () => {
    const db = makeDb();
    const { runId } = seedProgrammaticRun(db);
    const listStepResults = (): StepResultRow[] => [
      { runId, stepId: 'step-a', phaseId: 'phase-1', outcome: 'done', attempts: 1, summary: null, error: null },
      { runId, stepId: 'step-b', phaseId: 'phase-1', outcome: 'rejected', attempts: 1, summary: null, error: null },
    ];
    const { deps } = makeHarness(db, { listStepResults });

    expect(await createFinalGateHandover(deps).attempt(runId, 'x')).toBeNull();
    db.close();
  });

  it('drained-rest with a MISSING result for a defined step refuses', async () => {
    const db = makeDb();
    const { runId } = seedProgrammaticRun(db);
    // Only the final step recorded — step-a has no result row.
    const listStepResults = (): StepResultRow[] => [
      { runId, stepId: 'step-b', phaseId: 'phase-1', outcome: 'done', attempts: 1, summary: null, error: null },
    ];
    const { deps } = makeHarness(db, { listStepResults });

    expect(await createFinalGateHandover(deps).attempt(runId, 'x')).toBeNull();
    db.close();
  });

  it('an orchestrated run', async () => {
    const db = makeDb();
    const { runId } = seedProgrammaticRun(db, { executionModel: 'orchestrated' });
    seedGateItem(db, runId, 'gate:human-step:step-b');
    const { deps } = makeHarness(db);

    expect(await createFinalGateHandover(deps).attempt(runId, 'x')).toBeNull();
    db.close();
  });

  it('a non-resting status (running)', async () => {
    const db = makeDb();
    const { runId } = seedProgrammaticRun(db, { status: 'running' });
    seedGateItem(db, runId, 'gate:human-step:step-b');
    const { deps } = makeHarness(db);

    expect(await createFinalGateHandover(deps).attempt(runId, 'x')).toBeNull();
    db.close();
  });

  it('the kill switch is off (isEnabled → false)', async () => {
    const db = makeDb();
    const { runId } = seedProgrammaticRun(db);
    seedGateItem(db, runId, 'gate:human-step:step-b');
    const { deps, handover } = makeHarness(db, { isEnabled: false });

    expect(await createFinalGateHandover(deps).attempt(runId, 'x')).toBeNull();
    expect(handover).not.toHaveBeenCalled();
    db.close();
  });

  it('a missing run', async () => {
    const db = makeDb();
    const { deps } = makeHarness(db);
    expect(await createFinalGateHandover(deps).attempt('no-such-run', 'x')).toBeNull();
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Refusal path (handover returns a noOp)
// ---------------------------------------------------------------------------

describe('createFinalGateHandover — handover refusal', () => {
  it('a noOp handover → { delivered: true, handedOver: false } + a ⚠ marker (no monitor fallthrough)', async () => {
    const db = makeDb();
    const { runId } = seedProgrammaticRun(db);
    seedGateItem(db, runId, 'gate:human-step:step-b');
    const { deps, events } = makeHarness(db, { handoverResult: { noOp: true, reason: 'race' } });

    const result = await createFinalGateHandover(deps).attempt(runId, 'do the thing');

    expect(result).toEqual({ delivered: true, handedOver: false });
    // The user turn is already injected; a ⚠ marker follows (the message was consumed).
    expect(events[0]).toEqual({ type: 'user', text: 'do the thing' });
    const warnMarker = events.find((e) => e.type === 'assistant' && e.text.startsWith('⚠'));
    expect(warnMarker).toBeDefined();
    expect(warnMarker!.text).toContain('changed state mid-handover');
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Fix 2 — detection uses the run's FROZEN spec, not the live workflow row
// ---------------------------------------------------------------------------

describe('createFinalGateHandover — frozen-spec detection (Fix 2)', () => {
  it('a pending gate at the FROZEN last step fires (frozen graph, not the live row)', async () => {
    const db = makeDb();
    // Live workflow row = LIVE_SPEC (last step 'live-final'); frozen revision = FROZEN_SPEC
    // (last step 'frozen-final'). Detection must use the FROZEN graph.
    const { runId, workflowId } = seedProgrammaticRun(db, { specJson: LIVE_SPEC });
    seedFrozenSpec(db, runId, workflowId, FROZEN_SPEC);
    const gateId = seedGateItem(db, runId, 'gate:human-step:frozen-final');
    const { deps, handover } = makeHarness(db);

    const result = await createFinalGateHandover(deps).attempt(runId, 'tweak');

    expect(result).toEqual({ delivered: true, handedOver: true });
    const [, , ctx] = handover.mock.calls[0];
    expect(ctx).toEqual({
      kind: 'parked-at-final-gate',
      stepId: 'frozen-final',
      stepName: 'Frozen Final',
      reviewItemId: gateId,
    });
    db.close();
  });

  it('a pending gate at the LIVE last step (mid-run in the frozen graph) returns null', async () => {
    const db = makeDb();
    const { runId, workflowId } = seedProgrammaticRun(db, { specJson: LIVE_SPEC });
    seedFrozenSpec(db, runId, workflowId, FROZEN_SPEC);
    // 'live-final' is the LIVE last step but a NON-last step in the frozen graph, so a
    // gate there is a mid-run gate → not applicable.
    seedGateItem(db, runId, 'gate:human-step:live-final');
    const { deps, handover } = makeHarness(db);

    expect(await createFinalGateHandover(deps).attempt(runId, 'x')).toBeNull();
    expect(handover).not.toHaveBeenCalled();
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Fix 1 — reviewItemId capture into the handover context
// ---------------------------------------------------------------------------

describe('createFinalGateHandover — reviewItemId capture (Fix 1)', () => {
  it('captures the pending final gate review_items.id for parked-at-final-gate', async () => {
    const db = makeDb();
    const { runId } = seedProgrammaticRun(db);
    const gateId = seedGateItem(db, runId, 'gate:human-step:step-b');
    const { deps, handover } = makeHarness(db);

    await createFinalGateHandover(deps).attempt(runId, 'x');

    const [, , ctx] = handover.mock.calls[0];
    expect(ctx.reviewItemId).toBe(gateId);
    db.close();
  });

  it('omits reviewItemId for drained-rest (no open gate row to re-validate)', async () => {
    const db = makeDb();
    const { runId } = seedProgrammaticRun(db);
    const listStepResults = (): StepResultRow[] => [
      { runId, stepId: 'step-a', phaseId: 'phase-1', outcome: 'done', attempts: 1, summary: null, error: null },
      { runId, stepId: 'step-b', phaseId: 'phase-1', outcome: 'done', attempts: 1, summary: null, error: null },
    ];
    const { deps, handover } = makeHarness(db, { listStepResults });

    await createFinalGateHandover(deps).attempt(runId, 'x');

    const [, , ctx] = handover.mock.calls[0];
    expect(ctx.reviewItemId).toBeUndefined();
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Fix 3 — per-run single-flight
// ---------------------------------------------------------------------------

describe('createFinalGateHandover — single-flight (Fix 3)', () => {
  it('a second concurrent send does not re-run detection while the first is mid-handover', async () => {
    const db = makeDb();
    const { runId } = seedProgrammaticRun(db);
    seedGateItem(db, runId, 'gate:human-step:step-b');

    let releaseHandover!: (r: HandoverRunResult) => void;
    const handoverGate = new Promise<HandoverRunResult>((res) => {
      releaseHandover = res;
    });
    const handover = vi
      .fn<(runId: string, reason: string, ctx: FinalGateHandoverContext) => Promise<HandoverRunResult>>()
      .mockImplementation(async () => {
        // Simulate the real handover: flip execution_model + stamp handed_over_at BEFORE
        // resolving, so a second attempt chained behind this one observes a converted run.
        db.prepare(
          "UPDATE workflow_runs SET execution_model = 'orchestrated', handed_over_at = CURRENT_TIMESTAMP WHERE id = ?",
        ).run(runId);
        return handoverGate;
      });

    const deps: FinalGateHandoverDeps = {
      db: dbAdapter(db),
      isEnabled: () => true,
      listStepResults: () => [],
      getInjectEvent: () => () => {},
      handover,
    };
    const checker = createFinalGateHandover(deps);

    // Launch A and B concurrently — B is queued while A is mid-handover (deferred).
    const aPromise = checker.attempt(runId, 'first');
    const bPromise = checker.attempt(runId, 'second');
    releaseHandover({ delivered: true });
    const [aResult, bResult] = await Promise.all([aPromise, bPromise]);

    expect(aResult).toEqual({ delivered: true, handedOver: true });
    // B ran its detection ONLY after A settled — the run is now handed over, so B gets
    // an honest failure and never re-injects or re-hands-over.
    expect(bResult).toEqual({ delivered: false, handedOver: false });
    expect(handover).toHaveBeenCalledTimes(1);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Fix 4 — a handover that THROWS post-inject is owned here
// ---------------------------------------------------------------------------

describe('createFinalGateHandover — post-inject throw (Fix 4)', () => {
  it('a throwing handover injects a ⚠ failure marker and resolves { delivered: true, handedOver: false }', async () => {
    const db = makeDb();
    const { runId } = seedProgrammaticRun(db);
    seedGateItem(db, runId, 'gate:human-step:step-b');
    const { deps, events } = makeHarness(db, { handoverThrows: true });

    // Must NOT throw — the message is owned once injected.
    const result = await createFinalGateHandover(deps).attempt(runId, 'do it');

    expect(result).toEqual({ delivered: true, handedOver: false });
    expect(events[0]).toEqual({ type: 'user', text: 'do it' });
    const warnMarker = events.find((e) => e.type === 'assistant' && e.text.startsWith('⚠'));
    expect(warnMarker).toBeDefined();
    expect(warnMarker!.text).toContain('handover failed unexpectedly');
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Fix 3 — post-handover stale send (row already orchestrated)
// ---------------------------------------------------------------------------

describe('createFinalGateHandover — post-handover stale send (Fix 3)', () => {
  it('orchestrated + handed_over_at set → { delivered: false, handedOver: false } (honest failure)', async () => {
    const db = makeDb();
    const { runId } = seedProgrammaticRun(db, { executionModel: 'orchestrated' });
    db.prepare('UPDATE workflow_runs SET handed_over_at = CURRENT_TIMESTAMP WHERE id = ?').run(runId);
    const { deps, handover } = makeHarness(db);

    const result = await createFinalGateHandover(deps).attempt(runId, 'stale tab send');

    expect(result).toEqual({ delivered: false, handedOver: false });
    expect(handover).not.toHaveBeenCalled();
    db.close();
  });

  it('orchestrated + handed_over_at NULL → null (genuinely orchestrated; legacy monitor path)', async () => {
    const db = makeDb();
    const { runId } = seedProgrammaticRun(db, { executionModel: 'orchestrated' });
    // handed_over_at stays NULL (never handed over).
    const { deps, handover } = makeHarness(db);

    expect(await createFinalGateHandover(deps).attempt(runId, 'x')).toBeNull();
    expect(handover).not.toHaveBeenCalled();
    db.close();
  });
});
