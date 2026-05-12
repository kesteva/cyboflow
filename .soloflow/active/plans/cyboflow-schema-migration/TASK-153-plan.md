---
id: TASK-153
idea: IDEA-004
idea_id: IDEA-004
status: ready
created: 2026-05-11T00:00:00Z
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
    verification: "vitest --run main/src/services/cyboflow/__tests__/transitions.test.ts exits 0 with at least 4 passing test cases."
  - criterion: "Function signatures use the row types from shared/types/cyboflow.ts (specifically WorkflowRunStatus and ApprovalStatus); no use of `any`."
    verification: "grep -n 'any' main/src/services/cyboflow/transitions.ts returns 0 matches outside comments (the `@typescript-eslint/no-explicit-any` rule is enforced in this repo)."
depends_on: [TASK-152]
estimated_complexity: medium
epic: cyboflow-schema-migration
test_strategy:
  needed: true
  justification: "This helper is the only correctness primitive for the awaiting_review race-condition class. Bugs here directly cause the failure modes spec'd in §5.7 as non-negotiable: races between user approval and run cancellation. Tests must exercise both the happy path and the rejection path under realistic concurrent state."
  targets:
    - behavior: "Happy-path: run is in 'running' state; transitionToAwaitingReview updates the run AND inserts the approval row atomically."
      test_file: "main/src/services/cyboflow/__tests__/transitions.test.ts"
      type: unit
    - behavior: "Stale-status: run is in 'canceled'; transitionToAwaitingReview throws TransitionRejectedError, AND no approval row is inserted."
      test_file: "main/src/services/cyboflow/__tests__/transitions.test.ts"
      type: unit
    - behavior: "Reverse happy-path: run is in 'awaiting_review' AND approval is 'pending'; transitionFromAwaitingReview with decision='approved' updates both atomically."
      test_file: "main/src/services/cyboflow/__tests__/transitions.test.ts"
      type: unit
    - behavior: "Reverse stale-status: run is in 'failed'; transitionFromAwaitingReview throws and the approval row stays 'pending'."
      test_file: "main/src/services/cyboflow/__tests__/transitions.test.ts"
      type: unit
---

# Atomic awaiting_review Co-Write Transaction Helper

## Objective

Implement the single primitive that the `ApprovalRouter` (future epic) will use whenever a workflow_run transitions into or out of `awaiting_review`. Per system design §5.3, every such transition must co-write the run's status change AND the corresponding approvals row inside a `BEGIN IMMEDIATE` transaction with a `WHERE status = 'running'` (or `'awaiting_review'`) guard on the UPDATE. This guard is the **only** race-condition protection between approval routing and run cancellation: if a run is canceled while an approval is about to fire, the UPDATE affects 0 rows, the helper throws, and `better-sqlite3` rolls back the entire transaction (including the approvals INSERT that would otherwise leave an orphan pending approval pointing at a dead run).

This task delivers the helper module plus unit tests. It does NOT wire the helper into the approval flow — that's the `ApprovalRouter` epic's job.

## Implementation Steps

1. **Create new file `main/src/services/cyboflow/transitions.ts`** with two exported functions, a typed error, and no `any` types. Skeleton:

   