---
id: TASK-453
idea: IDEA-010
status: ready
created: 2026-05-11T00:00:00Z
files_owned:
  - main/src/orchestrator/mcpServer/cyboflowMcpServer.ts
files_readonly:
  - main/src/orchestrator/mcpServer/mcpQueryHandler.ts
  - main/src/services/mcpPermissionBridge.ts
acceptance_criteria:
  - criterion: "cyboflowMcpServer.ts's CallToolRequestSchema handler implements all three named tools — no 'not_implemented' stub remains for any of cyboflow_list_pending_approvals, cyboflow_get_run, cyboflow_submit_checkpoint."
    verification: "grep -E 'not_implemented' main/src/orchestrator/mcpServer/cyboflowMcpServer.ts returns 0 matches; grep -E \"case 'cyboflow_list_pending_approvals'|name === 'cyboflow_list_pending_approvals'\" main/src/orchestrator/mcpServer/cyboflowMcpServer.ts returns >0 matches; same for the other two tool names."
  - criterion: "Each tool handler calls sendQuery() (the socket helper from TASK-451) with the matching wire message type — 'mcp-list-pending-approvals', 'mcp-get-run', 'mcp-submit-checkpoint' — and forwards the orchestrator response back to Claude as MCP { content: [{ type: 'text', text: <stringified payload> }] }."
    verification: "grep -E 'sendQuery.*mcp-list-pending-approvals' main/src/orchestrator/mcpServer/cyboflowMcpServer.ts && grep -E 'sendQuery.*mcp-get-run' main/src/orchestrator/mcpServer/cyboflowMcpServer.ts && grep -E 'sendQuery.*mcp-submit-checkpoint' main/src/orchestrator/mcpServer/cyboflowMcpServer.ts"
  - criterion: "Input schemas for the three tools are tightened from the TASK-451 placeholders: cyboflow_list_pending_approvals takes no required args; cyboflow_get_run requires run_id:string; cyboflow_submit_checkpoint requires label:string and accepts optional note:string."
    verification: "grep -E \"required: \\['run_id'\\]\" main/src/orchestrator/mcpServer/cyboflowMcpServer.ts && grep -E \"required: \\['label'\\]\" main/src/orchestrator/mcpServer/cyboflowMcpServer.ts"
  - criterion: "Tool handlers extract typed arguments via request.params.arguments with a runtime type guard; missing/invalid args produce an MCP-formatted error response { content: [{ type: 'text', text: JSON.stringify({ error: 'invalid_arguments', ... }) }] }, not an SDK exception."
    verification: "grep -q 'invalid_arguments' main/src/orchestrator/mcpServer/cyboflowMcpServer.ts"
  - criterion: "If sendQuery() rejects (orchestrator socket closed, timeout, ok:false response), the tool handler returns an MCP error response and does NOT crash the subprocess."
    verification: "Visual: every tool branch wraps sendQuery() in try/catch and converts errors into MCP content; grep -E 'catch.*error.*sendQuery|\\.catch\\(' main/src/orchestrator/mcpServer/cyboflowMcpServer.ts returns >0 matches."
  - criterion: "sendQuery() (added in TASK-451) is updated to support a 30-second timeout — if no response arrives in 30s, the pending request is rejected with error 'orchestrator_timeout' and the requestId entry is cleaned from the pendingRequests map."
    verification: "grep -E 'orchestrator_timeout' main/src/orchestrator/mcpServer/cyboflowMcpServer.ts && grep -E 'setTimeout.*30' main/src/orchestrator/mcpServer/cyboflowMcpServer.ts"
  - criterion: "TypeScript compiles (pnpm typecheck passes)."
    verification: "cd main && pnpm typecheck — exit 0"
depends_on: [TASK-451, TASK-452]
estimated_complexity: medium
epic: cyboflow-mcp-server
test_strategy:
  needed: false
  justification: "The subprocess is fundamentally an integration artifact — it speaks MCP over stdio to Claude on one end and a Unix socket to the orchestrator on the other. Unit tests would either mock both transports (testing only the routing glue, which the AC greps already cover) or require a full integration harness (out of scope for this task, owned by TASK-454 lifecycle). The behavior tests that matter live on the McpQueryHandler side (TASK-452) where the SQL effects are deterministic, and on TASK-454 where spawn lifecycle has its own integration validation."
