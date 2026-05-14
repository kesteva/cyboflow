---
id: TASK-573
title: Call assertTransitionAllowed before each SQL UPDATE in transitions.ts
status: in-flight
epic: wire-sprint-005-services
source: compound/SPRINT-004-005
source_sprint: SPRINT-005
depends_on: []
files_owned:
  - main/src/services/cyboflow/transitions.ts
  - main/src/services/cyboflow/__tests__/transitions.test.ts
files_readonly:
  - main/src/services/cyboflow/stateMachine.ts
  - shared/types/cyboflow.ts
acceptance_criteria:
  - criterion: "`transitionToAwaitingReview` calls `assertTransitionAllowed('running', 'awaiting_review', params.runId)` at the head of the transaction body, BEFORE the `updateRun.run(...)` SQL call. Throws `IllegalTransitionError` if the static table forbids it, even if the DB row is still in 'running' state."
    verification: "grep -nB2 -A1 'assertTransitionAllowed' main/src/services/cyboflow/transitions.ts shows the call inside the `tx = db.transaction(...)` body of `transitionToAwaitingReview` and BEFORE `updateRun.run(`."
  - criterion: "`transitionFromAwaitingReview` calls `assertTransitionAllowed('awaiting_review', 'running', params.runId)` at the head of its transaction body."
    verification: "grep -nE 'assertTransitionAllowed' main/src/services/cyboflow/transitions.ts returns >= 2 matches (one per transition function)."
  - criterion: "The `transitions.test.ts` suite adds at least one test per direction that asserts an `IllegalTransitionError` is thrown when the in-process guard rejects, AND the SQL UPDATE was never reached (verified by row-state inspection — the row's status is unchanged)."
    verification: "grep -nE 'IllegalTransitionError' main/src/services/cyboflow/__tests__/transitions.test.ts returns >= 2 matches; the test file's `pnpm --filter main exec vitest run main/src/services/cyboflow/__tests__/transitions.test.ts` exits 0."
  - criterion: "`pnpm typecheck` and `pnpm --filter main exec vitest run` pass."
    verification: Exit code 0 for both.
estimated_complexity: low
test_strategy:
  needed: true
  justification: Sibling test `main/src/services/cyboflow/__tests__/transitions.test.ts` exists and is the canonical home for transitions behavior. New AC requires two new test cases (one per direction) covering the in-process guard firing BEFORE the SQL UPDATE.
  targets:
    - behavior: Calling `transitionToAwaitingReview` with a current status that the state-machine table forbids throws `IllegalTransitionError` and leaves the row unmodified.
      test_file: main/src/services/cyboflow/__tests__/transitions.test.ts
      type: unit
    - behavior: Calling `transitionFromAwaitingReview` with a current status that the state-machine table forbids throws `IllegalTransitionError` and leaves the row unmodified.
      test_file: main/src/services/cyboflow/__tests__/transitions.test.ts
      type: unit
prerequisites: []
---
# Call assertTransitionAllowed in transitions.ts

## Problem

`main/src/services/cyboflow/transitions.ts` mutates `workflow_runs.status`
via raw SQL UPDATE with an `AND status = <expected>` guard. The in-process
`assertTransitionAllowed()` function (from `stateMachine.ts:71`) is tested
but has zero production callers per:

```
grep -rn 'assertTransitionAllowed' main/src --include='*.ts' | grep -v __tests__ | grep -v 'cyboflow/stateMachine.ts'
```

returns 0 matches. The SQL guard catches the *current-row-state*
mismatch (0-row UPDATE → `TransitionRejectedError`), but if a future
maintainer changes the SQL literal (e.g. typos `'running'` as `'runing'`
in the WHERE clause, or swaps two transition functions), no in-process
guard fires. The `ALLOWED_TRANSITIONS` table in `stateMachine.ts` is the
intended single source of truth.

## Proposed Direction (Implementation Steps)

1. **Pre-flight read.** Confirm the current shape of `transitions.ts`:
   - `transitionToAwaitingReview`: lines 42-77. The `db.transaction(...)`
     body starts at line 58. The SQL UPDATE at line 59 is the first
     statement.
   - `transitionFromAwaitingReview`: lines 94-133. Transaction body at
     line 111.

