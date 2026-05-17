---
sprint: SPRINT-013
findings_count:
  critical: 2
  important: 3
  minor: 1
---

# Sprint Code Review: SPRINT-013

## Scope
- Base: 7d05821955100ab44bbc103b08b6f51a343f2765
- Tasks reviewed: [TASK-501, TASK-502, TASK-503, TASK-504, TASK-551, TASK-552, TASK-553, TASK-556]
- Files changed: 31 source files (+ 26 .soloflow state files)
- Cross-task hotspots:
  - frontend/src/components/ReviewQueue/PendingApprovalCard.tsx (TASK-502 + TASK-504)
  - main/src/orchestrator/trpc/routers/runs.ts (TASK-502 + TASK-504)
  - main/src/trpc/routers/runs.ts (TASK-504 only, but bridges shared types)
  - frontend/src/App.tsx (TASK-503 + TASK-553)
  - shared/types/stuckDetection.ts + shared/types/stuckInspection.ts (new sprint-level wire contract)

## Findings queued
6 new findings appended to `.soloflow/active/findings/SPRINT-013-findings.md` (FIND-SPRINT-013-21..26) for the next `/soloflow:compound` run. Severity breakdown: critical=2, important=3, minor=1.

### Critical (2)
- **FIND-SPRINT-013-21** — Entire stuck-detection UI surface unreachable: `ReviewQueueView` imports the base card not the new one, `useReviewQueueSlice` is never consumed, and `setCancelAndRestartDeps` is never called. No StuckBadge, no Why-stuck modal, no Cancel-and-restart button ever render.
- **FIND-SPRINT-013-22** — `StuckDetectedEvent` schema divergence between orchestrator (canonical) and `useStuckNotifications` (locally redeclared with non-existent `sessionId`/`workflowName` fields and string `reason`). Will crash the notification path when TASK-254 wires the real subscription.

### Important (3)
- **FIND-SPRINT-013-23** — Duplicate stuck-reason label maps in `StuckInspectorModal.tsx` (TASK-504) and `useStuckNotifications.ts` (TASK-503) with divergent wording; no single source of truth.
- **FIND-SPRINT-013-24** — Duplicate `StuckEventsClient` forward-looking subscription interface in `useStuckNotifications.ts` and `reviewQueueSlice.ts`; cross-task companion to per-task FIND-2 + FIND-12.
- **FIND-SPRINT-013-25** — Inconsistent MCP status enum: Sidebar uses 4-value `running|starting|failed|stopped`, new StatusBar uses 3-value `healthy|starting|error`; companion to FIND-19.

### Minor (1)
- **FIND-SPRINT-013-26** — Forward-dependency: `cancelAndRestartHandler` AC5 (deny-before-PTY-kill) relies on `approvalRouter.clearPendingForRun` which is a documented no-op until TASK-304 lands.
