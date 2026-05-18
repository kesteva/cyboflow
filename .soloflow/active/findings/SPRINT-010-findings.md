---
sprint: SPRINT-010
pending_count: 1
last_updated: "2026-05-18T21:24:40.046Z"
---
# Findings Queue

## FIND-SPRINT-010-1
- **type:** scope_deviation
- **source:** TASK-613 (executor)
- **severity:** low
- **status:** open
- **location:** frontend/src/components/OnboardingCard.test.tsx, frontend/src/components/StatusBar.test.tsx, frontend/src/components/cyboflow/__tests__/RunView.test.tsx, frontend/src/components/ReviewQueue/__tests__/PendingApprovalCard.test.tsx, frontend/src/components/__tests__/Sidebar.mcpHealth.test.tsx, frontend/src/components/ReviewQueue/__tests__/StuckInspectorModal.test.tsx, frontend/src/hooks/__tests__/useMcpHealth.test.tsx, frontend/src/hooks/__tests__/useStuckNotifications.test.ts
- **description:** required to meet AC: plan expected 3 files with @vitest-environment jsdom pragma but 11 were found; all 8 additional files claimed to satisfy AC criterion no pragmas remain in any frontend test file
