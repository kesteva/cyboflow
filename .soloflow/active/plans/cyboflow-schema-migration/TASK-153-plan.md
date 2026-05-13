---
id: TASK-153
idea: IDEA-004
idea_id: IDEA-004
status: ready
created: "2026-05-11T00:00:00Z"
files_owned:
  - main/src/services/cyboflow/transitions.ts
  - main/src/services/cyboflow/__tests__/transitions.test.ts
files_readonly:
  - main/src/database/database.ts
  - main/src/services/database.ts
  - main/src/database/migrations/006_cyboflow_schema.sql
  - shared/types/cyboflow.ts
  - docs/cyboflow_system_design.md
  - .soloflow/active/research/ROADMAP-001-research-architecture.md
acceptance_criteria:
  - criterion: "File `main/src/services/cyboflow/transitions.ts` exists and exports a `transitionToAwaitingReview(db, params)` function that, in a single BEGIN IMMEDIATE transaction, UPDATEs workflow_runs SET status='awaiting_review' WHERE id = ? AND status = 'running' AND INSERTs the approvals row."
    verification: "grep -nE 'export function transitionToAwaitingReview' main/src/services/cyboflow/transitions.ts returns 1 match. grep -n \"AND status\\s*=\\s*'running'\" main/src/services/cyboflow/transitions.ts returns at least 1 match (the status guard on the UPDATE). grep -nE '\\.immediate\\(' or 'db.transaction' followed by '.immediate' returns 1 match (BEGIN IMMEDIATE)."
  - criterion: "If the UPDATE affects 0 rows (run is not in 'running' state — e.g., it was canceled or already in awaiting_review), the helper THROWS a typed `TransitionRejectedError` and the approvals INSERT is rolled back (better-sqlite3 transactions auto-rollback on throw)."
    verification: "grep -nE 'class TransitionRejectedError|TransitionRejectedError' main/src/services/cyboflow/transitions.ts returns at least 2 matches (class definition and throw site). The throw is inside the transaction body, conditioned on `result.changes === 0`."
  - criterion: "Helper exposes a second function `transitionFromAwaitingReview(db, params)` that mirrors the same atomicity for the reverse transition: UPDATE workflow_runs SET status='running' WHERE id = ? AND status='awaiting_review' AND UPDATE approvals SET status=?, decided_at=CURRENT_TIMESTAMP, decided_by=? WHERE id = ? AND status='pending'."
    verification: "grep -nE 'export function transitionFromAwaitingReview' main/src/services/cyboflow/transitions.ts returns 1 match. The function uses BEGIN IMMEDIATE and includes both status guards."
  - criterion: "Unit tests cover: (a) happy-path awaiting_review write succeeds, (b) UPDATE with stale status (run is 'canceled') throws TransitionRejectedError AND the approvals row was NOT inserted, (c) reverse transition with valid approve→running succeeds, (d) reverse transition when run is in 'failed' state throws and approval status remains 'pending'."
    verification: vitest --run main/src/services/cyboflow/__tests__/transitions.test.ts exits 0 with at least 4 passing test cases.
  - criterion: Function signatures use the row types from shared/types/cyboflow.ts (specifically WorkflowRunStatus and ApprovalStatus); no use of `any`.
    verification: "grep -n 'any' main/src/services/cyboflow/transitions.ts returns 0 matches outside comments (the `@typescript-eslint/no-explicit-any` rule is enforced in this repo)."
depends_on:
  - TASK-152
estimated_complexity: medium
epic: cyboflow-schema-migration
test_strategy:
  needed: true
  justification: "This helper is the only correctness primitive for the awaiting_review race-condition class. Bugs here directly cause the failure modes spec'd in §5.7 as non-negotiable: races between user approval and run cancellation. Tests must exercise both the happy path and the rejection path under realistic concurrent state."
  targets:
    - behavior: "Happy-path: run is in 'running' state; transitionToAwaitingReview updates the run AND inserts the approval row atomically."
      test_file: main/src/services/cyboflow/__tests__/transitions.test.ts
      type: unit
    - behavior: "Stale-status: run is in 'canceled'; transitionToAwaitingReview throws TransitionRejectedError, AND no approval row is inserted."
      test_file: main/src/services/cyboflow/__tests__/transitions.test.ts
      type: unit
    - behavior: "Reverse happy-path: run is in 'awaiting_review' AND approval is 'pending'; transitionFromAwaitingReview with decision='approved' updates both atomically."
      test_file: main/src/services/cyboflow/__tests__/transitions.test.ts
      type: unit
    - behavior: "Reverse stale-status: run is in 'failed'; transitionFromAwaitingReview throws and the approval row stays 'pending'."
      test_file: main/src/services/cyboflow/__tests__/transitions.test.ts
      type: unit
