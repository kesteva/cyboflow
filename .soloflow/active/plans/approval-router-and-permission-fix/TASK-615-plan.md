---
id: TASK-615
idea: IDEA-009
status: ready
created: 2026-05-15T00:00:00Z
files_owned:
  - main/src/trpc/index.ts
  - main/src/trpc/context.ts
  - main/src/trpc/routers/approvals.ts
files_readonly:
  - main/src/orchestrator/trpc/routers/approvals.ts
  - main/src/trpc/__tests__/approvals.test.ts
  - main/src/orchestrator/trpc/trpc.ts
  - main/src/orchestrator/trpc/context.ts
acceptance_criteria:
  - criterion: "`main/src/trpc/index.ts` contains a prominent DO-NOT-EXPAND warning naming the canonical live-router directory and the approval-router epic."
    verification: "grep -n 'DO NOT ADD NEW ROUTERS' main/src/trpc/index.ts returns ≥1 match AND grep -n 'main/src/orchestrator/trpc/routers' main/src/trpc/index.ts returns ≥1 match AND grep -n 'approval-router' main/src/trpc/index.ts returns ≥1 match."
  - criterion: "`main/src/trpc/routers/approvals.ts` contains the same DO-NOT-EXPAND warning."
    verification: "grep -n 'DO NOT ADD NEW ROUTERS' main/src/trpc/routers/approvals.ts returns ≥1 match AND grep -n 'main/src/orchestrator/trpc/routers' main/src/trpc/routers/approvals.ts returns ≥1 match."
  - criterion: "`main/src/trpc/context.ts` contains a one-line back-pointer to index.ts."
    verification: "grep -n 'DO NOT ADD NEW ROUTERS\\|see main/src/trpc/index.ts' main/src/trpc/context.ts returns ≥1 match."
  - criterion: "approveRestOfRunHandler signature and behaviour unchanged — comments-only change."
    verification: "git diff --stat shows changes confined to comment lines. main/src/trpc/__tests__/approvals.test.ts continues to pass unchanged."
  - criterion: "No new TypeScript errors introduced in main."
    verification: "pnpm --filter main typecheck exits 0."
depends_on: []
estimated_complexity: low
epic: approval-router-and-permission-fix
test_strategy:
  needed: false
  justification: "Comments-only change. The existing main/src/trpc/__tests__/approvals.test.ts exercises the handler and serves as a behavioural-regression gate."
---

# Clarify the orphan main/src/trpc/ subtree with DO-NOT-EXPAND warnings

## Objective

`main/src/trpc/` is an orphan parallel router tree introduced by TASK-401: zero production imports outside `__tests__/`. It exists solely to host `approveRestOfRunHandler` until the approval-router epic wires `ctx.db` and lets the orchestrator delegate. Add a DO-NOT-EXPAND warning to each file in the subtree (index.ts, context.ts, routers/approvals.ts) naming the canonical directory (`main/src/orchestrator/trpc/routers/`) and the approval-router epic as the eventual consumer.

This task is assigned to the `approval-router-and-permission-fix` epic because that epic owns the eventual consumer that will collapse this subtree.

## Implementation Steps

1. In `main/src/trpc/index.ts`, replace the docstring with one opening with a `WARNING: DO NOT ADD NEW ROUTERS HERE.` block. The new docstring must include:
   - The phrase `DO NOT ADD NEW ROUTERS`
   - The path `main/src/orchestrator/trpc/routers/`
   - A reference to the `approval-router` epic
2. In `main/src/trpc/context.ts`, add a one-line back-pointer near the top: `DO NOT ADD NEW ROUTERS HERE — see main/src/trpc/index.ts for the canonical router location and the approval-router epic plan.`
3. In `main/src/trpc/routers/approvals.ts`, insert the same WARNING block at the top of the existing docstring.
4. Do NOT modify the `approveRestOfRunHandler` function body. Do NOT touch the test file or the orchestrator's stub.
5. Run `pnpm --filter main typecheck` and confirm the existing handler test still passes.

## Acceptance Criteria

All five criteria above.

## Test Strategy

Not applicable — comments-only. The existing handler test serves as a behavioural regression gate.
