---
id: ROADMAP-001-research-architecture
roadmap: ROADMAP-001
dimension: architecture
created: 2026-05-11T00:00:00Z
---

# Architecture Research: Cyboflow MVP

## Key Findings

- **`electron-trpc` and `p-queue` are not in either package.json yet** — both are net-new dependencies the fork does not carry. The current IPC layer is raw `ipcMain.handle`; `trpc-electron` (the v11-compatible fork) is the correct dependency, not `electron-trpc`.
- **The `--permission-prompt-tool` mechanism is substantially more complex than the design doc implies.** Crystal already implements a working two-process Unix-socket bridge (`PermissionIpcServer` + `mcpPermissionBridge.ts`). The doc says `MCP_PERMISSION_SOCKET` carries the socket path, but Crystal sets `MCP_SOCKET_PATH` in the env. The actual Claude documentation for this CLI flag is sparse and the community-confirmed behavior is that the tool name must be `mcp__<server-name>__<tool-name>` format; Crystal uses `mcp__crystal-permissions__approve_permission`.
- **The `ClaudeStreamEvent` 7-variant union has concrete gaps.** The actual stream-json schema has a `system/compact` variant that is not in Anthropic's current official specification. The `result` event has 4 `subtype` values (`success`, `error_max_turns`, `error_max_budget_usd`, `error_during_execution`), not just `success`. Tool-result `content` is sometimes a string and sometimes an array. Issue #1920 (result event missing) is **closed as `not planned`** — the watchdog pattern is mandatory, not optional.
- **Crystal's existing `Mutex` (polling-every-10ms busy-wait) is not `p-queue`.** The design doc specifies `p-queue({concurrency: 1})` for per-run serialization; Crystal has a custom `Mutex` class based on a polling loop, which has known timeout behavior at 30 seconds. These are architecturally different; the queue approach is better but adds a new dependency.
- **The 5 new tables coexist cleanly with Crystal's schema, but Crystal's migration system is a hybrid mess.** Crystal uses two overlapping migration strategies — a fragmented `runMigrations()` method in `database.ts` with inline `ALTER TABLE` calls and `PRAGMA`-driven checks, plus numbered `.sql` files in `migrations/`. Migration numbers have gaps (003, 004, 005 with no 001/002), and unnamed files use descriptive prefixes that sort lexicographically, not by application order. Adding 5 new tables requires a careful numbered approach.

## Detailed Analysis

### 1. Typed Event Schema — `ClaudeStreamEvent` 7-Variant Union

**Actual stream-json discriminants (confirmed via community reverse-engineering):**

The top-level `type` field takes values: `system`, `assistant`, `user`, `result`, `stream_event`.

| Type | Subtype | Description |
|------|---------|-------------|
| `system` | `init` | Session start: `session_id`, `cwd`, `model`, `tools: string[]`, `mcp_servers: {name, status}[]`, `permissionMode`, `apiKeySource`, `claude_code_version` |
| `system` | `api_retry` | Retry: `attempt`, `max_retries`, `retry_delay_ms`, `error_status`, `error` (with categories: `rate_limit`, `server_error`, `billing_error`, etc.) |
| `system` | (compact) | Context compaction — **not in the official spec but confirmed by community** |
| `assistant` | — | `message.id`, `message.model`, `message.role: "assistant"`, `message.content: (TextBlock | ToolUseBlock | ThinkingBlock)[]`, `message.usage`, `parent_tool_use_id` |
| `user` | — | `message.role: "user"`, `message.content: ToolResultBlock[]`, `tool_use_result: {filenames, durationMs, numFiles, truncated}` |
| `result` | `success` \| `error_max_turns` \| `error_max_budget_usd` \| `error_during_execution` | `is_error`, `duration_ms`, `num_turns`, `result: string`, `total_cost_usd`, `usage`, `modelUsage`, `permission_denials: {tool_name, tool_use_id, tool_input}[]` |
| `stream_event` | — | `event.type`: `message_start`, `content_block_start`, `content_block_delta` (with `text_delta` or `input_json_delta`), `content_block_stop`, `message_delta`, `message_stop` |

**Gaps in the design doc's proposed union:**

1. **`ResultEvent` is underspecified.** The doc names one variant but the actual `subtype` has 4 variants. `is_error: boolean` exists on the result. `permission_denials` is an array (the doc names it `permissionDenials` — casing mismatch with actual JSON which uses `snake_case`). `result.total_cost_usd` vs `totalCostUsd` — all actual field names are `snake_case`, the doc uses `camelCase`. This will cause silent Zod validation failures if not reconciled.

