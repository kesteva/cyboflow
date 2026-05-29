---
id: TASK-804
idea: IDEA-029
status: ready
created: 2026-05-29T00:00:00Z
source: IDEA-029
epic: mcp-runtime-step-tracking
files_owned:
  - main/src/orchestrator/__tests__/stepIdParity.test.ts
  - frontend/src/hooks/__tests__/useWorkflowPhaseState.test.tsx
files_readonly:
  - main/src/orchestrator/prompts/step-reporting-instructions.ts
  - main/src/orchestrator/prompts/planner-step-reporting.md
  - main/src/orchestrator/prompts/sprint-step-reporting.md
  - shared/types/workflows.ts
  - frontend/src/hooks/useWorkflowPhaseState.ts
acceptance_criteria:
  - criterion: "A new parity test file main/src/orchestrator/__tests__/stepIdParity.test.ts asserts every stepId referenced by the cyboflow-owned step-reporting prompt assets (from TASK-803) exists as a valid WorkflowStep.id in WORKFLOW_DEFINITIONS, and fails when a referenced id has no match."
    verification: "test -f main/src/orchestrator/__tests__/stepIdParity.test.ts && grep -q 'WORKFLOW_DEFINITIONS' main/src/orchestrator/__tests__/stepIdParity.test.ts"
  - criterion: "The parity test derives its referenced-stepId set from the actual TASK-803 prompt assets (not a hardcoded duplicate list), so prompt drift fails CI."
    verification: "grep -Eq \"planner-step-reporting|sprint-step-reporting|step-reporting-instructions\" main/src/orchestrator/__tests__/stepIdParity.test.ts"
  - criterion: "frontend/src/hooks/__tests__/useWorkflowPhaseState.test.tsx gains a forward-jump test: with a >=6-step flat definition and currentStep at index 2, a transition to the index-5 step with status 'running' yields steps 0-4 'done', step 5 'running', and any steps after 5 'pending'."
    verification: "grep -q 'forward' frontend/src/hooks/__tests__/useWorkflowPhaseState.test.tsx"
  - criterion: "Both files are NEW-test-only / additive — no production source under main/src or frontend/src outside the two test files is modified."
    verification: "git diff --name-only | grep -vE '(stepIdParity\\.test\\.ts|useWorkflowPhaseState\\.test\\.tsx)$' | grep -E '^(main|frontend)/src/' returns nothing"
  - criterion: "The full unit gate passes with the new and modified tests."
    verification: "pnpm test:unit exits 0"
  - criterion: "No `any` type is introduced in either test file."
    verification: "pnpm lint exits 0 (eslint @typescript-eslint/no-explicit-any is error)"
depends_on: [TASK-803]
estimated_complexity: low
test_strategy:
  needed: true
  justification: "This task IS the test task for the step_id contract; the two owned files are the tests themselves."
  targets:
    - behavior: "Every stepId referenced in TASK-803 prompt assets resolves to a WorkflowStep.id in WORKFLOW_DEFINITIONS"
      test_file: "main/src/orchestrator/__tests__/stepIdParity.test.ts"
      type: unit
    - behavior: "mergeTransition forward jump (index 2 -> index 5): steps 0-4 done, 5 running, rest pending"
      test_file: "frontend/src/hooks/__tests__/useWorkflowPhaseState.test.tsx"
      type: unit
---

# Lock the step_id contract + UI mergeTransition forward-jump test

## Objective

Codify the only cross-layer contract in IDEA-029 — the prompt `step_id` ↔ `WORKFLOW_DEFINITIONS` mapping — as a CI-gated parity test, and lock the forward-jump semantics of the renderer's `mergeTransition` with an additive unit test. This task writes tests only; it modifies no production code. It depends on TASK-803, which creates the cyboflow-owned step-reporting prompt assets that the parity test scans. The mcp-report-step handler unit tests are owned by TASK-802 (`mcpQueryHandler.test.ts`) and are NOT duplicated here.

## Implementation Steps

