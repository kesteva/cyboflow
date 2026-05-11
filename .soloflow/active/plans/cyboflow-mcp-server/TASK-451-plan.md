---
id: TASK-451
idea: IDEA-010
status: ready
created: 2026-05-11T00:00:00Z
files_owned:
  - main/src/orchestrator/mcpServer/cyboflowMcpServer.ts
files_readonly:
  - main/src/services/mcpPermissionBridge.ts
  - main/src/utils/crystalDirectory.ts
  - .soloflow/active/research/ROADMAP-001-research-architecture.md
  - .soloflow/active/ideas/IDEA-010.md
  - .soloflow/active/roadmaps/ROADMAP-001.md
acceptance_criteria:
  - criterion: "File main/src/orchestrator/mcpServer/cyboflowMcpServer.ts exists and exports a module-level main() that starts an MCP Server over StdioServerTransport when invoked as a Node subprocess."
    verification: "test -f main/src/orchestrator/mcpServer/cyboflowMcpServer.ts && grep -q 'StdioServerTransport' main/src/orchestrator/mcpServer/cyboflowMcpServer.ts && grep -q 'new Server' main/src/orchestrator/mcpServer/cyboflowMcpServer.ts"
  - criterion: "Subprocess reads CYBOFLOW_RUN_ID and CYBOFLOW_ORCH_SOCKET from process.env at startup and exits with code 1 (with a stderr log) if either is missing."
    verification: "grep -q 'CYBOFLOW_RUN_ID' main/src/orchestrator/mcpServer/cyboflowMcpServer.ts && grep -q 'CYBOFLOW_ORCH_SOCKET' main/src/orchestrator/mcpServer/cyboflowMcpServer.ts && grep -E 'process.exit\\(1\\)' main/src/orchestrator/mcpServer/cyboflowMcpServer.ts"
  - criterion: "Subprocess connects to the orchestrator over a Unix domain socket using net.createConnection(CYBOFLOW_ORCH_SOCKET) at startup; on socket 'close' the process exits cleanly with code 0 (mirroring mcpPermissionBridge.ts behavior)."
    verification: "grep -q \"net.createConnection\" main/src/orchestrator/mcpServer/cyboflowMcpServer.ts && grep -E \"'close'.*process.exit\\(0\\)\" main/src/orchestrator/mcpServer/cyboflowMcpServer.ts"
  - criterion: "Server registers a ListTools handler that announces exactly the three tool names: cyboflow_list_pending_approvals, cyboflow_get_run, cyboflow_submit_checkpoint (tool implementations come in TASK-453 but the names are declared here so the protocol is wired)."
    verification: "grep -q 'cyboflow_list_pending_approvals' main/src/orchestrator/mcpServer/cyboflowMcpServer.ts && grep -q 'cyboflow_get_run' main/src/orchestrator/mcpServer/cyboflowMcpServer.ts && grep -q 'cyboflow_submit_checkpoint' main/src/orchestrator/mcpServer/cyboflowMcpServer.ts && grep -q 'ListToolsRequestSchema' main/src/orchestrator/mcpServer/cyboflowMcpServer.ts"
  - criterion: "All error paths in the subprocess (uncaughtException, unhandledRejection, parse errors, socket errors) write to process.stderr only — never to process.stdout — so the MCP stdio protocol stream stays clean."
    verification: "grep -E 'process.stdout' main/src/orchestrator/mcpServer/cyboflowMcpServer.ts | grep -v -E '^\\s*//' returns 0 matches (no non-comment writes to stdout outside the MCP SDK transport itself), and uncaughtException + unhandledRejection handlers exist."
  - criterion: "TypeScript compiles (pnpm typecheck passes for the main workspace)."
    verification: "cd main && pnpm typecheck — exit 0"
depends_on: []
estimated_complexity: medium
epic: cyboflow-mcp-server
test_strategy:
  needed: false
  justification: "This task scaffolds a subprocess shell with no tool logic yet — behavior is asserted via grep-based AC and a typecheck. Tool-implementation testing comes in TASK-453 where logic actually exists. Adding unit tests for the env-var bootstrap path would require mocking process.argv/env/net and would test the framework, not the code."
