---
id: TASK-800
idea: IDEA-029
status: ready
created: 2026-05-29T00:00:00Z
source: IDEA-029
epic: mcp-runtime-step-tracking
files_owned:
  - main/src/orchestrator/runExecutor.ts
  - main/src/services/panels/claude/claudeCodeManager.ts
  - main/src/services/panels/claude/__tests__/claudeCodeManager.composeMcpServers.test.ts
files_readonly:
  - main/src/orchestrator/types.ts
  - main/src/orchestrator/__tests__/runExecutor.test.ts
  - main/src/services/panels/claude/__tests__/claudeCodeManagerWiring.test.ts
acceptance_criteria:
  - criterion: "ClaudeSpawnerOptions in runExecutor.ts declares an additive optional field runId?: string"
    verification: "grep -nE 'runId\\?:\\s*string' main/src/orchestrator/runExecutor.ts returns at least one hit inside the ClaudeSpawnerOptions interface block"
  - criterion: "RunExecutor.execute() passes runId to spawnCliProcess, set to the run id (panelId === runId === sessionId for workflow runs)"
    verification: "grep -n 'runId' main/src/orchestrator/runExecutor.ts shows runId included in the object literal passed to this.spawner.spawnCliProcess({ ... }) inside execute()"
  - criterion: "composeMcpServers() sets CYBOFLOW_RUN_ID to options.runId when present and non-empty, falling back to options.sessionId otherwise"
    verification: "grep -n 'CYBOFLOW_RUN_ID' main/src/services/panels/claude/claudeCodeManager.ts shows the value derived from options.runId with a fallback to options.sessionId (no longer the bare 'options.sessionId')"
  - criterion: "A new composeMcpServers test asserts runId wins over sessionId for CYBOFLOW_RUN_ID, and a case asserts the sessionId fallback when runId is absent"
    verification: "grep -nE 'CYBOFLOW_RUN_ID' main/src/services/panels/claude/__tests__/claudeCodeManager.composeMcpServers.test.ts returns at least two assertions — one where runId differs from sessionId and CYBOFLOW_RUN_ID equals runId, one where runId is undefined/empty and CYBOFLOW_RUN_ID equals sessionId"
  - criterion: "The verifier gate passes with no new type errors and no use of any"
    verification: "pnpm test:unit exits 0; the three owned files contain no new `: any`"
depends_on: []
estimated_complexity: low
test_strategy:
  needed: true
  justification: "composeMcpServers has a dedicated test file that must be extended with a runId-precedence case; the env-var wiring is behavior-changing and silent-failure-prone (FIND-SPRINT-024-4 class)."
  targets:
    - behavior: "CYBOFLOW_RUN_ID equals options.runId when runId is a non-empty string distinct from sessionId"
      test_file: "main/src/services/panels/claude/__tests__/claudeCodeManager.composeMcpServers.test.ts"
      type: unit
    - behavior: "CYBOFLOW_RUN_ID falls back to options.sessionId when runId is undefined (quick-session path)"
      test_file: "main/src/services/panels/claude/__tests__/claudeCodeManager.composeMcpServers.test.ts"
      type: unit
---

# Thread real workflow_runs.id as CYBOFLOW_RUN_ID through the spawn path

## Objective

`composeMcpServers()` (claudeCodeManager.ts:~523) sets `CYBOFLOW_RUN_ID` to `options.sessionId` — the Claude session UUID, not the `workflow_runs.id`. Every cyboflow MCP tool binds its run from this env var, so as-is any `UPDATE workflow_runs ... WHERE id=?` targets a non-existent row (changes===0, silent no-op — the FIND-SPRINT-024-4 silent-drop class). This task threads the real run id through the spawn path: add `runId?: string` to the narrow `ClaudeSpawnerOptions` interface in runExecutor.ts, have `RunExecutor.execute()` pass it (equal to runId per the panelId === runId === sessionId invariant), and switch `composeMcpServers()` to prefer `options.runId` over `options.sessionId` for `CYBOFLOW_RUN_ID`. Quick sessions with no run pass `undefined` and retain the existing `sessionId` fallback.

