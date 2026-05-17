---
sprint: SPRINT-012
pending_count: 3
last_updated: "2026-05-17T01:00:00.000Z"
---
# Findings Queue

## FIND-SPRINT-012-1
- **source:** TASK-453 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/mcpServer/cyboflowMcpServer.ts:181-282
- **description:** The three `CallToolRequestSchema` case branches duplicate identical response-handling scaffolding: `try { sendQuery → cast response as { ok, data?, error? } → if !ok return error content → return data content } catch → return error content`. Roughly 18 lines repeated 3 times. Additionally, the `as { ok: boolean; ... }` cast is unchecked — a malformed orchestrator response (missing `ok`) would route to the error branch with `error: undefined`, which `JSON.stringify` drops, yielding `{}` to Claude.
- **suggested_action:** Extract a small helper `async function executeMcpQuery(type, params): Promise<CallToolResult>` that performs the sendQuery + runtime-validated response narrowing + content wrapping. Each case branch then becomes the arg-guard + a single `return executeMcpQuery(...)`. Fixes both the duplication and the unchecked cast in one pass. Worth doing before any 4th tool is added (e.g., when scope re-opens beyond v1 read-mostly).
- **resolved_by:** 

## FIND-SPRINT-012-2
- **type:** scope_deviation
- **source:** TASK-454 (executor)
- **severity:** low
- **status:** resolved
- **location:** main/src/orchestrator/mcpServer/scriptPath.ts
- **description:** Created shared scriptPath.ts helper module as plan option (b) for asar extraction, so both McpServerLifecycle and claudeCodeManager can share the path-resolution logic without duplication.
- **resolved_by:** verifier — plan-prescribed: TASK-454 step 9 option (b) explicitly authorizes this helper module and the plan's `files_owned` already includes `main/src/orchestrator/mcpServer/scriptPath.ts` (line 10).

## FIND-SPRINT-012-3
- **source:** TASK-454 (verifier)
- **type:** bug
- **severity:** medium
- **status:** resolved
- **location:** main/src/orchestrator/mcpServer/mcpServerLifecycle.ts:73,182-204
- **description:** AC5 requires that after the lifecycle enters 'failed', a manual `stop()` then `start()` call is the recovery path. But neither `stop()` nor `start()` resets `restartAttempts`. After 'failed', `restartAttempts === 2`. Calling `stop()` then `start()` spawns once, and on the next non-zero exit the handler sees `restartAttempts < MAX_RESTARTS` → false → re-enters 'failed' immediately with no retry budget. The JSDoc on `start()` line 73 explicitly claims "Resets the restart counter so a manual start-after-failure is clean", but the implementation does not match. Either the doc is wrong (then AC5 manual-restart is degenerate) or the implementation should reset `restartAttempts = 0` at the top of `start()` when current status is not `'running'`. Recommended: reset `restartAttempts` to 0 in `start()` only when status is 'failed' or 'stopped' (i.e., not during the internal restart loop). The internal restart path calls `setTimeout(() => this.start(), delay)` and currently relies on `restartAttempts` being preserved across that call — a naive reset would break the retry-cap. A clean fix: a separate `manualStart()` public method, OR a private flag distinguishing internal vs manual entry.
- **suggested_action:** Decide whether the JSDoc or the code is authoritative. If manual recovery should work as documented, refactor `start()` to distinguish manual entry (resets counter) from internal restart entry (preserves counter). If manual recovery is not a v1 requirement, update the JSDoc to match the code and tighten the AC5 wording in a follow-up plan.
- **resolved_by:** TASK-454

## FIND-SPRINT-012-4
- **source:** TASK-454 (verifier)
- **type:** bug
- **severity:** medium
- **status:** resolved
- **location:** main/src/orchestrator/mcpServer/mcpServerLifecycle.ts:202-204
- **description:** `handleExit()` schedules a restart via `setTimeout(() => void this.start(), delay)` without storing the timer handle. If `stop()` is called while that timer is pending, the deferred `start()` will still fire after `stop()` returns and the subsequent spawn will live past the user-requested shutdown. The exit path of that orphan child will route through `handleExit` again; since `_status === 'stopped'` it will no-op (correct), but the subprocess will still have been spawned, the env vars allocated, the IPC socket attached, and a small race window exists where the lifecycle reports `'starting'/'running'` after `stop()`. For an Electron-quit shutdown this can prevent clean app exit if the new subprocess is mid-startup.
- **suggested_action:** Store the timer handle in a private field (`private restartTimer: NodeJS.Timeout | null`). Clear it at the top of `stop()` with `if (this.restartTimer) clearTimeout(this.restartTimer)`. Also reset `this.restartTimer = null` after the deferred start fires.
- **resolved_by:** TASK-454

