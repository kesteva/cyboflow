---
sprint: SPRINT-012
pending_count: 1
last_updated: "2026-05-16T00:00:00Z"
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
