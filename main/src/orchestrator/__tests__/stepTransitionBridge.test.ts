/**
 * Unit tests for stepTransitionBridge (TASK-765 acceptance criteria).
 *
 * Test coverage (per test_strategy):
 *   (a) Happy-path emit fires with correct event shape.
 *   (b) DB current_step_id is updated before emit.
 *   (c) Emit happens AFTER the UPDATE (write-then-emit ordering).
 *   (d) Unknown workflow name → resolveInitialStepId returns null; no DB write/emit.
 *   (e) Missing workflow_runs row → logs warn, does NOT throw.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '../__test_fixtures__/orchestratorTestDb';
import { makeSpyLogger } from '../__test_fixtures__/loggerLikeSpy';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import {
  buildStepTransitionEvent,
  resolveInitialStepId,
} from '../stepTransitionBridge';
import type { WorkflowStepTransitionEvent, WorkflowDefinition } from '../../../../shared/types/workflows';
import { stepTransitionEvents } from '../trpc/routers/events';
import { CYBOFLOW_WORKFLOW_NAMES, WORKFLOW_DEFINITIONS } from '../../../../shared/types/workflows';

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
    expect(resolveInitialStepId('soloflow')).toBe('context');
    expect(resolveInitialStepId('planner')).toBe('context');
    expect(resolveInitialStepId('sprint')).toBe('implement');
    expect(resolveInitialStepId('compound')).toBe('load-sprint');
    expect(resolveInitialStepId('prune')).toBe('scan');
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

    const event = buildStepTransitionEvent(runId, 'implement', 'running', adapter, logger);

    expect(event).not.toBeNull();
    expect(event!.runId).toBe(runId);
    expect(event!.stepId).toBe('implement');
    expect(event!.status).toBe('running');
    expect(typeof event!.timestamp).toBe('string');

    // Emitter must have fired exactly once with the correct event.
    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0]).toMatchObject({
      runId,
      stepId: 'implement',
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

    buildStepTransitionEvent(runId, 'implement', 'running', adapter, logger);

    // The DB must have been updated BEFORE the event fired.
    expect(dbValueAtEmitTime).toBe('implement');
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
      callLog.push(row?.current_step_id === 'implement' ? 'db-written-before-emit' : 'db-not-written');
      callLog.push('emit-fired');
    });

    buildStepTransitionEvent(runId, 'implement', 'done', adapter);

    expect(callLog[0]).toBe('db-written-before-emit');
    expect(callLog[1]).toBe('emit-fired');
  });

  it('also fires with status=done on run completion', () => {
    const { db, runId } = seedForBridge('compound');
    const adapter = dbAdapter(db);

    buildStepTransitionEvent(runId, 'load-sprint', 'done', adapter);

    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0].status).toBe('done');
    expect(emittedEvents[0].stepId).toBe('load-sprint');

    // Verify DB was also updated.
    const row = db
      .prepare('SELECT current_step_id FROM workflow_runs WHERE id = ?')
      .get(runId) as { current_step_id: string | null } | undefined;
    expect(row?.current_step_id).toBe('load-sprint');
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
    // Custom sprint def that keeps only 'implement' — the built-in 'write-tests'
    // step has been removed by the edit and must now be rejected.
    const editedDef: WorkflowDefinition = {
      id: 'sprint',
      phases: [
        {
          id: 'execute',
          label: 'Execute',
          color: '#c96442',
          steps: [
            {
              id: 'implement',
              name: 'Implement task',
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
    expect(sprintFlatStepIds).toContain('write-tests');

    const { db, runId } = seedForBridge('sprint', JSON.stringify(editedDef));
    const adapter = dbAdapter(db);
    const logger = makeSpyLogger();

    const result = buildStepTransitionEvent(runId, 'write-tests', 'running', adapter, logger);

    expect(result).toBeNull();
    expect(emittedEvents).toHaveLength(0);

    const row = db
      .prepare('SELECT current_step_id FROM workflow_runs WHERE id = ?')
      .get(runId) as { current_step_id: string | null } | undefined;
    expect(row?.current_step_id).toBeNull();

    expect(logger.warn).toHaveBeenCalledOnce();
    expect((logger.warn as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('write-tests');
  });
});
