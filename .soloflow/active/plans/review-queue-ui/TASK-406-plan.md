---
id: TASK-406
idea: IDEA-009
status: in-flight
created: "2026-05-11T00:00:00Z"
files_owned:
  - main/src/trpc/routers/approvals.ts
  - frontend/src/components/PendingApprovalCard.tsx
  - frontend/src/components/__tests__/PendingApprovalCard.test.tsx
  - main/src/trpc/__tests__/approvals.test.ts
  - shared/types/approvals.ts
files_readonly:
  - frontend/src/utils/reviewQueueSelectors.ts
  - frontend/src/stores/reviewQueueStore.ts
  - frontend/src/trpc/client.ts
  - main/src/services/database.ts
  - .soloflow/active/research/ROADMAP-001-research-user-needs.md
acceptance_criteria:
  - criterion: "`cyboflow.approvals.approveRestOfRun` tRPC mutation exists with input { runId: string } and decides all pending approvals for that run as approved"
    verification: "grep -n 'approveRestOfRun' main/src/trpc/routers/approvals.ts returns the mutation; grep -n 'approveRestOfRun' shared/types/approvals.ts confirms type exported"
  - criterion: No `approveAll` (or globally-scoped approve-all) mutation exists anywhere in the codebase
    verification: "grep -rn 'approveAll\\|approve_all\\|approveGlobal' main/src/trpc/ frontend/src/ shared/types/ returns 0 matches"
  - criterion: "Group variant of PendingApprovalCard's Approve button calls approveRestOfRun({ runId }) when the group represents all remaining items for that run + signature, rather than batching per-item mutations"
    verification: "grep -n 'approveRestOfRun' frontend/src/components/PendingApprovalCard.tsx returns a match in the group-approve handler"
  - criterion: "approveRestOfRun is scoped: it decides approvals for the given runId only, never affects other runs"
    verification: "Unit test on the tRPC handler: seed 3 pending approvals across 2 runs, call approveRestOfRun({ runId: 'run-A' }), assert only run-A's approvals are decided; run-B's remain pending"
  - criterion: A code comment in approvals.ts explicitly documents the deliberate omission of a global approve-all and links to the safety rationale
    verification: "grep -n 'NO global approve-all\\|deliberate omission\\|bulk-delete' main/src/trpc/routers/approvals.ts returns at least one match in a comment near the approveRestOfRun definition"
depends_on:
  - TASK-401
  - TASK-405
estimated_complexity: medium
epic: review-queue-ui
test_strategy:
  needed: true
  justification: "approveRestOfRun has scope-correctness invariants (only the targeted run is affected) that are exactly the kind of thing that breaks silently — the highest-harm failure mode if wrong is approving the wrong run's pending items"
  targets:
    - behavior: approveRestOfRun decides all pending approvals for the given runId
      test_file: main/src/trpc/__tests__/approvals.test.ts
      type: unit
    - behavior: approveRestOfRun does NOT affect approvals from other runs
      test_file: main/src/trpc/__tests__/approvals.test.ts
      type: unit
    - behavior: "Group variant card invokes approveRestOfRun on the group's runId when Approve is clicked"
      test_file: frontend/src/components/__tests__/PendingApprovalCard.test.tsx
      type: component
    - behavior: Codebase contains no global approve-all symbol (sweep test)
      test_file: main/src/trpc/__tests__/approvals.test.ts
      type: unit
---
# Per-Run "Approve Rest" + Explicit No-Global-Approve-All Guard

## Objective

Add the scoped per-run "approve rest of this run" action (IDEA-009 slice 7) and codify the deliberate omission of a global approve-all (IDEA slice 8). User-needs research §4 and §5 frame this as the highest-harm failure mode the queue must avoid: a global approve-all click during a sprint+prune session could silently approve a 50-file delete the user didn't intend. The per-run action is safe because the user has context about a single run. This task: (1) adds `cyboflow.approvals.approveRestOfRun` mutation, (2) refactors the group-card Approve handler from per-item batched (from TASK-405) to a single atomic call, (3) adds a grep-able comment + sweep test asserting no global-approve symbol exists.

## Implementation Steps

1. Run `grep -rn 'approveAll\|approve_all\|approveGlobal' main/src/ frontend/src/ shared/types/` to confirm no such symbol exists before starting. This is the pre-flight per refiner step 5d (the assertion is grep-driven, so the executor must re-run it as a completeness gate).
2. Modify `shared/types/approvals.ts`:
   - Export `type ApproveRestOfRunInput = { runId: string }` and `type ApproveRestOfRunResult = { decided: number }`.
