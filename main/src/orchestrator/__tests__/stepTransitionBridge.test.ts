/**
 * Unit tests for stepTransitionBridge (TASK-765 acceptance criteria).
 *
 * Test coverage (per test_strategy):
 *   (a) Happy-path emit fires with correct event shape.
 *   (b) DB current_step_id is updated before emit.
 *   (c) Emit happens AFTER the UPDATE (write-then-emit ordering).
 *   (d) Unknown workflow name → resolveInitialStepId returns null; no DB write/emit.
 *   (e) Missing workflow_runs row → logs warn, does NOT throw.
 *   (f) raw_events 'step_transition' persistence (Insights timeline): row written
 *       on valid transitions (shape + payload), no row on rejected/missing, and
 *       fail-soft emit when the INSERT throws.
 */

import Database from 'better-sqlite3';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '../__test_fixtures__/orchestratorTestDb';
import { makeSpyLogger } from '../__test_fixtures__/loggerLikeSpy';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { countRawEvents } from '../__test_fixtures__/rawEvents';
import type { DatabaseLike } from '../types';
import {
  buildStepTransitionEvent,
  resolveInitialStepId,
} from '../stepTransitionBridge';
import type { WorkflowStepTransitionEvent, WorkflowDefinition } from '../../../../shared/types/workflows';
import { stepTransitionEvents } from '../trpc/routers/events';
import { CYBOFLOW_WORKFLOW_NAMES, WORKFLOW_DEFINITIONS } from '../../../../shared/types/workflows';
import { handleRunStart, handleStepCompletion, handleVisualArtifactsScan } from '../autoMintArtifacts';

// The auto-mint hooks are observational fire-and-forget side-effects off the
// bridge — mock them so we can assert the run-START baseline trigger condition
// (FIX: fire handleRunStart ONLY on the INITIAL step's 'running', NOT on every
// later planner 'running' — the created-idea case now flows through
// handleEntityWrite off the MCP write path) without touching the real artifact DB.
vi.mock('../autoMintArtifacts', () => ({
  handleRunStart: vi.fn(() => Promise.resolve()),
  handleStepCompletion: vi.fn(() => Promise.resolve()),
  handleEntityWrite: vi.fn(() => Promise.resolve()),
  handleVisualArtifactsScan: vi.fn(() => Promise.resolve()),
}));

/**
 * Shape of a persisted 'step_transition' raw_events row's decoded payload_json.
 * Mirrors the object written by buildStepTransitionEvent.
 */
interface StepTransitionPayload {
  kind: string;
  step_id: string;
  status: string;
  timestamp: string;
}

/**
 * Read the single 'step_transition' raw_events row for a run and return its
 * { event_type, decoded payload }. Throws if there is not exactly one such row.
 */
