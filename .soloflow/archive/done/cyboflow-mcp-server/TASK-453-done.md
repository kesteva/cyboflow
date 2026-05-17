---
id: TASK-453
sprint: SPRINT-012
epic: cyboflow-mcp-server
status: done
summary: "Replaced not_implemented CallTool stub with three real MCP tool handlers, tightened input schemas, added 30s sendQuery timeout."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: not_applicable
---

# TASK-453 Done Report

Wired the three Cyboflow MCP tools to `sendQuery()` calls into the orchestrator's `McpQueryHandler`:

- `cyboflow_list_pending_approvals` → `sendQuery('mcp-list-pending-approvals', {})`
- `cyboflow_get_run` → type-guards `run_id: string`, then `sendQuery('mcp-get-run', { targetRunId: run_id })`
- `cyboflow_submit_checkpoint` → type-guards `label: string` and optional `note: string`, then `sendQuery('mcp-submit-checkpoint', { label, note? })`

`sendQuery()` now has a 30s timeout via `setTimeout` inside the promise body — on expiry the `requestId` is deleted from `pendingRequests` and the promise rejects with `'orchestrator_timeout'`. Timer is cleared on both resolve and explicit reject paths to prevent zombie timers.

Tool input schemas tightened from TASK-451 placeholders to final shapes (`required: ['run_id']`, `required: ['label']`). Tool descriptions written for Claude's reasoning. Default case in the CallTool switch throws `Unknown tool: ...` for SDK-handled MCP errors, matching `mcpPermissionServer.ts` pattern.

Argument validation produces structured MCP error responses (`{ content: [{ type: 'text', text: JSON.stringify({ error: 'invalid_arguments', expected: ... }) }] }`) rather than throwing, so Claude can reason about bad inputs conversationally. Each tool branch is wrapped in try/catch — `sendQuery` rejections (timeout, socket closed, orchestrator `ok:false`) convert to MCP error responses without crashing the subprocess.

Code review CLEAN with one minor finding queued (FIND-SPRINT-012-1: three case branches in CallToolRequestSchema duplicate scaffolding — bounded blast radius, queued for compound). Test-writer: NO_TESTS_NEEDED per plan; behavior coverage lives on the orchestrator query handler side and the upcoming TASK-454 lifecycle integration.

Commit: `0599f21 feat(TASK-453): implement three MCP tool surfaces with 30s timeout`.
