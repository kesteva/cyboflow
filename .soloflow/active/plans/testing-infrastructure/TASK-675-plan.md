---
id: TASK-675
idea: SPRINT-025-compounder
status: ready
created: 2026-05-20T00:00:00Z
files_owned:
  - main/src/database/__tests__/cyboflowSchema.test.ts
files_readonly:
  - main/src/database/database.ts
  - main/src/database/migrations/006_cyboflow_schema.sql
  - main/src/database/migrations/007_add_stuck_reason.sql
  - main/src/orchestrator/stuckDetector.ts
acceptance_criteria:
  - criterion: "The test case 'rebuilds the table when worktree_path is NOT NULL (canonical is nullable) or stuck_detected_at orphan column exists' passes on `main`."
    verification: "Run `pnpm --filter @cyboflow/main test -- cyboflowSchema.test.ts` from the repo root; exit code 0 and the named case appears in the passing list."
  - criterion: "The test reflects the actual production contract: `stuck_detected_at` is NOT an orphan column — it is added by migration 007 and re-added by `reconcileWorkflowRunsSchema()` at `main/src/database/database.ts:1360-1363`. After reconciliation, `stuck_detected_at` MUST be present on `workflow_runs`."
    verification: "grep -n 'stuck_detected_at' main/src/database/__tests__/cyboflowSchema.test.ts confirms the assertion at line 680 has flipped from `toBe(false)` (column gone) to `toBe(true)` or `toContain('stuck_detected_at')` (column present)."
  - criterion: "Other test invariants in the same case remain intact: worktree_path becomes nullable after rebuild; permission_mode_snapshot defaults to 'default'; the seed row 'run-preserve' survives; an INSERT without worktree_path succeeds."
    verification: "Read the updated test body and confirm all five sub-assertions (worktree_path notnull=0, stuck_detected_at present, permission_mode_snapshot default, preserved row data, INSERT without worktree_path) are still present."
  - criterion: "The other 2 reconciler test cases ('adds permission_mode_snapshot...' and 'is a no-op on a fresh install...') continue to pass."
    verification: "Same vitest invocation as above — all 3 cases in the `workflow_runs reconciler (post-006 in-place edits)` describe block pass."
depends_on: []
estimated_complexity: low
epic: testing-infrastructure
test_strategy:
  needed: true
  justification: "This task IS a test fix. The 'test' being modified is the failing case itself."
  targets:
    - behavior: "After Tier 1 + Tier 2 reconciliation on a pre-edit 006 install, stuck_detected_at column IS present (added back by the post-Tier-2 idempotent ALTER at database.ts:1360)."
      test_file: "main/src/database/__tests__/cyboflowSchema.test.ts"
      type: integration
---

# Fix stale cyboflowSchema.test.ts assertion that expected stuck_detected_at to be dropped

## Objective

The test at `main/src/database/__tests__/cyboflowSchema.test.ts:680` asserts that `stuck_detected_at` is removed from `workflow_runs` after the Tier 2 reconciler rebuild. This is wrong: `stuck_detected_at` is a legitimate column added by migration `007_add_stuck_reason.sql` and **re-added** by `reconcileWorkflowRunsSchema()` at `database.ts:1360-1363`. The reconciler's Tier 2 rebuild drops it momentarily, but the Tier 1 ALTER (run on subsequent initialize) restores it. The production-intent comment at `database.ts:1354-1359` explicitly documents this fix-up: "StuckDetector.prepare() throws SqliteError on boot when it's absent". The test must be updated to match production intent.

## Implementation Steps

1. **Confirm production intent.** Re-read `main/src/database/database.ts:1354-1363` to verify the reconciler adds `stuck_detected_at` back unconditionally on any initialize where the column is missing. Re-read `main/src/database/migrations/007_add_stuck_reason.sql` to confirm the column is part of the canonical post-006 schema.

2. **Update assertion in `cyboflowSchema.test.ts:680`.** The current line reads:
   ```ts
   expect(cols.some((c) => c.name === 'stuck_detected_at')).toBe(false);
   ```
   Change it to:
   ```ts
   // stuck_detected_at is added by migration 007 and re-added by Tier 1 of
   // reconcileWorkflowRunsSchema (database.ts:1360-1363) even after a Tier 2
   // rebuild — StuckDetector.prepare() requires it on boot.
   expect(cols.some((c) => c.name === 'stuck_detected_at')).toBe(true);
   ```

