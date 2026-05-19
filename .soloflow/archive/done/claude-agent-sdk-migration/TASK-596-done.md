---
id: TASK-596
sprint: SPRINT-020
epic: claude-agent-sdk-migration
status: done
summary: "Removed redundant cleanupPipeline call from killProcess so pipeline disposal is single-sourced through runSdkQuery's finally — closes silent raw_events drop race on kill-mid-stream"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-596 — Audit killProcess cleanup ordering

Single-sourced pipeline disposal through `runSdkQuery`'s `finally` block by removing the redundant `cleanupPipeline(panelId)` call from `killProcess`. New ordering: `await abortCurrentRun(panelId)` (which waits on `iteratorDone` — the promise that resolves only after `finally` runs) then `processes.delete(panelId)` as a defensive idempotent cleanup for the spawn-threw-before-runSdkQuery path. Comment block in killProcess documents the ordering rationale.

Verifier: APPROVED (parallel mode → visual verify skipped).
Code reviewer: CLEAN (no findings; race fix is surgical and correct).
Test writer: TESTS_WRITTEN (added clearPendingForRun spy assertions to both executor cases).
Tests: killProcess test file 2/2 pass; typecheck + lint green.
