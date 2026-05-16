---
id: TASK-454
idea: IDEA-010
status: in-flight
created: "2026-05-11T00:00:00Z"
files_owned:
  - main/src/orchestrator/mcpServer/mcpServerLifecycle.ts
  - package.json
  - main/src/services/panels/claude/claudeCodeManager.ts
files_readonly:
  - main/src/orchestrator/mcpServer/cyboflowMcpServer.ts
  - main/src/orchestrator/mcpServer/mcpQueryHandler.ts
  - main/src/services/permissionIpcServer.ts
  - main/src/utils/crystalDirectory.ts
  - main/src/utils/logger.ts
  - .soloflow/active/research/ROADMAP-001-research-risks.md
acceptance_criteria:
  - criterion: "File main/src/orchestrator/mcpServer/mcpServerLifecycle.ts exists and exports a class McpServerLifecycle with public methods start(): Promise<void>, stop(): Promise<void>, getStatus(): 'starting' | 'running' | 'failed' | 'stopped'."
    verification: "test -f main/src/orchestrator/mcpServer/mcpServerLifecycle.ts && grep -E 'export class McpServerLifecycle' main/src/orchestrator/mcpServer/mcpServerLifecycle.ts && grep -q \"'starting'\" main/src/orchestrator/mcpServer/mcpServerLifecycle.ts && grep -q \"'running'\" main/src/orchestrator/mcpServer/mcpServerLifecycle.ts && grep -q \"'failed'\" main/src/orchestrator/mcpServer/mcpServerLifecycle.ts && grep -q \"'stopped'\" main/src/orchestrator/mcpServer/mcpServerLifecycle.ts"
  - criterion: "start() spawns the cyboflowMcpServer.js subprocess via child_process.spawn with stdio: ['pipe', 'pipe', 'pipe'], passes CYBOFLOW_RUN_ID and CYBOFLOW_ORCH_SOCKET via the env option, captures stderr line-by-line and forwards each line to the Logger with prefix [Cyboflow MCP]."
    verification: "grep -E 'child_process|spawn' main/src/orchestrator/mcpServer/mcpServerLifecycle.ts && grep -q 'CYBOFLOW_RUN_ID' main/src/orchestrator/mcpServer/mcpServerLifecycle.ts && grep -q 'CYBOFLOW_ORCH_SOCKET' main/src/orchestrator/mcpServer/mcpServerLifecycle.ts && grep -E 'stderr' main/src/orchestrator/mcpServer/mcpServerLifecycle.ts"
  - criterion: "Subprocess script path resolution handles BOTH dev mode (main/dist/orchestrator/mcpServer/cyboflowMcpServer.js next to __dirname) AND packaged DMG (script extracted from app.asar to ~/.cyboflow/cyboflowMcpServer.js at first start). The extraction code is gated by mcpServerScriptPath.includes('.asar') — identical to the pattern at claudeCodeManager.ts lines 700-723."
    verification: "grep -E \"\\.asar\" main/src/orchestrator/mcpServer/mcpServerLifecycle.ts && grep -q 'fs.readFileSync' main/src/orchestrator/mcpServer/mcpServerLifecycle.ts && grep -q 'fs.writeFileSync' main/src/orchestrator/mcpServer/mcpServerLifecycle.ts"
  - criterion: "package.json build.asarUnpack array includes 'main/dist/orchestrator/mcpServer/**/*.js' so the script is extractable from the packaged DMG."
    verification: "grep -E 'main/dist/orchestrator/mcpServer' package.json"
  - criterion: "On subprocess exit with non-zero code, lifecycle attempts up to 2 auto-restarts with exponential backoff (1s, 5s). After the second restart fails (third total spawn), status transitions to 'failed' and remains there until stop() then start() is called manually."
    verification: "grep -E 'restart|backoff|1000.*5000|attempts? <' main/src/orchestrator/mcpServer/mcpServerLifecycle.ts && grep -q \"'failed'\" main/src/orchestrator/mcpServer/mcpServerLifecycle.ts"
  - criterion: "stop() sends SIGTERM to the subprocess, waits up to 2 seconds for clean exit, then SIGKILLs if still alive. Status transitions to 'stopped'."
    verification: "grep -E 'SIGTERM' main/src/orchestrator/mcpServer/mcpServerLifecycle.ts && grep -E 'SIGKILL' main/src/orchestrator/mcpServer/mcpServerLifecycle.ts"
  - criterion: "claudeCodeManager.ts's per-session .mcp.json now ALSO includes a 'cyboflow' MCP server entry alongside the existing 'crystal-permissions' entry, with env vars CYBOFLOW_RUN_ID and CYBOFLOW_ORCH_SOCKET, and the command/args point at the same node + extracted script path the lifecycle manager resolved."
    verification: "grep -E '\"cyboflow\":' main/src/services/panels/claude/claudeCodeManager.ts && grep -q 'CYBOFLOW_RUN_ID' main/src/services/panels/claude/claudeCodeManager.ts && grep -q 'CYBOFLOW_ORCH_SOCKET' main/src/services/panels/claude/claudeCodeManager.ts"
  - criterion: "Subprocess stderr never bleeds into Claude's stdout — verified by lifecycle setting stdio: ['pipe', 'pipe', 'pipe'] (NOT 'inherit' or 'ignore' for stderr) and explicitly attaching a 'data' handler on subprocess.stderr that routes to logger only."
    verification: "grep -E \"stdio:\\s*\\[['\\\"]pipe['\\\"]\" main/src/orchestrator/mcpServer/mcpServerLifecycle.ts && grep -E 'stderr\\.on|stderr\\.pipe' main/src/orchestrator/mcpServer/mcpServerLifecycle.ts"
  - criterion: "TypeScript compiles (pnpm typecheck passes for the main workspace) and the build:main task succeeds."
    verification: "cd main && pnpm typecheck — exit 0; cd .. && pnpm run build:main — exit 0"
