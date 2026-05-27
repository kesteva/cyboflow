---
id: TASK-771
sprint: SPRINT-040
epic: workflow-progress-visualization
status: done
summary: "Add useWorkflowPhaseState(runId) hook bridging tRPC phase state (getPhaseState query + onStepTransition subscription) into the canvas. Subscribe-before-await; cleanup-safe; tRPC inference end-to-end."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
visual_macos: not_applicable
---

# TASK-771 done report

## Summary
- `useWorkflowPhaseState(runId)` hook returns `{ definition, currentStepId, stepStates, isLoading, error }`. Vanilla tRPC proxy pattern (`.query()` Promise + `.subscribe(...).unsubscribe()`). Subscribe-before-await captures transitions during query resolution; `mergeTransition` race-guards against pre-resolve events by deferring to the authoritative query result. Cleanup function on `[runId]` deps unsubscribes old + cancels stale state writes via flag.
- Pure: no UI edits in this task (canvas-side wiring is out of scope; see findings).
- 7 tests cover null runId, initial fetch, delta merge ordering, unmount unsubscribe, runId-change re-subscribe, query rejection, subscription onError — all behaviours pass without modifying source files.

## Acceptance criteria
All 8 ACs MET.

## Verification
- `pnpm typecheck` PASS
- `pnpm lint` PASS (0 errors)
- useWorkflowPhaseState.test.tsx 7/7 PASS
- Visual verify: not_applicable (hook only, no UI surface)

## Commits
- `e783aa5 feat(TASK-771): add useWorkflowPhaseState hook bridging tRPC phase state to canvas`

## Findings
- FIND-SPRINT-040-10 (code-reviewer, **high severity**) — stepId namespace mismatch. Bridge `TERMINAL_STEP_IDS` emits dot-notation values (e.g. `'execute.implement'`) while `WORKFLOW_DEFINITIONS` declares bare step ids (e.g. `'implement'`). `getPhaseState` lookup and `mergeTransition` will silently drop every production transition via the defensive `idx === -1` guard. Originates in TASK-765/766; surfaces here. Slated for compound or a follow-up task.
