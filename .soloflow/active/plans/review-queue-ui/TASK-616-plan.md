---
id: TASK-616
idea: IDEA-009
status: in-flight
created: "2026-05-15T00:00:00Z"
files_owned:
  - shared/types/approvals.ts
  - main/src/trpc/routers/approvals.ts
  - main/src/orchestrator/trpc/routers/approvals.ts
  - main/src/trpc/__tests__/approvals.test.ts
  - frontend/src/components/PendingApprovalCard.tsx
  - frontend/src/components/__tests__/PendingApprovalCard.test.tsx
  - frontend/src/hooks/useReviewQueueKeyboard.ts
  - frontend/src/hooks/__tests__/useReviewQueueKeyboard.test.ts
  - .soloflow/active/plans/review-queue-ui/EPIC-review-queue-ui.md
files_readonly:
  - main/src/utils/mutex.ts
  - main/src/database/migrations/006_cyboflow_schema.sql
  - frontend/src/utils/trpcClient.ts
  - frontend/src/utils/reviewQueueSelectors.ts
  - .soloflow/archive/done/review-queue-ui/TASK-406-done.md
acceptance_criteria:
  - criterion: "`shared/types/approvals.ts` exports `RejectRestOfRunInput = { runId: string }` and `RejectRestOfRunResult = { decided: number }`."
    verification: "grep -n 'RejectRestOfRunInput\\|RejectRestOfRunResult' shared/types/approvals.ts returns >=2 matches and the file still typechecks (pnpm typecheck exits 0)."
  - criterion: "`main/src/trpc/routers/approvals.ts` exports an async function `rejectRestOfRunHandler(db, runId): Promise<RejectRestOfRunResult>` that wraps its body in `withLock(`run:${runId}`, ...)`, selects pending approvals scoped to `WHERE run_id = ? AND status = 'pending'`, and per row UPDATEs `status = 'rejected', decided_at = ?, decided_by = 'user'` with try/catch best-effort iteration matching `approveRestOfRunHandler`."
    verification: "grep -n 'export async function rejectRestOfRunHandler' main/src/trpc/routers/approvals.ts returns 1 match AND grep -n \"status = 'rejected'\" main/src/trpc/routers/approvals.ts returns >=1 match AND grep -n \"WHERE run_id = ? AND status = 'pending'\" main/src/trpc/routers/approvals.ts returns >=2 matches (one for each handler)."
  - criterion: "`main/src/orchestrator/trpc/routers/approvals.ts` adds a `rejectRestOfRun: protectedProcedure.input(z.object({ runId: z.string() })).mutation(...)` that throws `TRPCError({ code: 'NOT_IMPLEMENTED', ... })` matching the existing `approveRestOfRun` stub pattern exactly (per FIND-SPRINT-011-8 mitigation)."
    verification: "grep -n 'rejectRestOfRun:' main/src/orchestrator/trpc/routers/approvals.ts returns 1 match AND grep -n \"code: 'NOT_IMPLEMENTED'\" main/src/orchestrator/trpc/routers/approvals.ts returns >=2 matches (one per stub) AND the procedure references `input.runId` in the throw message."
  - criterion: "`PendingApprovalCard.tsx` group-card `handleReject` calls `trpc.cyboflow.approvals.rejectRestOfRun.mutate({ runId })` exactly once and contains no `Promise.all(...reject.mutate...)` fan-out for groups."
    verification: "grep -n 'rejectRestOfRun' frontend/src/components/PendingApprovalCard.tsx returns >=1 match inside the `kind === 'group'` arm. grep -n 'Promise.all' frontend/src/components/PendingApprovalCard.tsx returns 0 matches. grep -n 'items.map' frontend/src/components/PendingApprovalCard.tsx returns 0 matches."
  - criterion: "`useReviewQueueKeyboard.ts` `case 'n':` group branch calls `trpc.cyboflow.approvals.rejectRestOfRun.mutate({ runId: focused.runId })` exactly once and contains no per-member `Promise.all` reject fan-out."
    verification: "grep -n 'rejectRestOfRun' frontend/src/hooks/useReviewQueueKeyboard.ts returns >=1 match. The hook source contains no `Promise.all` calls (verified by grep -n 'Promise.all' frontend/src/hooks/useReviewQueueKeyboard.ts returning 0 matches after TASK-612 already removed the y-side fan-out)."
  - criterion: "Per-run scoping test: 3 pending approvals in run-A + 2 pending in run-B -> `rejectRestOfRunHandler(db, 'run-A')` returns `{ decided: 3 }`, run-A's 3 rows become `status='rejected'`, run-B's 2 rows remain `status='pending'`."
    verification: Vitest case in main/src/trpc/__tests__/approvals.test.ts named `rejects all pending for run-A and leaves run-B pending` passes.
  - criterion: "Nonexistent runId test: `rejectRestOfRunHandler(db, 'nonexistent-run')` returns `{ decided: 0 }` and does not throw."
    verification: "Vitest case `returns { decided: 0 } for a nonexistent runId without throwing` passes for the reject handler."
  - criterion: "Sweep test: grep across `main/src`, `frontend/src`, `shared/types` for `rejectAll|reject_all|rejectGlobal` (excluding `__tests__`) returns zero matches."
    verification: Vitest case `codebase contains no global reject-all symbol (sweep)` runs the grep at runtime and asserts empty output.
  - criterion: "Component test: group card with 3 items from run-X -> clicking Reject calls `mockRejectRestOfRunMutate` exactly once with `{ runId: 'run-X' }` AND `mockRejectMutate` is NOT called."
    verification: "Vitest case in frontend/src/components/__tests__/PendingApprovalCard.test.tsx named `group card with 3 items from run-X -> Reject calls rejectRestOfRun({ runId: run-X }) exactly once` passes."
  - criterion: "Keyboard hook test: pressing `n` on a 3-item group fires `mockRejectRestOfRunMutate` exactly once with the group runId AND `mockRejectMutate` (per-item) is NOT called."
    verification: Vitest case in frontend/src/hooks/__tests__/useReviewQueueKeyboard.test.ts named `n on a group item calls rejectRestOfRun.mutate once with the group runId -- not per-member reject` passes; the existing fan-out test for n is replaced.
  - criterion: "Single-item `n` keyboard path unchanged: pressing `n` on a single item still calls `reject.mutate({ approvalId })` once."
    verification: Existing vitest case `n calls reject.mutate with the focused approval id` continues to pass unmodified.
  - criterion: "Single-item Reject mouse path unchanged: clicking Reject on a single-card item still calls `reject.mutate({ approvalId })` once."
    verification: Existing vitest case `Reject button calls reject.mutate with the approval id` continues to pass unmodified.
  - criterion: "EPIC scope updated: `EPIC-review-queue-ui.md` removes the `Reject-rest-of-run (symmetric to approve-rest) -- deferred to v1.1` Out-of-scope entry and adds a bullet under In scope: `Per-run rejectRestOfRun mutation; group-card Reject and keyboard n use it`."
    verification: "grep -n 'rejectRestOfRun' .soloflow/active/plans/review-queue-ui/EPIC-review-queue-ui.md returns >=1 match in the In scope section AND grep -n 'Reject-rest-of-run.*deferred' .soloflow/active/plans/review-queue-ui/EPIC-review-queue-ui.md returns 0 matches."
  - criterion: "Whole-tree typecheck clean: `pnpm typecheck` exits 0."
    verification: Command exit code 0.
  - criterion: "Frontend + main test suites pass: `pnpm --filter frontend test` exits 0 (existing test count + 2 new cases for hook + 1 new case for card); `pnpm --filter main test` exits 0 (existing 3 cases + 3 new reject-side cases = 6 in approvals.test.ts)."
    verification: Both commands exit 0.