---

# TASK-453: Implement three MCP tool surfaces

## Objective

Replace the `not_implemented` CallTool stub from TASK-451 with real handlers for `cyboflow_list_pending_approvals`, `cyboflow_get_run`, and `cyboflow_submit_checkpoint`. Each handler validates input arguments, calls into `sendQuery()` to round-trip through the orchestrator's `McpQueryHandler` (from TASK-452), and formats the response back to Claude as MCP `{ content: [{ type: 'text', text: ... }] }`. Tighten the per-tool input schemas to their final shapes and ensure all error paths return structured MCP responses (never crash the subprocess).

## Implementation Steps

1. Open `main/src/orchestrator/mcpServer/cyboflowMcpServer.ts` (created in TASK-451).
2. Update the `sendQuery()` helper to add a 30-second timeout:
   - Wrap the existing promise in a `Promise.race` with `new Promise((_, reject) => setTimeout(() => reject(new Error('orchestrator_timeout')), 30_000))`.
   - On timeout, also delete the `requestId` from `pendingRequests` map so it cannot leak memory.
   - Rationale: an orphaned MCP query (orchestrator drops the response) must not hang Claude's tool call indefinitely; 30s mirrors typical SDK timeouts.
3. Tighten the `ListToolsRequestSchema` handler's tool definitions to the final shapes:
   ```ts
   const tools = [
     {
       name: 'cyboflow_list_pending_approvals',
       description: 'Return the cross-run review queue: all approvals currently pending across every running workflow in this Cyboflow workspace. Read-only.',
       inputSchema: { type: 'object', properties: {}, required: [] }
     },
     {
       name: 'cyboflow_get_run',
       description: 'Fetch a workflow run\'s state (status, workflow name, timestamps, last 10 events) by ID. Read-only.',
       inputSchema: {
         type: 'object',
         properties: { run_id: { type: 'string', description: 'The workflow_runs.id to fetch' } },
         required: ['run_id']
       }
     },
     {
       name: 'cyboflow_submit_checkpoint',
       description: 'Record a checkpoint marker for the current run. This is an observational marker only — it does not change run status, approve anything, or notify the user.',
       inputSchema: {
         type: 'object',
         properties: {
           label: { type: 'string', description: 'Short identifier for the checkpoint' },
           note: { type: 'string', description: 'Optional longer description' }
         },
         required: ['label']
       }
     }
   ];
   ```
4. Replace the `CallToolRequestSchema` handler body with a routing switch on `request.params.name`:
   - **`cyboflow_list_pending_approvals`**: `const result = await sendQuery('mcp-list-pending-approvals', {});` — return `{ content: [{ type: 'text', text: JSON.stringify(result) }] }`.
   - **`cyboflow_get_run`**: extract `request.params.arguments` as `{ run_id?: unknown }`. Type-guard `typeof run_id === 'string'`; if not, return `{ content: [{ type: 'text', text: JSON.stringify({ error: 'invalid_arguments', expected: 'run_id: string' }) }] }`. Else `await sendQuery('mcp-get-run', { targetRunId: run_id })` and return.
   - **`cyboflow_submit_checkpoint`**: extract `{ label?: unknown, note?: unknown }`. Type-guard `typeof label === 'string'`; if not, return the `invalid_arguments` error. If `note !== undefined`, type-guard `typeof note === 'string'` (else error). Then `await sendQuery('mcp-submit-checkpoint', { label, note })` and return.
   - **default**: throw `new Error(\`Unknown tool: ${request.params.name}\`)` (the SDK converts this to a proper MCP error response, matching mcpPermissionBridge line 162).
