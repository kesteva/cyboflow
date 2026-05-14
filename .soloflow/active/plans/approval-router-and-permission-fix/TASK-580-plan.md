---
id: TASK-580
idea: SPRINT-006-compound
status: ready
source_sprint: SPRINT-006
created: 2026-05-14T00:00:00Z
files_owned:
  - main/src/services/cyboflowPermissionIpcServer.ts
  - main/src/services/cyboflowPermissionBridge.ts
  - main/build-cyboflow-permission-bridge.js
  - main/src/services/__tests__/cyboflowPermissionIpcServer.test.ts
files_readonly:
  - main/src/orchestrator/approvalRouter.ts
  - main/src/services/panels/claude/claudeCodeManager.ts
  - main/src/index.ts
  - .soloflow/active/findings/SPRINT-006-findings.md
  - .soloflow/active/compound/SPRINT-006-proposal.md
  - .soloflow/active/plans/approval-router-and-permission-fix/EPIC-approval-router-and-permission-fix.md
  - .soloflow/active/plans/approval-router-and-permission-fix/TASK-302-plan.md
acceptance_criteria:
  - criterion: "CyboflowPermissionIpcServer maintains a per-socket buffer; the `client.on('data', ...)` handler appends the incoming chunk to the buffer, splits on `\\n`, parses every complete line, and retains any trailing partial-line in the buffer for the next chunk"
    verification: "grep -nE 'buffer|split.*\\\\n|indexOf.*\\\\n' main/src/services/cyboflowPermissionIpcServer.ts returns at least 3 matches AND grep -n 'JSON.parse' main/src/services/cyboflowPermissionIpcServer.ts shows the JSON.parse call is inside a per-line loop (not directly on data.toString())"
  - criterion: "CyboflowPermissionIpcServer's socketReply closure writes JSON followed by a `\\n` terminator on every reply (both the success path and the catch/deny path)"
    verification: "grep -nE \"JSON\\.stringify\\(.*\\)\\s*\\+\\s*['\\\"]\\\\\\\\n['\\\"]\" main/src/services/cyboflowPermissionIpcServer.ts returns at least 2 matches (one for success path, one for catch path)"
  - criterion: "cyboflowPermissionBridge.ts maintains a per-socket buffer for the IPC client; the `ipcClient.on('data', ...)` handler appends, splits on `\\n`, and parses complete lines"
    verification: "grep -nE 'buffer|split.*\\\\n|indexOf.*\\\\n' main/src/services/cyboflowPermissionBridge.ts returns at least 3 matches AND the JSON.parse call is inside a per-line loop"
  - criterion: "cyboflowPermissionBridge.ts writes the outbound request with a trailing `\\n` on the socket"
    verification: "grep -nE \"JSON\\.stringify\\(.*\\)\\s*\\+\\s*['\\\"]\\\\\\\\n['\\\"]\" main/src/services/cyboflowPermissionBridge.ts returns at least 1 match"
  - criterion: "build-cyboflow-permission-bridge.js (the standalone-bundled bridge string) emits the same buffer-and-write contract — both the IPC-client data handler and the outbound IPC write include `\\n` framing"
    verification: "grep -nE 'buffer|split.*\\\\\\\\n' main/build-cyboflow-permission-bridge.js returns at least 2 matches in the IPC client section (lines around the existing `ipcClient.on('data', ...)` block); grep -nE \"JSON\\.stringify\\(.*\\)\\s*\\+\\s*['\\\"]\\\\\\\\\\\\\\\\n['\\\"]\" main/build-cyboflow-permission-bridge.js returns at least 1 match in the outbound write"
  - criterion: "Unit-test suite for CyboflowPermissionIpcServer covers the three framing scenarios: (a) single complete line, (b) two messages coalesced into one chunk, (c) one message split across two chunks. All three pass."
    verification: "test -f main/src/services/__tests__/cyboflowPermissionIpcServer.test.ts AND grep -cE 'single complete|coalesced|split across' main/src/services/__tests__/cyboflowPermissionIpcServer.test.ts returns at least 3; pnpm --filter main test cyboflowPermissionIpcServer exits 0 and shows at least 3 cases"
  - criterion: "Manual smoke test from TASK-255 still works: a Claude session can start, the bridge connects, a permission request flows through to ApprovalRouter, and an approve/deny reply travels back end-to-end. Document the manual smoke result in the done report."
    verification: "Done report includes a `Manual smoke` section listing: app launched via `pnpm dev`; a Claude session created; an approve/deny path round-tripped; bridge logs show no JSON.parse SyntaxError"
  - criterion: "Main process typecheck passes"
    verification: "pnpm --filter main typecheck exits 0"
  - criterion: "Main process lint passes"
    verification: "pnpm --filter main lint exits 0"
depends_on:
  - TASK-579
