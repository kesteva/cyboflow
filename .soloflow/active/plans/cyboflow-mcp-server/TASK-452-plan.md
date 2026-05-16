---
id: TASK-452
idea: IDEA-010
status: in-flight
created: "2026-05-11T00:00:00Z"
files_owned:
  - main/src/orchestrator/mcpServer/mcpQueryHandler.ts
files_readonly:
  - main/src/services/permissionIpcServer.ts
  - main/src/orchestrator/mcpServer/cyboflowMcpServer.ts
  - .soloflow/active/research/ROADMAP-001-research-architecture.md
  - .soloflow/active/research/ROADMAP-001-research-risks.md
acceptance_criteria:
  - criterion: "File main/src/orchestrator/mcpServer/mcpQueryHandler.ts exists and exports a class McpQueryHandler with a method handleMessage(msg: McpQueryMessage, client: net.Socket): Promise<void>."
    verification: "test -f main/src/orchestrator/mcpServer/mcpQueryHandler.ts && grep -E 'export class McpQueryHandler' main/src/orchestrator/mcpServer/mcpQueryHandler.ts && grep -E 'handleMessage' main/src/orchestrator/mcpServer/mcpQueryHandler.ts"
  - criterion: "Three message types are handled: 'mcp-list-pending-approvals', 'mcp-get-run', 'mcp-submit-checkpoint'. Each writes back a structured response of shape { type: 'mcp-query-response', requestId, ok: boolean, data?: unknown, error?: string }."
    verification: "grep -q 'mcp-list-pending-approvals' main/src/orchestrator/mcpServer/mcpQueryHandler.ts && grep -q 'mcp-get-run' main/src/orchestrator/mcpServer/mcpQueryHandler.ts && grep -q 'mcp-submit-checkpoint' main/src/orchestrator/mcpServer/mcpQueryHandler.ts && grep -q 'mcp-query-response' main/src/orchestrator/mcpServer/mcpQueryHandler.ts"
  - criterion: "Unknown message type returns { ok: false, error: 'unknown_message_type' } without throwing — the orchestrator socket must not crash on malformed subprocess input."
    verification: "grep -q 'unknown_message_type' main/src/orchestrator/mcpServer/mcpQueryHandler.ts"
  - criterion: "Read queries (list_pending_approvals, get_run) are implemented as no-side-effect SELECTs against the existing approvals and workflow_runs tables (created by the earlier cyboflow-schema-migration epic — this task assumes those tables exist)."
    verification: "grep -E 'SELECT.*FROM approvals' main/src/orchestrator/mcpServer/mcpQueryHandler.ts && grep -E 'SELECT.*FROM workflow_runs' main/src/orchestrator/mcpServer/mcpQueryHandler.ts"
  - criterion: "Checkpoint write inserts a row into a checkpoints table (or appends to raw_events with event_type='cyboflow_checkpoint') under a single SQL statement — no side-effect to workflow_runs.status, no socket replies to Claude (this is a marker, not an approval)."
    verification: "grep -E 'INSERT INTO (checkpoints|raw_events)' main/src/orchestrator/mcpServer/mcpQueryHandler.ts"
  - criterion: TypeScript compiles (pnpm typecheck passes).
    verification: "cd main && pnpm typecheck — exit 0"
depends_on:
  - TASK-451
estimated_complexity: medium
epic: cyboflow-mcp-server
test_strategy:
  needed: true
  justification: "This task introduces three query paths with a routing decision and SQL side effects. Each path needs a unit test against an in-memory better-sqlite3 instance to verify (a) correct routing, (b) correct response shape, (c) unknown-message-type fallback, (d) checkpoint write is observable in the DB. Without these tests, regressions in routing or response shape would only surface integration-time."
  targets:
    - behavior: "handleMessage routes 'mcp-list-pending-approvals' to the approvals SELECT path and returns ok:true with an array data field"
      test_file: main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts
      type: unit
    - behavior: "handleMessage routes 'mcp-get-run' to the workflow_runs SELECT path and returns ok:false with error='not_found' when no row matches"
      test_file: main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts
      type: unit
    - behavior: "handleMessage 'mcp-submit-checkpoint' inserts exactly one row observable by a follow-up SELECT"
      test_file: main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts
      type: unit
    - behavior: "handleMessage returns { ok: false, error: 'unknown_message_type' } for an unrecognized type and never throws"
      test_file: main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts
      type: unit
