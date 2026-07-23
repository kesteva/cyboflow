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
  return db;
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

function seedGateItem(db: Database.Database, runId: string, source: string): void {
  db.prepare(
    `INSERT INTO review_items (id, run_id, kind, status, blocking, source)
     VALUES (?, ?, 'decision', 'pending', 1, ?)`,
  ).run(`ri-${Math.random().toString(36).slice(2)}`, runId, source);
}

type EventLogEntry = { type: 'user' | 'assistant'; text: string };

/** Collect injected events + a monotonic call-order log shared with the handover fn. */
function makeHarness(
  db: Database.Database,
  opts?: {
    isEnabled?: boolean;
    listStepResults?: (runId: string) => StepResultRow[];
    handoverResult?: HandoverRunResult;
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
    seedGateItem(db, runId, 'gate:human-step:step-b');
    const { deps, events, order, handover } = makeHarness(db);

    const result = await createFinalGateHandover(deps).attempt(runId, 'one more tweak please');

    expect(result).toEqual({ delivered: true, handedOver: true });
    // The raw user text is the handover reason + the final-gate context.
    expect(handover).toHaveBeenCalledTimes(1);
    const [handoverRunId, reason, ctx] = handover.mock.calls[0];
    expect(handoverRunId).toBe(runId);
    expect(reason).toBe('one more tweak please');
    expect(ctx).toEqual({ kind: 'parked-at-final-gate', stepId: 'step-b', stepName: 'Step B' });
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