3. Modify `main/src/trpc/routers/approvals.ts`:
   - Add `approveRestOfRun: publicProcedure.input(z.object({ runId: z.string() })).mutation(async ({ input, ctx }) => { ... })`.
   - Implementation: under the per-run mutex (acquire via the existing mutex util from `main/src/utils/mutex.ts`), select all `approvals.id` where `run_id = ?` and `status = 'pending'`; for each, invoke the same approve path that the single-item `approve` mutation uses (this delegates to the ApprovalRouter service from IDEA-008 once it exists; for now, if the service isn't ready, fall back to a direct status update + emit). Return `{ decided: count }`.
   - Add a prominent comment block above the mutation:
     ```ts
     // NO global approve-all exists in v1 — deliberate omission per IDEA-009 slice 8.
     // Rationale: global approve-all maps to the highest-harm failure mode (accidental
     // bulk-delete during prune+sprint queue clearing). The per-run scoping below is
     // safe because the user has context about what one run is doing.
     // See: user-needs research §5; risks research §10.
     ```
4. Modify `frontend/src/components/PendingApprovalCard.tsx`:
   - In the group-variant Approve handler, replace the `Promise.all(item.items.map(...))` batch from TASK-405 with a single call: `trpc.cyboflow.approvals.approveRestOfRun.mutate({ runId: item.runId })`.
   - The Reject button for groups: for v1, keep the per-item batched reject (`Promise.all(item.items.map(reject))`). A symmetric `rejectRestOfRun` is a v1.1 nice-to-have; not in scope here.
5. Write unit tests:
   - `main/src/trpc/__tests__/approvals.test.ts`:
     - Test 1: seed in-memory DB with 5 pending approvals (3 for run-A, 2 for run-B); call `approveRestOfRun({ runId: 'run-A' })`; assert run-A's 3 are now status='approved' AND run-B's 2 are still 'pending'.
     - Test 2: seed empty; call `approveRestOfRun({ runId: 'nonexistent' })`; assert returns `{ decided: 0 }` and does not throw.
     - Test 3 (sweep): `execSync('grep -rn "approveAll\\|approve_all\\|approveGlobal" main/src frontend/src shared/types || true')` returns empty stdout (or only matches inside this test file's own assertion strings — exclude via `--exclude-dir=__tests__`). This is a runtime grep, not a static check; it runs as the last test in the file.
   - `frontend/src/components/__tests__/PendingApprovalCard.test.tsx` (extend existing): render a group-variant card with 3 items all from run-X; click Approve; assert mocked `trpc.cyboflow.approvals.approveRestOfRun.mutate` called with `{ runId: 'run-X' }` exactly once.

## Acceptance Criteria

All five criteria above. The sweep test is the gate that ensures the deliberate omission stays deliberate over time.

## Test Strategy

Four tests as listed. The DB-level tests use the existing `DatabaseService` test patterns (check `main/src/services/__tests__/gitStatusManager.test.ts` for the pattern — an in-memory or temp-file SQLite instance).

## Hardest Decision

**Whether to also implement `rejectRestOfRun` symmetrically.** Per IDEA slice 7, only "approve rest" is in scope. Rejecting the rest of a run mid-execution would terminate the run with each rejection — it's a different semantic (cancel the run is what the user usually wants). Keep reject-all out of v1; if self-host shows users want it, the contract surface will support it cleanly.

The second decision: **whether `approveRestOfRun` should be atomic (all-or-nothing) or best-effort.** Best-effort wins: under the per-run mutex, iterate the pending approvals and decide each; if one fails (e.g., the run was canceled between fetch and decide), log and continue. The user-facing meaning of "approve rest" is "approve everything in this queue right now"; partial success is acceptable because the queue subscription will refresh and show what remains.

## Rejected Alternatives

- **Add a `confirm: boolean` flag and require a confirm step for approveRestOfRun.** Rejected — adds friction to the safe action; the safety guarantee is the per-run scoping, not user double-confirmation.
- **Surface global approve-all behind a hidden config flag.** Rejected — flags become defaults. The deliberate omission is the design.
- **Implement reject-rest-of-run symmetrically.** Out of scope; see Hardest Decision.

What would change my mind on the sweep test: if a future feature legitimately needs a symbol named `approveAll*` for unrelated reasons, the sweep test gains an allowlist. The cost is one line, worth it.

## Lowest Confidence Area

The handler's interaction with the ApprovalRouter service from IDEA-008 (`workflow-runs-and-day3-gate` epic). If that service is not yet implemented when TASK-406 lands, the handler's "decide each approval" path is a stub. The fall-back behavior (direct DB status update) is correct but the socket-reply-to-Claude side is the ApprovalRouter's job; without it, Claude doesn't actually resume. This is acceptable for self-host validation IF the executor verifies the ApprovalRouter handles "approval decided externally" by polling — otherwise approveRestOfRun decides the approvals in the DB but the runs stay paused. Validation step: check IDEA-008's status before executing TASK-406; if ApprovalRouter is not ready, document the gap clearly so the day-3 gate test catches it.