depends_on:
  - TASK-612
  - TASK-614
  - TASK-615
estimated_complexity: medium
epic: review-queue-ui
test_strategy:
  needed: true
  justification: "New tRPC mutation surface + handler + 2 frontend call-site swaps. Each layer has a sibling test file from TASK-406 that already encodes the approve-side contract; the reject-side mirror tests are required to keep the assertion-coverage symmetric. Without the new test cases, a future executor could regress the atomic group-reject behaviour without any gate firing."
  targets:
    - behavior: rejectRestOfRunHandler decides all pending approvals for the given runId and does NOT affect other runs
      test_file: main/src/trpc/__tests__/approvals.test.ts
      type: unit
    - behavior: "rejectRestOfRunHandler returns { decided: 0 } for a nonexistent runId without throwing"
      test_file: main/src/trpc/__tests__/approvals.test.ts
      type: unit
    - behavior: "Codebase contains no global reject-all symbol (runtime grep sweep, --exclude-dir=__tests__)"
      test_file: main/src/trpc/__tests__/approvals.test.ts
      type: unit
    - behavior: "PendingApprovalCard group Reject calls rejectRestOfRun.mutate({ runId }) exactly once; per-item reject.mutate NOT called"
      test_file: frontend/src/components/__tests__/PendingApprovalCard.test.tsx
      type: component
    - behavior: "useReviewQueueKeyboard n on group calls rejectRestOfRun.mutate({ runId: focused.runId }) exactly once; per-member reject.mutate NOT called"
      test_file: frontend/src/hooks/__tests__/useReviewQueueKeyboard.test.ts
      type: unit
    - behavior: "Single-item paths unchanged: card Reject + keyboard n on single still call reject.mutate({ approvalId })"
      test_file: frontend/src/components/__tests__/PendingApprovalCard.test.tsx
      type: component
