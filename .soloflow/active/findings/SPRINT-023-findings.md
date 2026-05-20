---
sprint: SPRINT-023
pending_count: 2
last_updated: "2026-05-20T01:47:42.341Z"
---
# Findings Queue

SPRINT-023 started with missing infra: docker; tests deferred.

## FIND-SPRINT-023-1
- **type:** scope_deviation
- **source:** TASK-622 (executor)
- **severity:** low
- **status:** resolved
- **location:** frontend/src/App.tsx
- **description:** required to meet AC: subscribeToStuckEvents must be mounted at app top-level per plan step 4; App.tsx was files_readonly but is the only valid mount point
- **resolved_by:** verifier — plan-prescribed: Implementation Step 4 explicitly names frontend/src/App.tsx as the mount site and provides the exact useEffect snippet; AC4 verification greps App.tsx for subscribeToStuckEvents

## FIND-SPRINT-023-2
- **type:** scope_deviation
- **source:** TASK-626 (executor)
- **severity:** low
- **status:** resolved
- **resolved_by:** verifier — AC-prescribed: test_strategy targets Sidebar.tsx absence assertions ("Sidebar.tsx no longer renders the 'MCP' label or the bottom indicator block") and the new test file directly verifies the removal mandated by AC4.
- **location:** frontend/src/components/__tests__/Sidebar.mcpHealth.test.tsx
- **description:** File claimed in addition to files_owned. Required to meet AC: Sidebar MCP indicator tests must be removed/updated since the indicator block was deleted from Sidebar.tsx in this task. The test file directly tests the removed MCP dot and would fail otherwise.

## FIND-SPRINT-023-3
- **type:** scope_deviation
- **source:** TASK-622 (executor)
- **severity:** low
- **status:** resolved
- **location:** frontend/src/components/OnboardingCard.test.tsx
- **description:** required to meet AC: test file imports ReviewQueueView which now uses the new PendingApprovalCard path; mock path must be updated to match
- **resolved_by:** verifier — AC-prescribed: AC9 requires existing test suites to still pass; OnboardingCard.test.tsx transitively imports ReviewQueueView and would fail without the mock-path update + trpc mock for the slice's subscription side effect

## FIND-SPRINT-023-4
- **type:** scope_deviation
- **source:** TASK-626 (executor)
- **severity:** low
- **status:** resolved
- **resolved_by:** verifier — AC-prescribed: AC6 mandates "exactly one polling loop... grep returns matches only in mcpHealthStore.ts". The orphaned getMcpHealth() in cyboflowApi.ts would have caused AC6 to fail; removing it satisfies the single-invoke-site requirement.
- **location:** frontend/src/utils/cyboflowApi.ts
- **description:** File claimed to remove getMcpHealth() dead code — the function still contains invoke(cyboflow:mcp-health) which causes AC6 grep to fail. useMcpHealth.ts no longer calls it (polling removed in TASK-626), making getMcpHealth dead code. Removing the export satisfies the single-invoke-site AC.

## FIND-SPRINT-023-5
- **type:** cleanup
- **source:** TASK-623 (verifier)
- **severity:** low
- **status:** open
- **location:** frontend/src/hooks/useStuckNotifications.ts:101
- **description:** Unused eslint-disable directive (react-hooks/exhaustive-deps) — the rule no longer flags this useEffect block. Safe to delete the `// eslint-disable-next-line react-hooks/exhaustive-deps` comment on line 101.
- **suggested_action:** Remove the eslint-disable-next-line comment.

## FIND-SPRINT-023-6
- **source:** TASK-633 (executor)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/services/panels/claude/__tests__/claudeCodeManager.killProcess.test.ts:81, main/src/services/panels/claude/__tests__/claudeCodeManagerWiring.test.ts:76
- **description:** Two claudeCodeManager test files still carry inline function dbAdapter definitions identical to the canonical fixture at __test_fixtures__/dbAdapter.ts. They were not in TASK-633 files_owned and were not counted in the plan pre-flight check. Migrating them to the canonical import would complete the full repo-wide consolidation.
- **suggested_action:** Add these two files to a follow-up task and apply the same canonical import pattern used in TASK-604 / TASK-633.

## FIND-SPRINT-023-7
- **type:** scope_deviation
- **source:** TASK-625 (executor)
- **severity:** low
- **status:** resolved
- **location:** frontend/src/components/OnboardingCard.test.tsx
- **description:** required to meet AC: OnboardingCard.test.tsx mocks useReviewQueueKeyboard without forwarding the onDecide arg. After removing the duplicate window.keydown listener from ReviewQueueView, the y/n dismissal path goes through useReviewQueueKeyboard.onDecide only. The test mock must be updated to capture and invoke onDecide so the y-key-dismisses test still passes.
- **resolved_by:** TASK-625
