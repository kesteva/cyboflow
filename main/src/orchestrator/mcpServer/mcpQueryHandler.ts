/**
 * McpQueryHandler — orchestrator-side handler for MCP query messages arriving
 * over the Cyboflow Unix IPC socket.
 *
 * Handles three message types dispatched by the cyboflowMcpServer subprocess:
 *   - mcp-list-pending-approvals  (SELECT from approvals)
 *   - mcp-get-run                 (SELECT from workflow_runs)
 *   - mcp-submit-checkpoint       (INSERT into raw_events with event_type='cyboflow_checkpoint')
 *
 * Unknown message types produce a structured error response — they never throw,
 * so a malformed subprocess message cannot crash the orchestrator socket.
 *
 * IMPORTANT: This handler is purely additive. The existing permission-request /
 * permission-response flow (owned by ApprovalRouter) is untouched. Checkpoint
 * writes do NOT transition workflow_runs.status; they are observational markers
 * only.
 *
 * Column names are verified against migration 006_cyboflow_schema.sql:
 *   approvals  — id, run_id, tool_name, tool_input_json, tool_use_id,
 *                status, created_at
 *   workflow_runs — all columns selected via *
 *   raw_events — id (AUTOINCREMENT), run_id, event_type, payload_json, created_at
 *
 * Quick-session invariant (IDEA-024 / TASK-743):
 *   This handler reads from `approvals` and `workflow_runs` only — it does NOT
 *   JOIN or SELECT from `sessions`.  Therefore it is already NULL-tolerant with
 *   respect to the TASK-743 nullable sessions.run_id column: quick sessions
 *   (sessions with run_id IS NULL) have no corresponding workflow_runs row, so
 *   any mcp-get-run request for a quick-session id will take the existing
 *   'not_found' branch and return ok:false — the intended behaviour.  No logic
 *   changes are required here for quick-session support.
 */
import * as net from 'net';
import type { DatabaseLike } from '../types';
import { resolveWorkflowDefinition } from '../../../../shared/types/workflows';
import { buildStepTransitionEvent } from '../stepTransitionBridge';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type McpQueryMessage =
  | { type: 'mcp-list-pending-approvals'; requestId: string; runId: string }
  | { type: 'mcp-get-run'; requestId: string; runId: string; targetRunId: string }
  | { type: 'mcp-submit-checkpoint'; requestId: string; runId: string; label: string; note?: string }
  | { type: 'mcp-report-step'; requestId: string; runId: string; stepId: string; status?: 'running' | 'done' };

export interface McpQueryResponse {
  type: 'mcp-query-response';
  requestId: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

// ---------------------------------------------------------------------------
// Internal row shapes (enough for safe narrowing — not a full ORM mapping)
// ---------------------------------------------------------------------------

interface ApprovalRow {
  id: string;
  run_id: string;
  tool_name: string;
  tool_input_json: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// McpQueryHandler
// ---------------------------------------------------------------------------

export class McpQueryHandler {
  constructor(private readonly db: DatabaseLike) {}

  // --------------------------------------------------------------------------
  // Public entry point
  // --------------------------------------------------------------------------

