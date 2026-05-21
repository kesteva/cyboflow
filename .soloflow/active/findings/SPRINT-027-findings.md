---
sprint: SPRINT-027
pending_count: 2
last_updated: "2026-05-21T00:49:19.502Z"
---
# Findings Queue

SoloFlow workflow defect: duplicate plan IDs exist for TASK-684 (claude-agent-sdk-migration + crystal-cuts-and-rebrand), TASK-685 (same epics), TASK-686 (cyboflow-shell-architecture + testing-infrastructure), TASK-687 (same epics). Excluded from this sprint to prevent state corruption. Needs deduplication via /soloflow:planner or manual review of .soloflow/active/plans/.
SPRINT-027 started with missing infra: playwright (stale shadows), peekaboo (CLI missing + stale shadows); visual_web and visual_macos checks deferred to `skipped_unable`.

## FIND-SPRINT-027-1
- **source:** TASK-673 (executor)
- **type:** bug
- **severity:** medium
- **status:** open
- **location:** main/src/database/__tests__/cyboflowSchema.test.ts:680
- **description:** Pre-existing test failure: cyboflowSchema.test.ts asserts stuck_detected_at column should not exist after reconciler runs, but the column persists. Test assertion: expect(cols.some(c => c.name === stuck_detected_at)).toBe(false) fails. Unrelated to TASK-673 changes.
- **suggested_action:** Investigate schema reconciler for workflow_runs table — stuck_detected_at orphan column removal may not be executing in test environment.
- **resolved_by:** 

## FIND-SPRINT-027-2
- **source:** TASK-673 (executor)
- **type:** bug
- **severity:** low
- **status:** open
- **location:** main/src/services/panels/claude/__tests__/claudeCodeManager.killProcess.test.ts
- **description:** Pre-existing test failure: killProcess mid-stream test times out at 5000ms. Test: killProcess mid-stream clears pipelines, sdkRuns, and processes maps. Unrelated to TASK-673 changes.
- **suggested_action:** Investigate ClaudeCodeManager.killProcess test — likely needs a longer timeout or a mock that resolves faster.
- **resolved_by:** 
SoloFlow workflow defect: TASK-674 (SPRINT-025-compounder) was a duplicate of TASK-671 (SPRINT-024-compound) — both targeted the same 4 stale assertions in runExecutor.test.ts. Acceptance met by a5f0a83. Compound's task-extraction step should deduplicate against open backlog tasks targeting the same files/symbols.
