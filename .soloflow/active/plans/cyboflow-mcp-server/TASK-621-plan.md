---
id: TASK-621
idea: null
status: in-flight
created: "2026-05-16T00:00:00Z"
files_owned:
  - main/src/orchestrator/mcpServer/cyboflowMcpServer.ts
files_readonly:
  - main/src/orchestrator/mcpServer/mcpQueryHandler.ts
acceptance_criteria:
  - criterion: "An async helper executeMcpQuery(type, params): Promise<CallToolResult> is defined above the CallTool registration."
    verification: "grep -n 'async function executeMcpQuery' main/src/orchestrator/mcpServer/cyboflowMcpServer.ts returns exactly 1 match"
  - criterion: "No unchecked `as { ok: boolean; ... }` cast remains."
    verification: "grep -nE 'as \\{ ok: boolean' main/src/orchestrator/mcpServer/cyboflowMcpServer.ts returns 0 matches"
  - criterion: All three CallTool branches end in `return executeMcpQuery(...)`; no per-branch await sendQuery / try-catch remains in the registration.
    verification: "grep -nE 'await sendQuery\\(' main/src/orchestrator/mcpServer/cyboflowMcpServer.ts returns 0 matches; grep -nc 'return executeMcpQuery' main/src/orchestrator/mcpServer/cyboflowMcpServer.ts returns 3"
  - criterion: "Malformed orchestrator response (missing 'ok' field or non-object) produces a meaningful error string — not the empty object {}."
    verification: "grep -n 'invalid_orchestrator_response' main/src/orchestrator/mcpServer/cyboflowMcpServer.ts returns ≥1 match"
  - criterion: pnpm typecheck and pnpm lint pass.
    verification: pnpm typecheck exits 0; pnpm lint exits 0
  - criterion: Full main test suite continues to pass (no test files import from cyboflowMcpServer.ts; mocked-string usages unchanged).
    verification: pnpm --filter main test exits 0
depends_on: []
estimated_complexity: low
epic: cyboflow-mcp-server
test_strategy:
  needed: false
  justification: "cyboflowMcpServer.ts is an isolated stdio subprocess excluded from unit-test coverage by design (TASK-453 done report). Sibling tests in mcpServer/__tests__/ test parent-process code, do not import from this file, and reference it only as a mocked string path. The malformed-response correctness invariant is small enough that an inline runtime type-guard plus typecheck/lint gates suffice; behavioral coverage of the query types lives in mcpQueryHandler.test.ts."
---
# TASK-621: Extract executeMcpQuery helper to deduplicate three MCP tool branches

## Objective

The three `CallToolRequestSchema` branches in `cyboflowMcpServer.ts` (lines 184-200, 216-232, 258-276) each duplicate ~9 lines of sendQuery → unchecked cast → ok-branch → JSON.stringify scaffold. The `as { ok: boolean; data?: unknown; error?: string }` cast is unchecked — a malformed response with no `error` field yields `JSON.stringify({ error: undefined }) === '{}'`, sending Claude an empty object. Extract a single helper that runtime-validates the response shape. Resolves FIND-1.

## Implementation Steps

1. **Add type-only import** at the top of `cyboflowMcpServer.ts`:
   ```ts
   import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
   ```

2. **Define helper above the `setRequestHandler(CallToolRequestSchema, ...)` registration**:
   ```ts
   async function executeMcpQuery(
     type: string,
     params: Record<string, unknown>,
   ): Promise<CallToolResult> {
     try {
       const response = await sendQuery(type, params);
       if (
         typeof response !== 'object' ||
         response === null ||
         !('ok' in response) ||
         typeof (response as { ok: unknown }).ok !== 'boolean'
       ) {
         return { content: [{ type: 'text', text: JSON.stringify({ error: 'invalid_orchestrator_response' }) }] };
       }
       const resp = response as { ok: boolean; data?: unknown; error?: string };
       if (!resp.ok) {
         const errorText = typeof resp.error === 'string' && resp.error.length > 0
           ? resp.error
           : 'orchestrator_error';
         return { content: [{ type: 'text', text: JSON.stringify({ error: errorText }) }] };
       }
       return { content: [{ type: 'text', text: JSON.stringify(resp.data) }] };
     } catch (error) {
       const message = error instanceof Error ? error.message : String(error);
       return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }] };
     }
   }
   ```

3. **Collapse the three case branches**. Each branch's `try/catch` block becomes a single `return executeMcpQuery(...)`:
   - `cyboflow_list_pending_approvals`: `return executeMcpQuery('mcp-list-pending-approvals', {});`
   - `cyboflow_get_run`: keep the `run_id` type-guard; replace the try/catch with `return executeMcpQuery('mcp-get-run', { targetRunId: run_id });`
   - `cyboflow_submit_checkpoint`: keep the `label` + `note` guards; replace the try/catch with `return executeMcpQuery('mcp-submit-checkpoint', queryParams);` where `queryParams` is built conditionally.

4. **Verify** — typecheck, lint, full test suite pass. The two sibling test files in `mcpServer/__tests__/` do not import from this file and reference it only as a mock string path; they should remain green.

## Hardest Decision

Hand-rolled runtime guard (chosen) vs Zod schema vs minimal `'ok' in response` check. The hand-rolled guard matches the existing JSON-parse pattern at line 81, fixes both the duplication AND the empty-error bug, and adds no new dependencies. Zod is overkill for one structural shape.

## Lowest Confidence Area

The `CallToolResult` return type from `@modelcontextprotocol/sdk/types.js@1.16.0` may have stricter shapes than expected. If typecheck fails, fall back to the narrower inline shape `Promise<{ content: Array<{ type: 'text'; text: string }> }>` — same runtime behavior, only the static annotation changes.
