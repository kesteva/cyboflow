---
id: TASK-154
idea: IDEA-004
idea_id: IDEA-004
status: ready
created: 2026-05-11T00:00:00Z
files_owned:
  - main/src/services/cyboflow/stateMachine.ts
  - main/src/services/cyboflow/__tests__/stateMachine.test.ts
files_readonly:
  - shared/types/cyboflow.ts
  - main/src/database/migrations/006_cyboflow_schema.sql
  - main/src/services/cyboflow/transitions.ts
  - docs/cyboflow_system_design.md
  - .soloflow/active/research/ROADMAP-001-research-architecture.md
acceptance_criteria:
  - criterion: "File `main/src/services/cyboflow/stateMachine.ts` exports a constant `ALLOWED_TRANSITIONS` mapping every WorkflowRunStatus to the set of statuses it may transition to."
    verification: "grep -nE 'export const ALLOWED_TRANSITIONS' main/src/services/cyboflow/stateMachine.ts returns 1 match. The constant covers all 8 source states: queued, starting, running, awaiting_review, stuck, completed, failed, canceled."
  - criterion: "Terminal states (completed, failed, canceled) map to an empty set (no outgoing transitions allowed)."
    verification: "grep -nE \"completed:\\s*\\[\\]\" or similar empty-array pattern is present for completed, failed, canceled in the ALLOWED_TRANSITIONS constant. Unit tests assert that isTransitionAllowed('completed', '<anything>') === false."
  - criterion: "Function `isTransitionAllowed(from: WorkflowRunStatus, to: WorkflowRunStatus): boolean` returns true for valid transitions and false for forbidden ones."
    verification: "grep -nE 'export function isTransitionAllowed' main/src/services/cyboflow/stateMachine.ts returns 1 match. Tests cover the explicit forbidden list: completed→*, failed→*, canceled→*, queued→awaiting_review, queued→running, awaiting_review→completed (without running first)."
  - criterion: "Function `assertTransitionAllowed(from, to, runId?)` throws a typed `IllegalTransitionError` with the from/to/runId in the message when the transition is forbidden."
    verification: "grep -nE 'export (function|class) (assertTransitionAllowed|IllegalTransitionError)' main/src/services/cyboflow/stateMachine.ts returns 2 matches. Tests assert the throw and the error message contains both from and to."
  - criterion: "Allowed transitions match the system design §5.3 spec: queued→{starting,canceled}; starting→{running,failed,canceled}; running→{awaiting_review,completed,failed,canceled,stuck}; awaiting_review→{running,canceled,stuck,failed}; stuck→{running,canceled,failed}; terminal states (completed, failed, canceled) → none."
    verification: "Inspect ALLOWED_TRANSITIONS; each source-state's allowed-set matches the list above. Unit tests cover at least one allowed and one forbidden transition per source state."
  - criterion: "Unit tests cover (a) every allowed transition returns true, (b) every forbidden transition returns false, (c) assertTransitionAllowed throws on forbidden, (d) terminal states reject every target including same-status no-ops."
    verification: "vitest --run main/src/services/cyboflow/__tests__/stateMachine.test.ts exits 0 with at least 6 test cases covering the four behaviors above."
  - criterion: "No `any` types used (project enforces `@typescript-eslint/no-explicit-any` as error)."
    verification: "grep -nE ':\\s*any\\b' main/src/services/cyboflow/stateMachine.ts returns 0 matches outside comments."
depends_on: [TASK-152]
estimated_complexity: low
epic: cyboflow-schema-migration
test_strategy:
  needed: true
  justification: "The state machine is the contract that prevents impossible transitions (e.g., a completed run accidentally going back to running, or a canceled run getting an awaiting_review approval). A bug in the allowed-set is invisible at compile time and would silently corrupt run history. Exhaustive tests across all 8 states are cheap and necessary."
  targets:
    - behavior: "isTransitionAllowed returns true for each allowed (from, to) pair per the spec."
      test_file: "main/src/services/cyboflow/__tests__/stateMachine.test.ts"
      type: unit
    - behavior: "isTransitionAllowed returns false for the explicit forbidden transitions: completed→running, failed→queued, canceled→running, queued→awaiting_review, awaiting_review→completed."
      test_file: "main/src/services/cyboflow/__tests__/stateMachine.test.ts"
      type: unit
    - behavior: "assertTransitionAllowed throws IllegalTransitionError on forbidden transitions; error message contains from, to, and runId."
      test_file: "main/src/services/cyboflow/__tests__/stateMachine.test.ts"
      type: unit
    - behavior: "Terminal states (completed, failed, canceled) reject every possible target status including themselves (no-op same-status transitions are explicitly disallowed)."
      test_file: "main/src/services/cyboflow/__tests__/stateMachine.test.ts"
      type: unit
---

# State Machine Transition Validator

## Objective

The 006 migration's CHECK constraint enforces "status must be one of 8 values" but does NOT enforce "this transition from A to B is legal." Per system design §5.3 and the architecture research §9, several transitions are forbidden invariants of the workflow state machine: terminal states (completed, failed, canceled) have no outgoing transitions, `queued → awaiting_review` skips required intermediate states, `awaiting_review → completed` skips the required `running` step, etc. This task delivers a pure-function validator (`isTransitionAllowed`) and an assert variant (`assertTransitionAllowed`) that the `ApprovalRouter`, `RunController`, and any future state-mutating code will call before issuing an UPDATE. The validator is the single source of truth for what transitions are legal.

## Implementation Steps

1. **Create new file `main/src/services/cyboflow/stateMachine.ts`** with the allowed-transition table, the boolean validator, the asserting validator, and the typed error. Skeleton:

   