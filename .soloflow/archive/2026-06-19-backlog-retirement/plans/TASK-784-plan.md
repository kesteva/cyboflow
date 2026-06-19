---
id: TASK-784
idea: braindump
status: done
created: "2026-05-27T00:00:00Z"
source: braindump
files_owned:
  - main/src/orchestrator/trpc/routers/runs.ts
  - main/src/orchestrator/trpc/routers/__tests__/runs.test.ts
  - frontend/src/hooks/__tests__/useQuickSession.test.tsx
  - frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx
  - frontend/src/components/cyboflow/__tests__/WorkflowPicker.test.tsx
files_readonly: []
acceptance_criteria:
  - criterion: Workflow progress view is static instead of reflecting actual workflow state
    verification: manual
depends_on: []
estimated_complexity: low
---
# Workflow progress view is static instead of reflecting actual workflow state

## Objective

Workflow progress view is static instead of reflecting actual workflow state. The right-rail timeline and canvas views render initial state but do not update live as workflow steps transition between PENDING, RUNNING, and DONE.

## Implementation Steps

1. Investigate and fix: Workflow progress view is static instead of reflecting actual workflow state

## Acceptance Criteria

- [ ] Workflow progress view is static instead of reflecting actual workflow state
