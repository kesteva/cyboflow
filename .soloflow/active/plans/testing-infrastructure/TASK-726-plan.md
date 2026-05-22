---
id: TASK-726
idea: SPRINT-030
status: in-flight
created: "2026-05-21T00:00:00Z"
files_owned:
  - main/src/ipc/validateInput.ts
  - main/src/ipc/cyboflow.ts
  - main/src/ipc/__tests__/cyboflow.test.ts
  - main/src/ipc/__tests__/validateInput.test.ts
  - docs/CODE-PATTERNS.md
files_readonly:
  - main/src/orchestrator/trpc/routers/runs.ts
  - main/src/services/streamParser/schemas.ts
  - main/src/ipc/types.ts
  - main/package.json
  - .soloflow/active/findings/SPRINT-030-findings.md
acceptance_criteria:
  - criterion: "A new module `main/src/ipc/validateInput.ts` exports a generic `validateInput<T>(schema: ZodType<T>, args: unknown, channel: string): { ok: true; value: T } | { ok: false; error: string }` helper that wraps `schema.safeParse(args)` and returns `{ ok: false, error: '<channel>: <flattened-error-message>' }` on failure."
    verification: "`grep -n 'export function validateInput' main/src/ipc/validateInput.ts` returns 1 match; `grep -n 'safeParse' main/src/ipc/validateInput.ts` returns at least 1 match; the function imports `ZodType` (or equivalent) from `zod`."
  - criterion: "The hand-rolled `validateNumberArg` and `validateStringArg` helpers at `main/src/ipc/cyboflow.ts:62-84` are removed. The three call sites (`cyboflow:listWorkflows`, `cyboflow:startRun`, `cyboflow:listRuns`) now use `validateInput(z.object({...}), args, '<channel>')`."
    verification: "`grep -n 'validateNumberArg\\|validateStringArg' main/src/ipc/cyboflow.ts` returns 0 matches; `grep -n 'validateInput(' main/src/ipc/cyboflow.ts` returns at least 3 matches; the file imports `z` from `zod` and `validateInput` from `./validateInput`."
  - criterion: "The `{ success: false, error }` IPC envelope contract is preserved. Error messages still name the offending field (e.g. `'cyboflow:listRuns: projectId must be a finite number'` or an equivalent Zod-flattened form that contains both the channel and the field name)."
    verification: Run the existing tests at `main/src/ipc/__tests__/cyboflow.test.ts` (the four error-path tests at lines 480-561) and confirm exit 0. The pre-existing `expect(result.error).toMatch(/projectId/)` and `/workflowId/` assertions continue to pass against the new error messages.
  - criterion: "`validateInput` itself has unit-test coverage for the four error classes the IPC handlers exercise: wrong-type (`'bad'` passed for `z.number()`), non-finite (`NaN` / `Infinity`), missing key, and empty string (`''` for `z.string().min(1)`). Each test asserts `ok: false` and a non-empty `error` string containing the channel name."
    verification: "`grep -n 'describe.*validateInput\\|it(' main/src/ipc/__tests__/validateInput.test.ts` returns at least 5 entries (1 describe + 4 it). Running `pnpm --filter main test main/src/ipc/__tests__/validateInput.test.ts` exits 0."
  - criterion: "`docs/CODE-PATTERNS.md` is updated with a `validateInput` section under the IPC-validation heading, citing `main/src/ipc/cyboflow.ts` as the canonical caller and noting that hand-rolled validators are forbidden in `main/src/ipc/*.ts` going forward."
    verification: "`grep -n 'validateInput' docs/CODE-PATTERNS.md` returns at least 1 match; the surrounding section names `main/src/ipc/validateInput.ts` and references Zod."
  - criterion: "`pnpm --filter main test` exits 0 with all pre-existing tests in `cyboflow.test.ts` passing against the new validator (no test changes needed beyond what AC#3 covers — the `expect(result.error).toMatch(/projectId/)` style assertions are agnostic to whether the helper is hand-rolled or Zod-backed)."
    verification: Run `pnpm --filter main test`; exit status 0.
  - criterion: "`pnpm typecheck` exits 0."
    verification: Run `pnpm typecheck`; exit status 0.
depends_on: []
estimated_complexity: low
epic: testing-infrastructure
test_strategy:
  needed: true
  justification: A new shared helper `validateInput` is introduced and needs its own unit-test coverage. The pre-existing `cyboflow.test.ts` error-path cases (lines 480-561) are the integration-level lock; the new `validateInput.test.ts` provides the unit-level lock so future IPC handler additions can rely on the helper without re-deriving the error contract.
  targets:
    - behavior: "validateInput returns { ok: true, value } on schema match; { ok: false, error: '<channel>: …' } on each failure class (wrong type, NaN/Infinity, missing key, empty string)."
      test_file: main/src/ipc/__tests__/validateInput.test.ts
      type: unit
    - behavior: "cyboflow:listWorkflows / startRun / listRuns continue to return { success: false, error } envelopes naming the offending field when args are invalid."
      test_file: main/src/ipc/__tests__/cyboflow.test.ts
      type: integration
