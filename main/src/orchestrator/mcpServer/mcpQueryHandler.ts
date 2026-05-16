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
 */
import * as net from 'net';
import type { DatabaseLike } from '../types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type McpQueryMessage =
  | { type: 'mcp-list-pending-approvals'; requestId: string; runId: string }
  | { type: 'mcp-get-run'; requestId: string; runId: string; targetRunId: string }
  | { type: 'mcp-submit-checkpoint'; requestId: string; runId: string; label: string; note?: string };

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
          await this.handleListPendingApprovals(msg, client);
          break;
        case 'mcp-get-run':
          await this.handleGetRun(msg, client);
          break;
        case 'mcp-submit-checkpoint':
          await this.handleSubmitCheckpoint(msg, client);
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

  private async handleListPendingApprovals(
    msg: Extract<McpQueryMessage, { type: 'mcp-list-pending-approvals' }>,
    client: net.Socket,
  ): Promise<void> {
    try {
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
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[Cyboflow MCP Query] mcp-list-pending-approvals error:`, err);
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error,
      });
    }
  }

  private async handleGetRun(
    msg: Extract<McpQueryMessage, { type: 'mcp-get-run' }>,
    client: net.Socket,
  ): Promise<void> {
    try {
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
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[Cyboflow MCP Query] mcp-get-run error:`, err);
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error,
      });
    }
  }

  private async handleSubmitCheckpoint(
    msg: Extract<McpQueryMessage, { type: 'mcp-submit-checkpoint' }>,
    client: net.Socket,
  ): Promise<void> {
    try {
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
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[Cyboflow MCP Query] mcp-submit-checkpoint error:`, err);
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error,
      });
    }
  }

  // --------------------------------------------------------------------------
  // Helper
  // --------------------------------------------------------------------------

  private writeResponse(client: net.Socket, response: McpQueryResponse): void {
    client.write(JSON.stringify(response));
  }
}