---
# TASK-452: Orchestrator-side MCP query handler

## Objective

Extend the orchestrator's Unix-socket protocol with three new message types (`mcp-list-pending-approvals`, `mcp-get-run`, `mcp-submit-checkpoint`) that the `cyboflowMcpServer.ts` subprocess calls into. This is the server side of the wire that TASK-451 set up the client side of. The handler routes each message type to a SQL query against the Cyboflow schema (approvals, workflow_runs, raw_events) and writes a structured JSON response back over the same socket. Critically, the existing permission-request flow (`permission-request` → `permission-response`) is untouched — this task adds new message types alongside, not in place of.

## Implementation Steps

1. Create new file `main/src/orchestrator/mcpServer/mcpQueryHandler.ts`.
2. Define and export TypeScript types:
   ```ts
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
   ```
3. Implement `export class McpQueryHandler` with constructor `constructor(private db: Database.Database)` (better-sqlite3 instance, injected so tests can pass in an in-memory DB).
4. Implement `async handleMessage(msg: McpQueryMessage, client: net.Socket): Promise<void>`. Use a switch on `msg.type`:
   - **`mcp-list-pending-approvals`**: SELECT `id, run_id, tool_name, input, created_at` FROM `approvals` WHERE `status = 'pending'` ORDER BY `created_at` ASC. Map rows to `{ approval_id, run_id, tool_name, input: JSON.parse(input), created_at }`. Respond `{ ok: true, data: { approvals: [...] } }`.
   - **`mcp-get-run`**: SELECT all columns FROM `workflow_runs` WHERE `id = ?` using `msg.targetRunId`. If no row, respond `{ ok: false, error: 'not_found' }`. Else respond `{ ok: true, data: { run: row } }`.
   - **`mcp-submit-checkpoint`**: INSERT into `raw_events` with `event_type = 'cyboflow_checkpoint'`, `run_id = msg.runId`, `payload = JSON.stringify({ label, note: note ?? null, submitted_via: 'mcp' })`, `created_at = current ISO timestamp`. Use a single prepared statement. Respond `{ ok: true, data: { checkpoint_id: <lastInsertRowid> } }`.
   - **default (unknown type)**: Respond `{ ok: false, error: 'unknown_message_type' }`. Do NOT throw — log to console.error and write the response.
5. Wrap each handler in try/catch. On any caught error, respond `{ ok: false, error: error.message }` and log to console.error with prefix `[Cyboflow MCP Query]`. Never let an exception escape `handleMessage`.
6. Helper `writeResponse(client: net.Socket, response: McpQueryResponse): void` that does `client.write(JSON.stringify(response))` — mirrors permissionIpcServer line-66 pattern.
7. CRITICAL: do not co-write to `workflow_runs.status`. Checkpoints are observational markers, not state transitions. Approval mutations must continue to go through the existing permission/approval flow (owned by the ApprovalRouter epic), not through this handler.
8. Create test file `main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts` (see Test Strategy section).
9. In the test setup, instantiate an in-memory better-sqlite3 database, manually CREATE the minimal `approvals`, `workflow_runs`, and `raw_events` table shapes the handler reads/writes (the production schema is created by the migration epic; here we mock just enough columns). Seed fixtures, run the handler, assert response shape and DB side effects.
10. The orchestrator-side socket server (whichever class owns the `cyboflow-permissions-*.sock`-equivalent socket — likely a renamed `permissionIpcServer.ts` from the approval-router epic) will be wired to call `McpQueryHandler.handleMessage` for incoming messages whose `type` starts with `mcp-`. That wiring lands in TASK-454 (lifecycle epic) where the socket-server integration is owned. This task only delivers the handler class + its tests.
11. Run `cd main && pnpm typecheck` to verify it compiles.

