---
id: TASK-739
idea: SPRINT-035-compound
status: ready
created: 2026-05-23T12:00:00Z
files_owned:
  - main/src/orchestrator/trpc/routers/runs.ts
  - main/src/orchestrator/trpc/routers/__tests__/runs.test.ts
files_readonly:
  - main/src/orchestrator/trpc/context.ts
  - main/src/orchestrator/trpc/trpc.ts
  - main/src/orchestrator/trpc/routers/workflows.ts
  - main/src/orchestrator/trpc/routers/approvals.ts
  - main/src/orchestrator/trpc/__tests__/router.test.ts
  - .soloflow/active/plans/orchestrator-and-trpc-router/EPIC-orchestrator-and-trpc-router.md
acceptance_criteria:
  - criterion: "All five `ctx.userId !== 'local'` guards in `main/src/orchestrator/trpc/routers/runs.ts` are removed."
    verification: "grep -n \"ctx\\.userId\" main/src/orchestrator/trpc/routers/runs.ts returns 0 hits"
  - criterion: "All three `'someone-else' as 'local'` forced casts in `main/src/orchestrator/trpc/routers/__tests__/runs.test.ts` are removed, along with their containing FORBIDDEN test cases."
    verification: "grep -n \"'someone-else'\" main/src/orchestrator/trpc/routers/__tests__/runs.test.ts returns 0 hits AND grep -nc \"FORBIDDEN\" main/src/orchestrator/trpc/routers/__tests__/runs.test.ts shows the count dropped by 3 vs. the pre-task state"
  - criterion: "`runs.ts` is now consistent with `workflows.ts` and `approvals.ts` — none of the three routers contains a `ctx.userId !== 'local'` check."
    verification: "grep -rn \"ctx\\.userId\" main/src/orchestrator/trpc/routers --include='*.ts' returns 0 hits (the test-only forced-cast sites are also gone — see prior AC)"
  - criterion: "`context.ts:88`'s `userId: 'local' as const` declaration is UNCHANGED — this task does not widen the type."
    verification: "grep -n \"userId: 'local' as const\" main/src/orchestrator/trpc/context.ts shows the line is still present"
  - criterion: "`protectedProcedure`'s `isAuthed` middleware in `main/src/orchestrator/trpc/trpc.ts` continues to gate on `ctx.userId` truthiness — the v2 swap point is preserved."
    verification: "grep -n \"if (!ctx.userId)\" main/src/orchestrator/trpc/trpc.ts shows the existing UNAUTHORIZED check is unchanged"
  - criterion: "`pnpm --filter main typecheck` exits 0 (no type errors from removed assertions)."
    verification: "pnpm --filter main typecheck exits with code 0"
  - criterion: "`pnpm --filter main test` exits 0 (full main suite green after the test-case deletions)."
    verification: "pnpm --filter main test exits with code 0"
  - criterion: "The header docblock comment in `runs.test.ts` is updated to remove references to the deleted FORBIDDEN test cases."
    verification: "grep -nE \"\\(c\\) Non-'local' userId|non-local userId → FORBIDDEN\" main/src/orchestrator/trpc/routers/__tests__/runs.test.ts returns 0 hits"
depends_on: []
estimated_complexity: low
epic: orchestrator-and-trpc-router
test_strategy:
  needed: true
  justification: "Three test cases in runs.test.ts depend on the guards being live — removing the guards without removing the tests would leave assertions that NEVER trigger (the production code path no longer rejects). Sibling-test scan: directory main/src/orchestrator/trpc/routers/__tests__/ contains runs.test.ts (owned here). The router.test.ts in main/src/orchestrator/trpc/__tests__/ does not assert on the userId guard for runs procedures so is not affected."
  targets:
    - behavior: "runs.list / runs.getStuckInspection / runs.start happy paths continue to work after FORBIDDEN guard removal (regression check)."
      test_file: "main/src/orchestrator/trpc/routers/__tests__/runs.test.ts"
      type: integration
