---
id: TASK-645
idea: SPRINT-017
status: in-flight
created: "2026-05-18T00:00:00Z"
files_owned:
  - main/src/trpc/routers/approvals.ts
  - main/src/trpc/__tests__/approvals.test.ts
files_readonly:
  - main/src/orchestrator/trpc/routers/approvals.ts
  - shared/types/approvals.ts
  - main/src/utils/mutex.ts
  - main/src/orchestrator/__test_fixtures__/dbAdapter.ts
acceptance_criteria:
  - criterion: "A single private function `decideRestOfRunHandler(db, runId, decision)` contains the SELECT-pending + iterate-UPDATE + best-effort-log body; the two exported wrappers `approveRestOfRunHandler` and `rejectRestOfRunHandler` each delegate to it in a single call expression."
    verification: "grep -nE 'decideRestOfRunHandler' main/src/trpc/routers/approvals.ts returns at least 3 matches (one declaration, two call sites from the wrappers). Reading the file confirms neither wrapper body contains a `for (const row of rows)` loop — that loop appears exactly once, inside decideRestOfRunHandler."
  - criterion: "The wrappers preserve their existing exported names and signatures so the orchestrator TODO comments (main/src/orchestrator/trpc/routers/approvals.ts lines 109-110, 139-140) still grep-replace cleanly."
    verification: "grep -n 'export async function approveRestOfRunHandler' main/src/trpc/routers/approvals.ts AND grep -n 'export async function rejectRestOfRunHandler' main/src/trpc/routers/approvals.ts each return exactly one match; both signatures still accept `(db, runId)` and return `Promise<ApproveRestOfRunResult>` / `Promise<RejectRestOfRunResult>`."
  - criterion: The shared implementation uses a parameterized status (the SQL UPDATE binds `?` for status instead of an inline literal) so adding a new decision state in future requires changing only one SQL string.
    verification: "grep -cE \"SET status = 'approved'|SET status = 'rejected'\" main/src/trpc/routers/approvals.ts returns 0. grep -nE 'SET status = \\?' main/src/trpc/routers/approvals.ts returns at least 1 match inside decideRestOfRunHandler."
  - criterion: "The error-log prefix is derived from the decision parameter so the existing log messages `[approveRestOfRun] Failed to approve ...` and `[rejectRestOfRun] Failed to reject ...` continue to appear verbatim at runtime."
    verification: Run `pnpm --filter main exec vitest run src/trpc/__tests__/approvals.test.ts`. All 6 existing tests still pass. New error-prefix test asserts both prefixes appear when the UPDATE throws.
  - criterion: All 6 existing handler tests still pass; the test file exercises the shared decideRestOfRunHandler implementation via both the approve and reject entry-point wrappers.
    verification: Run `pnpm --filter main exec vitest run src/trpc/__tests__/approvals.test.ts`; exit code 0; output reports 6 passing tests in the two existing `describe` blocks plus the new error-prefix tests.
  - criterion: "No external import surface change: callers continue to `import { approveRestOfRunHandler, rejectRestOfRunHandler } from '...trpc/routers/approvals'`. The shared `decideRestOfRunHandler` is not exported."
    verification: "grep -n 'export' main/src/trpc/routers/approvals.ts shows exports only for `approvalsRouter`, `approveRestOfRunHandler`, `rejectRestOfRunHandler` (no fourth export). grep -rn 'decideRestOfRunHandler' main/ frontend/ shared/ returns matches only inside main/src/trpc/routers/approvals.ts and the test file."
depends_on: []
estimated_complexity: low
epic: approval-router-and-permission-fix
test_strategy:
  needed: true
  justification: "The refactor touches a file that already has a sibling test file with 6 tests across two describe blocks. All 6 must continue to pass to prove behavior preservation, and one new test must assert the decision-derived error-log prefix on UPDATE failure (the symbol-folding intent of the refactor)."
  targets:
    - behavior: "All 6 existing tests pass unchanged (approves all pending for run-A, returns {decided:0} for nonexistent run, sweep-grep for global approve-all symbol; mirror trio for reject)."
      test_file: main/src/trpc/__tests__/approvals.test.ts
      type: unit
    - behavior: "When a single UPDATE throws, decideRestOfRunHandler logs with the decision-derived prefix `[approveRestOfRun]` or `[rejectRestOfRun]` (asserted via a vi.spyOn(console, 'error') spy) and continues iterating the remaining rows. Both branches must be exercised."
      test_file: main/src/trpc/__tests__/approvals.test.ts
      type: unit