## Implementation Steps

1. In `claudeCodeManager.ts` at line ~523, change the `CYBOFLOW_RUN_ID` assignment in the `cyboflowEntry.env` object so its value is `options.runId` when `options.runId` is a non-empty string, else `options.sessionId`: `CYBOFLOW_RUN_ID: (options.runId && options.runId.length > 0) ? options.runId : options.sessionId,`. Update the adjacent comment to state CYBOFLOW_RUN_ID is the workflow_runs.id for workflow runs and falls back to sessionId for legacy quick sessions. NOTE: the `ClaudeSpawnOptions` interface in this file ALREADY declares `runId?: string` (the intended doc comment is present) — do NOT re-add it; only the env-var consumer changes.

2. In `runExecutor.ts`, add `runId?: string;` as an additive optional field to the `ClaudeSpawnerOptions` interface, with a one-line doc comment: the real workflow_runs.id; for workflow runs equals panelId/sessionId per the orchestrator invariant. This narrow interface is the standalone-typecheck-safe twin of claudeCodeManager's `ClaudeSpawnOptions` — keep the field optional so quick-session callers are unaffected.

3. In `RunExecutor.execute()` (the `this.spawner.spawnCliProcess({ ... })` call at ~line 250), add `runId,` to the object literal alongside `panelId`, `sessionId`, `worktreePath`, `prompt`, `...overrides`. Since `const panelId = runId` and `const sessionId = runId` already hold, pass the `runId` parameter directly. Quick sessions never reach this executor (they throw earlier in execute per the IDEA-024 boundary).

4. In `claudeCodeManager.composeMcpServers.test.ts`, extend `TestableClaudeCodeManager.publicComposeMcpServers` to accept an optional `runId?: string` second parameter and forward it into the `composeMcpServers({ sessionId, runId })` call object.

5. Add two `it(...)` cases: (a) `publicComposeMcpServers('sess-uuid', 'run-real-id')` after `setOrchSocketPath` → assert `(result['cyboflow'] as { env: Record<string,string> }).env.CYBOFLOW_RUN_ID === 'run-real-id'`; (b) `publicComposeMcpServers('sess-uuid')` with no runId → assert `CYBOFLOW_RUN_ID === 'sess-uuid'`. Use `await Promise.resolve()` after `setOrchSocketPath` as existing tests do. No `any` — type the cyboflow entry via the existing cast pattern extended with `env: Record<string, string>`.

6. Run `pnpm test:unit` (exit 0). If `better-sqlite3` ABI errors appear, `pnpm rebuild better-sqlite3` first per CLAUDE.md, then re-run.

## Acceptance Criteria notes

- The `ClaudeSpawnerOptions` field (runExecutor.ts) and `ClaudeSpawnOptions` field (claudeCodeManager.ts) are distinct interfaces by design — the orchestrator standalone-typecheck invariant forbids runExecutor.ts importing from `main/src/services/*`. Only runExecutor.ts's interface gains the field here; claudeCodeManager's already has it.
- The runId-precedence guard must treat empty string as absent (fall back to sessionId).
- The existing runExecutor test case `(e)` (runExecutor.test.ts:184-199) asserts `panelId`/`sessionId` equal `run.id`; it remains green and is readonly here. Adding a `runId` assertion to it is OUT OF SCOPE (the file is not owned) — the composeMcpServers test carries the new coverage.

## Out of Scope

- Registering or implementing the `cyboflow_report_step` MCP tool (TASK-802).
- Standing up the MCP server runtime / socket wiring (TASK-798/799).
- stepId validation in the transition bridge (TASK-801).
- Any change to the quick-session direct claudeCodeManager spawn path beyond the additive optional field.
- Modifying runExecutor.test.ts or claudeCodeManagerWiring.test.ts (readonly context only).
