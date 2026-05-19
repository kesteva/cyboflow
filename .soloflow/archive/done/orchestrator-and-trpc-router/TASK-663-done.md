---
id: TASK-663
sprint: SPRINT-022
epic: orchestrator-and-trpc-router
status: done
summary: "Align panelId === runId === sessionId in RunExecutor — unblocks runs reaching 'running' status and PreToolUse approvals."
executor_loops: 0
code_review_rounds: 1
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-663 — Done

## Summary

Fixed the panelId/runId mismatch in `main/src/orchestrator/runExecutor.ts:181-182` that prevented runs from reaching `running` status. The executor previously synthesised `panelId = "run-${runId}"` and `sessionId = "run-${runId}"`, but the bridge filter at `runEventBridge.ts:158` requires `p.panelId === runId` (raw, no prefix), so events were silently dropped and the ApprovalRouter UPDATE matched zero rows.

## Changes

- **runExecutor.ts** — panelId and sessionId now both equal runId; class and execute() JSDoc updated to document the invariant.
- **runEventBridge.ts** — FIND-SPRINT-021-4 mismatch warning replaced with INVARIANT note (`panelId === runId === sessionId`).
- **runExecutor.test.ts** — test (e) and cancel test (ii) flipped to assert runId; emitOutputEvent helper updated; existing `source arg` test extended with `raw_events` INSERT COUNT assertion; new negative-path describe block (`panelId/runId alignment — integration with RunEventBridge`) locks in the regression failure mode.

## Commits

- `9195fdf fix(TASK-663): align panelId === runId === sessionId — fix runs stuck at 'starting'`
- `f3820bc refactor(TASK-663): collapse duplicate bridge integration test and refresh stale "synthetic" refs`

## Verifier

APPROVED (Level 1+2 ground truth: pnpm --filter main test 467/467; typecheck clean; lint 0 errors). visual_* = not_applicable (backend-only orchestrator change).

## Code Review

Round 1: IMPROVEMENTS_NEEDED (3 important, 1 minor) — collapse duplicate test, refresh stale "synthetic" refs.
Round 2: IMPROVEMENTS_NEEDED (1 important, 2 minor) — stale `bridgeEvents()` JSDoc + describe label still says "synthesis"; spawner reach-back stylistic nit. Out of retry budget (review_retry_max=1); accepted as deferred polish.
