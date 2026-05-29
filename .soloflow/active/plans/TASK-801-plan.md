---
id: TASK-801
idea: IDEA-029
status: ready
created: 2026-05-29T00:00:00Z
source: IDEA-029
epic: mcp-runtime-step-tracking
files_owned:
  - main/src/orchestrator/stepTransitionBridge.ts
  - main/src/orchestrator/__tests__/stepTransitionBridge.test.ts
files_readonly:
  - shared/types/workflows.ts
  - main/src/orchestrator/types.ts
  - main/src/index.ts
  - main/src/orchestrator/__test_fixtures__/dbAdapter.ts
  - main/src/orchestrator/__test_fixtures__/loggerLikeSpy.ts
  - main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts
acceptance_criteria:
  - criterion: "buildStepTransitionEvent rejects a stepId not present in the run's WORKFLOW_DEFINITIONS flat steps: no DB UPDATE, no emit, warn-log, returns null."
    verification: "New unit test seeds a 'sprint' run, calls buildStepTransitionEvent(runId, 'not-a-real-step', 'running', adapter, logger), asserts return null, emitSpy not called, current_step_id unchanged (null), logger.warn called once with a message containing 'not-a-real-step'. Run: pnpm --filter main test stepTransitionBridge"
  - criterion: "buildStepTransitionEvent accepts ANY stepId that exists in the resolved workflow's flat steps (not just the INITIAL_STEP_IDS entry): DB UPDATE runs, emit fires once, returns the event."
    verification: "New unit test seeds a 'planner' run and calls buildStepTransitionEvent with a non-initial valid step id (confirm the exact id exists in WORKFLOW_DEFINITIONS.planner flat steps at author time); asserts event not null, emittedEvents length 1, DB current_step_id equals that step id. Run: pnpm --filter main test stepTransitionBridge"
  - criterion: "buildStepTransitionEvent fail-soft on missing workflow_runs row is preserved: unknown runId returns null, no throw, warn-log, no emit."
    verification: "Existing test 'logs warn and does NOT throw when workflow_runs row is missing' still passes unchanged. Run: pnpm --filter main test stepTransitionBridge"
  - criterion: "Validation resolves the workflow name by JOIN on runId inside buildStepTransitionEvent, and the standalone-typecheck invariant holds: no new imports from 'electron', 'better-sqlite3', 'fs', or main/src/services/*."
    verification: "grep -nE \"from '(electron|better-sqlite3|fs)'|services/\" main/src/orchestrator/stepTransitionBridge.ts returns no new lines beyond the existing relative ./ and ../../../shared imports. pnpm typecheck passes."
  - criterion: "INITIAL_STEP_IDS and resolveInitialStepId remain exported and unchanged in behavior — the index.ts lifecycle fallback still resolves the initial step for 'running'/'done'."
    verification: "Existing resolveInitialStepId test block passes unchanged. grep -n 'INITIAL_STEP_IDS' main/src/orchestrator/stepTransitionBridge.ts still present. Run: pnpm --filter main test stepTransitionBridge"
  - criterion: "Full unit gate is green."
    verification: "pnpm test:unit exits 0."
depends_on: []
estimated_complexity: low
test_strategy:
  needed: true
  justification: "Adds validation logic to a function with an existing 263-line sibling test file (stepTransitionBridge.test.ts) that this task owns. The new reject path and the relaxed accept-arbitrary-valid path both need direct coverage; existing fail-soft tests must stay green."
  targets:
    - behavior: "Reject stepId absent from the run's WORKFLOW_DEFINITIONS flat steps (no write, no emit, warn, null)."
      test_file: "main/src/orchestrator/__tests__/stepTransitionBridge.test.ts"
      type: unit
    - behavior: "Accept an arbitrary valid (non-initial) stepId for the resolved workflow (write + single emit + returned event)."
      test_file: "main/src/orchestrator/__tests__/stepTransitionBridge.test.ts"
      type: unit
    - behavior: "Preserve missing-row and unknown-workflow fail-soft behavior."
      test_file: "main/src/orchestrator/__tests__/stepTransitionBridge.test.ts"
      type: unit
---

# Validate stepId in buildStepTransitionEvent + relax INITIAL_STEP_IDS hardcoding

## Objective

`buildStepTransitionEvent` (`main/src/orchestrator/stepTransitionBridge.ts:83-125`) currently runs a bare `UPDATE workflow_runs SET current_step_id = ? WHERE id = ?` with ZERO stepId validation — a typo or unknown step id corrupts `current_step_id` (the UI defensively drops unknown ids on read, but the DB row stays wrong; FIND-SPRINT-024-4 silent-corruption class). This task adds in-function validation: resolve the run's workflow name (JOIN `workflows` by `runId`), look the stepId up in `WORKFLOW_DEFINITIONS[name]` flat steps, and reject (warn-log, return `null`, NO write, NO emit) any stepId not found. The v1 `INITIAL_STEP_IDS` single-step hardcoding is relaxed in that `buildStepTransitionEvent` now accepts ANY validated step id (not only the initial one), while `resolveInitialStepId` / `INITIAL_STEP_IDS` stay exactly as-is to serve as the lifecycle fallback used by the `StepTransitionEmitterLike` adapter in `index.ts:596-610`.

## Implementation Steps

1. In `stepTransitionBridge.ts`, extend the imports from `../../../shared/types/workflows` to add `WORKFLOW_DEFINITIONS` (and `SoloFlowWorkflowName` if not already imported). Do NOT add any import from `electron`, `better-sqlite3`, `fs`, or `main/src/services/*` — the standalone-typecheck invariant (file header) must hold.