2. Edit `main/src/services/cyboflow/transitions.ts`:
   - Add the import at the top:
     ```ts
     import { assertTransitionAllowed } from './stateMachine';
     ```
   - Inside `transitionToAwaitingReview`'s transaction body (line 58),
     INSERT a call as the very first line, BEFORE `updateRun.run(...)`:
     ```ts
     const tx = db.transaction((p: TransitionToAwaitingReviewParams) => {
       assertTransitionAllowed('running', 'awaiting_review', p.runId);
       const result = updateRun.run({ runId: p.runId });
       // ... rest unchanged
     });
     ```
   - Inside `transitionFromAwaitingReview`'s transaction body (line 111),
     INSERT the same pattern with the other direction:
     ```ts
     const tx = db.transaction((p: TransitionFromAwaitingReviewParams) => {
       assertTransitionAllowed('awaiting_review', 'running', p.runId);
       const runResult = updateRun.run({ runId: p.runId });
       // ... rest unchanged
     });
     ```
   - Note: both transitions are statically `from -> to` known at function
     authorship time, so we hardcode the literals — this is a coverage of
     the static-table contract, not a dynamic dispatch.

3. Open `main/src/services/cyboflow/__tests__/transitions.test.ts`. Add
   two new `it()` blocks:
   - **"throws IllegalTransitionError if guard table rejects
     transitionToAwaitingReview".** Setup: pre-populate workflow_runs row
     with status='completed' (a terminal state). Call
     `transitionToAwaitingReview(...)`. Expected: throws
     `IllegalTransitionError` (NOT `TransitionRejectedError`); confirm
     the row's status is still 'completed' (UPDATE was never reached).
     Note: this is subtly different from the existing TransitionRejected
     tests — the existing tests would have the row in 'awaiting_review'
     (UPDATE hits, 0 rows changed because status guard fails). The new
     test has the row in a state where the static table forbids the
     transition entirely.
   - **"throws IllegalTransitionError if guard table rejects
     transitionFromAwaitingReview".** Similar setup with status='completed'.

4. Run `pnpm typecheck` and
   `pnpm --filter main exec vitest run main/src/services/cyboflow/__tests__/transitions.test.ts`.
   Both must pass.

## Acceptance Criteria

(See frontmatter.)

## Test Strategy

Two new test cases in the existing `transitions.test.ts` (sibling test that
already exercises the SQL guard via `TransitionRejectedError`). The new
tests exercise the in-process guard via `IllegalTransitionError` and
verify the SQL never runs. See AC verification for the grep gate.

## Hardest Decision

**Where in the transaction to assert.** Three options:
- **(A) First statement inside the transaction callback** (chosen).
  Throws before any SQL touches; better-sqlite3 auto-rolls back. Matches
  the natural placement.
- **(B) Before `db.transaction(...)` is called at all.** Even earlier —
  no transaction overhead. But the existing pattern is "transaction
  wraps everything atomic"; pulling the assertion outside would split
  the validation/execution boundary.
- **(C) Inside `updateRun.run` via a CHECK constraint.** SQL-only —
  would be the strongest guarantee but breaks the in-process-guard
  intent (the whole point of `assertTransitionAllowed` is to surface a
  named TS error, not an SQLITE_CONSTRAINT message).

(A) is the compounder's suggestion and matches the existing
`TransitionRejectedError` placement.

## Rejected Alternatives

- **(B) above.** Rejected — clutters the call sites and breaks the
  "transaction = atomic envelope" mental model.
- **(C) SQL CHECK constraint.** Rejected — the static table evolves
  faster than a DB migration, and the typed TS error is more useful to
  callers than a generic SQLITE_CONSTRAINT.
- **Add the assertion only inside the SQL `AND status = ?` guard via
  a stored procedure.** SQLite doesn't have procedures; not viable.

## Lowest Confidence Area

The error-flow contract: when the assertion fires, the existing test
suite asserts a `TransitionRejectedError`. The new tests assert
`IllegalTransitionError`. Both are valid throws but the type is different.
If any production caller does
`catch (e) { if (e instanceof TransitionRejectedError) ... }`,
it will silently miss the new `IllegalTransitionError`. Risk is low —
production callers are currently zero (per the umbrella problem
statement) — but the executor should grep for `TransitionRejectedError`
catches after wiring lands (i.e. after TASK-572) and decide whether to
broaden the catches or wrap the new throw.