estimated_complexity: medium
epic: approval-router-and-permission-fix
test_strategy:
  needed: true
  justification: "Framing is the load-bearing invariant that prevents the DB-wedge bug. Coalescing and chunk-splitting cannot be visually verified — they require a test that synthesizes the byte stream. Pair-tasking with B3 (zod validation), which extends the same test file with envelope-shape cases."
  targets:
    - behavior: "Single complete newline-terminated message parses into one ApprovalRouter.requestApproval call"
      test_file: main/src/services/__tests__/cyboflowPermissionIpcServer.test.ts
      type: unit
    - behavior: "Two complete messages arriving in one data chunk both parse and both reach ApprovalRouter (coalescing case)"
      test_file: main/src/services/__tests__/cyboflowPermissionIpcServer.test.ts
      type: unit
    - behavior: "One message split across two data chunks parses correctly once both chunks have arrived; the trailing partial line is buffered between chunks (chunk-splitting case)"
      test_file: main/src/services/__tests__/cyboflowPermissionIpcServer.test.ts
      type: unit
    - behavior: "Malformed line (broken JSON) is logged and the buffer continues processing subsequent complete lines without crashing the connection"
      test_file: main/src/services/__tests__/cyboflowPermissionIpcServer.test.ts
      type: unit
---

# Add newline-delimited message framing to the unix socket (IPC server + bridge)

## Objective

`cyboflowPermissionIpcServer.ts:50-95` and `cyboflowPermissionBridge.ts:40-53` both call `JSON.parse(data.toString())` once per `data` event on their respective net sockets. Node `net.Socket` does not preserve message boundaries — two writes can coalesce into a single `data` event, and a large payload can split across chunks. Either case throws `JSON.parse` `SyntaxError`, the message is silently dropped, and (post-TASK-302) the `workflow_runs.status='awaiting_review'` row is left wedged indefinitely because the deny-on-error fallback also never runs.

This task adds the canonical buffer-and-split-on-`\n` idiom to both endpoints and to the standalone bundled bridge (`build-cyboflow-permission-bridge.js`). The pattern is already proven by `SimpleMCPServer.processBuffer` at `main/build-cyboflow-permission-bridge.js:111-125`.

## Implementation Steps

1. **Edit `main/src/services/cyboflowPermissionIpcServer.ts`** — replace the body of the `client.on('data', ...)` handler with the buffer pattern:

   Inside the `net.createServer((client) => { ... })` callback, immediately after `this.clients.set(clientId, client);` add a per-client buffer:
   ```ts
   let buffer = '';
   ```

   Replace the existing `client.on('data', async (data) => { try { const message = JSON.parse(data.toString()); ... } catch (...) { ... } })` block with:
   ```ts
   client.on('data', async (data) => {
     buffer += data.toString();
     let newlineIdx: number;
     while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
       const line = buffer.slice(0, newlineIdx);
       buffer = buffer.slice(newlineIdx + 1);
       if (!line.trim()) continue;
       try {
         const message = JSON.parse(line);
         // ... existing per-message handling (the if (message.type === 'permission-request') block) ...
       } catch (error) {
         console.error('[Permission IPC] Error handling message:', error);
       }
     }
   });
   ```

2. **In the same file, update both `client.write(...)` calls** (the success path inside `socketReply` and the catch-path deny inside the error handler) to append a newline terminator:
   ```ts
   client.write(JSON.stringify({ type: 'permission-response', requestId, response: decision }) + '\n');
   ```
   Both writes must include the `+ '\n'` suffix. Do NOT use `\r\n` — the parser only splits on `\n`.

3. **Edit `main/src/services/cyboflowPermissionBridge.ts`** — apply the symmetric change to the bridge subprocess's IPC-client side:

   Add a module-scoped buffer:
   ```ts
   let ipcBuffer = '';
   ```

   Replace the `ipcClient.on('data', (data) => { try { const message = JSON.parse(data.toString()); ... } catch (...) { ... } })` block with:
   ```ts
   ipcClient.on('data', (data) => {
     ipcBuffer += data.toString();
     let newlineIdx: number;
     while ((newlineIdx = ipcBuffer.indexOf('\n')) !== -1) {
       const line = ipcBuffer.slice(0, newlineIdx);
       ipcBuffer = ipcBuffer.slice(newlineIdx + 1);
       if (!line.trim()) continue;
       try {
         const message = JSON.parse(line);
         if (message.type === 'permission-response' && message.requestId) {
           const resolver = pendingRequests.get(message.requestId);
           if (resolver) {
             resolver(message.response);
             pendingRequests.delete(message.requestId);
           }
         }
       } catch (error) {
         console.error(`[MCP Bridge] Error parsing IPC message: ${error}`);
       }
     }
   });
   ```

   Update the outbound write inside `requestPermission` (around line 73) to append `+ '\n'`:
   ```ts
   ipcClient.write(JSON.stringify({ type: 'permission-request', requestId, sessionId, toolName, input }) + '\n');
   ```

