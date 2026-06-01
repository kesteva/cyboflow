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
import type Database from 'better-sqlite3';
import { McpQueryHandler, type McpQueryMessage, type McpQueryResponse } from '../mcpQueryHandler';
import type * as net from 'net';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import { createTestDb, seedApproval } from '../../__test_fixtures__/orchestratorTestDb';
import { stepTransitionEvents } from '../../trpc/routers/events';
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
