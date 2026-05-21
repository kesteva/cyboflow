---
id: TASK-695
sprint: SPRINT-029
epic: orchestrator-and-trpc-router
status: done
summary: "Patch trpc-electron@0.1.2 to neuter 'Symbol.asyncDispose already exists' throw via pnpm patch. Add stuckEvents EventEmitter + onStuckDetected subscription to events.ts. Remove cast-through-unknown workaround in reviewQueueSlice (typed proxy direct access). Add placeholder subscription test."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
visual_macos: skipped_user_preference
---

## Outcome
APPROVED_WITH_DEFERRED + CLEAN. AC10 (pnpm dev smoke for 10s) deferred to integration tester. router.test.ts 18 pass; reviewQueueSlice.test.ts 35 pass; typecheck + lint exit 0.

## Files changed (5 commits)
- patches/trpc-electron@0.1.2.patch (new)
- package.json (pnpm.patchedDependencies entry)
- pnpm-lock.yaml (patch hash)
- frontend/src/trpc/client.ts (JSDoc)
- main/src/orchestrator/trpc/routers/events.ts (stuckEvents + onStuckDetected)
- frontend/src/stores/reviewQueueSlice.ts (typed proxy direct)
- main/src/orchestrator/trpc/__tests__/router.test.ts (placeholder subscription test)

## Notes
- Patch fragility under future trpc-electron republish acknowledged in plan; pnpm-lock.yaml records patch hash → install-time canary.
- StuckDetector → stuckEvents emit-source bridge intentionally deferred per epic boundary.
