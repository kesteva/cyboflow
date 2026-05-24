---
id: TASK-738
idea: SPRINT-035-compound
status: ready
created: 2026-05-23T12:00:00Z
files_owned:
  - main/src/orchestrator/trpc/routers/runs.ts
  - main/src/index.ts
  - main/src/orchestrator/__tests__/runLifecycle.test.ts
files_readonly:
  - main/src/orchestrator/runExecutor.ts
  - main/src/orchestrator/runLauncher.ts
  - main/src/orchestrator/cancelAndRestartHandler.ts
  - main/src/orchestrator/approvalRouter.ts
  - main/src/orchestrator/RunQueueRegistry.ts
  - frontend/src/utils/cyboflowApi.ts
  - frontend/src/utils/trpcClient.ts
  - frontend/src/trpc/client.ts
  - .soloflow/active/plans/trpc-cutover-and-legacy-tree-cleanup/EPIC-trpc-cutover-and-legacy-tree-cleanup.md
acceptance_criteria:
  - criterion: "`cyboflow.runs.cancel` is no longer reachable as a live procedure in v1 — calling it from a tRPC caller throws `METHOD_NOT_SUPPORTED` with a message that does NOT mention `setCancelDeps`."
    verification: "grep -n \"setCancelDeps\" main/src/orchestrator/trpc/routers/runs.ts returns 0 hits; grep -n \"throwNotImplemented\" main/src/orchestrator/trpc/routers/runs.ts shows the cancel procedure delegating to throwNotImplemented('workflow-runs')"
  - criterion: "The `CancelDeps` interface and `setCancelDeps`/`cancelDeps`/`cancelHandler` exports are deleted."
    verification: "grep -nE \"(export interface CancelDeps|export function setCancelDeps|export async function cancelHandler|let cancelDeps)\" main/src/orchestrator/trpc/routers/runs.ts returns 0 hits"
  - criterion: "No code in `main/src/` imports `setCancelDeps`, `cancelHandler`, or `CancelDeps`."
    verification: "grep -rnE \"(setCancelDeps|cancelHandler|CancelDeps)\" main/src --include='*.ts' returns 0 hits"
  - criterion: "Cancel-related tests in `runLifecycle.test.ts` (the `describe('cancelHandler', ...)` block and its imports) are removed; the rest of that file continues to pass."
    verification: "grep -n \"describe.*cancelHandler\" main/src/orchestrator/__tests__/runLifecycle.test.ts returns 0 hits; pnpm --filter main test -- runLifecycle exits 0"
  - criterion: "`pnpm --filter main typecheck` exits 0."
    verification: "pnpm --filter main typecheck exits with code 0"
  - criterion: "`pnpm --filter main test` exits 0."
    verification: "pnpm --filter main test exits with code 0"
  - criterion: "`grep -rnE \"cyboflow\\.runs\\.cancel\\b\" frontend/src` returns 0 hits (no renderer caller depends on the procedure)."
    verification: "grep -rnE \"cyboflow\\.runs\\.cancel\\.\" frontend/src returns 0 hits (matches `.query(`, `.mutate(`, `.useQuery(`, etc., on the bare `cancel` procedure — `cancelAndRestart` is intentionally excluded by the `\\b` word boundary semantics in the cancel-only grep)"
depends_on: []
estimated_complexity: low
epic: trpc-cutover-and-legacy-tree-cleanup
test_strategy:
  needed: true
  justification: "The change deletes the `cancelHandler` export, which has a sibling test block in `runLifecycle.test.ts` (`describe('cancelHandler', ...)` at line 211). The directory scan (`main/src/orchestrator/__tests__/*.test.ts`) shows runLifecycle.test.ts depends on the symbol — keeping it as-is after the deletion would fail typecheck."
  targets:
    - behavior: "After the cancelHandler export is removed, no test imports a now-missing symbol; the remaining transition tests in runLifecycle.test.ts continue to pass."
      test_file: "main/src/orchestrator/__tests__/runLifecycle.test.ts"
      type: unit
---

# Demote `cyboflow.runs.cancel` to METHOD_NOT_SUPPORTED stub

## Objective

