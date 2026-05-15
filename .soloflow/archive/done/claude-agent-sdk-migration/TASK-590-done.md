---
id: TASK-590
sprint: SPRINT-008
epic: claude-agent-sdk-migration
status: done
summary: "Rewrite claudeCodeManager.ts: PTY+stream-json → @anthropic-ai/claude-agent-sdk in-process query(); all 8 parity options wired; PreToolUse hook routes through ApprovalRouter; inline mcpServers."
executor_loops: 0
code_review_rounds: 1
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-590 — Rewrite claudeCodeManager.ts to use SDK query()

## Outcome

The Claude panel's substrate is now `@anthropic-ai/claude-agent-sdk` in-process, not a `claude -p` subprocess. `main/src/services/panels/claude/claudeCodeManager.ts` was rewritten end-to-end (769 lines removed, 412 added across two commits): PTY-spawn + stream-json parser pipeline (parser/lineBufferer/jsonParser/completionDetector) replaced by an `await for` iterator over `query()`. All 8 parity-verified SDK options are passed: `cwd`, `includePartialMessages: true`, `systemPrompt: { type: 'preset', preset: 'claude_code', append }`, `mcpServers` (inline object literal — no temp file), `env` (spread `process.env` + `CYBOFLOW_RUN_ID` + optional `MCP_DEBUG`), conditional `model` (omit when `'auto'`), conditional `resume` (when `isResume`), and `hooks.PreToolUse` (conditionally omitted when `permissionMode === 'ignore'` to match pre-task bridge-skip behavior). PreToolUse hook routes through `ApprovalRouter.getInstance().requestApproval(panelId, ...)` and maps `ApprovalDecision` to the SDK's `hookSpecificOutput` shape with fail-closed deny on errors. Inheritance with `AbstractCliManager` preserved per plan §2 — PTY-touching methods overridden, stub `CliProcess` keeps `isPanelRunning`/`getAllProcesses` working.

## Files changed

- `main/src/services/panels/claude/claudeCodeManager.ts` — full rewrite (commits ce9aefe + 57bddbf)

## Verification

- `pnpm typecheck` (main/ + repo root): PASS
- Verifier (round 1): APPROVED — 12/12 ACs
- Code-reviewer (round 1): IMPROVEMENTS_NEEDED with 3 Important findings
- Round 2 fixes (commit 57bddbf):
  1. `composeRunEnv` now spreads `process.env` first (was stripping PATH/HOME/USER/NODE_PATH from SDK-spawned child processes)
  2. `hooks.PreToolUse` conditionally omitted when `permissionMode === 'ignore'` (previously silently dropped — every tool call would have gone through ApprovalRouter regardless of user opt-out)
  3. Approval cleanup aligned to `panelId` — `clearPendingForRun(panelId)` matches `requestApproval(panelId, ...)` filing; resolved FIND-SPRINT-008-4
- Verifier (round 2): APPROVED — 12/12 ACs still met
- Code-reviewer (round 2): CLEAN

## Known acceptable deferrals

- Sibling tests (`claudeCodeManagerWiring.test.ts`, `claudeCodeManagerPermissions.test.ts`) intentionally land RED — they assert PTY-spawn behavior that is gone. Test rewrite is TASK-594's scope.
- FIND-SPRINT-008-2 (MCP server type cast narrowing — low severity)
- FIND-SPRINT-008-3 (`killProcess` early-return skips approval cleanup when no run is active — low severity, defensive path)

## Forward references

- TASK-591 (T5) — delete `main/build-cyboflow-permission-bridge.js` and the cyboflow-permissions MCP server; the PreToolUse hook is now the in-process replacement.
- TASK-592 (T6) — delete the legacy stream-json parser modules (lineBufferer/jsonParser/streamParser/completionDetector) now that no consumer references them.
- TASK-593 (T7) — re-wire eventRouter/messageProjection/rawEventsSink to consume SDK SDKMessage stream directly (this task forwards via `output` events; T7 settles the typed-event pipeline).
- TASK-594 (T8) — rewrite the two broken sibling test files against the settled SDK substrate.
