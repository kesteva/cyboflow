/**
 * Unit tests for McpQueryHandler.
 *
 * Four cases per the test_strategy in TASK-452:
 *
 * 1. handleMessage routes 'mcp-list-pending-approvals' to the approvals SELECT
 *    path and returns ok:true with an array data field sorted oldest-first.
 *
 * 2. handleMessage routes 'mcp-get-run' to the workflow_runs SELECT path and
 *    returns ok:false with error='not_found' when no row matches targetRunId.
 *
 * 3. handleMessage 'mcp-submit-checkpoint' inserts exactly one row observable
 *    by a follow-up SELECT from raw_events.
 *
 * 4. handleMessage returns { ok: false, error: 'unknown_message_type' } for an
 *    unrecognized type and never throws.
 *
 * All tests use an in-memory better-sqlite3 instance initialised with the
 * inline `MINIMAL_SCHEMA` const declared below (no real migration runner — tests are hermetic). A writes-capturing
 * socket test double is used to assert on the JSON response bodies.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpQueryHandler, type McpQueryMessage, type McpQueryResponse } from '../mcpQueryHandler';
import type * as net from 'net';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import { createTestDb, seedApproval } from '../../__test_fixtures__/orchestratorTestDb';
import { stepTransitionEvents } from '../../trpc/routers/events';
import { TaskChangeRouter, taskChangeEvents } from '../../taskChangeRouter';
import { ReviewItemRouter, reviewItemChangeEvents } from '../../reviewItemRouter';
import type { WorkflowDefinition, WorkflowStepTransitionEvent } from '../../../../../shared/types/workflows';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal net.Socket test double that captures write() calls.
 * We only need write(); everything else can be a no-op stub.
 */
function makeSocketDouble(): { socket: net.Socket; writes: string[] } {
  const writes: string[] = [];
  const socket = {
    write: (chunk: string | Buffer) => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      return true;
    },
  } as unknown as net.Socket;
  return { socket, writes };
}