---
# Atomic awaiting_review Co-Write Transaction Helper

## Objective

Implement the single primitive that the `ApprovalRouter` (future epic) will use whenever a workflow_run transitions into or out of `awaiting_review`. Per system design §5.3, every such transition must co-write the run's status change AND the corresponding approvals row inside a `BEGIN IMMEDIATE` transaction with a `WHERE status = 'running'` (or `'awaiting_review'`) guard on the UPDATE. This guard is the **only** race-condition protection between approval routing and run cancellation: if a run is canceled while an approval is about to fire, the UPDATE affects 0 rows, the helper throws, and `better-sqlite3` rolls back the entire transaction (including the approvals INSERT that would otherwise leave an orphan pending approval pointing at a dead run).

This task delivers the helper module plus unit tests. It does NOT wire the helper into the approval flow — that's the `ApprovalRouter` epic's job.

## Implementation Steps

1. **Create new file `main/src/services/cyboflow/transitions.ts`** with two exported functions, a typed error, and no `any` types. The file imports `Database` from `better-sqlite3` (type-only) and the row-type unions from `shared/types/cyboflow.ts` (`WorkflowRunStatus`, `ApprovalStatus`). It uses better-sqlite3's `db.transaction(fn).immediate()` form so SQLite emits `BEGIN IMMEDIATE` rather than the default deferred `BEGIN` (see Hardest Decision below for why this is non-negotiable). Skeleton:

   ```ts
   import type Database from 'better-sqlite3';
   import type { ApprovalStatus, WorkflowRunStatus } from '../../../../shared/types/cyboflow';

   /**
    * Thrown when a state transition is rejected because the source row was no
    * longer in the expected status (e.g. the run was canceled before the
    * approval write landed). better-sqlite3 auto-rolls back the surrounding
    * transaction when this propagates out.
    */
   export class TransitionRejectedError extends Error {
     readonly code = 'TRANSITION_REJECTED' as const;
     constructor(
       message: string,
       readonly details: {
         runId: string;
         expectedStatus: WorkflowRunStatus | ApprovalStatus;
         entity: 'workflow_run' | 'approval';
       },
     ) {
       super(message);
       this.name = 'TransitionRejectedError';
     }
   }

   export interface TransitionToAwaitingReviewParams {
     runId: string;
     approvalId: string;
     toolName: string;
     toolInputJson: string;
     toolUseId: string;
     rationale: string | null;
   }

   /**
    * Atomically: (1) UPDATE workflow_runs SET status='awaiting_review' WHERE
    * id = ? AND status = 'running'; (2) INSERT INTO approvals (..., status='pending').
    * Runs inside BEGIN IMMEDIATE so the RESERVED lock is acquired up front
    * (closes the SELECT-then-INSERT race with concurrent cancellations).
    * Throws TransitionRejectedError if the UPDATE affects 0 rows; the INSERT
    * is rolled back automatically.
    */
   export function transitionToAwaitingReview(
     db: Database.Database,
     params: TransitionToAwaitingReviewParams,
   ): void {
     const updateRun = db.prepare(
       `UPDATE workflow_runs
           SET status = 'awaiting_review', updated_at = CURRENT_TIMESTAMP
         WHERE id = @runId AND status = 'running'`,
     );
     const insertApproval = db.prepare(
       `INSERT INTO approvals
          (id, run_id, tool_name, tool_input_json, tool_use_id, rationale, status)
        VALUES
          (@approvalId, @runId, @toolName, @toolInputJson, @toolUseId, @rationale, 'pending')`,
     );

     const tx = db.transaction((p: TransitionToAwaitingReviewParams) => {
       const result = updateRun.run({ runId: p.runId });
       if (result.changes === 0) {
         throw new TransitionRejectedError(
           `Cannot transition run ${p.runId} to awaiting_review: not in 'running' state`,
           { runId: p.runId, expectedStatus: 'running', entity: 'workflow_run' },
         );
       }
       insertApproval.run({
         approvalId: p.approvalId,
         runId: p.runId,
         toolName: p.toolName,
         toolInputJson: p.toolInputJson,
         toolUseId: p.toolUseId,
         rationale: p.rationale,
       });
     });

     tx.immediate(params);
   }

   export interface TransitionFromAwaitingReviewParams {
     runId: string;
     approvalId: string;
     decision: Exclude<ApprovalStatus, 'pending'>; // 'approved' | 'rejected' | 'timed_out'
     decidedBy: string;
   }

   /**
    * Atomically: (1) UPDATE workflow_runs SET status='running' WHERE id = ?
    * AND status = 'awaiting_review'; (2) UPDATE approvals SET status=@decision,
    * decided_at=CURRENT_TIMESTAMP, decided_by=@decidedBy WHERE id=@approvalId
    * AND status='pending'. Same BEGIN IMMEDIATE + status-guard pattern. If
    * either UPDATE affects 0 rows, throws TransitionRejectedError and the
    * partial work is rolled back.
    */
   export function transitionFromAwaitingReview(
     db: Database.Database,
     params: TransitionFromAwaitingReviewParams,
   ): void {
     const updateRun = db.prepare(
       `UPDATE workflow_runs
           SET status = 'running', updated_at = CURRENT_TIMESTAMP
         WHERE id = @runId AND status = 'awaiting_review'`,
     );
     const updateApproval = db.prepare(
       `UPDATE approvals
           SET status = @decision,
               decided_at = CURRENT_TIMESTAMP,
               decided_by = @decidedBy
         WHERE id = @approvalId AND status = 'pending'`,
     );

     const tx = db.transaction((p: TransitionFromAwaitingReviewParams) => {
       const runResult = updateRun.run({ runId: p.runId });
       if (runResult.changes === 0) {
         throw new TransitionRejectedError(
           `Cannot transition run ${p.runId} out of awaiting_review: not in 'awaiting_review' state`,
           { runId: p.runId, expectedStatus: 'awaiting_review', entity: 'workflow_run' },
         );
       }
       const approvalResult = updateApproval.run({
         approvalId: p.approvalId,
         decision: p.decision,
         decidedBy: p.decidedBy,
       });
       if (approvalResult.changes === 0) {
         throw new TransitionRejectedError(
           `Cannot decide approval ${p.approvalId}: not in 'pending' state`,
           { runId: p.runId, expectedStatus: 'pending', entity: 'approval' },
         );
       }
     });

     tx.immediate(params);
   }
   ```

   Notes:
   - The import path for `shared/types/cyboflow` must match the tsconfig's `paths` mapping or the repo's existing `../../../../shared/...` relative pattern used elsewhere in `main/src/services/`. Verify by `grep -rn "from.*shared/types" main/src/services/ | head -5` before writing the import.
   - `db.transaction(fn).immediate(args)` is the better-sqlite3 idiom for emitting `BEGIN IMMEDIATE` instead of the default `BEGIN` (which is `BEGIN DEFERRED`). The `.immediate` modifier is a property on the returned wrapped function, not a separate API.
   - The `WorkflowRunStatus` and `ApprovalStatus` union types are owned by TASK-152 (`shared/types/cyboflow.ts`); this task only imports them.
   - No `any`: every parameter and result type is explicit. `Database.Database` is the better-sqlite3 instance type.