---

# TASK-451: Build CyboflowMcpServer stdio subprocess shell

## Objective

Create the `cyboflowMcpServer.ts` Node subprocess that the orchestrator will spawn per Claude session. It establishes the stdio MCP transport, opens the Unix socket connection to the orchestrator using env-var-injected paths, registers a ListTools handler announcing the three tool names, and installs crash-isolation handlers. Tool call implementations are intentionally deferred — this task only lays the protocol scaffolding so TASK-452 and TASK-453 have a stable shape to plug into.

## Implementation Steps

1. Create directory `main/src/orchestrator/mcpServer/` if it does not already exist. Create new file `main/src/orchestrator/mcpServer/cyboflowMcpServer.ts`.
2. Add the standard `#!/usr/bin/env node` shebang on line 1 (matches `mcpPermissionBridge.ts`).
3. Import from `@modelcontextprotocol/sdk@^1.12.1` (already in `package.json` dependencies — verify with `grep '@modelcontextprotocol/sdk' package.json` returns `^1.12.1`):
   - `Server` from `@modelcontextprotocol/sdk/server/index.js`
   - `StdioServerTransport` from `@modelcontextprotocol/sdk/server/stdio.js`
   - `CallToolRequestSchema`, `ListToolsRequestSchema` from `@modelcontextprotocol/sdk/types.js`
4. Import Node built-ins `net`, `process`.
5. At module scope, read env vars: `const runId = process.env.CYBOFLOW_RUN_ID;` and `const socketPath = process.env.CYBOFLOW_ORCH_SOCKET;`. If either is missing, write a clear error to `process.stderr` (prefix every line with `[Cyboflow MCP]`) and `process.exit(1)`.
6. Implement `connectToOrchestrator()` that creates a `net.Socket` via `net.createConnection(socketPath)`. Pattern mirrors `mcpPermissionBridge.ts:32-61`:
   - On `'data'`: JSON.parse the buffer; route to a `pendingRequests` Map of `requestId → resolver`. Catch parse errors and log to stderr.
   - On `'error'`: log to stderr only.
   - On `'close'`: `process.exit(0)` (graceful shutdown when orchestrator socket goes away).
   - Maintain a `pendingRequests = new Map<string, (response: unknown) => void>()` module-level.
   - Expose a `sendQuery(type: string, params: Record<string, unknown>): Promise<unknown>` helper that generates a unique `requestId`, writes `{ type, requestId, runId, ...params }` to the socket, and resolves when the matching `requestId` response arrives. (TASK-452 wires the orchestrator side; TASK-453 calls this from tool handlers.)
7. Build the MCP `Server` instance with `name: 'cyboflow'`, `version: '1.0.0'`, capabilities `{ tools: {} }`.
8. Register `ListToolsRequestSchema` handler that returns the three tools with placeholder input schemas (full schemas are refined in TASK-453, but the names must be final here):
   - `cyboflow_list_pending_approvals` — `inputSchema: { type: 'object', properties: {}, required: [] }`
   - `cyboflow_get_run` — `inputSchema: { type: 'object', properties: { run_id: { type: 'string' } }, required: ['run_id'] }`
   - `cyboflow_submit_checkpoint` — `inputSchema: { type: 'object', properties: { label: { type: 'string' }, note: { type: 'string' } }, required: ['label'] }`
9. Register `CallToolRequestSchema` handler as a stub that returns `{ content: [{ type: 'text', text: JSON.stringify({ error: 'not_implemented', tool: request.params.name }) }] }` — TASK-453 replaces this with real implementations.
10. Install crash-isolation handlers (mirror lines 184-194 of `mcpPermissionBridge.ts`):
    - `process.on('uncaughtException', (err) => { console.error('[Cyboflow MCP] Uncaught:', err.stack); process.exit(1); })`
    - `process.on('unhandledRejection', (reason) => { console.error('[Cyboflow MCP] Unhandled rejection:', reason); })`
    - `process.on('SIGTERM', () => { if (ipcClient) ipcClient.end(); process.exit(0); })`
    - `process.on('SIGINT', () => { if (ipcClient) ipcClient.end(); process.exit(0); })`
