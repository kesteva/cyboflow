---
sprint: SPRINT-011
pending_count: 3
last_updated: "2026-05-16T02:30:00Z"
---

# Findings Queue
SPRINT-011 started with missing infra: docker; tests deferred.

## FIND-SPRINT-011-1
- **source:** TASK-401 (verifier)
- **type:** claude-md
- **severity:** medium
- **status:** open
- **location:** docs/CODE-PATTERNS.md:60-66 (also frontend/src/trpc/client.ts and frontend/src/utils/trpcClient.ts)
- **description:** TASK-401 recreated `frontend/src/trpc/client.ts` as the canonical `createTRPCProxyClient` instance and reduced `frontend/src/utils/trpcClient.ts` to a re-export shim. This REVERSES the SPRINT-010 sprint-closer consolidation (commits 805cd42 + e8cc5ac) that explicitly deleted `trpc/client.ts` and documented `utils/trpcClient.ts` as the canonical path in CODE-PATTERNS.md (lines 60-66). The TASK-401 plan was authored before SPRINT-010's consolidation and its `files_owned` includes `frontend/src/trpc/client.ts`, so the recreation is plan-prescribed — but CODE-PATTERNS.md now contradicts the implementation. Singleton invariant is preserved (only ONE `createTRPCProxyClient` call exists, confirmed via grep), so this is not a runtime bug — it is a documentation / convention divergence. Consumers (`PendingApprovalCard.tsx`, `useReviewQueueKeyboard.ts`, `reviewQueueStore.ts`) still import from `../utils/trpcClient` (the shim), so the codebase now has the import directionality inverted from what CODE-PATTERNS.md describes.
- **suggested_action:** Decide which path is canonical and align all three artifacts: (a) the implementation file containing the `createTRPCProxyClient` call, (b) consumer imports across the codebase, and (c) the `### frontend/src/utils/trpcClient` section in docs/CODE-PATTERNS.md. Either: (1) update CODE-PATTERNS.md to describe `frontend/src/trpc/client.ts` as canonical and update the three consumer imports to match; OR (2) revert TASK-401's swap, restore `utils/trpcClient.ts` as the canonical, make `trpc/client.ts` the shim again, and update the two test mock paths (`PendingApprovalCard.test.tsx:86`, `useReviewQueueKeyboard.test.ts:26`) from `'../../trpc/client'` to `'../../utils/trpcClient'` — the original incomplete change in SPRINT-010 that triggered the test failure TASK-401 was solving.

## FIND-SPRINT-011-2
- **source:** TASK-401 (code-reviewer)
- **type:** anti-pattern
- **severity:** medium
- **status:** open
- **location:** main/src/trpc/routers/approvals.ts:22; main/src/trpc/routers/events.ts:16; .soloflow/active/plans/review-queue-ui/TASK-401-plan.md (AC verification commands at lines 28-30)
- **description:** TASK-401's acceptance-criteria verification commands `grep -n 'listPending' main/src/trpc/routers/approvals.ts` and `grep -n 'onApprovalCreated' main/src/trpc/routers/events.ts` target file paths that no longer host the live router definitions — those moved to `main/src/orchestrator/trpc/routers/{approvals,events}.ts` and are composed into `appRouter` via `main/src/orchestrator/trpc/router.ts`. To satisfy the AC grep without re-introducing duplicate router definitions, TASK-401 added `main/src/trpc/routers/{approvals,events}.ts` as pure re-export shims (`export { approvalsRouter } from '../../orchestrator/trpc/routers/approvals'`). These re-export files have ZERO production importers (verified via `grep -rn "trpc/routers/approvals\|trpc/routers/events" main/src`) — they exist solely to satisfy the AC grep. The header comments honestly admit this ("Re-export the canonical router so the AC grep finds 'listPending' here"), which is the best the executor could do given the plan, but the underlying pattern is grep-driven dead code: a future reader looking at `main/src/trpc/routers/approvals.ts` will reasonably ask "why does this file exist?" The plan-prescribed file path is the root cause, not the executor.
- **suggested_action:** Pick one of: (1) Delete the two re-export shim files, update CODE-PATTERNS.md (or a future plan's AC) to grep `main/src/orchestrator/trpc/routers/{approvals,events}.ts` directly; (2) Move the live router definitions back into `main/src/trpc/routers/` and have `main/src/orchestrator/trpc/router.ts` import from there — collapses the two-tier structure; (3) Add a single `main/src/orchestrator/trpc/routers/CLAUDE.md` documenting that the orchestrator subtree is the canonical home and the `main/src/trpc/routers/` paths are TASK-401-AC compatibility shims to be removed once a plan-aware grep is available. Option 1 is the cleanest; option 3 is the lowest-friction.

## FIND-SPRINT-011-3
- **source:** TASK-403 (code-reviewer)
- **type:** anti-pattern
- **severity:** medium
- **status:** open
- **location:** frontend/src/hooks/useReviewQueueKeyboard.ts:74-80, 92-98
- **description:** TASK-406 introduced `approveRestOfRun` as the atomic per-run approve mutation and wired it into `PendingApprovalCard`'s group-card Approve button. The keyboard-triage hook `useReviewQueueKeyboard` was authored in TASK-404 (before TASK-406) and still uses `Promise.all(items.map((a) => trpc.cyboflow.approvals.approve.mutate(...)))` for `y` on a group item. The hook's own header comment at line 23 explicitly flags this: "TASK-406 will replace this with a single atomic per-run mutation." TASK-406 updated the card but did not update the hook, leaving keyboard `y` semantically and behaviorally divergent from mouse-click Approve on the same group card: keyboard issues N parallel mutations (chatty, no atomic guarantee, partial-failure exposure); mouse issues one `approveRestOfRun` call (atomic per-run, server decides). For the rote-approval flow IDEA-009 targets, the keyboard path is the dominant one — so the inconsistency lands on the hot path.
- **suggested_action:** In `useReviewQueueKeyboard.ts`, replace the group branch of the `y` handler (lines 74-80) with `void trpc.cyboflow.approvals.approveRestOfRun.mutate({ runId: focused.runId })`, mirroring `PendingApprovalCard.handleApprove`. Update the header comment at line 23. Add a hook unit test asserting `y` on a group fires `approveRestOfRun` exactly once with the group's `runId` (mirroring the existing component test at `PendingApprovalCard.test.tsx:291-300`). The `n` (reject) branch can stay on `Promise.all` for now — there is no `rejectRestOfRun` mutation, and TASK-403's card uses the same per-item reject pattern.
- **resolved_by:**