function readStepTransitionRow(
  db: Database.Database,
  runId: string,
): { event_type: string; payload: StepTransitionPayload } {
  const rows = db
    .prepare(
      `SELECT event_type, payload_json FROM raw_events
       WHERE run_id = ? AND event_type = 'step_transition'`,
    )
    .all(runId) as { event_type: string; payload_json: string }[];
  expect(rows).toHaveLength(1);
  return {
    event_type: rows[0].event_type,
    payload: JSON.parse(rows[0].payload_json) as StepTransitionPayload,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a test DB with migration 011 (current_step_id) applied on top of
 * GATE_SCHEMA. We cannot modify orchestratorTestDb.ts (files_readonly), so the
 * ALTER is inlined here per the plan's note on the fixture.
 */
function createTestDbWithCurrentStep() {
  const db = createTestDb({ includeQuestionsTable: true });
  db.exec('ALTER TABLE workflow_runs ADD COLUMN current_step_id TEXT');
  return db;
}

/**
 * Seed a minimal workflow + workflow_run row pair for bridge tests.
 *
 * Returns { db, runId } ready for use.
 */
function seedForBridge(workflowName: string, specJson = '{}') {
  const db = createTestDbWithCurrentStep();
  const workflowId = `wf-${workflowName}`;
  const runId = `run-${workflowName}-01`;

  db.prepare(
    `INSERT INTO workflows (id, project_id, name, spec_json)
     VALUES (?, 1, ?, ?)`,
  ).run(workflowId, workflowName, specJson);

  db.prepare(
    `INSERT INTO workflow_runs
       (id, workflow_id, project_id, worktree_path, status)
     VALUES (?, ?, 1, '/tmp/test', 'running')`,
  ).run(runId, workflowId);

  return { db, runId };
}

// ---------------------------------------------------------------------------
// resolveInitialStepId
// ---------------------------------------------------------------------------

describe('resolveInitialStepId', () => {
  it('returns a non-null string for every CYBOFLOW_WORKFLOW_NAMES entry', () => {
    for (const name of CYBOFLOW_WORKFLOW_NAMES) {
      const stepId = resolveInitialStepId(name);
      expect(stepId, `${name} should resolve to a step id`).not.toBeNull();
      expect(typeof stepId).toBe('string');
      expect(stepId!.length).toBeGreaterThan(0);
    }
  });

  it('returns null for an unknown workflow name', () => {
    expect(resolveInitialStepId('nonexistent-workflow')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(resolveInitialStepId('')).toBeNull();
  });

  it('returns stable bare step ids matching the first step of each WORKFLOW_DEFINITIONS entry', () => {
    expect(resolveInitialStepId('planner')).toBe('context');
    expect(resolveInitialStepId('sprint')).toBe('analyze-dependencies');
    expect(resolveInitialStepId('compound')).toBe('load-sprint');
  });
});

// ---------------------------------------------------------------------------
// buildStepTransitionEvent
// ---------------------------------------------------------------------------

describe('buildStepTransitionEvent — happy path', () => {
  let emittedEvents: WorkflowStepTransitionEvent[] = [];

  beforeEach(() => {
    emittedEvents = [];
    stepTransitionEvents.on('transition', (ev: WorkflowStepTransitionEvent) => {
      emittedEvents.push(ev);
    });
  });

  afterEach(() => {
    stepTransitionEvents.removeAllListeners('transition');
  });

  it('(a) emits an event with the correct shape on the stepTransitionEvents emitter', () => {
    const { db, runId } = seedForBridge('sprint');
    const adapter = dbAdapter(db);
    const logger = makeSpyLogger();

    const event = buildStepTransitionEvent(runId, 'execute-tasks', 'running', adapter, logger);

    expect(event).not.toBeNull();
    expect(event!.runId).toBe(runId);
    expect(event!.stepId).toBe('execute-tasks');
    expect(event!.status).toBe('running');
    expect(typeof event!.timestamp).toBe('string');

    // Emitter must have fired exactly once with the correct event.
    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0]).toMatchObject({
      runId,
      stepId: 'execute-tasks',
      status: 'running',
    });
  });

  it('(b) DB current_step_id is updated to the stepId before emit', () => {
    const { db, runId } = seedForBridge('sprint');
    const adapter = dbAdapter(db);
    const logger = makeSpyLogger();

    // Track when the event was emitted and what the DB state was at that moment.
    let dbValueAtEmitTime: string | null | undefined;
    stepTransitionEvents.once('transition', () => {
      const row = db
        .prepare('SELECT current_step_id FROM workflow_runs WHERE id = ?')
        .get(runId) as { current_step_id: string | null } | undefined;
      dbValueAtEmitTime = row?.current_step_id;
    });

    buildStepTransitionEvent(runId, 'execute-tasks', 'running', adapter, logger);

    // The DB must have been updated BEFORE the event fired.
    expect(dbValueAtEmitTime).toBe('execute-tasks');
  });

  it('(c) emit happens AFTER the UPDATE (write-then-emit ordering verified via event listener read)', () => {
    const { db, runId } = seedForBridge('sprint');
    const adapter = dbAdapter(db);

    const callLog: string[] = [];

    // The event listener reads from DB — if UPDATE had not run yet, current_step_id would be null.
    stepTransitionEvents.once('transition', () => {
      const row = db
        .prepare('SELECT current_step_id FROM workflow_runs WHERE id = ?')
        .get(runId) as { current_step_id: string | null } | undefined;
      // Record whether the DB had the value when the listener fired.
      callLog.push(row?.current_step_id === 'execute-tasks' ? 'db-written-before-emit' : 'db-not-written');
      callLog.push('emit-fired');
    });

    buildStepTransitionEvent(runId, 'execute-tasks', 'done', adapter);

    expect(callLog[0]).toBe('db-written-before-emit');
    expect(callLog[1]).toBe('emit-fired');
  });

  it('also fires with status=done on run completion', () => {
    const { db, runId } = seedForBridge('sprint');
    const adapter = dbAdapter(db);

    buildStepTransitionEvent(runId, 'sprint-verify', 'done', adapter);

    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0].status).toBe('done');
    expect(emittedEvents[0].stepId).toBe('sprint-verify');

    // Verify DB was also updated.
    const row = db
      .prepare('SELECT current_step_id FROM workflow_runs WHERE id = ?')
      .get(runId) as { current_step_id: string | null } | undefined;
    expect(row?.current_step_id).toBe('sprint-verify');
  });
});

