---
id: TASK-452
sprint: SPRINT-012
epic: cyboflow-mcp-server
status: done
summary: "Added McpQueryHandler routing three MCP message types to SQL queries against approvals, workflow_runs, and raw_events with newline-framed JSON responses."
executor_loops: 0
code_review_rounds: 1
visual_mobile: skipped_user_preference
visual_web: not_applicable
---

# TASK-452 Done Report

Created `main/src/orchestrator/mcpServer/mcpQueryHandler.ts` and `main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts`. The handler routes three MCP message types:

- `mcp-list-pending-approvals` → `SELECT id, run_id, tool_name, tool_input_json, created_at FROM approvals WHERE status = 'pending' ORDER BY created_at ASC`
- `mcp-get-run` → `SELECT * FROM workflow_runs WHERE id = ?`; missing rows return `{ ok: false, error: 'not_found' }`
- `mcp-submit-checkpoint` → single INSERT into `raw_events` with `event_type = 'cyboflow_checkpoint'`; no write to `workflow_runs.status`

Column names adapted from the plan to match migration `006_cyboflow_schema.sql` (`tool_input_json` / `payload_json`). Constructor takes the narrow `DatabaseLike` interface from `main/src/orchestrator/types.ts` to preserve the orchestrator's standalone-typecheck boundary (no `better-sqlite3` import in orchestrator-land).

Code-review round 1 caught a wire-protocol framing mismatch: `writeResponse` wrote bare JSON without a trailing `\n`, while the TASK-451 subprocess client uses newline-delimited parsing. Fix in commit 6ea7f45 appended `\n`, removed redundant inner try/catch (outer handles), dropped `async` from synchronous handlers, added `console.warn` on malformed `tool_input_json`, and added four `endsWith('\n')` assertions in the test suite (one per response code path).

Wiring into the orchestrator's socket dispatch loop lands in TASK-454 — this task delivers the handler class + tests only.

Commits: `609e56b feat(TASK-452): add McpQueryHandler for orchestrator-side MCP query routing`, `6ea7f45 fix(TASK-452): newline-framed responses to match subprocess wire protocol`.

Verifier APPROVED both rounds. Code reviewer CLEAN on round 2. Test-writer: NO_TESTS_NEEDED (all 4 plan targets already covered by 9 executor-written tests; 238/238 main suite passes).
