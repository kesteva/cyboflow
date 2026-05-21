---
id: TASK-705
idea: SPRINT-028-compounder
status: in-flight
created: "2026-05-21T00:00:00Z"
files_owned:
  - main/src/ipc/cyboflow.ts
  - main/src/ipc/__tests__/cyboflow.test.ts
files_readonly:
  - docs/CODE-PATTERNS.md
  - shared/types/cyboflow.ts
  - shared/types/workflows.ts
  - frontend/src/utils/cyboflowApi.ts
acceptance_criteria:
  - criterion: "cyboflow:listRuns rejects calls where args.projectId is not a number with { success: false, error mentions projectId }"
    verification: new unit test asserts result.success === false AND result.error matches /projectId/
  - criterion: "cyboflow:listWorkflows applies the same runtime guard for args.projectId"
    verification: inspect main/src/ipc/cyboflow.ts; the listWorkflows handler uses the shared validateNumberArg helper
  - criterion: "cyboflow:startRun applies runtime guards for args.workflowId (string) and args.projectId (number)"
    verification: "new unit tests assert both invalid-arg cases return success: false"
  - criterion: A shared validator helper (validateNumberArg / validateStringArg) is defined in main/src/ipc/cyboflow.ts and used by all three guarded handlers
    verification: "grep -nE 'function validate(Number|String)Arg|const validate(Number|String)Arg' main/src/ipc/cyboflow.ts returns >=1 match"
  - criterion: "main/src/ipc/__tests__/cyboflow.test.ts has at least one new case asserting cyboflow:listRuns returns { success: false } on bad projectId"
    verification: pnpm --filter main exec vitest run main/src/ipc/__tests__/cyboflow.test.ts passes including new cases
  - criterion: pnpm --filter main test exits 0; existing cases continue to pass
    verification: pnpm --filter main test exits 0
  - criterion: pnpm typecheck exits 0
    verification: pnpm typecheck exits 0
  - criterion: "bare cast pattern is replaced (no `args as { projectId: number }` style)"
    verification: "grep -nE 'args as \\{' main/src/ipc/cyboflow.ts returns 0 matches"
depends_on: []
estimated_complexity: low
epic: testing-infrastructure
test_strategy:
  needed: true
  justification: "FIND-SPRINT-028-11 explicitly requests a unit test covering the invalid-arg path for at least cyboflow:listRuns. The existing cyboflow.test.ts has the makeHandlerCapture pattern; we extend with invalid-arg cases."
  targets:
    - behavior: "cyboflow:listRuns returns { success: false } with error matching /projectId/ when args.projectId is undefined or a string"
      test_file: main/src/ipc/__tests__/cyboflow.test.ts
      type: unit
    - behavior: "cyboflow:listWorkflows returns { success: false } when args.projectId is missing"
      test_file: main/src/ipc/__tests__/cyboflow.test.ts
      type: unit
    - behavior: "cyboflow:startRun returns { success: false } when args.workflowId is missing OR args.projectId is a string"
      test_file: main/src/ipc/__tests__/cyboflow.test.ts
      type: unit
---
# B3 — Runtime input validation for cyboflow:* IPC handlers

## Objective

Add runtime type guards to `cyboflow:listRuns`, `cyboflow:listWorkflows`, and `cyboflow:startRun` so that an invalid renderer payload returns a structured `{ success: false, error: '...' }` rather than crashing better-sqlite3 or silently returning wrong rows. Extract local `validateNumberArg` / `validateStringArg` helpers (per docs/CODE-PATTERNS.md). Add unit tests covering the invalid-arg paths.

## Implementation Steps

1. In `main/src/ipc/cyboflow.ts`, add two local helpers near the top (after imports, before `registerCyboflowHandlers`):

   ```typescript
   function validateNumberArg(args: unknown, key: string, channel: string):
       { ok: true; value: number } | { ok: false; error: string } {
     const v = (args as Record<string, unknown> | null | undefined)?.[key];
     if (typeof v !== 'number' || !Number.isFinite(v)) {
       return { ok: false, error: `${channel}: ${key} must be a finite number` };
     }
     return { ok: true, value: v };
   }
   function validateStringArg(args: unknown, key: string, channel: string):
       { ok: true; value: string } | { ok: false; error: string } {
     const v = (args as Record<string, unknown> | null | undefined)?.[key];
     if (typeof v !== 'string' || v.length === 0) {
       return { ok: false, error: `${channel}: ${key} must be a non-empty string` };
     }
     return { ok: true, value: v };
   }
   ```

2. Refactor `cyboflow:listWorkflows`, `cyboflow:startRun`, and `cyboflow:listRuns` to:
   - Widen the handler's `args` parameter to `unknown`.
   - Call the appropriate validator(s) first; return `{ success: false, error: v.error }` on failure.
   - Use the validated `.value` in the existing happy-path body.

3. Extend `main/src/ipc/__tests__/cyboflow.test.ts` with a new `describe('registerCyboflowHandlers — runtime input validation', ...)` block following the existing `makeHandlerCapture` + `invoke` pattern. Add at minimum:
   - listRuns: undefined args → success: false, error /projectId/
   - listRuns: string projectId → success: false, error /projectId/
   - listWorkflows: missing args.projectId → success: false
   - startRun: missing workflowId → success: false, error /workflowId/
   - startRun: string projectId → success: false, error /projectId/

4. Run `pnpm --filter main exec vitest run main/src/ipc/__tests__/cyboflow.test.ts`, then `pnpm --filter main test` and `pnpm typecheck`. All exit 0.

5. Confirm `grep -nE 'args as \{' main/src/ipc/cyboflow.ts` returns 0 matches.

## Hardest Decision

Local helper in `cyboflow.ts` vs shared helper in `main/src/ipc/validate.ts`. Local — premature shared module risk. Lift to shared file when a 2nd IPC domain needs the same pattern.

## Rejected Alternatives

- Use Zod for runtime validation — Zod is already a dep but pulling it into hot-path IPC handlers adds parse cost; two typeof checks suffice.
- Throw inside the handler — breaks the existing `{ success, error }` envelope convention.
- Skip the unit test — FIND-SPRINT-028-11 explicitly requires runtime test coverage; TypeScript is bypassed when the renderer passes runtime garbage.

## Lowest Confidence Area

The happy-path sanity check (`listRuns` with valid number, no rows → `{ success: true, data: [] }`) depends on `REGISTRY_SCHEMA` fixture including `workflow_runs`. If absent, downgrade that case or skip it — the invalid-arg cases are the primary deliverable.