---
# Extract decideRestOfRunHandler to eliminate the approve/reject clone

## Objective

Collapse the byte-for-byte clone between `approveRestOfRunHandler` and `rejectRestOfRunHandler` in `main/src/trpc/routers/approvals.ts` into a single shared `decideRestOfRunHandler(db, runId, decision)` implementation, while preserving the two existing named wrappers so the orchestrator-side TODO grep-replace targets keep working unchanged. The refactor is behavior-preserving — all 6 existing handler tests must continue to pass — and reduces the surface where future approval-router work (audit logging, timeout handling, new decision states) must be applied from two file regions to one.

## Implementation Steps

1. Open `main/src/trpc/routers/approvals.ts` and re-read the two handlers. Both currently run identical SELECT, identical loop, identical try/catch shape — diverging only at the `SET status = 'approved'|'rejected'` literal and the `[approveRestOfRun]|[rejectRestOfRun]` log prefix.

2. Introduce a private (non-exported) `decideRestOfRunHandler` immediately after the existing top-of-file comment block. Signature:
   ```ts
   async function decideRestOfRunHandler(
     db: { prepare: (sql: string) => { all: (...params: unknown[]) => unknown[]; run: (...params: unknown[]) => void; }; },
     runId: string,
     decision: 'approved' | 'rejected',
   ): Promise<{ decided: number }> { ... }
   ```
   Reuse the existing inline `DatabaseLike` shape; don't import from `../orchestrator/types` — file header invariant.

3. In the body, keep `withLock(`run:${runId}`, ...)` wrapper. Replace inline status literal with `?` placeholder bound from `decision`. Compute log prefix and verb forms from `decision`. Preserve `Failed to approve`/`Failed to reject` wording verbatim.

4. Rewrite both exported handlers to one-line delegations preserving exported names, signatures, and result type aliases.

5. Verify the file header warning + standalone-typecheck invariant remain intact.

6. Add a new `describe('decideRestOfRunHandler error logging', ...)` block in `__tests__/approvals.test.ts`: two tests spying on `console.error`, forcing the second UPDATE in a 2-approval seed to throw, asserting the decision-specific prefix.

7. `pnpm --filter main exec vitest run src/trpc/__tests__/approvals.test.ts` — all tests pass.

8. `pnpm --filter main typecheck` — exits 0.

9. `grep -cE "SET status = 'approved'|SET status = 'rejected'" main/src/trpc/routers/approvals.ts` must return 0.

## Acceptance Criteria

See frontmatter.

## Test Strategy

Behavior-preservation primary signal. New `describe('decideRestOfRunHandler error logging', ...)` block adds two tests asserting prefix derivation works for both branches via console.error spy + forced UPDATE throw on second iteration. Restore spy in `afterEach`.

## Hardest Decision

Whether to fold the two wrappers entirely vs keep both as thin shells. Chose wrapper-preserving: (1) orchestrator-side TODO grep-replace targets depend on those exact exported names; (2) stack-trace readability.

## Rejected Alternatives

- Export `decideRestOfRunHandler` directly and delete wrappers — forces same-commit edit to orchestrator-side TODOs.
- Add named `Decision` discriminated union — 18 chars used once, premature.
- Extract shared body to separate file — tight coupling to withLock + inline DatabaseLike shape, no readability win.

## Lowest Confidence Area

The error-prefix test's "force second UPDATE to throw" mechanism is coupled to the structural-typed `db.prepare(...).run` shape. If `ctx.db` migration retypes `db` to full `DatabaseLike`, the throw-injection adapter needs updating in one place.
