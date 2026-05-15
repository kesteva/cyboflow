---
id: TASK-406
sprint: SPRINT-010
epic: review-queue-ui
status: done
summary: "approveRestOfRun mutation (run-scoped) + group-card integration + NO-global-approve-all sweep guard"
executor_loops: 0
code_review_rounds: 1
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-406 — Per-Run "Approve Rest" + No-Global-Approve-All Guard

## Outcome

`cyboflow.approvals.approveRestOfRun` mutation added (`{ runId }` input, returns `{ decided: count }`). Handler in `main/src/trpc/routers/approvals.ts` runs under per-run mutex, scopes by `run_id = ? AND status = 'pending'`. Group-variant Approve in PendingApprovalCard now fires a single atomic call instead of TASK-405's per-item batch. Orchestrator-side `approvalsRouter` stub returns `{ decided: 0 }` pending ctx.db wiring in the approval-router epic — the TODO comment spells out the exact import + delegating call. Prominent NO-global-approve-all comment block + runtime sweep test guards against the highest-harm failure mode.

## Files

- `shared/types/approvals.ts` (added ApproveRestOfRunInput/Result types)
- `main/src/trpc/routers/approvals.ts` (NEW — handler + NO-global-approve-all comment, orphan router fragment removed in fix pass)
- `main/src/orchestrator/trpc/routers/approvals.ts` (wired approveRestOfRun mutation stub + delegation-path TODO)
- `frontend/src/components/PendingApprovalCard.tsx` (group Approve → approveRestOfRun)
- `main/src/trpc/__tests__/approvals.test.ts` (NEW — 3 tests: scope correctness, no-match, sweep grep)
- `frontend/src/components/__tests__/PendingApprovalCard.test.tsx` (mock + group test)

## Verification

- 222 main tests pass + 96 frontend tests pass
- `pnpm typecheck`: clean
- `pnpm lint`: 0 errors
- Sweep grep returns 0 matches outside __tests__
- Visual: skipped (parallel mode)

## Commits

- `161df62` feat(TASK-406): add ApproveRestOfRunInput and ApproveRestOfRunResult types
- `c31794a` feat(TASK-406): add approveRestOfRun handler and router fragment
- `af63228` feat(TASK-406): wire approveRestOfRun into orchestrator AppRouter type
- `26522a2` feat(TASK-406): replace per-item batch approve with approveRestOfRun in group card
- `98dbb95` test(TASK-406): add approveRestOfRun unit tests and update component tests
- `6012a32` refactor(TASK-406): remove orphan approveRestOfRunRouter; update orchestrator TODO to point at handler
