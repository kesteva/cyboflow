---
sprint: SPRINT-012
pending_count: 10
last_updated: "2026-05-17T01:30:00.198Z"
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

## FIND-SPRINT-012-11
- **source:** SPRINT-012 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/ipc/cyboflow.ts:43-55, main/src/orchestrator/trpc/routers/health.ts:20-29
- **description:** Duplicate OrchestratorHealth singleton-injection setters with duplicate fallback constants — `setCyboflowHealth` (in ipc/cyboflow.ts) and `setHealthProvider` (in trpc/routers/health.ts) each store their own module-level `_orchestratorHealth | _health` reference for the same instance, AND each inlines the same fallback `{ status: starting, restartAttempts: 0 }`. At app bootstrap the integrator must remember to call BOTH setters or the IPC channel and tRPC procedure will return divergent snapshots (one real, one frozen-yellow). Neither is wired today, so the divergence is silent.
- **suggested_action:** Pick one source of truth: either (a) construct `OrchestratorHealth` in `cyboflow.ts` and pass it to `setHealthProvider` from the same call site, OR (b) push the singleton into the shared services bag (`AppServices` / DI) and have both consumers read it from there. Also extract the `HEALTH_STARTING` constant to `shared/types/mcpHealth.ts` so both files import the same default.
- **resolved_by:** 







Suspected tasks: TASK-455

## FIND-SPRINT-012-12
- **source:** SPRINT-012 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** package.json:103-106, main/src/orchestrator/mcpServer/scriptPath.ts:39-63
- **description:** Redundant asar handling — TASK-454 added BOTH `main/dist/orchestrator/mcpServer/**/*.js` to `asarUnpack` AND the runtime extraction-to-~/.cyboflow branch in `scriptPath.ts`. Because `scriptPath.ts` itself lives inside `.asar` (it is not in asarUnpack), `__dirname` resolves to an `.asar`-internal path at runtime, the extraction branch runs unconditionally, and the asarUnpack copy is never read — it just adds disk bloat to the packaged app. Additionally, the extraction comment says it is `overwritten on every call` so updates are picked up — but there is no first-call cache, so every `composeMcpServers()` / `_spawn()` call re-extracts.
- **suggested_action:** Pick one approach: either (a) drop the asarUnpack entry and keep the extract-to-~/.cyboflow flow (current effective behaviour), OR (b) drop the extraction logic and switch `scriptPath.ts` to resolve `process.resourcesPath + /app.asar.unpacked/main/dist/orchestrator/mcpServer/cyboflowMcpServer.js` when `app.isPackaged`. Option (b) is the standard electron-builder pattern and avoids both disk-copy and the `~/.cyboflow` write entirely.
- **resolved_by:** 






Suspected tasks: TASK-454

## FIND-SPRINT-012-13
- **source:** SPRINT-012 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/orchestrator/mcpServer/scriptPath.ts:43-58
- **description:** `resolveMcpServerScriptPath()` does three sync filesystem syscalls (`readFileSync` + `mkdirSync` + `writeFileSync` + `chmodSync`) on every call when packaged, and the function is called once per claude-session spawn from `claudeCodeManager.composeMcpServers()` AND once per MCP-subprocess `_spawn()` call. With N parallel cyboflow workflow sessions this becomes N × 3+ sync syscalls on the main process. There is no first-call cache — the comment explicitly says the file is overwritten every call.
- **suggested_action:** Memoize the resolved path inside the module: on first call extract and store, on subsequent calls return the cached absolute path. If overwrite-on-update is desired, key the cache on the source mtime/sha so an updated DMG triggers re-extraction once per app launch, not per session spawn.
- **resolved_by:** 





Suspected tasks: TASK-454

