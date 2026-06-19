---
id: TASK-798
idea: IDEA-029
status: ready
created: 2026-05-29T00:00:00Z
source: IDEA-029
epic: mcp-runtime-step-tracking
files_owned:
  - main/src/orchestrator/mcpServer/orchSocketServer.ts
  - main/src/orchestrator/mcpServer/__tests__/orchSocketServer.test.ts
files_readonly:
  - main/src/orchestrator/mcpServer/mcpQueryHandler.ts
  - main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts
  - main/src/orchestrator/mcpServer/cyboflowMcpServer.ts
  - main/src/orchestrator/types.ts
  - main/src/orchestrator/stuckDetector.ts
  - main/src/orchestrator/runLauncher.ts
  - main/src/utils/cyboflowDirectory.ts
  - main/src/orchestrator/__test_fixtures__/dbAdapter.ts
  - main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts
acceptance_criteria:
  - criterion: "A new class `OrchSocketServer` exists in main/src/orchestrator/mcpServer/orchSocketServer.ts that creates a net.Server, listens on a Unix socket path under the cyboflow sockets dir, and routes each parsed message through an injected McpQueryHandler."
    verification: "grep -n 'class OrchSocketServer' main/src/orchestrator/mcpServer/orchSocketServer.ts && grep -n 'net.createServer' main/src/orchestrator/mcpServer/orchSocketServer.ts && grep -n 'handleMessage' main/src/orchestrator/mcpServer/orchSocketServer.ts"
  - criterion: "The server exposes getSocketPath(): string so it satisfies the OrchSocketProvider interface, and hasClientForRun(runId: string): boolean so it satisfies the PermissionServerLike interface — both declared in existing readonly files."
    verification: "grep -n 'getSocketPath' main/src/orchestrator/mcpServer/orchSocketServer.ts && grep -n 'hasClientForRun' main/src/orchestrator/mcpServer/orchSocketServer.ts"
  - criterion: "Incoming connections are framed by newline-delimited JSON using a per-connection rolling receive buffer (mirroring cyboflowMcpServer.ts), so messages split across multiple 'data' events or batched without a trailing newline parse correctly."
    verification: "Covered by orchSocketServer.test.ts case that writes a single JSON message split across two socket writes and asserts exactly one routed McpQueryMessage; runs under `pnpm --filter main test`."
  - criterion: "Each parsed line is cast/narrowed to McpQueryMessage and passed to McpQueryHandler.handleMessage(msg, client); a line that is not valid JSON is logged via the injected logger and does NOT crash the server or the connection."
    verification: "orchSocketServer.test.ts asserts (a) a valid message produces a handler-written response on the client socket, and (b) a malformed line leaves the server listening and emits a logger.warn/error — no throw escapes."
  - criterion: "The constructor accepts and uses an injected LoggerLike (per CLAUDE.md: optional logger? must be passed, not omitted) and an injected DatabaseLike used to construct the McpQueryHandler."
    verification: "grep -n 'logger' main/src/orchestrator/mcpServer/orchSocketServer.ts shows logger.* calls on socket lifecycle/error events; grep -n 'new McpQueryHandler' main/src/orchestrator/mcpServer/orchSocketServer.ts"
  - criterion: "No use of the `any` type."
    verification: "grep -nE ':\\s*any(\\b|\\[)|<any>|as any' main/src/orchestrator/mcpServer/orchSocketServer.ts main/src/orchestrator/mcpServer/__tests__/orchSocketServer.test.ts returns 0 matches"
  - criterion: "start() creates the sockets directory if missing, unlinks any stale socket file at the path, and resolves once the server is listening; stop() closes the server and resolves."
    verification: "orchSocketServer.test.ts starts the server on a tmp socket path, connects a real net client, sends a message, asserts a response, then calls stop() and asserts the server is no longer listening."
  - criterion: "All unit tests pass."
    verification: "pnpm --filter main test (or pnpm test:unit) exits 0 with orchSocketServer.test.ts included."
  - criterion: "The new code type-checks and lints clean."
    verification: "pnpm typecheck && pnpm lint exit 0"