---

# Resolve statically-dead `ctx.userId !== 'local'` guards in runs.ts

## Objective

`createContext()` returns `{ userId: 'local' as const }` (`context.ts:88`). The five `ctx.userId !== 'local'` guards in `main/src/orchestrator/trpc/routers/runs.ts` (lines 185, 204, 231, 276, 301) are TypeScript-statically unreachable in production code. The matching `runs.test.ts` tests reach them only by bypassing `createContext` and forcing the cast `'someone-else' as 'local'` (lines 172, 250, 389). Sibling routers `workflows.ts` and `approvals.ts` omit these guards entirely — proven by FIND-SPRINT-035-4. The inconsistency widens every time a new procedure is added.

Two paths were available (per the compound proposal): (a) widen `context.ts:userId` to `string` and extract a `localOnlyProcedure` middleware applied uniformly across all routers; (b) drop the guards from `runs.ts` and the matching test-only casts. **This task takes path (b).** Rationale: `protectedProcedure`'s existing `isAuthed` middleware in `trpc.ts:26-31` already gates on `ctx.userId` truthiness — that is the surviving v2-swap point. The redundant inline guards add no enforcement today; widening the type to enable them would expand the v2 swap's blast radius by making every other router import a new middleware. The minimal change is to converge on the current `workflows.ts` / `approvals.ts` shape. When v2 lands and `userId` becomes a real principal, the lift-to-middleware refactor (path a) is one task with a clear scope; doing it pre-emptively now widens the type for code paths that have no v2 design yet.

## Implementation Steps

1. **Edit `main/src/orchestrator/trpc/routers/runs.ts`** — delete five guard blocks. Each takes the same shape:
   ```ts
   if (ctx.userId !== 'local') {
     throw new TRPCError({ code: 'FORBIDDEN' });
   }
   ```
   Locations: lines 185-187 (`list`), 204-206 (`start`), 231-233 (`cancel`), 276-278 (`cancelAndRestart`), 301-303 (`getStuckInspection`). Delete each three-line block AND the preceding/following blank line if removal leaves a double blank. Do not adjust any other code in the procedure bodies.

2. **Re-check unused imports.** After step 1, run `grep -n "TRPCError" main/src/orchestrator/trpc/routers/runs.ts` — if any procedure still throws `TRPCError` for non-FORBIDDEN codes (`NOT_FOUND`, `PRECONDITION_FAILED`, `METHOD_NOT_SUPPORTED`), the import stays. Based on file inspection, `TRPCError` is still used for `start.NOT_FOUND` (line 215), `cancel.METHOD_NOT_SUPPORTED` (236), `cancelAndRestart.METHOD_NOT_SUPPORTED` (281), `getStuckInspection.PRECONDITION_FAILED` (305) and `NOT_FOUND` (312) — so the import stays.

3. **Edit `main/src/orchestrator/trpc/routers/__tests__/runs.test.ts`** — delete three FORBIDDEN test cases (each ~13-15 lines):
   - `(c) non-local userId → TRPCError FORBIDDEN` for `getStuckInspection` (around line 166-183).
   - `(b) non-local userId → TRPCError FORBIDDEN` for `runs.list` (around line 245-261).
   - `(c) Non-'local' userId → FORBIDDEN` for `runs.start` (around line 379-408).
   Delete each `it(...)` block entirely, including the preceding `// -----` comment banner that demarcates it. The other `(a)/(b)/(d)` cases in each `describe` stay.

4. **Update test-file header docblock** (lines 1-34 of `runs.test.ts`): remove `(c) Non-'local' userId → TRPCError FORBIDDEN.` from the `runs.getStuckInspection` block; remove `(b) Non-'local' userId → TRPCError FORBIDDEN.` from the `runs.list` block; remove `(c) Non-'local' userId → TRPCError FORBIDDEN.` from the `runs.start` block. Renumber the remaining sub-bullets (`(d)` → `(c)`) only if doing so does not make the diff noisier than necessary — if the inline comments use `(a)`, `(b)`, `(c)`, `(d)` letters, prefer to leave them as-is (drop `(b)` so the sequence becomes `(a)`, `(c)`, `(d)`); this avoids a cascade of test-name renames inside the body.