---
# Replace hand-rolled IPC validators with a Zod-based shared helper

## Objective

TASK-705 introduced `validateNumberArg` and `validateStringArg` in `main/src/ipc/cyboflow.ts:62-83` and applied them to three IPC handlers. The project already uses Zod in `main/src/orchestrator/trpc/routers/runs.ts:141,147,153` and `main/src/services/streamParser/schemas.ts`. The hand-rolled helpers duplicate `z.number().finite()` and `z.string().min(1)`, fork the error-shape pattern, and make the in-progress tRPC ipcLink migration harder (a future tRPC cutover will be a re-validate, not a code-move). FIND-SPRINT-030-9 proposes consolidating to a `validateInput<T>(schema: ZodType<T>, args: unknown, channel: string)` helper that preserves the `{ success: false, error }` IPC envelope contract and aligns with the tRPC router pattern.

## Implementation Steps

1. Create `main/src/ipc/validateInput.ts`. Implement:

   ```ts
   import { z, type ZodType } from 'zod';

   /**
    * Generic Zod-backed validator for IPC handler args.
    *
    * Wraps `schema.safeParse(args)` and returns a discriminated result:
    *   - { ok: true, value }                    — args satisfy the schema
    *   - { ok: false, error: '<channel>: <m>' } — args fail; `<m>` is a Zod-flattened
    *                                               summary that names the failing field
    *
    * The error format is intentionally aligned with the pre-existing hand-rolled
    * helpers (`<channel>: <field> must be a <type>`) so existing tests that match
    * `result.error` against `/projectId/` or `/workflowId/` continue to pass.
    *
    * Canonical use site: main/src/ipc/cyboflow.ts. Hand-rolled validators in
    * main/src/ipc/*.ts are forbidden — extend this helper instead.
    */
   export function validateInput<T>(
     schema: ZodType<T>,
     args: unknown,
     channel: string,
   ): { ok: true; value: T } | { ok: false; error: string } {
     const result = schema.safeParse(args);
     if (result.success) return { ok: true, value: result.data };

     // Format the first issue: include the path (field name) and the message.
     // Zod issues for missing/wrong-type fields carry `path: ['projectId']` and
     // a message like 'Expected number, received string'.
     const issue = result.error.issues[0];
     const fieldPath = issue.path.join('.') || '<root>';
     const detail = `${fieldPath} ${issue.message.toLowerCase()}`;
     return { ok: false, error: `${channel}: ${detail}` };
   }
   ```

   The `<fieldPath> <message>` shape ensures the regex `/projectId/` and `/workflowId/` in the existing cyboflow.test.ts still match. Confirm by running step 5's tests.

2. Open `main/src/ipc/cyboflow.ts`. Add imports:

   ```ts
   import { z } from 'zod';
   import { validateInput } from './validateInput';
   ```

3. Delete `validateNumberArg` and `validateStringArg` (lines 62-84). Rewrite the three call sites:

   - `cyboflow:listWorkflows` (lines 100-128): replace `validateNumberArg(args, 'projectId', 'cyboflow:listWorkflows')` with:
     ```ts
     const v = validateInput(z.object({ projectId: z.number().finite() }), args, 'cyboflow:listWorkflows');
     if (!v.ok) return { success: false, error: v.error };
     const { projectId } = v.value;
     ```

   - `cyboflow:startRun` (lines 137-168): replace the two-step validate with a single schema:
     ```ts
     const v = validateInput(
       z.object({ workflowId: z.string().min(1), projectId: z.number().finite() }),
       args,
       'cyboflow:startRun',
     );
     if (!v.ok) return { success: false, error: v.error };
     const { workflowId, projectId } = v.value;
     ```

   - `cyboflow:listRuns` (lines 180-204): mirror `cyboflow:listWorkflows`:
     ```ts
     const v = validateInput(z.object({ projectId: z.number().finite() }), args, 'cyboflow:listRuns');
     if (!v.ok) return { success: false, error: v.error };
     const { projectId } = v.value;
     ```

4. Create `main/src/ipc/__tests__/validateInput.test.ts` with one `describe('validateInput')` and 4-5 `it` cases:

   - `valid args → { ok: true, value }`: pass `z.object({ projectId: z.number().finite() })` with `{ projectId: 42 }`; expect `ok: true` and `value.projectId === 42`.
   - `wrong type → { ok: false, error contains channel and field }`: pass `{ projectId: 'bad' }`; expect `ok: false`, `error.includes('cyboflow:listRuns')`, `error.includes('projectId')`.
   - `non-finite number → { ok: false }`: pass `{ projectId: NaN }`; expect `ok: false` and the error to name `projectId`.
   - `missing key → { ok: false }`: pass `{}`; expect `ok: false` and the error to name `projectId`.
   - `empty string → { ok: false }`: pass `z.object({ workflowId: z.string().min(1) })` with `{ workflowId: '' }`; expect `ok: false` and the error to name `workflowId`.