depends_on: []
estimated_complexity: medium
test_strategy:
  needed: true
  justification: "New networked class with framing, routing, and lifecycle logic — all behaviors are unit-testable against a real net socket pair and an in-memory DB, mirroring the existing mcpQueryHandler.test.ts fixtures."
  targets:
    - behavior: "A valid newline-delimited McpQueryMessage sent by a connected client is routed through McpQueryHandler and a JSON response is written back on the same socket."
      test_file: "main/src/orchestrator/mcpServer/__tests__/orchSocketServer.test.ts"
      type: integration
    - behavior: "A JSON message split across two socket writes is reassembled by the rolling buffer and routed exactly once."
      test_file: "main/src/orchestrator/mcpServer/__tests__/orchSocketServer.test.ts"
      type: integration
    - behavior: "A malformed (non-JSON) line is logged and dropped without crashing the server or terminating other connections."
      test_file: "main/src/orchestrator/mcpServer/__tests__/orchSocketServer.test.ts"
      type: unit
    - behavior: "getSocketPath() returns the listening path; hasClientForRun(runId) reflects whether a client connection bound to that runId is currently open."
      test_file: "main/src/orchestrator/mcpServer/__tests__/orchSocketServer.test.ts"
      type: unit
    - behavior: "stop() closes the server; start() unlinks a stale socket file and creates the sockets dir."
      test_file: "main/src/orchestrator/mcpServer/__tests__/orchSocketServer.test.ts"
      type: integration
---

# Stand up the orchestrator Unix-socket IPC server and wire McpQueryHandler

## Objective

Create the real `permissionIpcServer` half of IDEA-029 slice 1: a Unix-socket server class (`OrchSocketServer`) in `main/src/orchestrator/mcpServer/orchSocketServer.ts` that listens on a socket under `~/.cyboflow/sockets/`, accepts connections from spawned `cyboflowMcpServer` subprocesses, parses the newline-delimited JSON wire protocol those subprocesses already emit, and routes each message through a real `McpQueryHandler` instance (constructed with the injected cyboflow DB). This makes the three existing `cyboflow_*` tools routable for the first time. This task delivers the *server object only*. It does NOT start `McpServerLifecycle`, does NOT call `defaultCliManager.setOrchSocketPath()`, and does NOT touch `main/src/index.ts` — that boot wiring is TASK-799, which depends on this.

## Implementation Steps

1. Create the new file `main/src/orchestrator/mcpServer/orchSocketServer.ts`. Import `net` and `fs` from node, `path` (for dirname), `McpQueryHandler` + `McpQueryMessage` from `./mcpQueryHandler`, and `DatabaseLike` + `LoggerLike` from `../types`. Do NOT import `electron` or any `services/*` module — `orchestrator/` keeps the standalone-typecheck invariant documented at the top of `types.ts`. Resolve the socket path via the cyboflow directory helper, but to preserve that invariant, accept the resolved `socketPath: string` as a constructor argument rather than importing `getCyboflowSubdirectory` here (the caller in TASK-799 will pass `getCyboflowSubdirectory('sockets', 'orch.sock')`).

2. Define the class `OrchSocketServer` with a constructor `(private readonly socketPath: string, db: DatabaseLike, private readonly logger: LoggerLike)`. In the constructor, build `this.handler = new McpQueryHandler(db)`. Hold `private server: net.Server | null = null` and a `private readonly clientsByRun = new Map<string, Set<net.Socket>>()` to back `hasClientForRun`.

3. Implement `async start(): Promise<void>`:
   - `fs.mkdirSync(path.dirname(this.socketPath), { recursive: true })`.
   - If a stale socket file exists at `this.socketPath`, `fs.rmSync(this.socketPath, { force: true })` (unix sockets fail to bind onto a leftover file).
   - `this.server = net.createServer((socket) => this.onConnection(socket))`.
   - Attach `this.server.on('error', (err) => this.logger.error(...))`.
   - Return a Promise that resolves on `this.server.listen(this.socketPath, () => resolve())`.

4. Implement `private onConnection(socket: net.Socket): void` mirroring the rolling-buffer framing in `cyboflowMcpServer.ts:66-90`:
   - Local `let recvBuffer = ''`.
   - On `socket.on('data', (buf: Buffer) => { recvBuffer += buf.toString('utf8'); ... })`, loop on `recvBuffer.indexOf('\n')`, slice each complete line, `.trim()`, skip empty lines.
   - For each line, `JSON.parse` inside try/catch. On parse failure, `this.logger.warn('[Cyboflow Orch IPC] failed to parse line', { line })` and `continue` — never throw out of the data handler.
   - Narrow the parsed value: it must be an object with a string `type` and string `requestId`. If it has a string `runId`, register the socket in `clientsByRun` (so `hasClientForRun` works) the first time a runId is seen on this socket. Cast the validated object to `McpQueryMessage` (the union from mcpQueryHandler) and `void this.handler.handleMessage(msg, socket)`.
   - On `socket.on('close', ...)` and `socket.on('error', ...)`, remove the socket from every `clientsByRun` set and log at debug/warn. Use the injected logger — do not omit it.