depends_on:
  - TASK-451
  - TASK-452
  - TASK-453
estimated_complexity: high
epic: cyboflow-mcp-server
test_strategy:
  needed: true
  justification: "Lifecycle spans process spawn, stderr routing, restart-with-backoff, and asar extraction — four orthogonal concerns each with failure modes that only surface at runtime. Without unit tests covering at least the restart-attempts state machine and the stderr-isolation contract, regressions would manifest only at the integration gate (TASK-455 health check) or during the 1-day self-host. The asar extraction and the .mcp.json injection are integration-like and validated by manual smoke against a packaged DMG (called out in implementation steps), not unit tests."
  targets:
    - behavior: "After 2 consecutive subprocess exits with non-zero code, getStatus() returns 'failed' and no further auto-restart fires"
      test_file: main/src/orchestrator/mcpServer/__tests__/mcpServerLifecycle.test.ts
      type: unit
    - behavior: "stderr output from the subprocess is captured line-by-line and forwarded to the injected logger; stdout from the subprocess is NOT forwarded to the logger (it's MCP protocol)"
      test_file: main/src/orchestrator/mcpServer/__tests__/mcpServerLifecycle.test.ts
      type: unit
    - behavior: "stop() called on a 'running' lifecycle transitions to 'stopped' and SIGTERM is observed on the (mocked) subprocess handle"
      test_file: main/src/orchestrator/mcpServer/__tests__/mcpServerLifecycle.test.ts
      type: unit
prerequisites:
  - check: "grep -q '\"@modelcontextprotocol/sdk\"' package.json"
    fix: pnpm add @modelcontextprotocol/sdk
    description: MCP SDK must be a declared dependency for the subprocess script to import from it at runtime in the packaged DMG.
    blocking: true
  - check: "test -f main/dist/orchestrator/mcpServer/cyboflowMcpServer.js || test -f main/src/orchestrator/mcpServer/cyboflowMcpServer.ts"
    fix: "Complete TASK-451 first (creates the subprocess source); then pnpm run build:main to produce the dist artifact."
    description: "Lifecycle cannot spawn a script that doesn't exist; TASK-451 is a hard prerequisite."
    blocking: true
---
# TASK-454: MCP server spawn lifecycle, asarUnpack, and crash isolation

## Objective

Wire the `cyboflowMcpServer.ts` subprocess into the orchestrator's lifecycle. On `Orchestrator.start()`, spawn a singleton subprocess (one per orchestrator process, not per run — the runId discrimination happens via per-tool arguments and the socket's existing session-id routing). Handle the packaged-DMG asar extraction pattern lifted from `claudeCodeManager.ts:700-723`. Isolate subprocess stderr into the dedicated logger channel so it never leaks to Claude's stdout. Implement a bounded auto-restart-with-backoff policy (2 attempts; then `failed`). Update `claudeCodeManager.ts`'s per-session `.mcp.json` writer to ALSO register the `cyboflow` MCP server alongside `crystal-permissions`. Update `package.json`'s `asarUnpack` to include the new mcpServer directory.

## Implementation Steps

