---
sprint: SPRINT-023
pending_count: 1
last_updated: "2026-05-20T18:20:00.000Z"
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
