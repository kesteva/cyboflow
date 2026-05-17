---
id: TASK-454
sprint: SPRINT-012
epic: cyboflow-mcp-server
status: done
summary: "Wired Cyboflow MCP subprocess lifecycle (spawn, stderr routing, asar extraction, bounded auto-restart) and injected cyboflow MCP server into per-session .mcp.json."
executor_loops: 0
code_review_rounds: 1
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-454 Done Report

Wired the Cyboflow MCP subprocess into the orchestrator lifecycle, plus the per-session .mcp.json injection that lets Claude actually see the new tools.

**New `McpServerLifecycle` class** (`main/src/orchestrator/mcpServer/mcpServerLifecycle.ts`):

- Spawns `cyboflowMcpServer.js` via `child_process.spawn` with `stdio: ['pipe', 'pipe', 'pipe']` so stderr can be captured.
- Injects `CYBOFLOW_RUN_ID` and `CYBOFLOW_ORCH_SOCKET` via env (singleton uses sentinel `'orchestrator'` for the run ID — per-session injection in claudeCodeManager uses the actual session ID).
- Line-by-line stderr forwarding to the injected `LoggerLike` with `[Cyboflow MCP]` prefix; stdout is intentionally untouched (it is the MCP SDK's JSON-RPC stream).
- Bounded auto-restart: 2 attempts at 1s and 5s backoff, then `'failed'`. After fix round, `start()` resets the budget for manual recovery and `_spawn()` is the internal retry path that preserves it.
- `stop()` sends SIGTERM, waits up to 2s, escalates to SIGKILL. Also clears any pending restart timer to prevent ghost spawns when stop fires during the backoff window.

**Shared script-path helper** (`main/src/orchestrator/mcpServer/scriptPath.ts`, plan option (b)):

`resolveMcpServerScriptPath()` returns the dev-mode dist path or extracts the script from `.asar` to `~/.cyboflow/cyboflowMcpServer.js` on first run (pattern lifted from `claudeCodeManager.ts:700-723`). Both the lifecycle's spawn and `claudeCodeManager`'s .mcp.json injection consume the helper, so packaged DMGs see a consistent path.

**`claudeCodeManager.ts` modification:**

- Adds `orchSocketPath`/`cachedNodePath` fields + `setOrchSocketPath()` setter.
- `composeMcpServers()` now writes a `cyboflow` MCP server entry alongside `crystal-permissions`, env-injected with `CYBOFLOW_RUN_ID` (sessionId) and `CYBOFLOW_ORCH_SOCKET`. Skipped when `orchSocketPath` is unset (during the integration ramp).

**`package.json`:**

- Added `main/dist/orchestrator/mcpServer/**/*.js` to `build.asarUnpack` so the script is extractable from the packaged DMG.

**Tests** (`main/src/orchestrator/mcpServer/__tests__/mcpServerLifecycle.test.ts`):

8 hermetic vi.mock-based tests covering the three plan-designated targets (restart state machine, stderr→logger, stop SIGTERM/SIGKILL) plus three regression guards added during code review (budget reset after manual recovery, whitespace-only stderr suppression, mid-backoff stop cancels pending restart). 246/246 main tests pass.

**Code review round 1 surfaced 2 medium state-machine bugs:**
- FIND-SPRINT-012-3: stop() then start() didn't reset restartAttempts despite JSDoc claim. Resolved in commit 84f25bd via start() / _spawn() split.
- FIND-SPRINT-012-4: pending backoff timer survived stop(). Resolved in same commit by storing `restartTimer` handle and clearing it in stop().

**Findings remaining open** (not fixed here, queued for compound / TASK-455 / manual smoke):
- FIND-SPRINT-012-1 (TASK-453 carryover): duplicate scaffolding in 3 CallTool branches — bounded blast radius.
- FIND-SPRINT-012-5: nodeCmd is cached lazily in `composeMcpServers`; eager population via `setOrchSocketPath` is a cleaner TASK-455 hook.
- FIND-SPRINT-012-6: asarUnpack glob may not match real dist layout — mitigated by runtime in-process extraction; surface at manual DMG smoke.

Commits: `8d3aedd feat(TASK-454): MCP subprocess lifecycle with asar extraction and auto-restart`, `84f25bd fix(TASK-454): correct restart counter reset and clear pending timer on stop`.

Verifier APPROVED both rounds. Code reviewer CLEAN on round 2. Test-writer: NO_TESTS_NEEDED (existing 8 tests cover all plan targets + 3 regression guards).