## Acceptance Criteria

Each frontmatter criterion restated:

1. `mcpQueryHandler.ts` exists with the named class and method signature.
2. All three message types route to distinct handlers and produce the response envelope shape.
3. Unknown types return a structured error response instead of throwing.
4. Read queries are pure SELECTs against `approvals` and `workflow_runs`.
5. Checkpoint write is a single INSERT into either a dedicated `checkpoints` table or `raw_events` with a marker event_type (the latter is preferred since it reuses the audit log infrastructure).
6. TypeScript compiles.

## Test Strategy

A new unit test file at `main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts` covers:

- **Routing**: each of the three message types reaches the right handler (asserted by checking the response data shape and DB side effects).
- **Unknown-type fallback**: an unrecognized `type` does not throw and returns `{ ok: false, error: 'unknown_message_type' }`.
- **Read shapes**: `mcp-list-pending-approvals` returns approvals sorted oldest-first; `mcp-get-run` returns `'not_found'` for a missing ID.
- **Write side effect**: `mcp-submit-checkpoint` produces an observable row via SELECT.

Setup uses an in-memory `better-sqlite3` instance (`new Database(':memory:')`) with minimal table creates inlined in the test (do not call the real migration runner — keep tests hermetic). Mock `net.Socket` with a writes-capturing test double; assert on captured JSON bodies.

## Hardest Decision

**Whether to store checkpoints in a dedicated `checkpoints` table or as append-only rows in `raw_events`.** I chose **`raw_events` with `event_type = 'cyboflow_checkpoint'`** because: (1) the schema migration epic already commits to `raw_events` as the system-wide audit log with day-1 indexes on `(run_id, id)` and `(event_type, run_id)` — those indexes serve checkpoint queries directly without retrofit, (2) a separate `checkpoints` table would require its own migration and would diverge from the "single audit log" architectural principle in the brief, (3) `raw_events` already supports per-run scoping via its FK-free design. The trade-off: querying "all checkpoints for run X" requires `WHERE event_type = 'cyboflow_checkpoint' AND run_id = ?` instead of `SELECT * FROM checkpoints WHERE run_id = ?` — the index covers both equally well.

## Rejected Alternatives

- **Dedicated `checkpoints` table.** Rejected for the reasons above — would change my mind if v1.1 introduces checkpoint-specific columns (e.g., links to artifacts, expiration timestamps) that don't fit the generic `raw_events.payload` blob shape.
- **Make all three query types go through tRPC instead of the raw socket.** Rejected because the MCP subprocess is a Node process, not a renderer — tRPC's `ipcLink` is renderer-targeted. Raw socket reuses the same proven Unix-socket transport the permission bridge already uses. Would change my mind if we extract the orchestrator out of Electron in v2 (then a typed RPC would replace the socket protocol entirely).
- **Allow the checkpoint write to also transition `workflow_runs.status`.** Rejected — that would smuggle a write surface inside what was sold as a "limited write" tool. Checkpoints are markers only; status transitions belong to the ApprovalRouter and the workflow-runs epic.

## Lowest Confidence Area

The exact column names of the `approvals` table this task SELECTs from. The schema migration epic (`cyboflow-schema-migration`) is the owner of those columns and ships before this epic, but if a column rename happens between the migration epic and this task landing, the SELECT will fail at runtime (typecheck won't catch SQL column drift). Mitigation: the executor must `grep '006_cyboflow_schema' main/src/database/migrations/` and verify the actual column names before writing the SELECTs. If column names differ from `id, run_id, tool_name, input, status, created_at`, adapt the projection to match.