## FIND-SPRINT-012-5
- **source:** TASK-454 (verifier)
- **type:** bug
- **severity:** low
- **status:** open
- **location:** main/src/services/panels/claude/claudeCodeManager.ts:425-453
- **description:** `composeMcpServers` resolves the node binary asynchronously (`void findNodeExecutable().then(...)`) and falls back to the literal string `'node'` for the FIRST call. In a packaged DMG on macOS without `node` on PATH (a common state — users open the .app, no shell login env), Claude Code spawns the cyboflow MCP entry with `command: 'node'` which fails the first time. The lifecycle manager itself awaits `findNodeExecutable()` before spawning (correct), but the per-session injection uses a fire-and-forget caching pattern that races with the first call.
- **suggested_action:** Either (a) make `composeMcpServers` async and await `findNodeExecutable()` on first call (mild refactor — `buildSdkOptions` already returns a Promise), or (b) populate `cachedNodePath` synchronously at boot by calling it from `setOrchSocketPath` (which is itself called once at boot — the orchestrator socket is known, so the fire-and-forget can happen there before any session starts).
- **resolved_by:** 

## FIND-SPRINT-012-6
- **source:** TASK-454 (verifier)
- **type:** claude-md
- **severity:** low
- **status:** open
- **location:** package.json:103-107
- **description:** The `asarUnpack` globs `main/dist/services/**/*.js` and `main/dist/orchestrator/mcpServer/**/*.js` do not match the actual tsc output layout, which produces `main/dist/main/src/services/**` and `main/dist/main/src/orchestrator/mcpServer/**` (note the extra `main/src/` segment from the include path in `main/tsconfig.json`). This was the existing pattern for `services/` — TASK-454 followed it verbatim per plan instruction — but the latent mismatch means either (a) electron-builder's glob matcher is more permissive than naive expansion, or (b) the asarUnpack rule has never actually unpacked anything in production. The packaged DMG smoke test in TASK-454 plan step 13 will surface this; until then, asar extraction at runtime is the actual fallback that makes the packaged path work via `fs.readFileSync` of the in-asar virtual path. A follow-up should validate whether asarUnpack matters at all for these subprocess scripts (since `scriptPath.ts` already extracts them on first use) or whether the glob should be tightened to `main/dist/main/src/services/**/*.js` and `main/dist/main/src/orchestrator/mcpServer/**/*.js`.
- **suggested_action:** Add a check (post-`pnpm run build:mac:arm64`) that the .app bundle contains both `Contents/Resources/app.asar.unpacked/main/dist/.../cyboflowMcpServer.js` and verify the asarUnpack glob actually unpacks it. If not, either (a) drop the entries (rely solely on the in-app asar-extraction path) or (b) fix the glob.
- **resolved_by:** 

## FIND-SPRINT-012-7
- **type:** scope_deviation
- **source:** TASK-455 (executor)
- **severity:** low
- **status:** resolved
- **location:** main/src/preload.ts
- **description:** TASK-455 cannot add getMcpHealth to contextBridge.exposeInMainWorld because main/src/preload.ts is owned by TASK-255. Mitigated by using window.electronAPI.invoke("cyboflow:mcp-health") in the useMcpHealth hook instead of a named binding. The type for getMcpHealth is added to frontend/src/types/electron.d.ts as an optional typed method that routes through the generic invoke. A future task can add the named binding to preload.ts when TASK-255 lands.
- **resolved_by:** verifier — no scope deviation occurred: preload.ts was NOT edited; the executor documented the intentional avoidance. AC5 explicitly allows `window.electronAPI (or the tRPC client when wired)` — invoke() satisfies that.

## FIND-SPRINT-012-8
- **type:** scope_deviation
- **source:** TASK-455 (executor)
- **severity:** low
- **status:** resolved
- **location:** main/src/orchestrator/mcpServer/mcpServerLifecycle.ts
- **description:** Required to meet AC (restartAttempts in getMcpServerStatus return shape). Added getRestartAttempts() public getter exposing the existing private restartAttempts field. Plan explicitly authorizes this one-line extension.
- **resolved_by:** verifier — plan-prescribed: plan step 1 explicitly authorizes adding `getRestartAttempts()` to McpServerLifecycle, treating it as the one acceptable cross-task readonly-violation. File is also listed in `files_owned` (line 11 of plan frontmatter).

## FIND-SPRINT-012-9
- **type:** scope_deviation
- **source:** TASK-455 (executor)
- **severity:** low
- **status:** resolved
- **location:** main/src/ipc/cyboflow.ts
- **description:** Added cyboflow:mcp-health ipcMain.handle to expose OrchestratorHealth.getMcpServerStatus() to the renderer as an interim IPC channel (per plan step 4) while tRPC ipcLink is not yet wired by the orchestrator epic.
- **resolved_by:** verifier — plan-prescribed: plan step 4 explicitly instructs adding the ipcMain.handle. File is listed in `files_owned` (line 12 of plan frontmatter).

## FIND-SPRINT-012-10
- **type:** scope_deviation
- **source:** TASK-455 (executor)
- **severity:** low
- **status:** resolved
- **location:** frontend/src/types/electron.d.ts
- **description:** Added getMcpHealth optional typed method to ElectronAPI interface. The actual named binding in preload.ts cannot be added (owned by TASK-255), so the hook uses window.electronAPI.invoke() instead. The type annotation documents intent and aids IDE completion.
- **resolved_by:** verifier — plan-prescribed: plan step 7 explicitly instructs extending the electronAPI type definitions; file is listed in `files_owned` (line 13 of plan frontmatter).