1. **Verify prerequisites are met** before starting:
   - `grep '"@modelcontextprotocol/sdk"' package.json` returns `^1.12.1` (the SDK must be a runtime dependency, not a devDependency).
   - `test -f main/src/orchestrator/mcpServer/cyboflowMcpServer.ts` (TASK-451 deliverable).
   - `test -f main/src/orchestrator/mcpServer/mcpQueryHandler.ts` (TASK-452 deliverable).
2. Create new file `main/src/orchestrator/mcpServer/mcpServerLifecycle.ts`.
3. Define the class:
   ```ts
   export class McpServerLifecycle {
     private subprocess: ChildProcess | null = null;
     private status: 'starting' | 'running' | 'failed' | 'stopped' = 'stopped';
     private restartAttempts = 0;
     private readonly MAX_RESTARTS = 2;
     private readonly BACKOFF_MS = [1000, 5000];
     constructor(
       private socketPath: string,
       private logger: Logger,
       private orchestratorRunIdProvider: () => string  // returns CYBOFLOW_RUN_ID for the spawn
     ) {}
     async start(): Promise<void> { /* ... */ }
     async stop(): Promise<void> { /* ... */ }
     getStatus() { return this.status; }
     resolveScriptPath(): string { /* asar extraction logic */ }
   }
   ```
4. Implement `resolveScriptPath()` lifted from `claudeCodeManager.ts:672-723`:
   - Build the candidate path: `app.isPackaged ? path.join(__dirname, '..', 'mcpServer', 'cyboflowMcpServer.js') : path.join(__dirname, '..', 'mcpServer', 'cyboflowMcpServer.js')` — adjust the relative path so it resolves correctly from `main/dist/orchestrator/mcpServer/mcpServerLifecycle.js` to its sibling `cyboflowMcpServer.js`. Verify with `console.log` or a `fs.existsSync` check in dev.
   - If the path contains `.asar` (packaged DMG): `fs.readFileSync(scriptPath, 'utf8')` → `fs.writeFileSync(path.join(getCrystalSubdirectory(), 'cyboflowMcpServer.js'), scriptContent)` → `fs.chmodSync(extracted, 0o755)`. Return the extracted path.
   - Else: return the dev path directly.
5. Implement `start()`:
   - Guard: if `this.status === 'running'`, return early.
   - Set `this.status = 'starting'`.
   - Resolve node binary path using the same pattern as `claudeCodeManager.ts:734-766` (try `node` on PATH, fall back to `/usr/local/bin/node` / `/opt/homebrew/bin/node` / `process.execPath`).
   - `const scriptPath = this.resolveScriptPath();`
   - `this.subprocess = spawn(nodePath, [scriptPath], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CYBOFLOW_RUN_ID: this.orchestratorRunIdProvider(), CYBOFLOW_ORCH_SOCKET: this.socketPath } });`
   - Note on `CYBOFLOW_RUN_ID`: this lifecycle spawns the singleton orchestrator MCP server, so the env var here is `'orchestrator'` (a sentinel string). Per-run identification happens inside tool calls via the run_id arguments passed by Claude. **Critical:** this is different from the per-session `.mcp.json` config in step 9, which sets `CYBOFLOW_RUN_ID` to the actual Cyboflow workflow run ID for that Claude session.
   - Attach `subprocess.stderr.on('data', (chunk: Buffer) => { for (const line of chunk.toString('utf8').split('\n')) { if (line.trim()) this.logger.info(`[Cyboflow MCP] ${line}`); } })`.
   - Do NOT attach a stdout handler — stdout is the MCP protocol stream owned by the SDK on the other side.
   - Attach `subprocess.on('exit', (code) => { /* restart logic, see step 6 */ })`.
   - Attach `subprocess.on('error', (err) => { this.logger.error(`[Cyboflow MCP] spawn error: ${err.message}`); this.status = 'failed'; })`.
   - After 200ms (give the subprocess time to bootstrap), set `this.status = 'running'` if `subprocess.pid` is still defined.
6. Implement the restart-with-backoff exit handler:
   - If exit `code === 0` AND `this.status === 'stopped'` (we intentionally stopped): no-op.
   - If exit `code !== 0` AND `this.restartAttempts < this.MAX_RESTARTS`:
     - `this.logger.warn(\`[Cyboflow MCP] subprocess exited with code ${code}, restart attempt ${this.restartAttempts + 1}/${this.MAX_RESTARTS} in ${this.BACKOFF_MS[this.restartAttempts]}ms\`)`.
     - `await new Promise(r => setTimeout(r, this.BACKOFF_MS[this.restartAttempts]))`.
     - `this.restartAttempts++;` then call `this.start()` recursively.
   - Else: `this.status = 'failed'; this.logger.error('[Cyboflow MCP] subprocess unrecoverable after 2 restarts; outbound MCP tools unavailable until app restart.')`.
