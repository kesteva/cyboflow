---
sprint: SPRINT-039
pending_count: 1
last_updated: "2026-05-26T21:42:56.727Z"
---
# Findings Queue

## FIND-SPRINT-039-1
- **source:** TASK-756 (verifier)
- **type:** claude-md
- **severity:** medium
- **status:** open
- **location:** docs/VISUAL-VERIFICATION-SETUP.md
- **description:** Recurring TCC-grant gap: Peekaboo MCP server_status reports Screen Recording=granted but Accessibility=not granted, AND live image() capture fails with "The user declined TCCs for application, window, display capture" even on screen:0 / frontmost / by-PID-window. This recurs across SPRINT-031..SPRINT-039 (TASK-655, TASK-715, TASK-752, now TASK-756). Compounder candidate: docs/VISUAL-VERIFICATION-SETUP.md should explicitly call out that BOTH permissions must be granted to the MCP host process (the binary actually issuing the CGDisplay / CGWindow calls), not just to Cyboflow.app or Warp, and include a one-shot diagnostic command. Currently each verifier session re-discovers the gap, escalates to the queue, then proceeds with skipped_unable.

## FIND-SPRINT-039-2
- **category:** flaky_test
- **severity:** medium
- **title:** reviewQueueStore.test.ts has 4 pre-existing failures from TASK-750 trpc-shim removal
- **summary:** pnpm test:unit fails with 4 errors in frontend/src/stores/__tests__/reviewQueueStore.test.ts (TypeError at trpc.cyboflow.events.onApprovalDecided.subscribe). Confirmed pre-existing baseline via git stash against pre-TASK-757 state. Root cause is trpc-shim removal in TASK-750 (SPRINT-038, commits 9927ca8 + 1127800).
- **files:** frontend/src/stores/__tests__/reviewQueueStore.test.ts
- **action:** Open a follow-up task to update reviewQueueStore.test.ts mocks for the post-TASK-750 trpc surface.
