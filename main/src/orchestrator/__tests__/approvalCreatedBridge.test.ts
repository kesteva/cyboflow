/**
 * Unit tests for buildApprovalCreatedEvent (approvalCreatedBridge).
 *
 * Four cases per the test_strategy in TASK-720:
 *
 * 1. Positive resolution: bridge returns workflowName='parity-workflow' when
 *    a matching workflow row exists in the DB.
 *
 * 2. Missing-row fallback: bridge returns workflowName='' and logs a
 *    console.warn, does NOT throw, when no workflow_runs row matches.
 *
 * 3. Round-trip parity: bridge.workflowName === listPending.workflowName
 *    for the same seeded approval — the SSE push and the list query agree.
 *
 * 4. Field completeness: id, runId, toolName, payloadPreview, status and
 *    createdAt are all populated correctly from the request.
 *
 * All tests use an in-memory better-sqlite3 instance so transaction semantics
 * are exercised end-to-end without spinning up Electron or the MCP bridge.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { buildApprovalCreatedEvent } from '../approvalCreatedBridge';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { createTestDb, seedRun } from '../__test_fixtures__/orchestratorTestDb';
import type { ApprovalRequest } from '../../../../shared/types/approval';
import type { Approval } from '../../../../shared/types/approvals';

// ---------------------------------------------------------------------------
// Test-database helpers
// ---------------------------------------------------------------------------

/**
 * Seed one workflow + one workflow_run via the shared fixture.
 * Returns { workflowId, runId }.
 */
function seedWorkflowAndRun(
  db: Database.Database,
  workflowName: string,
): { workflowId: string; runId: string } {
  return seedRun(db, {
    id: `run-${workflowName}`,
    workflowId: `workflow-${workflowName}`,
    workflowName,
  });
}

/**
 * Seed an approvals row for the given runId.
 * Returns the approval id.
 */
function seedApproval(
  db: Database.Database,
  runId: string,
  toolName: string,
  toolInputJson: string,
): string {
  const approvalId = `approval-${runId}`;
  db.prepare(
    `INSERT INTO approvals (id, run_id, tool_name, tool_input_json, tool_use_id)
     VALUES (?, ?, ?, ?, 'tool-use-id-test')`,
  ).run(approvalId, runId, toolName, toolInputJson);
  return approvalId;
}

/**
 * Replicate listPending logic from trpc/routers/approvals.ts for parity testing.
 * Returns the Approval[] rows visible to the UI.
 */