7. Implement `stop()`:
   - Set `this.status = 'stopped'`.
   - If `subprocess` alive: send `subprocess.kill('SIGTERM')`. Wait up to 2000ms (`await Promise.race([new Promise<void>(r => subprocess!.once('exit', () => r())), new Promise<void>(r => setTimeout(r, 2000))])`).
   - If still alive after timeout: `subprocess.kill('SIGKILL')`.
   - Null out `this.subprocess`.
8. Edit `package.json` `build.asarUnpack` array: add the entry `"main/dist/orchestrator/mcpServer/**/*.js"`. The existing array already includes `"main/dist/services/**/*.js"` — the new entry covers the new path. Verify the JSON remains valid.
9. Edit `main/src/services/panels/claude/claudeCodeManager.ts`'s `setupMcpConfigurationSync()` method (~line 800-810). The current code constructs:
   ```ts
   const mcpConfig = {
     "mcpServers": {
       ...baseProjectMcp.mcpServers,
       "crystal-permissions": { command, args }
     }
   };
   ```
   Add a `cyboflow` entry alongside `crystal-permissions`:
   ```ts
   const mcpConfig = {
     "mcpServers": {
       ...baseProjectMcp.mcpServers,
       "crystal-permissions": { command: mcpCommand, args: mcpArgs },
       "cyboflow": {
         command: mcpCommand,  // same node binary
         args: [cyboflowMcpScriptPath],  // resolved via the same asar-extraction logic, lifted into a helper or duplicated here
         env: {
           CYBOFLOW_RUN_ID: sessionId,  // for the per-session MCP, runId is the Cyboflow workflow run ID (which the caller of setupMcpConfigurationSync now needs to pass — pass it as a new parameter)
           CYBOFLOW_ORCH_SOCKET: this.permissionIpcPath!  // reuses the same socket as permissions
         }
       }
     }
   };
   ```
   - Pass the `cyboflowRunId` through the call chain so `setupMcpConfigurationSync` receives it. If the caller (`spawnCliProcess` or upstream) does not have a Cyboflow run ID yet (Phase 1 Crystal session), use `sessionId` as a temporary stand-in — the workflow-runs epic will tighten this.
   - Reuse the asar-extraction logic from `mcpServerLifecycle.resolveScriptPath()` so both spawn paths see the same extracted script. Either (a) call `McpServerLifecycle.resolveScriptPath()` statically, or (b) extract the path-resolution to a shared helper module `main/src/orchestrator/mcpServer/scriptPath.ts`. Prefer (b) for testability; create that file as part of this task's `files_owned` if you take that route (note: doing so requires adding it to `files_owned` here — if the executor chooses route (a), no extra file is needed).
10. Add the dedicated logger channel: if `Logger` does not already support a per-component log prefix, no change needed — the `[Cyboflow MCP]` prefix in stderr forwarding is sufficient channel discrimination for grep-based debug.
11. Create test file `main/src/orchestrator/mcpServer/__tests__/mcpServerLifecycle.test.ts` (see Test Strategy section).
12. Run `cd main && pnpm typecheck` to verify compilation. Then `cd .. && pnpm run build:main` to verify the dist output is produced at `main/dist/orchestrator/mcpServer/cyboflowMcpServer.js` (which is what asarUnpack will package).
13. Manual smoke test (optional, recommended): build the universal DMG (`pnpm run build:mac`), open it on a fresh user, observe `~/.cyboflow/cyboflowMcpServer.js` is created on first run.

## Acceptance Criteria

Each frontmatter criterion restated:

1. `mcpServerLifecycle.ts` exists; class with start/stop/getStatus and all four status enum values present.
2. `start()` spawns via `child_process.spawn`, passes env vars, attaches a stderr line-handler routing to the logger.
3. Script path resolves correctly in both dev and packaged-asar modes; extraction uses the same readFileSync/writeFileSync pattern.
4. `package.json` `asarUnpack` is updated to include the new directory.
5. Exit-with-nonzero retries up to 2 times with [1000ms, 5000ms] backoff; status becomes `failed` after 3 total spawn attempts.
6. `stop()` SIGTERMs, waits 2s, then SIGKILLs.
7. `claudeCodeManager.ts` writes a `cyboflow` entry into the per-session `.mcp.json` with both env vars.
8. `stdio: ['pipe', 'pipe', 'pipe']` ensures stderr is captured (not inherited) and a `data` handler exists on `subprocess.stderr`.
9. TypeScript compiles and `pnpm run build:main` succeeds.