`cyboflow.runs.cancel` delegates to `cancelHandler` through a module-level `cancelDeps` singleton wired by `setCancelDeps()`. The setter is exported but never called in `main/src/index.ts` — three sibling setters (`setCancelAndRestartDeps`, `setStartRunDeps`, `setHealthProvider`) ARE wired at boot, but `setCancelDeps` is not, so any caller of `cyboflow.runs.cancel` gets `METHOD_NOT_SUPPORTED` with a misleading "Call setCancelDeps() at boot" message. The frontend currently calls only `cancelAndRestart` (verified by `grep -rnE "cyboflow.runs.cancel\\." frontend/src` returning 0 hits), so there is no UI regression today. This task demotes the procedure to a clean stub via `throwNotImplemented('workflow-runs')` and deletes the dead `CancelDeps` interface, `cancelHandler` function, and `setCancelDeps` setter — eliminating an entire unused dependency-injection path from the surface area.

This is the lower-risk path of the two options laid out in the compound proposal: wiring it up would require deciding on a `RunExecutor` lookup callback (currently `RunExecutor.cancel()` aborts ALL active runs, not a single `runId`), which is real design work that belongs to the workflow-runs epic when bare `cancel` is reactivated. Demoting now matches the trpc-cutover epic's stated hygiene-task scope ("Pattern A/B consolidation for `setCancelDeps`" listed as out-of-scope deferred work — this is the natural pickup).

## Implementation Steps

1. **Pre-flight grep — confirm no renderer caller.** Run `grep -rnE "cyboflow\\.runs\\.cancel\\." frontend/src` and `grep -rnE "cyboflow\\.runs\\.cancel\\b" frontend/src --include='*.ts' --include='*.tsx'`. Both must return 0 hits before proceeding. (`cancelAndRestart` matches are expected and unaffected — the word-boundary grep on bare `cancel` excludes them.)

2. **Edit `main/src/orchestrator/trpc/routers/runs.ts`** — surgical deletion:
   - Delete the `// cancel dependency bag` comment block (lines 89-96).
   - Delete the `export interface CancelDeps { ... }` declaration (lines 98-108).
   - Delete `let cancelDeps: CancelDeps | null = null;` (line 110).
   - Delete the `setCancelDeps` JSDoc + function (lines 112-122).
   - Delete the `// cancelHandler — extracted for direct testability` comment block AND the entire `export async function cancelHandler(...)` function (lines 124-178).
   - Rewrite the `cancel: protectedProcedure ...` mutation body (lines 227-243) to:
     ```ts
     cancel: protectedProcedure
       .input(z.object({ runId: z.string() }))
       .mutation(() => throwNotImplemented('workflow-runs')),
     ```
   - Remove now-unused imports if they become orphans: `cancelHandler`'s deletion may orphan `TERMINAL_RUN_STATUSES_SQL_IN`, `DatabaseLike`, `LoggerLike`, `ApprovalRouter` — verify each via `grep -n "<symbol>" main/src/orchestrator/trpc/routers/runs.ts` AFTER the deletions; remove the import line for any symbol with 0 remaining references in the file.