4. **Edit `main/build-cyboflow-permission-bridge.js`** — the standalone bundle inlines a parallel implementation of the IPC client (lines ~30-83). Apply the identical buffer+split treatment to the inlined bridge string:
   - Add `let ipcBuffer = '';` near the top of the bridge script (after `let pendingRequests = new Map();`).
   - Replace the `ipcClient.on('data', (data) => { ... })` block with the buffer-loop version (mirror step 3, including the escape semantics — note this is template-literal source, so `\\n` becomes `\n` at runtime).
   - Update the inlined `ipcClient.write(JSON.stringify({ type: 'permission-request', ... }))` to append `+ '\\n'` (template-literal escape → `+ '\n'` at runtime).

   The MCP `SimpleMCPServer.processBuffer` at line 111 (the stdin side) is already correct — leave it untouched.

5. **Create `main/src/services/__tests__/cyboflowPermissionIpcServer.test.ts`** — new file. Use a strategy that does not require a real Electron bootstrap:
   - Construct a `CyboflowPermissionIpcServer` instance and call `.start()` against a temp socket path (override via `setCrystalDirectory(tmpdir())` from `crystalDirectory.ts` before construction).
   - Initialize `ApprovalRouter` against an in-memory better-sqlite3 instance using the schema-load pattern from `main/src/orchestrator/__tests__/approvalRouter.test.ts:41-69` (read `src/database/migrations/006_cyboflow_schema.sql`, exec it, seed a `workflow_runs` row in `running` state).
   - Connect to the server via `net.createConnection(socketPath)` and exercise the four cases:
     - **single complete line**: write `JSON.stringify(msg) + '\n'`; assert one `requestApproval` call.
     - **coalesced**: write two messages in a single `client.write(json1 + '\n' + json2 + '\n')`; assert two `requestApproval` calls.
     - **split**: write the message in two `client.write` calls (e.g. first half then second half + `'\n'`); assert one `requestApproval` call after the second write.
     - **malformed line**: write `'{not-json\n'` followed by a valid `JSON.stringify(msg) + '\n'`; assert the valid message still reaches `requestApproval` and console.error was called once.
   - Tear down by `await server.stop()` and closing all client sockets in `afterEach`.

   Use vitest's `vi.spyOn(ApprovalRouter.getInstance(), 'requestApproval').mockResolvedValue(...)` or a stub injection to observe inbound calls without exercising the full DB transaction (the framing is what we're testing, not ApprovalRouter behavior).

6. **Run the full verification chain**:
   ```
   pnpm --filter main typecheck
   pnpm --filter main lint
   pnpm --filter main test cyboflowPermissionIpcServer
   pnpm --filter main test
   ```

7. **Manual smoke**: launch the app via `pnpm dev`, create a Claude session, trigger a tool-permission prompt, approve it. Confirm:
   - The bridge log shows no `JSON.parse` `SyntaxError`.
   - The approval round-trips end-to-end (renderer receives `approvalCreated`, decision flows back to Claude).
   - Record this in the done report's `Manual smoke` section.

## Acceptance Criteria

See frontmatter. Eight criteria covering buffering, newline-terminated writes on both sides, the standalone bundle parity, the new test file, manual smoke, typecheck, lint.

## Test Strategy

See frontmatter `test_strategy`. Four cases: single, coalesced, split, malformed. All in one new file. The malformed-line case is the "graceful degradation" assertion — the parser must continue processing valid lines after a broken line, not tear down the connection.

## Hardest Decision

**Should the standalone bundled bridge (`build-cyboflow-permission-bridge.js`) keep its own inlined implementation or be unified with the TypeScript source?** Chosen: keep both separate, fix both in lockstep. The standalone version exists because the packaged-app ASAR copy can't share imports with the TS source (the bridge runs as an external `node` subprocess with no module graph access to `main/dist/`). Unifying them would require a build-time bundler step that is out of scope for this finding. Document the drift in B8 (separately tracked) — this task only fixes both sides identically.

## Rejected Alternatives

- **Switch to length-prefixed framing (4-byte BE length header).** Rejected: more invasive, requires binary read on both sides, and length-prefixed framing is overkill for JSON messages bounded to a few KB. Newline-delimited JSON is the de-facto convention for the existing MCP stdio side (`SimpleMCPServer.processBuffer:111-125`); using the same convention keeps the codebase coherent.
- **Use a library like `split2` or `ndjson`.** Rejected: a 6-line buffer loop is simpler than a dependency, and the test surface is the framing logic itself — wrapping it in a library would push tests into the library boundary. The buffer pattern is already proven in `SimpleMCPServer.processBuffer`.
- **Defer the standalone-bundle (`build-cyboflow-permission-bridge.js`) fix to B8.** Rejected: leaving the packaged bridge unfixed means the framing bug ships in releases while only dev mode is healed. B8 (drift elimination) is a separate problem.

## Lowest Confidence Area

The `build-cyboflow-permission-bridge.js` edit (step 4). The file is a JavaScript-source string inside a template literal, so escape semantics are doubled: `\\n` in the source compiles to `\n` at runtime. The grep AC has matching double-escape requirements. The executor must verify the *generated* `dist/main/src/services/cyboflowPermissionBridgeStandalone.js` (after `pnpm run --filter main bundle:mcp`) contains `'\n'` and a working buffer loop — running `node` against the generated file with synthesized input is the safest sanity check.