3. **Update the describe-block title and JSDoc.** The current title (`cyboflowSchema.test.ts:621`) reads: `'rebuilds the table when worktree_path is NOT NULL (canonical is nullable) or stuck_detected_at orphan column exists'`. The `or stuck_detected_at orphan column` phrasing is now inaccurate. Change to:
   ```
   'rebuilds the table when worktree_path is NOT NULL (canonical is nullable); preserves stuck_detected_at (added by migration 007)'
   ```
   Update the corresponding inline comment block (around line 666) from `Tier 2 rebuilds to drop the NOT NULL on worktree_path and remove stuck_detected_at.` to `Tier 2 rebuilds to drop the NOT NULL on worktree_path; Tier 1 then re-adds stuck_detected_at (migration 007 column).`

4. **Run the file in isolation:**
   ```bash
   pnpm --filter @cyboflow/main test -- cyboflowSchema.test.ts
   ```
   Expected: all cases (including the 3 reconciler cases) pass.

5. **Run the full main workspace test suite** to catch any other place that asserts on `stuck_detected_at` being absent (per the grep evidence, there are at least 7 other tests in `inspectorQueries.test.ts` and `stuckDetector.test.ts` that ASSERT presence — none assert absence, so no regression expected):
   ```bash
   pnpm --filter @cyboflow/main test
   ```

## Acceptance Criteria

See frontmatter. The Tier 2 reconciler test passes; the `stuck_detected_at` assertion is inverted to expect presence; other reconciler cases and other tests across the suite continue to pass.

## Test Strategy

This task updates one failing test case in `main/src/database/__tests__/cyboflowSchema.test.ts`. No new test files are required. The updated assertion documents the real reconciler contract: `stuck_detected_at` IS canonical post-007 and must always be present after `initialize()`.

## Hardest Decision

**Whether to fix the test (chosen) or fix production code to actually drop the column (rejected).** The IDEA proposed either (a) fix reconciler to drop orphan column, or (b) update test if behavior is intentional. Evidence weighs decisively toward (b):
- `database.ts:1354-1359` has a 5-line JSDoc explicitly explaining why the column MUST be present — `StuckDetector.prepare()` throws `SqliteError` on boot otherwise, cascading into ApprovalRouter never initializing.
- `migrations/007_add_stuck_reason.sql` adds the column as canonical post-006 schema.
- 7+ other tests across `inspectorQueries.test.ts`, `stuckDetector.test.ts`, and `runs.ts` (TRPC router) assert the column IS present.
- Only ONE test asserts it should be absent — and that assertion was likely authored before migration 007 existed.

The "orphan column" framing in the test was the original author's mental model; migration 007 made it canonical and the orphan framing became stale.

## Rejected Alternatives

- **Modify the Tier 1 reconciler to NOT re-add `stuck_detected_at` after Tier 2 rebuild.** Rejected because it would break `StuckDetector` on boot for any installer who triggers a Tier 2 rebuild, per the production-side JSDoc. Would change if we also moved the column add into Tier 2's CREATE TABLE statement — but that's a larger refactor that's out of scope and offers no improvement over today's behavior.
- **Mark the test as `.skip()`.** Rejected — the test exercises real Tier 2 rebuild behavior (worktree_path nullability, data preservation, INSERT path). Only the one stale assertion needs flipping.

## Lowest Confidence Area

Whether the Tier 2 rebuild executes BEFORE the Tier 1 `stuck_detected_at` add on the second `initialize()` pass. Reading `database.ts:1330-1421` carefully: Tier 1 adds run at lines 1342-1363, the Tier 2 rebuild at 1378-1418, and the rebuild's `INSERT INTO ... SELECT` does explicitly include `stuck_detected_at` (lines 1405-1410), so the column survives the rebuild. On a SECOND initialize, Tier 1 runs again and is a no-op (column already present). The single-pass flow keeps the column on disk. If a future change ever reorders these (Tier 2 before Tier 1), the assertion would still pass because Tier 2's CREATE TABLE includes `stuck_detected_at INTEGER` at line 1394. Confidence: high.
