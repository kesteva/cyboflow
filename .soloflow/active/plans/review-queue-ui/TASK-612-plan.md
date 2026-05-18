---
id: TASK-612
idea: IDEA-009
status: in-flight
created: "2026-05-15T00:00:00Z"
files_owned:
  - frontend/src/hooks/useReviewQueueKeyboard.ts
  - frontend/src/hooks/__tests__/useReviewQueueKeyboard.test.ts
files_readonly:
  - frontend/src/components/PendingApprovalCard.tsx
  - frontend/src/utils/trpcClient.ts
  - frontend/src/utils/reviewQueueSelectors.ts
  - shared/types/approvals.ts
acceptance_criteria:
  - criterion: "Pressing `y` on a group item calls `approveRestOfRun.mutate({ runId })` exactly once with the group's runId — NOT per-member `approve.mutate`."
    verification: "grep -n 'approveRestOfRun' frontend/src/hooks/useReviewQueueKeyboard.ts shows the call inside the `case 'y':` branch under the `focused.kind === 'group'` arm. Vitest case asserts mockApproveRestOfRunMutate called once with correct runId and mockApproveMutate NOT called."
  - criterion: "Pressing `y` on a single item still calls `approve.mutate({ approvalId })` once with the focused approval's id — unchanged from TASK-404."
    verification: "Vitest case asserts mockApproveMutate.toHaveBeenCalledWith({ approvalId: 'a' }) and mockApproveRestOfRunMutate NOT called when y pressed on single item."
  - criterion: Pressing `n` on a group item still calls `reject.mutate` once per member via Promise.all — unchanged (no rejectRestOfRun exists).
    verification: "Existing 'n on a group item calls reject.mutate for each member' test continues to pass."
  - criterion: "The hook's tRPC mock path matches the actual import path (`'../../utils/trpcClient'`)."
    verification: "grep -n \"vi.mock('../../utils/trpcClient'\" frontend/src/hooks/__tests__/useReviewQueueKeyboard.test.ts returns the mock declaration."
depends_on: []
estimated_complexity: low
epic: review-queue-ui
test_strategy:
  needed: true
  justification: Behavioural change in mutation dispatch — contract that keyboard y on group fires approveRestOfRun (matching mouse) is the entire point of this task.
  targets:
    - behavior: y on 3-item group fires approveRestOfRun.mutate exactly once with the group runId; per-member approve.mutate NOT called
      test_file: frontend/src/hooks/__tests__/useReviewQueueKeyboard.test.ts
      type: unit
    - behavior: y on single item still fires approve.mutate with the single approvalId
      test_file: frontend/src/hooks/__tests__/useReviewQueueKeyboard.test.ts
      type: unit
    - behavior: n on group still fans out to per-member reject.mutate (preserve existing behaviour)
      test_file: frontend/src/hooks/__tests__/useReviewQueueKeyboard.test.ts
      type: unit
---
# Fix keyboard `y` on group card to use approveRestOfRun (match mouse semantics)

## Objective

Restore parity between keyboard and mouse triage paths. After TASK-406 the mouse Approve path uses atomic `trpc.cyboflow.approvals.approveRestOfRun.mutate({ runId })` (PendingApprovalCard.tsx:120). The keyboard hook still fans out per-member `approve.mutate` via `Promise.all` — bypassing the per-run lock IDEA-009 slice 8 introduced. Swap the group `y` branch to call `approveRestOfRun` once with `focused.runId`. Group `n` stays as Promise.all reject. Also fix the test-mock path bug (`'../../trpc/client'` → `'../../utils/trpcClient'`).

## Implementation Steps

1. In `frontend/src/hooks/useReviewQueueKeyboard.ts`, in the `case 'y':` branch when `focused.kind === 'group'`: replace `Promise.all(focused.items.map(...))` with `void trpc.cyboflow.approvals.approveRestOfRun.mutate({ runId: focused.runId })`.
2. Update the doc comment that says "TASK-406 will replace this" to current-tense: "Group `y` dispatches `approveRestOfRun` atomically; group `n` fans out per-member because no `rejectRestOfRun` exists in v1."
3. In `frontend/src/hooks/__tests__/useReviewQueueKeyboard.test.ts`, change `vi.mock('../../trpc/client', ...)` to `vi.mock('../../utils/trpcClient', ...)`.
4. Extend the hoisted mock to include `mockApproveRestOfRunMutate: vi.fn().mockResolvedValue({ decided: 0 })` and add `approveRestOfRun: { mutate: mockApproveRestOfRunMutate }` to the mocked `trpc.cyboflow.approvals` shape.
5. Replace the existing `'y on a group item calls approve.mutate for each member'` test with a new one asserting atomic `approveRestOfRun` behavior.
6. Verify the single-item `y` test still asserts `mockApproveMutate` is called and `mockApproveRestOfRunMutate` is NOT.
7. Run `pnpm --filter frontend test` and `pnpm typecheck`.

## Acceptance Criteria

All four criteria above.

## Test Strategy

Refactor the existing group-`y` test plus fix the mock-path bug to ensure the assertion isn't a false-green.