5. Implement `getSocketPath(): string { return this.socketPath; }` (satisfies `OrchSocketProvider` from `runLauncher.ts:33`) and `hasClientForRun(runId: string): boolean { return (this.clientsByRun.get(runId)?.size ?? 0) > 0; }` (satisfies `PermissionServerLike` from `stuckDetector.ts:46`). Prefer structural satisfaction; if you want a compile-time guarantee, add `import type { OrchSocketProvider } from '../runLauncher'` and `import type { PermissionServerLike } from '../stuckDetector'` and declare `class OrchSocketServer implements OrchSocketProvider, PermissionServerLike` — but FIRST confirm neither import pulls `electron`/`services/*` transitively (both are pure interface modules; if `runLauncher.ts` drags concrete types, prefer the structural approach and assert satisfaction in the test instead).

6. Implement `async stop(): Promise<void>`: if `this.server`, wrap `this.server.close(() => resolve())` in a Promise, null out `this.server`, and best-effort `fs.rmSync(this.socketPath, { force: true })` to clean the socket file.

7. Create the new test file `main/src/orchestrator/mcpServer/__tests__/orchSocketServer.test.ts`. Reuse the existing fixtures: `dbAdapter` from `../../__test_fixtures__/dbAdapter` and `createTestDb`/`seedApproval` from `../../__test_fixtures__/orchestratorTestDb` (same imports as `mcpQueryHandler.test.ts`). Use a real `net` client (`net.createConnection`) against a tmp socket path (e.g. under `os.tmpdir()` to keep tests hermetic and avoid touching `~/.cyboflow`). Make a `makeSpyLogger()` (or reuse the orchestrator test helper) producing a `LoggerLike` with vitest `vi.fn()` methods. Cover the five `test_strategy.targets` behaviors. For the split-frame test, send the JSON in two `client.write()` calls and assert the response arrives once. For `hasClientForRun`, send a message carrying a `runId`, then assert `server.hasClientForRun(thatRunId) === true` and an unknown run is `false`. Always `await server.stop()` and close clients in `afterEach`.

8. Run `pnpm --filter main test` and confirm `orchSocketServer.test.ts` passes. If you hit a `better-sqlite3` NODE_MODULE_VERSION error, run `pnpm rebuild better-sqlite3` first per CLAUDE.md, then re-run. Then run `pnpm typecheck && pnpm lint` and confirm clean.

## Acceptance Criteria notes

- The wire protocol is fixed by the already-shipped subprocess: it sends `JSON.stringify({ type, requestId, runId, ...params }) + '\n'` (`cyboflowMcpServer.ts:126-127`) and expects a response object containing a matching `requestId` written back with a trailing newline. `McpQueryHandler.writeResponse` already appends `'\n'`, so the server just forwards `socket` into `handleMessage` and the framing is correct — do not double-encode.
- `McpQueryHandler.handleMessage` already never throws and writes its own `unknown_message_type` / error responses. The server's only error responsibility is the *transport* layer: malformed (non-JSON) lines, which the handler never sees. Keep that boundary clean.
- The `any`-free grep AC excludes the legitimate use of `unknown` + narrowing for the parsed line; ensure the narrowing helper returns a typed value (e.g. a small `isMcpQueryEnvelope(v: unknown): v is { type: string; requestId: string; runId?: string }` guard) rather than an `as any` cast.

## Out of Scope

- Starting `McpServerLifecycle`, calling `defaultCliManager.setOrchSocketPath()`, replacing the `OrchestratorHealth` sentinel, or any edit to `main/src/index.ts` — that is TASK-799 (depends on this task).
- Resolving `bridgeScriptResolver` / ASAR script-path extraction — that remains in `scriptPath.ts` and is wired by TASK-799.
- Adding the `mcp-report-step` message type or any new `McpQueryMessage` union member — that is slice 4 (TASK-802). This task treats the union as-is and is forward-compatible because `handleMessage` already has an exhaustive-default fallback.
- Threading the real `CYBOFLOW_RUN_ID` (slice 2 / TASK-800) — unrelated to the server transport.
- Any frontend or `WORKFLOW_DEFINITIONS` change.
