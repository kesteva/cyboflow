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
 * imported GATE_SCHEMA fixture (no real migration runner — tests are hermetic). A writes-capturing
 * socket test double is used to assert on the JSON response bodies.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { McpQueryHandler, type McpQueryMessage, type McpQueryResponse } from '../mcpQueryHandler';
import type * as net from 'net';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';

// ---------------------------------------------------------------------------
// Minimal schema for this test suite
// ---------------------------------------------------------------------------
// Mirrors the relevant subset of REGISTRY_SCHEMA + GATE_SCHEMA with FK
// constraints present so that foreign_keys = ON enforces referential integrity
// exactly as production does. workflow_runs has no FOREIGN KEY on workflow_id
// here (workflows table omitted) — seedRun inserts directly without a parent
// workflows row, which is fine for unit tests.
// ---------------------------------------------------------------------------

const MINIMAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  project_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  permission_mode_snapshot TEXT NOT NULL DEFAULT 'default',
  worktree_path TEXT,
  branch_name TEXT,
  policy_json TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_input_json TEXT NOT NULL,
  tool_use_id TEXT NOT NULL,
  rationale TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  decided_at DATETIME,
  decided_by TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS raw_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
);
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(MINIMAL_SCHEMA);
  return db;
}

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

function seedApproval(
  db: Database.Database,
  id: string,
  runId: string,
  status: string,
  createdAt: string,
): void {
  db.prepare(
    `INSERT INTO approvals (id, run_id, tool_name, tool_input_json, tool_use_id, status, created_at)
     VALUES (?, ?, 'bash', '{"cmd":"ls"}', ?, ?, ?)`,
  ).run(id, runId, id, status, createdAt);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('McpQueryHandler', () => {
  let db: Database.Database;
  let handler: McpQueryHandler;

  beforeEach(() => {
    db = createTestDb();
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
      seedApproval(db, 'appr-2', 'run-a', 'pending', '2026-01-02T00:00:00Z');
      seedApproval(db, 'appr-1', 'run-a', 'pending', '2026-01-01T00:00:00Z');
      seedApproval(db, 'appr-3', 'run-a', 'approved', '2026-01-03T00:00:00Z');

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
      seedApproval(db, 'appr-x', 'run-b', 'pending', '2026-01-01T00:00:00Z');

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