11. `main()` calls `connectToOrchestrator()`, waits 100ms (`await new Promise(r => setTimeout(r, 100))`) to give the socket time to establish (matches mcpPermissionBridge pattern), then `await server.connect(new StdioServerTransport())`. On any uncaught error in `main`, log to stderr and `process.exit(1)`.
12. CRITICAL: do NOT write anything to `process.stdout` except via the MCP SDK's `StdioServerTransport`. All log/debug messages use `console.error` (which writes to stderr). The SDK owns stdout for the JSON-RPC protocol stream.
13. Run `cd main && pnpm typecheck` and verify it passes.

## Acceptance Criteria

The five frontmatter criteria each restated:

1. The file exists at the exact path and imports `StdioServerTransport` + `new Server` — confirmed by greps in the verification.
2. The subprocess reads both env vars and exits 1 if either is missing — `process.exit(1)` appears alongside the env-var checks.
3. Unix socket connection is established and `close` triggers a clean `process.exit(0)`.
4. ListTools handler announces all three tool names verbatim.
5. No non-comment writes to `process.stdout` outside the SDK; uncaughtException/unhandledRejection handlers present.
6. TypeScript compiles cleanly.

## Test Strategy

No automated tests are added in this task. The scaffold is fully asserted by grep-based ACs against required imports, env-var handling, error-handling shape, and tool-name declarations. Behavior tests come in TASK-453 when the tool handlers carry real logic against a fakeable orchestrator socket.

## Hardest Decision

**Whether to read socket path from `process.argv` (Crystal's existing pattern in `mcpPermissionBridge.ts`) or from `process.env` (the IDEA's explicit choice via `.mcp.json` env injection).** The architecture research §6 noted Crystal uses `argv[3]` but the design doc and IDEA both specify env-var injection via `.mcp.json`'s `env` field. I chose **env vars** because: (1) the IDEA frontmatter explicitly names `CYBOFLOW_RUN_ID` and `CYBOFLOW_ORCH_SOCKET` as the contract, (2) `.mcp.json` natively supports `env:`, (3) env-var injection is more robust to argv quoting issues across shells, (4) it leaves `argv` clean for future operational flags. The trade-off: a slightly noisier env, but env-pollution is bounded to the subprocess.

## Rejected Alternatives

- **Lift `mcpPermissionBridge.ts` verbatim and edit in place.** Rejected because the two servers have different lifecycles (permission bridge is per-session; this server is per-run from Claude's perspective but per-orchestrator from the socket's perspective), different tool surfaces, and different write-vs-read protocol shapes. A fresh file keeps the diff readable and avoids cross-contamination of bridge-specific concerns. Would change my mind if the two servers turn out to share >70% of code in TASK-453.
- **Embed tool implementations directly in TASK-451.** Rejected because TASK-452 (orchestrator socket protocol extension) is a prerequisite — implementing tools without the server-side handlers would just produce dead `not_implemented` stubs anyway. Splitting at this boundary keeps each task's diff scoped and reviewable.
- **Use a single `tools/list_changed` capability instead of a static three-tool list.** Rejected as overkill for v1 — the tool list is fixed and known at startup; dynamic capability negotiation adds complexity with no v1 benefit.

## Lowest Confidence Area

The 100ms `setTimeout` before `server.connect(transport)` is copied from `mcpPermissionBridge.ts:90-91` and is the only race-condition mitigation between socket open and protocol handshake. If the orchestrator's socket server is slow to accept (e.g., under load during multi-run spawn), 100ms may not be enough and the first MCP query could fail with `'IPC client not connected'`. A more robust pattern would be to await the socket `'connect'` event explicitly before calling `server.connect()`. I'm shipping the 100ms timeout for parity with the existing bridge, but this is the most likely follow-up tweak after TASK-454's integration test.
