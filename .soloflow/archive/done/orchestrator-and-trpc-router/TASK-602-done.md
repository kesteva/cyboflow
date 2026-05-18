---
id: TASK-602
sprint: SPRINT-016
epic: orchestrator-and-trpc-router
status: done
summary: "RunLauncher publishes a synthetic run_started event via StreamEventPublisher; concrete webContents.send adapter built in cyboflow.ts (no electron in orchestrator); RunView's raw-IPC subscription is now end-to-end live"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-602 Done

## Outcome

Added a `StreamEventPublisher` interface in `main/src/orchestrator/runLauncher.ts` as an optional 9th constructor argument, keeping the standalone-typecheck invariant intact (no `electron` import in orchestrator). `RunLauncher.launch()` now emits a synthetic `run_started` event after the `status='starting'` DB update so the renderer sees something immediately. The concrete `webContents.send('cyboflow:stream:${runId}', event)` adapter lives in `main/src/ipc/cyboflow.ts`'s `getRunLauncher()` and stacks cleanly on top of TASK-610's makeLoggerLike fix. `RunView.tsx`'s placeholder migration comment now reads `TODO(epic-7-trpc-cutover)` per TASK-600's transport-decision. End-to-end: with TASK-599 (preload whitelist) and this task both merged, `cyboflowApi.subscribeToStreamEvents` is no longer a no-op.

## Verification

- Verifier verdict: APPROVED. typecheck + lint clean; 17/17 vitest pass; day-3 gate (`pnpm test:gate`) continues passing in 11.13s with claude CLI.
- Code review verdict: CLEAN.
- Test writer: TESTS_WRITTEN — added 3 payload-shape assertions in runLauncher publisher test and 4 new tests in a new `RunView.test.tsx` covering subscribe/unmount/re-subscribe lifecycle.

## Notes

- AC6 (regression-canary for TASK-599) was satisfied via the plan-authorized Vitest fallback rather than a Playwright spec; the verifier filed FIND-SPRINT-016-2 noting the AC-vs-plan-body contradiction for the compounder.