2. Add a module-private helper `isValidStepId(workflowName: string, stepId: string): boolean`: returns `false` if `workflowName` is not in `SOLOFLOW_WORKFLOW_NAMES`; otherwise flattens `WORKFLOW_DEFINITIONS[workflowName].phases.flatMap(p => p.steps).map(s => s.id)` and returns whether `stepId` is in that list. Keep it pure (no DB, no logger). Narrow `workflowName` via the existing `(SOLOFLOW_WORKFLOW_NAMES as readonly string[]).includes(...)` guard pattern (lines 52-57) — no `any`.

3. In `buildStepTransitionEvent`, BEFORE the existing DB UPDATE block (current line 93), add workflow-name resolution + validation using the narrow `DatabaseLike` only:
   - `const runRow = db.prepare("SELECT w.name AS workflowName FROM workflow_runs r JOIN workflows w ON w.id = r.workflow_id WHERE r.id = ?").get(runId) as { workflowName: string } | undefined;` — mirrors the JOIN already proven in `index.ts:599-604`, satisfiable by the narrow `PreparedStatement.get` in `types.ts:18`.
   - If `runRow` is undefined (missing run) → warn-log (include `runId`), return `null`. This subsumes the not-found case; keep the existing post-UPDATE `changes === 0` branch as a defensive guard for the row-vanished-mid-call race.
   - If `!isValidStepId(runRow.workflowName, stepId)` → warn-log a NEW message containing both `stepId` and `runId` (e.g. `Rejecting unknown stepId=${stepId} for runId=${runId} (workflow=${runRow.workflowName}) — no write/emit`), passing `{ runId, stepId, status }` to `logger.warn` when present (else `console.warn`, matching the existing fallback at lines 100-105). Return `null`. Do NOT run the UPDATE and do NOT emit.

4. Leave the existing UPDATE → `changes` check → event construction → `stepTransitionEvents.emit('transition', event)` → `return event` flow (lines 93-124) intact after the new validation gate. Write-then-emit ordering and the fail-soft try/catch are preserved.

5. Do NOT modify `INITIAL_STEP_IDS` (lines 36-42) or `resolveInitialStepId` (lines 52-57). They remain the lifecycle fallback that `index.ts:596-610` calls; that adapter already does its own JOIN + `resolveInitialStepId` guard, so the added in-function JOIN is redundant-but-harmless for the lifecycle path and authoritative for the new tool-driven arbitrary-step path (TASK-802).

6. In `__tests__/stepTransitionBridge.test.ts`, add a new `describe('buildStepTransitionEvent — stepId validation')` block using the existing `seedForBridge`, `dbAdapter`, and `makeSpyLogger` helpers:
   - Reject: seed `'sprint'`, call with `'not-a-real-step'` → `null`, `emitSpy` not called, `current_step_id` still null, `logger.warn` called once with a message containing `'not-a-real-step'`.
   - Accept-arbitrary-valid: seed `'planner'`, call with a valid NON-initial planner step id. AUTHOR NOTE: open `shared/types/workflows.ts`, read the actual `WORKFLOW_DEFINITIONS.planner` flat step ids, and use a real one that is NOT `'context'` (the IDEA names `research`/`approve-idea`/`epics`/`tasks`/`approve-plan` — confirm verbatim spelling). Assert event not null, `emittedEvents` length 1, DB `current_step_id` equals that id.
   - Confirm the existing missing-row and unknown-workflow tests still pass.

7. Run `pnpm --filter main test stepTransitionBridge` then `pnpm test:unit`; both green.

## Acceptance Criteria

See frontmatter. All verification is via the owned vitest file and the `pnpm test:unit` / `pnpm typecheck` gates. The reject-path and accept-arbitrary-valid ACs are the net-new behaviors; the missing-row, unknown-workflow, and `resolveInitialStepId` ACs assert no regression.

## Out of Scope

- The `cyboflow_report_step` MCP tool and `mcpQueryHandler` routing (TASK-802) — this task only hardens the bridge function.
- Changing the `index.ts` `StepTransitionEmitterLike` adapter (`index.ts:596-610`) — stays the lifecycle fallback; `files_readonly` here.
- Changing `INITIAL_STEP_IDS` membership, `resolveInitialStepId`, or migrating `WORKFLOW_DEFINITIONS` to a user-editable store.
- Richer step states (`failed`/`skipped`) — status stays `pending|running|done`.
- Any `mergeTransition` / frontend / `getPhaseState` change.

## Hardest Decision

Where the workflow-name JOIN lives. `buildStepTransitionEvent` only receives `runId`, not the workflow name. Two designs: (a) JOIN INSIDE `buildStepTransitionEvent` (chosen), or (b) require callers to pass a pre-resolved `workflowName`. Chosen (a): the only existing caller (`index.ts:596-610`) already does this JOIN and would otherwise pass the name redundantly, and the future tool-driven caller (TASK-802) must validate against the DB-of-record run anyway — putting validation in the function makes it impossible to bypass and keeps the signature `(runId, stepId, status, db, logger?)` stable, so no caller churn ripples into TASK-802/803. The narrow `DatabaseLike.prepare(...).get(...)` already supports the JOIN, so the standalone-typecheck invariant is preserved.

## Lowest Confidence Area

The exact non-initial planner step id literal in the accept-arbitrary-valid test (step 6). The authoritative source is `WORKFLOW_DEFINITIONS.planner` in `shared/types/workflows.ts` — read the actual flat step ids there and use a verbatim match, not the IDEA's prose, in case spelling/casing differs.
