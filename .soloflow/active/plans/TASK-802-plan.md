---
id: TASK-802
idea: IDEA-029
status: ready
created: 2026-05-29T00:00:00Z
source: IDEA-029
epic: mcp-runtime-step-tracking
files_owned:
  - main/src/orchestrator/mcpServer/cyboflowMcpServer.ts
  - main/src/orchestrator/mcpServer/mcpQueryHandler.ts
  - main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts
files_readonly:
  - main/src/orchestrator/stepTransitionBridge.ts
  - main/src/orchestrator/types.ts
  - shared/types/workflows.ts
  - main/src/orchestrator/__tests__/stepTransitionBridge.test.ts
  - main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts
  - main/src/orchestrator/__test_fixtures__/dbAdapter.ts
  - main/src/orchestrator/__test_fixtures__/loggerLikeSpy.ts
acceptance_criteria:
  - criterion: "cyboflowMcpServer.ts registers a `cyboflow_report_step` tool in the ListTools response with inputSchema { step_id: string (required), status?: 'running'|'done' } and NO run_id property; its description states it is OBSERVATIONAL and does not pause the run or change run status."
    verification: "grep -n \"cyboflow_report_step\" main/src/orchestrator/mcpServer/cyboflowMcpServer.ts shows the tool name, a required: ['step_id'] entry, and a description containing 'OBSERVATIONAL' (case-insensitive); the schema has no run_id property."
  - criterion: "The CallTool switch in cyboflowMcpServer.ts has a `case 'cyboflow_report_step'` that rejects a non-string step_id with { error: 'invalid_arguments' }, rejects a status that is neither 'running' nor 'done', and otherwise calls executeMcpQuery('mcp-report-step', { stepId, status })."
    verification: "grep -n \"mcp-report-step\" main/src/orchestrator/mcpServer/cyboflowMcpServer.ts shows the executeMcpQuery dispatch inside the new case; pnpm typecheck passes."
  - criterion: "The McpQueryMessage union in mcpQueryHandler.ts includes a `{ type: 'mcp-report-step'; requestId; runId; stepId: string; status?: 'running' | 'done' }` member, and handleMessage dispatches it to a handleReportStep() method (exhaustiveness preserved)."
    verification: "grep -n \"mcp-report-step\" main/src/orchestrator/mcpServer/mcpQueryHandler.ts shows the union member and the dispatch case; pnpm typecheck passes."
  - criterion: "handleReportStep() returns ok:false 'report_step_requires_real_run' when runId === 'orchestrator' (mirroring the checkpoint guard) and performs no DB write."
    verification: "Unit test asserts a 'mcp-report-step' message with runId='orchestrator' yields ok:false with error 'report_step_requires_real_run' and current_step_id stays NULL."
  - criterion: "handleReportStep() JOINs workflows for the run's name, validates stepId against the flat step ids of WORKFLOW_DEFINITIONS[name], and returns ok:false 'unknown_step_id' (with NO current_step_id write) when stepId is not a known step."
    verification: "Unit test asserts that an invalid stepId for a run whose workflow name is 'sprint' yields ok:false error 'unknown_step_id' and current_step_id is unchanged."
  - criterion: "On a valid stepId, handleReportStep() calls buildStepTransitionEvent(runId, stepId, status, db, undefined) and returns ok:true; the DB current_step_id is updated and exactly one transition event is emitted."
    verification: "Unit test asserts a valid stepId='write-tests' status='running' for a 'sprint' run yields ok:true, current_step_id === 'write-tests', and stepTransitionEvents emits exactly once."
  - criterion: "handleReportStep() returns ok:false when no workflow_runs row matches runId (run vanished) without throwing."
    verification: "Unit test asserts a 'mcp-report-step' message for a non-existent runId yields ok:false ('run_not_found' or 'unknown_step_id' per the JOIN-miss path) and does not throw."
  - criterion: "The full unit suite is green."
    verification: "pnpm test:unit exits 0."