2. **Create new test file `main/src/services/cyboflow/__tests__/transitions.test.ts`** with the 4 unit-test cases from the frontmatter `test_strategy.targets`. The harness pattern:
   - `beforeEach`: open a fresh in-memory `better-sqlite3` database (`new Database(':memory:')`), apply the `006_cyboflow_schema.sql` migration text directly (read the file with `fs.readFileSync` and run via `db.exec`), then seed one `workflows` row and one `workflow_runs` row with the status the test requires.
   - Case (a) happy-path: seed run with `status='running'`. Call `transitionToAwaitingReview(...)`. Assert `workflow_runs.status === 'awaiting_review'` AND a matching approvals row exists with `status='pending'`.
   - Case (b) stale-status: seed run with `status='canceled'`. Expect `transitionToAwaitingReview(...)` to throw `TransitionRejectedError`. After the throw, assert the run is still `'canceled'` AND `SELECT COUNT(*) FROM approvals WHERE id = ?` returns `0` (proves the INSERT rolled back).
   - Case (c) reverse happy-path: seed run with `status='awaiting_review'` and an approval row with `status='pending'`. Call `transitionFromAwaitingReview(..., decision: 'approved')`. Assert run is now `'running'` AND approval is `'approved'` with `decided_at` non-null and `decided_by` set.
   - Case (d) reverse stale-status: seed run with `status='failed'`. Expect `transitionFromAwaitingReview(...)` to throw. Assert the approval row's `status` is still `'pending'` and `decided_at IS NULL`.
   - Each case asserts on `instanceof TransitionRejectedError` (not just any thrown Error) and on the `code === 'TRANSITION_REJECTED'` discriminator.