describe('buildStepTransitionEvent — missing row (fail-soft)', () => {
  afterEach(() => {
    stepTransitionEvents.removeAllListeners('transition');
  });

  it('(e) logs warn and does NOT throw when workflow_runs row is missing', () => {
    const db = createTestDbWithCurrentStep();
    const adapter = dbAdapter(db);
    const logger = makeSpyLogger();

    const emitSpy = vi.fn();
    stepTransitionEvents.on('transition', emitSpy);

    // runId that does not exist in the DB.
    let result: WorkflowStepTransitionEvent | null | undefined;
    expect(() => {
      result = buildStepTransitionEvent('nonexistent-run-id', 'implement', 'running', adapter, logger);
    }).not.toThrow();

    // Returns null — no event emitted.
    expect(result).toBeNull();
    expect(emitSpy).not.toHaveBeenCalled();

    // logger.warn must have been called.
    expect(logger.warn).toHaveBeenCalledOnce();
    expect((logger.warn as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('nonexistent-run-id');
  });
});

describe('buildStepTransitionEvent — unknown workflow name (no DB write/emit)', () => {
  afterEach(() => {
    stepTransitionEvents.removeAllListeners('transition');
  });

  it('(d) resolveInitialStepId returns null for unknown workflow; caller skips DB write and emit', () => {
    const db = createTestDbWithCurrentStep();

    // Seed a run with an unknown workflow name.
    const workflowId = 'wf-unknown';
    const runId = 'run-unknown-01';
    db.prepare(
      `INSERT INTO workflows (id, project_id, name, spec_json) VALUES (?, 1, ?, '{}')`,
    ).run(workflowId, 'unknown-workflow');
    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, worktree_path, status) VALUES (?, ?, 1, '/tmp/test', 'running')`,
    ).run(runId, workflowId);

    const stepId = resolveInitialStepId('unknown-workflow');
    expect(stepId).toBeNull();

    // When stepId is null, the caller (RunExecutor's emitStep adapter in index.ts)
    // does NOT call buildStepTransitionEvent. We verify the DB is untouched.
    const adapter = dbAdapter(db);
    const emitSpy = vi.fn();
    stepTransitionEvents.on('transition', emitSpy);

    // Simulate the caller's guard (as in index.ts stepTransitionEmitter.emit).
    if (stepId !== null) {
      buildStepTransitionEvent(runId, stepId, 'running', adapter);
    }

    expect(emitSpy).not.toHaveBeenCalled();

    const row = db
      .prepare('SELECT current_step_id FROM workflow_runs WHERE id = ?')
      .get(runId) as { current_step_id: string | null } | undefined;
    expect(row?.current_step_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildStepTransitionEvent — stepId validation (dynamic step-id model)
// ---------------------------------------------------------------------------

describe('buildStepTransitionEvent — stepId validation', () => {
  let emittedEvents: WorkflowStepTransitionEvent[] = [];

  beforeEach(() => {
    emittedEvents = [];
    stepTransitionEvents.on('transition', (ev: WorkflowStepTransitionEvent) => {
      emittedEvents.push(ev);
    });
  });

  afterEach(() => {
    stepTransitionEvents.removeAllListeners('transition');
  });

  it('rejects a stepId not present in the run\'s resolved definition: no write, no emit, warn, returns null', () => {
    const { db, runId } = seedForBridge('sprint');
    const adapter = dbAdapter(db);
    const logger = makeSpyLogger();

    const result = buildStepTransitionEvent(runId, 'not-a-real-step', 'running', adapter, logger);

    expect(result).toBeNull();
    expect(emittedEvents).toHaveLength(0);

    const row = db
      .prepare('SELECT current_step_id FROM workflow_runs WHERE id = ?')
      .get(runId) as { current_step_id: string | null } | undefined;
    expect(row?.current_step_id).toBeNull();

    expect(logger.warn).toHaveBeenCalledOnce();
    expect((logger.warn as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('not-a-real-step');
  });

  it('accepts ANY valid (non-initial) stepId of the resolved workflow: writes, emits once, returns the event', () => {
    // 'epics' is a real planner flat step id and is NOT the initial step ('context').
    const validNonInitialStepId = 'epics';
    const plannerFlatStepIds = WORKFLOW_DEFINITIONS.planner.phases
      .flatMap((p) => p.steps)
      .map((s) => s.id);
    expect(plannerFlatStepIds).toContain(validNonInitialStepId);
    expect(resolveInitialStepId('planner')).not.toBe(validNonInitialStepId);

    const { db, runId } = seedForBridge('planner');
    const adapter = dbAdapter(db);
    const logger = makeSpyLogger();

    const event = buildStepTransitionEvent(runId, validNonInitialStepId, 'running', adapter, logger);

    expect(event).not.toBeNull();
    expect(event!.stepId).toBe(validNonInitialStepId);
    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0].stepId).toBe(validNonInitialStepId);

    const row = db
      .prepare('SELECT current_step_id FROM workflow_runs WHERE id = ?')
      .get(runId) as { current_step_id: string | null } | undefined;
    expect(row?.current_step_id).toBe(validNonInitialStepId);
  });

  it('accepts an EDITED/custom stepId present only in spec_json (absent from the static built-in)', () => {
    // Custom flow def whose step id 'discovery-call' exists nowhere in
    // WORKFLOW_DEFINITIONS.sprint — proving validation resolves from spec_json.
    const customDef: WorkflowDefinition = {
      id: 'sprint',
      phases: [
        {
          id: 'execute',
          label: 'Execute',
          color: '#c96442',
          steps: [
            {
              id: 'discovery-call',
              name: 'Discovery call',
              agent: 'executor',
              mcps: [],
              retries: 0,
            },
          ],
        },
      ],
    };
    const sprintFlatStepIds = WORKFLOW_DEFINITIONS.sprint.phases
      .flatMap((p) => p.steps)
      .map((s) => s.id);
    expect(sprintFlatStepIds).not.toContain('discovery-call');

    const { db, runId } = seedForBridge('sprint', JSON.stringify(customDef));
    const adapter = dbAdapter(db);
    const logger = makeSpyLogger();

    const event = buildStepTransitionEvent(runId, 'discovery-call', 'running', adapter, logger);

    expect(event).not.toBeNull();
    expect(event!.stepId).toBe('discovery-call');
    expect(emittedEvents).toHaveLength(1);

    const row = db
      .prepare('SELECT current_step_id FROM workflow_runs WHERE id = ?')
      .get(runId) as { current_step_id: string | null } | undefined;
    expect(row?.current_step_id).toBe('discovery-call');
  });

  it('rejects a built-in stepId that the edit REMOVED from spec_json', () => {
    // Custom sprint def that keeps only 'analyze-dependencies' — the built-in
    // 'execute-tasks' step has been removed by the edit and must now be rejected.
    const editedDef: WorkflowDefinition = {
      id: 'sprint',
      phases: [
        {
          id: 'plan',
          label: 'Plan',
          color: '#5a4ad6',
          steps: [
            {
              id: 'analyze-dependencies',
              name: 'Analyze dependencies',
              agent: 'dependency-analyzer',
              mcps: [],
              retries: 0,
            },
          ],
        },
      ],
    };
    const sprintFlatStepIds = WORKFLOW_DEFINITIONS.sprint.phases
      .flatMap((p) => p.steps)
      .map((s) => s.id);
    expect(sprintFlatStepIds).toContain('execute-tasks');

    const { db, runId } = seedForBridge('sprint', JSON.stringify(editedDef));
    const adapter = dbAdapter(db);
    const logger = makeSpyLogger();

    const result = buildStepTransitionEvent(runId, 'execute-tasks', 'running', adapter, logger);

    expect(result).toBeNull();
    expect(emittedEvents).toHaveLength(0);

    const row = db
      .prepare('SELECT current_step_id FROM workflow_runs WHERE id = ?')
      .get(runId) as { current_step_id: string | null } | undefined;
    expect(row?.current_step_id).toBeNull();

    expect(logger.warn).toHaveBeenCalledOnce();
    expect((logger.warn as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('execute-tasks');
  });
});

// ---------------------------------------------------------------------------
// buildStepTransitionEvent — raw_events 'step_transition' persistence
// (Insights timeline; shared handler path → both substrates persist)
// ---------------------------------------------------------------------------

describe('buildStepTransitionEvent — step_transition raw_events persistence', () => {
  let emittedEvents: WorkflowStepTransitionEvent[] = [];

  beforeEach(() => {
    emittedEvents = [];
    stepTransitionEvents.on('transition', (ev: WorkflowStepTransitionEvent) => {
      emittedEvents.push(ev);
    });
  });

  afterEach(() => {
    stepTransitionEvents.removeAllListeners('transition');
  });

  it('(f) writes a step_transition raw_events row with the correct payload shape on a valid transition', () => {
    const { db, runId } = seedForBridge('sprint');
    const adapter = dbAdapter(db);
    const logger = makeSpyLogger();

    const event = buildStepTransitionEvent(runId, 'execute-tasks', 'running', adapter, logger);

    expect(event).not.toBeNull();
    // Exactly one step_transition row for this run.
    expect(countRawEvents(db, runId)).toBe(1);

    const { event_type, payload } = readStepTransitionRow(db, runId);
    expect(event_type).toBe('step_transition');
    expect(payload).toEqual({
      kind: 'step_transition',
      step_id: 'execute-tasks',
      status: 'running',
      timestamp: event!.timestamp,
    });
  });

  it('(f) the persisted payload timestamp equals the emitted event timestamp', () => {
    const { db, runId } = seedForBridge('sprint');
    const adapter = dbAdapter(db);

    const event = buildStepTransitionEvent(runId, 'execute-tasks', 'done', adapter);

    expect(event).not.toBeNull();
    expect(emittedEvents).toHaveLength(1);

    const { payload } = readStepTransitionRow(db, runId);
    // Payload timestamp matches BOTH the returned event and the emitted event.
    expect(payload.timestamp).toBe(event!.timestamp);
    expect(payload.timestamp).toBe(emittedEvents[0].timestamp);
    expect(payload.status).toBe('done');
  });

  it('(f) persists from the shared handler path regardless of substrate (no substrate fork)', () => {
    // The bridge has no substrate parameter — the SAME call site serves both the
    // SDK and interactive substrates, so a single valid transition always lands
    // exactly one row. This guards against a future substrate-specific fork.
    const { db, runId } = seedForBridge('planner');
    const adapter = dbAdapter(db);

    buildStepTransitionEvent(runId, 'context', 'running', adapter);
    buildStepTransitionEvent(runId, 'epics', 'running', adapter);

    expect(countRawEvents(db, runId)).toBe(2);
    const rows = db
      .prepare(
        `SELECT payload_json FROM raw_events
         WHERE run_id = ? AND event_type = 'step_transition'
         ORDER BY id ASC`,
      )
      .all(runId) as { payload_json: string }[];
    const stepIds = rows.map((r) => (JSON.parse(r.payload_json) as StepTransitionPayload).step_id);
    expect(stepIds).toEqual(['context', 'epics']);
  });

  it('(f) writes NO raw_events row when the stepId is rejected', () => {
    const { db, runId } = seedForBridge('sprint');
    const adapter = dbAdapter(db);
    const logger = makeSpyLogger();

    const result = buildStepTransitionEvent(runId, 'not-a-real-step', 'running', adapter, logger);

    expect(result).toBeNull();
    expect(emittedEvents).toHaveLength(0);
    expect(countRawEvents(db, runId)).toBe(0);
  });

  it('(f) writes NO raw_events row when the workflow_runs row is missing', () => {
    const db = createTestDbWithCurrentStep();
    const adapter = dbAdapter(db);
    const logger = makeSpyLogger();

    const result = buildStepTransitionEvent('nonexistent-run-id', 'execute-tasks', 'running', adapter, logger);

    expect(result).toBeNull();
    expect(emittedEvents).toHaveLength(0);
    expect(countRawEvents(db, 'nonexistent-run-id')).toBe(0);
  });

  it('(f) fail-soft: still emits and returns the event when the raw_events INSERT throws', () => {
    const { db, runId } = seedForBridge('sprint');
    const realAdapter = dbAdapter(db);
    const logger = makeSpyLogger();

    // Wrap the adapter so prepare() for the raw_events INSERT yields a statement
    // whose run() throws — but the pointer UPDATE and the validation SELECT still
    // go through the real DB so the transition is genuinely committed first.
    const throwingAdapter: DatabaseLike = {
      prepare: (sql: string) => {
        const stmt = realAdapter.prepare(sql);
        if (sql.includes('INSERT INTO raw_events')) {
          return {
            run: () => {
              throw new Error('simulated raw_events INSERT failure');
            },
            get: stmt.get.bind(stmt),
            all: stmt.all.bind(stmt),
          };
        }
        return stmt;
      },
      transaction: realAdapter.transaction.bind(realAdapter),
    };

    const event = buildStepTransitionEvent(runId, 'execute-tasks', 'running', throwingAdapter, logger);

    // The INSERT threw, but the emit and return STILL happened.
    expect(event).not.toBeNull();
    expect(event!.stepId).toBe('execute-tasks');
    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0].stepId).toBe('execute-tasks');

    // The authoritative pointer write committed despite the INSERT failure.
    const row = db
      .prepare('SELECT current_step_id FROM workflow_runs WHERE id = ?')
      .get(runId) as { current_step_id: string | null } | undefined;
    expect(row?.current_step_id).toBe('execute-tasks');

    // No row landed (the INSERT threw) and the failure was warn-logged.
    expect(countRawEvents(db, runId)).toBe(0);
    expect(logger.warn).toHaveBeenCalledOnce();
    expect((logger.warn as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('raw_events INSERT threw');
  });
});

// ---------------------------------------------------------------------------
// run-START baseline trigger (FIX: fire handleRunStart ONLY on the INITIAL step
// 'running', not on every planner 'running'). The created-idea case is covered
// by handleEntityWrite off the MCP write path, so the "every planner running"
// special-case is reverted.
// ---------------------------------------------------------------------------

describe('run-start baseline trigger', () => {
  beforeEach(() => {
    vi.mocked(handleRunStart).mockClear();
    vi.mocked(handleStepCompletion).mockClear();
  });
  afterEach(() => {
    stepTransitionEvents.removeAllListeners();
  });

  it("fires handleRunStart on the planner INITIAL step ('context') 'running'", () => {
    const { db, runId } = seedForBridge('planner');
    buildStepTransitionEvent(runId, 'context', 'running', dbAdapter(db));
    expect(handleRunStart).toHaveBeenCalledTimes(1);
    expect(vi.mocked(handleRunStart).mock.calls[0][1]).toBe(runId);
  });

  it("does NOT fire handleRunStart on a LATER planner step ('research') 'running'", () => {
    const { db, runId } = seedForBridge('planner');
    buildStepTransitionEvent(runId, 'research', 'running', dbAdapter(db));
    expect(handleRunStart).not.toHaveBeenCalled();
  });

  it("does NOT fire handleRunStart on a 'done' transition (only 'running' run-start)", () => {
    const { db, runId } = seedForBridge('planner');
    buildStepTransitionEvent(runId, 'context', 'done', dbAdapter(db));
    expect(handleRunStart).not.toHaveBeenCalled();
    // 'done' fires the step-completion hook instead.
    expect(handleStepCompletion).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// screenshots scan trigger — fired on EVERY step 'running' (unlike the initial-
// step-only run-start baseline). handleVisualArtifactsScan self-gates to
// sprint/ship + no-ops when no images, so the bridge fires it unconditionally on
// 'running'; here it is mocked, so we assert the trigger condition only.
// ---------------------------------------------------------------------------

describe('screenshots scan trigger', () => {
  beforeEach(() => {
    vi.mocked(handleVisualArtifactsScan).mockClear();
  });
  afterEach(() => {
    stepTransitionEvents.removeAllListeners();
  });

  it("fires handleVisualArtifactsScan on a sprint step 'running'", () => {
    const { db, runId } = seedForBridge('sprint');
    buildStepTransitionEvent(runId, 'execute-tasks', 'running', dbAdapter(db));
    expect(handleVisualArtifactsScan).toHaveBeenCalledTimes(1);
    expect(vi.mocked(handleVisualArtifactsScan).mock.calls[0][1]).toBe(runId);
  });

  it("does NOT fire handleVisualArtifactsScan on a 'done' transition", () => {
    const { db, runId } = seedForBridge('sprint');
    buildStepTransitionEvent(runId, 'execute-tasks', 'done', dbAdapter(db));
    expect(handleVisualArtifactsScan).not.toHaveBeenCalled();
  });
});