5. Run the pre-existing tests at `main/src/ipc/__tests__/cyboflow.test.ts` (`pnpm --filter main test main/src/ipc/__tests__/cyboflow.test.ts`). The four error-path tests at lines 488-505, 507-524, 527-541, 544-561 each assert `expect(result.error).toMatch(/<field>/)`. Confirm all four pass against the new error format. If any fail because the Zod-flattened message phrases the field differently, adjust the `<fieldPath> <message>` ordering in `validateInput` so the regex matches — do not weaken the test assertions.

6. Update `docs/CODE-PATTERNS.md`. Find the section that currently mentions IPC validation (or, if absent, add a new section under "IPC patterns"). Add:

   ```md
   ## IPC handler input validation

   All `ipcMain.handle` handlers in `main/src/ipc/*.ts` MUST validate args via
   `validateInput` from `main/src/ipc/validateInput.ts`. Hand-rolled type guards
   are forbidden — they fork the error-shape and make the in-progress tRPC ipcLink
   migration harder.

   Canonical usage:
   ```ts
   const v = validateInput(z.object({ projectId: z.number().finite() }), args, 'cyboflow:listRuns');
   if (!v.ok) return { success: false, error: v.error };
   const { projectId } = v.value;
   ```

   See `main/src/ipc/cyboflow.ts` for the canonical caller.
   ```

7. Run `pnpm --filter main test` and `pnpm typecheck`; both exit 0.

## Acceptance Criteria

- `validateInput` exists with the documented signature and Zod-backed implementation.
- All three handlers in `cyboflow.ts` use `validateInput`; hand-rolled helpers are deleted.
- IPC envelope `{ success: false, error }` contract preserved.
- Unit tests for `validateInput` cover the four error classes plus the happy path.
- `docs/CODE-PATTERNS.md` carries the new section.
- `pnpm --filter main test` and `pnpm typecheck` exit 0.

## Test Strategy

A new helper module deserves its own unit-test file — `validateInput.test.ts` covers the success path and 4 distinct failure classes. The integration-level lock is the pre-existing `cyboflow.test.ts` error-path tests, which exercise the helper through the actual IPC handlers and assert the channel + field appear in the error envelope. The combination ensures (a) the helper is correct in isolation, and (b) the handlers wire it correctly without changing the externally-visible error contract.

## Hardest Decision

The error-string format. The pre-existing helpers produce `'cyboflow:listRuns: projectId must be a finite number'`. Zod's `safeParse` issues carry `path: ['projectId']` and `message: 'Expected number, received string'` (or `'Expected number, received nan'` for NaN — Zod handles `Number.isFinite` via `.finite()`). Aligning the new format to `'<channel>: <fieldPath> <issue.message.toLowerCase()>'` produces strings like `'cyboflow:listRuns: projectId expected number, received string'`. This is structurally different from the hand-rolled phrase but contains both `'projectId'` (matched by `/projectId/`) and the channel name. The decision is to align JUST closely enough that existing test regexes pass without weakening, and not attempt to byte-perfect-match the hand-rolled phrasing (which would require a custom error formatter on every Zod schema). If a future test asserts the exact pre-existing string, this task carves out that risk explicitly in the Lowest Confidence Area.

## Rejected Alternatives

- **Keep both hand-rolled helpers and add `validateInput` only for new handlers**: hedges the decision, perpetuates the fork. Would reconsider if a code-archaeology pass surfaced 10+ existing call sites with deep error-message dependencies.
- **Write a custom `errorFormatter` that produces byte-identical pre-existing strings** (`'<channel>: <field> must be a finite number'`): possible by mapping `issue.code === 'invalid_type'` + `expected === 'number'` to the legacy phrase. Rejected because (a) the existing test assertions use `/projectId/` regex matching, not full-string equality, so byte-match is unnecessary, and (b) the bespoke formatter forks back into the same maintenance burden the consolidation is removing.
- **Move `validateInput` to `shared/types/ipc.ts`** (alongside the planned `IPCResponse` consolidation in `CLAUDE.md`): would centralize the IPC envelope helpers in one place. Rejected because Zod is a main-process dependency (`main/package.json:30`) and the renderer doesn't need (and shouldn't import) the validator. Would reconsider if `shared/` later carries a re-exported zod boundary type that doesn't pull the runtime in.

## Lowest Confidence Area

The exact error-string format. The fixed assertions in `cyboflow.test.ts` use loose regex matching (`/projectId/`, `/workflowId/`), so any format containing the field name passes — this is unlikely to break. The risk is a developer in a future task asserting an exact pre-existing phrase (`'must be a finite number'`) and being surprised when the Zod-flattened message reads differently. Mitigation: the `docs/CODE-PATTERNS.md` section names the helper as the source of truth for the error format, so a future contributor reading that doc would update assertions to match `validateInput`'s output rather than the hand-rolled phrase. If the existing tests do fail because of phrasing, step 5 explicitly calls out adjusting the formatter (not the assertions) — keep the loose-regex contract intact.