1. **Confirm the TASK-803 prompt-asset shape first.** Read the three readonly prompt files created by TASK-803. Determine how each references stepIds (a `cyboflow_report_step` call with `step_id: 'context'`, a backtick-quoted id list, or an exported constant). The parity test MUST derive its referenced-id set from whatever format TASK-803 chose — do NOT hardcode the planner sequence. Prefer importing an exported constant if `step-reporting-instructions.ts` exposes one (most robust); fall back to regex-scanning the `.md` bodies only if no exported constant exists.

2. **Create `main/src/orchestrator/__tests__/stepIdParity.test.ts`** (NEW). Build the authoritative valid-id set by flattening `WORKFLOW_DEFINITIONS` from `shared/types/workflows.ts`: `Object.values(WORKFLOW_DEFINITIONS).flatMap(d => d.phases).flatMap(p => p.steps).map(s => s.id)`. Because ids are only unique within a phase, scope the assertion per-workflow when the prompt asset is workflow-specific (planner-prompt ids must exist in `WORKFLOW_DEFINITIONS.planner`; sprint-prompt ids in `WORKFLOW_DEFINITIONS.sprint`). For each stepId referenced, assert it is present in the matching workflow's flattened id set. Add a negative-control assertion (a bogus id like `'definitely-not-a-step'` is NOT in the set). Read prompt files with `fs.readFileSync` + `path.join(__dirname, '../prompts/...')`. Use vitest `describe`/`it`/`expect`.

3. **Add the forward-jump test to `frontend/src/hooks/__tests__/useWorkflowPhaseState.test.tsx`** (EXISTING — additive only; preserve all current cases and the tRPC mock/fixture block). The current `FIXTURE_DEFINITION` has only 3 flat steps; add a local 6+-step fixture inside the new test. Drive it through the hook as the existing "delta merge" case does: render with a runId, await query resolution, capture `onData` from `subscribeSpy.mock.calls[0][1]`, fire `onData({ runId, stepId: <index-5 id>, status: 'running', timestamp })`, then assert `result.current.stepStates` is indices 0-4 `'done'`, index 5 `'running'`, any index >5 `'pending'`. Set the initial query mock so `currentStepId` is the index-2 step. Title the test with the word "forward".

4. **Assert real behavior, not a re-derivation.** `mergeTransition` (useWorkflowPhaseState.ts:83-95): `event.status==='done'` → all done; else `i<idx`→done, `i===idx`→event.status, `i>idx`→pending. The forward-jump test uses `status:'running'`, exercising the `i<idx`/`i===idx`/`i>idx` branch (not the all-done branch already covered by the existing "status=done" case).

5. **Run the gate.** `pnpm test:unit` exit 0. If main-workspace ABI errors on `better-sqlite3`, `pnpm rebuild better-sqlite3` first (per CLAUDE.md). `pnpm lint` to confirm no `any`.

## Acceptance Criteria notes

- The parity test is meaningful ONLY if it parses TASK-803's actual assets; a hardcoded id list that duplicates the prompt content would pass while masking drift. Import an exported constant or scan the file bytes — never re-type the sequence.
- Per-workflow scoping matters: `'context'`, `'epics'`, `'tasks'` appear in multiple definitions. Asserting a planner-prompt id against the global union would hide a planner/sprint mismatch. If TASK-803's asset does not encode which workflow each id belongs to, fall back to the global-union assertion and note the limitation in a test header comment.
- The "additive / no production change" criterion is enforced by `git diff` excluding the two test paths.

## Out of Scope

- mcp-report-step handler unit tests — owned by TASK-802 (`mcpQueryHandler.test.ts`).
- Any production-code change: prompt assets (TASK-803), `mergeTransition` logic, `buildStepTransitionEvent`, or `WORKFLOW_DEFINITIONS`.
- The manual integration check (running a real planner under `pnpm dev`, watching `cyboflow-backend-debug.log` for `handleReportStep`) — operator verification.
- `pnpm test:e2e` — environmental per CLAUDE.md; the gate is `pnpm test:unit`.
