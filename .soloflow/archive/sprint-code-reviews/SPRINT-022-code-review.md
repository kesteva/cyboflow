---
sprint: SPRINT-022
findings_count:
  critical: 0
  important: 3
  minor: 3
---

# Sprint Code Review: SPRINT-022

## Scope
- Base: 91c82c6e976d04696b0f391c1c19102c080c7ffd
- Tasks reviewed: [TASK-663, TASK-664]
- Files changed (source/test, excluding .soloflow/): 4
  - main/src/orchestrator/runExecutor.ts
  - main/src/orchestrator/runEventBridge.ts
  - main/src/orchestrator/__tests__/runExecutor.test.ts
  - main/src/orchestrator/__tests__/runEventBridge.test.ts
- Cross-task hotspots:
  - main/src/orchestrator/runExecutor.ts (TASK-663 + TASK-664)
  - main/src/orchestrator/runEventBridge.ts (TASK-663 doc + TASK-664 skipPersistence refactor)
  - main/src/orchestrator/__tests__/runExecutor.test.ts (TASK-663 + TASK-664)
  - main/src/orchestrator/__tests__/runEventBridge.test.ts (TASK-664)

## Findings queued
6 findings appended to `.soloflow/active/findings/SPRINT-022-findings.md` for the next `/soloflow:compound` run. Severity breakdown: critical=0, important=3, minor=3.

### Important
- FIND-SPRINT-022-1: Stale line-number cross-references (runEventBridge.ts:12 and runExecutor.ts:180 both cite `runEventBridge.ts:158`; actual filter is at line 185 after TASK-664).
- FIND-SPRINT-022-2: Stale "synthetic" terminology surviving TASK-663 invariant rename (runExecutor.ts:315 JSDoc on `_panelId`; runExecutor.test.ts:172 describe label).
- FIND-SPRINT-022-3: Duplicated test-fixture scaffolding across both orchestrator test files (`RAW_EVENTS_DDL`, in-memory DB setup, `countRows` SELECT).

### Minor
- FIND-SPRINT-022-4: Overlapping dual-pipeline single-INSERT assertion across `runEventBridge.test.ts` and `runExecutor.test.ts` (both assert `cnt === 1` via a CCM-pipeline simulation).
- FIND-SPRINT-022-5: Protected-modifier reach-back via bracket notation at runExecutor.test.ts:1281 (`executor['spawner']`); other tests in the file hold the spawner from outer scope.
- FIND-SPRINT-022-6: `BridgeEventsOptions.db` API foot-gun — field stays non-optional even though its value is documented as unused when `skipPersistence === true`.

## Notes
- Zero critical/security findings. The diff is backend-only orchestrator wiring; no new external surfaces, secrets, or auth paths.
- No documented orchestrator conventions exist (no scoped `CLAUDE.md` in `main/src/orchestrator/`, no `CODE-PATTERNS.md` entry for `bridgeEvents`/`skipPersistence`). Convention drift could not be checked — this is an upstream gap, not a sprint defect, and is best addressed when the compound run elects to document the new invariant.
- Cross-cutting store-action sweep: not applicable to this sprint (no store-slice actions touched; backend-only).