3. **Edit `main/src/orchestrator/__tests__/runLifecycle.test.ts`**:
   - Remove `cancelHandler, type CancelDeps` from the import on line 32 (or remove the whole line if no other symbol remains from that module).
   - Delete the entire `describe('cancelHandler', () => { ... })` block (lines 211 through its closing `})`).
   - Keep the AC4 / AC5 transition tests above it (they don't depend on the cancel surface).
   - Update the file header docblock (lines 1-19): remove "AC6: cyboflow.runs.cancel tRPC mutation body is wired (cancelHandler)", "AC7: cancel procedure throws METHOD_NOT_SUPPORTED when deps unwired", "AC8: cancel ordering: clearPendingForRun -> executor.cancel -> DB write", and the `cancelHandler imported directly for ordering/return-value tests` bullet.

4. **Edit `main/src/index.ts`** — confirm no `setCancelDeps` call needs adding/removing. Pre-condition: there is none currently. Post-condition: still none. The `setCancelAndRestartDeps`, `setStartRunDeps`, and `setHealthProvider` calls at lines 744/753/759 are untouched.

5. **Sweep verification (must be re-run by executor as completeness gate):**
   - `grep -rnE "(setCancelDeps|cancelHandler|CancelDeps)" main/src --include='*.ts'` → must return 0 hits.
   - `grep -rnE "cyboflow\\.runs\\.cancel\\." frontend/src` → must return 0 hits.

6. **Verify the test suite.** Run `pnpm --filter main typecheck` (must exit 0), `pnpm --filter main test` (must exit 0). The METHOD_NOT_SUPPORTED test in `router.test.ts` for `cancel` (if any) should still pass because `throwNotImplemented` produces the same error code.

7. **Update file-level docblock at `runs.ts` top (lines 1-10):** the existing comment says "All procedure bodies are deliberate not-implemented placeholders" — this becomes accurate again for `cancel` after the change. No edit required unless the docblock has cancel-specific language; verify by reading lines 1-15 and remove any reference to cancel being implemented.

## Acceptance Criteria

- `cancel` procedure body in `runs.ts` is exactly `.mutation(() => throwNotImplemented('workflow-runs'))`.
- No `CancelDeps`, `setCancelDeps`, `cancelDeps`, or `cancelHandler` symbol remains anywhere in `main/src/`.
- `runLifecycle.test.ts` no longer references `cancelHandler` / `CancelDeps`.
- `pnpm --filter main typecheck` exits 0.
- `pnpm --filter main test` exits 0.
- `grep -rnE "cyboflow\\.runs\\.cancel\\." frontend/src` returns 0 hits (proves no regression).

## Test Strategy

The test impact is mechanical: removing the `cancelHandler` export forces removing the `describe('cancelHandler', ...)` block in `runLifecycle.test.ts` (it imports the deleted symbol — typecheck would fail otherwise). The five transition-handler tests in the same file above that block are unaffected and continue to validate `transitionToFailed`, `transitionToCanceled`, etc. No new tests are added — this is pure surface-area reduction.

## Hardest Decision

**Demote vs. wire.** The proposal listed both as options. Wiring requires a per-run `RunExecutor` lookup, but `RunExecutor.cancel()` currently aborts ALL active runs (no `runId` parameter — see `runExecutor.ts:244`). Building a per-run lookup would need either (a) a new `RunExecutorRegistry: Map<runId, RunExecutor>` (one executor per run instead of the current shared singleton) or (b) splitting `cancel()` into `cancelRun(runId)` + the all-runs sweep. Both are non-trivial workflow-runs-epic design choices. Demoting punts the design decision to that epic and removes dead-code-now (which is the actionable improvement today).

## Rejected Alternatives

- **Wire it now with a stub `lookupExecutor: () => null`.** This would make all cancel calls a no-op DB write — silently misleading. Worse than `METHOD_NOT_SUPPORTED` because the frontend gets a successful response with no actual cancellation. Rejected.
- **Wire it now using the existing `RunExecutor.cancel()` (all-runs).** Semantically wrong: cancelling run A would cancel run B. Rejected outright.
- **Leave the dead code in place pending the workflow-runs epic.** Leaves a misleading "Call setCancelDeps() at boot" error message and ~60 lines of dead surface area. The deferral cost is non-zero (every future reader of `runs.ts` has to figure out why the setter is dead).

Would reconsider demotion-vs-wire if: (a) the workflow-runs epic starts before this lands and we have a concrete `lookupExecutor` design; or (b) a frontend caller is added that depends on bare `cancel`.

## Lowest Confidence Area

The orphan-import removal in step 2. `TERMINAL_RUN_STATUSES_SQL_IN`, `DatabaseLike`, `LoggerLike`, and `ApprovalRouter` types are likely orphaned by the deletion, but `cancelAndRestartHandler`'s imports may transitively rely on some of them via the file's `import { cancelAndRestartHandler, type CancelAndRestartDeps } from '../../cancelAndRestartHandler'` line. Verify each candidate orphan symbol with a `grep -n "<symbol>" main/src/orchestrator/trpc/routers/runs.ts` AFTER the cancel-block deletions before removing import lines — `pnpm --filter main typecheck` will catch any over-removal.
