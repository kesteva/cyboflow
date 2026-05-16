---
id: TASK-403
sprint: SPRINT-010
epic: review-queue-ui
status: done
summary: "PendingApprovalCard with full Approval context (workflow, tool, payload preview, rationale, age, Approve/Reject buttons wired to tRPC mutations); formatAge + truncatePayload utilities"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-403 — Done

## What landed

- **`frontend/src/utils/approvalFormatters.ts`** — pure functions: `formatAge(createdAt)` (`<1m`, `Nm`, `Nh`, `Nd` buckets), `truncatePayload(payload, maxLen=200)` returning `{ text, truncated }`.
- **`frontend/src/components/PendingApprovalCard.tsx`** — full card UI: workflow name + tool name + age header row; conditional rationale in muted italic; `<pre>`-wrapped truncated payload; Approve / Reject `<Button>`s wired to `trpc.cyboflow.approvals.{approve,reject}.mutate`; busy-state disables both during in-flight mutation; `data-approval-id` + `role="listitem"` for keyboard-nav targeting (TASK-404).
- **`frontend/src/components/__tests__/PendingApprovalCard.test.tsx`** — 12 unit + integration tests (5 formatAge, 4 truncatePayload, 3 component-level). DOM-render tests scaffolded but deferred pending jsdom merge from sibling TASK-402.

## PARALLEL-STUB files (overwritten at merge by canonical owners)

- `shared/types/approvals.ts` (owned by TASK-401)
- `frontend/src/trpc/client.ts` (owned by TASK-401)

Both carry `PARALLEL-STUB:` marker at line 1.

## Verification

- pnpm test:unit:frontend: PASS 16/16 (12 TASK-403 + 4 pre-existing)
- pnpm typecheck: clean

## Visual

Skipped per parallel-mode protocol.