depends_on: [TASK-798, TASK-801]
estimated_complexity: medium
test_strategy:
  needed: true
  justification: "New handler with several decision branches (orchestrator guard, run-not-found, unknown stepId, valid stepId) plus a new tool surface. IDEA-029 slice 6 explicitly requires these mcpQueryHandler unit cases; the test file is created here."
  targets:
    - behavior: "runId==='orchestrator' guard returns ok:false 'report_step_requires_real_run', no write"
      test_file: "main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts"
      type: unit
    - behavior: "valid stepId -> ok:true + current_step_id write + exactly one emit"
      test_file: "main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts"
      type: unit
    - behavior: "invalid stepId for a known workflow -> ok:false 'unknown_step_id' + no write"
      test_file: "main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts"
      type: unit
    - behavior: "missing workflow_runs row -> ok:false + no throw"
      test_file: "main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts"
      type: unit
---

# Add cyboflow_report_step MCP tool and validated McpQueryHandler handler

## Objective

Expose an OBSERVATIONAL `cyboflow_report_step` MCP tool that lets the running orchestrating session report workflow phase transitions, and back it with an orchestrator-side `handleReportStep()` that validates the step id against the run's workflow definition before writing `current_step_id`. The tool and handler mirror the existing `cyboflow_submit_checkpoint` pattern (env-bound `CYBOFLOW_RUN_ID`, write-only, fail-soft try/catch, exhaustive union dispatch). This is the actual step-progress signal that drives the Workflow Progress panel; an unknown step id must be rejected with `unknown_step_id` and produce zero DB corruption.

## Implementation Steps

### A. Tool surface — `cyboflowMcpServer.ts`

1. In the `ListToolsRequestSchema` handler's `tools` array (after `cyboflow_submit_checkpoint`, ~line 176), add a tool: `name: 'cyboflow_report_step'`; `description` stating it is OBSERVATIONAL and does NOT pause the run / change run status / approve / notify (contrast with the PreToolUse approval gate); `inputSchema: { type:'object', properties: { step_id: { type:'string', ... }, status: { type:'string', enum:['running','done'], ... } }, required: ['step_id'] }`. No `run_id` property — the run is bound from `CYBOFLOW_RUN_ID`.

2. In the `CallToolRequestSchema` switch (~line 211), add `case 'cyboflow_report_step'` before `default`, mirroring `cyboflow_submit_checkpoint`:
   - `const args = (request.params.arguments ?? {}) as { step_id?: unknown; status?: unknown };`
   - If `typeof step_id !== 'string'` or empty → return `{ error: 'invalid_arguments', expected: 'step_id: string' }` (the sibling content shape).
   - If `status !== undefined && status !== 'running' && status !== 'done'` → return `{ error: 'invalid_arguments', expected: "status: 'running' | 'done' (optional)" }`.
   - Build `const queryParams: Record<string, unknown> = { stepId: step_id }; if (status !== undefined) queryParams['status'] = status;`
   - `return executeMcpQuery('mcp-report-step', queryParams);`
   - No `any` — narrow via the `as { step_id?: unknown; status?: unknown }` cast as the checkpoint case does.

### B. Handler — `mcpQueryHandler.ts`

3. Add imports: `import { WORKFLOW_DEFINITIONS, SOLOFLOW_WORKFLOW_NAMES } from '../../../../shared/types/workflows';` and `import { buildStepTransitionEvent } from '../stepTransitionBridge';`. Confirm relative depth (`stepTransitionBridge.ts` imports `../../../shared`; from `orchestrator/mcpServer/` it is `../../../../shared`).
4. Extend the `McpQueryMessage` union (lines 40-43): `| { type: 'mcp-report-step'; requestId: string; runId: string; stepId: string; status?: 'running' | 'done' }`.
5. In `handleMessage`'s switch (line 84), add `case 'mcp-report-step': this.handleReportStep(msg, client); break;` before `default` so exhaustiveness holds.
6. Add `private handleReportStep(msg: Extract<McpQueryMessage, { type: 'mcp-report-step' }>, client: net.Socket): void`, mirroring `handleSubmitCheckpoint`:
   - Orchestrator guard: if `msg.runId === 'orchestrator'` → `writeResponse` ok:false `'report_step_requires_real_run'`, return.
   - Resolve name: `const row = this.db.prepare('SELECT w.name AS name FROM workflow_runs r JOIN workflows w ON w.id = r.workflow_id WHERE r.id = ?').get(msg.runId) as { name?: unknown } | undefined;`
   - If `!row` → `writeResponse` ok:false `'run_not_found'`, return.
   - `const name = typeof row.name === 'string' ? row.name : '';`
   - Validate: `const isKnown = (SOLOFLOW_WORKFLOW_NAMES as readonly string[]).includes(name); const validStepIds = isKnown ? new Set(WORKFLOW_DEFINITIONS[name as keyof typeof WORKFLOW_DEFINITIONS].phases.flatMap((p) => p.steps).map((s) => s.id)) : new Set<string>();` If `!validStepIds.has(msg.stepId)` → `writeResponse` ok:false `'unknown_step_id'`, return (no write).
   - Write + emit: `const status = msg.status ?? 'running'; const event = buildStepTransitionEvent(msg.runId, msg.stepId, status, this.db, undefined);` If `event === null` → `writeResponse` ok:false `'run_not_found'`, return. Else `writeResponse` ok:true `data: { step_id: msg.stepId, status }`.
   - The outer `handleMessage` try/catch already converts any throw into an ok:false response (fail-soft) — do not add redundant try/catch. Pass `undefined` for the bridge logger arg (the class holds no LoggerLike; do not fabricate one).

