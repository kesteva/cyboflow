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
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';
import * as os from 'node:os';
import { setCyboflowDirectory, getCyboflowSubdirectory } from '../../../utils/cyboflowDirectory';
import { McpQueryHandler, type McpQueryMessage, type McpQueryResponse } from '../mcpQueryHandler';
import type * as net from 'net';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import { createTestDb, seedApproval, seedQuestion } from '../../__test_fixtures__/orchestratorTestDb';
import { stepTransitionEvents } from '../../trpc/routers/events';
import { TaskChangeRouter, taskChangeEvents } from '../../taskChangeRouter';
import { ReviewItemRouter, reviewItemChangeEvents } from '../../reviewItemRouter';
import { IdeaComponentRouter, ideaComponentChangeEvents } from '../../ideaComponents/ideaComponentRouter';
import { SprintLaneStore, sprintLaneEvents, sprintLaneChannel } from '../../sprintLaneStore';
import { ApprovalRouter } from '../../approvalRouter';
import { QuestionRouter } from '../../questionRouter';
import { VerificationScheduler } from '../../verify/verificationScheduler';
import type { VerificationRequestSummary } from '../../verify/verificationScheduler';
import { VerifyRunbookStore } from '../../verify/runbookStore';
import { VERIFY_RUNBOOK_RELATIVE_PATH } from '../../../../../shared/types/verifyRunbook';
import { QUICK_WORKFLOW_NAME } from '../../workflowRegistry';
import type { VerdictV1, ResolvedVisualVerifyConfig } from '../../../../../shared/types/visualVerification';
import { VISUAL_VERIFY_DEFAULTS } from '../../../../../shared/types/visualVerification';
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

    // -----------------------------------------------------------------------
    // approve-plan silent-pass guard: an orchestrated agent must not COMPLETE
    // the approve-plan human gate until a real gate stamped plan_approved_at.
    // -----------------------------------------------------------------------
    describe('human gate silent-pass guard', () => {
      /** Report DB with execution_model + plan_approved_at (guard reads both). */
      function createGuardDb(): Database.Database {
        const guardDb = createTestDb({
          includeWorkflowRunTaskColumns: true,
          includeQuestionsTable: true,
        });
        // plan_approved_at (migration 042) is not in the base fixture — layer it.
        guardDb.exec('ALTER TABLE workflow_runs ADD COLUMN plan_approved_at TEXT');
        return guardDb;
      }

      /** Seed a `ship` run (built-in def carries approve-plan human:true). */
      function seedShipRun(
        guardDb: Database.Database,
        opts: { executionModel: 'orchestrated' | 'programmatic'; planApprovedAt: string | null },
      ): string {
        const workflowId = `wf-ship-${Math.random().toString(36).slice(2)}`;
        const runId = `run-ship-${Math.random().toString(36).slice(2)}`;
        guardDb
          .prepare(`INSERT INTO workflows (id, project_id, name, spec_json) VALUES (?, 1, 'ship', '{}')`)
          .run(workflowId);
        guardDb
          .prepare(
            `INSERT INTO workflow_runs (id, workflow_id, project_id, worktree_path, status, execution_model, plan_approved_at)
             VALUES (?, ?, 1, '/tmp/test', 'running', ?, ?)`,
          )
          .run(runId, workflowId, opts.executionModel, opts.planApprovedAt);
        return runId;
      }

      let guardDb: Database.Database;
      let guardHandler: McpQueryHandler;
      let guardEmitted: WorkflowStepTransitionEvent[];

      beforeEach(() => {
        guardDb = createGuardDb();
        guardHandler = new McpQueryHandler(dbAdapter(guardDb));
        guardEmitted = [];
        stepTransitionEvents.on('transition', (ev: WorkflowStepTransitionEvent) => {
          guardEmitted.push(ev);
        });
      });

      afterEach(() => {
        stepTransitionEvents.removeAllListeners('transition');
        guardDb.close();
      });

      it('REJECTS approve-plan done for an orchestrated run with plan_approved_at NULL, writing no transition', async () => {
        const runId = seedShipRun(guardDb, { executionModel: 'orchestrated', planApprovedAt: null });

        const { socket, writes } = makeSocketDouble();
        await guardHandler.handleMessage(
          { type: 'mcp-report-step', requestId: 'g-1', runId, stepId: 'approve-plan', status: 'done' },
          socket,
        );

        const response = parseLastWrite(writes);
        expect(response.ok).toBe(false);
        expect(response.error).toContain('approve_plan_gate_not_resolved');
        // The transition never persisted — current_step_id untouched, no event.
        expect(currentStepId(guardDb, runId)).toBeNull();
        expect(guardEmitted).toHaveLength(0);
      });

      it('ALLOWS approve-plan done once plan_approved_at is stamped', async () => {
        const runId = seedShipRun(guardDb, {
          executionModel: 'orchestrated',
          planApprovedAt: '2026-07-16T18:00:00.000Z',
        });

        const { socket, writes } = makeSocketDouble();
        await guardHandler.handleMessage(
          { type: 'mcp-report-step', requestId: 'g-2', runId, stepId: 'approve-plan', status: 'done' },
          socket,
        );

        const response = parseLastWrite(writes);
        expect(response.ok).toBe(true);
        expect(currentStepId(guardDb, runId)).toBe('approve-plan');
        expect(guardEmitted).toHaveLength(1);
      });

      it('does NOT guard programmatic runs (the deterministic driver owns that gate)', async () => {
        const runId = seedShipRun(guardDb, { executionModel: 'programmatic', planApprovedAt: null });

        const { socket, writes } = makeSocketDouble();
        await guardHandler.handleMessage(
          { type: 'mcp-report-step', requestId: 'g-3', runId, stepId: 'approve-plan', status: 'done' },
          socket,
        );

        const response = parseLastWrite(writes);
        expect(response.ok).toBe(true);
        expect(currentStepId(guardDb, runId)).toBe('approve-plan');
      });

      it('only guards the "done" transition — reporting approve-plan running is allowed', async () => {
        const runId = seedShipRun(guardDb, { executionModel: 'orchestrated', planApprovedAt: null });

        const { socket, writes } = makeSocketDouble();
        await guardHandler.handleMessage(
          { type: 'mcp-report-step', requestId: 'g-4', runId, stepId: 'approve-plan', status: 'running' },
          socket,
        );

        const response = parseLastWrite(writes);
        expect(response.ok).toBe(true);
        expect(currentStepId(guardDb, runId)).toBe('approve-plan');
      });

      // --------------------------------------------------------------------
      // Generic branch: human gates OTHER than approve-plan (approve-idea,
      // approve-design, human-review) have no plan_approved_at signal, so the
      // guard checks for a `questions` row created at/after the step's
      // most-recent 'running' onset (from step_transition raw_events).
      // human-review is a `human:true` ship step used as the representative.
      // --------------------------------------------------------------------

      /** Drive the step's 'running' report through the handler → writes the raw_events onset. */
      async function reportRunning(runId: string, stepId: string): Promise<void> {
        const { socket } = makeSocketDouble();
        await guardHandler.handleMessage(
          { type: 'mcp-report-step', requestId: `run-${stepId}`, runId, stepId, status: 'running' },
          socket,
        );
      }

      it('REJECTS human-review done on an orchestrated run when no gate was surfaced', async () => {
        const runId = seedShipRun(guardDb, { executionModel: 'orchestrated', planApprovedAt: null });
        await reportRunning(runId, 'human-review'); // records the onset; no question follows

        const { socket, writes } = makeSocketDouble();
        await guardHandler.handleMessage(
          { type: 'mcp-report-step', requestId: 'h-1', runId, stepId: 'human-review', status: 'done' },
          socket,
        );

        const response = parseLastWrite(writes);
        expect(response.ok).toBe(false);
        expect(response.error).toContain('human_gate_not_surfaced');
        expect(response.error).toContain('human-review');
        // 'running' persisted current_step_id, but the guarded 'done' did not advance it.
        expect(currentStepId(guardDb, runId)).toBe('human-review');
      });

      it('ALLOWS human-review done when a gate question was surfaced since the step onset', async () => {
        const runId = seedShipRun(guardDb, { executionModel: 'orchestrated', planApprovedAt: null });
        await reportRunning(runId, 'human-review');
        // A gate question surfaced during the step (created well after the onset).
        seedQuestion(guardDb, { runId, status: 'answered', createdAt: '2099-01-01T00:00:00.000Z' });

        const { socket, writes } = makeSocketDouble();
        await guardHandler.handleMessage(
          { type: 'mcp-report-step', requestId: 'h-2', runId, stepId: 'human-review', status: 'done' },
          socket,
        );

        const response = parseLastWrite(writes);
        expect(response.ok).toBe(true);
        expect(currentStepId(guardDb, runId)).toBe('human-review');
      });

      it('a question from an EARLIER step (before this onset) does NOT count as surfaced', async () => {
        const runId = seedShipRun(guardDb, { executionModel: 'orchestrated', planApprovedAt: null });
        // A stale gate from an earlier step, resolved long before human-review began.
        seedQuestion(guardDb, { runId, status: 'answered', createdAt: '2000-01-01T00:00:00.000Z' });
        await reportRunning(runId, 'human-review'); // onset is real-now, after the stale question

        const { socket, writes } = makeSocketDouble();
        await guardHandler.handleMessage(
          { type: 'mcp-report-step', requestId: 'h-3', runId, stepId: 'human-review', status: 'done' },
          socket,
        );

        const response = parseLastWrite(writes);
        expect(response.ok).toBe(false);
        expect(response.error).toContain('human_gate_not_surfaced');
      });

      it('does NOT guard human-review on programmatic runs (the deterministic driver owns it)', async () => {
        const runId = seedShipRun(guardDb, { executionModel: 'programmatic', planApprovedAt: null });
        await reportRunning(runId, 'human-review'); // no question — would trip the orchestrated guard

        const { socket, writes } = makeSocketDouble();
        await guardHandler.handleMessage(
          { type: 'mcp-report-step', requestId: 'h-4', runId, stepId: 'human-review', status: 'done' },
          socket,
        );

        const response = parseLastWrite(writes);
        expect(response.ok).toBe(true);
        expect(currentStepId(guardDb, runId)).toBe('human-review');
      });

      it('fails open when no "running" onset was recorded (window unbounded)', async () => {
        const runId = seedShipRun(guardDb, { executionModel: 'orchestrated', planApprovedAt: null });
        // Report 'done' directly — no prior 'running', so the onset window can't be bounded.

        const { socket, writes } = makeSocketDouble();
        await guardHandler.handleMessage(
          { type: 'mcp-report-step', requestId: 'h-5', runId, stepId: 'human-review', status: 'done' },
          socket,
        );

        const response = parseLastWrite(writes);
        expect(response.ok).toBe(true);
        expect(currentStepId(guardDb, runId)).toBe('human-review');
      });
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
      // (archived_at columns + position-11 stage removal) -> 042 (board collapse
      // to 4 stages 1/6/9/10 + decomposed_at/approved_at/plan_approved_at stamps;
      // readEntity SELECTs decomposed_at, so this column MUST exist).
      taskDb.exec(readFileSync(join(migDir, '006_cyboflow_schema.sql'), 'utf-8'));
      taskDb.exec(readFileSync(join(migDir, '011_workflow_step_tracking.sql'), 'utf-8'));
      taskDb.exec(readFileSync(join(migDir, '014_native_tasks.sql'), 'utf-8'));
      taskDb.exec(readFileSync(join(migDir, '015_entity_model_rebuild.sql'), 'utf-8'));
      taskDb.exec(readFileSync(join(migDir, '024_archive_in_place.sql'), 'utf-8'));
      taskDb.exec(readFileSync(join(migDir, '028_idea_attachments.sql'), 'utf-8'));
      taskDb.exec(readFileSync(join(migDir, '042_collapse_board.sql'), 'utf-8'));
      // Migration 057: the read-side UNION projects sort_order unconditionally.
      taskDb.exec(readFileSync(join(migDir, '057_entity_sort_order.sql'), 'utf-8'));
      // Migration 059: category (feature|bug|chore) — an unconditional column in
      // insertEntity/readEntity now (mirrors priority), so every create needs it.
      taskDb.exec(readFileSync(join(migDir, '059_entity_category.sql'), 'utf-8'));
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

      it('persists scope on the created idea', async () => {
        seedTaskRun(taskDb, {
          runId: 'run-1',
          currentStepId: 'plan',
          stepsSnapshot: { plan: 'planner' },
        });

        const { socket, writes } = makeSocketDouble();
        await taskHandler.handleMessage(
          {
            type: 'mcp-create-task',
            requestId: 'ct-scope',
            runId: 'run-1',
            title: 'Scoped idea',
            scope: 'small',
          },
          socket,
        );

        const response = parseLastWrite(writes);
        expect(response.ok).toBe(true);
        const data = response.data as { task_id: string };

        const row = taskDb
          .prepare('SELECT scope FROM ideas WHERE id = ?')
          .get(data.task_id) as { scope: string | null };
        expect(row.scope).toBe('small');
      });

      it('leaves scope NULL when omitted on create', async () => {
        seedTaskRun(taskDb, {
          runId: 'run-1',
          currentStepId: 'plan',
          stepsSnapshot: { plan: 'planner' },
        });

        const { socket, writes } = makeSocketDouble();
        await taskHandler.handleMessage(
          { type: 'mcp-create-task', requestId: 'ct-noscope', runId: 'run-1', title: 'Unscoped idea' },
          socket,
        );

        const response = parseLastWrite(writes);
        expect(response.ok).toBe(true);
        const data = response.data as { task_id: string };

        const row = taskDb
          .prepare('SELECT scope FROM ideas WHERE id = ?')
          .get(data.task_id) as { scope: string | null };
        expect(row.scope).toBeNull();
      });

      it('resolves originating_idea_id supplied as a display ref (IDEA-001) to the opaque idea id', async () => {
        seedTaskRun(taskDb, { runId: 'run-1', currentStepId: 'plan', stepsSnapshot: { plan: 'planner' } });

        const { socket: ideaSocket, writes: ideaWrites } = makeSocketDouble();
        await taskHandler.handleMessage(
          { type: 'mcp-create-task', requestId: 'ct-origin-seed', runId: 'run-1', title: 'Seed idea' },
          ideaSocket,
        );
        const idea = parseLastWrite(ideaWrites).data as { task_id: string; ref: string };
        expect(idea.ref).toBe('IDEA-001');

        const { socket, writes } = makeSocketDouble();
        await taskHandler.handleMessage(
          {
            type: 'mcp-create-task',
            requestId: 'ct-origin-ref',
            runId: 'run-1',
            title: 'A task',
            taskType: 'task',
            originatingIdeaId: idea.ref,
          },
          socket,
        );

        const response = parseLastWrite(writes);
        expect(response.ok).toBe(true);
        const data = response.data as { task_id: string };

        const row = taskDb
          .prepare('SELECT originating_idea_id FROM tasks WHERE id = ?')
          .get(data.task_id) as { originating_idea_id: string | null };
        expect(row.originating_idea_id).toBe(idea.task_id);
      });

      it('accepts originating_idea_id supplied as the opaque idea id unchanged', async () => {
        seedTaskRun(taskDb, { runId: 'run-1', currentStepId: 'plan', stepsSnapshot: { plan: 'planner' } });

        const { socket: ideaSocket, writes: ideaWrites } = makeSocketDouble();
        await taskHandler.handleMessage(
          { type: 'mcp-create-task', requestId: 'ct-origin-seed2', runId: 'run-1', title: 'Seed idea' },
          ideaSocket,
        );
        const idea = parseLastWrite(ideaWrites).data as { task_id: string; ref: string };

        const { socket, writes } = makeSocketDouble();
        await taskHandler.handleMessage(
          {
            type: 'mcp-create-task',
            requestId: 'ct-origin-id',
            runId: 'run-1',
            title: 'An epic',
            taskType: 'epic',
            originatingIdeaId: idea.task_id,
          },
          socket,
        );

        const response = parseLastWrite(writes);
        expect(response.ok).toBe(true);
        const data = response.data as { task_id: string };

        const row = taskDb
          .prepare('SELECT originating_idea_id FROM epics WHERE id = ?')
          .get(data.task_id) as { originating_idea_id: string | null };
        expect(row.originating_idea_id).toBe(idea.task_id);
      });

      it('ignores originating_idea_id supplied on an idea create instead of rejecting it', async () => {
        seedTaskRun(taskDb, { runId: 'run-1', currentStepId: 'plan', stepsSnapshot: { plan: 'planner' } });

        const { socket, writes } = makeSocketDouble();
        await taskHandler.handleMessage(
          {
            type: 'mcp-create-task',
            requestId: 'ct-origin-idea',
            runId: 'run-1',
            title: 'A plain idea',
            originatingIdeaId: 'ide_does_not_exist',
          },
          socket,
        );

        // Would be invalid_lineage if the field reached the chokepoint — instead
        // it is dropped before the TaskChange is built (mirrors scope-on-epic).
        const response = parseLastWrite(writes);
        expect(response.ok).toBe(true);
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

      it('persists scope on update', async () => {
        seedTaskRun(taskDb, {
          runId: 'run-1',
          currentStepId: 'plan',
          stepsSnapshot: { plan: 'planner' },
        });

        const created = makeSocketDouble();
        await taskHandler.handleMessage(
          { type: 'mcp-create-task', requestId: 'ct-seed-scope', runId: 'run-1', title: 'Grows up' },
          created.socket,
        );
        const taskId = (parseLastWrite(created.writes).data as { task_id: string }).task_id;

        const { socket, writes } = makeSocketDouble();
        await taskHandler.handleMessage(
          {
            type: 'mcp-update-task',
            requestId: 'ut-scope',
            runId: 'run-1',
            taskId,
            scope: 'large',
          },
          socket,
        );

        const response = parseLastWrite(writes);
        expect(response.ok).toBe(true);

        const row = taskDb
          .prepare('SELECT scope FROM ideas WHERE id = ?')
          .get(taskId) as { scope: string | null };
        expect(row.scope).toBe('large');
      });

      it('leaves scope untouched when omitted on update', async () => {
        seedTaskRun(taskDb, {
          runId: 'run-1',
          currentStepId: 'plan',
          stepsSnapshot: { plan: 'planner' },
        });

        const created = makeSocketDouble();
        await taskHandler.handleMessage(
          {
            type: 'mcp-create-task',
            requestId: 'ct-seed-scope2',
            runId: 'run-1',
            title: 'Stays scoped',
            scope: 'small',
          },
          created.socket,
        );
        const taskId = (parseLastWrite(created.writes).data as { task_id: string }).task_id;

        const { socket, writes } = makeSocketDouble();
        await taskHandler.handleMessage(
          {
            type: 'mcp-update-task',
            requestId: 'ut-noscope',
            runId: 'run-1',
            taskId,
            title: 'Renamed only',
          },
          socket,
        );

        const response = parseLastWrite(writes);
        expect(response.ok).toBe(true);

        const row = taskDb
          .prepare('SELECT scope FROM ideas WHERE id = ?')
          .get(taskId) as { scope: string | null };
        expect(row.scope).toBe('small');
      });
    });

    // -----------------------------------------------------------------------
    // set-stage
    // -----------------------------------------------------------------------

    describe('mcp-set-task-stage', () => {
      it('moves an idea to an asserted stage (position 6, Ready for development) -> ok:true', async () => {
        // 042 collapsed the board to 1/6/9/10; position 6 ('Ready for
        // development') is the kept non-terminal asserted stage (old position 3
        // 'Idea spec' was removed).
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
            stageId: stage(6),
          },
          socket,
        );

        const response = parseLastWrite(writes);
        expect(response.ok).toBe(true);
        const data = response.data as { task_id: string; stage_id?: string; version?: number };
        expect(data.task_id).toBe(taskId);
        expect(data.stage_id).toBe(stage(6));

        const task = taskDb
          .prepare('SELECT stage_id FROM ideas WHERE id = ?')
          .get(taskId) as { stage_id: string };
        expect(task.stage_id).toBe(stage(6));
      });

      // Removed (042 board collapse): the position-12 'Decomposed' agent-move
      // test and the position-7 'derived stage forbidden' test no longer have a
      // premise — positions 7/8 (the only derived stages) and position 12 are
      // gone, so no seeded stage is derived. Decomposition is now a gate-only
      // decomposed_at stamp covered by the questionRouter gate tests.

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
  // Read-only backlog listing — mcp-list-tasks / mcp-get-task. Both reuse
  // resolveTaskRunContext (project scope only; the actor it returns is unused
  // for reads) and never write. Uses its own migration-backed DB seeded with
  // TWO projects BEFORE the migrations run so BOTH get a default board +
  // stages (014's seed is a one-time INSERT ... SELECT FROM projects) — the
  // cross-project guard test needs project 2 to have a real board to host an
  // entity.
  // -------------------------------------------------------------------------

  describe('read-only backlog listing (mcp-list-tasks / mcp-get-task)', () => {
    function buildListDb(): Database.Database {
      const db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      db.exec(`
        CREATE TABLE projects (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          path TEXT NOT NULL UNIQUE,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);
      db.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Proj', '/tmp/lp1');
      db.prepare('INSERT INTO projects (id, name, path) VALUES (2, ?, ?)').run('Proj Two', '/tmp/lp2');

      const migDir = join(__dirname, '..', '..', '..', 'database', 'migrations');
      db.exec(readFileSync(join(migDir, '006_cyboflow_schema.sql'), 'utf-8'));
      db.exec(readFileSync(join(migDir, '011_workflow_step_tracking.sql'), 'utf-8'));
      db.exec(readFileSync(join(migDir, '014_native_tasks.sql'), 'utf-8'));
      db.exec(readFileSync(join(migDir, '015_entity_model_rebuild.sql'), 'utf-8'));
      db.exec(readFileSync(join(migDir, '024_archive_in_place.sql'), 'utf-8'));
      db.exec(readFileSync(join(migDir, '028_idea_attachments.sql'), 'utf-8'));
      db.exec(readFileSync(join(migDir, '042_collapse_board.sql'), 'utf-8'));
      // Migration 049 adds the A/B experiment sandbox tag to all three entity
      // tables; the read-side UNION (selectProjectBacklog) now projects
      // experiment_id, so the fixture needs it. Migration 048 stamps
      // experiment_id/experiment_arm on runs, 053 stamps experiment_arm on
      // entities — both needed for the get_task arm-scoping read guard.
      db.exec('ALTER TABLE ideas ADD COLUMN experiment_id TEXT');
      db.exec('ALTER TABLE epics ADD COLUMN experiment_id TEXT');
      db.exec('ALTER TABLE tasks ADD COLUMN experiment_id TEXT');
      db.exec('ALTER TABLE workflow_runs ADD COLUMN experiment_id TEXT');
      db.exec('ALTER TABLE workflow_runs ADD COLUMN experiment_arm TEXT');
      db.exec('ALTER TABLE ideas ADD COLUMN experiment_arm TEXT');
      db.exec('ALTER TABLE epics ADD COLUMN experiment_arm TEXT');
      db.exec('ALTER TABLE tasks ADD COLUMN experiment_arm TEXT');
      // Migration 057: the read-side UNION projects sort_order unconditionally.
      db.exec(readFileSync(join(migDir, '057_entity_sort_order.sql'), 'utf-8'));
      // Migration 059: category (feature|bug|chore) — an unconditional column in
      // insertEntity/readEntity now (mirrors priority), so every create needs it.
      db.exec(readFileSync(join(migDir, '059_entity_category.sql'), 'utf-8'));
      // Migration 085 (Design Mode v0): handleGetTask now unconditionally reads
      // approved_designs for every idea — the table must exist even for tests
      // that never touch design sessions. The fixture's minimal schema has no
      // `sessions`/`artifacts` tables (006 doesn't create them), so this seeds
      // ONLY the approved_designs table verbatim from migration 085 (its other
      // statements ALTER those two tables and would fail against this fixture).
      db.exec(`
        CREATE TABLE approved_designs (
          id TEXT PRIMARY KEY,
          idea_id TEXT NOT NULL,
          project_id INTEGER NOT NULL,
          handoff_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          draft_revision INTEGER NOT NULL,
          prototype_artifact_id TEXT NOT NULL,
          prototype_revision INTEGER NOT NULL,
          snapshot_path TEXT NOT NULL,
          approved_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          superseded_at DATETIME
        );
        CREATE INDEX idx_approved_designs_idea ON approved_designs(idea_id);
      `);
      // Migration 101 (idea component ledger): handleGetTask now unconditionally
      // resolves cyboflow_get_task's 'components' for every idea via
      // resolveIdeaComponents — the table must exist even for tests that never
      // touch the ledger directly (same rationale as approved_designs above).
      // A minimal 'artifacts' table (migration 035, not otherwise in this
      // fixture's chain) is ALSO needed: an idea created via createEntity()
      // below is linked to its creating run through a real entity_events row
      // (run_id set), so resolveIdeaComponentsBatch's 'prototype' derivation
      // arm queries `artifacts` for that run id even when nothing was ever
      // minted against it.
      db.exec(readFileSync(join(migDir, '101_idea_component_ledger.sql'), 'utf-8'));
      db.exec(`
        CREATE TABLE artifacts (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          atype TEXT NOT NULL
        );
      `);
      return db;
    }

    function listSeedRun(db: Database.Database, runId: string, projectId = 1): void {
      db.prepare(
        `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-list', ?, 'sprint', '{}')`,
      ).run(projectId);
      db.prepare(
        `INSERT INTO workflow_runs
           (id, workflow_id, project_id, status, current_step_id, steps_snapshot_json)
         VALUES (?, 'wf-list', ?, 'running', 'plan', ?)`,
      ).run(runId, projectId, JSON.stringify({ plan: 'planner' }));
    }

    /** Seed an experiment-ARM run (migration 048) so its creates are tagged + arm-scoped. */
    function listSeedArmRun(
      db: Database.Database,
      runId: string,
      experimentId: string,
      arm: 'A' | 'B',
      projectId = 1,
    ): void {
      db.prepare(
        `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-list', ?, 'sprint', '{}')`,
      ).run(projectId);
      db.prepare(
        `INSERT INTO workflow_runs
           (id, workflow_id, project_id, status, current_step_id, steps_snapshot_json, experiment_id, experiment_arm)
         VALUES (?, 'wf-list', ?, 'running', 'plan', ?, ?, ?)`,
      ).run(runId, projectId, JSON.stringify({ plan: 'planner' }), experimentId, arm);
    }

    let listDb: Database.Database;
    let listHandler: McpQueryHandler;

    beforeEach(() => {
      listDb = buildListDb();
      TaskChangeRouter.initialize(dbAdapter(listDb));
      listHandler = new McpQueryHandler(dbAdapter(listDb));
    });

    afterEach(() => {
      TaskChangeRouter._resetForTesting();
      IdeaComponentRouter._resetForTesting();
      taskChangeEvents.removeAllListeners();
      ideaComponentChangeEvents.removeAllListeners();
    });

    /** Create an entity via the real mcp-create-task handler; returns its id + ref. */
    async function createEntity(
      runId: string,
      title: string,
      taskType?: 'idea' | 'epic' | 'task',
    ): Promise<{ id: string; ref: string }> {
      const { socket, writes } = makeSocketDouble();
      await listHandler.handleMessage(
        {
          type: 'mcp-create-task',
          requestId: `lc-${title}`,
          runId,
          title,
          ...(taskType !== undefined ? { taskType } : {}),
        },
        socket,
      );
      const data = parseLastWrite(writes).data as { task_id: string; ref: string };
      return { id: data.task_id, ref: data.ref };
    }

    describe('mcp-list-tasks', () => {
      it('happy path: returns compact items for every entity in the project, with total + hidden_count=0', async () => {
        listSeedRun(listDb, 'run-list-1');
        const idea = await createEntity('run-list-1', 'An idea');
        const task = await createEntity('run-list-1', 'A task', 'task');

        const { socket, writes } = makeSocketDouble();
        await listHandler.handleMessage(
          { type: 'mcp-list-tasks', requestId: 'lt-1', runId: 'run-list-1' },
          socket,
        );

        const response = parseLastWrite(writes);
        expect(response.ok).toBe(true);
        const data = response.data as {
          tasks: Array<Record<string, unknown>>;
          total: number;
          hidden_count: number;
        };
        expect(data.total).toBe(2);
        expect(data.hidden_count).toBe(0);

        const ideaItem = data.tasks.find((t) => t['id'] === idea.id)!;
        expect(ideaItem).toMatchObject({
          id: idea.id,
          ref: idea.ref,
          type: 'idea',
          title: 'An idea',
          archived: false,
          decomposed: false,
          approved: false,
          is_done: false,
        });
        // Compact shape deliberately excludes body / inFlow / children.
        expect(ideaItem['body']).toBeUndefined();
        expect(ideaItem['inFlow']).toBeUndefined();
        expect(ideaItem['children']).toBeUndefined();

        const taskItem = data.tasks.find((t) => t['id'] === task.id)!;
        expect(taskItem['type']).toBe('task');
        expect(taskItem['blocked_by']).toEqual([]);
        expect(taskItem['ready_to_work']).toBe(true);
      });

      it('hides archived items by default and reports hidden_count; include_archived surfaces them', async () => {
        listSeedRun(listDb, 'run-list-2');
        const idea = await createEntity('run-list-2', 'Archived idea');
        await createEntity('run-list-2', 'Visible idea');
        listDb.prepare('UPDATE ideas SET archived_at = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', idea.id);

        const defaultRes = makeSocketDouble();
        await listHandler.handleMessage(
          { type: 'mcp-list-tasks', requestId: 'lt-2a', runId: 'run-list-2' },
          defaultRes.socket,
        );
        const defaultData = parseLastWrite(defaultRes.writes).data as {
          tasks: unknown[];
          total: number;
          hidden_count: number;
        };
        expect(defaultData.total).toBe(1);
        expect(defaultData.hidden_count).toBe(1);

        const includeRes = makeSocketDouble();
        await listHandler.handleMessage(
          { type: 'mcp-list-tasks', requestId: 'lt-2b', runId: 'run-list-2', includeArchived: true },
          includeRes.socket,
        );
        const includeData = parseLastWrite(includeRes.writes).data as {
          tasks: Array<{ id: string; archived: boolean }>;
          total: number;
          hidden_count: number;
        };
        expect(includeData.total).toBe(2);
        expect(includeData.hidden_count).toBe(0);
        expect(includeData.tasks.find((t) => t.id === idea.id)?.archived).toBe(true);
      });

      it('filters by task_type', async () => {
        listSeedRun(listDb, 'run-list-3');
        await createEntity('run-list-3', 'An idea');
        const task = await createEntity('run-list-3', 'A task', 'task');

        const { socket, writes } = makeSocketDouble();
        await listHandler.handleMessage(
          { type: 'mcp-list-tasks', requestId: 'lt-3', runId: 'run-list-3', taskType: 'task' },
          socket,
        );
        const data = parseLastWrite(writes).data as { tasks: Array<{ id: string; type: string }> };
        expect(data.tasks).toHaveLength(1);
        expect(data.tasks[0]).toMatchObject({ id: task.id, type: 'task' });
      });

      it('rejects an unknown runId with "run_not_found"', async () => {
        const { socket, writes } = makeSocketDouble();
        await listHandler.handleMessage(
          { type: 'mcp-list-tasks', requestId: 'lt-4', runId: 'does-not-exist' },
          socket,
        );
        const response = parseLastWrite(writes);
        expect(response.ok).toBe(false);
        expect(response.error).toBe('run_not_found');
      });

      it('surfaces category in the compact projection (TASK-054, defaults to "feature")', async () => {
        listSeedRun(listDb, 'run-list-cat');
        const idea = await createEntity('run-list-cat', 'Feature idea');

        const { socket, writes } = makeSocketDouble();
        await listHandler.handleMessage(
          { type: 'mcp-list-tasks', requestId: 'lt-cat', runId: 'run-list-cat' },
          socket,
        );
        const data = parseLastWrite(writes).data as { tasks: Array<Record<string, unknown>> };
        const item = data.tasks.find((t) => t['id'] === idea.id)!;
        expect(item['category']).toBe('feature');
      });
    });

    describe('mcp-get-task', () => {
      it('fetches a task by its opaque id, including the full body and excluding inFlow', async () => {
        listSeedRun(listDb, 'run-get-1');
        const created = await createEntity('run-get-1', 'Spec idea');
        // Fold a body onto it so the full-projection assertion has something to check.
        await listHandler.handleMessage(
          {
            type: 'mcp-update-task',
            requestId: 'lu-1',
            runId: 'run-get-1',
            taskId: created.id,
            body: '## Idea spec\n\ndetail',
          },
          makeSocketDouble().socket,
        );

        const { socket, writes } = makeSocketDouble();
        await listHandler.handleMessage(
          { type: 'mcp-get-task', requestId: 'gt-1', runId: 'run-get-1', taskId: created.id },
          socket,
        );

        const response = parseLastWrite(writes);
        expect(response.ok).toBe(true);
        const data = response.data as { task: Record<string, unknown> };
        expect(data.task['id']).toBe(created.id);
        expect(data.task['ref']).toBe(created.ref);
        expect(data.task['body']).toBe('## Idea spec\n\ndetail');
        expect(data.task['inFlow']).toBeUndefined();
      });

      it('fetches the same task by its display ref', async () => {
        listSeedRun(listDb, 'run-get-2');
        const created = await createEntity('run-get-2', 'Ref idea');

        const { socket, writes } = makeSocketDouble();
        await listHandler.handleMessage(
          { type: 'mcp-get-task', requestId: 'gt-2', runId: 'run-get-2', taskId: created.ref },
          socket,
        );

        const response = parseLastWrite(writes);
        expect(response.ok).toBe(true);
        const data = response.data as { task: Record<string, unknown> };
        expect(data.task['id']).toBe(created.id);
      });

      it('round-trips category (TASK-054): an MCP-created "bug" is readable, and an MCP-updated "chore" is readable', async () => {
        listSeedRun(listDb, 'run-get-cat');
        const created = makeSocketDouble();
        await listHandler.handleMessage(
          {
            type: 'mcp-create-task',
            requestId: 'ct-cat',
            runId: 'run-get-cat',
            title: 'Bug idea',
            category: 'bug',
          },
          created.socket,
        );
        const { task_id: taskId } = parseLastWrite(created.writes).data as { task_id: string };

        const afterCreate = makeSocketDouble();
        await listHandler.handleMessage(
          { type: 'mcp-get-task', requestId: 'gt-cat-1', runId: 'run-get-cat', taskId },
          afterCreate.socket,
        );
        const dataAfterCreate = parseLastWrite(afterCreate.writes).data as { task: Record<string, unknown> };
        expect(dataAfterCreate.task['category']).toBe('bug');

        await listHandler.handleMessage(
          {
            type: 'mcp-update-task',
            requestId: 'ut-cat',
            runId: 'run-get-cat',
            taskId,
            category: 'chore',
          },
          makeSocketDouble().socket,
        );

        const afterUpdate = makeSocketDouble();
        await listHandler.handleMessage(
          { type: 'mcp-get-task', requestId: 'gt-cat-2', runId: 'run-get-cat', taskId },
          afterUpdate.socket,
        );
        const dataAfterUpdate = parseLastWrite(afterUpdate.writes).data as { task: Record<string, unknown> };
        expect(dataAfterUpdate.task['category']).toBe('chore');
      });

      it('returns "not_found" for a ref that does not exist', async () => {
        listSeedRun(listDb, 'run-get-3');

        const { socket, writes } = makeSocketDouble();
        await listHandler.handleMessage(
          { type: 'mcp-get-task', requestId: 'gt-3', runId: 'run-get-3', taskId: 'TASK-999' },
          socket,
        );

        const response = parseLastWrite(writes);
        expect(response.ok).toBe(false);
        expect(response.error).toBe('not_found');
      });

      it('returns "not_found" (never leaks the entity) when the id belongs to a DIFFERENT project', async () => {
        // Seed project 2's entity DIRECTLY — project 2 has a real board/stages
        // (seeded before the migrations ran, see buildListDb) — bypassing the
        // chokepoint since no run is bound to project 2 in this test.
        const otherIdeaId = 'ide_other_proj';
        listDb
          .prepare(
            `INSERT INTO ideas (id, project_id, ref, title, board_id, stage_id, created_at)
             VALUES (?, 2, 'IDEA-001', 'Other project idea', 'board-2-default', 'stage-board-2-default-1', '2026-01-01T00:00:00.000Z')`,
          )
          .run(otherIdeaId);

        listSeedRun(listDb, 'run-get-4', 1); // bound to project 1

        const { socket, writes } = makeSocketDouble();
        await listHandler.handleMessage(
          { type: 'mcp-get-task', requestId: 'gt-4', runId: 'run-get-4', taskId: otherIdeaId },
          socket,
        );

        const response = parseLastWrite(writes);
        expect(response.ok).toBe(false);
        expect(response.error).toBe('not_found');
      });

      it('ARM SCOPING (migration 053): the sibling arm gets "not_found"; the owning arm fetches its own entity', async () => {
        // Arm A creates a hidden, experiment-tagged idea.
        listSeedArmRun(listDb, 'run-arm-a', 'exp-ab', 'A');
        const armAEntity = await createEntity('run-arm-a', 'Arm A work');

        // The SIBLING arm (same experiment_id 'exp-ab', arm B) knows the id but must
        // NOT be able to read it — the pre-053 guard allowed this because both arms
        // shared experiment_id. Indistinguishable from a genuine miss.
        listSeedArmRun(listDb, 'run-arm-b', 'exp-ab', 'B');
        {
          const { socket, writes } = makeSocketDouble();
          await listHandler.handleMessage(
            { type: 'mcp-get-task', requestId: 'gt-arm-b', runId: 'run-arm-b', taskId: armAEntity.id },
            socket,
          );
          const response = parseLastWrite(writes);
          expect(response.ok).toBe(false);
          expect(response.error).toBe('not_found');
        }

        // A NON-experiment run is likewise denied the hidden entity.
        listSeedRun(listDb, 'run-plain');
        {
          const { socket, writes } = makeSocketDouble();
          await listHandler.handleMessage(
            { type: 'mcp-get-task', requestId: 'gt-plain', runId: 'run-plain', taskId: armAEntity.id },
            socket,
          );
          expect(parseLastWrite(writes).error).toBe('not_found');
        }

        // The OWNING arm (A) fetches its own entity normally (control).
        {
          const { socket, writes } = makeSocketDouble();
          await listHandler.handleMessage(
            { type: 'mcp-get-task', requestId: 'gt-arm-a', runId: 'run-arm-a', taskId: armAEntity.id },
            socket,
          );
          const response = parseLastWrite(writes);
          expect(response.ok).toBe(true);
          expect((response.data as { task: Record<string, unknown> }).task['id']).toBe(armAEntity.id);
        }
      });
    });

    // -----------------------------------------------------------------------
    // IDEA-006: idea attachments read-through on cyboflow_get_task.
    // -----------------------------------------------------------------------
    describe('mcp-get-task attachments (IDEA-006)', () => {
      let attTmpRoot: string;

      beforeEach(() => {
        attTmpRoot = mkdtempSync(join(os.tmpdir(), 'cyboflow-mcp-att-'));
        setCyboflowDirectory(attTmpRoot);
      });

      afterEach(() => {
        rmSync(attTmpRoot, { recursive: true, force: true });
      });

      it('surfaces an idea\'s attachments with a RESOLVED ABSOLUTE path', async () => {
        listSeedRun(listDb, 'run-get-att-1');
        const idea = await createEntity('run-get-att-1', 'Idea with a screenshot');

        const ideaAttDir = getCyboflowSubdirectory('artifacts', 'ideas', idea.id);
        mkdirSync(ideaAttDir, { recursive: true });
        const filePath = join(ideaAttDir, 'att_abc123.png');
        writeFileSync(filePath, Buffer.from('fake-png-bytes'));

        listDb.prepare('UPDATE ideas SET attachments = ? WHERE id = ?').run(
          JSON.stringify([{ id: 'att_abc123', name: 'screenshot.png', path: filePath, type: 'image/png', size: 14 }]),
          idea.id,
        );

        const { socket, writes } = makeSocketDouble();
        await listHandler.handleMessage(
          { type: 'mcp-get-task', requestId: 'gt-att-1', runId: 'run-get-att-1', taskId: idea.id },
          socket,
        );

        const response = parseLastWrite(writes);
        expect(response.ok).toBe(true);
        const data = response.data as { task: Record<string, unknown> };
        const attachments = data.task['attachments'] as Array<Record<string, unknown>>;
        expect(attachments).toHaveLength(1);
        expect(attachments[0]).toEqual({
          id: 'att_abc123',
          label: 'screenshot.png',
          mimeType: 'image/png',
          path: filePath,
        });
        expect(isAbsolute(attachments[0]['path'] as string)).toBe(true);
      });

      it('returns an empty attachments array for an idea with none', async () => {
        listSeedRun(listDb, 'run-get-att-2');
        const idea = await createEntity('run-get-att-2', 'Idea without attachments');

        const { socket, writes } = makeSocketDouble();
        await listHandler.handleMessage(
          { type: 'mcp-get-task', requestId: 'gt-att-2', runId: 'run-get-att-2', taskId: idea.id },
          socket,
        );

        const data = parseLastWrite(writes).data as { task: Record<string, unknown> };
        expect(data.task['attachments']).toEqual([]);
      });

      it('never surfaces an "attachments" key for a task (epics/tasks carry no such column)', async () => {
        listSeedRun(listDb, 'run-get-att-3');
        const task = await createEntity('run-get-att-3', 'A plain task', 'task');

        const { socket, writes } = makeSocketDouble();
        await listHandler.handleMessage(
          { type: 'mcp-get-task', requestId: 'gt-att-3', runId: 'run-get-att-3', taskId: task.id },
          socket,
        );

        const data = parseLastWrite(writes).data as { task: Record<string, unknown> };
        expect('attachments' in data.task).toBe(false);
      });

      it('drops an attachment whose stored path resolves outside the artifacts root', async () => {
        listSeedRun(listDb, 'run-get-att-4');
        const idea = await createEntity('run-get-att-4', 'Idea with a poisoned path');

        const outsideFile = join(attTmpRoot, 'outside-secret.txt');
        writeFileSync(outsideFile, 'secret');

        listDb.prepare('UPDATE ideas SET attachments = ? WHERE id = ?').run(
          JSON.stringify([{ id: 'att_evil', name: 'evil.txt', path: outsideFile, type: 'text/plain', size: 6 }]),
          idea.id,
        );

        const { socket, writes } = makeSocketDouble();
        await listHandler.handleMessage(
          { type: 'mcp-get-task', requestId: 'gt-att-4', runId: 'run-get-att-4', taskId: idea.id },
          socket,
        );

        const data = parseLastWrite(writes).data as { task: Record<string, unknown> };
        expect(data.task['attachments']).toEqual([]);
      });
    });

    // -----------------------------------------------------------------------
    // Design Mode v0 (design-mode.md "Idea-bound artifact + read path"): the
    // approved-design prototype-snapshot exposure on cyboflow_get_task. The
    // '## Design spec' half already lives in `item.body` via the existing
    // full-projection path tested above — this covers the other half.
    // -----------------------------------------------------------------------
    describe('mcp-get-task approved_design (Design Mode v0)', () => {
      let designCounter = 0;

      /** Insert a raw approved_designs row (migration 085) with sane defaults. */
      function seedApprovedDesign(
        ideaId: string,
        projectId: number,
        overrides: { supersededAt?: string | null } = {},
      ): { id: string; approvedAt: string; draftRevision: number; prototypeRevision: number; snapshotPath: string } {
        designCounter += 1;
        const id = `apd_${designCounter}`;
        const approvedAt = `2026-01-0${designCounter}T00:00:00.000Z`;
        const draftRevision = designCounter;
        const prototypeRevision = designCounter;
        const snapshotPath = `/tmp/design-snapshots/${ideaId}/handoff-${designCounter}.html`;
        listDb
          .prepare(
            `INSERT INTO approved_designs
               (id, idea_id, project_id, handoff_id, session_id, draft_revision,
                prototype_artifact_id, prototype_revision, snapshot_path, approved_at, superseded_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            ideaId,
            projectId,
            `handoff_${designCounter}`,
            `sess_${designCounter}`,
            draftRevision,
            `art_${designCounter}`,
            prototypeRevision,
            snapshotPath,
            approvedAt,
            overrides.supersededAt ?? null,
          );
        return { id, approvedAt, draftRevision, prototypeRevision, snapshotPath };
      }

      it('surfaces approved_design with the right fields, RESOLVED to an absolute path', async () => {
        listSeedRun(listDb, 'run-get-des-1');
        const idea = await createEntity('run-get-des-1', 'Idea with an approved design');
        const seeded = seedApprovedDesign(idea.id, 1);

        const { socket, writes } = makeSocketDouble();
        await listHandler.handleMessage(
          { type: 'mcp-get-task', requestId: 'gt-des-1', runId: 'run-get-des-1', taskId: idea.id },
          socket,
        );

        const response = parseLastWrite(writes);
        expect(response.ok).toBe(true);
        const data = response.data as { task: Record<string, unknown> };
        // The stored path is surfaced resolved to an absolute path — on win32
        // path.resolve also remaps the separators and roots '/tmp/…' to the
        // current drive, so derive the expectation through resolve as well.
        expect(data.task['approved_design']).toEqual({
          approved_at: seeded.approvedAt,
          draft_revision: seeded.draftRevision,
          prototype_revision: seeded.prototypeRevision,
          snapshot_path: resolve(seeded.snapshotPath),
        });
        expect(isAbsolute((data.task['approved_design'] as Record<string, unknown>)['snapshot_path'] as string)).toBe(
          true,
        );
      });

      it('omits approved_design for an idea that has never been approved', async () => {
        listSeedRun(listDb, 'run-get-des-2');
        const idea = await createEntity('run-get-des-2', 'Idea with no approved design');

        const { socket, writes } = makeSocketDouble();
        await listHandler.handleMessage(
          { type: 'mcp-get-task', requestId: 'gt-des-2', runId: 'run-get-des-2', taskId: idea.id },
          socket,
        );

        const data = parseLastWrite(writes).data as { task: Record<string, unknown> };
        expect('approved_design' in data.task).toBe(false);
      });

      it('never surfaces approved_design for an epic/task, even if a row exists for the same id', async () => {
        listSeedRun(listDb, 'run-get-des-3');
        const task = await createEntity('run-get-des-3', 'A plain task', 'task');
        // Nothing stops a stray row keyed by a non-idea id from existing; the
        // handler must gate on item.type, not on row presence.
        seedApprovedDesign(task.id, 1);

        const { socket, writes } = makeSocketDouble();
        await listHandler.handleMessage(
          { type: 'mcp-get-task', requestId: 'gt-des-3', runId: 'run-get-des-3', taskId: task.id },
          socket,
        );

        const data = parseLastWrite(writes).data as { task: Record<string, unknown> };
        expect('approved_design' in data.task).toBe(false);
      });

      it('omits approved_design when the idea\'s only approval row is superseded', async () => {
        listSeedRun(listDb, 'run-get-des-4');
        const idea = await createEntity('run-get-des-4', 'Idea with a superseded-only approval');
        seedApprovedDesign(idea.id, 1, { supersededAt: '2026-01-02T00:00:00.000Z' });

        const { socket, writes } = makeSocketDouble();
        await listHandler.handleMessage(
          { type: 'mcp-get-task', requestId: 'gt-des-4', runId: 'run-get-des-4', taskId: idea.id },
          socket,
        );

        const data = parseLastWrite(writes).data as { task: Record<string, unknown> };
        expect('approved_design' in data.task).toBe(false);
      });

      it('surfaces the CURRENT row (superseded_at IS NULL) when a superseded row also exists', async () => {
        listSeedRun(listDb, 'run-get-des-5');
        const idea = await createEntity('run-get-des-5', 'Idea with a re-approved design');
        seedApprovedDesign(idea.id, 1, { supersededAt: '2026-01-02T00:00:00.000Z' });
        const current = seedApprovedDesign(idea.id, 1);

        const { socket, writes } = makeSocketDouble();
        await listHandler.handleMessage(
          { type: 'mcp-get-task', requestId: 'gt-des-5', runId: 'run-get-des-5', taskId: idea.id },
          socket,
        );

        const data = parseLastWrite(writes).data as { task: Record<string, unknown> };
        expect(data.task['approved_design']).toMatchObject({
          approved_at: current.approvedAt,
          draft_revision: current.draftRevision,
        });
      });
    });

    // -----------------------------------------------------------------------
    // Idea component ledger (migration 101) exposure on cyboflow_get_task —
    // see the sibling 'idea component staleness hook' coverage in
    // taskChangeRouter.test.ts for how a component actually GOES stale; this
    // block covers the read-side shape/gating only.
    // -----------------------------------------------------------------------
    describe('mcp-get-task components (idea component ledger, migration 101)', () => {
      it("surfaces all FIVE derived components for a fresh idea, and omits 'components' for an epic/task", async () => {
        listSeedRun(listDb, 'run-get-comp-1');
        const idea = await createEntity('run-get-comp-1', 'Fresh idea');
        const task = await createEntity('run-get-comp-1', 'A plain task', 'task');

        const ideaRes = makeSocketDouble();
        await listHandler.handleMessage(
          { type: 'mcp-get-task', requestId: 'gt-comp-1', runId: 'run-get-comp-1', taskId: idea.id },
          ideaRes.socket,
        );
        const ideaData = parseLastWrite(ideaRes.writes).data as { task: Record<string, unknown> };
        const components = ideaData.task['components'] as Array<Record<string, unknown>>;
        expect(components).toBeDefined();
        expect(components.map((c) => c['component'])).toEqual([
          'idea-spec',
          'prototype',
          'architecture',
          'epics',
          'stories',
        ]);
        // A fresh idea with no body/children derives every component 'incomplete',
        // source 'derived', never stale (staleAt null on every entry).
        for (const c of components) {
          expect(c['state']).toBe('incomplete');
          expect(c['source']).toBe('derived');
          expect(c['staleAt']).toBeNull();
        }

        const taskRes = makeSocketDouble();
        await listHandler.handleMessage(
          { type: 'mcp-get-task', requestId: 'gt-comp-2', runId: 'run-get-comp-1', taskId: task.id },
          taskRes.socket,
        );
        const taskData = parseLastWrite(taskRes.writes).data as { task: Record<string, unknown> };
        expect('components' in taskData.task).toBe(false);
      });

      it('a component with prior work marked stale reads as visibly distinct from one never started', async () => {
        listSeedRun(listDb, 'run-get-comp-2');
        const idea = await createEntity('run-get-comp-2', 'Idea with mixed ledger state');

        IdeaComponentRouter.initialize(dbAdapter(listDb));
        // 'architecture' finished a full pass, THEN the idea's body moved under
        // it (mark-stale) — prior work exists and needs re-verification.
        await IdeaComponentRouter.getInstance().applyChange(1, {
          op: 'set-component-state',
          ideaId: idea.id,
          component: 'architecture',
          state: 'complete',
          source: 'flow',
        });
        await IdeaComponentRouter.getInstance().applyChange(1, {
          op: 'mark-stale',
          ideaId: idea.id,
          staleReason: 'idea body changed',
        });

        const { socket, writes } = makeSocketDouble();
        await listHandler.handleMessage(
          { type: 'mcp-get-task', requestId: 'gt-comp-3', runId: 'run-get-comp-2', taskId: idea.id },
          socket,
        );
        const data = parseLastWrite(writes).data as { task: Record<string, unknown> };
        const components = data.task['components'] as Array<Record<string, unknown>>;

        const architecture = components.find((c) => c['component'] === 'architecture')!;
        // "needs review": incomplete WITH a stale flag — prior work exists.
        expect(architecture['state']).toBe('incomplete');
        expect(architecture['staleAt']).not.toBeNull();

        // 'stories' has no ledger row at all and derives to plain 'incomplete' —
        // "not started". Same `state`, but VISIBLY DIFFERENT via staleAt: the
        // exact distinction the ledger design says must never collapse.
        const stories = components.find((c) => c['component'] === 'stories')!;
        expect(stories['state']).toBe('incomplete');
        expect(stories['staleAt']).toBeNull();
        expect(architecture['staleAt']).not.toEqual(stories['staleAt']);
      });
    });
  });

  // -------------------------------------------------------------------------
  // cyboflow_set_idea_component (mcp-set-idea-component) — the WRITE half of
  // the idea component ledger (migration 101). Routes through
  // IdeaComponentRouter.getInstance().applyChange with source:'flow';
  // sourceRunId + builtAgainstVersion are resolved by the handler itself.
  // -------------------------------------------------------------------------

  describe('mcp-set-idea-component', () => {
    function buildComponentDb(): Database.Database {
      const db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      db.exec(`
        CREATE TABLE projects (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          path TEXT NOT NULL UNIQUE,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);
      db.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Proj', '/tmp/p1');

      const migDir = join(__dirname, '..', '..', '..', 'database', 'migrations');
      db.exec(readFileSync(join(migDir, '006_cyboflow_schema.sql'), 'utf-8'));
      db.exec(readFileSync(join(migDir, '011_workflow_step_tracking.sql'), 'utf-8'));
      db.exec(readFileSync(join(migDir, '014_native_tasks.sql'), 'utf-8'));
      db.exec(readFileSync(join(migDir, '015_entity_model_rebuild.sql'), 'utf-8'));
      db.exec(readFileSync(join(migDir, '024_archive_in_place.sql'), 'utf-8'));
      db.exec(readFileSync(join(migDir, '028_idea_attachments.sql'), 'utf-8'));
      db.exec(readFileSync(join(migDir, '042_collapse_board.sql'), 'utf-8'));
      db.exec(readFileSync(join(migDir, '057_entity_sort_order.sql'), 'utf-8'));
      db.exec(readFileSync(join(migDir, '059_entity_category.sql'), 'utf-8'));
      db.exec(readFileSync(join(migDir, '101_idea_component_ledger.sql'), 'utf-8'));
      // taskListing.selectTaskById's UNION (reached by mcp-set-idea-component's
      // id/ref resolution, same as mcp-get-task) also reads experiment_id
      // (migration 049) unconditionally — absent from this fixture's chain.
      db.exec('ALTER TABLE ideas ADD COLUMN experiment_id TEXT;');
      db.exec('ALTER TABLE epics ADD COLUMN experiment_id TEXT;');
      db.exec('ALTER TABLE tasks ADD COLUMN experiment_id TEXT;');
      // resolveIdeaComponentsBatch (the post-write emit read) unconditionally
      // queries approved_designs, and — once the created idea's entity_events
      // row links it to this fixture's run — the 'prototype' derivation arm
      // also queries artifacts for that run id. Neither table is otherwise in
      // this fixture's chain (mirrors taskChangeRouter.test.ts's
      // buildDbWithIdeaComponents()).
      db.exec(`
        CREATE TABLE approved_designs (id TEXT PRIMARY KEY, idea_id TEXT NOT NULL, superseded_at TEXT);
        CREATE TABLE artifacts (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, atype TEXT NOT NULL);
      `);
      return db;
    }

    function seedComponentRun(db: Database.Database, runId: string): void {
      db.prepare(
        `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-comp', 1, 'planner', '{}')`,
      ).run();
      db.prepare(
        `INSERT INTO workflow_runs
           (id, workflow_id, project_id, status, current_step_id, steps_snapshot_json)
         VALUES (?, 'wf-comp', 1, 'running', 'expand-spec', ?)`,
      ).run(runId, JSON.stringify({ 'expand-spec': 'cyboflow-planner' }));
    }

    let componentDb: Database.Database;
    let componentHandler: McpQueryHandler;

    beforeEach(() => {
      componentDb = buildComponentDb();
      TaskChangeRouter.initialize(dbAdapter(componentDb));
      IdeaComponentRouter.initialize(dbAdapter(componentDb));
      componentHandler = new McpQueryHandler(dbAdapter(componentDb));
    });

    afterEach(() => {
      TaskChangeRouter._resetForTesting();
      IdeaComponentRouter._resetForTesting();
      taskChangeEvents.removeAllListeners();
      ideaComponentChangeEvents.removeAllListeners();
    });

    /** Create an idea via the real mcp-create-task handler; returns its id + ref. */
    async function createIdea(runId: string, title: string): Promise<{ id: string; ref: string }> {
      const { socket, writes } = makeSocketDouble();
      await componentHandler.handleMessage(
        { type: 'mcp-create-task', requestId: `ci-${title}`, runId, title, taskType: 'idea' },
        socket,
      );
      const data = parseLastWrite(writes).data as { task_id: string; ref: string };
      return { id: data.task_id, ref: data.ref };
    }

    /** Raw row read, bypassing the router — asserts exactly what was persisted. */
    function rawComponentRow(
      ideaId: string,
      component: string,
    ): { state: string; source: string; source_run_id: string | null; built_against_version: number | null } | undefined {
      return componentDb
        .prepare(
          `SELECT state, source, source_run_id, built_against_version
             FROM idea_components WHERE idea_id = ? AND component = ?`,
        )
        .get(ideaId, component) as
        | { state: string; source: string; source_run_id: string | null; built_against_version: number | null }
        | undefined;
    }

    it('sets a component state with source "flow", stamping sourceRunId + the idea\'s current version', async () => {
      seedComponentRun(componentDb, 'run-sic-1');
      const idea = await createIdea('run-sic-1', 'An idea');

      const { socket, writes } = makeSocketDouble();
      await componentHandler.handleMessage(
        {
          type: 'mcp-set-idea-component',
          requestId: 'sic-1',
          runId: 'run-sic-1',
          ideaId: idea.id,
          component: 'architecture',
          state: 'complete',
        },
        socket,
      );

      const response = parseLastWrite(writes);
      expect(response.ok).toBe(true);
      const data = response.data as {
        idea_id: string;
        ref: string;
        component: string;
        state: string;
        components: Array<Record<string, unknown>>;
      };
      expect(data.idea_id).toBe(idea.id);
      expect(data.ref).toBe(idea.ref);
      expect(data.component).toBe('architecture');
      expect(data.state).toBe('complete');
      // The fresh merged snapshot round-trips the just-written state.
      const architecture = data.components.find((c) => c['component'] === 'architecture')!;
      expect(architecture['state']).toBe('complete');
      expect(architecture['source']).toBe('flow');

      const row = rawComponentRow(idea.id, 'architecture');
      expect(row).toMatchObject({ state: 'complete', source: 'flow', source_run_id: 'run-sic-1' });
      // builtAgainstVersion is resolved from the idea's OWN current version —
      // never accepted from the caller, who never passed one.
      const idea2 = componentDb.prepare('SELECT version FROM ideas WHERE id = ?').get(idea.id) as {
        version: number;
      };
      expect(row?.built_against_version).toBe(idea2.version);
    });

    it('resolves a display ref (IDEA-NNN) to the idea, exactly like cyboflow_get_task', async () => {
      seedComponentRun(componentDb, 'run-sic-2');
      const idea = await createIdea('run-sic-2', 'Ref-addressed idea');
      expect(idea.ref).toMatch(/^IDEA-\d+$/);

      const { socket, writes } = makeSocketDouble();
      await componentHandler.handleMessage(
        {
          type: 'mcp-set-idea-component',
          requestId: 'sic-2',
          runId: 'run-sic-2',
          ideaId: idea.ref,
          component: 'stories',
          state: 'skipped',
        },
        socket,
      );

      const response = parseLastWrite(writes);
      expect(response.ok).toBe(true);
      expect((response.data as { idea_id: string }).idea_id).toBe(idea.id);
      expect(rawComponentRow(idea.id, 'stories')?.state).toBe('skipped');
    });

    it('rejects a non-idea target (epic/task) with not_found — the ledger is ideas-only', async () => {
      seedComponentRun(componentDb, 'run-sic-3');
      const { socket: taskSocket, writes: taskWrites } = makeSocketDouble();
      await componentHandler.handleMessage(
        { type: 'mcp-create-task', requestId: 'ci-task', runId: 'run-sic-3', title: 'A task', taskType: 'task' },
        taskSocket,
      );
      const taskId = (parseLastWrite(taskWrites).data as { task_id: string }).task_id;

      const { socket, writes } = makeSocketDouble();
      await componentHandler.handleMessage(
        {
          type: 'mcp-set-idea-component',
          requestId: 'sic-3',
          runId: 'run-sic-3',
          ideaId: taskId,
          component: 'stories',
          state: 'complete',
        },
        socket,
      );
      const response = parseLastWrite(writes);
      expect(response.ok).toBe(false);
      expect(response.error).toBe('not_found');
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
      reviewDb.exec(readFileSync(join(migDir, '085_review_item_audience.sql'), 'utf-8'));
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
    gateDb.exec(readFileSync(join(migDir, '007_add_stuck_reason.sql'), 'utf-8'));
    gateDb.exec(readFileSync(join(migDir, '010_questions.sql'), 'utf-8'));
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
    QuestionRouter.initialize(dbAdapter(gateDb));
    stepTransitionEvents.removeAllListeners('transition');
  });

  afterEach(() => {
    QuestionRouter._resetForTesting();
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

  it('blocks an MCP question until QuestionRouter receives the human answer', async () => {
    seedSprintRun(gateDb, 'run-g');
    const { socket, writes } = makeSocketDouble();
    const request = gateHandler.handleMessage({
      type: 'mcp-request-user-input',
      requestId: 'question-1',
      runId: 'run-g',
      questions: [{
        header: 'Review',
        question: 'Approve the sprint?',
        multiSelect: false,
        options: [{ label: 'Approve' }, { label: 'Reject' }],
      }],
    }, socket);

    await vi.waitFor(() => {
      expect(gateDb.prepare("SELECT status FROM workflow_runs WHERE id = 'run-g'").get()).toEqual({
        status: 'awaiting_input',
      });
    });
    expect(writes).toHaveLength(0);

    const row = gateDb.prepare("SELECT id FROM questions WHERE run_id = 'run-g'").get() as { id: string };
    await QuestionRouter.getInstance().respond(row.id, {
      answers: { 'Approve the sprint?': 'Approve' },
    });
    await request;

    expect(parseLastWrite(writes)).toMatchObject({
      requestId: 'question-1',
      ok: true,
      data: { answers: { 'Approve the sprint?': 'Approve' } },
    });
    expect(gateDb.prepare("SELECT status FROM workflow_runs WHERE id = 'run-g'").get()).toEqual({
      status: 'running',
    });
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
    // resolveRunPermissionMode now joins the owning SESSION (permission-mode
    // redesign §3c#3); migrations 019 (session_id) / 021 (agent_permission_mode)
    // are outside this fixture's set, so add the minimal join surface so the
    // handler's join resolves (these runs carry no mode ⇒ null ⇒ router gate).
    laneDb.exec('ALTER TABLE workflow_runs ADD COLUMN session_id TEXT');
    laneDb.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_permission_mode TEXT)');
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

  /**
   * Seed a workflows + workflow_runs pair with a CUSTOM workflow id/spec_json,
   * for Seam 2 (chain-derived allowedStepIds) coverage — unlike seedSprintRun,
   * the workflow id is caller-chosen (not the fixed 'wf-1') so multiple custom
   * defs can coexist across tests in this describe block.
   */
  function seedSprintRunWithSpec(
    laneDb: Database.Database,
    opts: { runId: string; batchId: string | null; workflowId: string; name: string; specJson: string },
  ): void {
    laneDb
      .prepare(`INSERT INTO workflows (id, project_id, name, spec_json) VALUES (?, 1, ?, ?)`)
      .run(opts.workflowId, opts.name, opts.specJson);
    laneDb
      .prepare(
        `INSERT INTO workflow_runs (id, workflow_id, project_id, status, current_step_id, steps_snapshot_json, batch_id)
         VALUES (?, ?, 1, 'running', 'execute-tasks', '{"execute-tasks":"executor"}', ?)`,
      )
      .run(opts.runId, opts.workflowId, opts.batchId);
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

  // -------------------------------------------------------------------------
  // Seam 2 — chain-derived allowedStepIds (Phase D). The handler now resolves
  // the CALLING run's fan-out chain (resolveRunFanOutInner) and threads it as
  // SprintLaneStore.updateLane's allowedStepIds instead of relying on the
  // fixed SPRINT_LANE_STEP_IDS default — mirroring the programmatic plane's
  // driveLane threading (programmatic/workflowController.ts).
  // -------------------------------------------------------------------------

  describe('chain-derived allowedStepIds', () => {
    const CUSTOM_FANOUT_SPEC = JSON.stringify({
      id: 'wf-custom-chain',
      phases: [
        {
          id: 'execute',
          label: 'Execute',
          color: '#3b6dd6',
          steps: [
            {
              id: 'execute-tasks',
              name: 'Execute tasks',
              agent: 'implement',
              mcps: [],
              retries: 0,
              fanOut: {
                over: 'tasks',
                inner: [
                  { id: 'design', agent: 'design', name: 'Design' },
                  { id: 'build', agent: 'build', name: 'Build', loopback: 'design' },
                ],
              },
            },
          ],
        },
      ],
    });

    const CUSTOM_NO_FANOUT_SPEC = JSON.stringify({
      id: 'wf-custom-no-fanout',
      phases: [
        {
          id: 'p1',
          label: 'P1',
          color: '#3b6dd6',
          steps: [{ id: 'step-a', name: 'Step A', agent: 'human', mcps: [], retries: 0 }],
        },
      ],
    });

    it("accepts a custom chain's own inner id ('design') and reaches the SprintLaneStore write", async () => {
      const { batchId } = SprintLaneStore.getInstance().createForRun(1, 'sdk', ['tsk_a']);
      seedSprintRunWithSpec(laneDb, {
        runId: 'run-custom',
        batchId,
        workflowId: 'wf-custom',
        name: 'custom-flow',
        specJson: CUSTOM_FANOUT_SPEC,
      });

      const { socket, writes } = makeSocketDouble();
      await laneHandler.handleMessage(
        {
          type: 'mcp-update-sprint-task',
          requestId: 'us-c1',
          runId: 'run-custom',
          taskId: 'tsk_a',
          currentStepId: 'design',
        },
        socket,
      );

      const response = parseLastWrite(writes);
      expect(response.ok).toBe(true);
      expect((response.data as { current_step_id: string }).current_step_id).toBe('design');
    });

    it("rejects an out-of-chain id ('implement' — a canonical id absent from this custom chain)", async () => {
      const { batchId } = SprintLaneStore.getInstance().createForRun(1, 'sdk', ['tsk_a']);
      seedSprintRunWithSpec(laneDb, {
        runId: 'run-custom2',
        batchId,
        workflowId: 'wf-custom2',
        name: 'custom-flow-2',
        specJson: CUSTOM_FANOUT_SPEC,
      });

      const { socket, writes } = makeSocketDouble();
      await laneHandler.handleMessage(
        {
          type: 'mcp-update-sprint-task',
          requestId: 'us-c2',
          runId: 'run-custom2',
          taskId: 'tsk_a',
          currentStepId: 'implement',
        },
        socket,
      );

      const response = parseLastWrite(writes);
      expect(response.ok).toBe(false);
      expect(response.error).toBe('bad_request');
    });

    it("accepts 'awaiting-verify' (the park step) on a custom chain — always widened in", async () => {
      const { batchId } = SprintLaneStore.getInstance().createForRun(1, 'sdk', ['tsk_a']);
      seedSprintRunWithSpec(laneDb, {
        runId: 'run-custom3',
        batchId,
        workflowId: 'wf-custom3',
        name: 'custom-flow-3',
        specJson: CUSTOM_FANOUT_SPEC,
      });

      const { socket, writes } = makeSocketDouble();
      await laneHandler.handleMessage(
        {
          type: 'mcp-update-sprint-task',
          requestId: 'us-c3',
          runId: 'run-custom3',
          taskId: 'tsk_a',
          currentStepId: 'awaiting-verify',
        },
        socket,
      );

      const response = parseLastWrite(writes);
      expect(response.ok).toBe(true);
    });

    it('a definition with no fanOut step falls back to the canonical SPRINT_LANE_STEP_IDS default', async () => {
      const { batchId } = SprintLaneStore.getInstance().createForRun(1, 'sdk', ['tsk_a']);
      seedSprintRunWithSpec(laneDb, {
        runId: 'run-nofanout',
        batchId,
        workflowId: 'wf-nofanout',
        name: 'custom-no-fanout',
        specJson: CUSTOM_NO_FANOUT_SPEC,
      });

      // A canonical id is accepted (fallback to SPRINT_LANE_STEP_IDS).
      const { socket: okSocket, writes: okWrites } = makeSocketDouble();
      await laneHandler.handleMessage(
        {
          type: 'mcp-update-sprint-task',
          requestId: 'us-nf1',
          runId: 'run-nofanout',
          taskId: 'tsk_a',
          currentStepId: 'implement',
        },
        okSocket,
      );
      expect(parseLastWrite(okWrites).ok).toBe(true);

      // A custom-chain-only id ('design') is rejected — there is no fan-out
      // chain to accept it, and it is not in the canonical fallback either.
      const { socket: badSocket, writes: badWrites } = makeSocketDouble();
      await laneHandler.handleMessage(
        {
          type: 'mcp-update-sprint-task',
          requestId: 'us-nf2',
          runId: 'run-nofanout',
          taskId: 'tsk_a',
          currentStepId: 'design',
        },
        badSocket,
      );
      const badResponse = parseLastWrite(badWrites);
      expect(badResponse.ok).toBe(false);
      expect(badResponse.error).toBe('bad_request');
    });
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
    // resolveRunPermissionMode now joins the owning SESSION (permission-mode
    // redesign §3c#3); migrations 019 (session_id) / 021 (agent_permission_mode)
    // are outside this fixture's set, so add the minimal join surface so the
    // handler's join resolves (these runs carry no mode ⇒ null ⇒ router gate).
    laneDb.exec('ALTER TABLE workflow_runs ADD COLUMN session_id TEXT');
    laneDb.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_permission_mode TEXT)');
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
//     chokepoint, AWAITED so a failure surfaces. get-selected-findings and
//     resolve-finding stay mid-run-only (run_not_active); list-run-findings is a
//     pure read and deliberately is NOT — the eval grades AT settle.
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
    // 085 adds review_items.audience — selectRunFindings (mcp-list-run-findings)
    // filters machine-audience rows out, so the column must exist here.
    fdb.exec(readFileSync(join(migDir, '085_review_item_audience.sql'), 'utf-8'));
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
  // list-run-findings — the run reading back its OWN open findings, with the
  // resolve handles fire-and-forget report-finding never returned.
  // -------------------------------------------------------------------------

  describe('mcp-list-run-findings', () => {
    it("returns only this run's pending human-audience findings, with their ids", async () => {
      seedCompoundRun(fdb, { runId: 'run-a' });
      seedCompoundRun(fdb, { runId: 'run-b' });

      seedFinding(fdb, {
        id: 'ri_mine',
        title: 'Unvalidated input',
        runId: 'run-a',
        severity: 'error',
        payload: { kind: 'finding', category: 'security', suggestedFix: 'validate it', locations: [{ path: 'a.ts', line: 9 }] },
      });
      // Another run's finding is out of scope.
      seedFinding(fdb, { id: 'ri_theirs', title: 'Elsewhere', runId: 'run-b' });
      // Already-resolved and machine-audience rows are both excluded.
      seedFinding(fdb, { id: 'ri_done', title: 'Handled', runId: 'run-a' });
      fdb.prepare(`UPDATE review_items SET status = 'resolved' WHERE id = 'ri_done'`).run();
      seedFinding(fdb, { id: 'ri_mailbox', title: 'loopback-implement', runId: 'run-a' });
      fdb.prepare(`UPDATE review_items SET audience = 'machine' WHERE id = 'ri_mailbox'`).run();

      const { socket, writes } = makeSocketDouble();
      await fHandler.handleMessage(
        { type: 'mcp-list-run-findings', requestId: 'lf-1', runId: 'run-a' },
        socket,
      );

      const response = parseLastWrite(writes);
      expect(response.ok).toBe(true);
      const data = response.data as {
        findings: Array<{ id: string; title: string; category: string | null; blocking: boolean; suggestedFix: string | null }>;
      };
      expect(data.findings).toHaveLength(1);
      expect(data.findings[0]).toMatchObject({
        id: 'ri_mine',
        title: 'Unvalidated input',
        category: 'security',
        blocking: false,
        suggestedFix: 'validate it',
      });
    });

    it('returns an empty array when the run filed nothing', async () => {
      seedCompoundRun(fdb, { runId: 'run-a' });

      const { socket, writes } = makeSocketDouble();
      await fHandler.handleMessage(
        { type: 'mcp-list-run-findings', requestId: 'lf-2', runId: 'run-a' },
        socket,
      );

      const response = parseLastWrite(writes);
      expect(response.ok).toBe(true);
      // `runScope` is the widened session scope; with no session_id link it
      // fail-softs to the caller's own run, i.e. the pre-widening behavior.
      expect(response.data).toEqual({ findings: [], runScope: ['run-a'] });
    });

    it("reads the FLOW run's findings when called with the session's chat sentinel", async () => {
      // THE defect this widening exists for. A chat turn's CYBOFLOW_RUN_ID is
      // the session's `__quick__` sentinel, which files nothing; the findings
      // sit on the flow run the same session owns. Before the widening this
      // replied `{ findings: [] }` — an empty indistinguishable from a clean run.
      //
      // Migration 019's own UPDATE joins `sessions`, which this fixture does not
      // carry, so only its ALTER is applied here.
      fdb.exec('ALTER TABLE workflow_runs ADD COLUMN session_id TEXT');
      seedCompoundRun(fdb, { runId: 'run-flow', status: 'completed' });
      seedCompoundRun(fdb, { runId: 'run-sentinel' });
      seedCompoundRun(fdb, { runId: 'run-unrelated' });
      fdb
        .prepare(`UPDATE workflow_runs SET session_id = 'sess-1' WHERE id IN ('run-flow', 'run-sentinel')`)
        .run();
      fdb.prepare(`UPDATE workflow_runs SET session_id = 'sess-2' WHERE id = 'run-unrelated'`).run();

      seedFinding(fdb, { id: 'ri_flow', title: 'Filed by the flow run', runId: 'run-flow' });
      seedFinding(fdb, { id: 'ri_other', title: "Another session's", runId: 'run-unrelated' });

      const { socket, writes } = makeSocketDouble();
      await fHandler.handleMessage(
        { type: 'mcp-list-run-findings', requestId: 'lf-sess', runId: 'run-sentinel' },
        socket,
      );

      const response = parseLastWrite(writes);
      expect(response.ok).toBe(true);
      const data = response.data as {
        findings: Array<{ id: string; runId: string | null }>;
        runScope: string[];
      };
      expect(data.findings.map((f) => f.id)).toEqual(['ri_flow']);
      // The row names the run that filed it, so the agent can tell lanes apart.
      expect(data.findings[0].runId).toBe('run-flow');
      // And the scope is reported, so an empty result would be legible too.
      expect(new Set(data.runScope)).toEqual(new Set(['run-sentinel', 'run-flow']));
    });

    it('observes a finding still queued from a fire-and-forget report (drains first)', async () => {
      // report-finding replies BEFORE its create drains the per-project queue.
      // Reading review_items straight after would race that write and silently
      // return an incomplete set — dropping exactly the findings sprint-review
      // filed moments earlier.
      //
      // Reporting and listing back-to-back does NOT reproduce this (the queue
      // usually drains within the intervening microtasks), so OCCUPY the queue
      // first: the report's create then provably sits behind a pending job while
      // the list call runs. Without the drain in handleListRunFindings this
      // returns 0 findings.
      seedCompoundRun(fdb, { runId: 'run-a' });

      let releaseBlocker: () => void = () => {};
      const blocker = new Promise<void>((resolve) => {
        releaseBlocker = resolve;
      });
      void ReviewItemRouter.getInstance()
        ._queueForProject(1)
        .add(() => blocker);

      const reportSocket = makeSocketDouble();
      await fHandler.handleMessage(
        {
          type: 'mcp-report-finding',
          requestId: 'rf-1',
          runId: 'run-a',
          title: 'Races the reader',
          body: 'filed immediately before the list call',
          category: 'correctness',
        },
        reportSocket.socket,
      );
      // The report replied ok WITHOUT waiting for the write — that is the hazard.
      expect(parseLastWrite(reportSocket.writes).ok).toBe(true);
      // Proof the create really is still pending: nothing is in the table yet.
      expect(
        (fdb.prepare(`SELECT COUNT(*) AS n FROM review_items`).get() as { n: number }).n,
      ).toBe(0);

      const { socket, writes } = makeSocketDouble();
      const listed = fHandler.handleMessage(
        { type: 'mcp-list-run-findings', requestId: 'lf-race', runId: 'run-a' },
        socket,
      );
      // The list call is parked on the drain; let the queue through.
      releaseBlocker();
      await listed;

      const response = parseLastWrite(writes);
      expect(response.ok).toBe(true);
      const data = response.data as { findings: Array<{ id: string; title: string }> };
      expect(data.findings).toHaveLength(1);
      expect(data.findings[0].title).toBe('Races the reader');
    });

    it('READS a terminal run — the eval grades at settle, so its findings outlive the run', async () => {
      // Previously refused with run_not_active. That gate exists to stop a
      // settled run WRITING; applying it to a read refused the exact ask this
      // tool serves — "the run finished, now go fix what review found" — on a
      // run whose findings were sitting in the table the whole time.
      seedCompoundRun(fdb, { runId: 'run-a', status: 'completed' });
      seedFinding(fdb, { id: 'ri_after', title: 'Graded at settle', runId: 'run-a' });

      const { socket, writes } = makeSocketDouble();
      await fHandler.handleMessage(
        { type: 'mcp-list-run-findings', requestId: 'lf-3', runId: 'run-a' },
        socket,
      );

      const response = parseLastWrite(writes);
      expect(response.ok).toBe(true);
      const data = response.data as { findings: Array<{ id: string }> };
      expect(data.findings.map((f) => f.id)).toEqual(['ri_after']);
    });

    it('still refuses the orchestrator sentinel and an unknown run id', async () => {
      // The read-only context drops ONLY the terminal-run refusal. A request
      // that names no real run is still meaningless and must not reply ok:true
      // with an empty set, which would read as "this run is clean".
      const { socket: s1, writes: w1 } = makeSocketDouble();
      await fHandler.handleMessage(
        { type: 'mcp-list-run-findings', requestId: 'lf-orch', runId: 'orchestrator' },
        s1,
      );
      expect(parseLastWrite(w1)).toMatchObject({ ok: false, error: 'finding_requires_real_run' });

      const { socket: s2, writes: w2 } = makeSocketDouble();
      await fHandler.handleMessage(
        { type: 'mcp-list-run-findings', requestId: 'lf-ghost', runId: 'run-ghost' },
        s2,
      );
      expect(parseLastWrite(w2)).toMatchObject({ ok: false, error: 'run_not_found' });
    });
  });

  // -------------------------------------------------------------------------
  // get-eval — the jury verdict a chat agent could not previously reach
  // -------------------------------------------------------------------------

  describe('mcp-get-eval', () => {
    /** Minimal run_evals table + one complete verdict row for `runId`. */
    function seedEvalRow(runId: string, perSample: unknown): void {
      fdb.exec(`
        CREATE TABLE IF NOT EXISTS run_evals (
          run_id TEXT NOT NULL,
          rubric_version TEXT NOT NULL,
          eval_status TEXT NOT NULL DEFAULT 'pending',
          origin TEXT,
          snapshot_at TEXT,
          human_influenced INTEGER NOT NULL DEFAULT 0,
          overall_score INTEGER,
          band TEXT,
          ci_low REAL,
          ci_high REAL,
          sample_count INTEGER,
          judge_model TEXT,
          gated INTEGER NOT NULL DEFAULT 0,
          security_flag INTEGER NOT NULL DEFAULT 0,
          requirements_unmet INTEGER NOT NULL DEFAULT 0,
          cap_triggers_json TEXT,
          dimensions_json TEXT,
          per_sample_json TEXT,
          error TEXT,
          PRIMARY KEY (run_id, rubric_version)
        );
      `);
      fdb
        .prepare(
          `INSERT INTO run_evals
             (run_id, rubric_version, eval_status, snapshot_at, overall_score, band, sample_count,
              per_sample_json)
           VALUES (?, '1.1', 'complete', '2026-08-26T10:00:00Z', 62, 'Fair', 2, ?)`,
        )
        .run(runId, JSON.stringify(perSample));
    }

    interface EvalReply {
      runScope: string[];
      evaluation: {
        runId: string;
        overallScore: number | null;
        findings: Array<{ title: string; reviewItemId: string | null }>;
      } | null;
    }

    it("finds the FLOW run's verdict from a chat sentinel that was never graded", async () => {
      // The whole defect in one test: the sentinel has no run_evals row, so a
      // run-bound read returns nothing; the graded run is its session-mate.
      fdb.exec('ALTER TABLE workflow_runs ADD COLUMN session_id TEXT');
      seedCompoundRun(fdb, { runId: 'run-flow', status: 'completed' });
      seedCompoundRun(fdb, { runId: 'run-sentinel' });
      fdb
        .prepare(`UPDATE workflow_runs SET session_id = 'sess-1' WHERE id IN ('run-flow', 'run-sentinel')`)
        .run();
      seedEvalRow('run-flow', [
        { verdicts: [{ id: 'SEC-2', verdict: 'FAIL', evidence: 'unescaped input' }], findings: [{ subCheckId: 'SEC-2', title: 'Filed one', body: 'b' }] },
        { verdicts: [], findings: [{ subCheckId: 'STY-1', title: 'Never filed', body: 'b' }] },
      ]);
      seedFinding(fdb, { id: 'ri_1', title: 'Filed one', runId: 'run-flow' });

      const { socket, writes } = makeSocketDouble();
      await fHandler.handleMessage(
        { type: 'mcp-get-eval', requestId: 'ge-1', runId: 'run-sentinel' },
        socket,
      );

      const response = parseLastWrite(writes);
      expect(response.ok).toBe(true);
      const data = response.data as EvalReply;
      expect(data.evaluation?.runId).toBe('run-flow');
      expect(data.evaluation?.overallScore).toBe(62);
      // The link the agent needs to resolve, AND the null that marks a finding
      // nothing else would ever surface.
      const byTitle = new Map(data.evaluation!.findings.map((f) => [f.title, f.reviewItemId]));
      expect(byTitle.get('Filed one')).toBe('ri_1');
      expect(byTitle.get('Never filed')).toBeNull();
    });

    it('replies evaluation:null with the searched scope when nothing was graded', async () => {
      seedCompoundRun(fdb, { runId: 'run-a' });

      const { socket, writes } = makeSocketDouble();
      await fHandler.handleMessage(
        { type: 'mcp-get-eval', requestId: 'ge-2', runId: 'run-a' },
        socket,
      );

      const response = parseLastWrite(writes);
      expect(response.ok).toBe(true);
      // Not an error — "never graded" is a real answer — but the scope is named
      // so the agent can see what was actually searched.
      expect(response.data).toEqual({ runScope: ['run-a'], evaluation: null });
    });

    it('reads a TERMINAL run — the eval only exists once the run has settled', async () => {
      seedCompoundRun(fdb, { runId: 'run-a', status: 'completed' });
      seedEvalRow('run-a', []);

      const { socket, writes } = makeSocketDouble();
      await fHandler.handleMessage(
        { type: 'mcp-get-eval', requestId: 'ge-3', runId: 'run-a' },
        socket,
      );

      const response = parseLastWrite(writes);
      expect(response.ok).toBe(true);
      expect((response.data as EvalReply).evaluation?.overallScore).toBe(62);
    });

    it('honours an explicit run_id in the same project', async () => {
      seedCompoundRun(fdb, { runId: 'run-a' });
      seedCompoundRun(fdb, { runId: 'run-b', status: 'completed' });
      seedEvalRow('run-b', []);

      const { socket, writes } = makeSocketDouble();
      await fHandler.handleMessage(
        { type: 'mcp-get-eval', requestId: 'ge-4', runId: 'run-a', targetRunId: 'run-b' },
        socket,
      );

      const data = parseLastWrite(writes).data as EvalReply;
      expect(data.runScope).toEqual(['run-b']);
      expect(data.evaluation?.runId).toBe('run-b');
    });

    it("refuses an explicit run_id in ANOTHER project", async () => {
      // Tighter than the sibling mcp-get-run, which reads any run row by id —
      // right here because the payload carries review content.
      fdb.prepare('INSERT INTO projects (id, name, path) VALUES (2, ?, ?)').run('Other', '/tmp/p2');
      seedCompoundRun(fdb, { runId: 'run-a' });
      fdb
        .prepare(
          `INSERT INTO workflow_runs (id, workflow_id, project_id, status, current_step_id, steps_snapshot_json)
           VALUES ('run-far', 'wf-c', 2, 'completed', 'compound', '{}')`,
        )
        .run();

      const { socket, writes } = makeSocketDouble();
      await fHandler.handleMessage(
        { type: 'mcp-get-eval', requestId: 'ge-5', runId: 'run-a', targetRunId: 'run-far' },
        socket,
      );

      expect(parseLastWrite(writes)).toMatchObject({ ok: false, error: 'run_not_in_project' });
    });

    it('refuses an unknown run id rather than replying with a null verdict', async () => {
      seedCompoundRun(fdb, { runId: 'run-a' });

      const { socket, writes } = makeSocketDouble();
      await fHandler.handleMessage(
        { type: 'mcp-get-eval', requestId: 'ge-6', runId: 'run-a', targetRunId: 'run-ghost' },
        socket,
      );

      expect(parseLastWrite(writes)).toMatchObject({ ok: false, error: 'run_not_found' });
    });
  });

  // -------------------------------------------------------------------------
  // resolve-finding
  // -------------------------------------------------------------------------

  describe('mcp-resolve-finding', () => {
    it('refuses to resolve an item this run neither filed nor was seeded with', async () => {
      // The router validates only (projectId, status='pending'), so without the
      // scope guard a mistyped/hallucinated id would silently close an unrelated
      // pending item. address-review calls resolve N times per run with ids the
      // model transcribed, so this is the realistic failure.
      seedCompoundRun(fdb, { runId: 'run-a' });
      seedCompoundRun(fdb, { runId: 'run-b' });
      seedFinding(fdb, { id: 'ri_theirs', title: "another run's", runId: 'run-b' });

      const { socket, writes } = makeSocketDouble();
      await fHandler.handleMessage(
        {
          type: 'mcp-resolve-finding',
          requestId: 'rs-scope',
          runId: 'run-a',
          reviewItemId: 'ri_theirs',
          resolutionKind: 'fixed',
        },
        socket,
      );

      const response = parseLastWrite(writes);
      expect(response.ok).toBe(false);
      expect(response.error).toBe('finding_not_in_run_scope');
      // …and the other run's finding is untouched.
      await drain();
      const row = fdb.prepare(`SELECT status FROM review_items WHERE id = 'ri_theirs'`).get() as {
        status: string;
      };
      expect(row.status).toBe('pending');
    });

    it("resolves a SETTLED session-mate's finding from a live chat sentinel", async () => {
      // The other half of the loop the widened read opens. A chat can now SEE
      // the flow run's findings; without this arm every resolve on one came back
      // finding_not_in_run_scope, because a chat's run id is the `__quick__`
      // sentinel and never the run that filed them. Note the flow run is
      // COMPLETED and stays completed — session membership is the entitlement,
      // session-mate liveness is not, and nothing here revives it.
      fdb.exec('ALTER TABLE workflow_runs ADD COLUMN session_id TEXT');
      seedCompoundRun(fdb, { runId: 'run-flow', status: 'completed' });
      seedCompoundRun(fdb, { runId: 'run-sentinel' });
      fdb
        .prepare(`UPDATE workflow_runs SET session_id = 'sess-1' WHERE id IN ('run-flow', 'run-sentinel')`)
        .run();
      seedFinding(fdb, { id: 'ri_flow', title: 'Filed by the flow run', runId: 'run-flow' });

      const { socket, writes } = makeSocketDouble();
      await fHandler.handleMessage(
        {
          type: 'mcp-resolve-finding',
          requestId: 'rs-sess',
          runId: 'run-sentinel',
          reviewItemId: 'ri_flow',
          resolutionKind: 'fixed',
          note: 'fixed in the chat',
        },
        socket,
      );

      expect(parseLastWrite(writes)).toMatchObject({ ok: true });
      await drain();
      const row = fdb.prepare(`SELECT status FROM review_items WHERE id = 'ri_flow'`).get() as {
        status: string;
      };
      expect(row.status).toBe('resolved');
      // The settled session-mate was NOT revived as a side effect.
      const flow = fdb.prepare(`SELECT status FROM workflow_runs WHERE id = 'run-flow'`).get() as {
        status: string;
      };
      expect(flow.status).toBe('completed');
    });

    it('does NOT extend the session arm to another session\'s run', async () => {
      fdb.exec('ALTER TABLE workflow_runs ADD COLUMN session_id TEXT');
      seedCompoundRun(fdb, { runId: 'run-sentinel' });
      seedCompoundRun(fdb, { runId: 'run-elsewhere' });
      fdb.prepare(`UPDATE workflow_runs SET session_id = 'sess-1' WHERE id = 'run-sentinel'`).run();
      fdb.prepare(`UPDATE workflow_runs SET session_id = 'sess-2' WHERE id = 'run-elsewhere'`).run();
      seedFinding(fdb, { id: 'ri_far', title: 'Another session', runId: 'run-elsewhere' });

      const { socket, writes } = makeSocketDouble();
      await fHandler.handleMessage(
        {
          type: 'mcp-resolve-finding',
          requestId: 'rs-far',
          runId: 'run-sentinel',
          reviewItemId: 'ri_far',
          resolutionKind: 'fixed',
        },
        socket,
      );

      expect(parseLastWrite(writes)).toMatchObject({
        ok: false,
        error: 'finding_not_in_run_scope',
      });
    });

    it('refuses a non-finding review item (a gate or human task is not triage fodder)', async () => {
      seedCompoundRun(fdb, { runId: 'run-a' });
      fdb
        .prepare(
          `INSERT INTO review_items (id, project_id, run_id, kind, status, blocking, title, body)
           VALUES ('ri_gate', 1, 'run-a', 'human_task', 'pending', 1, 'Decide the thing', 'b')`,
        )
        .run();

      const { socket, writes } = makeSocketDouble();
      await fHandler.handleMessage(
        {
          type: 'mcp-resolve-finding',
          requestId: 'rs-kind',
          runId: 'run-a',
          reviewItemId: 'ri_gate',
          resolutionKind: 'triaged',
        },
        socket,
      );

      const response = parseLastWrite(writes);
      expect(response.ok).toBe(false);
      expect(response.error).toBe('not_a_finding');
    });

    it('still allows a compound run to resolve a SEEDED finding filed by an earlier run', async () => {
      // The seeded arm is why the ownership check cannot be a bare
      // `run_id = runId`: compound acts on findings that by definition belong to
      // earlier runs. Guarding without this arm would break that flow entirely.
      seedCompoundRun(fdb, { runId: 'run-old' });
      seedFinding(fdb, { id: 'ri_seeded', title: 'from an older run', runId: 'run-old' });
      seedCompoundRun(fdb, { runId: 'run-c', seedFindingIds: ['ri_seeded'] });

      const { socket, writes } = makeSocketDouble();
      await fHandler.handleMessage(
        {
          type: 'mcp-resolve-finding',
          requestId: 'rs-seeded',
          runId: 'run-c',
          reviewItemId: 'ri_seeded',
          resolutionKind: 'triaged',
        },
        socket,
      );

      expect(parseLastWrite(writes).ok).toBe(true);
      await drain();
      const row = fdb.prepare(`SELECT status FROM review_items WHERE id = 'ri_seeded'`).get() as {
        status: string;
      };
      expect(row.status).toBe('resolved');
    });

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
  let verifyStore: VerifyRunbookStore;

  // Codex adversarial-review finding 4: setup_proof:true is authorized against
  // the run's FROZEN workflow identity (resolveRunFrozenSpec's workflow_runs →
  // workflows.name JOIN), so these tests need real `workflows` rows behind
  // `workflow_id`, not just the bare workflow_runs row the pre-fix fixture got
  // away with. 'wf-1' (the pre-existing default every OTHER test in this block
  // already relies on) is deliberately named something that is NOT
  // 'verify-setup' — an ordinary sprint-shaped run is the realistic default,
  // and it doubles as the fixture for the "unauthorized workflow" rejection
  // test. 'wf-verify-setup' is the one workflow identity the new gate accepts.
  const NON_SETUP_WORKFLOW_ID = 'wf-1';
  const VERIFY_SETUP_WORKFLOW_ID = 'wf-verify-setup';
  // The __quick__ chat sentinel identity (b5f25edb): resolveRunFrozenSpec's
  // workflow_runs → workflows JOIN must see a real row named QUICK_WORKFLOW_NAME
  // for `isQuickRun` to flip true, exactly like the two IDs above.
  const QUICK_WORKFLOW_ID = 'wf-quick';

  /**
   * Seed a run with the migration-036 verify stamp applied inline.
   *
   * `worktreePath` defaults to a path that is NOT a git repo, which is the
   * fail-soft snapshot case (§5.5): `captureSnapshotSha` throws and the row is
   * stamped `snapshot_sha = NULL`. Tests that care about the snapshot pass
   * `gitRepo` (the real throwaway repo below) explicitly.
   */
  function seedVerifyRun(
    db: Database.Database,
    id: string,
    opts: {
      enabled: boolean;
      type?: string | null;
      chain?: string[] | null;
      status?: string;
      workflowId?: string;
      worktreePath?: string;
    },
  ): void {
    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, worktree_path, status, policy_json,
                                  verify_enabled, verify_type, verify_chain)
       VALUES (?, ?, 1, ?, ?, '{}', ?, ?, ?)`,
    ).run(
      id,
      opts.workflowId ?? NON_SETUP_WORKFLOW_ID,
      opts.worktreePath ?? nonRepoDir,
      opts.status ?? 'running',
      opts.enabled ? 1 : 0,
      opts.type ?? null,
      opts.chain ? JSON.stringify(opts.chain) : null,
    );
  }

  /**
   * Seed a resolvable machine-local runbook draft (migration 096) so a
   * setup_proof request's pin can pass `VerifyRunbookStore.getByHash`. The
   * content only needs to PARSE as a VerifyRunbookV1 — getByHash trusts the
   * stored `portable_hash` column rather than recomputing it, so the test can
   * pin an arbitrary hash string without hashing real content.
   */
  function seedRunbookDraft(db: Database.Database, hash: string, modality = 'web'): void {
    db.prepare(
      `INSERT INTO verify_runbook_local (project_id, modality, portable_hash, portable_json, version, status)
       VALUES (1, ?, ?, ?, 3, 'unproven-draft')`,
    ).run(
      modality,
      hash,
      JSON.stringify({
        version: 1,
        modalities: {
          [modality]: {
            serve: { cmd: 'pnpm dev --port ${PORT}' },
            attestation: { kind: 'http-endpoint', urlPath: '/__cyboflow_verify__' },
          },
        },
      }),
    );
  }

  /**
   * Two real on-disk fixtures for the §5.5 snapshot capture (round-3 finding 2).
   * `gitRepo` is a throwaway repo with one commit so `captureSnapshotSha`
   * resolves a real HEAD; `nonRepoDir` EXISTS but is not a repo, so the capture
   * fails for the reason under test (no git metadata) rather than for a missing
   * cwd. Both are process-wide for this block — nothing in it writes to them.
   */
  let gitRepo: string;
  let gitRepoHead: string;
  let nonRepoDir: string;

  beforeAll(() => {
    gitRepo = mkdtempSync(join(os.tmpdir(), 'cyboflow-mcp-verify-git-'));
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: gitRepo, encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 't@t.dev');
    git('config', 'user.name', 'T');
    writeFileSync(join(gitRepo, 'f.txt'), 'hi');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    gitRepoHead = git('rev-parse', 'HEAD').trim();
    nonRepoDir = mkdtempSync(join(os.tmpdir(), 'cyboflow-mcp-verify-plain-'));
  });

  afterAll(() => {
    rmSync(gitRepo, { recursive: true, force: true });
    rmSync(nonRepoDir, { recursive: true, force: true });
  });

  /**
   * (Re)initialize the scheduler singleton. `runbookStore` is passed only by the
   * proven-runbook injection test: with no store wired,
   * `resolveProvenRunbook` answers null and every other test in this block
   * enqueues unpinned, which is what they assert.
   */
  function initVerifyScheduler(runbookStore?: VerifyRunbookStore): void {
    VerificationScheduler._resetForTesting();
    VerificationScheduler.initialize({
      db: dbAdapter(vdb),
      backends: {},
      judge: {
        judge: vi.fn(
          async (): Promise<VerdictV1> => ({
            status: 'pass',
            confidence: 0.95,
            issues: [],
            feedback: 'ok',
            judgedFileNames: [],
            baselineUsed: false,
            model: 'fake',
          }),
        ),
      },
      artifactsDirResolver: () => '/tmp/artifacts',
      ...(runbookStore ? { runbookStore } : {}),
    });
  }

  beforeEach(() => {
    // includeWorkflowRunTaskColumns gives current_step_id + steps_snapshot_json,
    // which resolveReviewItemRunContext SELECTs to derive the actor.
    vdb = createTestDb({ disableForeignKeys: true, includeWorkflowRunTaskColumns: true });
    // The migration-055 verify stamp columns are provided by createTestDb's
    // includeWorkflowRunTaskColumns block; here we layer only the
    // verification_requests table onto the GATE_SCHEMA test DB.
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
        ended_at DATETIME,
        -- Migration 078 (verification-agent dual-format request plumbing).
        task_json TEXT,
        report_json TEXT,
        delivery_state TEXT,
        snapshot_sha TEXT,
        enqueue_key TEXT,
        -- Migration 095 (verification-setup-flow §3): classification + gate axes.
        failure_class TEXT,
        failure_evidence_json TEXT,
        modality TEXT,
        preflight_json TEXT,
        setup_proof INTEGER NOT NULL DEFAULT 0,
        -- Migration 096 (§5.2 seam 3): the content-addressed runbook PIN.
        runbook_hash TEXT,
        runbook_local_version INTEGER
      );
      -- Migration 096 (§5.2 seam 1): the MACHINE-LOCAL runbook record the
      -- register tool writes through VerifyRunbookStore.
      CREATE TABLE verify_runbook_local (
        project_id INTEGER NOT NULL,
        modality TEXT NOT NULL,
        portable_hash TEXT NOT NULL,
        portable_json TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL CHECK (status IN ('proven','unproven-draft')),
        bindings_json TEXT,
        proof_json TEXT,
        input_hash TEXT,
        host_fingerprint_json TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (project_id, modality)
      );
    `);

    // The two workflow IDENTITIES the setup-proof authorization gate
    // distinguishes (see the class doc-comment above) — inserted unconditionally
    // so every test's default 'wf-1' run resolves to a real (non-setup)
    // workflow name rather than the JOIN finding nothing.
    vdb
      .prepare(`INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES (?, 1, 'sprint', '{}')`)
      .run(NON_SETUP_WORKFLOW_ID);
    vdb
      .prepare(`INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES (?, 1, 'verify-setup', '{}')`)
      .run(VERIFY_SETUP_WORKFLOW_ID);
    vdb
      .prepare(`INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES (?, 1, ?, '{}')`)
      .run(QUICK_WORKFLOW_ID, QUICK_WORKFLOW_NAME);

    initVerifyScheduler();

    // Wired for the setup-proof pin-resolution tests below (getByHash reads the
    // DB directly; these IO deps are never invoked by getByHash but the store's
    // constructor requires them). Harmless for every other test in this block —
    // its presence only matters when a request carries setup_proof:true.
    verifyStore = new VerifyRunbookStore(dbAdapter(vdb), {
      readPortableFile: async () => null,
      computeInputHash: async () => 'input-hash-1',
      hostFingerprint: async () => 'host-fp-1',
    });
    vHandler = new McpQueryHandler(dbAdapter(vdb), undefined, { verifyRunbookStore: verifyStore });
  });

  afterEach(() => {
    VerificationScheduler._resetForTesting();
  });

  /**
   * A handler wired with `getVisualVerifyConfig` — the dep b5f25edb added so a
   * `__quick__` run can resolve its posture at CALL time (index.ts wires the real
   * one to `configManager.getVisualVerifyConfig()`; here it's a fixed value so
   * each test controls the global rung directly). Deliberately a SEPARATE
   * handler instance from `vHandler`: most of this block's tests exercise the
   * pre-existing frozen-stamp path and must keep doing so with the dep absent,
   * which is itself one of the required regression cases below.
   */
  function makeQuickHandler(configOverrides: Partial<ResolvedVisualVerifyConfig> = {}): McpQueryHandler {
    return new McpQueryHandler(dbAdapter(vdb), undefined, {
      verifyRunbookStore: verifyStore,
      getVisualVerifyConfig: () => ({ ...VISUAL_VERIFY_DEFAULTS, ...configOverrides }),
    });
  }

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

    // The ack NAMES its reason. A flow run's stamp is immutable, so the honest
    // reason says a new run is needed — not "flip a setting", which would send
    // the caller after a fix that cannot work here.
    const data = response.data as { skipped: boolean; reason: string };
    expect(data.skipped).toBe(true);
    expect(data.reason).toMatch(/immutable/i);
    expect(data.reason).toMatch(/new run/i);
    // NEVER the runbook: this branch skips before a row exists, so the
    // scheduler's runbook gate was never consulted and cannot be blamed.
    expect(data.reason).not.toMatch(/runbook for this project/i);

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

  // -------------------------------------------------------------------------
  // Dual-format contract (verification-agent redesign §5.2, migration 078):
  // `task` (a VerificationTaskV1) is strictly validated server-side and, when
  // valid, is authoritative for the persisted deliverable — task_json dual-
  // writes alongside deliverable_json. `task` absent leaves the legacy path
  // (exercised by every test above this block) byte-identical.
  // -------------------------------------------------------------------------

  it('absent task → task_json stays NULL (unchanged legacy path)', async () => {
    seedVerifyRun(vdb, 'run-v5a', {
      enabled: true,
      type: 'static-render-snapshot',
      chain: ['capturePage'],
    });

    const { socket, writes } = makeSocketDouble();
    await vHandler.handleMessage(
      {
        type: 'mcp-request-verification',
        requestId: 'rv-5a',
        runId: 'run-v5a',
        intent: 'legacy check',
        url: 'http://localhost:5173',
      },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(true);
    const data = response.data as { requestId: string };
    const row = vdb
      .prepare('SELECT task_json, deliverable_json FROM verification_requests WHERE id = ?')
      .get(data.requestId) as { task_json: string | null; deliverable_json: string };
    expect(row.task_json).toBeNull();
    expect(JSON.parse(row.deliverable_json)).toEqual({ intent: 'legacy check', url: 'http://localhost:5173' });
  });

  it('invalid task → ok:false invalid_verification_task, nothing enqueued', async () => {
    seedVerifyRun(vdb, 'run-v5b', {
      enabled: true,
      type: 'static-render-snapshot',
      chain: ['capturePage'],
    });

    const { socket, writes } = makeSocketDouble();
    await vHandler.handleMessage(
      {
        type: 'mcp-request-verification',
        requestId: 'rv-5b',
        runId: 'run-v5b',
        intent: 'ignored, task wins',
        // Missing `summary` — an invalid VerificationTaskV1.
        task: { version: 1, behaviors: [] },
      },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/^invalid_verification_task: summary:/);
    const count = vdb.prepare('SELECT COUNT(*) AS n FROM verification_requests').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('valid task → enqueued input derives intent/url/htmlPath/viewports/taskRef from the task and dual-writes task_json', async () => {
    seedVerifyRun(vdb, 'run-v5c', {
      enabled: true,
      type: 'static-render-snapshot',
      chain: ['capturePage'],
    });

    const task = {
      version: 1,
      taskRef: 'TASK-042',
      summary: 'Check the settings toggle renders, default off',
      behaviors: [{ id: 'b1', description: 'toggle renders', expected: 'toggle visible, unchecked' }],
      target: { url: 'http://localhost:5173', htmlPath: '/tmp/out/index.html' },
      viewports: [{ width: 1280, height: 720 }],
    };

    const { socket, writes } = makeSocketDouble();
    await vHandler.handleMessage(
      {
        type: 'mcp-request-verification',
        requestId: 'rv-5c',
        runId: 'run-v5c',
        // Legacy fields present but SUPERSEDED by the task per the dual-format contract.
        intent: 'ignored, task wins',
        url: 'http://ignored',
        task,
      },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(true);
    const data = response.data as { requestId: string };
    const row = vdb
      .prepare('SELECT deliverable_json, task_json FROM verification_requests WHERE id = ?')
      .get(data.requestId) as { deliverable_json: string; task_json: string | null };

    const deliverable = JSON.parse(row.deliverable_json) as Record<string, unknown>;
    expect(deliverable.intent).toBe(task.summary);
    expect(deliverable.url).toBe('http://localhost:5173');
    expect(deliverable.htmlPath).toBe('/tmp/out/index.html');
    expect(deliverable.viewports).toEqual([{ width: 1280, height: 720 }]);
    expect(deliverable.taskRef).toBe('TASK-042');

    expect(row.task_json).not.toBeNull();
    expect(JSON.parse(row.task_json as string)).toEqual(task);
  });

  it('task+wire taskRef precedence: task.taskRef wins over the wire task_ref arg, and both columns agree', async () => {
    seedVerifyRun(vdb, 'run-v5d', {
      enabled: true,
      type: 'static-render-snapshot',
      chain: ['capturePage'],
    });

    const task = {
      version: 1,
      taskRef: 'TASK-100',
      summary: 'Check the page renders',
      behaviors: [],
    };

    const { socket, writes } = makeSocketDouble();
    await vHandler.handleMessage(
      {
        type: 'mcp-request-verification',
        requestId: 'rv-5d',
        runId: 'run-v5d',
        intent: 'ignored',
        task,
        taskRef: 'TASK-999',
      },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(true);
    const data = response.data as { requestId: string };
    const row = vdb
      .prepare('SELECT deliverable_json, task_json FROM verification_requests WHERE id = ?')
      .get(data.requestId) as { deliverable_json: string; task_json: string };
    expect((JSON.parse(row.deliverable_json) as { taskRef?: string }).taskRef).toBe('TASK-100');
    expect((JSON.parse(row.task_json) as { taskRef?: string }).taskRef).toBe('TASK-100');
  });

  it('task without a taskRef falls back to the wire task_ref arg, reflected into BOTH columns', async () => {
    seedVerifyRun(vdb, 'run-v5e', {
      enabled: true,
      type: 'static-render-snapshot',
      chain: ['capturePage'],
    });

    const task = { version: 1, summary: 'Check the page renders', behaviors: [] };

    const { socket, writes } = makeSocketDouble();
    await vHandler.handleMessage(
      {
        type: 'mcp-request-verification',
        requestId: 'rv-5e',
        runId: 'run-v5e',
        intent: 'ignored',
        task,
        taskRef: 'TASK-777',
      },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(true);
    const data = response.data as { requestId: string };
    const row = vdb
      .prepare('SELECT deliverable_json, task_json FROM verification_requests WHERE id = ?')
      .get(data.requestId) as { deliverable_json: string; task_json: string };
    expect((JSON.parse(row.deliverable_json) as { taskRef?: string }).taskRef).toBe('TASK-777');
    expect((JSON.parse(row.task_json) as { taskRef?: string }).taskRef).toBe('TASK-777');
  });

  // Ownership guard: when a programmatic run's controller owns the enqueue it
  // goes through its direct host capability, never this socket path — so an
  // MCP-path call on such a run is a rogue step turn, regardless of provider
  // (the per-spawn disallowedTools denial only reaches the Claude SDK manager).
  // Scoped to chains that actually HAVE a controller-owned visual-verify step,
  // since "programmatic" was only ever a proxy for that (dogfood finding 0).
  it('programmatic run → rejected provider-independently, no row enqueued', async () => {
    seedVerifyRun(vdb, 'run-vprog', {
      enabled: true,
      type: 'static-render-snapshot',
      chain: ['capturePage'],
    });
    vdb.prepare("UPDATE workflow_runs SET execution_model = 'programmatic' WHERE id = ?").run('run-vprog');

    const { socket, writes } = makeSocketDouble();
    await vHandler.handleMessage(
      {
        type: 'mcp-request-verification',
        requestId: 'rv-prog',
        runId: 'run-vprog',
        intent: 'the toggle renders',
        url: 'http://localhost:5173',
        taskRef: 'TASK-001',
      },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/^programmatic_run_verification_rejected:/);
    const count = vdb.prepare('SELECT COUNT(*) AS n FROM verification_requests').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('programmatic guard precedes the disabled-run skip (rejects even when verify is disabled)', async () => {
    seedVerifyRun(vdb, 'run-vprog2', { enabled: false });
    vdb.prepare("UPDATE workflow_runs SET execution_model = 'programmatic' WHERE id = ?").run('run-vprog2');

    const { socket, writes } = makeSocketDouble();
    await vHandler.handleMessage(
      {
        type: 'mcp-request-verification',
        requestId: 'rv-prog2',
        runId: 'run-vprog2',
        intent: 'anything',
      },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/^programmatic_run_verification_rejected:/);
  });

  it('orchestrated run is unaffected by the programmatic guard', async () => {
    seedVerifyRun(vdb, 'run-vorch', {
      enabled: true,
      type: 'static-render-snapshot',
      chain: ['capturePage'],
    });
    vdb.prepare("UPDATE workflow_runs SET execution_model = 'orchestrated' WHERE id = ?").run('run-vorch');

    const { socket, writes } = makeSocketDouble();
    await vHandler.handleMessage(
      {
        type: 'mcp-request-verification',
        requestId: 'rv-orch',
        runId: 'run-vorch',
        intent: 'the toggle renders',
        url: 'http://localhost:5173',
      },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(true);
    expect(typeof (response.data as { requestId?: string }).requestId).toBe('string');
  });

  // The blocker the first live dogfood run surfaced (2026-07-31): verify-setup
  // resolves PROGRAMMATIC like every other SDK run, but its chain has no fan-out
  // and therefore no controller-owned visual-verify step — nobody else can
  // enqueue for it, and its `prove` step's entire deliverable is firing a proof
  // through this exact path. The old execution-model-only guard rejected it,
  // making the flow that bootstraps verification unable to prove anything.
  it('programmatic run whose chain has NO controller-owned visual-verify step is NOT rejected', async () => {
    seedVerifyRun(vdb, 'run-vsetupprog', {
      enabled: true,
      type: 'static-render-snapshot',
      chain: ['capturePage'],
      workflowId: VERIFY_SETUP_WORKFLOW_ID,
    });
    vdb.prepare("UPDATE workflow_runs SET execution_model = 'programmatic' WHERE id = ?").run('run-vsetupprog');

    const { socket, writes } = makeSocketDouble();
    await vHandler.handleMessage(
      {
        type: 'mcp-request-verification',
        requestId: 'rv-setupprog',
        runId: 'run-vsetupprog',
        intent: 'the runbook stands the project up',
        url: 'http://localhost:5173',
      },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(true);
    expect(typeof (response.data as { requestId?: string }).requestId).toBe('string');
  });

  // §7.2 (docs/proposals/verification-setup-flow.md): the ENQUEUE half of the
  // dependency guard, applied through the SAME shared helper the programmatic
  // seam calls — a snapshot's node_modules is symlinked from the live worktree,
  // so an install inside it flips native-module ABIs under every sibling lane,
  // invisibly to the mutation check.
  it('rejects a composed task whose build step mutates dependencies, enqueuing nothing', async () => {
    seedVerifyRun(vdb, 'run-vguard', {
      enabled: true,
      type: 'interactive-web-behavior',
      chain: ['playwright'],
    });

    const { socket, writes } = makeSocketDouble();
    await vHandler.handleMessage(
      {
        type: 'mcp-request-verification',
        requestId: 'rv-guard',
        runId: 'run-vguard',
        intent: 'the toggle renders',
        task: {
          version: 1,
          summary: 'the toggle renders',
          behaviors: [{ id: 'b1', description: 'renders', expected: 'visible' }],
          build: ['pnpm install --frozen-lockfile', 'pnpm run build'],
          serve: { cmd: 'pnpm dev --port ${PORT}' },
        },
      },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(false);
    // Mirrors the invalid_verification_task naming style, and names the command
    // verbatim so the composer can fix it without re-deriving anything.
    expect(response.error).toMatch(/^forbidden_dependency_command:/);
    expect(response.error).toContain('pnpm install --frozen-lockfile');
    const count = vdb.prepare('SELECT COUNT(*) AS n FROM verification_requests').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('a clean composed task is unaffected by the §7.2 guard', async () => {
    seedVerifyRun(vdb, 'run-vguard-ok', {
      enabled: true,
      type: 'interactive-web-behavior',
      chain: ['playwright'],
    });

    const { socket, writes } = makeSocketDouble();
    await vHandler.handleMessage(
      {
        type: 'mcp-request-verification',
        requestId: 'rv-guard-ok',
        runId: 'run-vguard-ok',
        intent: 'the toggle renders',
        task: {
          version: 1,
          summary: 'the toggle renders',
          behaviors: [{ id: 'b1', description: 'renders', expected: 'visible' }],
          build: ['pnpm run build'],
          serve: { cmd: 'pnpm dev --port ${PORT}' },
        },
      },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(true);
    expect(typeof (response.data as { requestId?: string }).requestId).toBe('string');
  });

  // -------------------------------------------------------------------------
  // setup_proof AUTHORIZATION (§3.6 + §5.2 seam 3, Codex adversarial-review
  // finding 4). setup_proof:true is a self-declared exemption from BOTH the
  // §3.2 degrade gate and the project's verification budget, and the MCP
  // socket is the untrusted seam it arrives over — so it is gated on (1) the
  // run's FROZEN workflow identity actually being 'verify-setup' and (2) a
  // pin that resolves to a draft really registered via
  // cyboflow_register_verify_runbook. See handleRequestVerification's
  // `msg.setupProof === true` block.
  // -------------------------------------------------------------------------

  it('setup_proof from a verify-setup-stamped run with a valid pin is authorized and threads the pin onto the enqueued row', async () => {
    seedVerifyRun(vdb, 'run-vproof', {
      enabled: true,
      type: 'interactive-web-behavior',
      chain: ['playwright'],
      workflowId: VERIFY_SETUP_WORKFLOW_ID,
      // A real repo so this test also pins down round-3 finding 2's worst case:
      // the setup flow's own PROOF run used to run the dirty live-worktree
      // fallback, i.e. a runbook could be marked proven off an unisolated build.
      worktreePath: gitRepo,
    });
    seedRunbookDraft(vdb, 'hash-abc');

    const { socket, writes } = makeSocketDouble();
    await vHandler.handleMessage(
      {
        type: 'mcp-request-verification',
        requestId: 'rv-proof',
        runId: 'run-vproof',
        intent: 'the app boots',
        task: {
          version: 1,
          summary: 'the app boots',
          behaviors: [{ id: 'b1', description: 'boots', expected: 'window visible' }],
          serve: { cmd: 'pnpm dev --port ${PORT}' },
        },
        setupProof: true,
        runbookHash: 'hash-abc',
        runbookLocalVersion: 3,
      },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(true);
    const data = response.data as { requestId: string };
    const row = vdb
      .prepare(
        'SELECT setup_proof, runbook_hash, runbook_local_version, snapshot_sha FROM verification_requests WHERE id = ?',
      )
      .get(data.requestId) as {
      setup_proof: number;
      runbook_hash: string | null;
      runbook_local_version: number | null;
      snapshot_sha: string | null;
    };
    expect(row.setup_proof).toBe(1);
    expect(row.runbook_hash).toBe('hash-abc');
    expect(row.runbook_local_version).toBe(3);
    expect(row.snapshot_sha).toBe(gitRepoHead);
  });

  it('setup_proof from a sprint (non-verify-setup) run is rejected with setup_proof_not_authorized, naming the actual workflow, and enqueues nothing', async () => {
    // A valid, resolvable pin is seeded anyway — the point of this test is
    // that the WORKFLOW check rejects first, before the pin is ever consulted;
    // a caller cannot buy the exemption just by also holding a real pin.
    seedVerifyRun(vdb, 'run-vproof-wrongflow', {
      enabled: true,
      type: 'interactive-web-behavior',
      chain: ['playwright'],
      // workflowId omitted ⇒ defaults to NON_SETUP_WORKFLOW_ID ('sprint').
    });
    seedRunbookDraft(vdb, 'hash-abc');

    const { socket, writes } = makeSocketDouble();
    await vHandler.handleMessage(
      {
        type: 'mcp-request-verification',
        requestId: 'rv-proof-wrongflow',
        runId: 'run-vproof-wrongflow',
        intent: 'the app boots',
        task: {
          version: 1,
          summary: 'the app boots',
          behaviors: [{ id: 'b1', description: 'boots', expected: 'window visible' }],
          serve: { cmd: 'pnpm dev --port ${PORT}' },
        },
        setupProof: true,
        runbookHash: 'hash-abc',
        runbookLocalVersion: 3,
      },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(false);
    expect(response.error).toBe("setup_proof_not_authorized: this run's workflow is 'sprint', not 'verify-setup' — setup_proof is verify-setup-flow-only");
    const count = vdb.prepare('SELECT COUNT(*) AS n FROM verification_requests').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('setup_proof from a verify-setup run with NO pin is rejected with setup_proof_requires_pin and enqueues nothing', async () => {
    seedVerifyRun(vdb, 'run-vproof-nopin', {
      enabled: true,
      type: 'interactive-web-behavior',
      chain: ['playwright'],
      workflowId: VERIFY_SETUP_WORKFLOW_ID,
    });

    const { socket, writes } = makeSocketDouble();
    await vHandler.handleMessage(
      {
        type: 'mcp-request-verification',
        requestId: 'rv-proof-nopin',
        runId: 'run-vproof-nopin',
        intent: 'the app boots',
        task: {
          version: 1,
          summary: 'the app boots',
          behaviors: [{ id: 'b1', description: 'boots', expected: 'window visible' }],
          serve: { cmd: 'pnpm dev --port ${PORT}' },
        },
        setupProof: true,
      },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/^setup_proof_requires_pin:/);
    const count = vdb.prepare('SELECT COUNT(*) AS n FROM verification_requests').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('setup_proof from a verify-setup run with an UNRESOLVABLE hash is rejected with setup_proof_requires_pin and enqueues nothing', async () => {
    seedVerifyRun(vdb, 'run-vproof-badhash', {
      enabled: true,
      type: 'interactive-web-behavior',
      chain: ['playwright'],
      workflowId: VERIFY_SETUP_WORKFLOW_ID,
    });
    // Deliberately NOT seeding a draft for this hash — 'hash-nonexistent' never
    // resolves through the store.

    const { socket, writes } = makeSocketDouble();
    await vHandler.handleMessage(
      {
        type: 'mcp-request-verification',
        requestId: 'rv-proof-badhash',
        runId: 'run-vproof-badhash',
        intent: 'the app boots',
        task: {
          version: 1,
          summary: 'the app boots',
          behaviors: [{ id: 'b1', description: 'boots', expected: 'window visible' }],
          serve: { cmd: 'pnpm dev --port ${PORT}' },
        },
        setupProof: true,
        runbookHash: 'hash-nonexistent',
        runbookLocalVersion: 1,
      },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/^setup_proof_requires_pin:/);
    const count = vdb.prepare('SELECT COUNT(*) AS n FROM verification_requests').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('HALF a pin is not a pin — a verify-setup run supplying only the hash is rejected with setup_proof_requires_pin', async () => {
    seedVerifyRun(vdb, 'run-vhalfpin', {
      enabled: true,
      type: 'interactive-web-behavior',
      chain: ['playwright'],
      workflowId: VERIFY_SETUP_WORKFLOW_ID,
    });
    seedRunbookDraft(vdb, 'hash-abc');

    const { socket, writes } = makeSocketDouble();
    await vHandler.handleMessage(
      {
        type: 'mcp-request-verification',
        requestId: 'rv-halfpin',
        runId: 'run-vhalfpin',
        intent: 'the app boots',
        task: {
          version: 1,
          summary: 'the app boots',
          behaviors: [{ id: 'b1', description: 'boots', expected: 'window visible' }],
          serve: { cmd: 'pnpm dev --port ${PORT}' },
        },
        setupProof: true,
        runbookHash: 'hash-abc',
        // runbookLocalVersion deliberately omitted — half a pin is no pin.
      },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/^setup_proof_requires_pin:/);
    const count = vdb.prepare('SELECT COUNT(*) AS n FROM verification_requests').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('an ordinary request stamps no pin and no setup-proof flag', async () => {
    seedVerifyRun(vdb, 'run-vplain', {
      enabled: true,
      type: 'static-render-snapshot',
      chain: ['capturePage'],
    });

    const { socket, writes } = makeSocketDouble();
    await vHandler.handleMessage(
      {
        type: 'mcp-request-verification',
        requestId: 'rv-plain',
        runId: 'run-vplain',
        intent: 'the page renders',
        url: 'http://localhost:5173',
      },
      socket,
    );

    const data = parseLastWrite(writes).data as { requestId: string };
    const row = vdb
      .prepare(
        'SELECT setup_proof, runbook_hash, runbook_local_version FROM verification_requests WHERE id = ?',
      )
      .get(data.requestId) as {
      setup_proof: number;
      runbook_hash: string | null;
      runbook_local_version: number | null;
    };
    expect(row.setup_proof).toBe(0);
    expect(row.runbook_hash).toBeNull();
    expect(row.runbook_local_version).toBeNull();
  });

  // -------------------------------------------------------------------------
  // WIRE-PIN CONTAINMENT (Codex round-3 finding 1). `prepareVerificationEnqueue`
  // treats a caller-supplied pin as authoritative and SKIPS the proven-runbook
  // lookup — semantics written for the authorized setup-proof envelope. On an
  // ordinary request that same short-circuit is a kill switch: an invented hash
  // suppresses the injection, the runner's CAS then reports a runbook/sha
  // mismatch, and the mismatch env-SKIPS — which ADVANCES the lane. So the
  // handler drops both wire fields unless setup_proof authorized them. These two
  // tests are the MCP-to-row proof of that; the setup-proof half is unchanged
  // and covered by the authorization tests above.
  // -------------------------------------------------------------------------

  /**
   * A portable runbook whose build/serve deliberately DIFFER from what the
   * caller composes below, so a successful injection is observable in the
   * persisted `task_json` rather than merely in the pin columns.
   */
  const PROVEN_RUNBOOK_JSON = JSON.stringify({
    version: 1,
    modalities: {
      web: {
        build: ['pnpm run build:web'],
        serve: { cmd: 'pnpm run preview -- --port ${PORT}' },
        attestation: { kind: 'http-endpoint', urlPath: '/__cyboflow_verify__' },
      },
    },
  });

  /** The composer's guess at how to stand the project up — the part §1 says is never right. */
  const GUESSED_TASK = {
    version: 1,
    summary: 'the app boots',
    behaviors: [{ id: 'b1', description: 'boots', expected: 'window visible' }],
    serve: { cmd: 'pnpm dev --port ${PORT}' },
  };

  /**
   * Register PROVEN_RUNBOOK_JSON and flip it proven, returning the store to wire
   * into the scheduler. The three store IO deps are faked (they are its only
   * filesystem contact) so this stays a test about the enqueue seam; the values
   * must simply be STABLE, since `status()` re-derives all three and demotes on
   * any drift.
   */
  async function seedProvenRunbook(): Promise<{ store: VerifyRunbookStore; hash: string; version: number }> {
    const store = new VerifyRunbookStore(dbAdapter(vdb), {
      readPortableFile: async () => PROVEN_RUNBOOK_JSON,
      computeInputHash: async () => 'input-hash-1',
      hostFingerprint: async () => 'host-fp-1',
    });
    const registered = (await store.registerDraft(1, gitRepo, 'web')) as { hash: string; version: number };
    expect(store.markProven(1, 'web', registered.hash, registered.version, '{}')).toEqual({ ok: true });
    return { store, hash: registered.hash, version: registered.version };
  }

  function readPinRow(requestId: string): {
    setup_proof: number;
    runbook_hash: string | null;
    runbook_local_version: number | null;
    task_json: string | null;
    snapshot_sha: string | null;
  } {
    return vdb
      .prepare(
        `SELECT setup_proof, runbook_hash, runbook_local_version, task_json, snapshot_sha
           FROM verification_requests WHERE id = ?`,
      )
      .get(requestId) as ReturnType<typeof readPinRow>;
  }

  it('an ordinary request supplying BOGUS pin fields has them dropped — the engine still injects and pins the PROVEN revision', async () => {
    const { store, hash, version } = await seedProvenRunbook();
    initVerifyScheduler(store);
    seedVerifyRun(vdb, 'run-vbogus', {
      enabled: true,
      type: 'static-render-snapshot',
      chain: ['capturePage'],
      worktreePath: gitRepo,
    });
    const handler = new McpQueryHandler(dbAdapter(vdb), undefined, { verifyRunbookStore: store });

    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage(
      {
        type: 'mcp-request-verification',
        requestId: 'rv-bogus',
        runId: 'run-vbogus',
        intent: 'the app boots',
        task: GUESSED_TASK,
        // No setup_proof — an ordinary lane inventing a pin.
        runbookHash: 'bogus-hash-nobody-registered',
        runbookLocalVersion: 999,
      },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(true);
    const row = readPinRow((response.data as { requestId: string }).requestId);
    // The pin the ENGINE resolved, never the one the caller sent.
    expect(row.runbook_hash).toBe(hash);
    expect(row.runbook_local_version).toBe(version);
    expect(row.setup_proof).toBe(0);
    // …and the injection the bogus pin would have short-circuited actually ran.
    const persisted = JSON.parse(row.task_json as string) as { build?: string[]; serve?: { cmd?: string } };
    expect(persisted.build).toEqual(['pnpm run build:web']);
    expect(persisted.serve?.cmd).toBe('pnpm run preview -- --port ${PORT}');
  });

  it('an ordinary request with BOGUS pin fields and NO proven record enqueues UNPINNED (the bogus hash is never stamped)', async () => {
    // The sharpest form of the finding: with nothing to resolve, the pre-fix
    // handler stamped the caller's string verbatim and every such request
    // reached the runner pre-poisoned for a CAS mismatch.
    seedVerifyRun(vdb, 'run-vbogus-nostore', {
      enabled: true,
      type: 'static-render-snapshot',
      chain: ['capturePage'],
      worktreePath: gitRepo,
    });

    const { socket, writes } = makeSocketDouble();
    await vHandler.handleMessage(
      {
        type: 'mcp-request-verification',
        requestId: 'rv-bogus-nostore',
        runId: 'run-vbogus-nostore',
        intent: 'the app boots',
        task: GUESSED_TASK,
        runbookHash: 'bogus-hash-nobody-registered',
        runbookLocalVersion: 999,
      },
      socket,
    );

    const row = readPinRow((parseLastWrite(writes).data as { requestId: string }).requestId);
    expect(row.runbook_hash).toBeNull();
    expect(row.runbook_local_version).toBeNull();
  });

  // -------------------------------------------------------------------------
  // SNAPSHOT SHA (§5.5, Codex round-3 finding 2). The MCP path never captured
  // one, so every orchestrated verification ran the runner's dirty
  // live-worktree FALLBACK — no isolation from sibling lanes, and the
  // fallback's build/launch_failed→skipped carve-out (a skip ADVANCES a lane)
  // as the normal path. It now mirrors the programmatic seam exactly:
  // capture from the run's worktree, fail-soft to null.
  // -------------------------------------------------------------------------

  it('stamps the run worktree HEAD as snapshot_sha so the request builds against a snapshot, not the live tree', async () => {
    seedVerifyRun(vdb, 'run-vsnap', {
      enabled: true,
      type: 'static-render-snapshot',
      chain: ['capturePage'],
      worktreePath: gitRepo,
    });

    const { socket, writes } = makeSocketDouble();
    await vHandler.handleMessage(
      {
        type: 'mcp-request-verification',
        requestId: 'rv-snap',
        runId: 'run-vsnap',
        intent: 'the page renders',
        url: 'http://localhost:5173',
      },
      socket,
    );

    const row = readPinRow((parseLastWrite(writes).data as { requestId: string }).requestId);
    expect(row.snapshot_sha).toBe(gitRepoHead);
  });

  it('a worktree that is not a git repo → snapshot_sha NULL and the request still enqueues (fail-soft, not a lost verification)', async () => {
    // worktreePath defaults to `nonRepoDir` — a real directory with no git
    // metadata, so the capture fails for the reason under test.
    seedVerifyRun(vdb, 'run-vsnap-null', {
      enabled: true,
      type: 'static-render-snapshot',
      chain: ['capturePage'],
    });

    const { socket, writes } = makeSocketDouble();
    await vHandler.handleMessage(
      {
        type: 'mcp-request-verification',
        requestId: 'rv-snap-null',
        runId: 'run-vsnap-null',
        intent: 'the page renders',
        url: 'http://localhost:5173',
      },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(true);
    const row = readPinRow((response.data as { requestId: string }).requestId);
    expect(row.snapshot_sha).toBeNull();
  });

  // -------------------------------------------------------------------------
  // mcp-await-verification (§5.2 seam 2) — the BLOCKING verdict read. Rows are
  // written directly here: these tests are about the await contract, not about
  // driving a request through the drain.
  // -------------------------------------------------------------------------

  function insertTerminalRequest(
    id: string,
    runId: string,
    patch: { status: string; verdictJson?: string; errorMessage?: string; failureClass?: string } = {
      status: 'passed',
    },
  ): void {
    vdb.prepare(
      `INSERT INTO verification_requests
         (id, run_id, project_id, status, verify_type, deliverable_json, chain_json,
          verdict_json, error_message, failure_class)
       VALUES (?, ?, 1, ?, 'interactive-web-behavior', '{"intent":"x"}', '[]', ?, ?, ?)`,
    ).run(
      id,
      runId,
      patch.status,
      patch.verdictJson ?? null,
      patch.errorMessage ?? null,
      patch.failureClass ?? null,
    );
  }

  it('await → replies with the settled status, failure class, feedback and error message', async () => {
    seedVerifyRun(vdb, 'run-await', { enabled: true, type: 'interactive-web-behavior', chain: ['playwright'] });
    insertTerminalRequest('vr_await_ok', 'run-await', {
      status: 'failed',
      verdictJson: JSON.stringify({ feedback: 'the serve command never came up' }),
      errorMessage: 'serve timed out',
      failureClass: 'env',
    });

    const { socket, writes } = makeSocketDouble();
    await vHandler.handleMessage(
      {
        type: 'mcp-await-verification',
        requestId: 'aw-1',
        runId: 'run-await',
        verificationRequestId: 'vr_await_ok',
      },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(true);
    expect(response.data).toEqual({
      status: 'failed',
      failureClass: 'env',
      feedback: 'the serve command never came up',
      errorMessage: 'serve timed out',
    });
  });

  it("await on ANOTHER run's request → not_your_request (run-bound like every other tool)", async () => {
    seedVerifyRun(vdb, 'run-await-a', { enabled: true, type: 'interactive-web-behavior', chain: ['playwright'] });
    seedVerifyRun(vdb, 'run-await-b', { enabled: true, type: 'interactive-web-behavior', chain: ['playwright'] });
    insertTerminalRequest('vr_await_other', 'run-await-b');

    const { socket, writes } = makeSocketDouble();
    await vHandler.handleMessage(
      {
        type: 'mcp-await-verification',
        requestId: 'aw-2',
        runId: 'run-await-a',
        verificationRequestId: 'vr_await_other',
      },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(false);
    expect(response.error).toBe('not_your_request');
  });

  it('await on an unknown request id → verification_request_not_found', async () => {
    seedVerifyRun(vdb, 'run-await-missing', {
      enabled: true,
      type: 'interactive-web-behavior',
      chain: ['playwright'],
    });

    const { socket, writes } = makeSocketDouble();
    await vHandler.handleMessage(
      {
        type: 'mcp-await-verification',
        requestId: 'aw-3',
        runId: 'run-await-missing',
        verificationRequestId: 'vr_does_not_exist',
      },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(false);
    expect(response.error).toBe('verification_request_not_found');
  });

  it('await returns the CURRENT status with an await-timeout note when the wait budget expires', async () => {
    seedVerifyRun(vdb, 'run-await-slow', {
      enabled: true,
      type: 'interactive-web-behavior',
      chain: ['playwright'],
    });
    insertTerminalRequest('vr_await_slow', 'run-await-slow', { status: 'running' });

    const { socket, writes } = makeSocketDouble();
    await vHandler.handleMessage(
      {
        type: 'mcp-await-verification',
        requestId: 'aw-4',
        runId: 'run-await-slow',
        verificationRequestId: 'vr_await_slow',
        timeoutMs: 20,
      },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(true);
    expect(response.data).toEqual({
      status: 'running',
      failureClass: null,
      feedback: null,
      errorMessage: 'await timeout',
    });
  });

  it('await on a terminal run → run_not_active (no wait)', async () => {
    seedVerifyRun(vdb, 'run-await-done', {
      enabled: true,
      type: 'interactive-web-behavior',
      chain: ['playwright'],
      status: 'completed',
    });
    insertTerminalRequest('vr_await_done', 'run-await-done');

    const { socket, writes } = makeSocketDouble();
    await vHandler.handleMessage(
      {
        type: 'mcp-await-verification',
        requestId: 'aw-5',
        runId: 'run-await-done',
        verificationRequestId: 'vr_await_done',
      },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(false);
    expect(response.error).toBe('run_not_active');
  });

  // -------------------------------------------------------------------------
  // QUICK-SESSION LATE BINDING (b5f25edb). A `__quick__` chat sentinel's
  // verify_chain stamp is minted once on the session's first turn and has no
  // UPDATE path, so it resolves posture at CALL time through the OPTIONAL
  // `getVisualVerifyConfig` dep instead — gated on `isQuickRun` (the run's
  // FROZEN workflow name, via resolveRunFrozenSpec, equals QUICK_WORKFLOW_NAME)
  // AND the dep actually being present, so every pre-existing fixture that
  // builds a deps bag without it keeps its old behavior untouched. `vHandler`
  // (built in `beforeEach` with no `getVisualVerifyConfig`) stays the control
  // for "old wiring, unaffected"; `makeQuickHandler` builds the post-change
  // wiring on demand.
  // -------------------------------------------------------------------------

  it('QUICK run + getVisualVerifyConfig enabled=true → enqueues (posture resolved at CALL time, overriding a DISABLED frozen stamp) and persists chain_json exactly ["agent"]', async () => {
    // Stamped DISABLED — this is the exact bug b5f25edb fixes: a `__quick__`
    // sentinel minted before the master switch was flipped on is frozen
    // disabled forever under the OLD stamp-reading path. The quick branch must
    // enqueue anyway by resolving the CURRENT global config instead of this stamp.
    seedVerifyRun(vdb, 'run-quick-enabled', { enabled: false, workflowId: QUICK_WORKFLOW_ID });

    const quickHandler = makeQuickHandler({ enabled: true });
    const { socket, writes } = makeSocketDouble();
    await quickHandler.handleMessage(
      {
        type: 'mcp-request-verification',
        requestId: 'rvq-1',
        runId: 'run-quick-enabled',
        intent: 'the quick-session UI renders',
        url: 'http://localhost:5173',
      },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(true);
    const data = response.data as { requestId: string; type: string; skipped?: boolean };
    expect(data.skipped).toBeUndefined();
    expect(typeof data.requestId).toBe('string');
    expect(data.type).toBe('static-render-snapshot');

    const row = vdb
      .prepare('SELECT chain_json, verify_type FROM verification_requests WHERE id = ?')
      .get(data.requestId) as { chain_json: string; verify_type: string };
    // Written VERBATIM, not intersected against FALLBACK_CHAINS — the
    // intersection would erase the 'agent' selector (it is not a
    // VisualBackendId) and misroute the row to the legacy waterfall.
    expect(row.chain_json).toBe('["agent"]');
    expect(row.verify_type).toBe('static-render-snapshot');
  });

  it('QUICK run + getVisualVerifyConfig enabled=false → replies { skipped:true } and enqueues nothing', async () => {
    seedVerifyRun(vdb, 'run-quick-disabled', { enabled: false, workflowId: QUICK_WORKFLOW_ID });

    const quickHandler = makeQuickHandler({ enabled: false });
    const { socket, writes } = makeSocketDouble();
    await quickHandler.handleMessage(
      {
        type: 'mcp-request-verification',
        requestId: 'rvq-2',
        runId: 'run-quick-disabled',
        intent: 'should be skipped',
      },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(true);

    // REGRESSION (observed in dogfooding): a quick session skipped here for a
    // plain disabled master switch, and — handed a bare `{ skipped: true }` —
    // told the user the project had "no proven verification runbook". That was
    // the only skip reason named anywhere in its context, so it filled the gap
    // with the wrong one and the user chased a runbook that was not the problem.
    // The reason must therefore be present, point at the switch, say the fix
    // takes effect without a restart, and disclaim the runbook explicitly.
    const data = response.data as { skipped: boolean; reason: string };
    expect(data.skipped).toBe(true);
    expect(data.reason).toMatch(/turned OFF/i);
    expect(data.reason).toMatch(/no restart/i);
    expect(data.reason).toMatch(/says NOTHING about whether the project has a runbook/i);

    const count = vdb
      .prepare("SELECT COUNT(*) AS n FROM verification_requests WHERE run_id = 'run-quick-disabled'")
      .get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('REGRESSION — a non-quick run still reads its FROZEN stamp (chain_json "[]" under the default agent engine), even when getVisualVerifyConfig is wired', async () => {
    // Mirrors what createRun actually stamps for an ordinary flow run under the
    // default agent engine: verify_chain = ['agent']. The pre-existing
    // intersection (FALLBACK_CHAINS[type] ∩ the stamp narrowed to
    // VisualBackendId[]) always empties this out — 'agent' narrows away — so
    // the persisted chain_json is '[]', byte-identical to before b5f25edb.
    // `quickHandler` (not `vHandler`) is used deliberately: it carries
    // getVisualVerifyConfig, the realistic post-change production wiring — the
    // point of this test is that a NON-quick run ignores that dep entirely
    // because `isQuickRun` is false, proving the change has zero blast radius
    // on sprint/ship runs.
    seedVerifyRun(vdb, 'run-flow-regression', {
      enabled: true,
      type: 'static-render-snapshot',
      chain: ['agent'],
      workflowId: NON_SETUP_WORKFLOW_ID,
    });

    const quickHandler = makeQuickHandler({ enabled: true });
    const { socket, writes } = makeSocketDouble();
    await quickHandler.handleMessage(
      {
        type: 'mcp-request-verification',
        requestId: 'rvq-3',
        runId: 'run-flow-regression',
        intent: 'the toggle renders',
        url: 'http://localhost:5173',
      },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(true);
    const data = response.data as { requestId: string; skipped?: boolean };
    expect(data.skipped).toBeUndefined();

    const row = vdb
      .prepare('SELECT chain_json FROM verification_requests WHERE id = ?')
      .get(data.requestId) as { chain_json: string };
    expect(row.chain_json).toBe('[]');
  });

  it('QUICK run with getVisualVerifyConfig ABSENT from deps falls back to the frozen stamp (pre-existing fixtures keep their old behavior)', async () => {
    seedVerifyRun(vdb, 'run-quick-nodep', {
      enabled: true,
      type: 'static-render-snapshot',
      chain: ['capturePage'],
      workflowId: QUICK_WORKFLOW_ID,
    });

    // vHandler (beforeEach) was built WITHOUT getVisualVerifyConfig — the
    // `this.deps.getVisualVerifyConfig !== undefined` guard must skip the quick
    // branch entirely and fall through to the frozen-stamp read above it.
    const { socket, writes } = makeSocketDouble();
    await vHandler.handleMessage(
      {
        type: 'mcp-request-verification',
        requestId: 'rvq-4',
        runId: 'run-quick-nodep',
        intent: 'legacy quick behavior',
        url: 'http://localhost:5173',
      },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(true);
    const data = response.data as { requestId: string; skipped?: boolean };
    expect(data.skipped).toBeUndefined();

    const row = vdb
      .prepare('SELECT chain_json FROM verification_requests WHERE id = ?')
      .get(data.requestId) as { chain_json: string };
    // Intersected off the frozen stamp exactly as a pre-b5f25edb quick run
    // would be — NOT the verbatim ['agent'] engine selector.
    expect(JSON.parse(row.chain_json)).toEqual(['capturePage']);
  });

  it('the enqueue ack carries snapshotSha and dirtyWorktree, and dirtyWorktree is true for a quick-session worktree with uncommitted changes', async () => {
    // A dedicated throwaway repo (not the shared `gitRepo` fixture, which other
    // tests in this block read `gitRepoHead` against and must stay clean) so
    // this test can dirty it without disturbing any other test's assumptions.
    const dirtyRepo = mkdtempSync(join(os.tmpdir(), 'cyboflow-mcp-verify-dirty-'));
    try {
      const git = (...args: string[]): string => execFileSync('git', args, { cwd: dirtyRepo, encoding: 'utf8' });
      git('init', '-q');
      git('config', 'user.email', 't@t.dev');
      git('config', 'user.name', 'T');
      writeFileSync(join(dirtyRepo, 'f.txt'), 'hi');
      git('add', '.');
      git('commit', '-q', '-m', 'init');
      const head = git('rev-parse', 'HEAD').trim();
      // Uncommitted change AFTER the commit — the exact case `isWorktreeDirty`
      // exists to catch: a snapshot at `head` will not contain this edit.
      writeFileSync(join(dirtyRepo, 'f.txt'), 'changed, uncommitted');

      seedVerifyRun(vdb, 'run-quick-dirty', {
        enabled: false,
        workflowId: QUICK_WORKFLOW_ID,
        worktreePath: dirtyRepo,
      });

      const quickHandler = makeQuickHandler({ enabled: true });
      const { socket, writes } = makeSocketDouble();
      await quickHandler.handleMessage(
        {
          type: 'mcp-request-verification',
          requestId: 'rvq-5',
          runId: 'run-quick-dirty',
          intent: 'checking before I commit',
          url: 'http://localhost:5173',
        },
        socket,
      );

      const response = parseLastWrite(writes);
      expect(response.ok).toBe(true);
      const data = response.data as {
        requestId: string;
        type: string;
        snapshotSha: string | null;
        dirtyWorktree: boolean;
      };
      expect(data.snapshotSha).toBe(head);
      expect(data.dirtyWorktree).toBe(true);
    } finally {
      rmSync(dirtyRepo, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // mcp-get-verifications (cyboflow_get_verifications — b5f25edb). The
  // NON-BLOCKING cold read behind VerificationScheduler.listRequestsForRun:
  // run-scoped in SQL (never a post-filter), newest-first, with PER-REQUEST
  // (not run-unioned) screenshot filenames.
  // -------------------------------------------------------------------------

  /**
   * Seed a bare verification_requests row for the listing tests — these care
   * about status/enqueued_at/report_json shape, not about driving a real
   * enqueue through the scheduler. `enqueuedAt` is always explicit (never the
   * column DEFAULT) so "newest-first" is asserted against a controlled
   * ordering rather than same-second CURRENT_TIMESTAMP ties.
   */
  function seedListedRequest(
    id: string,
    runId: string,
    opts: { status?: string; verifyType?: string; enqueuedAt: string; reportJson?: string | null },
  ): void {
    vdb
      .prepare(
        `INSERT INTO verification_requests
           (id, run_id, project_id, status, verify_type, deliverable_json, chain_json, enqueued_at, report_json)
         VALUES (?, ?, 1, ?, ?, '{"intent":"x"}', '[]', ?, ?)`,
      )
      .run(
        id,
        runId,
        opts.status ?? 'passed',
        opts.verifyType ?? 'static-render-snapshot',
        opts.enqueuedAt,
        opts.reportJson ?? null,
      );
  }

  it("mcp-get-verifications is run-scoped: only THIS run's rows come back newest-first, and a request_id from ANOTHER run yields an EMPTY list (not that run's row, not an error)", async () => {
    seedVerifyRun(vdb, 'run-list-a', { enabled: false });
    seedVerifyRun(vdb, 'run-list-b', { enabled: false });

    seedListedRequest('vr_a_older', 'run-list-a', { enqueuedAt: '2026-01-01T00:00:00.000Z' });
    seedListedRequest('vr_a_newer', 'run-list-a', { enqueuedAt: '2026-01-02T00:00:00.000Z' });
    seedListedRequest('vr_b_only', 'run-list-b', { enqueuedAt: '2026-01-03T00:00:00.000Z' });

    const { socket, writes } = makeSocketDouble();
    await vHandler.handleMessage({ type: 'mcp-get-verifications', requestId: 'gv-1', runId: 'run-list-a' }, socket);

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(true);
    const { verifications } = response.data as { verifications: VerificationRequestSummary[] };
    expect(verifications.map((v) => v.id)).toEqual(['vr_a_newer', 'vr_a_older']);

    // vr_b_only genuinely exists — just not on run-list-a. Run-scoping is
    // enforced in the SQL WHERE, so this cannot leak run-b's row.
    const { socket: socket2, writes: writes2 } = makeSocketDouble();
    await vHandler.handleMessage(
      {
        type: 'mcp-get-verifications',
        requestId: 'gv-2',
        runId: 'run-list-a',
        verificationRequestId: 'vr_b_only',
      },
      socket2,
    );
    const response2 = parseLastWrite(writes2);
    expect(response2.ok).toBe(true);
    expect((response2.data as { verifications: unknown[] }).verifications).toEqual([]);
  });

  it('mcp-get-verifications reports PER-REQUEST screenshots with no bleed across rows on the same run, and a NULL report_json → screenshotFiles null (distinct from [])', async () => {
    seedVerifyRun(vdb, 'run-list-shots', { enabled: false });

    seedListedRequest('vr_shots_1', 'run-list-shots', {
      enqueuedAt: '2026-01-01T00:00:00.000Z',
      reportJson: JSON.stringify({ screenshots: [{ fileName: 'turn1-a.png' }] }),
    });
    seedListedRequest('vr_shots_2', 'run-list-shots', {
      enqueuedAt: '2026-01-02T00:00:00.000Z',
      reportJson: JSON.stringify({ screenshots: [{ fileName: 'turn2-a.png' }, { fileName: 'turn2-b.png' }] }),
    });
    // No report_json at all — the legacy capture path / a request that never
    // reached a terminal. Must read back as null, not [].
    seedListedRequest('vr_shots_none', 'run-list-shots', {
      enqueuedAt: '2026-01-03T00:00:00.000Z',
      reportJson: null,
    });

    const { socket, writes } = makeSocketDouble();
    await vHandler.handleMessage(
      { type: 'mcp-get-verifications', requestId: 'gv-3', runId: 'run-list-shots' },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(true);
    const { verifications } = response.data as { verifications: VerificationRequestSummary[] };
    const byId = new Map(verifications.map((v) => [v.id, v]));

    // If this test were sourcing from the run's unioned `screenshots` artifact
    // instead of this request's own report_json, EVERY row here would carry
    // all four filenames — exactly the bleed the design (verificationScheduler
    // §VerificationRequestSummary doc) calls out as the bug to avoid.
    expect(byId.get('vr_shots_1')?.screenshotFiles).toEqual(['turn1-a.png']);
    expect(byId.get('vr_shots_2')?.screenshotFiles).toEqual(['turn2-a.png', 'turn2-b.png']);
    expect(byId.get('vr_shots_none')?.screenshotFiles).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// mcp-register-verify-runbook (cyboflow_register_verify_runbook — §5.2 seam 1)
//
// The tool takes NO runbook content: the store reads
// `.cyboflow/verify-runbook.json` out of the run's own worktree, which is what
// makes the returned hash address the file the flow actually committed. These
// tests therefore use a REAL temp worktree with a real file, and inject only the
// two cheap probes (input hash / host fingerprint) the store needs for its drift
// baseline.
// ---------------------------------------------------------------------------

describe('McpQueryHandler — mcp-register-verify-runbook', () => {
  const VALID_RUNBOOK = {
    version: 1,
    modalities: {
      web: {
        build: ['pnpm run build'],
        serve: { cmd: 'pnpm run preview -- --port ${PORT}' },
        attestation: { kind: 'http-endpoint', urlPath: '/__cyboflow_verify__' },
      },
    },
  };

  let rdb: Database.Database;
  let worktree: string;
  let store: VerifyRunbookStore;

  /** Write the portable half into the run's worktree (the only input this tool reads). */
  function writeRunbook(contents: string): void {
    mkdirSync(join(worktree, '.cyboflow'), { recursive: true });
    writeFileSync(join(worktree, VERIFY_RUNBOOK_RELATIVE_PATH), contents, 'utf8');
  }

  function makeHandler(withStore = true): McpQueryHandler {
    return new McpQueryHandler(dbAdapter(rdb), undefined, withStore ? { verifyRunbookStore: store } : {});
  }

  beforeEach(() => {
    rdb = createTestDb({ disableForeignKeys: true, includeWorkflowRunTaskColumns: true });
    rdb.exec(`
      CREATE TABLE verify_runbook_local (
        project_id INTEGER NOT NULL,
        modality TEXT NOT NULL,
        portable_hash TEXT NOT NULL,
        portable_json TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL CHECK (status IN ('proven','unproven-draft')),
        bindings_json TEXT,
        proof_json TEXT,
        input_hash TEXT,
        host_fingerprint_json TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (project_id, modality)
      );
    `);
    worktree = mkdtempSync(join(os.tmpdir(), 'cyboflow-runbook-'));
    rdb.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, worktree_path, status, policy_json)
       VALUES ('run-rb', 'wf-1', 1, ?, 'running', '{}')`,
    ).run(worktree);
    store = new VerifyRunbookStore(dbAdapter(rdb), {
      readPortableFile: async (dirPath: string) => {
        try {
          return readFileSync(join(dirPath, VERIFY_RUNBOOK_RELATIVE_PATH), 'utf8');
        } catch {
          return null;
        }
      },
      computeInputHash: async () => 'input-hash-1',
      hostFingerprint: async () => 'host-fp-1',
    });
  });

  afterEach(() => {
    rmSync(worktree, { recursive: true, force: true });
    rdb.close();
  });

  it('a valid committed runbook registers an unproven draft and replies { hash, version }', async () => {
    writeRunbook(JSON.stringify(VALID_RUNBOOK));

    const { socket, writes } = makeSocketDouble();
    await makeHandler().handleMessage(
      {
        type: 'mcp-register-verify-runbook',
        requestId: 'rb-1',
        runId: 'run-rb',
        modality: 'web',
        bindingsJson: JSON.stringify({ dataDirLever: 'CYBOFLOW_DIR' }),
      },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(true);
    const data = response.data as { hash: string; version: number };
    expect(typeof data.hash).toBe('string');
    expect(data.hash.length).toBeGreaterThan(0);
    expect(data.version).toBe(1);

    const row = rdb
      .prepare(
        'SELECT status, portable_hash, bindings_json, input_hash, host_fingerprint_json FROM verify_runbook_local WHERE project_id = 1 AND modality = ?',
      )
      .get('web') as {
      status: string;
      portable_hash: string;
      bindings_json: string | null;
      input_hash: string | null;
      host_fingerprint_json: string | null;
    };
    // Registering NEVER proves: new content is unproven content, and only a
    // passing setup-proof run may promote it (engine-enforced, §5.3).
    expect(row.status).toBe('unproven-draft');
    expect(row.portable_hash).toBe(data.hash);
    expect(JSON.parse(row.bindings_json as string)).toEqual({ dataDirLever: 'CYBOFLOW_DIR' });
    expect(row.input_hash).toBe('input-hash-1');
    expect(row.host_fingerprint_json).toBe('host-fp-1');
  });

  // COMMITTED-AT-HEAD backstop (live dogfood 2026-07-31). registerDraft reads the
  // WORKING TREE, but the proof builds a detached snapshot at a commit — and many
  // repos ignore or locally-exclude `.cyboflow/`, which makes `git add` on the
  // runbook a silent no-op. Without this, the flow registers happily and the
  // proof fails ten minutes later against a snapshot with no runbook in it.
  it('warns with committed:false when the runbook never reached HEAD', async () => {
    writeRunbook(JSON.stringify(VALID_RUNBOOK)); // worktree is not a git repo at all

    const { socket, writes } = makeSocketDouble();
    await makeHandler().handleMessage(
      { type: 'mcp-register-verify-runbook', requestId: 'rb-1c', runId: 'run-rb', modality: 'web' },
      socket,
    );

    const response = parseLastWrite(writes);
    // Advisory only — the registration itself is valid and stands.
    expect(response.ok).toBe(true);
    const data = response.data as { hash: string; version: number; committed: boolean; warning?: string };
    expect(data.version).toBe(1);
    expect(data.committed).toBe(false);
    expect(data.warning).toContain('git add -f');
  });

  it('reports committed:true with no warning once the runbook is present at HEAD', async () => {
    writeRunbook(JSON.stringify(VALID_RUNBOOK));
    // A real repo whose exclude carries `.cyboflow/` — the observed condition —
    // with the runbook force-added past it, which is the documented fix.
    execFileSync('git', ['init', '-q'], { cwd: worktree });
    execFileSync('git', ['config', 'user.email', 'test@cyboflow.dev'], { cwd: worktree });
    execFileSync('git', ['config', 'user.name', 'Cyboflow Test'], { cwd: worktree });
    writeFileSync(join(worktree, '.git', 'info', 'exclude'), '.cyboflow/\n', 'utf8');
    execFileSync('git', ['add', '-f', VERIFY_RUNBOOK_RELATIVE_PATH], { cwd: worktree });
    execFileSync('git', ['commit', '-q', '-m', 'add runbook'], { cwd: worktree });

    const { socket, writes } = makeSocketDouble();
    await makeHandler().handleMessage(
      { type: 'mcp-register-verify-runbook', requestId: 'rb-1d', runId: 'run-rb', modality: 'web' },
      socket,
    );

    const data = parseLastWrite(writes).data as { committed: boolean; warning?: string };
    expect(data.committed).toBe(true);
    expect(data.warning).toBeUndefined();
  });

  it('re-registering edited content bumps the CAS version and changes the hash', async () => {
    writeRunbook(JSON.stringify(VALID_RUNBOOK));
    const first = makeSocketDouble();
    await makeHandler().handleMessage(
      { type: 'mcp-register-verify-runbook', requestId: 'rb-2a', runId: 'run-rb', modality: 'web' },
      first.socket,
    );
    const firstData = parseLastWrite(first.writes).data as { hash: string; version: number };

    writeRunbook(
      JSON.stringify({
        ...VALID_RUNBOOK,
        modalities: {
          web: { ...VALID_RUNBOOK.modalities.web, build: ['pnpm run build:web'] },
        },
      }),
    );
    const second = makeSocketDouble();
    await makeHandler().handleMessage(
      { type: 'mcp-register-verify-runbook', requestId: 'rb-2b', runId: 'run-rb', modality: 'web' },
      second.socket,
    );
    const secondData = parseLastWrite(second.writes).data as { hash: string; version: number };

    expect(secondData.version).toBe(firstData.version + 1);
    expect(secondData.hash).not.toBe(firstData.hash);
  });

  it('an unparseable runbook file surfaces the store error VERBATIM (so the flow can fix the file)', async () => {
    writeRunbook('{ this is not json');

    const { socket, writes } = makeSocketDouble();
    await makeHandler().handleMessage(
      { type: 'mcp-register-verify-runbook', requestId: 'rb-3', runId: 'run-rb', modality: 'web' },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/^portable runbook is not valid JSON:/);
    const count = rdb.prepare('SELECT COUNT(*) AS n FROM verify_runbook_local').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('a runbook that declares a DIFFERENT modality is rejected by name', async () => {
    writeRunbook(JSON.stringify(VALID_RUNBOOK));

    const { socket, writes } = makeSocketDouble();
    await makeHandler().handleMessage(
      { type: 'mcp-register-verify-runbook', requestId: 'rb-4', runId: 'run-rb', modality: 'cdp-app' },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(false);
    expect(response.error).toContain('declares no "cdp-app" modality');
  });

  it('a missing runbook file names the path it looked in', async () => {
    const { socket, writes } = makeSocketDouble();
    await makeHandler().handleMessage(
      { type: 'mcp-register-verify-runbook', requestId: 'rb-5', runId: 'run-rb', modality: 'web' },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(false);
    expect(response.error).toContain(worktree);
  });

  it('a malformed modality is rejected before any file is read', async () => {
    writeRunbook(JSON.stringify(VALID_RUNBOOK));

    const { socket, writes } = makeSocketDouble();
    await makeHandler().handleMessage(
      // 'mobile' is deferred (§4) — deliberately NOT registrable.
      { type: 'mcp-register-verify-runbook', requestId: 'rb-6', runId: 'run-rb', modality: 'mobile' },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/^invalid_modality:/);
    const count = rdb.prepare('SELECT COUNT(*) AS n FROM verify_runbook_local').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('bindings_json that is not JSON is rejected at the door', async () => {
    writeRunbook(JSON.stringify(VALID_RUNBOOK));

    const { socket, writes } = makeSocketDouble();
    await makeHandler().handleMessage(
      {
        type: 'mcp-register-verify-runbook',
        requestId: 'rb-7',
        runId: 'run-rb',
        modality: 'web',
        bindingsJson: 'electronBinary=/usr/bin/x',
      },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/^invalid_bindings_json:/);
    const count = rdb.prepare('SELECT COUNT(*) AS n FROM verify_runbook_local').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('no store wired → runbook_store_unavailable (documented no-op fallback)', async () => {
    writeRunbook(JSON.stringify(VALID_RUNBOOK));

    const { socket, writes } = makeSocketDouble();
    await makeHandler(false).handleMessage(
      { type: 'mcp-register-verify-runbook', requestId: 'rb-8', runId: 'run-rb', modality: 'web' },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(false);
    expect(response.error).toBe('runbook_store_unavailable');
  });

  it('a run with no worktree cannot register (there is no tree to read the file from)', async () => {
    rdb.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, worktree_path, status, policy_json)
       VALUES ('run-rb-nowt', 'wf-1', 1, NULL, 'running', '{}')`,
    ).run();

    const { socket, writes } = makeSocketDouble();
    await makeHandler().handleMessage(
      { type: 'mcp-register-verify-runbook', requestId: 'rb-9', runId: 'run-rb-nowt', modality: 'web' },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(false);
    expect(response.error).toBe('run_worktree_unavailable');
  });
});

// ---------------------------------------------------------------------------
// interactive-turn-end (INTERACTIVE substrate Stop hook, IDEA-030). Fire-and-
// ack: unlike shell-approval-request, this ALWAYS writeResponses synchronously
// — there is no verdict to defer, only "was a live run notified or not".
// mcpQueryHandler cannot import main/src/services (ORCHESTRATOR LAYERING
// RULE), so the actual InteractiveClaudeManager.notifyTurnEnd call is exercised
// in interactiveClaudeManager.test.ts; here we only exercise the dispatch +
// the injected onInteractiveTurnEnd dep contract.
// ---------------------------------------------------------------------------

describe('interactive-turn-end', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb({ disableForeignKeys: true });
  });

  afterEach(() => {
    db.close();
  });

  it('ok:true and forwards runId when the injected dep reports a match', async () => {
    const onInteractiveTurnEnd = vi.fn(() => true);
    const handler = new McpQueryHandler(dbAdapter(db), undefined, { onInteractiveTurnEnd });
    const { socket, writes } = makeSocketDouble();

    await handler.handleMessage(
      { type: 'interactive-turn-end', requestId: 'tte-1', runId: 'run-1' },
      socket,
    );

    expect(onInteractiveTurnEnd).toHaveBeenCalledWith('run-1');
    const response = parseLastWrite(writes);
    expect(response.type).toBe('mcp-query-response');
    expect(response.requestId).toBe('tte-1');
    expect(response.ok).toBe(true);
    expect(response.error).toBeUndefined();
  });

  it('ok:false error="turn_end_unavailable" when the dep reports no matching run', async () => {
    const onInteractiveTurnEnd = vi.fn(() => false);
    const handler = new McpQueryHandler(dbAdapter(db), undefined, { onInteractiveTurnEnd });
    const { socket, writes } = makeSocketDouble();

    await handler.handleMessage(
      { type: 'interactive-turn-end', requestId: 'tte-2', runId: 'run-does-not-exist' },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(false);
    expect(response.error).toBe('turn_end_unavailable');
  });

  it('ok:false error="turn_end_unavailable" when no dep is wired at all (host never wired it)', async () => {
    const handler = new McpQueryHandler(dbAdapter(db));
    const { socket, writes } = makeSocketDouble();

    await handler.handleMessage(
      { type: 'interactive-turn-end', requestId: 'tte-3', runId: 'run-1' },
      socket,
    );

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(false);
    expect(response.error).toBe('turn_end_unavailable');
  });

  it('never throws and always replies exactly once, synchronously', async () => {
    const handler = new McpQueryHandler(dbAdapter(db));
    const { socket, writes } = makeSocketDouble();

    await expect(
      handler.handleMessage({ type: 'interactive-turn-end', requestId: 'tte-4', runId: 'run-1' }, socket),
    ).resolves.toBeUndefined();
    expect(writes).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// mcp-run-eval — the ad-hoc code-review eval tool (cyboflow_run_eval).
//
// The handler is a thin, DB-free mapper over the injected runAdHocEval callback
// (the ORCHESTRATOR LAYERING RULE keeps EvalWorker's service-touching wiring out
// of this layer), so these tests pin exactly that: the sentinel guard, the
// absent-dep degrade, and the outcome→wire mapping for every branch.
// ---------------------------------------------------------------------------

describe('mcp-run-eval', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb({ disableForeignKeys: true });
  });

  afterEach(() => {
    db.close();
  });

  const msg = (requestId: string, runId: string): McpQueryMessage => ({
    type: 'mcp-run-eval',
    requestId,
    runId,
  });

  it("rejects the 'orchestrator' sentinel runId without calling the dep", async () => {
    const runAdHocEval = vi.fn(async () => ({ outcome: 'queued' as const, rubricVersion: '9.9' }));
    const handler = new McpQueryHandler(dbAdapter(db), undefined, { runAdHocEval });
    const { socket, writes } = makeSocketDouble();

    await handler.handleMessage(msg('ev-1', 'orchestrator'), socket);

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/^eval_requires_real_run/);
    expect(runAdHocEval).not.toHaveBeenCalled();
  });

  it("returns 'eval_unavailable' when the dep is absent (documented degrade)", async () => {
    const handler = new McpQueryHandler(dbAdapter(db)); // no deps
    const { socket, writes } = makeSocketDouble();

    await handler.handleMessage(msg('ev-2', 'run-1'), socket);

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/^eval_unavailable/);
  });

  it.each(['queued', 'requeued', 'in_flight'] as const)(
    "maps the '%s' outcome to ok:true { status, rubricVersion }",
    async (outcome) => {
      const runAdHocEval = vi.fn(async () => ({ outcome, rubricVersion: '9.9' }));
      const handler = new McpQueryHandler(dbAdapter(db), undefined, { runAdHocEval });
      const { socket, writes } = makeSocketDouble();

      await handler.handleMessage(msg('ev-3', 'run-1'), socket);

      const response = parseLastWrite(writes);
      expect(response.ok).toBe(true);
      expect(response.data).toEqual({ status: outcome, rubricVersion: '9.9' });
      expect(runAdHocEval).toHaveBeenCalledWith('run-1');
    },
  );

  it.each([
    ['run_not_found', /^run_not_found/],
    ['tagged_run', /^adhoc_eval_tagged_run_rejected/],
    ['exists_auto', /^adhoc_eval_exists_auto/],
    ['no_diff', /^adhoc_eval_no_diff/],
  ] as const)("maps the '%s' rejection to its own wire code", async (reason, pattern) => {
    const runAdHocEval = vi.fn(async () => ({ outcome: 'rejected' as const, reason }));
    const handler = new McpQueryHandler(dbAdapter(db), undefined, { runAdHocEval });
    const { socket, writes } = makeSocketDouble();

    await handler.handleMessage(msg('ev-4', 'run-1'), socket);

    const response = parseLastWrite(writes);
    expect(response.ok).toBe(false);
    expect(response.error).toMatch(pattern);
    // Every rejection carries a human-readable explanation after the code.
    expect((response.error ?? '').length).toBeGreaterThan(reason.length + 10);
  });

  it('surfaces a thrown dep as ok:false rather than escaping handleMessage', async () => {
    const runAdHocEval = vi.fn(async () => {
      throw new Error('worker not initialized');
    });
    const handler = new McpQueryHandler(dbAdapter(db), undefined, { runAdHocEval });
    const { socket, writes } = makeSocketDouble();

    await expect(handler.handleMessage(msg('ev-5', 'run-1'), socket)).resolves.toBeUndefined();
    const response = parseLastWrite(writes);
    expect(response.ok).toBe(false);
    expect(response.error).toBe('eval_request_failed');
    expect(writes).toHaveLength(1);
  });
});

describe('bootstrap_proof is not a wire field (migration 107 tripwire)', () => {
  /**
   * THE INVARIANT. `setup_proof` is agent-settable and defends itself with a
   * workflow-identity check. `bootstrap_proof` (docs/proposals/lane-runbook-bootstrap.md
   * §5) defends itself more simply and more strongly: the MCP handler does not
   * read it AT ALL, so there is no request an agent can compose — in any flow,
   * with any argument — that sets it. Only the in-process controller seam
   * (enqueueTaskVerification) can.
   *
   * This is a SOURCE tripwire rather than a behavioral one on purpose: the
   * property being protected is the ABSENCE of a code path, and the way that
   * property dies is someone helpfully threading the flag through the wire
   * schema "for symmetry with setup_proof". A behavioral test would pass right
   * up until that happens and then start testing the new path instead.
   */
  it('the MCP query handler never references the bootstrap-proof flag', () => {
    const source = readFileSync(join(__dirname, '..', 'mcpQueryHandler.ts'), 'utf-8');
    // Comments are allowed to NAME it (explaining why it is absent is useful);
    // strip line comments and block comments before scanning for real references.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/bootstrap_proof/);
    expect(code).not.toMatch(/bootstrapProof/);
  });

  it('the MCP server tool schema never exposes a bootstrap-proof input', () => {
    const source = readFileSync(join(__dirname, '..', 'cyboflowMcpServer.ts'), 'utf-8');
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/bootstrap_proof/);
    expect(code).not.toMatch(/bootstrapProof/);
  });
});