3. **Run the verification greps from frontmatter.** Each acceptance criterion has a `verification:` field; run each one and confirm the expected match count. Specifically:
   - `grep -nE 'export function transitionToAwaitingReview' main/src/services/cyboflow/transitions.ts` → 1 match
   - `grep -nE 'export function transitionFromAwaitingReview' main/src/services/cyboflow/transitions.ts` → 1 match
   - `grep -n "AND status\s*=\s*'running'" main/src/services/cyboflow/transitions.ts` → ≥ 1 match
   - `grep -nE '\.immediate\(' main/src/services/cyboflow/transitions.ts` → ≥ 1 match (two, actually — one per helper)
   - `grep -nE 'class TransitionRejectedError|TransitionRejectedError' main/src/services/cyboflow/transitions.ts` → ≥ 2 matches
   - `grep -n '\bany\b' main/src/services/cyboflow/transitions.ts` → 0 matches outside comments

4. **Run `pnpm --filter main test main/src/services/cyboflow/__tests__/transitions.test.ts`** (or the vitest equivalent for this workspace) and confirm all 4 cases pass.

5. **Run `pnpm typecheck` and `pnpm lint`** to confirm the file is clean across the workspace (no `no-explicit-any` violations, no unused imports, no missing type annotations).

## Acceptance Criteria

The five frontmatter criteria collectively gate this task. (1) `transitions.ts` must exist and export `transitionToAwaitingReview` with the `BEGIN IMMEDIATE` transaction body that UPDATEs `workflow_runs` under a `status = 'running'` guard and INSERTs the approvals row. (2) A `TransitionRejectedError` class must be defined and thrown inside the transaction whenever `result.changes === 0`, so better-sqlite3 auto-rolls back the INSERT. (3) A mirror `transitionFromAwaitingReview` helper must implement the reverse path with the same atomicity discipline and a `status = 'awaiting_review'` / `status = 'pending'` double guard. (4) The unit-test file at `main/src/services/cyboflow/__tests__/transitions.test.ts` must exercise the four cases (forward happy, forward stale, reverse happy, reverse stale) and pass under vitest. (5) The file must use the row-type unions from `shared/types/cyboflow.ts` and contain no `any` types — the repo-wide `@typescript-eslint/no-explicit-any: error` rule enforces this in CI.

## Test Strategy

Unit tests are mandatory here because this helper is the only correctness primitive guarding the awaiting_review race. The four cases map 1:1 to the four `test_strategy.targets` entries in the frontmatter:

- **Forward happy-path** proves that the normal flow (running → awaiting_review with new approvals row) is atomic and observable.
- **Forward stale-status** proves the race-condition fix: if a run was canceled between the policy decision and the transaction body, the UPDATE finds 0 rows, the helper throws, and the approvals INSERT is rolled back. This is the failure mode `§5.7` calls "non-negotiable" — an orphan `pending` approval pointing at a dead run would deadlock the review queue.
- **Reverse happy-path** proves the symmetric exit path (awaiting_review → running on user approval) co-writes the decision and the resumption atomically.
- **Reverse stale-status** proves the same race protection in reverse: if a run failed (e.g., the underlying CLI crashed) while a user was deliberating in the UI, the approval cannot be flipped to `approved` against a `failed` run.