2. **`system/compact` is unspecified.** Real Claude sessions emit a context-compaction event when the context window is approaching capacity. Crystal handles it by setting `skip_continue_next = true` on the session. The `ClaudeStreamEvent` union must include an `unknown` catch-all (which the doc does acknowledge via `.passthrough()`), but the compact variant should be explicit if it drives the `--resume` flag behavior.

3. **`AssistantMessageEvent` needs two sub-shapes.** The design doc notes that an `assistant.message` carrying a `tool_use` block is the approval trigger. In practice, the `content` array may contain mixed blocks — a text block followed by a tool_use block. The TypeScript type for `content` must be `Array<TextBlock | ToolUseBlock | ThinkingBlock>`, and the `ApprovalRouter` must iterate all blocks looking for `type === "tool_use"`, not just check whether blocks exist.

4. **`UserMessageEvent` tool-result content encoding is inconsistent.** The official spec shows `content: string`, but community sources report `content` can be an array `[{type: "text", text: "..."}]` or a string, depending on Claude version and whether the tool succeeded. The `is_error` (or `isError`) field also appears inconsistently. The Zod schema should use `z.union([z.string(), z.array(z.object({type: z.string(), text: z.string()}))])`.

5. **`StreamDeltaEvent` naming conflict.** In the actual stream-json output, streaming events are top-level objects with `type: "stream_event"` (two-word). The design doc calls the variant `StreamDeltaEvent`. The Zod discriminant must match `"stream_event"` exactly.

6. **`ErrorEvent` does not appear in the actual stream-json at top level.** Errors are surfaced as `system/api_retry`, as `result` with `subtype: "error_during_execution"`, or as non-JSON stderr. There is no separate `type: "error"` object in the stream. The `ErrorEvent` in the design doc's union appears to be fictional unless it refers to MCP/tool errors.

7. **`system.permissionMode` vs `system.permission_mode`.** The init event uses `permissionMode` (camelCase) — confirmed in the SamSaffron gist spec. Zod schema must use this exact casing.

