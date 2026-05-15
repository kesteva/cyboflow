---
id: TASK-353
sprint: SPRINT-009
epic: workflow-runs-and-day3-gate
status: done
summary: "Per-run .mcp.json writer (cyboflow-permissions server) + --strict-mcp-config plumbing in ClaudeCodeManager + RunLauncher invokes the writer post-worktree"
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-353 Done

## Outcome

- `McpConfigWriter.writeForRun({ runId, worktreePath, orchSocketPath, bridgeScriptPath, nodeExecutablePath })` writes a `.mcp.json` at the worktree root with one server `cyboflow-permissions` whose `command`/`args`/`env` block matches the bridge subprocess contract (argv `[bridgeScriptPath, runId, orchSocketPath]`; env `CYBOFLOW_RUN_ID`/`CYBOFLOW_ORCH_SOCKET`).
- `ClaudeSpawnOptions.strictMcpConfig?: boolean` (default `undefined` → off) added to `claudeCodeManager.ts`; `buildCommandArgs` appends `--strict-mcp-config` when the option is true. Crystal-session callers see no behavior change.
- `RunLauncher` constructor accepts four optional collaborators (`mcpConfigWriter`, `orchSocketProvider`, `bridgeScriptResolver`, `nodeResolver`); `launch()` invokes `writeForRun` after `createDeterministicWorktree` resolves, guarded so existing tests/callers without the collaborators are unaffected.

## Verification

- Vitest: 209/209 across 21 files; 5 new mcpConfigWriter tests + 1 new runLauncher ordering test.
- Typecheck: clean across `frontend`, `main`, `shared`.
- Lint: 0 errors.
- Visual: not_applicable (orchestrator/services/CLI plumbing only).

## Deferred

- FIND-SPRINT-009-3 (out-of-scope here) — silent-skip behavior in `RunLauncher.launch` when any of the four MCP collaborators is undefined; future epic 6 wiring task should make presence required (or assert all-or-none) before going to production.
- FIND-SPRINT-009-2 (still open) — orphan `workflow_runs` row if `writeForRun` throws between `createRun` and the status UPDATE; same lifecycle concern as TASK-352, even slightly widened. Right home is the IPC-wiring task.
- AC#4 has no automated test (grep-verified per plan). The SDK substrate doesn't currently consume the produced argv; this is an intentional forward-compat marker for a future PTY fallback path. TASK-355's day-3 gate is the integration tripwire.