---
# Introduce rejectRestOfRun mutation for atomic group-reject symmetry

## Objective

Close the asymmetry between approve and reject for group cards. TASK-406 introduced atomic `approveRestOfRun` because partial-failure on a group Approve is the highest-harm failure mode (10-tool destructive group with N-1 succeed / 1 in-flight error leaves the user staring at an inconsistent queue). The symmetric argument applies to group Reject: a partial reject on the same destructive group is at least as user-hostile — some tools get blocked, others run. Today both `PendingApprovalCard.tsx:124-129` (mouse) and `useReviewQueueKeyboard.ts` (`n` keyboard hot path) still fan out N individual `reject.mutate({ approvalId })` calls via `Promise.all`. This task adds a `rejectRestOfRun` mutation mirroring TASK-406's pattern end-to-end: shared input/result types, canonical handler in `main/src/trpc/routers/approvals.ts`, orchestrator-side stub throwing `NOT_IMPLEMENTED` until ctx.db is wired (FIND-SPRINT-011-8 mitigation), atomic call-sites in both the card and the keyboard hook, and per-run scoping unit tests plus the sweep guard test.

## Implementation Steps

1. **Update `shared/types/approvals.ts`** — append `RejectRestOfRunInput = { runId: string }` and `RejectRestOfRunResult = { decided: number }` mirroring the approve-side shape.

2. **Add `rejectRestOfRunHandler` to `main/src/trpc/routers/approvals.ts`** — sibling to `approveRestOfRunHandler`, mirrors byte-for-byte except UPDATE sets `status = 'rejected'` and log prefix is `[rejectRestOfRun]`. Same `withLock(\`run:${runId}\`, ...)`, same SELECT scope, same best-effort try/catch.

3. **Add `rejectRestOfRun` mutation to `main/src/orchestrator/trpc/routers/approvals.ts`** — adjacent to existing `approveRestOfRun`. Throws `TRPCError({ code: 'NOT_IMPLEMENTED', message: ... })` (FIND-SPRINT-011-8 mitigation) until `ctx.db` is wired by the approval-router epic.