5. Wrap each tool branch in try/catch — on any error (timeout, socket closed, orchestrator ok:false response), return `{ content: [{ type: 'text', text: JSON.stringify({ error: error.message }) }] }`. The subprocess must not crash on a transient orchestrator query failure; Claude should see a tool-error response instead.
6. The orchestrator returns responses of shape `{ ok: boolean, data?: unknown, error?: string }` (per TASK-452). Forward `data` to Claude on success; convert `ok: false` to `{ error: response.error }` in the MCP text payload so Claude can reason about it.
7. Run `cd main && pnpm typecheck` to verify compilation.
8. Smoke-validate the implementation manually if convenient: `node main/dist/orchestrator/mcpServer/cyboflowMcpServer.js` with mock env vars and pipe a `tools/list` JSON-RPC request to stdin — observe correct tool list returned on stdout. (Optional; not required for AC.)

## Acceptance Criteria

Each frontmatter criterion restated:

1. No `not_implemented` stub remains; all three tool names appear in the switch logic.
2. Each handler calls `sendQuery()` with the matching wire-protocol type.
3. Input schemas have final required-fields shape (`run_id` for get_run, `label` for submit_checkpoint, none for list_pending_approvals).
4. Invalid arguments produce `'invalid_arguments'` MCP responses, not exceptions.
5. `sendQuery()` errors are caught and converted to MCP error responses.
6. `sendQuery()` has a 30-second timeout that rejects with `'orchestrator_timeout'`.
7. TypeScript compiles.

## Test Strategy

No automated tests. Rationale in frontmatter: the subprocess is an integration artifact spanning two transports (stdio MCP + Unix socket), and tests that mock both would cover only the routing glue — already asserted by grep ACs. The deterministic SQL behavior lives in TASK-452's tests. TASK-454's lifecycle tests will end-to-end validate the spawn → tool-call → response path against a real socket.

## Hardest Decision

**How to surface orchestrator `{ ok: false, error: ... }` responses to Claude — as an MCP exception or as a structured tool result?** I chose to surface them as a tool result with an `error` field in the JSON text payload, **not** as an MCP SDK exception. Rationale: (1) Claude's behavior on MCP tool exceptions is to retry or surface a hard error to the user; for a `not_found` on `cyboflow_get_run` (e.g., user supplied a wrong run_id), Claude should see a structured error and respond conversationally, not crash the tool call; (2) the design doc §5.6 frames these tools as read-mostly observation surfaces — a missing run is a valid query outcome, not a system error. The trade-off: Claude's downstream MCP error handling won't fire for `not_found` cases (which is what we want). True system errors (orchestrator crashed, socket gone) still surface as caught exceptions.

## Rejected Alternatives

- **Use Zod schemas to validate tool arguments instead of inline type guards.** Rejected because the input shapes are tiny (1-2 string fields each) and adding Zod to the subprocess imports increases startup time and bundle size for a per-run spawn. Would change my mind if input schemas grow past ~5 fields.
- **Implement a fourth `cyboflow_cancel_run` write tool.** Rejected per the IDEA frontmatter and design doc §5.6 — the human-in-the-loop is the product, no write surface for state transitions in v1. Resisting scope creep here is the whole point of the IDEA's "limited write — checkpoint marker only" framing.
- **Add a 30s timeout on the orchestrator side instead of inside `sendQuery`.** Rejected — the client (subprocess) owns its own timeout because the orchestrator might be paused (GC, full-disk, locked DB) and never see the request. The client-side timeout is the only fail-safe.

## Lowest Confidence Area

The exact shape of what Claude expects in the `text` payload of a tool result. The MCP SDK's `CallToolResult.content` is typed as `(TextContent | ImageContent | EmbeddedResource)[]` and `TextContent.text: string` is opaque to the SDK. Claude almost certainly parses the text as JSON when the tool description hints at structured data, but the prompt-engineering side (whether to wrap the data in `{ result: ..., metadata: ... }` envelopes, whether to pretty-print the JSON for token efficiency, whether to truncate long arrays) is not specified anywhere I can verify. I'm shipping a flat `JSON.stringify(orchResponse.data)` for the success case. If Claude struggles to parse it during TASK-454 integration testing, the fallback is to pretty-print and/or add an envelope.
