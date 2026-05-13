---
id: TASK-154
idea: IDEA-004
idea_id: IDEA-004
status: in-flight
created: "2026-05-11T00:00:00Z"
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
  - criterion: File `main/src/services/cyboflow/stateMachine.ts` exports a constant `ALLOWED_TRANSITIONS` mapping every WorkflowRunStatus to the set of statuses it may transition to.
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
    verification: vitest --run main/src/services/cyboflow/__tests__/stateMachine.test.ts exits 0 with at least 6 test cases covering the four behaviors above.
  - criterion: No `any` types used (project enforces `@typescript-eslint/no-explicit-any` as error).
    verification: "grep -nE ':\\s*any\\b' main/src/services/cyboflow/stateMachine.ts returns 0 matches outside comments."
depends_on:
  - TASK-152
estimated_complexity: low
epic: cyboflow-schema-migration
test_strategy:
  needed: true
  justification: "The state machine is the contract that prevents impossible transitions (e.g., a completed run accidentally going back to running, or a canceled run getting an awaiting_review approval). A bug in the allowed-set is invisible at compile time and would silently corrupt run history. Exhaustive tests across all 8 states are cheap and necessary."
  targets:
    - behavior: "isTransitionAllowed returns true for each allowed (from, to) pair per the spec."
      test_file: main/src/services/cyboflow/__tests__/stateMachine.test.ts
      type: unit
    - behavior: "isTransitionAllowed returns false for the explicit forbidden transitions: completed→running, failed→queued, canceled→running, queued→awaiting_review, awaiting_review→completed."
      test_file: main/src/services/cyboflow/__tests__/stateMachine.test.ts
      type: unit
    - behavior: "assertTransitionAllowed throws IllegalTransitionError on forbidden transitions; error message contains from, to, and runId."
      test_file: main/src/services/cyboflow/__tests__/stateMachine.test.ts
      type: unit
    - behavior: "Terminal states (completed, failed, canceled) reject every possible target status including themselves (no-op same-status transitions are explicitly disallowed)."
      test_file: main/src/services/cyboflow/__tests__/stateMachine.test.ts
      type: unit
---
# State Machine Transition Validator

## Objective

The 006 migration's CHECK constraint enforces "status must be one of 8 values" but does NOT enforce "this transition from A to B is legal." Per system design §5.3 and the architecture research §9, several transitions are forbidden invariants of the workflow state machine: terminal states (completed, failed, canceled) have no outgoing transitions, `queued → awaiting_review` skips required intermediate states, `awaiting_review → completed` skips the required `running` step, etc. This task delivers a pure-function validator (`isTransitionAllowed`) and an assert variant (`assertTransitionAllowed`) that the `ApprovalRouter`, `RunController`, and any future state-mutating code will call before issuing an UPDATE. The validator is the single source of truth for what transitions are legal.

## Implementation Steps

1. **Create new file `main/src/services/cyboflow/stateMachine.ts`** with the allowed-transition table, the boolean validator, the asserting validator, and the typed error. Skeleton:

   ```ts
   import type { WorkflowRunStatus } from '../../../../shared/types/cyboflow';

   /**
    * Allowed state transitions for `workflow_runs.status`, per
    * `docs/cyboflow_system_design.md` §5.3.
    *
    * Source state -> set of target states it may transition to.
    * Terminal states (completed, failed, canceled) map to an empty set:
    * once a run reaches a terminal state, NO further transitions are legal —
    * not even same-status no-ops (e.g. completed -> completed is rejected).
    *
    * Rationale: the database CHECK constraint enforces "status is one of 8
    * values" but cannot enforce "this transition from A to B is legal".
    * This table is the in-process source of truth.
    */
   export const ALLOWED_TRANSITIONS: Record<
     WorkflowRunStatus,
     readonly WorkflowRunStatus[]
   > = {
     queued:          ['starting', 'canceled'],
     starting:        ['running', 'failed', 'canceled'],
     running:         ['awaiting_review', 'completed', 'failed', 'canceled', 'stuck'],
     awaiting_review: ['running', 'canceled', 'stuck', 'failed'],
     stuck:           ['running', 'canceled', 'failed'],
     completed:       [],
     failed:          [],
     canceled:        [],
   };

   /**
    * Pure predicate: is the (from -> to) transition allowed?
    * Returns false for any transition out of a terminal state, including
    * same-status no-ops.
    */
   export function isTransitionAllowed(
     from: WorkflowRunStatus,
     to: WorkflowRunStatus,
   ): boolean {
     return ALLOWED_TRANSITIONS[from].includes(to);
   }

   /**
    * Typed error thrown when an illegal transition is attempted. Carries the
    * from/to states and the optional runId so callers can log a tight
    * forensic line without re-stringifying.
    */
   export class IllegalTransitionError extends Error {
     public readonly from: WorkflowRunStatus;
     public readonly to: WorkflowRunStatus;
     public readonly runId: string | undefined;

     constructor(
       from: WorkflowRunStatus,
       to: WorkflowRunStatus,
       runId?: string,
     ) {
       const suffix = runId !== undefined ? ` (runId=${runId})` : '';
       super(`Illegal workflow_run status transition: ${from} -> ${to}${suffix}`);
       this.name = 'IllegalTransitionError';
       this.from = from;
       this.to = to;
       this.runId = runId;
     }
   }

   /**
    * Assert variant: throws `IllegalTransitionError` if the transition is
    * not in `ALLOWED_TRANSITIONS`. Use this at the head of every code path
    * that issues an `UPDATE workflow_runs SET status = ?` statement.
    */
   export function assertTransitionAllowed(
     from: WorkflowRunStatus,
     to: WorkflowRunStatus,
     runId?: string,
   ): void {
     if (!isTransitionAllowed(from, to)) {
       throw new IllegalTransitionError(from, to, runId);
     }
   }
   ```

   The `WorkflowRunStatus` import path matches the location TASK-152 establishes for `shared/types/cyboflow.ts`. The relative path may differ depending on the final main-process tsconfig `baseUrl` — confirm via `pnpm typecheck` after editing.