4. **Add 3 new vitest cases to `main/src/trpc/__tests__/approvals.test.ts`** — new `describe('rejectRestOfRun handler')` block with: per-run scoping (3 in run-A + 2 in run-B → `{decided:3}` and run-B untouched), nonexistent runId no-throw, sweep test for `rejectAll|reject_all|rejectGlobal`.

5. **Update `frontend/src/components/PendingApprovalCard.tsx`** — replace group-branch `handleReject` `Promise.all(items.map(...))` with single `void trpc.cyboflow.approvals.rejectRestOfRun.mutate({ runId }).finally(...)`.

6. **Update `frontend/src/components/__tests__/PendingApprovalCard.test.tsx`** — extend hoisted mock + vi.mock with `mockRejectRestOfRunMutate`; replace per-item fan-out test with atomic-call assertion + add run-X case.

7. **Update `frontend/src/hooks/useReviewQueueKeyboard.ts`** — replace `case 'n'` group branch `Promise.all` with single `void trpc.cyboflow.approvals.rejectRestOfRun.mutate({ runId: focused.runId })`. Update doc comment.

8. **Update `frontend/src/hooks/__tests__/useReviewQueueKeyboard.test.ts`** — extend mock with `mockRejectRestOfRunMutate`; replace per-member fan-out test with atomic-call assertion. Keep single-item test unchanged.

9. **Update `.soloflow/active/plans/review-queue-ui/EPIC-review-queue-ui.md`** — add In-scope bullet for `Per-run rejectRestOfRun`; remove the Out-of-scope `Reject-rest-of-run … deferred to v1.1` bullet.

10. **Verification gate** — `pnpm typecheck` exits 0; `pnpm --filter main test` exits 0; `pnpm --filter frontend test` exits 0; `grep -rn 'Promise.all' frontend/src/components/PendingApprovalCard.tsx frontend/src/hooks/useReviewQueueKeyboard.ts` returns 0 matches.

## Acceptance Criteria

All fourteen criteria above.

## Test Strategy

Six concrete test surfaces (see frontmatter `targets`). No new test files — all are extensions of TASK-406-introduced siblings.

## Hardest Decision

**Whether to refactor approve and reject into a single parameterised `decideRestOfRunHandler(db, runId, decision: 'approved' | 'rejected')`.** The two handlers share ~90% of their body.

**Chosen approach:** keep them as two parallel functions. Reasons: (1) AC greps in this task and TASK-406's done report literal-match handler names; (2) approve and reject will likely diverge once `ctx.db` is wired (reject may carry `input.message` rejection reason); (3) the 30-line cost is paid once but symmetric parallel functions read faster than a parameterised helper with a literal-string branch. Same rationale TASK-406 implicitly made for approve.

## Rejected Alternatives

1. **Parameterised `decideRestOfRunHandler`.** DRY win is real but readability + log-prefix + future-divergence costs dominate.
2. **Single wire mutation `decideRestOfRun({ runId, decision })`.** Would invalidate existing approveRestOfRun on disk; callers still need an if/else; no caller benefit.
3. **Skip orchestrator stub.** Exactly the silent-no-op trap FIND-SPRINT-011-8 surfaced. The whole point of NOT_IMPLEMENTED is to make failure visible.
4. **Defer to approval-router epic.** The call-site fan-out is already shipped; partial-failure exposure compounds with every week of delay. Compounder explicitly elevated.

## Lowest Confidence Area

**Test-count math after TASK-612 lands.** TASK-612's exact final shape of the hook (mock-factory key naming, doc-comment text) is in-flight. The executor should preserve TASK-612's wording and add the reject-side sentence, prefer case-name verification over count math when the two disagree, and reconcile mock-factory names with whatever is actually on disk at execution time.