5. **Confirm no orphan symbols.** Run `grep -n "as 'local'" main/src/orchestrator/trpc/routers/__tests__/runs.test.ts` — must return 0 hits. The `userId: 'someone-else' as 'local'` casts are now gone; the type cast itself was only needed because the test was deliberately violating the narrow `'local'` literal type.

6. **Run the suite.** `pnpm --filter main typecheck && pnpm --filter main test`. Both must exit 0.

7. **Sanity grep across all routers.** `grep -rn "ctx.userId" main/src/orchestrator/trpc/routers --include='*.ts'` — must return 0 hits (proves consistency with `workflows.ts` / `approvals.ts`).

## Acceptance Criteria

- 0 `ctx.userId !== 'local'` guards remain in `runs.ts`.
- 0 `'someone-else' as 'local'` casts remain in `runs.test.ts`.
- 3 FORBIDDEN test cases deleted from `runs.test.ts`; the file's other tests pass.
- `context.ts:88` (`userId: 'local' as const`) is unchanged.
- `protectedProcedure.use(isAuthed)` truthiness gate in `trpc.ts` is unchanged.
- `pnpm --filter main typecheck` exits 0.
- `pnpm --filter main test` exits 0.

## Test Strategy

Removing the guards is paired one-for-one with removing the tests that exercise them. The remaining tests in `runs.test.ts` — happy paths, NOT_FOUND, PRECONDITION_FAILED, METHOD_NOT_SUPPORTED — are the surviving guard coverage and they all continue to pass. No new test cases are introduced. The `isAuthed` middleware in `trpc.ts` is not directly tested by this file; that coverage (verifying `UNAUTHORIZED` when `userId` is falsy) lives in `main/src/orchestrator/trpc/__tests__/router.test.ts` and is unaffected.

## Hardest Decision

**Path (a) lift-to-middleware vs. path (b) drop-to-baseline.** Both achieve consistency. Path (a) preserves the principal-scoping semantics that `runs.ts` originally intended; path (b) accepts the baseline that `workflows.ts` and `approvals.ts` already established. Chose path (b) for three reasons: (1) the v2 team-tier swap is unscheduled and its design is open — committing to a middleware shape now could be wrong work later; (2) `protectedProcedure`'s `isAuthed` truthiness check is the load-bearing v2 swap point and it already covers all three routers; (3) reducing surface area today is reversible — adding a `localOnlyProcedure` middleware later is straightforward when v2 has a real session-token contract.

## Rejected Alternatives

- **Path (a) — widen `context.ts:userId` to `string` and extract `localOnlyProcedure = protectedProcedure.use(...)`.** Rejected because it bakes a v2 design decision early. Would reconsider when v2 team-tier work is scheduled and the session-principal shape is concrete.
- **Leave the asymmetry in place.** Rejected because FIND-SPRINT-035-4 documents the inconsistency as a low-severity drift that widens with every new procedure; one of the two paths must be taken eventually, and path (b) is the cheap path-of-least-coupling option.
- **Convert the runs.ts guards to use `protectedProcedure.use(localOnly)` per-procedure (no shared middleware).** Rejected — same surface area as path (a) without the consolidation benefit.

## Lowest Confidence Area

The test-deletion exact line counts (steps 3 + 4) — line numbers in the proposal (172, 250, 389) were captured at SPRINT-035 close and may have drifted by a few lines. The executor should match by content (`'someone-else' as 'local'` and the FORBIDDEN test name pattern) rather than absolute line numbers, then `grep -n "'someone-else'"` post-edit to confirm all three sites are gone.