function listPending(db: Database.Database): Approval[] {
  interface DbRow {
    id: string;
    runId: string;
    workflowName: string;
    toolName: string;
    payloadPreviewRaw: string;
    rationale: string | null;
    createdAt: string;
    status: string;
  }

  const rows = db.prepare(
    `SELECT
       a.id          AS id,
       a.run_id      AS runId,
       w.name        AS workflowName,
       a.tool_name   AS toolName,
       a.tool_input_json AS payloadPreviewRaw,
       a.rationale   AS rationale,
       a.created_at  AS createdAt,
       a.status      AS status
     FROM approvals a
     JOIN workflow_runs r ON r.id = a.run_id
     JOIN workflows     w ON w.id = r.workflow_id
     WHERE a.status = 'pending'
     ORDER BY a.created_at ASC`,
  ).all() as DbRow[];

  return rows.map((row): Approval => ({
    id: row.id,
    runId: row.runId,
    workflowName: row.workflowName,
    toolName: row.toolName,
    payloadPreview:
      row.payloadPreviewRaw.length > 512
        ? row.payloadPreviewRaw.slice(0, 512)
        : row.payloadPreviewRaw,
    rationale: row.rationale,
    createdAt: new Date(row.createdAt).toISOString(),
    status: row.status as Approval['status'],
  }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildApprovalCreatedEvent', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Case 1: Positive resolution — bridge returns workflowName when row exists
  // -------------------------------------------------------------------------
  it('positive resolution: returns workflowName from DB when workflow row exists', () => {
    const db = createTestDb();
    const adapter = dbAdapter(db);
    const { runId } = seedWorkflowAndRun(db, 'parity-workflow');

    const request: ApprovalRequest = {
      id: 'approval-001',
      runId,
      toolName: 'Bash',
      input: { command: 'ls -la' },
      timestamp: Date.now(),
    };

    const event = buildApprovalCreatedEvent(request, adapter);

    expect(event.approval.workflowName).toBe('parity-workflow');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Case 2: Missing-row fallback — returns '' and warns, does NOT throw
  // -------------------------------------------------------------------------
  it('missing-row fallback: returns workflowName="" with console.warn, does not throw', () => {
    const db = createTestDb();
    const adapter = dbAdapter(db);
    // No workflow or run seeded — runId will not match any row.

    const request: ApprovalRequest = {
      id: 'approval-orphan',
      runId: 'run-nonexistent',
      toolName: 'Bash',
      input: { command: 'echo hello' },
      timestamp: Date.now(),
    };

    let event;
    expect(() => {
      event = buildApprovalCreatedEvent(request, adapter);
    }).not.toThrow();

    expect(event!.approval.workflowName).toBe('');
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toMatch(/No workflow row found for runId=run-nonexistent/);
  });

  // -------------------------------------------------------------------------
  // Case 3: Round-trip parity — bridge.workflowName === listPending.workflowName
  // -------------------------------------------------------------------------
  it('round-trip parity: bridge.workflowName === listPending.workflowName for same approval', () => {
    const db = createTestDb();
    const adapter = dbAdapter(db);
    const toolInput = JSON.stringify({ cmd: 'make test' });
    const { runId } = seedWorkflowAndRun(db, 'parity-workflow');
    const approvalId = seedApproval(db, runId, 'Bash', toolInput);

    const request: ApprovalRequest = {
      id: approvalId,
      runId,
      toolName: 'Bash',
      input: { cmd: 'make test' },
      timestamp: Date.now(),
    };

    // Bridge produces the SSE event
    const bridgeEvent = buildApprovalCreatedEvent(request, adapter);

    // listPending produces the REST query result
    const pending = listPending(db);
    expect(pending).toHaveLength(1);

    // Round-trip parity: the SSE push and the query must agree on workflowName
    expect(bridgeEvent.approval.workflowName).toBe(pending[0].workflowName);
    expect(bridgeEvent.approval.workflowName).toBe('parity-workflow');
  });

  // -------------------------------------------------------------------------
  // Case 4: Field completeness — all required Approval fields populated
  // -------------------------------------------------------------------------
  it('field completeness: id, runId, toolName, payloadPreview, status, createdAt populated', () => {
    const db = createTestDb();
    const adapter = dbAdapter(db);
    const { runId } = seedWorkflowAndRun(db, 'field-test-workflow');

    const timestamp = Date.now();
    const input = { file: 'src/index.ts', content: 'new content' };
    const request: ApprovalRequest = {
      id: 'approval-fields-test',
      runId,
      toolName: 'str_replace_editor',
      input,
      timestamp,
    };

    const event = buildApprovalCreatedEvent(request, adapter);
    const approval = event.approval;

    expect(approval.id).toBe('approval-fields-test');
    expect(approval.runId).toBe(runId);
    expect(approval.toolName).toBe('str_replace_editor');
    expect(approval.payloadPreview).toBe(JSON.stringify(input));
    expect(approval.status).toBe('pending');
    expect(approval.rationale).toBeNull();
    expect(approval.createdAt).toBe(new Date(timestamp).toISOString());
  });

  // -------------------------------------------------------------------------
  // Case 5: payloadPreview truncation at 512 chars
  // -------------------------------------------------------------------------
  it('truncates payloadPreview to 512 chars for large input', () => {
    const db = createTestDb();
    const adapter = dbAdapter(db);
    const { runId } = seedWorkflowAndRun(db, 'trunc-workflow');

    // Build an input whose JSON exceeds 512 chars
    const bigValue = 'x'.repeat(600);
    const request: ApprovalRequest = {
      id: 'approval-trunc',
      runId,
      toolName: 'Bash',
      input: { data: bigValue },
      timestamp: Date.now(),
    };

    const event = buildApprovalCreatedEvent(request, adapter);

    expect(event.approval.payloadPreview.length).toBe(512);
  });
});