2. **Create the test file `main/src/services/cyboflow/__tests__/stateMachine.test.ts`** with the four behavior targets from the frontmatter `test_strategy.targets`:

   - **(a) Every allowed transition returns `true`.** Iterate `ALLOWED_TRANSITIONS` and assert `isTransitionAllowed(from, to) === true` for each (from, to) pair listed. This guards against accidental table edits that remove a legal transition.
   - **(b) Every forbidden transition returns `false`.** Test the explicit forbidden cases from AC #3's verification line: `completed -> running`, `failed -> queued`, `canceled -> running`, `queued -> awaiting_review`, `queued -> running` (must go through `starting` first), `awaiting_review -> completed` (must go back through `running` first), plus `starting -> awaiting_review`, `stuck -> completed` (must go back through `running`).
   - **(c) `assertTransitionAllowed` throws `IllegalTransitionError` on forbidden transitions.** Assert that:
     - The thrown error is an instance of `IllegalTransitionError`.
     - `err.from`, `err.to`, `err.runId` match the inputs.
     - `err.message` contains both the from and to strings AND the runId when supplied.
     - `assertTransitionAllowed('running', 'completed')` does NOT throw (positive control).
   - **(d) Terminal states reject every target including themselves.** For each terminal state in `['completed', 'failed', 'canceled']`, iterate every status in the full 8-state enum (including the terminal state itself) and assert `isTransitionAllowed(terminal, target) === false`. This explicitly forbids same-status no-ops; an UPDATE that "transitions" `completed -> completed` is a bug somewhere upstream.

   Use Vitest's `describe`/`it` blocks grouped by the four behaviors. Total cases: ~6 minimum per AC #6's verification, but the iteration patterns in (a) and (d) will produce more concrete `expect` calls.

3. **Verify with the frontmatter's grep gates.** Run, from repo root:

   ```bash
   grep -nE 'export const ALLOWED_TRANSITIONS' main/src/services/cyboflow/stateMachine.ts
   grep -nE 'export function isTransitionAllowed' main/src/services/cyboflow/stateMachine.ts
   grep -nE 'export (function|class) (assertTransitionAllowed|IllegalTransitionError)' main/src/services/cyboflow/stateMachine.ts
   grep -nE ':\s*any\b' main/src/services/cyboflow/stateMachine.ts   # must return 0 outside comments
   ```

   Each of the first three must return at least one match; the `any`-grep must return zero matches outside comment lines.

4. **Run the unit tests and typecheck:**

   ```bash
   pnpm --filter main test -- main/src/services/cyboflow/__tests__/stateMachine.test.ts
   pnpm typecheck
   pnpm lint main/src/services/cyboflow/stateMachine.ts main/src/services/cyboflow/__tests__/stateMachine.test.ts
   ```

   All three must exit 0. The lint pass is the practical check for `@typescript-eslint/no-explicit-any`.

## Acceptance Criteria

All seven frontmatter ACs must hold:

- `main/src/services/cyboflow/stateMachine.ts` exports an `ALLOWED_TRANSITIONS` constant covering every one of the 8 `WorkflowRunStatus` source states.
- The terminal states (`completed`, `failed`, `canceled`) map to empty arrays — they have no outgoing transitions and reject same-status no-ops.
- `isTransitionAllowed(from, to)` is a pure boolean predicate returning `true` exactly for the (from, to) pairs in the table and `false` for everything else.
- `assertTransitionAllowed(from, to, runId?)` throws a typed `IllegalTransitionError` carrying `from`, `to`, and (when supplied) `runId`, and whose message text contains all three.
- The allowed-set per source state matches the system design §5.3 spec exactly: `queued → {starting, canceled}`, `starting → {running, failed, canceled}`, `running → {awaiting_review, completed, failed, canceled, stuck}`, `awaiting_review → {running, canceled, stuck, failed}`, `stuck → {running, canceled, failed}`, terminals → none.
- The unit test suite covers the four behaviors (a)–(d) above and exits 0 with at least six concrete test cases.
- The implementation file is free of the `any` type (grep returns zero matches outside comments); ESLint `@typescript-eslint/no-explicit-any` does not fire.