**The `result` event missing issue (#1920 — CLOSED NOT PLANNED).** The watchdog pattern `(child exited) AND (stdout EOF) AND (parser queue drained) + 30s grace` is the only viable approach. The issue is marked `closed as not planned` meaning Anthropic is not fixing this. Planning must treat it as permanent, not a temporary workaround.

**Sources:**
- [CLAUDE_AGENT_SDK_SPEC.md gist (SamSaffron)](https://gist.github.com/SamSaffron/603648958a8c18ceae34939a8951d417) — most complete community-maintained schema reference
- [Issue #1920 — missing result event](https://github.com/anthropics/claude-code/issues/1920) — closed not planned
- [Issue #24596 — missing stream-json docs](https://github.com/anthropics/claude-code/issues/24596) — confirms documentation gap
- [claude-agent-sdk-go/docs/cli-protocol.md](https://github.com/Roasbeef/claude-agent-sdk-go/blob/main/docs/cli-protocol.md) — documents `isError`, `control` type, `--permission-prompt-tool stdio`

### 2. Synchronous Permission-Socket Bridge

**What Crystal actually does (grounded in code):**

Crystal's implementation is a two-process Unix-socket bridge:
1. `PermissionIpcServer` — a `net.createServer()` listening at `~/.crystal/sockets/crystal-permissions-<pid>.sock`
2. `mcpPermissionBridge.ts` — a Node.js subprocess that connects to that socket, exposes an MCP server over stdio, and acts as the `claude-permissions` MCP server registered via `--mcp-config`
3. Claude is spawned with `--permission-prompt-tool mcp__crystal-permissions__approve_permission --allowedTools mcp__crystal-permissions__approve_permission`

**The env variable question.** The design doc says `MCP_PERMISSION_SOCKET` carries the socket path. The actual Crystal code sets `MCP_SOCKET_PATH` in the subprocess environment (`claudeCodeManager.ts`, line 252). The subprocess (`mcpPermissionBridge.ts`) does **not** read `MCP_PERMISSION_SOCKET` — it takes the socket path as `process.argv[3]`. The design doc's claim that Claude Code exposes `MCP_PERMISSION_SOCKET` appears to be aspirational or refers to a different mechanism. The actual socket path reaches the bridge via `argv`, not an env var.

**The JSON exchange.** The MCP bridge sends to `PermissionIpcServer`:
```json
{ "type": "permission-request", "requestId": "...", "sessionId": "...", "toolName": "Bash", "input": {...} }
```
`PermissionIpcServer` replies:
```json
{ "type": "permission-response", "requestId": "...", "response": { "behavior": "allow|deny", "updatedInput": {...}, "message": "..." } }
```
The bridge then returns this as the MCP tool call result.

**Critical gap: `PermissionManager.requestPermission` has no timeout.** The current Crystal code (`permissionManager.ts`, line 73): `return new Promise((resolve, reject) => { this.once(\`response:${request.id}\`, ...) })` — this promise never settles without a socket reply. The design doc mandates a 60-minute timeout that replies with `deny` on the socket. Crystal does not implement this. The `ApprovalRouter` for Cyboflow must add the timeout.

**Socket disconnect behavior.** In `mcpPermissionBridge.ts`, `ipcClient.on('close', () => { process.exit(0) })`. If the orchestrator socket closes (e.g., app crash), the bridge subprocess exits cleanly. But Claude is left waiting on the MCP tool call with no response — this will cause Claude to hang indefinitely. This needs a timeout on Claude's side or a controlled socket teardown that sends deny before closing.

**Multiple runs competing for the socket.** The current Crystal design is one `PermissionIpcServer` per process (singleton via `process.pid` in the socket path), and one bridge subprocess per session (taking `sessionId` as `argv[2]`). For Cyboflow's multi-run design, the existing architecture already supports this — the `sessionId` discriminates requests within the single socket server. The `PermissionManager.pendingRequests` map is session-scoped. No socket collision risk, but the singleton `PermissionManager` becomes the `ApprovalRouter` target.

**Latency.** The socket round-trip is within the same machine. Measured via Crystal's implementation: the bridge's IPC connection is established once at subprocess spawn (with a 100ms `setTimeout` delay baked in), and each permission request is a single write-read cycle on a Unix domain socket. Realistically < 5ms per round trip excluding user think time. The blocking is entirely on `PermissionManager.requestPermission()` awaiting the user response.

**Sources:**
- `main/src/services/permissionIpcServer.ts` — socket server implementation
- `main/src/services/mcpPermissionBridge.ts` — bridge subprocess
- `main/src/services/permissionManager.ts` — request/response lifecycle (no timeout — confirmed)
- `main/src/services/panels/claude/claudeCodeManager.ts` (lines 92–148) — how `--permission-prompt-tool` flag is assembled
- [Claude Code permissions doc](https://code.claude.com/docs/en/agent-sdk/permissions) — `canUseTool` is the SDK-level analog; for the CLI the `--permission-prompt-tool` flag is the hook
- [Issue #1175 — permission-prompt-tool documentation gap](https://github.com/anthropics/claude-code/issues/1175)

### 3. electron-trpc v11 Subscription Pattern

**Critical finding: neither `electron-trpc` nor `trpc-electron` nor `@trpc/server` are installed.** The fork's `main/package.json` and `frontend/package.json` do not contain any tRPC dependencies. The design doc mandates this as a day-1 discipline, but it is a net-new installation, not a refactor of existing code.

**The correct package for tRPC v11.** The original `electron-trpc` (`jsonnull/electron-trpc`) does not support tRPC v11. The correct package is `trpc-electron` (`mat-sz/trpc-electron`), which is explicitly a fork for tRPC v11.x.x. The npm package name is `trpc-electron`, installed alongside `@trpc/server` and `@trpc/client` at v11.

**Subscription backpressure.** tRPC v11 subscriptions over `ipcLink` flow through Electron IPC, which is unbuffered — it's a message passing system with no built-in flow control. The design doc's `throttle subscription broadcast at 60Hz` plan is the right mitigation. For `raw_events` storage, every event lands regardless. For the renderer's `onStreamEvent` subscription, the throttle must be applied at the server-side broadcast (in the tRPC subscription handler), not on the client side.

**tRPC v11 subscription implementation.** tRPC v11 subscriptions support async generators (not just RxJS observables). This is simpler to implement:
```ts
events.onStreamEvent: t.procedure.subscription(async function*() {
  // yield from EventEmitter using on-the-fly AsyncIterator
  for await (const event of eventEmitter.toAsyncIterator('streamEvent')) {
    yield event;
  }
})
```
The async generator pattern auto-cleans on client disconnect (the generator's `return()` or `throw()` is called), which avoids listener leaks on renderer reload.

**Renderer reload reconnection.** When the renderer reloads (dev hot-reload or crash recovery), `trpc-electron`'s `ipcLink` re-establishes on next `useSubscription()` call. Any events emitted during the gap are lost from the subscription stream but are preserved in `raw_events`. The renderer must re-query `workflow_runs` and `approvals` on mount to resync.

**Sources:**
- [trpc-electron repository](https://github.com/mat-sz/trpc-electron) — v11-compatible fork, confirmed tRPC v11 support
- [tRPC v11 subscriptions docs](https://trpc.io/docs/server/subscriptions) — async generator pattern
- `main/package.json` — confirmed absence of tRPC dependencies
- `frontend/package.json` — confirmed absence of tRPC client dependencies

### 4. Per-Run Mutex / Queue

**Crystal's existing mutex is not `p-queue`.** Crystal has a hand-rolled `Mutex` class (`main/src/utils/mutex.ts`) that uses a polling busy-wait loop with 10ms intervals and a 30-second hard timeout. The design doc specifies `p-queue({concurrency: 1})` per workflow run, which is behaviorally equivalent but has important differences:

| Aspect | Crystal `Mutex` | `p-queue({concurrency: 1})` |
|--------|----------------|---------------------------|
| Queuing | No — second caller will timeout if lock not released in 30s | Yes — callers queue and wait indefinitely |
| Timeout | Hard 30s throws `Error` | Configurable per-task via `AbortSignal` |
| Introspection | None | `.size`, `.pending`, `.isPaused` |
| Cancellation | `releaseAll()` (nuclear) | `AbortSignal` per task, `queue.clear()` |
| Shutdown drain | None | `queue.onIdle()` |
| CPU cost | Polling 100x/second per waiter | Event-driven |

**Known `p-queue` fault pattern.** Issue #168 in the `p-queue` repo documents: if you abort one queued and one running task simultaneously, the queue enters a stuck state with a phantom active job count. The workaround is to use `AbortSignal.timeout()` consistently and never call `queue.clear()` while items are pending without aborting them first.

**Shutdown drain.** `p-queue.onIdle()` returns a Promise that resolves when the queue is empty and no tasks are running. For a clean shutdown, each per-run queue should be drained via `queue.onIdle()` before `app.quit()`. The problem: a run that is blocked in `awaiting_review` (holding the socket open, waiting on a permission) will keep the queue occupied indefinitely. Shutdown must first flush all pending approvals with a `deny` reply, which drains the queue.

**Mutex hang from socket wait.** The approval flow is: `ApprovalRouter` enqueues a task into the per-run queue, that task writes the `approvals` row and then calls `PermissionManager.requestPermission()` which blocks. The per-run queue is therefore blocked for the duration of user approval. This is intentional — no other mutations should race with an approval in progress. But it means the queue is not "hung"; it's correctly paused. The 60-minute timeout must be inside `requestPermission`, not inside the queue.

**Sources:**
- `main/src/utils/mutex.ts` — Crystal's actual mutex (polling, 30s hard timeout)
- [p-queue GitHub — stuck queue issue #168](https://github.com/sindresorhus/p-queue/issues/168)
- [p-queue GitHub — hanging issue #163](https://github.com/sindresorhus/p-queue/issues/163)
- [p-queue npm page](https://www.npmjs.com/package/p-queue)

### 5. Append-Only Audit Log and Storage Costs

**Migration story when projection logic changes.** The design doc proposes `raw_events` as the source of truth with `messages` and `approvals` as derived projections. If a projection reducer changes (e.g., a bug is found in how `tool_use` blocks are parsed into `approvals`), the system must either:
- **Replay**: `DELETE FROM approvals; INSERT INTO approvals SELECT ... FROM raw_events WHERE ...` — this is O(n) over all raw events and must be done while the orchestrator is stopped (no live runs).
- **Schema version**: Add a `schema_version` column to `messages`/`approvals`, re-derive only rows from raw_events that post-date a certain `created_at` where the old projection was active.

For v1 MVP (solo developer, 2-week timeline), replay is acceptable. The replay script should be a standalone Node.js migration that reads `raw_events` and re-populates projections. Document this as a manual emergency operation.

**Storage cost estimate.** Based on the actual stream-json output schema:
- `system/init`: ~500 bytes per run
- `assistant` events with tool_use: ~1-3 KB per event (input payload varies widely for Bash commands, file writes)
- `user` events (tool_result): ~500B to 50 KB (file read results can be large, but the design doc says parse on `content_block_stop` only — tool results in `--output-format stream-json` are already complete)
- `stream_event` deltas: ~50-150 bytes per token (only with `--include-partial-messages`; the design doc says Cyboflow should parse on `content_block_stop` only, so these are stored but small)
- `result`: ~300 bytes

For a moderately active session (50 turns, 200 tool calls), `raw_events` rows total roughly 50,000 bytes = 50 KB of data payload. With SQLite row overhead (~50 bytes/row) and 250 rows, ~62 KB per run.

At 10 runs/day over 30 days = 300 runs × 62 KB = ~18 MB for `raw_events`. This is trivially small for SQLite on a local machine. Even 100× more aggressive usage (1,000 runs/day) would be 1.8 GB/month — still manageable with a simple `DELETE FROM raw_events WHERE created_at < datetime('now', '-30 days')` cleanup job.

**`BEGIN IMMEDIATE` vs `BEGIN EXCLUSIVE`.** The design doc specifies `BEGIN IMMEDIATE` for co-writes of `workflow_runs` status transitions and `approvals` rows. `better-sqlite3` is synchronous and single-process, so in practice there is no WAL reader blocking a write on this database. `BEGIN IMMEDIATE` is correct (it acquires a write lock immediately, preventing write-read phantom reads), but in a single-process SQLite context the real protection comes from the per-run mutex, not from the transaction isolation level.

**Sources:**
- `main/src/database/database.ts` — actual migration approach (hybrid `ALTER TABLE` + `.sql` files)
- `main/src/database/migrations/*.sql` — numbered files start at 003, not 001
- [SQLite WAL mode / event sourcing patterns](https://www.sqliteforum.com/p/event-sourcing-with-sqlite)
- [Dual-contract event store in SQLite (Medium)](https://medium.com/@impactarchitecture/persistence-model-for-a-dual-contract-event-store-in-sqlite-53f3505f7d21)

### 6. MCP Server Architecture

**Crystal already has a working MCP subprocess architecture.** `mcpPermissionBridge.ts` is a stdio MCP server subprocess spawned per Claude session, connecting back to the orchestrator via Unix socket. The `CyboflowMcpServer` described in §5.6 is architecturally identical — it just needs a different tool surface.

**Key risk: multiple MCP server subprocesses per run.** Each workflow run spawns a `mcpPermissionBridge` subprocess. For 8 concurrent runs, there are 8 MCP bridge subprocesses plus 8 Claude PTY processes, all pointing at the single `PermissionIpcServer`. The single socket handles this correctly (Crystal already does it), but the `CyboflowMcpServer` for `cyboflow_list_pending_approvals` is a separate concern — it needs to be a singleton (one per orchestrator), not per-run.

**The `.mcp.json` per-session injection.** Crystal already does this via `setupMcpConfigurationSync()` in `claudeCodeManager.ts`, writing a temp JSON file to `~/.crystal/crystal-mcp-<sessionId>.json`. The Cyboflow version would write:
```json
{
  "mcpServers": {
    "cyboflow": {
      "command": "<node>",
      "args": ["<cyboflowMcpServer.js>"],
      "env": {
        "CYBOFLOW_RUN_ID": "<runId>",
        "CYBOFLOW_ORCH_SOCKET": "<socket-path>"
      }
    }
  }
}
```
This is a direct lift-and-adapt of Crystal's existing pattern.

**Risk: ASAR packaging and subprocess execution.** Crystal already handles the ASAR problem (lines 700-730 of `claudeCodeManager.ts`) by extracting the bridge script to `~/.crystal/` at runtime. Cyboflow must do the same for `cyboflowMcpServer.js`. The `asarUnpack` config in `electron-builder` is also needed.

**Sources:**
- `main/src/services/mcpPermissionBridge.ts` — working reference implementation
- `main/src/services/panels/claude/claudeCodeManager.ts` (lines 672-858) — MCP config setup
- `main/src/services/permissionIpcServer.ts` — singleton socket server
- [MCP Inspector multiple instances issue](https://github.com/modelcontextprotocol/inspector/issues/293) — risk of accidental multi-spawn

### 7. Day-1 Disciplines vs Roadmap Sequencing

**Actual sequencing constraint analysis:**

Discipline 6.1 (freeze `ClaudeStreamEvent` union) must precede 6.2 (move parser to main) because the parser emits typed events. Discipline 6.2 must precede 6.3 (build orchestrator structure) because the orchestrator consumes typed events. These are strictly sequential, not parallelizable, taking roughly:
- 6.1: ~2 hours (write Zod schemas, TypeScript union, test against real output)
- 6.2: ~4 hours (extract `ClaudeMessageTransformer`, wire EventEmitter, connect to DB writer)
- 6.3: ~4 hours (wrap in `Orchestrator` class, route via tRPC router skeleton)

Total: ~10 hours = 1.25 working days. The doc's "roughly one combined day" is slightly optimistic given the tRPC install is also net-new.

**What happens if deferred.** The design doc's day-3 gate is "two runs must each be pausable on the queue." If the parser stays on the renderer side (Crystal's current position), the orchestrator cannot intercept tool_use events before they reach the renderer — the approval flow would require a round-trip from renderer → main → socket, adding at least one full IPC hop in the critical path. More critically, the per-run mutex lives in main process; if the parser is in the renderer, it cannot hold the mutex during event processing. Deferring 6.2 past day 3 makes the day-3 gate fail by design.

**The `--dangerously-skip-permissions` default.** Crystal's `ClaudeCodeManager.buildCommandArgs()` defaults to `--dangerously-skip-permissions` if `effectiveMode !== 'approve'` or if `permissionIpcPath` is null. For Cyboflow's review-queue-centric workflow, every run must use `approve` mode. The fork must change the default.

**Sources:**
- `main/src/services/panels/claude/claudeCodeManager.ts` (lines 88-105) — default permission mode
- Design doc §6 — day-1 discipline ordering

### 8. Database Schema Delta

**Crystal's migration system is fragmented and order-sensitive in a non-obvious way.**

The system has two layers:
1. `runMigrations()` in `database.ts` — a ~400-line method with inline `PRAGMA table_info()` checks and `ALTER TABLE` statements. No idempotency tracking. Applied every startup.
2. `.sql` files in `migrations/` — numbered 003/004/005, applied by `runMigrations()` in a second pass. But files `001` and `002` are missing (they were inlined).

File sort order matters: files with no numeric prefix (e.g., `add_archived_field.sql`) sort before `003_add_tool_panels.sql` lexicographically. The migration runner must be checked for whether it uses numeric or lexicographic ordering.

**For Cyboflow's 5 new tables**, the cleanest approach is:
- A single numbered migration file `006_cyboflow_schema.sql` that creates all 5 new tables in one transaction
- No foreign keys referencing Crystal's `sessions` or `tool_panels` tables (strict separation, as §5.3 states "Crystal's tables coexist but are not the source of truth")
- Use `IF NOT EXISTS` to make it idempotent

**Foreign key enforcement.** `better-sqlite3` supports `PRAGMA foreign_keys = ON`, but Crystal's `database.ts` does not currently enable it (common SQLite default is OFF). The new Cyboflow tables should work with FK enforcement enabled. Check Crystal's `DatabaseService.initialize()` for whether it's set.

**New tables summary:**

```sql
-- 006_cyboflow_schema.sql
CREATE TABLE IF NOT EXISTS workflows (...);          -- 5 pre-set workflow definitions per project
CREATE TABLE IF NOT EXISTS workflow_runs (...);      -- central entity; status state machine
CREATE TABLE IF NOT EXISTS raw_events (...);         -- append-only, one row per parsed event
CREATE TABLE IF NOT EXISTS messages (...);           -- derived projection from raw_events
CREATE TABLE IF NOT EXISTS approvals (...);          -- pending/decided tool-use approvals
```

**No foreign keys to Crystal tables** is the right call for v1. A `workflow_runs.session_id` FK to `sessions` would impose a dependency on Crystal's session lifecycle for every Cyboflow run, complicating the eventual cleanup of Crystal tables.

**Sources:**
- `main/src/database/database.ts` (lines 113-250) — actual migration runner
- `main/src/database/schema.sql` — base schema (3 tables)
- `main/src/database/migrations/*.sql` — numbered 003/004/005 with gaps

### 9. State Machine on `workflow_runs.status`

**The state machine invariants from §5.3:**
```
queued → starting → running ─┬→ awaiting_review → running (loop)
                             ├→ completed
                             ├→ failed
                             └→ canceled
```

**Forbidden transitions** (must be enforced at the DB mutation layer):
- `completed → *` (terminal, no transitions out)
- `failed → *` (terminal, except potentially `→ queued` for retry in v2)
- `canceled → *` (terminal)
- `awaiting_review → completed` (must go back through `running` first)
- `queued → awaiting_review` (must start first)
- `running → running` (no-op but could hide bugs; should log WARN)

**Stuck-state detection.** The design doc: "if a run is awaiting review for >5 min and that review is itself paused on another run's tool call, flag as `stuck`." This is actually a cross-run deadlock scenario that requires:
1. A periodic check (e.g., every 60 seconds) scanning `approvals` where `status = 'pending' AND created_at < now() - 5 minutes`
2. For each stale approval, check if the `approvals` table has another approval with the same `run_id` that is also pending (self-deadlock) or if the Claude process for that run is still alive

The `stuck` state is not in the state machine transitions above — it would be `awaiting_review` with a `stuck_at` timestamp or a separate `stuck` status. The design doc uses `stuck` as a status value. Adding it means the enum is: `queued | starting | running | awaiting_review | stuck | completed | failed | canceled`.

**Recovery from `failed`.** The design doc is silent on `failed → queued` retry. For v1, `failed` is terminal. Recovery means creating a new `workflow_run` row. The worktree is kept (§5.4 says "keep until user manually merges or archives"), so a retry can reuse the same worktree.

**Atomic co-writes required.** The design doc is correct: every `awaiting_review` transition must co-write an `approvals` row in the same `BEGIN IMMEDIATE` transaction. In `better-sqlite3`, this is:
```ts
const transition = db.transaction((runId, approvalData) => {
  db.prepare('UPDATE workflow_runs SET status = "awaiting_review" WHERE id = ? AND status = "running"').run(runId);
  db.prepare('INSERT INTO approvals (...) VALUES (...)').run(approvalData);
});
transition(runId, approvalData);
```
The `AND status = "running"` guard on the UPDATE is the race condition protection — if the run has been canceled concurrently, the UPDATE affects 0 rows, and the code must check `changes` and rollback.

**Sources:**
- Design doc §5.3 — state machine definition
- `main/src/services/database.ts` — `transaction()` wrapper (synchronous in better-sqlite3, no async transaction issues)
- `main/src/utils/mutex.ts` — Crystal's existing per-resource lock

## Recommendations

1. **Resolve the `MCP_PERMISSION_SOCKET` vs `MCP_SOCKET_PATH` vs `argv` discrepancy on day 1.** The design doc says `MCP_PERMISSION_SOCKET`, Crystal uses `MCP_SOCKET_PATH` in the environment but actually passes the path as `argv[3]` to the bridge subprocess. Cyboflow must pick one convention and document it. Recommend keeping `argv`-based passing (more explicit, no env pollution), and updating the `CyboflowMcpServer` to take `CYBOFLOW_RUN_ID` and `CYBOFLOW_ORCH_SOCKET` as env vars (as the design doc intends) because those are injected into the `.mcp.json`, not passed by Claude.
   - Evidence: `claudeCodeManager.ts` line 777: `mcpArgs: [mcpBridgePath, sessionId, this.permissionIpcPath!]`
   - Risk if ignored: `CyboflowMcpServer` will fail to connect to orchestrator because the socket path lookup mechanism will be wrong

2. **Fix the `ClaudeStreamEvent` union before writing any parser code.** The design doc's field names are camelCase but actual JSON uses snake_case (`total_cost_usd`, `permission_denials`, `num_turns`). The `result` event has 4 subtypes, not 1. `ErrorEvent` is not a real top-level event type. The compact variant needs explicit handling.
   - Evidence: SamSaffron spec gist, community implementations
   - Risk if ignored: Silent Zod parsing failures (`.passthrough()` will swallow the mismatched fields), the `ResultEvent` reducer will never fire correctly, cost tracking will always be 0

3. **Add `p-queue` and `trpc-electron` as new dependencies immediately (day 1).** Neither is currently installed. The `Mutex` class should remain for PTY spawn locks (it's used throughout Crystal) but the per-run serialization should use `p-queue({concurrency: 1})` for queue introspection and drain-on-shutdown.
   - Evidence: `main/package.json` — no tRPC or p-queue entries
   - Risk if ignored: No typed IPC means the day-1 discipline (§6.3, tRPC router as only public surface) cannot be met; without queue introspection, stuck-state detection is harder to implement

4. **Fix `PermissionManager.requestPermission()` to include a 60-minute timeout that replies `deny` on the socket.** The current Crystal implementation has an infinite wait promise. This is flagged as a non-negotiable failure mode in §5.7.
   - Evidence: `permissionManager.ts` line 73 — no timeout
   - Risk if ignored: App hangs indefinitely if user closes laptop, walks away, or approval dialog is dismissed without a decision. The run's PTY is blocked, the per-run queue is blocked, and no other mutations for that run can proceed.

5. **Use a single numbered migration file `006_cyboflow_schema.sql` for all 5 new tables.** Crystal's migration system is messy (inline code + files with gaps in numbering), but the file-based path is cleaner for review and replay. Use `IF NOT EXISTS` guards, no FK references to Crystal's tables, and enable `PRAGMA foreign_keys = ON` for the Cyboflow tables.
   - Evidence: `database.ts` runMigrations() — hybrid approach creates ordering ambiguity
   - Risk if ignored: If two separate migration files are used for Cyboflow tables, a startup failure between file 1 and file 2 leaves the schema in a partially-applied state with no rollback

## Open Questions

- **Does Crystal's migration runner apply `.sql` files in lexicographic or numeric order?** The `runMigrations()` code must be inspected (beyond the first 250 lines already read) to confirm whether `006_cyboflow_schema.sql` will actually run after `005_unified_panel_settings.sql`. If it uses `fs.readdirSync().sort()`, the numeric prefix is sufficient. If it uses `glob` with a wildcard, ordering may be OS-dependent. This matters for the architecture researcher to verify; it is a schema-migration execution concern.

- **Should `workflow_runs` rows own the PTY process reference, or should Crystal's `sessions`/`tool_panels` tables be the PTY anchor?** The design doc says Crystal's tables "coexist but are not the source of truth," but the `ClaudeCodeManager.processes` Map is keyed by `panelId`. If Cyboflow creates a minimal Crystal session + panel per run (to reuse `ClaudeCodeManager`), then `workflow_runs` must reference a Crystal panel. If Cyboflow bypasses Crystal's session layer and manages PTY processes directly, it must fork `AbstractCliManager` with a `runId`-keyed process map. This is a sequencing decision the roadmap must address by day 2.

- **Is `trpc-electron` (mat-sz fork) maintained and production-ready?** The fork exists because the original `jsonnull/electron-trpc` is stagnant on tRPC v10. The mat-sz fork's activity level and issue count should be verified. If it is also stagnant, the alternative is to implement `ipcMain.handle`-based typed wrappers manually (more verbose but no external dependency risk).

- **How does the compact event interact with the permission-socket state?** If Claude emits a `system/compact` event while blocked on a socket reply (in `awaiting_review`), does the compact event arrive on the PTY stream before or after the socket resumes? The `skip_continue_next` logic in Crystal (which sets a flag on the session to skip `--resume` after compaction) would interact incorrectly with an approval in-flight. This is a race condition that needs a concrete test case.

- **Does Cyboflow's `workflow_runs` table need to reference a Crystal `sessions` row at all?** If the answer is no, Crystal's `AbstractCliManager` needs modification to accept a `runId` as the process key instead of a `panelId`. If yes, a minimal Crystal session is created per run and `workflow_runs.crystal_session_id` FK points to it. The architecture choice drives the scope of the Crystal-fork surgery needed on day 1-2.

---

Sources:
- [CLAUDE_AGENT_SDK_SPEC.md gist (SamSaffron)](https://gist.github.com/SamSaffron/603648958a8c18ceae34939a8951d417)
- [Issue #1920 — missing result event](https://github.com/anthropics/claude-code/issues/1920)
- [Issue #24596 — missing stream-json documentation](https://github.com/anthropics/claude-code/issues/24596)
- [claude-agent-sdk-go CLI protocol docs](https://github.com/Roasbeef/claude-agent-sdk-go/blob/main/docs/cli-protocol.md)
- [Claude Code permissions documentation](https://code.claude.com/docs/en/agent-sdk/permissions)
- [Claude Code user input / canUseTool documentation](https://code.claude.com/docs/en/agent-sdk/user-input)
- [Issue #1175 — permission-prompt-tool documentation gap](https://github.com/anthropics/claude-code/issues/1175)
- [trpc-electron (mat-sz fork, tRPC v11)](https://github.com/mat-sz/trpc-electron)
- [tRPC v11 subscriptions documentation](https://trpc.io/docs/server/subscriptions)
- [p-queue GitHub — stuck queue issue #168](https://github.com/sindresorhus/p-queue/issues/168)
- [p-queue GitHub — hanging issue #163](https://github.com/sindresorhus/p-queue/issues/163)
- [SQLite event sourcing patterns](https://www.sqliteforum.com/p/event-sourcing-with-sqlite)
- [MCP Inspector multiple instances issue](https://github.com/modelcontextprotocol/inspector/issues/293)
- [Claude Code stream-json backgroundclaude.com explainer](https://backgroundclaude.com/blog/stream-json)
