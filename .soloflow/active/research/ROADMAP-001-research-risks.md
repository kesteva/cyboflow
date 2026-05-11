---
id: ROADMAP-001-research-risks
roadmap: ROADMAP-001
dimension: risks
created: 2026-05-11T00:00:00Z
---

# Risks Research: Cyboflow MVP

## Key Findings

- **The inherited `PermissionManager` has no timeout.** `permissionManager.ts` line 73 is a bare `Promise` with no timeout, no reject path, no cleanup. Crystal's in-production code will hang indefinitely if the main window is destroyed while a permission is pending. This is the exact scenario the design doc says is non-negotiable: the review queue must reply with `deny` on the socket when a session is terminated or the app is closed. Zero of that is currently implemented.
- **The `package.json` ships with `hardenedRuntime: false` and `notarize: false`.** This is Crystal's development shortcut — it produces an unsigned, unnotarized DMG. Notarization requires `hardenedRuntime: true`, entitlements files, `notarytool` credentials, and an Apple Developer Program membership ($99/yr). The `afterSign.js` hook currently only strips JAR files. First-time notarization on a complex Electron app with native modules (`better-sqlite3`, node-pty) can take 1–2 days of debug iteration. This cost is invisible in the brief.
- **`bull` is still imported in `taskQueue.ts` and in `package.json` dependencies.** The doc says to delete Bull references, but they are live in the codebase. Bull transitively requires Redis at import time in some code paths. This is a ticking delete task that can produce confusing startup errors if not addressed on day 1 of the crystal-cuts epic.
- **tRPC v11 subscriptions have a confirmed memory leak** (GitHub issue trpc#6156, closed with fix PR #6161). The brief mandates tRPC v11 subscriptions as the primary streaming mechanism for Claude events to the renderer. Leaking 100KB/100ms = ~1MB/s per running workflow. At 8 concurrent runs over 8 hours, the 1-day self-host bar will expose memory exhaustion. Version confirmation is required to verify the fix is included.
- **The `result` event (issue #1920) is officially "closed, not planned"** — Anthropic will not fix it. The design doc's completion gate (`child exited AND stdout EOF AND parser drained + 30s watchdog`) is correctly specified, but this is custom code that must be built from scratch; it cannot be inherited from Crystal's completion detection logic, which does not implement this pattern.

---

## Detailed Analysis

### 1. Day-3 Greenfield-Reset Gate as Risk

**The gate condition:** If implementing the cross-workflow review queue requires touching 20+ files by day 3, the Crystal fork loses its value.

**What the codebase audit reveals:** The permission/approval path in Crystal runs: `PermissionIpcServer` (socket) → `PermissionManager` (singleton, direct Electron import, IPC handlers) → renderer via `ipcMain.handle('permission:respond')`. The Cyboflow review queue needs to intercept this path and replace it with an `ApprovalRouter` that writes to `approvals` table + drives `reviewQueueSlice`. Counting files: `permissionIpcServer.ts`, `permissionManager.ts`, a new `approvalRouter.ts`, the tRPC router (`cyboflow.*`), the `reviewQueueSlice`, `<ReviewQueueView />`, `<PendingApprovalCard />`, and the modifications to `AbstractCliManager` or `claudeCodeManager` that pass the socket path. That is 8–10 files of new code plus 3–4 existing files to modify. **This is well within the 20-file gate**, which makes the fork still justified on day 3.

However, the risk is the ordering: if the stream parser refactor (`ClaudeMessageTransformer` renderer→main) is not completed before the queue is attempted, the two halves of the work will be in-flight simultaneously and integration will be the bottleneck on day 3, not the file count.

**Realistic greenfield-reset timeline:** A TypeScript-fluent developer with Claude Code assistance building Electron + React + tRPC + SQLite + PTY management from scratch would need at minimum 15–20 days for a feature-equivalent MVP. The 2× calendar estimate in §3 is realistic. Triggering the reset on day 3 would forfeit approximately 2 days of work and face a wall-clock timeline that exceeds the 10-working-day target by 100%. The 1-day self-host bar would become unreachable in a 2-week window.

**Sources:**
- System design doc §3 — "Greenfield equivalent is estimated at roughly 2× calendar time"
- Codebase audit: `main/src/services/permissionIpcServer.ts`, `main/src/services/permissionManager.ts`

---

### 2. macOS Code Signing and Notarization Friction

**Current state of the inherited config:** `package.json` build section has `hardenedRuntime: false` and `notarize: false` (lines 118-123). The `afterSign.js` hook only removes JAR files — no notarization call. The `afterSign` is not wired to `notarytool`. This is Crystal's dev-only posture that lets builds complete without Apple credentials.

**What Cyboflow needs:** A signed + notarized DMG is in the explicit success criteria ("signed, notarized macOS app" — §1). The changes required are:
1. Flip `hardenedRuntime: true` in `package.json`
2. Create `build/entitlements.mac.plist` with minimum entitlements: `com.apple.security.cs.allow-jit` (Electron requires JIT), `com.apple.security.network.client` (for API calls), `com.apple.security.files.user-selected.read-write` (for project directory access)
3. Replace `afterSign.js` with actual `notarytool` call using keychain credentials
4. Enroll in Apple Developer Program ($99/yr) if not already enrolled — this takes 24–48 hours for identity verification
5. Create `Developer ID Application` certificate via Xcode or Apple portal

**First-time-builder pitfalls (researched):**
- `hardenedRuntime: true` + node-pty: node-pty spawns subprocesses with shebangs; hardened runtime may block unsigned subprocess execution. Requires `com.apple.security.cs.allow-unsigned-executable-memory` or testing to confirm it passes.
- `better-sqlite3` `.node` binary: must be in `asarUnpack` (Crystal already has `node_modules/**/*.node` in asarUnpack — this is correctly configured).
- Notarization turnaround: `notarytool` takes 5–30 minutes per submission. Debug iteration on a rejection (e.g., unsigned `.node` binary, unsigned helper executable) means re-signing + re-submitting + 5–30 min wait per attempt.
- Apple's `altool` was decommissioned in 2024. Must use `notarytool`. Crystal's `afterSign.js` does not call either.
- Universal binary lipo verification: electron-builder handles the universal lipo step via `arch: universal` in target config, but the `.node` binaries must each be built fat (both x64 and arm64 slices). The `@homebridge/node-pty-prebuilt-multiarch` name suggests it ships pre-built multiarch — but this should be verified with `lipo -info` on the packed binary, not assumed.

**Time budget risk:** If notarization debug is needed in week 2 (the DMG is a deliverable, not a nice-to-have), each iteration costs 30–60 min. Three rejections = half a day. Apple program enrollment delays = up to 2 days.

**Sources:**
- [Notarization requirements — hardened runtime](https://kilianvalkhof.com/2019/electron/notarizing-your-electron-application/) — explains entitlements requirements
- [altool decommission](https://github.com/electron/notarize/issues/189) — confirms altool is dead, notarytool required
- [electron-builder #3989](https://github.com/electron-userland/electron-builder/issues/3989) — hardened runtime + crash interaction
- Direct codebase audit: `package.json` lines 118–123, `build/afterSign.js`

---

### 3. `@electron/rebuild` and Native Module ABI Risk

**Current state:** `package.json` has `"postinstall": "electron-builder install-app-deps"` and `"electron:rebuild": "pnpm exec electron-rebuild -f -w better-sqlite3 -m ./main"`. The `onlyBuiltDependencies` list correctly includes `better-sqlite3` and `@homebridge/node-pty-prebuilt-multiarch`. `npmRebuild: true` in the builder config.

**Electron 37 specifics (researched):** Electron 37.0.0 ships Chromium 138, Node 22.16.0. The Node ABI for Node 22 is ABI 127. This is a significant ABI jump from Electron 32 (Node 20, ABI 115). If the developer's machine has `better-sqlite3` cached from a different Electron/Node version, the postinstall rebuild should catch it — but only if the developer runs `pnpm install` again. Simply `pnpm update electron` does not trigger postinstall.

**Known failure mode:** `better-sqlite3` issue #1163 and the broader pattern: if the `@electron/rebuild` step did not complete on the first install, the `.node` file is built against system Node rather than Electron Node, producing a cryptic `NODE_MODULE_VERSION mismatch` error at runtime that looks like a completely unrelated crash. The `setup` script (`pnpm install && pnpm run electron:rebuild && pnpm run build:main`) is the correct guard — but Claude Code agents running `pnpm install` directly without `setup` will break this.

**Universal binary risk:** `@homebridge/node-pty-prebuilt-multiarch` ships pre-built fat binaries (hence the name). This is the correct dependency choice. However, `better-sqlite3` must be rebuilt for both architectures via `electron-builder`'s universal build pipeline. The `x64ArchFiles` pattern in `package.json` (line 131) specifies which files get the x64-only treatment inside the universal bundle. The current pattern covers `{**/*.node,...}` which should include `better-sqlite3`. Verify after first universal build with `lipo -info dist-electron/*.app/Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node`.

**Routine `pnpm update` risk:** An Electron version bump (e.g., 37 → 38 during sprint 2 dependency maintenance) would change the Node ABI. `pnpm update` would update `package.json` but not trigger the rebuild hook. The developer would see a runtime error next launch. Mitigation: pin Electron version explicitly and never run `pnpm update electron` without immediately running `pnpm run setup`.

**Sources:**
- [Electron native modules docs](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules) — @electron/rebuild pattern
- [better-sqlite3 #1163](https://github.com/WiseLibs/better-sqlite3/issues/1163) — ABI mismatch diagnosis
- [Electron 37 release](https://www.electronjs.org/blog/electron-37-0) — Node 22.16.0 confirmation
- Direct codebase audit: `package.json` lines 17–21, 104–131

---

### 4. `PermissionManager` No-Timeout Bug (Inherited Critical Bug)

**Finding (code-level, high severity):** `main/src/services/permissionManager.ts` line 73–75:

```ts
return new Promise((resolve, reject) => {
  this.once(`response:${request.id}`, (response: PermissionResponse) => {
    resolve(response);
  });
});
```

There is no timeout. No reject path. If the main window closes, navigates, or crashes while a permission request is in flight, the `once` listener will never fire, the Promise will never resolve or reject, and the `PermissionIpcServer` client socket will be left hanging. The Unix socket reply to Claude's `--permission-prompt-tool` will never arrive, and the PTY process will block forever awaiting it.

Crystal's own open issue #221 ("Full Access mode switches back to Workspace, tasks hanging") is directly related: tasks enter a hung state that cannot be recovered without process kill.

**What Cyboflow requires:** The design doc §5.7 explicitly calls this out as non-negotiable: "Approval timeout (default 60 min) must reply on the socket with deny, not just expire silently." The `PermissionManager` replacement (`ApprovalRouter`) must be built with:
1. A per-approval 60-minute `setTimeout` that fires a `deny` on the socket
2. A `clearPendingForRun(runId)` path called when a run is canceled, fails, or the app is closing — each pending approval for that run must receive a socket deny reply before the PTY is killed
3. A startup recovery pass: if the DB shows runs in `awaiting_review` at app boot, they cannot be resumed (the socket no longer exists), so they should be transitioned to `failed`

**Sources:**
- Direct codebase audit: `main/src/services/permissionManager.ts`
- [stravu/crystal issue #221](https://github.com/stravu/crystal/issues/221) — permission mode and hanging, unresolved

---

### 5. Crystal Tech Debt: Inherited Bug Surfaces

**`bull` still imported in production code:** `taskQueue.ts` line 1 imports Bull. `package.json` lists `bull: "^4.16.3"` as a production dependency. The doc says to delete Bull references, but the import is live. Bull will attempt to connect to Redis if `REDIS_URL` env var is set. More critically, Bull's package.json brings in `ioredis` as a transitive dependency — this is real weight in the final bundle even in the `useSimpleQueue` path. Day-1 crystal-cuts must delete the Bull import and the `TaskQueue` class's Bull branch, keeping only `SimpleQueue`.

**`WorktreeNameGenerator` still called in `taskQueue.ts`:** Line 189 calls `this.options.worktreeNameGenerator.generateSessionName(prompt)` — this makes an API hop to Claude to generate a name. The doc says to delete this and replace with deterministic naming. It is still wired in the task queue processor. If Claude API is unreachable (offline, rate-limited), session creation silently hangs at the name generation step.

**`AbstractCliManager.setupProcessHandlers` has a `lastOutput.substring(-500)` bug:** Line 781 in `AbstractCliManager.ts`: `lastOutput.substring(-500)` — JavaScript's `substring()` treats negative arguments as 0, so this always returns the full `lastOutput` string, not the last 500 characters. Should be `lastOutput.slice(-500)`. Minor but illustrates that inherited code has not been reviewed recently.

**`SimpleQueue` does not drain in-flight jobs on `.close()`:** Lines 101–105 of `simpleTaskQueue.ts`: `.close()` clears the queue array and the jobs map without waiting for active jobs to finish. If `close()` is called while a session-creation job is executing (creating a worktree, spawning a PTY), the job will continue running orphaned — no reference, no error handling, no cleanup path. This is a zombie-creation vector on app quit.

**`PermissionManager` is a singleton initialized at module load via `getInstance()`**, which calls `setupIpcHandlers()` registering `ipcMain.handle('permission:respond', ...)`. In Cyboflow, `ipcMain.handle` will conflict with the tRPC router if both try to own the same channel name, or if `PermissionManager` is initialized before the tRPC router is set up. The replacement `ApprovalRouter` must either unregister Crystal's IPC handler or never initialize `PermissionManager` at all.

**Crystal open issues intersecting v1 surface:**
- Issue #228 ("Crystal unable to start Claude Code"): `Starting Claude Code...` spins forever — root cause in `taskQueue.ts` where the panel-creation polling loop (lines 351–363) waits up to 15 × 200ms = 3 seconds for a panel to appear, then throws `No Claude panel found`. If panel creation is slow (e.g., database contention), session creation silently fails.
- Issue #221: Permission mode hanging, unresolved, directly intersects the approval socket mechanism.
- Issue #216: MCP server initialization errors appearing after every turn — this is the exact pattern that will affect `CyboflowMcpServer` if the subprocess crashes and is not auto-restarted.

**Sources:**
- Direct codebase audit: `main/src/services/taskQueue.ts`, `main/src/services/simpleTaskQueue.ts`, `main/src/services/panels/cli/AbstractCliManager.ts`, `main/src/services/permissionManager.ts`
- [stravu/crystal issues](https://github.com/stravu/crystal/issues) — open issues #216, #221, #228

---

### 6. "Hide Rebase/Squash UI But Keep Code" Dead Code Risk

**The specific trap:** The doc says to hide entry points (buttons that invoke the code) but keep `WorktreeManager`'s rebase/squash/merge methods. These methods in `worktreeManager.ts` are ~500 lines. They have no test coverage (there are no test files for `worktreeManager.ts` — `Glob` found only `codexManager.test.ts` and `gitStatusManager.test.ts`). They depend on git CLI via `execWithShellPath`. They import from `configManager` (to check `enableCrystalFooter` flag — line 617, still hardcoded to add "Built using Crystal" footer to commits).

**The compounding risk in a fast iteration context:** Claude Code agents will read `worktreeManager.ts` as part of any context about git operations. The squash/merge/rebase methods reference `mainBranch` parameters, `git merge --ff-only`, and `git reset --soft` patterns that are irrelevant to Cyboflow's v1 operation (no user-initiated git merges, all worktrees auto-named, no squash UI). Agents asked to "fix a bug in worktree handling" may modify or depend on these methods thinking they are active code paths. **Recommendation: add a `// @cyboflow-hidden` comment block at the top of the class and at the start of each hidden method group so agents have a clear signal.**

**Sources:**
- Direct codebase audit: `main/src/services/worktreeManager.ts` lines 472–715
- `Glob` for test files in `main/src/services/` — found no worktreeManager tests

---

### 7. MCP Server Isolation and Crash Recovery

**The design:** `CyboflowMcpServer` is a stdio subprocess spawned by the orchestrator. It talks to the orchestrator over a private Unix socket. Per §5.6, it is "new code — Crystal does not have an outbound MCP server today."

**In-flight tool call risk if orchestrator crashes:** The MCP server is configured per-session via `.mcp.json` written into the worktree. The `CYBOFLOW_ORCH_SOCKET` env var points to the Unix socket. If the Electron main process crashes (OOM, unhandled exception), the Unix socket is destroyed. The MCP server's next Unix socket write will get `ECONNRESET` or `EPIPE`. The MCP server's tool call (`cyboflow_list_pending_approvals`, etc.) will fail with a transport error. Claude's MCP client (inside the PTY session) will see a tool call failure — this manifests as an `error` content block in the stream, which the (now-crashed) orchestrator will never see. Net effect: Claude's session is in an unknown state; when the app restarts, the run's `awaiting_review` state is stale. **Mitigation: app-boot recovery pass must transition all runs in `awaiting_review` to `failed` with reason "app_restart".**

**If MCP server crashes while Claude holds a tool call response open:** Claude's session will timeout waiting for a tool result. Claude Code's behavior in this case is to emit an error event and continue. The orchestrator will receive an `error` event on the stream. The run's `raw_events` audit log will record this. The run state machine will transition to `failed`. This is acceptable if the error event arrives; if Claude hangs instead (see issue #1920), the 30s watchdog must fire the transition.

**Issue #216 (MCP server errors after every turn):** The Crystal codebase shows `stravuMcpService.ts` and `mcpPermissionBridge.ts` — these are different from the new `CyboflowMcpServer`. But the pattern of MCP initialization errors leaking into per-turn output (issue #216) suggests Crystal's MCP infrastructure has noisy error propagation. The new `CyboflowMcpServer` startup errors need to be isolated to a dedicated error channel, not bleed into Claude's stdout/stderr.

**Sources:**
- [MCP stdio server persistent connection issue](https://github.com/modelcontextprotocol/servers/issues/2464) — confirms stdio transport must maintain persistent connection
- [stravu/crystal issue #216](https://github.com/stravu/crystal/issues/216) — MCP error noise per-turn
- Direct codebase audit: `main/src/services/mcpPermissionBridge.ts`, `main/src/services/stravuMcpService.ts`

---

### 8. `raw_events` Table Growth and Query Performance

**Scale estimation:** 100s of events per Claude run × 8 concurrent runs × 8 hours of self-hosted use:
- A typical Claude Code session generating tool calls: 20–50 events per turn, 10–30 turns = 200–1,500 events per run
- 8 concurrent runs × 8 hours at (conservatively) 30 events/min/run = 8 × 480 min × 30 = 115,200 events in a single workday

**WAL mode handles writes well** — inserts are sequential appends, WAL avoids write contention. Read performance is the risk: if the history view queries `raw_events` with `WHERE run_id = ? ORDER BY id DESC LIMIT 100`, this is fine with an index on `run_id`. A scan on `event_type` without an index is `O(n)` over 100k rows.

**Checkpoint starvation risk:** researched. If `raw_events` has 100k rows and the WAL file never gets checkpointed (because the app keeps reads open), the WAL file can grow unboundedly. `better-sqlite3` WAL mode auto-checkpoints at 1000 pages by default. With 100k insert-heavy rows, this triggers frequently but should not stall. The real risk is if a long-running query (e.g., full replay for history view) holds a read transaction open while writes accumulate — the WAL checkpoint waits for the reader to release. The WAL file grows. On the next app open, checkpoint blocks startup. **Mitigation: index `raw_events` on `(run_id, id)` and `(event_type, run_id)` from the schema migration, never do full-table scans.**

**Sources:**
- [SQLite WAL checkpoint starvation](https://loke.dev/blog/sqlite-checkpoint-starvation-wal-growth) — describes the WAL file growth issue
- [better-sqlite3 WAL performance docs](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/performance.md) — checkpoint strategies
- [SQLite event sourcing patterns](https://www.sqliteforum.com/p/event-sourcing-with-sqlite) — indexing for append-only event logs

---

### 9. tRPC v11 Subscription Memory Leak

**The risk:** tRPC v11 subscriptions have a confirmed memory leak (issue #6156) when emitting large strings through observables. The leak is in `getRawInput` processing and causes heap growth of ~450MB over a 5-minute stress test (195MB → 646MB with 100KB payloads every 100ms). The fix was merged in PR #6161.

**Cyboflow's exposure:** Stream-json events from Claude are variable size. Tool use payloads (file contents, bash commands) can be 10–100KB. At 60Hz subscription broadcast with 8 concurrent runs, the peak throughput is 8 × 60 × 50KB = 24MB/s through tRPC subscriptions. If the fix in #6161 is not included in the version of `@trpc/server` that Cyboflow pins, this is a memory exhaustion vector during the 1-day self-host bar.

**Mitigation:** Pin `@trpc/server` and `electron-trpc` to specific versions and verify the fix is included. The `electron-trpc` library (jsonnull) only recently added tRPC v11 support (PR #194 was pending as of research date). Consider using the `mat-sz/trpc-electron` fork which explicitly targets v11, or verify jsonnull's v11 compatibility status.

**Sources:**
- [tRPC issue #6156](https://github.com/trpc/trpc/issues/6156) — memory leak in v11 subscriptions
- [tRPC issue #6533](https://github.com/trpc/trpc/issues/6533) — streaming memory leak v11
- [electron-trpc v11 support PR](https://github.com/jsonnull/electron-trpc/pull/194) — v11 compatibility status

---

### 10. The 1-Day Self-Host Bar as Risk

**What the bar exposes that earlier testing won't:**

1. **Memory leaks in tRPC subscriptions** (see above) — surface after 2+ hours of active use
2. **WAL checkpoint stalls** — surface after 50k+ raw_events rows
3. **Zombie PTY processes** — `SimpleQueue.close()` abandons in-flight jobs; app quit while a session is starting leaves orphaned PTY. Crystal has zombie-process detection on boot but it is heuristic (finds processes matching the Claude binary path). If the zombie was only just spawned, it may not match the heuristic.
4. **Dock badge desync** — badge bound to `reviewQueueSlice.queue.length`. If a tRPC subscription drops and fails to reconnect (e.g., renderer reload), the queue length in the renderer goes stale. Badge shows 3 pending; queue shows 0. The user misses approvals.
5. **Mutex hang in `p-queue`:** The design calls for per-run `p-queue({concurrency: 1})`. If a job submitted to the queue itself awaits a queue slot for the same run (e.g., an approval handler that triggers a status-change that triggers another approval handler), the queue deadlocks. The `p-queue` documentation explicitly warns: "Avoid calling the same limit function inside a function that is already limited." This is a self-deadlock pattern that is easy to create accidentally in the orchestrator's state machine transitions.
6. **Power-loss durability:** `awaiting_review` runs on app power-loss (not clean shutdown). SQLite WAL mode ensures committed transactions survive. But if a transaction was in-flight (no `BEGIN IMMEDIATE` / `COMMIT` atomicity), the DB is clean but the run state may be inconsistent with the socket state. The design doc requires `BEGIN IMMEDIATE` co-writes for `awaiting_review` transitions — this must be verified in implementation.
7. **Crash recovery on reopen:** No design for "app reopens and finds stale `awaiting_review` rows." These runs have no live socket. Must be transitioned to `failed` at boot.

**Sources:**
- [p-queue self-deadlock warning](https://github.com/sindresorhus/p-queue) — README warns against recursive queue calls
- [Electron memory leak IPC](https://github.com/electron/electron/issues/27039) — IPC contextBridge memory patterns
- [node-pty zombie process pattern](https://github.com/microsoft/node-pty/issues/382) — PTY cleanup on window close

---

### 11. Renderer/Orchestrator Boundary Discipline

**The half-migrated state risk:** Crystal's existing IPC has direct DB writes scattered across IPC handlers. The design doc commits to "renderer never writes DB directly, all via tRPC." But Crystal's inherited `ipcMain.handle`-based handlers in `main/src/ipc/session.ts` (1,872 lines) and `main/src/ipc/git.ts` (1,391 lines) contain direct `databaseService` calls. The plan is to "not refactor what works" for inherited Crystal functionality and use tRPC only for new `cyboflow.*` routes.

**The risk:** Half-migrated state means two patterns coexist in the codebase. Claude Code agents will imitate the pattern they see most often. If the majority of IPC code uses direct `databaseService` calls, agents building new `cyboflow.*` features will follow that pattern and bypass the tRPC boundary. The architecture discipline degrades from day 1 without explicit pattern enforcement. **A lint rule or comment convention (`// @orchestrator-only-db-access`) is a minimal guard.**

**Bull import contamination:** `taskQueue.ts` imports Bull at the top level. This means any module that imports `TaskQueue` pulls in Bull's code. Bull's code references Redis connection strings. In a non-Redis environment (all Electron deployments), this is dead weight but also a potential ECONNREFUSED log noise if Bull's connection management code runs.

**Sources:**
- Direct codebase audit: `main/src/services/taskQueue.ts` line 1, `main/src/services/database.ts`

---

### 12. What the Doc Does Not Name

**Observability / stuck queue item UX:** If a run is in `running` state but Claude is idle (e.g., Claude issued a tool call but the approval event never arrived in the renderer due to a dropped tRPC subscription), the user has no affordance to diagnose or unstick it. There is no "why is this run stuck?" debug view. The 5-minute cross-run deadlock detector (`stuck` flag) helps, but only after 5 minutes. The 1-day self-host bar will surface this.

**DB file backup:** `~/.cyboflow/cyboflow.db` is the sole persistence store. No backup mechanism. A corrupt WAL (rare but possible on forced kill) leaves all run history unrecoverable. SQLite's WAL corruption on forced kill is very rare but non-zero. Minimum mitigation: copy the DB on clean shutdown to `cyboflow.db.bak`.

**Error boundaries in renderer:** The React renderer has no documented error boundaries around `<ReviewQueueView />` or `<PendingApprovalCard />`. A JavaScript exception in the queue UI (e.g., malformed approval data from a stream parser edge case) will unmount the entire React tree and show a blank white screen. The user cannot approve pending runs. The runs hang.

**tRPC subscription reconnect after renderer reload:** If the renderer reloads (e.g., developer hot-reload during development, or a crash recovery), existing tRPC subscriptions are torn down. The new renderer must re-subscribe and receive a full state snapshot — not just future events. If the subscription only delivers deltas, the new renderer's `reviewQueueSlice` starts empty and misses all in-flight approvals.

**Sources:**
- [React Error Boundaries](https://react.dev/reference/react/Component#catching-rendering-errors-with-an-error-boundary) — missing in inherited Crystal UI
- `Glob` for `ErrorBoundary` in frontend — found zero instances

---

## Recommendations

1. **Treat `PermissionManager` replacement as a day-1 mandatory task, not a week-2 task.** The existing implementation has no timeout and will hang indefinitely on app close while a permission is pending. The new `ApprovalRouter` must implement: 60-minute timeout with socket deny, `clearPendingForRun(runId)` that sends deny before PTY kill, and boot-time recovery that transitions stale `awaiting_review` rows to `failed`. This is the single highest-severity inherited bug that directly threatens the review queue differentiator.
   - Evidence: `permissionManager.ts` line 73 — bare Promise with no timeout or reject
   - Risk if ignored: Claude PTY hangs forever on app close, or after 60 minutes of user inactivity, permanently blocking the socket

2. **Execute the code-signing / notarization setup on day 1 or day 2, not at packaging time.** The inherited config has `hardenedRuntime: false` and `notarize: false`. Enabling notarization requires Apple Developer Program enrollment (24–48h), entitlements file creation, and `afterSign.js` replacement with a `notarytool` call. Debug iteration time on notarization rejections (5–30 min per submission) is a significant time sink if first attempted in week 2. Set up signing early so packaging is a known-good operation by Milestone 2.
   - Evidence: `package.json` lines 118–123 — `hardenedRuntime: false`, `notarize: false`
   - Risk if ignored: Milestone 2 produces an unsigned DMG that Gatekeeper blocks on first launch, which fails the self-host bar on a technicality

3. **Delete Bull from `taskQueue.ts` and `package.json` on day 1 of the crystal-cuts epic.** The import is live, the dependency is in production deps. Delete `import Bull from 'bull'`, remove the conditional Bull/SimpleQueue branches, keep only the `SimpleQueue` path. Remove `bull` from `package.json`. Also delete `WorktreeNameGenerator` usage in the task queue (the API-hop name generation that silently hangs offline).
   - Evidence: `taskQueue.ts` line 1; `package.json` `bull: "^4.16.3"`
   - Risk if ignored: Bull remains a transitive dependency; Redis connection noise; agents follow the dual-queue pattern in new code

4. **Index `raw_events(run_id, id)` and `raw_events(event_type, run_id)` in the initial schema migration.** Without indexes, a history view query over 100k rows is O(n). WAL checkpoint starvation from long-running reads will stall the app. Define these indexes in the migration that creates the `raw_events` table, not as an optimization retrofit.
   - Evidence: WAL checkpoint starvation research showing unbounded WAL growth under concurrent reads; estimated 100k+ events in a 1-day self-host session
   - Risk if ignored: History view queries progressively slower across the 1-day self-host bar; WAL file grows to 100MB+ causing startup delay on next open

5. **Add React error boundaries around `<ReviewQueueView />` and all queue card components.** A crash in the review queue UI is a product-fatal failure — the user cannot approve pending runs. A top-level error boundary that catches and renders a "Review queue error — restart app" message with the error details preserves the app's usability while the bug is diagnosed. This is a 30-minute implementation with outsized safety value.
   - Evidence: `Glob` for `ErrorBoundary` in `frontend/src/` — zero instances found
   - Risk if ignored: Any unhandled JavaScript exception in the queue view leaves the user unable to approve runs, with no recovery path except force-quitting the app

---

## Open Questions

- **Does the Apple Developer Program enrollment already exist?** ($99/yr) If not, 24–48h identity verification time must be budgeted before the first notarized build can be attempted. This question matters for milestone scheduling.

- **Which exact version of `electron-trpc` is targeted, and does it include the tRPC v11 subscription leak fix?** The `jsonnull/electron-trpc` v11 support was in-progress as of research. If using `mat-sz/trpc-electron` instead, that's a different package name and API surface — the roadmap should specify.

- **What is the plan for runs in `awaiting_review` at app boot?** The design doc does not specify boot-time recovery semantics. The Unix socket is gone. The options are: (a) transition to `failed` immediately, (b) attempt re-attach (impossible — socket path is ephemeral), (c) surface a "resume or abandon?" dialog. The roadmap should pick one; option (a) is the safest.

- **Is the `CyboflowMcpServer` subprocess restarted automatically on crash, or does the orchestrator surface a permanent error?** The design doc says it runs as a stdio subprocess from day 1 but does not specify restart policy. A crashloop (e.g., `CYBOFLOW_ORCH_SOCKET` is stale after orchestrator restart) should not silently fail — it should be surfaced and the subprocess should be restartable without full app restart.

- **What is the `p-queue` topology for transitions that trigger sub-transitions?** If `approve(runId)` → writes DB → transitions run to `running` → the running transition emits a `status-changed` event → the renderer's tRPC subscription triggers another DB read → that read path re-enters the per-run queue, is that safe? The per-run queue is for mutations only, but the event flow needs to be mapped to confirm no self-deadlock.

- **What observability does the user get for a stuck run?** The 5-minute cross-run deadlock detection flags a run as `stuck`, but how is it surfaced? Badge? Toast? Special card state? This UX decision should be made during queue UI design, not after the 1-day self-host bar reveals it's missing.

---

Sources:
- [stravu/crystal open issues](https://github.com/stravu/crystal/issues)
- [stravu/crystal issue #221 — Full Access mode hanging](https://github.com/stravu/crystal/issues/221)
- [stravu/crystal issue #216 — Error at end of each session](https://github.com/stravu/crystal/issues/216)
- [stravu/crystal issue #228 — Crystal unable to start Claude Code](https://github.com/stravu/crystal/issues/228)
- [Claude Code issue #1920 — missing result event, closed not planned](https://github.com/anthropics/claude-code/issues/1920)
- [tRPC issue #6156 — memory leak in v11 subscriptions](https://github.com/trpc/trpc/issues/6156)
- [tRPC issue #6533 — streaming memory leak v11](https://github.com/trpc/trpc/issues/6533)
- [electron-trpc v11 support PR #194](https://github.com/jsonnull/electron-trpc/pull/194)
- [mat-sz/trpc-electron fork for v11](https://github.com/mat-sz/trpc-electron)
- [electron-builder issue #3989 — hardened runtime crashes](https://github.com/electron-userland/electron-builder/issues/3989)
- [altool decommission — must use notarytool](https://github.com/electron/notarize/issues/189)
- [Electron native modules official docs](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules)
- [Electron 37.0.0 release notes](https://www.electronjs.org/blog/electron-37-0)
- [better-sqlite3 WAL performance docs](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/performance.md)
- [SQLite WAL checkpoint starvation deep dive](https://loke.dev/blog/sqlite-checkpoint-starvation-wal-growth)
- [SQLite event sourcing append-only design](https://www.sqliteforum.com/p/event-sourcing-with-sqlite)
- [p-queue self-deadlock warning](https://github.com/sindresorhus/p-queue)
- [node-pty zombie process cleanup](https://github.com/microsoft/node-pty/issues/382)
- [Kilian Valkhof — Notarizing Electron apps](https://kilianvalkhof.com/2019/electron/notarizing-your-electron-application/)
- [Electron notarize package](https://github.com/electron/notarize)
- [MCP stdio persistent connection issue](https://github.com/modelcontextprotocol/servers/issues/2464)
- [React Error Boundaries](https://react.dev/reference/react/Component#catching-rendering-errors-with-an-error-boundary)