## Test Strategy

Four Vitest unit-test behaviors, all colocated in `main/src/services/cyboflow/__tests__/stateMachine.test.ts`:

1. **Positive sweep — every allowed transition.** Iterate the `ALLOWED_TRANSITIONS` table and confirm `isTransitionAllowed(from, to) === true` for each listed pair. Catches a future regression that drops a legal edge (e.g. removing `running → stuck` by mistake).
2. **Negative sweep — explicit forbidden list.** Hard-code the high-risk forbidden cases (`completed → running`, `failed → queued`, `canceled → running`, `queued → awaiting_review`, `awaiting_review → completed`) and confirm each returns `false`. Catches a future regression that loosens the table.
3. **`assertTransitionAllowed` throw semantics.** Confirm that the assert variant throws on forbidden transitions, that the thrown value is an instance of `IllegalTransitionError`, that the `from`/`to`/`runId` properties are populated, and that the error message contains both states and the runId. Confirm the assert is a no-op on allowed transitions (positive control).
4. **Terminal-state lockdown.** For each terminal state, confirm `isTransitionAllowed(terminal, X) === false` for every `X` in the full 8-state enum, including the terminal state itself. This is the explicit no-no-op contract.

No integration tests at this layer — the validator is pure-function and consumed by the transaction helper (separate task), where the integration coverage lives.

## Hardest Decision

**Whether to allow same-status no-op transitions out of terminal states (e.g. `completed → completed`).** The system design §5.3 diagram does not list any self-edges and explicitly forbids further movement from the terminal states. A reading that "no-ops should always be allowed because nothing actually changes" is tempting and would simplify some upstream callers — but it would also mask real bugs: a code path that issues `UPDATE workflow_runs SET status='completed'` against an already-`completed` row is almost certainly a duplicate completion event or a stale write, not a benign retry. We chose the strict reading: terminal-state entries map to empty arrays, and every target (including the terminal state itself) is rejected. Upstream callers that want idempotency must read-then-decide rather than blindly re-write. Test behavior (d) pins this decision so a future "let's just allow same-status no-ops" refactor surfaces as a failed test instead of a silent semantic shift.

## Rejected Alternatives

- **Use a state-machine library like `xstate` or `robot3`.** The 8-state, ~18-edge table is small enough that a hand-written `Record<WorkflowRunStatus, readonly WorkflowRunStatus[]>` constant is both clearer at a glance and zero-dep. `xstate` would add a runtime, a configuration surface, and a learning curve for the next reader — all to encode 18 array entries. Reconsider only if guards, actions, or hierarchical states enter the requirements (none are on the roadmap through Phase 1).
- **Encode the table at the database layer via a CHECK trigger.** SQLite supports `CREATE TRIGGER … BEFORE UPDATE … WHEN NEW.status NOT IN (…)`, but the trigger body would have to switch on `OLD.status`, the error message would be a generic SQLite constraint failure (no `from`/`to`/`runId` context), and the rule would be invisible from TypeScript. The in-process validator stays the canonical contract; the schema CHECK is intentionally limited to the enum-membership check.
- **Store the allowed-set as data in a `transitions` table.** Would let the rules be edited without a code deploy, but the state machine is a load-bearing invariant — changing it outside of a tested code change is a footgun, not a feature. Hard-coding it in `stateMachine.ts` is correct.

## Lowest Confidence Area

**Whether the system design §5.3 truly forbids `stuck → completed` directly (vs. requiring a `stuck → running → completed` round-trip).** The §5.3 diagram only renders the main `running` cycle and the four exits from it; `stuck` is introduced in §5.7 ("Cross-run deadlock detection … flag as `stuck`") without an accompanying state-diagram edge list. The frontmatter spec lists `stuck → {running, canceled, failed}` — i.e. `stuck → completed` is forbidden, which matches the intuition that a `stuck` run must first un-stick (back to `running`) before it can complete cleanly. Verification path: re-read `docs/cyboflow_system_design.md` §5.3 and §5.7 end-to-end and confirm with the architecture research at `.soloflow/active/research/ROADMAP-001-research-architecture.md` §9 (state-machine invariants). If the design doc actually permits `stuck → completed` (e.g. for a run that finishes between the stuck-detection tick and the next status read), add it to the `stuck` row in `ALLOWED_TRANSITIONS` and a corresponding positive case to test (a). If ambiguous, **ESCALATE TO HUMAN** before shipping — the choice has follow-on consequences for the stuck-detector task in epic 10.
   