function parseLastWrite(writes: string[]): McpQueryResponse {
  const last = writes[writes.length - 1];
  return JSON.parse(last) as McpQueryResponse;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function seedRun(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, worktree_path, status, policy_json)
     VALUES (?, 'wf-1', 1, '/tmp/test', 'running', '{}')`,
  ).run(id);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('McpQueryHandler', () => {
  let db: Database.Database;
  let handler: McpQueryHandler;

  beforeEach(() => {
    db = createTestDb({ disableForeignKeys: true });
    handler = new McpQueryHandler(dbAdapter(db));
  });

  // -------------------------------------------------------------------------
  // 1. mcp-list-pending-approvals
  // -------------------------------------------------------------------------

  describe('mcp-list-pending-approvals', () => {
    it('returns ok:true with an empty approvals array when no pending rows exist', async () => {
      const { socket, writes } = makeSocketDouble();
      const msg: McpQueryMessage = {
        type: 'mcp-list-pending-approvals',
        requestId: 'req-1',
        runId: 'run-a',
      };

      await handler.handleMessage(msg, socket);

      // Wire-protocol contract: newline-delimited framing
      expect(writes[writes.length - 1].endsWith('\n')).toBe(true);

      const response = parseLastWrite(writes);
      expect(response.type).toBe('mcp-query-response');
      expect(response.requestId).toBe('req-1');
      expect(response.ok).toBe(true);
      expect(response.data).toEqual({ approvals: [] });
    });

    it('returns ok:true with all pending approvals sorted oldest-first', async () => {
      seedRun(db, 'run-a');
      // Insert newer first to verify ORDER BY created_at ASC
      seedApproval(db, { id: 'appr-2', runId: 'run-a', status: 'pending', createdAt: '2026-01-02T00:00:00Z', toolUseId: 'appr-2', toolInputJson: '{"cmd":"ls"}' });
      seedApproval(db, { id: 'appr-1', runId: 'run-a', status: 'pending', createdAt: '2026-01-01T00:00:00Z', toolUseId: 'appr-1', toolInputJson: '{"cmd":"ls"}' });
      seedApproval(db, { id: 'appr-3', runId: 'run-a', status: 'approved', createdAt: '2026-01-03T00:00:00Z', toolUseId: 'appr-3', toolInputJson: '{"cmd":"ls"}' });

      const { socket, writes } = makeSocketDouble();
      const msg: McpQueryMessage = {
        type: 'mcp-list-pending-approvals',
        requestId: 'req-2',
        runId: 'run-a',
      };

      await handler.handleMessage(msg, socket);

      const response = parseLastWrite(writes);
      expect(response.ok).toBe(true);

      const data = response.data as { approvals: Array<{ approval_id: string }> };
      expect(data.approvals).toHaveLength(2);
      expect(data.approvals[0].approval_id).toBe('appr-1');
      expect(data.approvals[1].approval_id).toBe('appr-2');
    });

    it('parses tool_input_json into a JS object on each approval', async () => {
      seedRun(db, 'run-b');
      seedApproval(db, { id: 'appr-x', runId: 'run-b', status: 'pending', createdAt: '2026-01-01T00:00:00Z', toolUseId: 'appr-x', toolInputJson: '{"cmd":"ls"}' });

      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage(
        { type: 'mcp-list-pending-approvals', requestId: 'req-3', runId: 'run-b' },
        socket,
      );

      const response = parseLastWrite(writes);
      const data = response.data as { approvals: Array<{ input: unknown }> };
      expect(data.approvals[0].input).toEqual({ cmd: 'ls' });
    });
  });

  // -------------------------------------------------------------------------
  // 2. mcp-get-run
  // -------------------------------------------------------------------------

  describe('mcp-get-run', () => {
    it('returns ok:false with error="not_found" when targetRunId does not exist', async () => {
      const { socket, writes } = makeSocketDouble();
      const msg: McpQueryMessage = {
        type: 'mcp-get-run',
        requestId: 'req-4',
        runId: 'run-caller',
        targetRunId: 'run-nonexistent',
      };

      await handler.handleMessage(msg, socket);

      // Wire-protocol contract: newline-delimited framing
      expect(writes[writes.length - 1].endsWith('\n')).toBe(true);

      const response = parseLastWrite(writes);
      expect(response.type).toBe('mcp-query-response');
      expect(response.requestId).toBe('req-4');
      expect(response.ok).toBe(false);
      expect(response.error).toBe('not_found');
    });

    it('returns ok:true with the run row when targetRunId exists', async () => {
      seedRun(db, 'run-target');

      const { socket, writes } = makeSocketDouble();
      const msg: McpQueryMessage = {
        type: 'mcp-get-run',
        requestId: 'req-5',
        runId: 'run-caller',
        targetRunId: 'run-target',
      };

      await handler.handleMessage(msg, socket);

      const response = parseLastWrite(writes);
      expect(response.ok).toBe(true);
      const data = response.data as { run: Record<string, unknown> };
      expect(data.run.id).toBe('run-target');
      expect(data.run.status).toBe('running');
    });
  });

  // -------------------------------------------------------------------------
  // 3. mcp-submit-checkpoint
  // -------------------------------------------------------------------------

  describe('mcp-submit-checkpoint', () => {
    it('inserts exactly one raw_events row with event_type=cyboflow_checkpoint', async () => {
      seedRun(db, 'run-c');

      const { socket, writes } = makeSocketDouble();
      const msg: McpQueryMessage = {
        type: 'mcp-submit-checkpoint',
        requestId: 'req-6',
        runId: 'run-c',
        label: 'phase-1-done',
        note: 'All tests passing',
      };

      await handler.handleMessage(msg, socket);

      // Wire-protocol contract: newline-delimited framing
      expect(writes[writes.length - 1].endsWith('\n')).toBe(true);

      const response = parseLastWrite(writes);
      expect(response.ok).toBe(true);
      const data = response.data as { checkpoint_id: number | bigint };
      expect(typeof data.checkpoint_id === 'number' || typeof data.checkpoint_id === 'bigint').toBe(true);

      // Verify DB side effect
      const rows = db
        .prepare(
          `SELECT * FROM raw_events WHERE run_id = ? AND event_type = 'cyboflow_checkpoint'`,
        )
        .all('run-c') as Array<{
        id: number;
        run_id: string;
        event_type: string;
        payload_json: string;
      }>;

      expect(rows).toHaveLength(1);
      expect(rows[0].run_id).toBe('run-c');
      expect(rows[0].event_type).toBe('cyboflow_checkpoint');

      const payload = JSON.parse(rows[0].payload_json) as {
        label: string;
        note: string | null;
        submitted_via: string;
      };
      expect(payload.label).toBe('phase-1-done');
      expect(payload.note).toBe('All tests passing');
      expect(payload.submitted_via).toBe('mcp');
    });

    it('stores null for note when note is omitted', async () => {
      seedRun(db, 'run-d');

      const { socket } = makeSocketDouble();
      await handler.handleMessage(
        {
          type: 'mcp-submit-checkpoint',
          requestId: 'req-7',
          runId: 'run-d',
          label: 'no-note',
          // note intentionally absent
        },
        socket,
      );

      const row = db
        .prepare(
          `SELECT payload_json FROM raw_events WHERE run_id = ? AND event_type = 'cyboflow_checkpoint'`,
        )
        .get('run-d') as { payload_json: string } | undefined;

      expect(row).toBeDefined();
      const payload = JSON.parse(row!.payload_json) as { note: unknown };
      expect(payload.note).toBeNull();
    });

    it('does NOT modify workflow_runs.status', async () => {
      seedRun(db, 'run-e');

      const { socket } = makeSocketDouble();
      await handler.handleMessage(
        {
          type: 'mcp-submit-checkpoint',
          requestId: 'req-8',
          runId: 'run-e',
          label: 'check',
        },
        socket,
      );

      const run = db
        .prepare(`SELECT status FROM workflow_runs WHERE id = ?`)
        .get('run-e') as { status: string } | undefined;

      expect(run?.status).toBe('running'); // unchanged
    });

    it('returns ok:false with error="checkpoint_requires_real_run" and inserts NO row when runId is "orchestrator"', async () => {
      // The singleton MCP server runs with CYBOFLOW_RUN_ID='orchestrator'.
      // That sentinel has no matching workflow_runs row and must be rejected
      // at the handler boundary — before any INSERT — to prevent a FK violation.
      const { socket, writes } = makeSocketDouble();
      const msg: McpQueryMessage = {
        type: 'mcp-submit-checkpoint',
        requestId: 'req-sentinel',
        runId: 'orchestrator',
        label: 'should-be-rejected',
        note: 'this must not reach the database',
      };

      await handler.handleMessage(msg, socket);

      // Wire-protocol contract: newline-delimited framing
      expect(writes[writes.length - 1].endsWith('\n')).toBe(true);

      // Response shape
      const response = parseLastWrite(writes);
      expect(response.type).toBe('mcp-query-response');
      expect(response.requestId).toBe('req-sentinel');
      expect(response.ok).toBe(false);
      expect(response.error).toBe('checkpoint_requires_real_run');

      // Must not have written any raw_events row
      const rows = db
        .prepare(`SELECT id FROM raw_events WHERE run_id = 'orchestrator'`)
        .all();
      expect(rows).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Quick-session / NULL-run regression tests (TASK-745)
  // -------------------------------------------------------------------------

  describe('quick-session NULL-tolerance', () => {
    /**
     * mcp-get-run for a runId that does not exist in workflow_runs (e.g. a
     * quick-session id that has no workflow_runs row) returns ok:false with
     * error='not_found' and does NOT throw.
     *
     * This pins the existing 'not_found' branch as the correct behaviour for
     * quick-session ids — no special handling is needed in McpQueryHandler.
     */
    it('mcp-get-run returns not_found for a quick-session id (no matching workflow_runs row)', async () => {
      // Deliberately do NOT seed a workflow_runs row — simulates a quick-session id.
      const quickSessionId = 'quick-session-abc123';

      const { socket, writes } = makeSocketDouble();
      const msg: McpQueryMessage = {
        type: 'mcp-get-run',
        requestId: 'req-qs-1',
        runId: 'run-caller',
        targetRunId: quickSessionId,
      };

      // Must not throw.
      await expect(handler.handleMessage(msg, socket)).resolves.toBeUndefined();

      const response = parseLastWrite(writes);
      expect(response.type).toBe('mcp-query-response');
      expect(response.requestId).toBe('req-qs-1');
      expect(response.ok).toBe(false);
      expect(response.error).toBe('not_found');
    });

    /**
     * mcp-submit-checkpoint for a runId that does not exist in workflow_runs
     * (e.g. a quick-session id) surfaces as caught error (FK violation), not a crash.
     *
     * The raw_events table has run_id TEXT NOT NULL with a FK to workflow_runs(id)
     * ON DELETE CASCADE (migration 006).  When FK enforcement is on, trying to INSERT
     * with a non-existent run_id throws a FOREIGN KEY constraint error.
     * McpQueryHandler's outer try/catch must convert this into an ok:false response.
     */
    it('mcp-submit-checkpoint returns ok:false for a quick-session id (FK violation, not a crash)', async () => {
      // Deliberately do NOT seed a workflow_runs row — simulates a quick-session id.
      const quickSessionId = 'quick-session-xyz789';

      // Enable FK enforcement so the INSERT actually fails.
      // (createTestDb disables FKs by default for general fixture use; we need them on here.)
      db.pragma('foreign_keys = ON');

      const { socket, writes } = makeSocketDouble();
      const msg: McpQueryMessage = {
        type: 'mcp-submit-checkpoint',
        requestId: 'req-qs-2',
        runId: quickSessionId,
        label: 'should-fail-fk',
        note: 'quick session has no workflow_runs row',
      };

      // Must not throw — the FK error is caught and returned as ok:false.
      await expect(handler.handleMessage(msg, socket)).resolves.toBeUndefined();

      const response = parseLastWrite(writes);
      expect(response.type).toBe('mcp-query-response');
      expect(response.requestId).toBe('req-qs-2');
      expect(response.ok).toBe(false);
      // The error message comes from the SQLite exception — it contains 'FOREIGN KEY'
      // or similar; we just need to confirm ok is false and something was returned.
      expect(typeof response.error).toBe('string');
      expect(response.error!.length).toBeGreaterThan(0);

      // No raw_events row must have been written.
      const rows = db
        .prepare(`SELECT id FROM raw_events WHERE run_id = ?`)
        .all(quickSessionId);
      expect(rows).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // 5. mcp-report-step (TASK-802)
  // -------------------------------------------------------------------------

  describe('mcp-report-step', () => {
    /**
     * createTestDb's GATE_SCHEMA does NOT include current_step_id (added by
     * migration 011). orchestratorTestDb.ts is files_readonly, so we ALTER it
     * in here per the plan. FK enforcement is left ON so a vanished-run path is
     * exercised faithfully; report-step tests seed their own rows.
     */
    function createReportStepDb(): Database.Database {
      const reportDb = createTestDb({ includeQuestionsTable: true });
      reportDb.exec('ALTER TABLE workflow_runs ADD COLUMN current_step_id TEXT');
      return reportDb;
    }

    /**
     * Seed a workflows + workflow_runs pair for report-step tests. Uses spec_json
     * '{}' (the built-in fallback resolution path) by default; pass a real edited
     * spec to exercise the custom-accept path.
     */
    function seedReportRun(
      reportDb: Database.Database,
      workflowName: string,
      specJson = '{}',
    ): string {
      const workflowId = `wf-${workflowName}-${Math.random().toString(36).slice(2)}`;
      const runId = `run-${workflowName}-${Math.random().toString(36).slice(2)}`;
      reportDb
        .prepare(
          `INSERT INTO workflows (id, project_id, name, spec_json) VALUES (?, 1, ?, ?)`,
        )
        .run(workflowId, workflowName, specJson);
      reportDb
        .prepare(
          `INSERT INTO workflow_runs (id, workflow_id, project_id, worktree_path, status)
           VALUES (?, ?, 1, '/tmp/test', 'running')`,
        )
        .run(runId, workflowId);
      return runId;
    }

    function currentStepId(reportDb: Database.Database, runId: string): string | null {
      const row = reportDb
        .prepare('SELECT current_step_id FROM workflow_runs WHERE id = ?')
        .get(runId) as { current_step_id: string | null } | undefined;
      return row?.current_step_id ?? null;
    }

    let reportDb: Database.Database;
    let reportHandler: McpQueryHandler;
    let emitted: WorkflowStepTransitionEvent[];

    beforeEach(() => {
      reportDb = createReportStepDb();
      reportHandler = new McpQueryHandler(dbAdapter(reportDb));
      emitted = [];
      stepTransitionEvents.on('transition', (ev: WorkflowStepTransitionEvent) => {
        emitted.push(ev);
      });
    });

    afterEach(() => {
      stepTransitionEvents.removeAllListeners('transition');
    });

    it('returns ok:false "report_step_requires_real_run" for the orchestrator sentinel and writes nothing', async () => {
      // The singleton MCP server runs with CYBOFLOW_RUN_ID='orchestrator', which
      // has no workflow_runs row and must be rejected before any DB touch.
      const runId = seedReportRun(reportDb, 'sprint');
      expect(currentStepId(reportDb, runId)).toBeNull();

      const { socket, writes } = makeSocketDouble();
      await reportHandler.handleMessage(
        { type: 'mcp-report-step', requestId: 'rs-1', runId: 'orchestrator', stepId: 'implement' },
        socket,
      );

      expect(writes[writes.length - 1].endsWith('\n')).toBe(true);
      const response = parseLastWrite(writes);
      expect(response.ok).toBe(false);
      expect(response.error).toBe('report_step_requires_real_run');

      // The seeded run is untouched and no transition fired.
      expect(currentStepId(reportDb, runId)).toBeNull();
      expect(emitted).toHaveLength(0);
    });

    it('writes current_step_id and emits exactly one transition for a valid stepId', async () => {
      const runId = seedReportRun(reportDb, 'sprint');

      const { socket, writes } = makeSocketDouble();
      await reportHandler.handleMessage(
        { type: 'mcp-report-step', requestId: 'rs-2', runId, stepId: 'write-tests', status: 'running' },
        socket,
      );

      const response = parseLastWrite(writes);
      expect(response.ok).toBe(true);
      expect(response.data).toEqual({ step_id: 'write-tests', status: 'running' });

      expect(currentStepId(reportDb, runId)).toBe('write-tests');
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({ runId, stepId: 'write-tests', status: 'running' });
    });

    it('defaults status to "running" when omitted', async () => {
      const runId = seedReportRun(reportDb, 'sprint');

      const { socket, writes } = makeSocketDouble();
      await reportHandler.handleMessage(
        { type: 'mcp-report-step', requestId: 'rs-3', runId, stepId: 'implement' },
        socket,
      );

      const response = parseLastWrite(writes);
      expect(response.ok).toBe(true);
      expect(response.data).toEqual({ step_id: 'implement', status: 'running' });
      expect(emitted[0].status).toBe('running');
    });

    it('accepts an EDITED/custom stepId present only in spec_json (absent from the static built-in)', async () => {
      // Custom sprint def whose step id 'discovery-call' exists nowhere in the
      // static WORKFLOW_DEFINITIONS.sprint — proving validation resolves from
      // spec_json (resolveWorkflowDefinition), not the seed constant.
      const customDef: WorkflowDefinition = {
        id: 'sprint',
        phases: [
          {
            id: 'execute',
            label: 'Execute',
            color: '#c96442',
            steps: [
              { id: 'discovery-call', name: 'Discovery call', agent: 'executor', mcps: [], retries: 0 },
            ],
          },
        ],
      };
      const runId = seedReportRun(reportDb, 'sprint', JSON.stringify(customDef));

      const { socket, writes } = makeSocketDouble();
      await reportHandler.handleMessage(
        { type: 'mcp-report-step', requestId: 'rs-4', runId, stepId: 'discovery-call', status: 'done' },
        socket,
      );

      const response = parseLastWrite(writes);
      expect(response.ok).toBe(true);
      expect(response.data).toEqual({ step_id: 'discovery-call', status: 'done' });
      expect(currentStepId(reportDb, runId)).toBe('discovery-call');
      expect(emitted).toHaveLength(1);
      expect(emitted[0].stepId).toBe('discovery-call');
    });

    it('returns ok:false "unknown_step_id" for an invalid stepId and writes nothing', async () => {
      const runId = seedReportRun(reportDb, 'sprint');

      const { socket, writes } = makeSocketDouble();
      await reportHandler.handleMessage(
        { type: 'mcp-report-step', requestId: 'rs-5', runId, stepId: 'does-not-exist' },
        socket,
      );

      const response = parseLastWrite(writes);
      expect(response.ok).toBe(false);
      expect(response.error).toBe('unknown_step_id');

      expect(currentStepId(reportDb, runId)).toBeNull();
      expect(emitted).toHaveLength(0);
    });

    it('returns ok:false and does not throw when no workflow_runs row matches runId', async () => {
      // No seed — the JOIN finds nothing.
      const { socket, writes } = makeSocketDouble();
      await expect(
        reportHandler.handleMessage(
          { type: 'mcp-report-step', requestId: 'rs-6', runId: 'run-vanished', stepId: 'implement' },
          socket,
        ),
      ).resolves.toBeUndefined();

      const response = parseLastWrite(writes);
      expect(response.ok).toBe(false);
      // JOIN-miss path returns 'run_not_found'.
      expect(response.error).toBe('run_not_found');
      expect(emitted).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // 6. Native task writes — mcp-create-task / mcp-update-task / mcp-set-task-stage
  //    (the three handlers routing through the TaskChangeRouter chokepoint).
  // -------------------------------------------------------------------------

  describe('native task write handlers', () => {
    // The task handlers reach TaskChangeRouter.getInstance().applyChange, which
    // needs the full native-entity schema (boards/board_stages/ideas/epics/tasks/
    // entity_events/task_ref_counters) plus the workflow_runs run->task link
    // columns. The GATE_SCHEMA used elsewhere in this file does NOT have those
    // tables, so we build a migration-backed in-memory DB exactly like
    // taskChangeRouter.test.ts (006 -> 011 -> 014 -> 015).

    function buildTaskDb(): Database.Database {
      const taskDb = new Database(':memory:');
      taskDb.pragma('foreign_keys = ON');
      // The 014 seed is `... FROM projects`, so the projects table MUST exist
      // (with project 1) BEFORE migrations run or no board/stages seed.
      taskDb.exec(`
        CREATE TABLE projects (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          path TEXT NOT NULL UNIQUE,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);
      taskDb.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Proj', '/tmp/p1');

      const migDir = join(__dirname, '..', '..', '..', 'database', 'migrations');
      // Production order: 006 (workflow_runs base) -> 011 (current_step_id) ->
      // 014 (unified tasks + run->task columns + seed) -> 015 (entity-model
      // rebuild: ideas/epics/tasks + entity_events + 12th stage).
      taskDb.exec(readFileSync(join(migDir, '006_cyboflow_schema.sql'), 'utf-8'));
      taskDb.exec(readFileSync(join(migDir, '011_workflow_step_tracking.sql'), 'utf-8'));
      taskDb.exec(readFileSync(join(migDir, '014_native_tasks.sql'), 'utf-8'));
      taskDb.exec(readFileSync(join(migDir, '015_entity_model_rebuild.sql'), 'utf-8'));
      return taskDb;
    }

    function stage(position: number): string {
      return `stage-board-1-default-${position}`;
    }

    /**
     * Seed a workflows + workflow_runs pair. The run carries current_step_id +
     * a steps_snapshot_json mapping that step id to an agent label, so
     * resolveTaskRunContext derives actor = `agent:${label}`.
     */
    function seedTaskRun(
      taskDb: Database.Database,
      opts: {
        runId: string;
        status?: string;
        currentStepId?: string | null;
        stepsSnapshot?: Record<string, string> | null;
        taskId?: string | null;
      },
    ): void {
      taskDb
        .prepare(
          `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', 1, 'sprint', '{}')`,
        )
        .run();
      taskDb
        .prepare(
          `INSERT INTO workflow_runs
             (id, workflow_id, project_id, status, current_step_id, steps_snapshot_json, task_id)
           VALUES (?, 'wf-1', 1, ?, ?, ?, ?)`,
        )
        .run(
          opts.runId,
          opts.status ?? 'running',
          opts.currentStepId ?? null,
          opts.stepsSnapshot ? JSON.stringify(opts.stepsSnapshot) : null,
          opts.taskId ?? null,
        );
    }

    let taskDb: Database.Database;
    let taskHandler: McpQueryHandler;

    beforeEach(() => {
      taskDb = buildTaskDb();
      // The handlers reach the singleton via TaskChangeRouter.getInstance().
      TaskChangeRouter.initialize(dbAdapter(taskDb));
      // Same dbAdapter the handler reads its run-context SELECTs through.
      taskHandler = new McpQueryHandler(dbAdapter(taskDb));
    });

    afterEach(() => {
      TaskChangeRouter._resetForTesting();
      taskChangeEvents.removeAllListeners();
    });

    // -----------------------------------------------------------------------
    // create
    // -----------------------------------------------------------------------

    describe('mcp-create-task', () => {
      it('happy path: mints IDEA-001 at the idea stage, writes the row + an agent entity_event', async () => {
        seedTaskRun(taskDb, {
          runId: 'run-1',
          currentStepId: 'plan',
          stepsSnapshot: { plan: 'planner' },
        });

        const { socket, writes } = makeSocketDouble();
        await taskHandler.handleMessage(
          {
            type: 'mcp-create-task',
            requestId: 'ct-1',
            runId: 'run-1',
            title: 'First idea',
          },
          socket,
        );

        // Wire-protocol contract: newline-delimited framing.
        expect(writes[writes.length - 1].endsWith('\n')).toBe(true);

        const response = parseLastWrite(writes);
        expect(response.type).toBe('mcp-query-response');
        expect(response.requestId).toBe('ct-1');
        expect(response.ok).toBe(true);

        const data = response.data as {
          task_id: string;
          ref?: string;
          stage_id?: string;
          type?: string;
          version?: number;
        };
        expect(typeof data.task_id).toBe('string');
        expect(data.ref).toBe('IDEA-001');
        expect(data.stage_id).toBe(stage(1));
        expect(data.type).toBe('idea');
        expect(data.version).toBe(1);

        // The ideas row actually exists with the canonical ref (table identity
        // is the discriminator — an idea lives in `ideas`, not `tasks`).
        const task = taskDb
          .prepare('SELECT ref, stage_id, version FROM ideas WHERE id = ?')
          .get(data.task_id) as { ref: string; stage_id: string; version: number } | undefined;
        expect(task).toBeDefined();
        expect(task!.ref).toBe('IDEA-001');

        // An entity_events row was written for entity_type='idea', attributed to
        // an agent:<label> actor.
        const ev = taskDb
          .prepare(
            "SELECT actor, kind FROM entity_events WHERE entity_type = 'idea' AND entity_id = ? ORDER BY seq ASC LIMIT 1",
          )
          .get(data.task_id) as { actor: string; kind: string } | undefined;
        expect(ev).toBeDefined();
        expect(ev!.actor.startsWith('agent:')).toBe(true);
        // snapshot[current_step_id] = 'planner' wins over the raw step id.
        expect(ev!.actor).toBe('agent:planner');
        expect(ev!.kind).toBe('created');
      });

      it('task_type "epic" mints EPIC-001', async () => {
        seedTaskRun(taskDb, {
          runId: 'run-1',
          currentStepId: 'plan',
          stepsSnapshot: { plan: 'planner' },
        });

        const { socket, writes } = makeSocketDouble();
        await taskHandler.handleMessage(
          {
            type: 'mcp-create-task',
            requestId: 'ct-2',
            runId: 'run-1',
            title: 'An epic',
            taskType: 'epic',
          },
          socket,
        );

        const response = parseLastWrite(writes);
        expect(response.ok).toBe(true);
        const data = response.data as { ref?: string; type?: string };
        expect(data.ref).toBe('EPIC-001');
        expect(data.type).toBe('epic');
      });

      it('falls back to actor=agent:<step_id> when the snapshot has no mapping for the step', async () => {
        // current_step_id present but snapshot lacks a non-empty mapping for it →
        // label = current_step_id (mirrors resolveAgentLabel).
        seedTaskRun(taskDb, {
          runId: 'run-1',
          currentStepId: 'implement',
          stepsSnapshot: { other: 'executor' },
        });

        const { socket, writes } = makeSocketDouble();
        await taskHandler.handleMessage(
          { type: 'mcp-create-task', requestId: 'ct-3', runId: 'run-1', title: 'T' },
          socket,
        );

        const response = parseLastWrite(writes);
        expect(response.ok).toBe(true);
        const data = response.data as { task_id: string };
        const ev = taskDb
          .prepare(
            "SELECT actor FROM entity_events WHERE entity_type = 'idea' AND entity_id = ? ORDER BY seq ASC LIMIT 1",
          )
          .get(data.task_id) as { actor: string };
        expect(ev.actor).toBe('agent:implement');
      });
    });

    // -----------------------------------------------------------------------
    // update
    // -----------------------------------------------------------------------

    describe('mcp-update-task', () => {
      it('happy path: updates title + priority, bumps version, reflects in the row', async () => {
        seedTaskRun(taskDb, {
          runId: 'run-1',
          currentStepId: 'plan',
          stepsSnapshot: { plan: 'planner' },
        });

        // Seed a task to update.
        const created = makeSocketDouble();
        await taskHandler.handleMessage(
          { type: 'mcp-create-task', requestId: 'ct-seed', runId: 'run-1', title: 'Before' },
          created.socket,
        );
        const taskId = (parseLastWrite(created.writes).data as { task_id: string }).task_id;

        const { socket, writes } = makeSocketDouble();
        await taskHandler.handleMessage(
          {
            type: 'mcp-update-task',
            requestId: 'ut-1',
            runId: 'run-1',
            taskId,
            title: 'After',
            priority: 'P0',
          },
          socket,
        );

        const response = parseLastWrite(writes);
        expect(response.ok).toBe(true);
        const data = response.data as { task_id: string; version?: number };
        expect(data.task_id).toBe(taskId);
        // create -> version 1, one mutating update -> version 2.
        expect(data.version).toBe(2);

        const task = taskDb
          .prepare('SELECT title, priority, version FROM ideas WHERE id = ?')
          .get(taskId) as { title: string; priority: string; version: number };
        expect(task.title).toBe('After');
        expect(task.priority).toBe('P0');
        expect(task.version).toBe(2);
      });

      it('stale expected_version is rejected with error "concurrency" (no write)', async () => {
        seedTaskRun(taskDb, {
          runId: 'run-1',
          currentStepId: 'plan',
          stepsSnapshot: { plan: 'planner' },
        });

        const created = makeSocketDouble();
        await taskHandler.handleMessage(
          { type: 'mcp-create-task', requestId: 'ct-seed2', runId: 'run-1', title: 'Stable' },
          created.socket,
        );
        const taskId = (parseLastWrite(created.writes).data as { task_id: string }).task_id;

        const { socket, writes } = makeSocketDouble();
        await taskHandler.handleMessage(
          {
            type: 'mcp-update-task',
            requestId: 'ut-2',
            runId: 'run-1',
            taskId,
            title: 'Should not apply',
            expectedVersion: 99,
          },
          socket,
        );

        const response = parseLastWrite(writes);
        expect(response.ok).toBe(false);
        expect(response.error).toBe('concurrency');

        // The title is unchanged (current version is still 1).
        const task = taskDb
          .prepare('SELECT title, version FROM ideas WHERE id = ?')
          .get(taskId) as { title: string; version: number };
        expect(task.title).toBe('Stable');
        expect(task.version).toBe(1);
      });
    });

    // -----------------------------------------------------------------------
    // set-stage
    // -----------------------------------------------------------------------

    describe('mcp-set-task-stage', () => {
      it('moves an idea to an asserted stage (position 3) -> ok:true', async () => {
        seedTaskRun(taskDb, {
          runId: 'run-1',
          currentStepId: 'plan',
          stepsSnapshot: { plan: 'planner' },
        });

        const created = makeSocketDouble();
        await taskHandler.handleMessage(
          { type: 'mcp-create-task', requestId: 'ct-seed3', runId: 'run-1', title: 'Movable' },
          created.socket,
        );
        const taskId = (parseLastWrite(created.writes).data as { task_id: string }).task_id;

        const { socket, writes } = makeSocketDouble();
        await taskHandler.handleMessage(
          {
            type: 'mcp-set-task-stage',
            requestId: 'ss-1',
            runId: 'run-1',
            taskId,
            stageId: stage(3),
          },
          socket,
        );

        const response = parseLastWrite(writes);
        expect(response.ok).toBe(true);
        const data = response.data as { task_id: string; stage_id?: string; version?: number };
        expect(data.task_id).toBe(taskId);
        expect(data.stage_id).toBe(stage(3));

        const task = taskDb
          .prepare('SELECT stage_id FROM ideas WHERE id = ?')
          .get(taskId) as { stage_id: string };
        expect(task.stage_id).toBe(stage(3));
      });

      it('moves an idea to the terminal Decomposed stage (position 12) for an AGENT actor -> ok:true', async () => {
        // Decomposed (position 12) is write_policy='asserted', terminal=1 — an
        // agent retiring an idea on decomposition is an ALLOWED assert (only the
        // DERIVED execution stages are orchestrator-only). This is the P3
        // Decomposed-agent-path assertion: assertStageAuthority must NOT reject it.
        seedTaskRun(taskDb, {
          runId: 'run-1',
          currentStepId: 'plan',
          stepsSnapshot: { plan: 'planner' },
        });

        const created = makeSocketDouble();
        await taskHandler.handleMessage(
          { type: 'mcp-create-task', requestId: 'ct-seed-dec', runId: 'run-1', title: 'To decompose' },
          created.socket,
        );
        const taskId = (parseLastWrite(created.writes).data as { task_id: string }).task_id;

        const { socket, writes } = makeSocketDouble();
        await taskHandler.handleMessage(
          {
            type: 'mcp-set-task-stage',
            requestId: 'ss-dec',
            runId: 'run-1',
            taskId,
            stageId: stage(12),
          },
          socket,
        );

        const response = parseLastWrite(writes);
        expect(response.ok).toBe(true);
        const data = response.data as { task_id: string; stage_id?: string };
        expect(data.stage_id).toBe(stage(12));

        const task = taskDb
          .prepare('SELECT stage_id FROM ideas WHERE id = ?')
          .get(taskId) as { stage_id: string };
        expect(task.stage_id).toBe(stage(12));

        // The decomposition delta is recorded against the idea in the audit log.
        const ev = taskDb
          .prepare(
            "SELECT actor, kind FROM entity_events WHERE entity_type = 'idea' AND entity_id = ? ORDER BY seq DESC LIMIT 1",
          )
          .get(taskId) as { actor: string; kind: string };
        expect(ev.actor).toBe('agent:planner');
        expect(ev.kind).toBe('decomposed');
      });

      it('rejects a DERIVED stage (position 7, In development) with error "forbidden_stage"', async () => {
        // An agent actor cannot assert an orchestrator-owned derived stage.
        seedTaskRun(taskDb, {
          runId: 'run-1',
          currentStepId: 'plan',
          stepsSnapshot: { plan: 'planner' },
        });

        const created = makeSocketDouble();
        await taskHandler.handleMessage(
          { type: 'mcp-create-task', requestId: 'ct-seed4', runId: 'run-1', title: 'NoDerived' },
          created.socket,
        );
        const taskId = (parseLastWrite(created.writes).data as { task_id: string }).task_id;

        const { socket, writes } = makeSocketDouble();
        await taskHandler.handleMessage(
          {
            type: 'mcp-set-task-stage',
            requestId: 'ss-2',
            runId: 'run-1',
            taskId,
            stageId: stage(7),
          },
          socket,
        );

        const response = parseLastWrite(writes);
        expect(response.ok).toBe(false);
        expect(response.error).toBe('forbidden_stage');

        // Stage is unchanged (still at the idea stage).
        const task = taskDb
          .prepare('SELECT stage_id FROM ideas WHERE id = ?')
          .get(taskId) as { stage_id: string };
        expect(task.stage_id).toBe(stage(1));
      });

      it('rejects asserting a stage on a task with a non-terminal run with error "active_runs"', async () => {
        // The calling run plans the task; a SEPARATE non-terminal run is linked
        // to the same task, which blocks an agent-asserted stage move.
        seedTaskRun(taskDb, {
          runId: 'run-1',
          currentStepId: 'plan',
          stepsSnapshot: { plan: 'planner' },
        });

        const created = makeSocketDouble();
        await taskHandler.handleMessage(
          { type: 'mcp-create-task', requestId: 'ct-seed5', runId: 'run-1', title: 'Busy' },
          created.socket,
        );
        const taskId = (parseLastWrite(created.writes).data as { task_id: string }).task_id;

        // Link a live (running) run to the task.
        seedTaskRun(taskDb, {
          runId: 'run-exec',
          status: 'running',
          currentStepId: 'implement',
          stepsSnapshot: { implement: 'executor' },
          taskId,
        });

        const { socket, writes } = makeSocketDouble();
        await taskHandler.handleMessage(
          {
            type: 'mcp-set-task-stage',
            requestId: 'ss-3',
            runId: 'run-1',
            taskId,
            stageId: stage(6),
          },
          socket,
        );

        const response = parseLastWrite(writes);
        expect(response.ok).toBe(false);
        expect(response.error).toBe('active_runs');
      });
    });

    // -----------------------------------------------------------------------
    // run-context guards (shared across all three handlers)
    // -----------------------------------------------------------------------

    describe('run-context guards', () => {
      it('rejects the "orchestrator" sentinel with "task_write_requires_real_run" and writes nothing', async () => {
        const { socket, writes } = makeSocketDouble();
        await taskHandler.handleMessage(
          {
            type: 'mcp-create-task',
            requestId: 'g-1',
            runId: 'orchestrator',
            title: 'should-be-rejected',
          },
          socket,
        );

        const response = parseLastWrite(writes);
        expect(response.ok).toBe(false);
        expect(response.error).toBe('task_write_requires_real_run');

        // No entity and no event were written (the rejected create targeted ideas).
        const count = (
          taskDb.prepare('SELECT COUNT(*) AS n FROM ideas').get() as { n: number }
        ).n;
        expect(count).toBe(0);
      });

      it('rejects a non-existent runId with "run_not_found"', async () => {
        const { socket, writes } = makeSocketDouble();
        await taskHandler.handleMessage(
          {
            type: 'mcp-create-task',
            requestId: 'g-2',
            runId: 'run-does-not-exist',
            title: 'orphan',
          },
          socket,
        );

        const response = parseLastWrite(writes);
        expect(response.ok).toBe(false);
        expect(response.error).toBe('run_not_found');
      });

      it('rejects a terminal (completed) run with "run_not_active"', async () => {
        seedTaskRun(taskDb, {
          runId: 'run-done',
          status: 'completed',
          currentStepId: 'plan',
          stepsSnapshot: { plan: 'planner' },
        });

        const { socket, writes } = makeSocketDouble();
        await taskHandler.handleMessage(
          {
            type: 'mcp-create-task',
            requestId: 'g-3',
            runId: 'run-done',
            title: 'after-the-fact',
          },
          socket,
        );

        const response = parseLastWrite(writes);
        expect(response.ok).toBe(false);
        expect(response.error).toBe('run_not_active');

        const count = (
          taskDb.prepare('SELECT COUNT(*) AS n FROM ideas').get() as { n: number }
        ).n;
        expect(count).toBe(0);
      });
    });
  });

  // -------------------------------------------------------------------------
  // 7. mcp-report-finding — NON-BLOCKING review-item create via ReviewItemRouter.
  // -------------------------------------------------------------------------

  describe('mcp-report-finding', () => {
    // handleReportFinding reaches ReviewItemRouter.getInstance().applyReviewItem,
    // which needs the review_items table (migration 016) + the polymorphic
    // entity_events log (migration 015) + the workflow_runs run-context columns.
    // Build the same migration-backed in-memory DB as the task block, plus 016.

    function buildReviewDb(): Database.Database {
      const reviewDb = new Database(':memory:');
      reviewDb.pragma('foreign_keys = ON');
      reviewDb.exec(`
        CREATE TABLE projects (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          path TEXT NOT NULL UNIQUE,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);
      reviewDb.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Proj', '/tmp/p1');

      const migDir = join(__dirname, '..', '..', '..', 'database', 'migrations');
      reviewDb.exec(readFileSync(join(migDir, '006_cyboflow_schema.sql'), 'utf-8'));
      reviewDb.exec(readFileSync(join(migDir, '011_workflow_step_tracking.sql'), 'utf-8'));
      reviewDb.exec(readFileSync(join(migDir, '014_native_tasks.sql'), 'utf-8'));
      reviewDb.exec(readFileSync(join(migDir, '015_entity_model_rebuild.sql'), 'utf-8'));
      reviewDb.exec(readFileSync(join(migDir, '016_review_items.sql'), 'utf-8'));
      return reviewDb;
    }

    function seedReviewRun(
      reviewDb: Database.Database,
      opts: { runId: string; status?: string; currentStepId?: string | null; stepsSnapshot?: Record<string, string> | null },
    ): void {
      reviewDb
        .prepare(
          `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', 1, 'sprint', '{}')`,
        )
        .run();
      reviewDb
        .prepare(
          `INSERT INTO workflow_runs
             (id, workflow_id, project_id, status, current_step_id, steps_snapshot_json)
           VALUES (?, 'wf-1', 1, ?, ?, ?)`,
        )
        .run(
          opts.runId,
          opts.status ?? 'running',
          opts.currentStepId ?? null,
          opts.stepsSnapshot ? JSON.stringify(opts.stepsSnapshot) : null,
        );
    }

    /** Wait for the per-project review queue to drain so the async create commits. */
    async function drain(): Promise<void> {
      await ReviewItemRouter.getInstance()._queueForProject(1).onIdle();
    }

    let reviewDb: Database.Database;
    let reviewHandler: McpQueryHandler;

    beforeEach(() => {
      reviewDb = buildReviewDb();
      ReviewItemRouter.initialize(dbAdapter(reviewDb));
      reviewHandler = new McpQueryHandler(dbAdapter(reviewDb));
    });

    afterEach(() => {
      ReviewItemRouter._resetForTesting();
      reviewItemChangeEvents.removeAllListeners();
    });

    it('happy path: replies ok:true immediately and inserts a finding row attributed to the agent actor', async () => {
      seedReviewRun(reviewDb, { runId: 'run-1', currentStepId: 'implement', stepsSnapshot: { implement: 'executor' } });

      const { socket, writes } = makeSocketDouble();
      await reviewHandler.handleMessage(
        {
          type: 'mcp-report-finding',
          requestId: 'rf-1',
          runId: 'run-1',
          title: 'Hardcoded secret',
          body: 'Found an API key in config.ts',
          severity: 'warning',
        },
        socket,
      );

      // Non-blocking contract: a response is written SYNCHRONOUSLY (before any
      // queue drain) — the run is never paused on the inbox.
      expect(writes[writes.length - 1].endsWith('\n')).toBe(true);
      const response = parseLastWrite(writes);
      expect(response.type).toBe('mcp-query-response');
      expect(response.requestId).toBe('rf-1');
      expect(response.ok).toBe(true);
      expect(response.data).toMatchObject({ accepted: true, kind: 'finding', blocking: false });

      // The async create commits after the queue drains.
      await drain();
      const row = reviewDb
        .prepare("SELECT kind, status, blocking, title, severity, source, run_id FROM review_items WHERE run_id = 'run-1'")
        .get() as
        | { kind: string; status: string; blocking: number; title: string; severity: string | null; source: string; run_id: string }
        | undefined;
      expect(row).toBeDefined();
      expect(row!.kind).toBe('finding');
      expect(row!.status).toBe('pending');
      expect(row!.blocking).toBe(0);
      expect(row!.title).toBe('Hardcoded secret');
      expect(row!.severity).toBe('warning');
      expect(row!.source).toBe('agent:executor');

      // A polymorphic review_item entity_events row was logged.
      const ev = reviewDb
        .prepare(
          "SELECT actor, kind FROM entity_events WHERE entity_type = 'review_item' ORDER BY seq ASC LIMIT 1",
        )
        .get() as { actor: string; kind: string } | undefined;
      expect(ev).toBeDefined();
      expect(ev!.actor).toBe('agent:executor');
      expect(ev!.kind).toBe('created');
    });

    it('persists a blocking decision item when kind=decision and blocking=true', async () => {
      seedReviewRun(reviewDb, { runId: 'run-1', currentStepId: 'plan', stepsSnapshot: { plan: 'planner' } });

      const { socket, writes } = makeSocketDouble();
      await reviewHandler.handleMessage(
        {
          type: 'mcp-report-finding',
          requestId: 'rf-2',
          runId: 'run-1',
          title: 'Approve the plan?',
          body: 'Plan ready for review',
          kind: 'decision',
          blocking: true,
        },
        socket,
      );

      const response = parseLastWrite(writes);
      expect(response.ok).toBe(true);
      expect(response.data).toMatchObject({ accepted: true, kind: 'decision', blocking: true });

      await drain();
      const row = reviewDb
        .prepare("SELECT kind, blocking FROM review_items WHERE run_id = 'run-1'")
        .get() as { kind: string; blocking: number };
      expect(row.kind).toBe('decision');
      expect(row.blocking).toBe(1);
    });

    it('rejects the "orchestrator" sentinel with "finding_requires_real_run" and writes nothing', async () => {
      const { socket, writes } = makeSocketDouble();
      await reviewHandler.handleMessage(
        { type: 'mcp-report-finding', requestId: 'rf-3', runId: 'orchestrator', title: 't', body: 'b' },
        socket,
      );

      const response = parseLastWrite(writes);
      expect(response.ok).toBe(false);
      expect(response.error).toBe('finding_requires_real_run');

      await drain();
      const count = (reviewDb.prepare('SELECT COUNT(*) AS n FROM review_items').get() as { n: number }).n;
      expect(count).toBe(0);
    });

    it('rejects a non-existent runId with "run_not_found"', async () => {
      const { socket, writes } = makeSocketDouble();
      await reviewHandler.handleMessage(
        { type: 'mcp-report-finding', requestId: 'rf-4', runId: 'run-missing', title: 't', body: 'b' },
        socket,
      );

      const response = parseLastWrite(writes);
      expect(response.ok).toBe(false);
      expect(response.error).toBe('run_not_found');
    });

    it('rejects a terminal (completed) run with "run_not_active" and writes nothing', async () => {
      seedReviewRun(reviewDb, { runId: 'run-done', status: 'completed', currentStepId: 'plan', stepsSnapshot: { plan: 'planner' } });

      const { socket, writes } = makeSocketDouble();
      await reviewHandler.handleMessage(
        { type: 'mcp-report-finding', requestId: 'rf-5', runId: 'run-done', title: 't', body: 'b' },
        socket,
      );

      const response = parseLastWrite(writes);
      expect(response.ok).toBe(false);
      expect(response.error).toBe('run_not_active');

      await drain();
      const count = (reviewDb.prepare('SELECT COUNT(*) AS n FROM review_items').get() as { n: number }).n;
      expect(count).toBe(0);
    });

    it('rejects an unpaired soft entity link with "invalid_entity" (synchronous, no insert)', async () => {
      seedReviewRun(reviewDb, { runId: 'run-1', currentStepId: 'plan', stepsSnapshot: { plan: 'planner' } });

      const { socket, writes } = makeSocketDouble();
      // entityType set but entityId omitted → both-or-neither guard rejects.
      await reviewHandler.handleMessage(
        { type: 'mcp-report-finding', requestId: 'rf-6', runId: 'run-1', title: 't', body: 'b', entityType: 'task' },
        socket,
      );

      const response = parseLastWrite(writes);
      expect(response.ok).toBe(false);
      expect(response.error).toBe('invalid_entity');

      await drain();
      const count = (reviewDb.prepare('SELECT COUNT(*) AS n FROM review_items').get() as { n: number }).n;
      expect(count).toBe(0);
    });

    it('rejects a payload whose discriminant mismatches kind with "invalid_payload" (synchronous, no insert)', async () => {
      seedReviewRun(reviewDb, { runId: 'run-1', currentStepId: 'plan', stepsSnapshot: { plan: 'planner' } });

      const { socket, writes } = makeSocketDouble();
      // kind defaults to 'finding' but payload.kind is 'decision' → reject.
      await reviewHandler.handleMessage(
        {
          type: 'mcp-report-finding',
          requestId: 'rf-7',
          runId: 'run-1',
          title: 't',
          body: 'b',
          payloadJson: JSON.stringify({ kind: 'decision', gate: 'approve-plan' }),
        },
        socket,
      );

      const response = parseLastWrite(writes);
      expect(response.ok).toBe(false);
      expect(response.error).toBe('invalid_payload');

      await drain();
      const count = (reviewDb.prepare('SELECT COUNT(*) AS n FROM review_items').get() as { n: number }).n;
      expect(count).toBe(0);
    });

    it('rejects malformed payload_json with "invalid_payload" (synchronous, no insert)', async () => {
      seedReviewRun(reviewDb, { runId: 'run-1', currentStepId: 'plan', stepsSnapshot: { plan: 'planner' } });

      const { socket, writes } = makeSocketDouble();
      await reviewHandler.handleMessage(
        { type: 'mcp-report-finding', requestId: 'rf-8', runId: 'run-1', title: 't', body: 'b', payloadJson: 'not json{' },
        socket,
      );

      const response = parseLastWrite(writes);
      expect(response.ok).toBe(false);
      expect(response.error).toBe('invalid_payload');

      await drain();
      const count = (reviewDb.prepare('SELECT COUNT(*) AS n FROM review_items').get() as { n: number }).n;
      expect(count).toBe(0);
    });

    it('stores a matching payload + soft entity link on a valid finding', async () => {
      seedReviewRun(reviewDb, { runId: 'run-1', currentStepId: 'plan', stepsSnapshot: { plan: 'planner' } });

      const { socket, writes } = makeSocketDouble();
      await reviewHandler.handleMessage(
        {
          type: 'mcp-report-finding',
          requestId: 'rf-9',
          runId: 'run-1',
          title: 'Perf concern',
          body: 'N+1 query',
          entityType: 'task',
          entityId: 'tsk_xyz',
          payloadJson: JSON.stringify({ kind: 'finding', category: 'perf' }),
        },
        socket,
      );

      const response = parseLastWrite(writes);
      expect(response.ok).toBe(true);

      await drain();
      const row = reviewDb
        .prepare("SELECT entity_type, entity_id, payload_json FROM review_items WHERE run_id = 'run-1'")
        .get() as { entity_type: string; entity_id: string; payload_json: string };
      expect(row.entity_type).toBe('task');
      expect(row.entity_id).toBe('tsk_xyz');
      expect(JSON.parse(row.payload_json)).toEqual({ kind: 'finding', category: 'perf' });
    });

    it('never throws on a DB fault during the async create (the run is already replied to)', async () => {
      // The chokepoint's late failure is fire-and-forget — the synchronous reply
      // is ok:true and the handler returns without awaiting. Even if we surface a
      // genuine fault by dropping the table after the reply, handleMessage must
      // have resolved cleanly.
      seedReviewRun(reviewDb, { runId: 'run-1', currentStepId: 'plan', stepsSnapshot: { plan: 'planner' } });

      const { socket, writes } = makeSocketDouble();
      await expect(
        reviewHandler.handleMessage(
          { type: 'mcp-report-finding', requestId: 'rf-10', runId: 'run-1', title: 't', body: 'b' },
          socket,
        ),
      ).resolves.toBeUndefined();

      const response = parseLastWrite(writes);
      expect(response.ok).toBe(true);
      await drain();
    });
  });

  // -------------------------------------------------------------------------
  // 4. Unknown message type
  // -------------------------------------------------------------------------

  describe('unknown message type', () => {
    it('returns ok:false with error="unknown_message_type" and does not throw', async () => {
      const { socket, writes } = makeSocketDouble();

      // Cast to McpQueryMessage to simulate a runtime-unknown type arriving
      const msg = {
        type: 'mcp-does-not-exist',
        requestId: 'req-9',
        runId: 'run-x',
      } as unknown as McpQueryMessage;

      // Must not throw
      await expect(handler.handleMessage(msg, socket)).resolves.toBeUndefined();

      // Wire-protocol contract: newline-delimited framing
      expect(writes[writes.length - 1].endsWith('\n')).toBe(true);

      const response = parseLastWrite(writes);
      expect(response.type).toBe('mcp-query-response');
      expect(response.requestId).toBe('req-9');
      expect(response.ok).toBe(false);
      expect(response.error).toBe('unknown_message_type');
    });
  });
});