## FIND-SPRINT-012-14
- **source:** SPRINT-012 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/orchestrator/trpc/routers/health.ts:20-49, main/src/ipc/cyboflow.ts:29-55
- **description:** New singleton-injection idiom introduced in two places, conflicting with the existing tRPC router convention. Sibling routers `runs.ts`, `approvals.ts`, `workflows.ts`, `events.ts` use the `throwNotImplemented`-stub pattern with no module-level mutable state. TASK-455 introduces `let _health: OrchestratorHealth | null = null; export function setHealthProvider(...)` in `routers/health.ts` AND mirrors the same pattern in `ipc/cyboflow.ts`. This is a documented-convention-drift: future routers will face an ambiguous choice between the two patterns.
- **suggested_action:** Either (a) document the new injection pattern in `docs/CODE-PATTERNS.md` with explicit guidance on when to use it vs. `AppServices`-injection, OR (b) refactor `health.ts` to receive the OrchestratorHealth via `ctx` / a router factory function so it matches the dependency-injection pattern used by services elsewhere (e.g. `WorkflowRegistry` in `cyboflow.ts` reads from `services`). Decide before any further router-with-state is added.
- **resolved_by:** 




Suspected tasks: TASK-455

## FIND-SPRINT-012-15
- **source:** SPRINT-012 (sprint-code-reviewer)
- **type:** bug
- **severity:** low
- **status:** open
- **location:** main/src/services/panels/claude/claudeCodeManager.ts:432-455
- **description:** `composeMcpServers()` fire-and-forget `findNodeExecutable()` cache silently degrades the first cyboflow MCP injection. The function is synchronous, so it falls back to the bare string `node` for the very first session and kicks off `void findNodeExecutable().then(...)` to populate `cachedNodePath` for the *next* call. In `pnpm dev` under nvm/asdf where `PATH` may not include a Node binary that `spawn(node, ...)` can find without the shell-PATH enrichment, the first sessions cyboflow MCP server will fail to spawn. Subsequent sessions get the resolved path and work.
- **suggested_action:** Resolve `cachedNodePath` eagerly at `setOrchSocketPath()` time (the boot moment when the socket is wired) so it is always populated before any session spawns. Drop the fire-and-forget pattern. If `findNodeExecutable()` rejects, log and refuse to inject the cyboflow entry rather than silently shipping a broken `node` fallback.
- **resolved_by:** 



Suspected tasks: TASK-454

## FIND-SPRINT-012-16
- **source:** SPRINT-012 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/mcpServer/mcpQueryHandler.ts:180-203, main/src/orchestrator/mcpServer/mcpServerLifecycle.ts:41-52
- **description:** `mcp-submit-checkpoint` writes `raw_events.run_id = msg.runId` where `msg.runId` is whatever the subprocess passes (sourced from `CYBOFLOW_RUN_ID` env). For the singleton `McpServerLifecycle` spawn the env value is the sentinel string `orchestrator`, so every singleton-side checkpoint lands with `run_id=orchestrator` — a value with no corresponding row in `workflow_runs`. The `raw_events` table has no FK constraint, so the insert succeeds and creates a synthetic-run-id namespace that future readers/joiners must filter out manually.
- **suggested_action:** Either (a) document `orchestrator` as a reserved run_id in `migration 006_cyboflow_schema.sql` and update any raw_events readers to handle it, OR (b) have the orchestrator-side handler reject `mcp-submit-checkpoint` when `runId === orchestrator` (return `ok: false, error: checkpoint_requires_real_run`) so callers must opt into a real workflow run before writing.
- **resolved_by:** 


Suspected tasks: TASK-453, TASK-454

## FIND-SPRINT-012-17
- **source:** SPRINT-012 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/mcpServer/mcpQueryHandler.ts:116-178
- **description:** Cross-run data exposure is intentional but undocumented in the spec. `cyboflow_list_pending_approvals` returns approvals across *all* workflow runs (no `WHERE run_id = ?` filter), and `cyboflow_get_run` accepts any `targetRunId` regardless of the caller subprocesss own `runId`. The tool descriptions in `cyboflowMcpServer.ts` say `cross-run review queue` and `by ID`, so the wide read scope is by-design — but `docs/cyboflow_system_design.md` does not currently call out this trust boundary, which means a future contributor could narrow either tools SELECT thinking its a bug, breaking the day-3 review-queue UX.

Suspected tasks: TASK-452, TASK-453
- **suggested_action:** Add a `## Trust boundaries` subsection to `docs/cyboflow_system_design.md` (or `docs/ARCHITECTURE.md`) documenting that the cyboflow MCP server treats the local Unix socket as a trusted channel and that `mcp-list-pending-approvals` + `mcp-get-run` return data across the entire workspace by design. Reference this from the inline JSDoc on both handler methods so future reviewers dont mistake the wide scope for a missing filter.
- **resolved_by:** 
