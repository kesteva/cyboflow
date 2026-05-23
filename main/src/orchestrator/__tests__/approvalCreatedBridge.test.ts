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
import { createTestDb, seedRun, seedApproval } from '../__test_fixtures__/orchestratorTestDb';
import { selectPendingApprovals } from '../approvalListing';
import type { ApprovalRequest } from '../../../../shared/types/approval';

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
    const approvalId = seedApproval(db, { id: `approval-${runId}`, runId, toolName: 'Bash', toolInputJson: toolInput });

    const request: ApprovalRequest = {
      id: approvalId,
      runId,
      toolName: 'Bash',
      input: { cmd: 'make test' },
      timestamp: Date.now(),
    };

    // Bridge produces the SSE event
    const bridgeEvent = buildApprovalCreatedEvent(request, adapter);

    // selectPendingApprovals produces the REST query result (same function as tRPC listPending)
    const pending = selectPendingApprovals(adapter);
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