### C. Tests — `mcpServer/__tests__/mcpQueryHandler.test.ts` (NEW FILE)

7. Mirror `__tests__/stepTransitionBridge.test.ts` setup: import `createTestDb` from `'../../__test_fixtures__/orchestratorTestDb'`, `dbAdapter` from `'../../__test_fixtures__/dbAdapter'`, `stepTransitionEvents` from `'../../trpc/routers/events'`, `{ McpQueryHandler }` from `'../mcpQueryHandler'`. Add a `createTestDbWithCurrentStep()` helper that calls `createTestDb({ includeQuestionsTable: true })` then `db.exec('ALTER TABLE workflow_runs ADD COLUMN current_step_id TEXT')` (current_step_id is NOT in base GATE_SCHEMA; orchestratorTestDb.ts is readonly). Add `seedReportRun(workflowName)` inserting a `workflows` row (`INSERT INTO workflows (id, project_id, name, spec_json) VALUES (?, 1, ?, '{}')`) with a SOLOFLOW name and a `workflow_runs` row. Capture responses with a fake socket: `const written: string[] = []; const client = { write: (s: string) => { written.push(s); return true; } } as unknown as import('net').Socket;` parse the last line with `JSON.parse(written.at(-1)!.trim())`.
8. Cases (each `new McpQueryHandler(dbAdapter(db))` + `await handler.handleMessage({...}, client)`):
   - orchestrator guard → ok:false `'report_step_requires_real_run'`.
   - valid stepId (`'sprint'` run, `stepId:'write-tests'`) → ok:true, `SELECT current_step_id === 'write-tests'`, exactly one `stepTransitionEvents` 'transition' emit (subscribe in beforeEach, `removeAllListeners` in afterEach, copy the bridge test pattern).
   - invalid stepId (`'sprint'` run, `'does-not-exist'`) → ok:false `'unknown_step_id'`, current_step_id still NULL, no emit.
   - run not found (no seed) → ok:false, no throw.
9. Run `pnpm test:unit` (exit 0). Not `pnpm test:e2e`.

## Acceptance Criteria notes

- "OBSERVATIONAL" must appear verbatim (case-insensitive grep) in the tool description.
- `unknown_step_id` is the contract error string from IDEA-029 slice 4 — do not rename. `report_step_requires_real_run` mirrors the checkpoint guard's `<verb>_requires_real_run` shape.
- The handler validates stepId itself (returning structured `unknown_step_id`) rather than relying on TASK-801's bridge hardening, because `buildStepTransitionEvent` returns `null` for both "bad step" and "row vanished" and cannot distinguish them for the response. The bridge call is reached only for already-validated steps.

## Out of Scope

- Wiring `mcp-report-step` into any live socket server / `McpServerLifecycle` (TASK-798/799).
- Threading the real `CYBOFLOW_RUN_ID` (TASK-800).
- The stepId-validation hardening inside `buildStepTransitionEvent` itself (TASK-801, a readonly dependency here).
- Injecting step-reporting instructions into agent prompts (TASK-803).
- The parity test and frontend forward-jump test (TASK-804).
- Adding `'failed'`/`'skipped'` to the status enum (deferred; v1 is `running | done`).
