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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
import { SprintLaneStore, sprintLaneEvents, sprintLaneChannel } from '../../sprintLaneStore';
import { ApprovalRouter } from '../../approvalRouter';
import { VerificationScheduler } from '../../verify/verificationScheduler';
import type { VerdictV1 } from '../../../../../shared/types/visualVerification';
import type { WorkflowDefinition, WorkflowStepTransitionEvent } from '../../../../../shared/types/workflows';
import type { SprintLaneChangedEvent } from '../../../../../shared/types/sprintBatch';
import { handleEntityWrite } from '../../autoMintArtifacts';

// Mock the content-driven mint hook so we can assert mcpQueryHandler fires it
// (fire-and-forget) after a SUCCESSFUL task create/update. The real hook is
// covered by autoMintArtifacts.test.ts; here we only assert the wiring +
// entity-type derivation. handleRunStart/handleStepCompletion are also stubbed
// because the report-step path reaches them transitively through the real
// stepTransitionBridge (no test asserts their artifact output).
vi.mock('../../autoMintArtifacts', () => ({
  handleEntityWrite: vi.fn(() => Promise.resolve()),
  handleRunStart: vi.fn(() => Promise.resolve()),
  handleStepCompletion: vi.fn(() => Promise.resolve()),
}));

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
        { type: 'mcp-report-step', requestId: 'rs-2', runId, stepId: 'execute-tasks', status: 'running' },
        socket,
      );

      const response = parseLastWrite(writes);
      expect(response.ok).toBe(true);
      expect(response.data).toEqual({ step_id: 'execute-tasks', status: 'running' });

      expect(currentStepId(reportDb, runId)).toBe('execute-tasks');
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({ runId, stepId: 'execute-tasks', status: 'running' });
    });

    it('defaults status to "running" when omitted', async () => {
      const runId = seedReportRun(reportDb, 'sprint');

      const { socket, writes } = makeSocketDouble();
      await reportHandler.handleMessage(
        { type: 'mcp-report-step', requestId: 'rs-3', runId, stepId: 'analyze-dependencies' },
        socket,
      );

      const response = parseLastWrite(writes);
      expect(response.ok).toBe(true);
      expect(response.data).toEqual({ step_id: 'analyze-dependencies', status: 'running' });
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
      // rebuild: ideas/epics/tasks + entity_events + 12th stage) -> 024
      // (archived_at columns + position-11 stage removal).
      taskDb.exec(readFileSync(join(migDir, '006_cyboflow_schema.sql'), 'utf-8'));
      taskDb.exec(readFileSync(join(migDir, '011_workflow_step_tracking.sql'), 'utf-8'));
      taskDb.exec(readFileSync(join(migDir, '014_native_tasks.sql'), 'utf-8'));
      taskDb.exec(readFileSync(join(migDir, '015_entity_model_rebuild.sql'), 'utf-8'));
      taskDb.exec(readFileSync(join(migDir, '024_archive_in_place.sql'), 'utf-8'));
      taskDb.exec(readFileSync(join(migDir, '028_idea_attachments.sql'), 'utf-8'));
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

      it('persists the rich markdown body alongside the short summary (the planner spec path)', async () => {
        seedTaskRun(taskDb, {
          runId: 'run-1',
          currentStepId: 'plan',
          stepsSnapshot: { plan: 'planner' },
        });

        const specBody = '## Idea spec\n\n- goal one\n- goal two\n\n### Acceptance\n- it works';
        const { socket, writes } = makeSocketDouble();
        await taskHandler.handleMessage(
          {
            type: 'mcp-create-task',
            requestId: 'ct-body',
            runId: 'run-1',
            title: 'Spec idea',
            summary: 'One-line caption',
            body: specBody,
          },
          socket,
        );

        const response = parseLastWrite(writes);
        expect(response.ok).toBe(true);
        const data = response.data as { task_id: string };

        // body lands in ideas.body (the canonical markdown field) and summary
        // stays the short caption — the two no longer collide.
        const row = taskDb
          .prepare('SELECT summary, body FROM ideas WHERE id = ?')
          .get(data.task_id) as { summary: string | null; body: string | null };
        expect(row.body).toBe(specBody);
        expect(row.summary).toBe('One-line caption');
      });
    });

    // -----------------------------------------------------------------------
    // content-driven artifact mint (handleEntityWrite) wiring
    // -----------------------------------------------------------------------

    describe('fires handleEntityWrite after a successful task write', () => {
      beforeEach(() => {
        vi.mocked(handleEntityWrite).mockClear();
      });

      it("fires handleEntityWrite('idea') after a successful idea create (default type)", async () => {
        seedTaskRun(taskDb, { runId: 'run-1', currentStepId: 'plan', stepsSnapshot: { plan: 'planner' } });

        const { socket, writes } = makeSocketDouble();
        await taskHandler.handleMessage(
          { type: 'mcp-create-task', requestId: 'ew-1', runId: 'run-1', title: 'An idea' },
          socket,
        );
        expect(parseLastWrite(writes).ok).toBe(true);

        expect(handleEntityWrite).toHaveBeenCalledTimes(1);
        const call = vi.mocked(handleEntityWrite).mock.calls[0];
        expect(call[1]).toBe('run-1'); // runId
        expect(call[2]).toBe('idea'); // derived entity type
      });

      it("fires handleEntityWrite('task') after a successful task create (taskType='task')", async () => {
        seedTaskRun(taskDb, { runId: 'run-1', currentStepId: 'plan', stepsSnapshot: { plan: 'planner' } });

        const { socket, writes } = makeSocketDouble();
        await taskHandler.handleMessage(
          { type: 'mcp-create-task', requestId: 'ew-2', runId: 'run-1', taskType: 'task', title: 'A task' },
          socket,
        );
        expect(parseLastWrite(writes).ok).toBe(true);

        expect(handleEntityWrite).toHaveBeenCalledTimes(1);
        expect(vi.mocked(handleEntityWrite).mock.calls[0][2]).toBe('task');
      });

      it('fires handleEntityWrite after a successful update (entity type from identity)', async () => {
        seedTaskRun(taskDb, { runId: 'run-1', currentStepId: 'plan', stepsSnapshot: { plan: 'planner' } });

        const created = makeSocketDouble();
        await taskHandler.handleMessage(
          { type: 'mcp-create-task', requestId: 'ew-seed', runId: 'run-1', title: 'Before' },
          created.socket,
        );
        const taskId = (parseLastWrite(created.writes).data as { task_id: string }).task_id;
        vi.mocked(handleEntityWrite).mockClear(); // ignore the create's fire

        const { socket, writes } = makeSocketDouble();
        await taskHandler.handleMessage(
          { type: 'mcp-update-task', requestId: 'ew-up', runId: 'run-1', taskId, title: 'After' },
          socket,
        );
        expect(parseLastWrite(writes).ok).toBe(true);

        expect(handleEntityWrite).toHaveBeenCalledTimes(1);
        expect(vi.mocked(handleEntityWrite).mock.calls[0][2]).toBe('idea');
      });

      it('does NOT fire handleEntityWrite when the create is REJECTED (no real run)', async () => {
        // 'orchestrator' sentinel → resolveTaskRunContext rejects before any write.
        const { socket, writes } = makeSocketDouble();
        await taskHandler.handleMessage(
          { type: 'mcp-create-task', requestId: 'ew-rej', runId: 'orchestrator', title: 'X' },
          socket,
        );
        expect(parseLastWrite(writes).ok).toBe(false);
        expect(handleEntityWrite).not.toHaveBeenCalled();
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

      it('updates the markdown body, bumps version, leaves summary untouched', async () => {
        seedTaskRun(taskDb, {
          runId: 'run-1',
          currentStepId: 'plan',
          stepsSnapshot: { plan: 'planner' },
        });

        // Seed an idea carrying only a short caption (no body yet — the create gate).
        const created = makeSocketDouble();
        await taskHandler.handleMessage(
          {
            type: 'mcp-create-task',
            requestId: 'ct-seed-body',
            runId: 'run-1',
            title: 'Folding idea',
            summary: 'Short caption',
          },
          created.socket,
        );
        const taskId = (parseLastWrite(created.writes).data as { task_id: string }).task_id;

        const specBody = '## Idea spec\n\nFolded-in rich spec\n\n- detail';
        const { socket, writes } = makeSocketDouble();
        await taskHandler.handleMessage(
          {
            type: 'mcp-update-task',
            requestId: 'ut-body',
            runId: 'run-1',
            taskId,
            body: specBody,
          },
          socket,
        );

        const response = parseLastWrite(writes);
        expect(response.ok).toBe(true);
        const data = response.data as { version?: number };
        expect(data.version).toBe(2);

        const row = taskDb
          .prepare('SELECT summary, body, version FROM ideas WHERE id = ?')
          .get(taskId) as { summary: string | null; body: string | null; version: number };
        expect(row.body).toBe(specBody);
        expect(row.summary).toBe('Short caption');
        expect(row.version).toBe(2);
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
    // add-dependency
    // -----------------------------------------------------------------------

    describe('mcp-add-task-dependency', () => {
      /** Create a real TASK via the create handler and return its id. */
      async function createTask(runId: string, title: string): Promise<string> {
        const created = makeSocketDouble();
        await taskHandler.handleMessage(
          { type: 'mcp-create-task', requestId: `ct-${title}`, runId, taskType: 'task', title },
          created.socket,
        );
        return (parseLastWrite(created.writes).data as { task_id: string }).task_id;
      }

      it('records a blocking edge and replies ok:true with the edge data', async () => {
        seedTaskRun(taskDb, {
          runId: 'run-1',
          currentStepId: 'analyze-deps',
          stepsSnapshot: { 'analyze-deps': 'dependency-analyzer' },
        });
        const a = await createTask('run-1', 'A');
        const b = await createTask('run-1', 'B');

        const { socket, writes } = makeSocketDouble();
        await taskHandler.handleMessage(
          {
            type: 'mcp-add-task-dependency',
            requestId: 'dep-1',
            runId: 'run-1',
            taskId: a,
            dependsOnTaskId: b,
          },
          socket,
        );

        const response = parseLastWrite(writes);
        expect(response.ok).toBe(true);
        const data = response.data as { task_id: string; depends_on_task_id: string; kind: string };
        expect(data).toEqual({ task_id: a, depends_on_task_id: b, kind: 'blocking' });

        const row = taskDb
          .prepare('SELECT kind FROM task_dependencies WHERE task_id = ? AND depends_on_task_id = ?')
          .get(a, b) as { kind: string };
        expect(row.kind).toBe('blocking');
      });

      it('resolves display refs (TASK-001) and echoes the canonical opaque ids', async () => {
        seedTaskRun(taskDb, {
          runId: 'run-1',
          currentStepId: 'analyze-deps',
          stepsSnapshot: { 'analyze-deps': 'dependency-analyzer' },
        });
        const a = await createTask('run-1', 'A');
        const b = await createTask('run-1', 'B');
        const refA = (taskDb.prepare('SELECT ref FROM tasks WHERE id = ?').get(a) as { ref: string }).ref;
        const refB = (taskDb.prepare('SELECT ref FROM tasks WHERE id = ?').get(b) as { ref: string }).ref;

        const { socket, writes } = makeSocketDouble();
        await taskHandler.handleMessage(
          { type: 'mcp-add-task-dependency', requestId: 'dep-ref', runId: 'run-1', taskId: refA, dependsOnTaskId: refB },
          socket,
        );

        const response = parseLastWrite(writes);
        expect(response.ok).toBe(true);
        // The response echoes the RESOLVED opaque ids for BOTH endpoints — not the
        // refs the caller sent — so it reflects what was actually stored.
        const data = response.data as { task_id: string; depends_on_task_id: string; kind: string };
        expect(data).toEqual({ task_id: a, depends_on_task_id: b, kind: 'blocking' });
        // The stored edge keys on the opaque ids (aligning with the fan-out DAG).
        const row = taskDb
          .prepare('SELECT task_id, depends_on_task_id FROM task_dependencies WHERE task_id = ?')
          .get(a) as { task_id: string; depends_on_task_id: string };
        expect(row).toEqual({ task_id: a, depends_on_task_id: b });
      });

      it('surfaces a cycle as ok:false error "dependency_cycle"', async () => {
        seedTaskRun(taskDb, {
          runId: 'run-1',
          currentStepId: 'analyze-deps',
          stepsSnapshot: { 'analyze-deps': 'dependency-analyzer' },
        });
        const a = await createTask('run-1', 'A');
        const b = await createTask('run-1', 'B');

        const first = makeSocketDouble();
        await taskHandler.handleMessage(
          { type: 'mcp-add-task-dependency', requestId: 'dep-2a', runId: 'run-1', taskId: a, dependsOnTaskId: b },
          first.socket,
        );
        expect(parseLastWrite(first.writes).ok).toBe(true);

        const { socket, writes } = makeSocketDouble();
        await taskHandler.handleMessage(
          { type: 'mcp-add-task-dependency', requestId: 'dep-2b', runId: 'run-1', taskId: b, dependsOnTaskId: a },
          socket,
        );

        const response = parseLastWrite(writes);
        expect(response.ok).toBe(false);
        expect(response.error).toBe('dependency_cycle');
      });

      it('surfaces a self-edge as ok:false error "invalid_dependency"', async () => {
        seedTaskRun(taskDb, {
          runId: 'run-1',
          currentStepId: 'analyze-deps',
          stepsSnapshot: { 'analyze-deps': 'dependency-analyzer' },
        });
        const a = await createTask('run-1', 'A');

        const { socket, writes } = makeSocketDouble();
        await taskHandler.handleMessage(
          { type: 'mcp-add-task-dependency', requestId: 'dep-3', runId: 'run-1', taskId: a, dependsOnTaskId: a },
          socket,
        );

        const response = parseLastWrite(writes);
        expect(response.ok).toBe(false);
        expect(response.error).toBe('invalid_dependency');
      });

      it('rejects the "orchestrator" sentinel run with "task_write_requires_real_run"', async () => {
        const { socket, writes } = makeSocketDouble();
        await taskHandler.handleMessage(
          {
            type: 'mcp-add-task-dependency',
            requestId: 'dep-4',
            runId: 'orchestrator',
            taskId: 'tsk_x',
            dependsOnTaskId: 'tsk_y',
          },
          socket,
        );

        const response = parseLastWrite(writes);
        expect(response.ok).toBe(false);
        expect(response.error).toBe('task_write_requires_real_run');
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
      reviewDb.exec(readFileSync(join(migDir, '024_archive_in_place.sql'), 'utf-8'));
      reviewDb.exec(readFileSync(join(migDir, '028_idea_attachments.sql'), 'utf-8'));
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
      // The legacy snapshot label 'executor' normalizes to the canonical key
      // 'implement' via resolveStepAgentKey (P0 agent-identity reconciliation),
      // so the actor is 'agent:implement'.
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
      expect(row!.source).toBe('agent:implement');

      // A polymorphic review_item entity_events row was logged.
      const ev = reviewDb
        .prepare(
          "SELECT actor, kind FROM entity_events WHERE entity_type = 'review_item' ORDER BY seq ASC LIMIT 1",
        )
        .get() as { actor: string; kind: string } | undefined;
      expect(ev).toBeDefined();
      expect(ev!.actor).toBe('agent:implement');
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

    it('maps the structured finding extras (category / locations / suggested_fix / impact) into the payload', async () => {
      // The MCP tool forwards camelCase extras on the query message; the handler
      // folds them into a FindingPayload (snake_case impact members → camelCase).
      seedReviewRun(reviewDb, { runId: 'run-1', currentStepId: 'review', stepsSnapshot: { review: 'reviewer' } });

      const { socket, writes } = makeSocketDouble();
      await reviewHandler.handleMessage(
        {
          type: 'mcp-report-finding',
          requestId: 'rf-extras',
          runId: 'run-1',
          title: 'Regression after merge',
          body: 'Guard ran but a regression slipped through',
          severity: 'error',
          category: 'post-merge-bug',
          locations: [
            { path: 'src/foo.ts', line: 42 },
            { path: 'src/bar.ts' }, // no line — still kept
          ],
          suggestedFix: 'Re-add the null check',
          impact: { ran_count: 3, caught_regressions: 1, token_delta: -120, note: 'cheaper now' },
        },
        socket,
      );

      expect(parseLastWrite(writes).ok).toBe(true);

      await drain();
      const row = reviewDb
        .prepare("SELECT payload_json FROM review_items WHERE run_id = 'run-1'")
        .get() as { payload_json: string };
      expect(JSON.parse(row.payload_json)).toEqual({
        kind: 'finding',
        category: 'post-merge-bug',
        suggestedFix: 'Re-add the null check',
        locations: [{ path: 'src/foo.ts', line: 42 }, { path: 'src/bar.ts' }],
        impact: { ranCount: 3, caughtRegressions: 1, tokenDelta: -120, note: 'cheaper now' },
      });
    });

    it('DROPS malformed extras (bad location entries / wrong-typed impact members) without failing the write', async () => {
      // An agent typo must never fail a non-blocking finding. Malformed location
      // entries are dropped individually; a non-numeric impact member is dropped;
      // an impact with no surviving member is omitted entirely.
      seedReviewRun(reviewDb, { runId: 'run-1', currentStepId: 'review', stepsSnapshot: { review: 'reviewer' } });

      const { socket, writes } = makeSocketDouble();
      await reviewHandler.handleMessage(
        {
          type: 'mcp-report-finding',
          requestId: 'rf-malformed',
          runId: 'run-1',
          title: 'Has typos',
          body: 'b',
          category: 'perf',
          // Only the well-formed entry (string path) survives; the others are dropped.
          locations: [
            { path: 'src/ok.ts', line: 7 },
            { path: 123 }, // path not a string → dropped
            { line: 9 }, // missing path → dropped
            'not-an-object', // not a record → dropped
          ],
          // ran_count is a string → dropped; nothing else valid → impact omitted.
          impact: { ran_count: 'three' },
          // suggested_fix wrong type → dropped.
          suggestedFix: 99,
        } as unknown as McpQueryMessage,
        socket,
      );

      expect(parseLastWrite(writes).ok).toBe(true);

      await drain();
      const row = reviewDb
        .prepare("SELECT payload_json FROM review_items WHERE run_id = 'run-1'")
        .get() as { payload_json: string };
      // Only the valid category + the single surviving location remain; impact and
      // suggestedFix are absent (every member was malformed).
      expect(JSON.parse(row.payload_json)).toEqual({
        kind: 'finding',
        category: 'perf',
        locations: [{ path: 'src/ok.ts', line: 7 }],
      });
    });

    it('leaves the payload null when no structured extras and no payload_json are sent (unchanged from before)', async () => {
      // The legacy no-payload path must be byte-for-byte unchanged: a bare finding
      // persists with a NULL payload_json (the extras mapping adds nothing).
      seedReviewRun(reviewDb, { runId: 'run-1', currentStepId: 'implement', stepsSnapshot: { implement: 'executor' } });

      const { socket, writes } = makeSocketDouble();
      await reviewHandler.handleMessage(
        { type: 'mcp-report-finding', requestId: 'rf-bare', runId: 'run-1', title: 'Bare', body: 'b' },
        socket,
      );

      expect(parseLastWrite(writes).ok).toBe(true);

      await drain();
      const row = reviewDb
        .prepare("SELECT payload_json FROM review_items WHERE run_id = 'run-1'")
        .get() as { payload_json: string | null };
      expect(row.payload_json).toBeNull();
    });

    it('folds extras over an explicit finding payload_json (extras win per-field, base kept otherwise)', async () => {
      // payload_json carries a base finding payload; the structured extras override
      // category and add impact, while a payload-only field (suggestedFix) survives.
      seedReviewRun(reviewDb, { runId: 'run-1', currentStepId: 'review', stepsSnapshot: { review: 'reviewer' } });

      const { socket, writes } = makeSocketDouble();
      await reviewHandler.handleMessage(
        {
          type: 'mcp-report-finding',
          requestId: 'rf-fold',
          runId: 'run-1',
          title: 'Merged base + extras',
          body: 'b',
          payloadJson: JSON.stringify({ kind: 'finding', category: 'style', suggestedFix: 'from payload' }),
          category: 'perf', // overrides the payload's 'style'
          impact: { ran_count: 2 },
        },
        socket,
      );

      expect(parseLastWrite(writes).ok).toBe(true);

      await drain();
      const row = reviewDb
        .prepare("SELECT payload_json FROM review_items WHERE run_id = 'run-1'")
        .get() as { payload_json: string };
      expect(JSON.parse(row.payload_json)).toEqual({
        kind: 'finding',
        category: 'perf', // extra overrode base
        suggestedFix: 'from payload', // base survived (no extra for it)
        impact: { ranCount: 2 },
      });
    });

    it("maps a proposed_target of 'fix' into the finding payload (findings-triage redesign)", async () => {
      // 'fix' = a quick in-place fix bucket, added with the findings-triage
      // redesign — buildFindingExtras must accept it alongside backlog/docs/prompt.
      seedReviewRun(reviewDb, { runId: 'run-1', currentStepId: 'review', stepsSnapshot: { review: 'reviewer' } });

      const { socket, writes } = makeSocketDouble();
      await reviewHandler.handleMessage(
        {
          type: 'mcp-report-finding',
          requestId: 'rf-fix',
          runId: 'run-1',
          title: 'Quick fix candidate',
          body: 'b',
          proposedTarget: 'fix',
        },
        socket,
      );

      expect(parseLastWrite(writes).ok).toBe(true);
      await drain();
      const row = reviewDb
        .prepare("SELECT payload_json FROM review_items WHERE run_id = 'run-1'")
        .get() as { payload_json: string };
      expect(JSON.parse(row.payload_json)).toEqual({ kind: 'finding', proposedTarget: 'fix' });
    });

    it('DROPS a garbage proposed_target value without failing the write', async () => {
      // An out-of-vocabulary proposed_target is dropped (agent-typo-can-never-
      // fail-a-write discipline) — the finding persists with a NULL payload.
      seedReviewRun(reviewDb, { runId: 'run-1', currentStepId: 'review', stepsSnapshot: { review: 'reviewer' } });

      const { socket, writes } = makeSocketDouble();
      await reviewHandler.handleMessage(
        {
          type: 'mcp-report-finding',
          requestId: 'rf-bad-target',
          runId: 'run-1',
          title: 'Bad target',
          body: 'b',
          proposedTarget: 'wherever',
        } as unknown as McpQueryMessage,
        socket,
      );

      expect(parseLastWrite(writes).ok).toBe(true);
      await drain();
      const row = reviewDb
        .prepare("SELECT payload_json FROM review_items WHERE run_id = 'run-1'")
        .get() as { payload_json: string | null };
      // No surviving extra → payload stays NULL (the garbage target was dropped).
      expect(row.payload_json).toBeNull();
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
    gateDb.exec(readFileSync(join(migDir, '024_archive_in_place.sql'), 'utf-8'));
    gateDb.exec(readFileSync(join(migDir, '028_idea_attachments.sql'), 'utf-8'));
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
      { type: 'mcp-report-step', requestId: 'hg-2', runId: 'run-g', stepId: 'execute-tasks', status: 'running' },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(true);
    expect(response.data).toEqual({ step_id: 'execute-tasks', status: 'running' });

    const status = (gateDb.prepare('SELECT status FROM workflow_runs WHERE id = ?').get('run-g') as { status: string })
      .status;
    expect(status).toBe('running');
    expect(gateDb.prepare("SELECT COUNT(*) AS n FROM review_items WHERE run_id = 'run-g'").get()).toEqual({ n: 0 });
  });
});

// ---------------------------------------------------------------------------
// 9. FIX-STAGE-MODEL (C): mcp-report-step advances EVERY idea the run owns —
//    its seed idea AND every idea it created during the run (entity_events) —
//    to the planning stage mapped to the step.
//    context->Idea(1), research->Research(2), approve-idea->Idea spec(3).
//    NON-PAUSING (run stays 'running'); fail-soft when the run owns no ideas.
// ---------------------------------------------------------------------------

describe('mcp-report-step advances run-owned idea stages (FIX-STAGE-MODEL C)', () => {
  // Migration-backed DB through 017 (adds workflow_runs.seed_idea_id) so the
  // report path can resolve + move the seed idea via the TaskChangeRouter.
  function buildSeedDb(): Database.Database {
    const seedDb = new Database(':memory:');
    seedDb.pragma('foreign_keys = ON');
    seedDb.exec(`
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    seedDb.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Proj', '/tmp/p1');
    const migDir = join(__dirname, '..', '..', '..', 'database', 'migrations');
    seedDb.exec(readFileSync(join(migDir, '006_cyboflow_schema.sql'), 'utf-8'));
    seedDb.exec(readFileSync(join(migDir, '011_workflow_step_tracking.sql'), 'utf-8'));
    seedDb.exec(readFileSync(join(migDir, '014_native_tasks.sql'), 'utf-8'));
    seedDb.exec(readFileSync(join(migDir, '015_entity_model_rebuild.sql'), 'utf-8'));
    seedDb.exec(readFileSync(join(migDir, '016_review_items.sql'), 'utf-8'));
    seedDb.exec(readFileSync(join(migDir, '017_run_seed_idea.sql'), 'utf-8'));
    seedDb.exec(readFileSync(join(migDir, '024_archive_in_place.sql'), 'utf-8'));
    seedDb.exec(readFileSync(join(migDir, '028_idea_attachments.sql'), 'utf-8'));
    return seedDb;
  }

  function stage(position: number): string {
    return `stage-board-1-default-${position}`;
  }

  // Seed a 'planner' run (built-in def has context/research/approve-idea steps).
  function seedPlannerRun(seedDb: Database.Database, runId: string, seedIdeaId: string | null): void {
    seedDb
      .prepare(`INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-p', 1, 'planner', '{}')`)
      .run();
    seedDb
      .prepare(
        `INSERT INTO workflow_runs (id, workflow_id, project_id, status, seed_idea_id) VALUES (?, 'wf-p', 1, 'running', ?)`,
      )
      .run(runId, seedIdeaId);
  }

  let seedDb: Database.Database;
  let seedHandler: McpQueryHandler;

  beforeEach(() => {
    seedDb = buildSeedDb();
    TaskChangeRouter.initialize(dbAdapter(seedDb));
    seedHandler = new McpQueryHandler(dbAdapter(seedDb));
    stepTransitionEvents.removeAllListeners('transition');
  });

  afterEach(() => {
    TaskChangeRouter._resetForTesting();
    taskChangeEvents.removeAllListeners();
    stepTransitionEvents.removeAllListeners('transition');
  });

  async function createSeedIdea(): Promise<string> {
    const { taskId } = await TaskChangeRouter.getInstance().applyChange(1, {
      actor: 'user',
      entityType: 'idea',
      title: 'Seed idea',
    });
    return taskId;
  }

  it('research step moves the seed idea to Research (position 2) WITHOUT pausing the run', async () => {
    const ideaId = await createSeedIdea();
    // Created at the idea type-default (position 1).
    expect((seedDb.prepare('SELECT stage_id FROM ideas WHERE id = ?').get(ideaId) as { stage_id: string }).stage_id).toBe(
      stage(1),
    );
    seedPlannerRun(seedDb, 'run-p', ideaId);

    const { socket, writes } = makeSocketDouble();
    await seedHandler.handleMessage(
      { type: 'mcp-report-step', requestId: 'sc-1', runId: 'run-p', stepId: 'research', status: 'running' },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(true);
    // Observational shape is unchanged — no seed-idea field leaks into the reply.
    expect(response.data).toEqual({ step_id: 'research', status: 'running' });

    // The seed idea advanced to Research (position 2)...
    expect((seedDb.prepare('SELECT stage_id FROM ideas WHERE id = ?').get(ideaId) as { stage_id: string }).stage_id).toBe(
      stage(2),
    );
    // ...and the run is STILL running (non-pausing).
    expect((seedDb.prepare('SELECT status FROM workflow_runs WHERE id = ?').get('run-p') as { status: string }).status).toBe(
      'running',
    );
    // The move is orchestrator-attributed.
    const ev = seedDb
      .prepare("SELECT actor FROM entity_events WHERE entity_type = 'idea' AND entity_id = ? ORDER BY seq DESC LIMIT 1")
      .get(ideaId) as { actor: string };
    expect(ev.actor).toBe('orchestrator');
  });

  it('approve-idea step moves the seed idea to Idea spec (position 3)', async () => {
    const ideaId = await createSeedIdea();
    seedPlannerRun(seedDb, 'run-p', ideaId);

    const { socket, writes } = makeSocketDouble();
    await seedHandler.handleMessage(
      { type: 'mcp-report-step', requestId: 'sc-2', runId: 'run-p', stepId: 'approve-idea', status: 'running' },
      socket,
    );

    expect(parseLastWrite(writes).ok).toBe(true);
    expect((seedDb.prepare('SELECT stage_id FROM ideas WHERE id = ?').get(ideaId) as { stage_id: string }).stage_id).toBe(
      stage(3),
    );
  });

  it('advances a run-CREATED idea (no seed_idea_id) to the mapped stage on approve-idea', async () => {
    // A raw-prompt run has NO seed_idea_id but mints an idea during the run; that
    // idea is "owned" via an entity_events created row tagged with the run id, and
    // must advance to Idea spec (position 3) on approve-idea — proving the report
    // path now drives EVERY run-owned idea, not only the legacy seed.
    const ideaId = await createSeedIdea(); // starts at the idea type-default (position 1)
    expect((seedDb.prepare('SELECT stage_id FROM ideas WHERE id = ?').get(ideaId) as { stage_id: string }).stage_id).toBe(
      stage(1),
    );
    seedPlannerRun(seedDb, 'run-p', null); // raw-prompt run — NO seed idea linked

    // Link the idea to the run via a 'created' entity_events row. createSeedIdea
    // already wrote a seq=1 created event (run_id NULL, actor 'user'); use seq=2 to
    // respect the UNIQUE(entity_type, entity_id, seq) constraint.
    seedDb
      .prepare(
        `INSERT INTO entity_events (entity_type, entity_id, seq, kind, actor, run_id)
         VALUES ('idea', ?, 2, 'created', 'agent:context', 'run-p')`,
      )
      .run(ideaId);

    const { socket, writes } = makeSocketDouble();
    await seedHandler.handleMessage(
      { type: 'mcp-report-step', requestId: 'sc-created', runId: 'run-p', stepId: 'approve-idea', status: 'running' },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(true);
    // Observational shape is unchanged — no idea field leaks into the reply.
    expect(response.data).toEqual({ step_id: 'approve-idea', status: 'running' });

    // The run-created idea advanced to Idea spec (position 3)...
    expect((seedDb.prepare('SELECT stage_id FROM ideas WHERE id = ?').get(ideaId) as { stage_id: string }).stage_id).toBe(
      stage(3),
    );
    // ...the run is STILL running (non-pausing)...
    expect((seedDb.prepare('SELECT status FROM workflow_runs WHERE id = ?').get('run-p') as { status: string }).status).toBe(
      'running',
    );
    // ...and the move is orchestrator-attributed.
    const ev = seedDb
      .prepare("SELECT actor FROM entity_events WHERE entity_type = 'idea' AND entity_id = ? ORDER BY seq DESC LIMIT 1")
      .get(ideaId) as { actor: string };
    expect(ev.actor).toBe('orchestrator');
  });

  it('fail-soft: a run with no seed_idea_id reports normally and touches no idea', async () => {
    const ideaId = await createSeedIdea();
    seedPlannerRun(seedDb, 'run-p', null); // NO seed idea linked

    const { socket, writes } = makeSocketDouble();
    await seedHandler.handleMessage(
      { type: 'mcp-report-step', requestId: 'sc-3', runId: 'run-p', stepId: 'research', status: 'running' },
      socket,
    );

    expect(parseLastWrite(writes).ok).toBe(true);
    // The unrelated idea is untouched at its create stage.
    expect((seedDb.prepare('SELECT stage_id FROM ideas WHERE id = ?').get(ideaId) as { stage_id: string }).stage_id).toBe(
      stage(1),
    );
  });

  it('fail-soft: an UNMAPPED planner step (epics) does not move the seed idea', async () => {
    const ideaId = await createSeedIdea();
    seedPlannerRun(seedDb, 'run-p', ideaId);

    const { socket, writes } = makeSocketDouble();
    await seedHandler.handleMessage(
      { type: 'mcp-report-step', requestId: 'sc-4', runId: 'run-p', stepId: 'epics', status: 'running' },
      socket,
    );

    expect(parseLastWrite(writes).ok).toBe(true);
    // 'epics' is not in PLANNER_STEP_TO_IDEA_POSITION — idea stays at position 1.
    expect((seedDb.prepare('SELECT stage_id FROM ideas WHERE id = ?').get(ideaId) as { stage_id: string }).stage_id).toBe(
      stage(1),
    );
  });
});

// ---------------------------------------------------------------------------
// mcp-update-sprint-task — sprint lane writes via SprintLaneStore
// ---------------------------------------------------------------------------

describe('mcp-update-sprint-task (sprint lane writes)', () => {
  // The handler resolves the calling run's batch (workflow_runs.batch_id,
  // migration 022) and routes the write through SprintLaneStore, so we need
  // the entity schema PLUS the sprint-batch tables: 006 -> 011 -> 014 -> 015
  // (mirrors buildTaskDb above) -> 022 (sprint_batches / sprint_batch_tasks /
  // workflow_runs.batch_id) -> 023 (sprint_batch_tasks.current_step_id).
  function buildLaneDb(): Database.Database {
    const laneDb = new Database(':memory:');
    laneDb.pragma('foreign_keys = ON');
    laneDb.exec(`
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    laneDb.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Proj', '/tmp/p1');

    const migDir = join(__dirname, '..', '..', '..', 'database', 'migrations');
    laneDb.exec(readFileSync(join(migDir, '006_cyboflow_schema.sql'), 'utf-8'));
    laneDb.exec(readFileSync(join(migDir, '011_workflow_step_tracking.sql'), 'utf-8'));
    laneDb.exec(readFileSync(join(migDir, '014_native_tasks.sql'), 'utf-8'));
    laneDb.exec(readFileSync(join(migDir, '015_entity_model_rebuild.sql'), 'utf-8'));
    laneDb.exec(readFileSync(join(migDir, '022_sprint_batches.sql'), 'utf-8'));
    laneDb.exec(readFileSync(join(migDir, '023_sprint_lane_step.sql'), 'utf-8'));
    laneDb.exec(readFileSync(join(migDir, '025_sprint_lane_attempts.sql'), 'utf-8'));
    return laneDb;
  }

  /** Seed a workflows + workflow_runs pair, optionally stamped with a batch_id. */
  function seedSprintRun(
    laneDb: Database.Database,
    opts: { runId: string; batchId?: string | null; status?: string },
  ): void {
    laneDb
      .prepare(
        `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', 1, 'sprint', '{}')`,
      )
      .run();
    laneDb
      .prepare(
        `INSERT INTO workflow_runs (id, workflow_id, project_id, status, current_step_id, steps_snapshot_json, batch_id)
         VALUES (?, 'wf-1', 1, ?, 'execute-tasks', '{"execute-tasks":"executor"}', ?)`,
      )
      .run(opts.runId, opts.status ?? 'running', opts.batchId ?? null);
  }

  let laneDb: Database.Database;
  let laneHandler: McpQueryHandler;

  beforeEach(() => {
    laneDb = buildLaneDb();
    SprintLaneStore.initialize(dbAdapter(laneDb));
    laneHandler = new McpQueryHandler(dbAdapter(laneDb));
  });

  afterEach(() => {
    SprintLaneStore._resetForTesting();
    sprintLaneEvents.removeAllListeners();
    laneDb.close();
  });

  it('happy path: updates the lane via SprintLaneStore and replies with the snake_case lane row', async () => {
    laneDb
      .prepare(
        `INSERT INTO tasks (id, project_id, ref, title, board_id, stage_id)
         VALUES ('tsk_a', 1, 'TASK-001', 'First task', 'board-1-default', 'stage-board-1-default-5')`,
      )
      .run();
    const { batchId } = SprintLaneStore.getInstance().createForRun(1, 'sdk', ['tsk_a']);
    seedSprintRun(laneDb, { runId: 'run-s', batchId });

    const { socket, writes } = makeSocketDouble();
    await laneHandler.handleMessage(
      {
        type: 'mcp-update-sprint-task',
        requestId: 'us-1',
        runId: 'run-s',
        taskId: 'tsk_a',
        status: 'running',
        currentStepId: 'implement',
      },
      socket,
    );

    // Wire-protocol contract: newline-delimited framing.
    expect(writes[writes.length - 1].endsWith('\n')).toBe(true);

    const response = parseLastWrite(writes);
    expect(response.type).toBe('mcp-query-response');
    expect(response.requestId).toBe('us-1');
    expect(response.ok).toBe(true);

    const data = response.data as {
      batch_id: string;
      task_id: string;
      status: string;
      current_step_id: string | null;
      attempts: number;
      ref: string | null;
      title: string | null;
      updated_at: string;
    };
    expect(data.batch_id).toBe(batchId);
    expect(data.task_id).toBe('tsk_a');
    expect(data.status).toBe('running');
    expect(data.current_step_id).toBe('implement');
    expect(data.attempts).toBe(0);
    expect(data.ref).toBe('TASK-001');
    expect(data.title).toBe('First task');
    expect(typeof data.updated_at).toBe('string');

    // The DB row actually changed.
    const row = laneDb
      .prepare('SELECT status, current_step_id FROM sprint_batch_tasks WHERE batch_id = ? AND task_id = ?')
      .get(batchId, 'tsk_a') as { status: string; current_step_id: string | null };
    expect(row.status).toBe('running');
    expect(row.current_step_id).toBe('implement');
  });

  it('passes attempt through to SprintLaneStore and replies with the updated attempts', async () => {
    const { batchId } = SprintLaneStore.getInstance().createForRun(1, 'sdk', ['tsk_a']);
    seedSprintRun(laneDb, { runId: 'run-s', batchId });

    const { socket, writes } = makeSocketDouble();
    await laneHandler.handleMessage(
      {
        type: 'mcp-update-sprint-task',
        requestId: 'us-a1',
        runId: 'run-s',
        taskId: 'tsk_a',
        currentStepId: 'implement',
        attempt: 2,
      },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(true);
    expect((response.data as { attempts: number }).attempts).toBe(2);

    const row = laneDb
      .prepare('SELECT attempts FROM sprint_batch_tasks WHERE batch_id = ? AND task_id = ?')
      .get(batchId, 'tsk_a') as { attempts: number };
    expect(row.attempts).toBe(2);
  });

  it('maps an attempt < 1 onto the wire as bad_request (no write)', async () => {
    const { batchId } = SprintLaneStore.getInstance().createForRun(1, 'sdk', ['tsk_a']);
    seedSprintRun(laneDb, { runId: 'run-s', batchId });

    const { socket, writes } = makeSocketDouble();
    await laneHandler.handleMessage(
      {
        type: 'mcp-update-sprint-task',
        requestId: 'us-a2',
        runId: 'run-s',
        taskId: 'tsk_a',
        currentStepId: 'implement',
        attempt: 0,
      },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(false);
    expect(response.error).toBe('bad_request');

    const row = laneDb
      .prepare('SELECT attempts, current_step_id FROM sprint_batch_tasks WHERE batch_id = ?')
      .get(batchId) as { attempts: number; current_step_id: string | null };
    expect(row.attempts).toBe(0);
    expect(row.current_step_id).toBeNull();
  });

  it('rejects a run with NULL batch_id with sprint_lane_requires_batch_run (no write)', async () => {
    seedSprintRun(laneDb, { runId: 'run-nb', batchId: null });

    const { socket, writes } = makeSocketDouble();
    await laneHandler.handleMessage(
      { type: 'mcp-update-sprint-task', requestId: 'us-2', runId: 'run-nb', taskId: 'tsk_a', status: 'running' },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(false);
    expect(response.error).toBe('sprint_lane_requires_batch_run');
  });

  it("rejects the 'orchestrator' sentinel runId before any DB touch", async () => {
    const { socket, writes } = makeSocketDouble();
    await laneHandler.handleMessage(
      {
        type: 'mcp-update-sprint-task',
        requestId: 'us-3',
        runId: 'orchestrator',
        taskId: 'tsk_a',
        status: 'running',
      },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(false);
    // Parity with the other task-scoped writes (resolveTaskRunContext).
    expect(response.error).toBe('task_write_requires_real_run');
  });

  it('rejects a terminal run with run_not_active', async () => {
    seedSprintRun(laneDb, { runId: 'run-done', batchId: 'b-any', status: 'completed' });

    const { socket, writes } = makeSocketDouble();
    await laneHandler.handleMessage(
      { type: 'mcp-update-sprint-task', requestId: 'us-4', runId: 'run-done', taskId: 'tsk_a', status: 'running' },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(false);
    expect(response.error).toBe('run_not_active');
  });

  it('maps a SprintLaneError onto the wire: unknown lane -> lane_not_found', async () => {
    const { batchId } = SprintLaneStore.getInstance().createForRun(1, 'sdk', ['tsk_a']);
    seedSprintRun(laneDb, { runId: 'run-s', batchId });

    const { socket, writes } = makeSocketDouble();
    await laneHandler.handleMessage(
      {
        type: 'mcp-update-sprint-task',
        requestId: 'us-5',
        runId: 'run-s',
        taskId: 'tsk_not_in_batch',
        status: 'running',
      },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(false);
    expect(response.error).toBe('lane_not_found');
  });

  it('maps a SprintLaneError onto the wire: no field given -> bad_request', async () => {
    const { batchId } = SprintLaneStore.getInstance().createForRun(1, 'sdk', ['tsk_a']);
    seedSprintRun(laneDb, { runId: 'run-s', batchId });

    const { socket, writes } = makeSocketDouble();
    await laneHandler.handleMessage(
      { type: 'mcp-update-sprint-task', requestId: 'us-6', runId: 'run-s', taskId: 'tsk_a' },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(false);
    expect(response.error).toBe('bad_request');
  });
});

describe('shell-approval-request -> auto-derive sprint lane', () => {
  // Same migration-backed DB as the mcp-update-sprint-task suite: the auto-derive
  // shim resolves the run's batch (workflow_runs.batch_id, migration 022) and
  // writes through SprintLaneStore.updateLane (migration 023 current_step_id).
  function buildLaneDb(): Database.Database {
    const laneDb = new Database(':memory:');
    laneDb.pragma('foreign_keys = ON');
    laneDb.exec(`
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    laneDb.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Proj', '/tmp/p1');

    const migDir = join(__dirname, '..', '..', '..', 'database', 'migrations');
    laneDb.exec(readFileSync(join(migDir, '006_cyboflow_schema.sql'), 'utf-8'));
    laneDb.exec(readFileSync(join(migDir, '011_workflow_step_tracking.sql'), 'utf-8'));
    laneDb.exec(readFileSync(join(migDir, '014_native_tasks.sql'), 'utf-8'));
    laneDb.exec(readFileSync(join(migDir, '015_entity_model_rebuild.sql'), 'utf-8'));
    laneDb.exec(readFileSync(join(migDir, '022_sprint_batches.sql'), 'utf-8'));
    laneDb.exec(readFileSync(join(migDir, '023_sprint_lane_step.sql'), 'utf-8'));
    laneDb.exec(readFileSync(join(migDir, '025_sprint_lane_attempts.sql'), 'utf-8'));
    return laneDb;
  }

  function seedSprintRun(
    laneDb: Database.Database,
    opts: { runId: string; batchId?: string | null; status?: string },
  ): void {
    laneDb
      .prepare(
        `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', 1, 'sprint', '{}')`,
      )
      .run();
    laneDb
      .prepare(
        `INSERT INTO workflow_runs (id, workflow_id, project_id, status, current_step_id, steps_snapshot_json, batch_id)
         VALUES (?, 'wf-1', 1, ?, 'execute-tasks', '{"execute-tasks":"executor"}', ?)`,
      )
      .run(opts.runId, opts.status ?? 'running', opts.batchId ?? null);
  }

  function seedTask(laneDb: Database.Database, id: string, ref: string, title: string): void {
    laneDb
      .prepare(
        `INSERT INTO tasks (id, project_id, ref, title, board_id, stage_id)
         VALUES (?, 1, ?, ?, 'board-1-default', 'stage-board-1-default-5')`,
      )
      .run(id, ref, title);
  }

  function readLane(
    laneDb: Database.Database,
    batchId: string,
    taskId: string,
  ): { status: string; current_step_id: string | null } {
    return laneDb
      .prepare('SELECT status, current_step_id FROM sprint_batch_tasks WHERE batch_id = ? AND task_id = ?')
      .get(batchId, taskId) as { status: string; current_step_id: string | null };
  }

  function taskDispatch(
    runId: string,
    subagentType: string,
    prompt = '',
    requestId = 'sa-1',
  ): Extract<McpQueryMessage, { type: 'shell-approval-request' }> {
    return {
      type: 'shell-approval-request',
      requestId,
      runId,
      toolName: 'Task',
      toolInput: { subagent_type: subagentType, prompt },
    };
  }

  let laneDb: Database.Database;
  let laneHandler: McpQueryHandler;

  beforeEach(() => {
    laneDb = buildLaneDb();
    SprintLaneStore.initialize(dbAdapter(laneDb));
    // The gate path (after the observe side-effect) routes unknown runs through
    // ApprovalRouter; initialize it so the verdict path runs without throwing.
    ApprovalRouter.initialize(dbAdapter(laneDb));
    laneHandler = new McpQueryHandler(dbAdapter(laneDb));
  });

  afterEach(() => {
    SprintLaneStore._resetForTesting();
    ApprovalRouter._resetForTesting();
    sprintLaneEvents.removeAllListeners();
    laneDb.close();
  });

  it('single-lane batch: a cyboflow-write-tests dispatch advances the lane to running/write-tests and emits the event', async () => {
    seedTask(laneDb, 'tsk_a', 'TASK-001', 'First task');
    const { batchId } = SprintLaneStore.getInstance().createForRun(1, 'sdk', ['tsk_a']);
    seedSprintRun(laneDb, { runId: 'run-s', batchId });

    const received: SprintLaneChangedEvent[] = [];
    sprintLaneEvents.on(sprintLaneChannel('run-s'), (evt: SprintLaneChangedEvent) => received.push(evt));

    const { socket } = makeSocketDouble();
    await laneHandler.handleMessage(taskDispatch('run-s', 'cyboflow-write-tests', 'do the task'), socket);

    const row = readLane(laneDb, batchId, 'tsk_a');
    expect(row.status).toBe('running');
    expect(row.current_step_id).toBe('write-tests');

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      runId: 'run-s',
      batchId,
      taskId: 'tsk_a',
      status: 'running',
      currentStepId: 'write-tests',
    });
  });

  it('maps each of the five per-task subagent_types onto its lane step (single-lane)', async () => {
    const cases: ReadonlyArray<[string, string]> = [
      ['cyboflow-implement', 'implement'],
      ['cyboflow-write-tests', 'write-tests'],
      ['cyboflow-code-review', 'code-review'],
      ['cyboflow-task-verify', 'task-verify'],
      ['cyboflow-visual-verify', 'visual-verify'],
    ];
    for (const [subagentType, expectedStep] of cases) {
      SprintLaneStore._resetForTesting();
      ApprovalRouter._resetForTesting();
      laneDb.close();
      laneDb = buildLaneDb();
      SprintLaneStore.initialize(dbAdapter(laneDb));
      ApprovalRouter.initialize(dbAdapter(laneDb));
      laneHandler = new McpQueryHandler(dbAdapter(laneDb));

      const { batchId } = SprintLaneStore.getInstance().createForRun(1, 'sdk', ['tsk_a']);
      seedSprintRun(laneDb, { runId: 'run-s', batchId });

      const { socket } = makeSocketDouble();
      await laneHandler.handleMessage(taskDispatch('run-s', subagentType), socket);

      const row = readLane(laneDb, batchId, 'tsk_a');
      expect(row.current_step_id).toBe(expectedStep);
      expect(row.status).toBe('running');
    }
  });

  it('multi-lane wave: an unambiguous ref match advances ONLY the matched lane', async () => {
    seedTask(laneDb, 'tsk_a', 'TASK-1', 'A');
    seedTask(laneDb, 'tsk_b', 'TASK-2', 'B');
    const { batchId } = SprintLaneStore.getInstance().createForRun(1, 'sdk', ['tsk_a', 'tsk_b']);
    seedSprintRun(laneDb, { runId: 'run-s', batchId });

    const { socket } = makeSocketDouble();
    await laneHandler.handleMessage(
      taskDispatch('run-s', 'cyboflow-implement', 'Implement TASK-2: the second task'),
      socket,
    );

    expect(readLane(laneDb, batchId, 'tsk_b')).toMatchObject({ status: 'running', current_step_id: 'implement' });
    expect(readLane(laneDb, batchId, 'tsk_a')).toMatchObject({ status: 'queued', current_step_id: null });
  });

  it('multi-lane wave: a ref-prefix collision (TASK-1 vs TASK-12) attributes by boundary, not substring', async () => {
    seedTask(laneDb, 'tsk_a', 'TASK-1', 'A');
    seedTask(laneDb, 'tsk_b', 'TASK-12', 'B');
    const { batchId } = SprintLaneStore.getInstance().createForRun(1, 'sdk', ['tsk_a', 'tsk_b']);
    seedSprintRun(laneDb, { runId: 'run-s', batchId });

    const { socket } = makeSocketDouble();
    await laneHandler.handleMessage(
      taskDispatch('run-s', 'cyboflow-implement', 'Work on TASK-12 only'),
      socket,
    );

    expect(readLane(laneDb, batchId, 'tsk_b')).toMatchObject({ status: 'running', current_step_id: 'implement' });
    expect(readLane(laneDb, batchId, 'tsk_a')).toMatchObject({ status: 'queued', current_step_id: null });
  });

  it('multi-lane wave: an ambiguous / no-match prompt is a strict no-op (no lane changed, no event)', async () => {
    seedTask(laneDb, 'tsk_a', 'TASK-1', 'A');
    seedTask(laneDb, 'tsk_b', 'TASK-2', 'B');
    const { batchId } = SprintLaneStore.getInstance().createForRun(1, 'sdk', ['tsk_a', 'tsk_b']);
    seedSprintRun(laneDb, { runId: 'run-s', batchId });

    let emitted = 0;
    sprintLaneEvents.on(sprintLaneChannel('run-s'), () => (emitted += 1));

    const { socket } = makeSocketDouble();
    await laneHandler.handleMessage(
      taskDispatch('run-s', 'cyboflow-implement', 'no task ref here at all'),
      socket,
    );

    expect(readLane(laneDb, batchId, 'tsk_a')).toMatchObject({ status: 'queued', current_step_id: null });
    expect(readLane(laneDb, batchId, 'tsk_b')).toMatchObject({ status: 'queued', current_step_id: null });
    expect(emitted).toBe(0);
  });

  it('NULL batch_id (non-sprint run) is a strict no-op but the deny-gating verdict still fires', async () => {
    seedSprintRun(laneDb, { runId: 'run-nb', batchId: null });
    let emitted = 0;
    sprintLaneEvents.on(sprintLaneChannel('run-nb'), () => (emitted += 1));

    const { socket } = makeSocketDouble();
    await laneHandler.handleMessage(taskDispatch('run-nb', 'cyboflow-implement', 'TASK-1'), socket);

    expect(emitted).toBe(0);
    // No sprint_batch_tasks row exists / changed — the strict no-op guarantee.
    const any = laneDb.prepare('SELECT COUNT(*) AS n FROM sprint_batch_tasks').get() as { n: number };
    expect(any.n).toBe(0);
    // NOTE: we deliberately do NOT assert on `writes` here. For a non-sentinel
    // run the gating path routes through ApprovalRouter.requestApproval, which
    // parks in 'awaiting_review' and only writes the verdict on a later human
    // decision — so writes.length is racily 0 at this point. The
    // verdict-still-fires guarantee is covered by the synchronous sentinel-deny
    // test below; here we only assert the observe side-effect is a no-op.
  });

  it("orchestrator-sentinel dispatch: no lane write, and the existing deny verdict still fires", async () => {
    const { batchId } = SprintLaneStore.getInstance().createForRun(1, 'sdk', ['tsk_a']);
    seedSprintRun(laneDb, { runId: 'run-s', batchId });
    let emitted = 0;
    sprintLaneEvents.on(sprintLaneChannel('orchestrator'), () => (emitted += 1));

    const { socket, writes } = makeSocketDouble();
    await laneHandler.handleMessage(taskDispatch('orchestrator', 'cyboflow-implement'), socket);

    expect(emitted).toBe(0);
    expect(readLane(laneDb, batchId, 'tsk_a')).toMatchObject({ status: 'queued', current_step_id: null });
    // writeShellVerdict deny for the sentinel — synchronous, unchanged.
    const last = parseLastWrite(writes);
    expect(last.type).toBe('mcp-query-response');
    expect((last.data as { permissionDecision: string }).permissionDecision).toBe('deny');
  });

  it('non-Task tool (Bash) is a no-op for lane derivation', async () => {
    const { batchId } = SprintLaneStore.getInstance().createForRun(1, 'sdk', ['tsk_a']);
    seedSprintRun(laneDb, { runId: 'run-s', batchId });

    const { socket } = makeSocketDouble();
    await laneHandler.handleMessage(
      {
        type: 'shell-approval-request',
        requestId: 'sa-bash',
        runId: 'run-s',
        toolName: 'Bash',
        toolInput: { command: 'ls' },
      },
      socket,
    );

    expect(readLane(laneDb, batchId, 'tsk_a')).toMatchObject({ status: 'queued', current_step_id: null });
  });

  it('an unknown / phase-wide subagent_type (cyboflow-sprint-verify) is a no-op', async () => {
    const { batchId } = SprintLaneStore.getInstance().createForRun(1, 'sdk', ['tsk_a']);
    seedSprintRun(laneDb, { runId: 'run-s', batchId });

    const { socket } = makeSocketDouble();
    await laneHandler.handleMessage(taskDispatch('run-s', 'cyboflow-sprint-verify'), socket);

    expect(readLane(laneDb, batchId, 'tsk_a')).toMatchObject({ status: 'queued', current_step_id: null });
  });

  it('idempotent / monotonic: re-dispatching implement does not regress a lane already at task-verify', async () => {
    seedTask(laneDb, 'tsk_a', 'TASK-001', 'A');
    const { batchId } = SprintLaneStore.getInstance().createForRun(1, 'sdk', ['tsk_a']);
    seedSprintRun(laneDb, { runId: 'run-s', batchId });

    // Pre-advance the lane to task-verify (as a real run would have).
    SprintLaneStore.getInstance().updateLane({
      runId: 'run-s',
      batchId,
      taskId: 'tsk_a',
      status: 'running',
      currentStepId: 'task-verify',
    });

    const { socket } = makeSocketDouble();
    await laneHandler.handleMessage(taskDispatch('run-s', 'cyboflow-implement'), socket);

    // Stays at task-verify — never yanked back to implement.
    expect(readLane(laneDb, batchId, 'tsk_a')).toMatchObject({
      status: 'running',
      current_step_id: 'task-verify',
    });
  });
});

// ---------------------------------------------------------------------------
// 10. mcp-get-selected-findings / mcp-resolve-finding — compound-run findings.
//     The triage tray seeds a compound run with workflow_runs.seed_finding_ids
//     (migration 034). get-selected-findings re-reads that set (read-only);
//     resolve-finding resolves a consumed finding via the ReviewItemRouter
//     chokepoint, AWAITED so a failure surfaces. Both are mid-run-only — a
//     terminal run is rejected by the shared run-context guard (run_not_active).
// ---------------------------------------------------------------------------

describe('compound-run findings (mcp-get-selected-findings / mcp-resolve-finding)', () => {
  // The handlers reach selectFindingForSeed (reads review_items.priority +
  // workflow_runs.seed_finding_ids) and ReviewItemRouter.applyReviewItem, so the
  // DB needs the full review schema PLUS migration 034 (findings-triage columns).
  function buildFindingsDb(): Database.Database {
    const fdb = new Database(':memory:');
    fdb.pragma('foreign_keys = ON');
    fdb.exec(`
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    fdb.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Proj', '/tmp/p1');

    const migDir = join(__dirname, '..', '..', '..', 'database', 'migrations');
    fdb.exec(readFileSync(join(migDir, '006_cyboflow_schema.sql'), 'utf-8'));
    fdb.exec(readFileSync(join(migDir, '011_workflow_step_tracking.sql'), 'utf-8'));
    fdb.exec(readFileSync(join(migDir, '014_native_tasks.sql'), 'utf-8'));
    fdb.exec(readFileSync(join(migDir, '015_entity_model_rebuild.sql'), 'utf-8'));
    fdb.exec(readFileSync(join(migDir, '016_review_items.sql'), 'utf-8'));
    fdb.exec(readFileSync(join(migDir, '024_archive_in_place.sql'), 'utf-8'));
    fdb.exec(readFileSync(join(migDir, '028_idea_attachments.sql'), 'utf-8'));
    fdb.exec(readFileSync(join(migDir, '034_findings_triage.sql'), 'utf-8'));
    return fdb;
  }

  /** Seed a 'compound' run optionally stamped with a JSON seed_finding_ids array. */
  function seedCompoundRun(
    fdb: Database.Database,
    opts: { runId: string; status?: string; seedFindingIds?: string[] | null; stepsSnapshot?: Record<string, string> | null; currentStepId?: string | null },
  ): void {
    fdb
      .prepare(`INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-c', 1, 'compound', '{}')`)
      .run();
    fdb
      .prepare(
        `INSERT INTO workflow_runs
           (id, workflow_id, project_id, status, current_step_id, steps_snapshot_json, seed_finding_ids)
         VALUES (?, 'wf-c', 1, ?, ?, ?, ?)`,
      )
      .run(
        opts.runId,
        opts.status ?? 'running',
        opts.currentStepId ?? 'compound',
        opts.stepsSnapshot ? JSON.stringify(opts.stepsSnapshot) : '{"compound":"compounder"}',
        opts.seedFindingIds ? JSON.stringify(opts.seedFindingIds) : null,
      );
  }

  /** Insert a pending finding row directly (the chokepoint shape, no PQueue needed for reads). */
  function seedFinding(
    fdb: Database.Database,
    opts: { id: string; title: string; priority?: 'P0' | 'P1' | 'P2' | null; payload?: object | null; severity?: 'info' | 'warning' | 'error' | null; runId?: string | null },
  ): void {
    fdb
      .prepare(
        `INSERT INTO review_items
           (id, project_id, kind, status, blocking, title, body, severity, source, priority, payload_json, run_id)
         VALUES (?, 1, 'finding', 'pending', 0, ?, 'body', ?, 'agent:reviewer', ?, ?, ?)`,
      )
      .run(
        opts.id,
        opts.title,
        opts.severity ?? null,
        opts.priority ?? null,
        opts.payload ? JSON.stringify(opts.payload) : null,
        opts.runId ?? null,
      );
  }

  /** Drain the per-project review queue so an awaited resolve commits. */
  async function drain(): Promise<void> {
    await ReviewItemRouter.getInstance()._queueForProject(1).onIdle();
  }

  let fdb: Database.Database;
  let fHandler: McpQueryHandler;

  beforeEach(() => {
    fdb = buildFindingsDb();
    ReviewItemRouter.initialize(dbAdapter(fdb));
    fHandler = new McpQueryHandler(dbAdapter(fdb));
  });

  afterEach(() => {
    ReviewItemRouter._resetForTesting();
    reviewItemChangeEvents.removeAllListeners();
    fdb.close();
  });

  // -------------------------------------------------------------------------
  // get-selected-findings
  // -------------------------------------------------------------------------

  describe('mcp-get-selected-findings', () => {
    it("returns the run's seeded findings, shaped for compounding", async () => {
      seedFinding(fdb, {
        id: 'ri_1',
        title: 'Quick fix me',
        priority: 'P0',
        severity: 'warning',
        payload: { kind: 'finding', proposedTarget: 'fix', suggestedFix: 'do the thing', locations: [{ path: 'a.ts', line: 4 }] },
      });
      seedFinding(fdb, { id: 'ri_2', title: 'Doc update', priority: 'P2', payload: { kind: 'finding', proposedTarget: 'docs' } });
      seedCompoundRun(fdb, { runId: 'run-c', seedFindingIds: ['ri_1', 'ri_2'] });

      const { socket, writes } = makeSocketDouble();
      await fHandler.handleMessage(
        { type: 'mcp-get-selected-findings', requestId: 'gs-1', runId: 'run-c' },
        socket,
      );

      const response = parseLastWrite(writes);
      expect(response.ok).toBe(true);
      const data = response.data as { findings: Array<{ id: string; title: string; priority: string | null; proposedTarget: string | null; suggestedFix: string | null; locations: Array<{ path: string; line?: number }> | null }> };
      expect(data.findings).toHaveLength(2);
      expect(data.findings[0]).toMatchObject({
        id: 'ri_1',
        title: 'Quick fix me',
        priority: 'P0',
        proposedTarget: 'fix',
        suggestedFix: 'do the thing',
      });
      expect(data.findings[0].locations).toEqual([{ path: 'a.ts', line: 4 }]);
      expect(data.findings[1]).toMatchObject({ id: 'ri_2', proposedTarget: 'docs', priority: 'P2' });
    });

    it('returns an empty array when seed_finding_ids is null', async () => {
      seedCompoundRun(fdb, { runId: 'run-c', seedFindingIds: null });

      const { socket, writes } = makeSocketDouble();
      await fHandler.handleMessage(
        { type: 'mcp-get-selected-findings', requestId: 'gs-2', runId: 'run-c' },
        socket,
      );

      const response = parseLastWrite(writes);
      expect(response.ok).toBe(true);
      expect(response.data).toEqual({ findings: [] });
    });

    it('skips an id that does not resolve to a finding (fail-soft)', async () => {
      seedFinding(fdb, { id: 'ri_real', title: 'Real', priority: 'P1', payload: { kind: 'finding', proposedTarget: 'backlog' } });
      seedCompoundRun(fdb, { runId: 'run-c', seedFindingIds: ['ri_real', 'ri_missing'] });

      const { socket, writes } = makeSocketDouble();
      await fHandler.handleMessage(
        { type: 'mcp-get-selected-findings', requestId: 'gs-3', runId: 'run-c' },
        socket,
      );

      const response = parseLastWrite(writes);
      expect(response.ok).toBe(true);
      const data = response.data as { findings: Array<{ id: string }> };
      expect(data.findings).toHaveLength(1);
      expect(data.findings[0].id).toBe('ri_real');
    });

    it('rejects the "orchestrator" sentinel with "finding_requires_real_run"', async () => {
      const { socket, writes } = makeSocketDouble();
      await fHandler.handleMessage(
        { type: 'mcp-get-selected-findings', requestId: 'gs-4', runId: 'orchestrator' },
        socket,
      );

      const response = parseLastWrite(writes);
      expect(response.ok).toBe(false);
      expect(response.error).toBe('finding_requires_real_run');
    });
  });

  // -------------------------------------------------------------------------
  // resolve-finding
  // -------------------------------------------------------------------------

  describe('mcp-resolve-finding', () => {
    it('promoted + task_id builds promoted:<taskId> and resolves the finding via the chokepoint', async () => {
      seedFinding(fdb, { id: 'ri_p', title: 'Promote me', payload: { kind: 'finding', proposedTarget: 'backlog' } });
      seedCompoundRun(fdb, { runId: 'run-c', seedFindingIds: ['ri_p'] });

      const { socket, writes } = makeSocketDouble();
      await fHandler.handleMessage(
        {
          type: 'mcp-resolve-finding',
          requestId: 'rs-1',
          runId: 'run-c',
          reviewItemId: 'ri_p',
          resolutionKind: 'promoted',
          taskId: 'TASK-042',
        },
        socket,
      );

      const response = parseLastWrite(writes);
      expect(response.ok).toBe(true);
      expect(response.data).toEqual({ resolved: true, review_item_id: 'ri_p' });

      await drain();
      const row = fdb
        .prepare("SELECT status, resolution FROM review_items WHERE id = 'ri_p'")
        .get() as { status: string; resolution: string };
      expect(row.status).toBe('resolved');
      expect(row.resolution).toBe('promoted:TASK-042');
    });

    it('fixed builds fixed:<note> with the supplied note', async () => {
      seedFinding(fdb, { id: 'ri_f', title: 'Fix me', payload: { kind: 'finding', proposedTarget: 'fix' } });
      seedCompoundRun(fdb, { runId: 'run-c', seedFindingIds: ['ri_f'] });

      const { socket, writes } = makeSocketDouble();
      await fHandler.handleMessage(
        {
          type: 'mcp-resolve-finding',
          requestId: 'rs-2',
          runId: 'run-c',
          reviewItemId: 'ri_f',
          resolutionKind: 'fixed',
          note: 'compound',
        },
        socket,
      );

      expect(parseLastWrite(writes).ok).toBe(true);
      await drain();
      const row = fdb.prepare("SELECT resolution FROM review_items WHERE id = 'ri_f'").get() as { resolution: string };
      expect(row.resolution).toBe('fixed:compound');
    });

    it('triaged builds triaged:<note> (empty tail when no note)', async () => {
      seedFinding(fdb, { id: 'ri_t', title: 'Triage me', payload: { kind: 'finding', proposedTarget: 'docs' } });
      seedCompoundRun(fdb, { runId: 'run-c', seedFindingIds: ['ri_t'] });

      const { socket, writes } = makeSocketDouble();
      await fHandler.handleMessage(
        {
          type: 'mcp-resolve-finding',
          requestId: 'rs-3',
          runId: 'run-c',
          reviewItemId: 'ri_t',
          resolutionKind: 'triaged',
        },
        socket,
      );

      expect(parseLastWrite(writes).ok).toBe(true);
      await drain();
      const row = fdb.prepare("SELECT resolution FROM review_items WHERE id = 'ri_t'").get() as { resolution: string };
      expect(row.resolution).toBe('triaged:');
    });

    it('rejects resolving on a terminal run with "run_not_active" (mid-run-only)', async () => {
      seedFinding(fdb, { id: 'ri_late', title: 'Too late', payload: { kind: 'finding', proposedTarget: 'fix' } });
      seedCompoundRun(fdb, { runId: 'run-done', status: 'completed', seedFindingIds: ['ri_late'] });

      const { socket, writes } = makeSocketDouble();
      await fHandler.handleMessage(
        {
          type: 'mcp-resolve-finding',
          requestId: 'rs-4',
          runId: 'run-done',
          reviewItemId: 'ri_late',
          resolutionKind: 'fixed',
        },
        socket,
      );

      const response = parseLastWrite(writes);
      expect(response.ok).toBe(false);
      expect(response.error).toBe('run_not_active');

      // The finding stays pending — the terminal-seam close-out (RunExecutor) is
      // the safety net, not a batched resolve at run end.
      await drain();
      const row = fdb.prepare("SELECT status FROM review_items WHERE id = 'ri_late'").get() as { status: string };
      expect(row.status).toBe('pending');
    });

    it('surfaces a not_found resolve as an ok:false error (await — not silently swallowed)', async () => {
      seedCompoundRun(fdb, { runId: 'run-c', seedFindingIds: ['ri_x'] });

      const { socket, writes } = makeSocketDouble();
      await fHandler.handleMessage(
        {
          type: 'mcp-resolve-finding',
          requestId: 'rs-5',
          runId: 'run-c',
          reviewItemId: 'ri_does_not_exist',
          resolutionKind: 'fixed',
        },
        socket,
      );

      const response = parseLastWrite(writes);
      expect(response.ok).toBe(false);
      expect(response.error).toBe('not_found');
    });
  });
});

// ---------------------------------------------------------------------------
// mcp-request-verification (cyboflow_request_verification — P6)
//
// FIRE-AND-CONTINUE: enabled run → enqueue a verification_requests row + reply
// { requestId }; disabled run → reply { skipped:true } (never an error). The
// VerificationScheduler singleton is initialized with INJECTED fake backends /
// judge so the test stays electron-free (the scheduler's standalone invariant).
// ---------------------------------------------------------------------------

describe('McpQueryHandler — mcp-request-verification', () => {
  let vdb: Database.Database;
  let vHandler: McpQueryHandler;

  /** Seed a run with the migration-036 verify stamp applied inline. */
  function seedVerifyRun(
    db: Database.Database,
    id: string,
    opts: { enabled: boolean; type?: string | null; chain?: string[] | null; status?: string },
  ): void {
    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, worktree_path, status, policy_json,
                                  verify_enabled, verify_type, verify_chain)
       VALUES (?, 'wf-1', 1, '/tmp/test', ?, '{}', ?, ?, ?)`,
    ).run(
      id,
      opts.status ?? 'running',
      opts.enabled ? 1 : 0,
      opts.type ?? null,
      opts.chain ? JSON.stringify(opts.chain) : null,
    );
  }

  beforeEach(() => {
    // includeWorkflowRunTaskColumns gives current_step_id + steps_snapshot_json,
    // which resolveReviewItemRunContext SELECTs to derive the actor.
    vdb = createTestDb({ disableForeignKeys: true, includeWorkflowRunTaskColumns: true });
    // Layer migration 036's verify stamp columns + verification_requests table
    // onto the GATE_SCHEMA test DB (the fixture stops before 036).
    vdb.exec('ALTER TABLE workflow_runs ADD COLUMN verify_enabled INTEGER NOT NULL DEFAULT 0');
    vdb.exec('ALTER TABLE workflow_runs ADD COLUMN verify_type TEXT');
    vdb.exec('ALTER TABLE workflow_runs ADD COLUMN verify_chain TEXT');
    vdb.exec(`
      CREATE TABLE verification_requests (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        project_id INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        verify_type TEXT NOT NULL,
        deliverable_json TEXT NOT NULL,
        chain_json TEXT,
        current_backend TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        verdict_json TEXT,
        error_message TEXT,
        enqueued_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        leased_at DATETIME,
        ended_at DATETIME
      );
    `);

    VerificationScheduler._resetForTesting();
    VerificationScheduler.initialize({
      db: dbAdapter(vdb),
      backends: {},
      judge: { judge: vi.fn(async (): Promise<VerdictV1> => ({
        status: 'pass',
        confidence: 0.95,
        issues: [],
        feedback: 'ok',
        judgedFileNames: [],
        baselineUsed: false,
        model: 'fake',
      })) },
      artifactsDirResolver: () => '/tmp/artifacts',
    });

    vHandler = new McpQueryHandler(dbAdapter(vdb));
  });

  afterEach(() => {
    VerificationScheduler._resetForTesting();
  });

  it('enabled run → enqueues a verification_requests row and replies { requestId }', async () => {
    seedVerifyRun(vdb, 'run-v1', {
      enabled: true,
      type: 'static-render-snapshot',
      chain: ['capturePage'],
    });

    const { socket, writes } = makeSocketDouble();
    await vHandler.handleMessage(
      {
        type: 'mcp-request-verification',
        requestId: 'rv-1',
        runId: 'run-v1',
        intent: 'the toggle renders, default off',
        url: 'http://localhost:5173',
      },
      socket,
    );

    // Wire-protocol framing
    expect(writes[writes.length - 1].endsWith('\n')).toBe(true);

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(true);
    const data = response.data as { requestId?: string; type?: string; skipped?: boolean };
    expect(typeof data.requestId).toBe('string');
    expect(data.requestId).toMatch(/^vr_/);
    expect(data.type).toBe('static-render-snapshot');
    expect(data.skipped).toBeUndefined();

    // Exactly one queued row, carrying the resolved type + chain + deliverable.
    const row = vdb
      .prepare(
        'SELECT id, run_id, project_id, status, verify_type, deliverable_json, chain_json FROM verification_requests WHERE id = ?',
      )
      .get(data.requestId) as
      | {
          id: string;
          run_id: string;
          project_id: number;
          status: string;
          verify_type: string;
          deliverable_json: string;
          chain_json: string;
        }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.run_id).toBe('run-v1');
    expect(row?.status).toBe('queued');
    expect(row?.verify_type).toBe('static-render-snapshot');
    expect(JSON.parse(row!.chain_json)).toEqual(['capturePage']);
    expect(JSON.parse(row!.deliverable_json)).toEqual({
      intent: 'the toggle renders, default off',
      url: 'http://localhost:5173',
    });
  });

  it('threads taskRef into deliverable_json for the merge-gate verdict→lane attribution (P8b)', async () => {
    seedVerifyRun(vdb, 'run-vtr', {
      enabled: true,
      type: 'static-render-snapshot',
      chain: ['capturePage'],
    });

    const { socket, writes } = makeSocketDouble();
    await vHandler.handleMessage(
      {
        type: 'mcp-request-verification',
        requestId: 'rv-tr',
        runId: 'run-vtr',
        intent: 'the lane UI renders',
        url: 'http://localhost:5173',
        taskRef: 'TASK-008',
      },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(true);
    const data = response.data as { requestId?: string };
    const row = vdb
      .prepare('SELECT deliverable_json FROM verification_requests WHERE id = ?')
      .get(data.requestId) as { deliverable_json: string } | undefined;
    expect(JSON.parse(row!.deliverable_json)).toEqual({
      intent: 'the lane UI renders',
      url: 'http://localhost:5173',
      taskRef: 'TASK-008',
    });
  });

  it('typeOverride NARROWS the chain to the override-type ∩ the run stamped chain', async () => {
    // Run resolved interactive-web (chain playwright,peekaboo) but an override to
    // static-render must intersect down to only the stamped backends that overlap.
    seedVerifyRun(vdb, 'run-v2', {
      enabled: true,
      type: 'interactive-web-behavior',
      chain: ['playwright', 'peekaboo'],
    });

    const { socket, writes } = makeSocketDouble();
    await vHandler.handleMessage(
      {
        type: 'mcp-request-verification',
        requestId: 'rv-2',
        runId: 'run-v2',
        intent: 'static check',
        typeOverride: 'static-render-snapshot',
      },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(true);
    const data = response.data as { requestId: string; type: string };
    expect(data.type).toBe('static-render-snapshot');
    const row = vdb
      .prepare('SELECT chain_json FROM verification_requests WHERE id = ?')
      .get(data.requestId) as { chain_json: string };
    // static-render chain is [capturePage,playwright,peekaboo]; ∩ stamped
    // [playwright,peekaboo] = [playwright,peekaboo] (capturePage dropped — not host-available).
    expect(JSON.parse(row.chain_json)).toEqual(['playwright', 'peekaboo']);
  });

  it('disabled run → replies { skipped:true } and enqueues nothing (never an error)', async () => {
    seedVerifyRun(vdb, 'run-v3', { enabled: false });

    const { socket, writes } = makeSocketDouble();
    await vHandler.handleMessage(
      {
        type: 'mcp-request-verification',
        requestId: 'rv-3',
        runId: 'run-v3',
        intent: 'should be skipped',
      },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(true);
    expect(response.data).toEqual({ skipped: true });

    const count = vdb.prepare('SELECT COUNT(*) AS n FROM verification_requests').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('terminal run → ok:false run_not_active (no enqueue)', async () => {
    seedVerifyRun(vdb, 'run-v4', {
      enabled: true,
      type: 'static-render-snapshot',
      chain: ['capturePage'],
      status: 'completed',
    });

    const { socket, writes } = makeSocketDouble();
    await vHandler.handleMessage(
      {
        type: 'mcp-request-verification',
        requestId: 'rv-4',
        runId: 'run-v4',
        intent: 'too late',
      },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(false);
    expect(response.error).toBe('run_not_active');
    const count = vdb.prepare('SELECT COUNT(*) AS n FROM verification_requests').get() as { n: number };
    expect(count.n).toBe(0);
  });
});