  /**
   * Route a parsed McpQueryMessage to the correct handler and write a
   * JSON response back on `client`.
   *
   * Never throws — all exceptions are caught and surfaced as ok:false responses.
   */
  async handleMessage(msg: McpQueryMessage, client: net.Socket): Promise<void> {
    try {
      switch (msg.type) {
        case 'mcp-list-pending-approvals':
          this.handleListPendingApprovals(msg, client);
          break;
        case 'mcp-get-run':
          this.handleGetRun(msg, client);
          break;
        case 'mcp-submit-checkpoint':
          this.handleSubmitCheckpoint(msg, client);
          break;
        case 'mcp-report-step':
          this.handleReportStep(msg, client);
          break;
        default: {
          // TypeScript exhaustiveness helper — cast so the switch compiles even
          // if future union members are added without updating this switch.
          const exhaustive = msg as { type: string; requestId: string };
          console.error(
            `[Cyboflow MCP Query] Unknown message type: ${exhaustive.type}`,
          );
          this.writeResponse(client, {
            type: 'mcp-query-response',
            requestId: exhaustive.requestId,
            ok: false,
            error: 'unknown_message_type',
          });
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[Cyboflow MCP Query] Unhandled error in handleMessage:`, err);
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error,
      });
    }
  }

  // --------------------------------------------------------------------------
  // Message handlers
  // --------------------------------------------------------------------------

  private handleListPendingApprovals(
    msg: Extract<McpQueryMessage, { type: 'mcp-list-pending-approvals' }>,
    client: net.Socket,
  ): void {
    const stmt = this.db.prepare(
      `SELECT id, run_id, tool_name, tool_input_json, created_at
         FROM approvals
        WHERE status = 'pending'
        ORDER BY created_at ASC`,
    );
    const rows = stmt.all() as ApprovalRow[];

    const approvals = rows.map((row) => ({
      approval_id: row.id,
      run_id: row.run_id,
      tool_name: row.tool_name,
      input: (() => {
        try {
          return JSON.parse(row.tool_input_json) as unknown;
        } catch {
          console.warn(
            `[Cyboflow MCP Query] tool_input_json parse failed for approval ${row.id} — returning raw string`,
          );
          return row.tool_input_json;
        }
      })(),
      created_at: row.created_at,
    }));

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { approvals },
    });
  }

  private handleGetRun(
    msg: Extract<McpQueryMessage, { type: 'mcp-get-run' }>,
    client: net.Socket,
  ): void {
    const stmt = this.db.prepare(
      `SELECT * FROM workflow_runs WHERE id = ?`,
    );
    const row = stmt.get(msg.targetRunId) as Record<string, unknown> | undefined;

    if (!row) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'not_found',
      });
      return;
    }

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { run: row },
    });
  }

  private handleSubmitCheckpoint(
    msg: Extract<McpQueryMessage, { type: 'mcp-submit-checkpoint' }>,
    client: net.Socket,
  ): void {
    if (msg.runId === 'orchestrator') {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'checkpoint_requires_real_run',
      });
      return;
    }

    const now = new Date().toISOString();
    const payload = JSON.stringify({
      label: msg.label,
      note: msg.note ?? null,
      submitted_via: 'mcp',
    });

    const stmt = this.db.prepare(
      `INSERT INTO raw_events (run_id, event_type, payload_json, created_at)
       VALUES (?, 'cyboflow_checkpoint', ?, ?)`,
    );
    const result = stmt.run(msg.runId, payload, now);

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { checkpoint_id: result.lastInsertRowid },
    });
  }

  /**
   * Record the run's current workflow step (OBSERVATIONAL — drives the Workflow
   * Progress panel; never changes workflow_runs.status).
   *
   * Validation flow (dynamic step-id model, post user-editable-workflows merge):
   *   - orchestrator-sentinel guard mirrors handleSubmitCheckpoint: the
   *     singleton MCP server runs with CYBOFLOW_RUN_ID='orchestrator', which has
   *     no workflow_runs row → reject before any DB touch.
   *   - JOIN workflows for the run's name AND spec_json, then resolve the
   *     EFFECTIVE definition via resolveWorkflowDefinition(name, specJson). This
   *     is the runtime source of truth that fully overrides the static
   *     WORKFLOW_DEFINITIONS seed — an edited/custom step id present only in
   *     spec_json is accepted, a step id absent from (or removed by an edit of)
   *     the resolved def is rejected with 'unknown_step_id' (no write).
   *   - We validate stepId here (returning structured 'unknown_step_id') rather
   *     than relying on buildStepTransitionEvent's null return, which collapses
   *     "bad step" and "row vanished" into a single null and cannot distinguish
   *     them for the response. The bridge call is reached only for already-
   *     validated steps; its `null` there means the row vanished mid-flight.
   *
   * Pass `undefined` for the bridge logger arg — this class holds no LoggerLike
   * and must not fabricate one (CLAUDE.md silent-no-op rule applies only to
   * loggers actually in scope; the bridge falls back to console.warn).
   */
  private handleReportStep(
    msg: Extract<McpQueryMessage, { type: 'mcp-report-step' }>,
    client: net.Socket,
  ): void {
    if (msg.runId === 'orchestrator') {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'report_step_requires_real_run',
      });
      return;
    }

    const row = this.db
      .prepare(
        `SELECT w.name AS name, w.spec_json AS specJson
           FROM workflow_runs r
           JOIN workflows w ON w.id = r.workflow_id
          WHERE r.id = ?`,
      )
      .get(msg.runId) as { name?: unknown; specJson?: unknown } | undefined;

    if (!row) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'run_not_found',
      });
      return;
    }

    const name = typeof row.name === 'string' ? row.name : '';
    const specJson = typeof row.specJson === 'string' ? row.specJson : null;

    // Validate stepId against the run's RESOLVED definition — NOT the static
    // WORKFLOW_DEFINITIONS constant (which is now only the seed/fallback).
    const def = resolveWorkflowDefinition(name, specJson);
    const validStepIds =
      def === null
        ? new Set<string>()
        : new Set(def.phases.flatMap((p) => p.steps).map((s) => s.id));

    if (!validStepIds.has(msg.stepId)) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'unknown_step_id',
      });
      return;
    }

    const status = msg.status ?? 'running';
    const event = buildStepTransitionEvent(msg.runId, msg.stepId, status, this.db, undefined);

    if (event === null) {
      // Row vanished between the JOIN above and the bridge UPDATE — the stepId
      // was already validated, so a null here is a missing-run race, not a typo.
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'run_not_found',
      });
      return;
    }

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { step_id: msg.stepId, status },
    });
  }

  // --------------------------------------------------------------------------
  // Helper
  // --------------------------------------------------------------------------

  private writeResponse(client: net.Socket, response: McpQueryResponse): void {
    client.write(JSON.stringify(response) + '\n');
  }
}
