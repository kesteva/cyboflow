---
id: TASK-407
sprint: SPRINT-011
epic: review-queue-ui
status: done
summary: "Dock badge + reconnect-resync via ctx.setDockBadge DI (preserves orchestrator standalone-typecheck invariant); will-quit clears badge (cumulative from SPRINT-010)"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_unable
---

# TASK-407 — Done (SPRINT-011)

## Context
TASK-407 fully delivered in SPRINT-010 (8 commits). Verifier APPROVED all 6 ACs; code reviewer CLEAN with one out-of-diff finding queued for compounder.

## Files in Scope
- `main/src/services/dockBadgeService.ts` (singleton, setBadgeCount with darwin guard + clamp + zero-clear)
- `main/src/services/__tests__/dockBadgeService.test.ts` (3 unit tests)
- `main/src/orchestrator/trpc/context.ts` (ContextDeps.setDockBadge capability)
- `main/src/orchestrator/trpc/routers/events.ts` (setBadgeCount mutation delegates to ctx.setDockBadge)
- `main/src/trpc/routers/events.ts` (re-export shim)
- `main/src/index.ts` (capability injection + will-quit clear handler)
- `frontend/src/stores/reviewQueueStore.ts` (syncBadge in addApproval/removeApproval/replaceAll + init)

## Verification
- Tests: 3/3 dockBadgeService, 227/227 main, 99/99 frontend
- Typecheck + lint: PASS
- Standalone-typecheck invariant preserved (orchestrator subtree imports no electron)
- Visual: mobile skipped (user pref); web skipped_unable per-task — deferred to sprint-level verifier

## Findings
- FIND-SPRINT-011-7 (code-reviewer, new): no upper-bound on setBadgeCount input + no createCaller-level procedure test. Low severity; queued for compounder.