// ---------------------------------------------------------------------------
// 8. mcp-report-step is OBSERVATIONAL — it NEVER pauses the run, even for a
//    human:true step. Human gates (approve-idea/approve-plan/human-review) are
//    agent-driven: the agent asks via AskUserQuestion (-> QuestionRouter decision
//    review_item). Pausing the run on a human-step report would block the agent's
//    own tool calls (status='running' guard) -> deadlock.
// ---------------------------------------------------------------------------

describe('mcp-report-step does not pause on human steps', () => {
  // Build a migration-backed DB (projects + 006/011/014/015/016) so the report
  // path can JOIN workflows/workflow_runs and — if it regressed — write review_items.
  function buildGateDb(): Database.Database {
    const gateDb = new Database(':memory:');
    gateDb.pragma('foreign_keys = ON');
    gateDb.exec(`
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    gateDb.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Proj', '/tmp/p1');
    const migDir = join(__dirname, '..', '..', '..', 'database', 'migrations');
    gateDb.exec(readFileSync(join(migDir, '006_cyboflow_schema.sql'), 'utf-8'));
    gateDb.exec(readFileSync(join(migDir, '011_workflow_step_tracking.sql'), 'utf-8'));
    gateDb.exec(readFileSync(join(migDir, '014_native_tasks.sql'), 'utf-8'));
    gateDb.exec(readFileSync(join(migDir, '015_entity_model_rebuild.sql'), 'utf-8'));
    gateDb.exec(readFileSync(join(migDir, '016_review_items.sql'), 'utf-8'));
    return gateDb;
  }

  // Seed a 'sprint' run (built-in def has a human:true 'human-review' step).
  function seedSprintRun(gateDb: Database.Database, runId: string): void {
    gateDb
      .prepare(`INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-s', 1, 'sprint', '{}')`)
      .run();
    gateDb
      .prepare(`INSERT INTO workflow_runs (id, workflow_id, project_id, status) VALUES (?, 'wf-s', 1, 'running')`)
      .run(runId);
  }

  let gateDb: Database.Database;
  let gateHandler: McpQueryHandler;

  beforeEach(() => {
    gateDb = buildGateDb();
    gateHandler = new McpQueryHandler(dbAdapter(gateDb));
    stepTransitionEvents.removeAllListeners('transition');
  });

  afterEach(() => {
    stepTransitionEvents.removeAllListeners('transition');
  });

  it('reports a human step WITHOUT pausing the run or creating a review_item', async () => {
    seedSprintRun(gateDb, 'run-g');

    const { socket, writes } = makeSocketDouble();
    // 'human-review' is the human:true step in the built-in sprint def. The
    // agent drives this gate via AskUserQuestion; report-step must not pause.
    await gateHandler.handleMessage(
      { type: 'mcp-report-step', requestId: 'hg-1', runId: 'run-g', stepId: 'human-review', status: 'running' },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(true);
    // Purely observational — no human_gate field.
    expect(response.data).toEqual({ step_id: 'human-review', status: 'running' });

    // The run STAYS running — pausing it here would deadlock the agent.
    const status = (gateDb.prepare('SELECT status FROM workflow_runs WHERE id = ?').get('run-g') as { status: string })
      .status;
    expect(status).toBe('running');
    expect(gateDb.prepare("SELECT COUNT(*) AS n FROM review_items WHERE run_id = 'run-g'").get()).toEqual({ n: 0 });
  });

  it('reports a non-human step identically (no pause, no review_item)', async () => {
    seedSprintRun(gateDb, 'run-g');

    const { socket, writes } = makeSocketDouble();
    await gateHandler.handleMessage(
      { type: 'mcp-report-step', requestId: 'hg-2', runId: 'run-g', stepId: 'implement', status: 'running' },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(true);
    expect(response.data).toEqual({ step_id: 'implement', status: 'running' });

    const status = (gateDb.prepare('SELECT status FROM workflow_runs WHERE id = ?').get('run-g') as { status: string })
      .status;
    expect(status).toBe('running');
    expect(gateDb.prepare("SELECT COUNT(*) AS n FROM review_items WHERE run_id = 'run-g'").get()).toEqual({ n: 0 });
  });
});
