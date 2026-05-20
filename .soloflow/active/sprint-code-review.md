---
sprint: SPRINT-025
findings_count:
  critical: 1
  important: 2
  minor: 0
---

# Sprint Code Review: SPRINT-025

## Scope
- Base: 2493186
- Tasks reviewed: [TASK-653, TASK-657, TASK-658, TASK-659, TASK-665, TASK-666, TASK-667, TASK-668, TASK-669, TASK-670]
- Files changed: 28 (source + tests, excluding .soloflow/ state)
- Cross-task hotspots: [frontend/src/stores/reviewQueueSlice.ts (TASK-668 + TASK-669), main/src/orchestrator/__tests__/runEventBridge.test.ts (TASK-665 + TASK-666)]
- Cross-task surfaces (different files, related concern): [PanelTabBar.tsx + ProjectView.tsx + SessionView.tsx (TASK-658), main/src/ipc/panels.ts + frontend/src/components/panels/TerminalPanel.tsx (TASK-657 + TASK-659), main/src/ipc/file.ts + main/src/services/worktreeManager.ts + main/src/services/runCommandManager.ts (TASK-670)]

## Findings queued
3 new findings appended to `.soloflow/active/findings/SPRINT-025-findings.md` for the next `/soloflow:compound` run. Severity breakdown: critical=1, important=2, minor=0. Pending queue now 18 entries.

### Critical
- FIND-SPRINT-025-18 — `events.ts attachProcessLifecycleHandlers` exit handler missing the `isCyboflowRunId` guard that TASK-667 added to the matching spawned handler (half-applied symmetric protection).

### Important
- FIND-SPRINT-025-19 — TASK-658 duplicates `handleAddTerminal` near-verbatim across `ProjectView.tsx` and `SessionView.tsx`; sprint-extractable into `useAddTerminalPanel` hook.
- FIND-SPRINT-025-20 — TASK-659 frontend `TerminalPanel` extracts `customState.cwd` with an unsafe type assertion that bypasses the `hasCwdString` type-guard pattern TASK-657 carefully established on the backend; promote to shared narrowing in `shared/types/`.

## Convention compliance notes
- `StuckEventsClient` consolidation (CODE-PATTERNS.md §142-151): TASK-668 correctly promoted the interface from frontend to `shared/types/stuckDetection.ts`; `grep StuckEventsClient frontend/src` returns the documented single cast site (`reviewQueueSlice.ts:188`). PASS.
- Shared-utility extraction completeness (CODE-PATTERNS.md §222-230): TASK-670 migrated 3 of N+ matching shell-arg interpolation sites in main/. The 30+ uncovered sites (gitDiffManager.ts, worktreeManager.ts inline worktreePath/branchName interpolations at lines 96/130/152/214, file.ts:245/275 tmpFile sites) are ALL already filed by the per-task code-reviewer as FIND-SPRINT-025-11/-12/-13 — no additional sprint-level finding warranted.
- Shared-fixture directory convention (CODE-PATTERNS.md §107-118): TASK-665 placed `rawEvents.ts` at `__tests__/__fixtures__/` instead of the established sibling `__test_fixtures__/` pattern — already filed FIND-SPRINT-025-8.
- `pureSetRunStatus` now dead after TASK-669 — already filed FIND-SPRINT-025-10.
- Store-action sweep: `setRunStatus` has one production call site (via `applyStuckEvent` in the same slice), `setActiveRun` has one (`WorkflowPicker.tsx:58`). No redundant or mid-flow reset patterns introduced this sprint.

## Suppressed (already filed by per-task reviewers)
- FIND-SPRINT-025-7 (TASK-657 cwd-narrowing duplication in main/) — sprint-level extension covered by FIND-SPRINT-025-20 above (adds frontend leg).
- FIND-SPRINT-025-8 / -9 (raw_events fixture documentation + leftover inline DDL in rawEventsSink.test.ts).
- FIND-SPRINT-025-10 (dead `pureSetRunStatus`).
- FIND-SPRINT-025-11 / -12 / -13 (extended shell-escape migration backlog).