All four tests use a fresh `:memory:` SQLite database per case to keep state isolated. The test harness loads the actual `006_cyboflow_schema.sql` via `db.exec` rather than reproducing schema inline — this also serves as an end-to-end smoke that the migration text from TASK-152 is consumable.

## Hardest Decision

**`BEGIN IMMEDIATE` vs default `BEGIN DEFERRED`.** SQLite's default transaction mode is `DEFERRED`: locks are not acquired until the first write statement runs. With `DEFERRED`, two concurrent transactions can both pass their initial SELECT/UPDATE attempt before either commits, and the second one to write will receive `SQLITE_BUSY`. better-sqlite3 retries `SQLITE_BUSY` automatically within `busy_timeout`, but the retry runs the transaction body *again from the top* — meaning our status-guard UPDATE re-evaluates against the now-committed state and can correctly return 0 changes. That sounds safe, but it has a subtle failure: the retry semantics are not documented as a public guarantee across better-sqlite3 versions, and the retry behavior interacts badly with prepared-statement side effects if the transaction body ever performs a non-idempotent read before the guarded write. `BEGIN IMMEDIATE` eliminates the ambiguity entirely: it acquires the `RESERVED` lock at transaction start, so concurrent writers serialize at the lock-acquisition boundary rather than at first write. The classic race — two transactions both observing `status='running'` via SELECT and both attempting to INSERT — cannot occur because the second writer blocks before its SELECT even runs. The 1-line cost (`tx.immediate(params)` instead of `tx(params)`) is trivial; the correctness guarantee is mandatory.

## Rejected Alternatives

- **Use `SELECT ... FOR UPDATE` to lock the row before the UPDATE.** Rejected — SQLite has no row-level locks and no `FOR UPDATE` syntax. The whole-database `RESERVED` lock that `BEGIN IMMEDIATE` acquires is the closest equivalent and is what we use.
- **Skip the status guard and rely on a separate "cancel" mutex.** Rejected — would require every cancel path to know about every approval path. The status-guard UPDATE is a local invariant that does not require global coordination; the mutex approach moves complexity from the DB layer into the orchestrator and creates a new class of "forgot to acquire the mutex" bugs.
- **Two separate transactions (UPDATE run, then INSERT approval) with application-level compensating rollback on the INSERT failure.** Rejected — there is no way to compensate for a successful UPDATE if the process crashes between transactions. The whole point of the helper is atomicity; splitting it defeats the purpose.
- **Put the helper as a method on `DatabaseService` instead of a standalone module.** Rejected — `DatabaseService` is already a 2700-line god-object (see `main/src/database/database.ts`). The Cyboflow extension surface deserves its own namespace (`main/src/services/cyboflow/`) so the `ApprovalRouter` epic and future state-machine work have a clean import target.

## Lowest Confidence Area

The test harness's ability to *meaningfully* exercise concurrent transactions against better-sqlite3, which is fundamentally synchronous. A single-threaded test cannot truly interleave two transactions — both will run to completion in order, so the race we care about (two concurrent writers) cannot be reproduced inside one Node process. What the tests *can* prove is the local invariant: given a row in the wrong state at transaction start, the helper rejects atomically. That is sufficient for the AC, because `BEGIN IMMEDIATE` reduces the multi-process race to "is the status correct when the transaction body runs?" — and the tests answer that question by seeding the row in the wrong state up front. Verification path: if reviewers push back asking for a true concurrency test, the answer is "run two `node -e '...'` processes against a shared on-disk DB file with `journal_mode=WAL` and observe that exactly one transaction succeeds." That smoke is out of scope for this unit-test file but can be appended as a manual repro under `docs/cyboflow-debug/` if a regression is ever suspected. If the implementer cannot confidently construct the four single-process tests, **ESCALATE TO HUMAN** before inventing a concurrency mock.
