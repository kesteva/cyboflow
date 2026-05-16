---
id: TASK-401
sprint: SPRINT-011
epic: review-queue-ui
status: done
summary: "Promote frontend/src/trpc/client.ts to canonical createTRPCProxyClient site; utils/trpcClient.ts becomes re-export shim; fixes 48/96 → 96/96 frontend tests"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: not_applicable
---

# TASK-401 — Done (SPRINT-011)

## Context

Most of TASK-401's contract was satisfied in SPRINT-010 (orchestrator tRPC routers, shared types, reviewQueueStore, unit tests). On entering SPRINT-011 the plan was still active and 48/96 frontend tests were failing because `PendingApprovalCard.test.tsx` and `useReviewQueueKeyboard.test.ts` mock `'../../trpc/client'` (a path that did not yet exist as a real module). This sprint finishes the task by promoting that path to the canonical `createTRPCProxyClient<AppRouter>` site and demoting `utils/trpcClient.ts` to a backwards-compat re-export shim — singleton invariant preserved (one constructor site).

## Changed Files
- `frontend/src/trpc/client.ts` (now canonical `createTRPCProxyClient<AppRouter>`)
- `frontend/src/utils/trpcClient.ts` (re-export shim only)
- `main/src/trpc/routers/events.ts` (new re-export of `eventsRouter` / `approvalEvents`)
- `main/src/trpc/routers/approvals.ts` (added re-export of `approvalsRouter`)

## Commit
`bf6f4f0 feat(TASK-401): wire tRPC foundation — frontend client, stable import surfaces, test fixes`

## Verification
- Tests: 96/96 frontend (was 48/96 before this task), 227/227 main
- Typecheck: PASS (frontend, shared, main)
- Lint: PASS (304 pre-existing warnings, none introduced)
- Visual: mobile skipped (user preference); web N/A (foundation task; downstream UI tests already cover behavior)

## Findings
- FIND-SPRINT-011-1 (verifier): canonical/shim directionality contradicts a now-stale snippet in `docs/CODE-PATTERNS.md:60-66`; non-blocking — compounder should reconcile docs.
- FIND-SPRINT-011-2 (code-reviewer): `main/src/trpc/routers/{approvals,events}.ts` re-export shims have zero production importers — reconciliation requires a planner/orchestrator decision (delete shims and update AC grep target, or move canonical routers back here).
