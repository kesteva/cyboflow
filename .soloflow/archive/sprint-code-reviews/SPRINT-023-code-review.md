---
sprint: SPRINT-023
findings_count:
  critical: 0
  important: 4
  minor: 3
---

# Sprint Code Review: SPRINT-023

## Scope
- Base: 14129c706e2034df6748a15f612fd307c97131dc
- Tasks reviewed: [TASK-622, TASK-623, TASK-624, TASK-625, TASK-626, TASK-627, TASK-628, TASK-629, TASK-631, TASK-633]
- Files changed: 35 (production + test)
- Cross-task hotspots: frontend/src/components/ReviewQueue/PendingApprovalCard.tsx (TASK-624, TASK-625, TASK-627), frontend/src/components/ReviewQueueView.tsx (TASK-622, TASK-625), frontend/src/stores/reviewQueueSlice.ts (TASK-622, TASK-624), main/src/index.ts (TASK-622, TASK-629), frontend/src/hooks/useStuckNotifications.ts + frontend/src/stores/reviewQueueSlice.ts (cross-task subscription duplication TASK-622 + TASK-623)

## Findings queued
7 findings appended to `.soloflow/active/findings/SPRINT-023-findings.md` for the next `/soloflow:compound` run. Severity breakdown: critical=0, important=4, minor=3.

### Important
- FIND-SPRINT-023-8 — Duplicate PendingApprovalCard files; base variant is now dead code post-TASK-622 swap (also patched by TASK-625, kept alive only by its own test file).
- FIND-SPRINT-023-9 — StuckEventsClient interface duplicated verbatim across reviewQueueSlice (TASK-622) and useStuckNotifications (TASK-623); both subscribe at App top-level → doubled IPC subscription for the same stream.
- FIND-SPRINT-023-10 — useMcpHealth hook has zero production callers after TASK-626; retained as a lossy 3→4 value adapter for non-existent consumers.
- FIND-SPRINT-023-11 — TASK-628 missed git:execute-project (file.ts:795) — still uses weaker inline double-quote escaping instead of the canonical escapeShellArg the task was supposed to standardize on.

### Minor
- FIND-SPRINT-023-12 — TASK-627 added an unrate-limited logger.warn that fires every Cancel-and-restart click; duplicates the user-facing tooltip text in production logs.
- FIND-SPRINT-023-13 — TASK-624 runReasonMap / runDetectedAtMap have no eviction policy, while runStatusMap evicts on terminal status → unbounded growth.
- FIND-SPRINT-023-14 — CYBOFLOW_SESSION_ID + CRYSTAL_SESSION_ID dual-set pattern inlined in two PTY managers (TASK-631 + pre-existing terminalPanelManager) instead of a shared helper.

## Notes
- Critical/security findings: none. New IPC paths (cancelAndRestart, mcp-health subscription, stuck events) preserve existing validation patterns; no new external surface introduced.
- Cross-cutting store-action sweep: no redundant resets or mid-flow store mutations observed across the sprint diff. setRunStatus's eviction asymmetry vs runReasonMap/runDetectedAtMap is captured in FIND-SPRINT-023-13.
- Convention check: docs/CODE-PATTERNS.md sec "Extract-shared-utility refactors: prove completeness" directly applies to FIND-SPRINT-023-8 and FIND-SPRINT-023-11 — both are violations of the documented "grep the PRE-refactor pattern across the entire codebase" rule.