## Test Strategy

Unit tests in `main/src/orchestrator/mcpServer/__tests__/mcpServerLifecycle.test.ts`:

- **Restart state machine** — mock `child_process.spawn` to return a fake `ChildProcess` event emitter; emit 3 consecutive `'exit'` events with code 1; assert `getStatus()` returns `'failed'` after the third and no fourth spawn fires.
- **stderr → logger routing** — pipe a Buffer of `"line1\nline2\n"` into the mock subprocess's `stderr`; assert the injected mock logger received exactly two `info()` calls with the `[Cyboflow MCP]` prefix.
- **stdout NOT routed to logger** — pipe arbitrary bytes into the mock subprocess's `stdout`; assert the logger received zero calls. (This guards against accidental stdout-piping in future refactors.)
- **stop() SIGTERM then SIGKILL** — use a fake subprocess that ignores SIGTERM; assert `stop()` calls `kill('SIGKILL')` after 2s and resolves; status becomes `'stopped'`.

Mock `child_process.spawn` with a small fake-spawn helper. Inject the `Logger` via the constructor and use a mock with `info`/`warn`/`error` jest-style spies. Tests must not actually spawn the script — keep them hermetic. Asar extraction is covered by the manual smoke test (step 13), not unit tests, because the `.asar` branch only triggers in a packaged build.

## Hardest Decision

**Restart policy: how many attempts, what backoff, when to give up.** The IDEA's open question is "auto-restart with backoff vs fail-the-run." I chose **2 attempts at 1s, 5s, then permanent `failed`** for these reasons: (1) the MCP server is read-mostly — its failure does not corrupt runs (the permission bridge is independent), so failing closed is acceptable; (2) unbounded restarts create the issue #216 crashloop pattern the risks research called out; (3) two attempts cover transient orchestrator-socket reconnect failures (the common case) while bounded failure prevents pathological loops; (4) backoff at 1s/5s mirrors industry-standard exponential-with-cap heuristics for short-lived subprocess crashloops. The trade-off: a transient orchestrator hiccup that takes >5s to recover means the user must restart the app to get outbound MCP tools back — but the red status dot from TASK-455 makes that visible.

## Rejected Alternatives

- **Unbounded restarts with constant 1s backoff.** Rejected — matches the issue #216 crashloop pattern; one bad config causes log spam and CPU burn forever.
- **Restart only on connect-error (ECONNREFUSED, EPIPE); fail immediately on protocol error.** Rejected as too clever — distinguishing transport from logic errors at exit time is unreliable without inspecting the subprocess exit-reason JSON. Bounded-attempts is simpler and equally effective.
- **Use a separate Unix socket for MCP queries (distinct from the permissions socket).** Rejected — the existing socket-server class already handles multiplexing by message `type` field. A separate socket would require a second `permissionIpcServer`-like singleton + a second cleanup path + a second potential race during shutdown. TASK-452's `mcp-*` message-type prefixing on the existing socket is the cheaper composition.
- **Spawn one MCP subprocess per Claude session (not per orchestrator).** Rejected per the architecture research §6 explicit recommendation: "the CyboflowMcpServer for cyboflow_list_pending_approvals is a separate concern — it needs to be a singleton (one per orchestrator), not per-run." The cross-run queue view requires the singleton design.

## Lowest Confidence Area

The relative path math in `resolveScriptPath()`. After `pnpm run build:main`, the dist layout is `main/dist/orchestrator/mcpServer/mcpServerLifecycle.js` next to `cyboflowMcpServer.js`. From within the running `.js` at runtime, `__dirname` is `main/dist/orchestrator/mcpServer` and `path.join(__dirname, 'cyboflowMcpServer.js')` is correct. But in the packaged ASAR, `__dirname` is something like `/Applications/Cyboflow.app/Contents/Resources/app.asar/main/dist/orchestrator/mcpServer/`, and electron's ASAR `fs.readFileSync` works against that virtual path. The patten works for `claudeCodeManager.ts:674-676` so it should work here, but the indirection-through-`__dirname` will need verification once the first packaged DMG runs. Mitigation: the manual smoke in step 13 surfaces this before the self-host bar.
