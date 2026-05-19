---
sprint: SPRINT-018
findings_count:
  critical: 0
  important: 6
  minor: 7
---

# Sprint Code Review: SPRINT-018

## Scope
- Base: c1e3e836414db2ccbc81985b2c5e27812e9e5b21
- Tasks reviewed: [TASK-640, TASK-641, TASK-642, TASK-643, TASK-644]
- Files changed (source): 7
  - main/src/orchestrator/runExecutor.ts (new, 189 lines)
  - main/src/orchestrator/runLauncher.ts (+27)
  - main/src/orchestrator/workflowPromptReader.ts (new, 119 lines)
  - main/src/orchestrator/runEventBridge.ts (new, 214 lines)
  - main/src/orchestrator/permissionModeMapper.ts (new, 136 lines)
  - main/src/orchestrator/trpc/routers/runs.ts (+109)
  - main/src/services/cyboflow/transitions.ts (+142)
- Cross-task hotspots: none — each task owns disjoint files. The cross-task surface is in
  the implicit contracts BETWEEN the four new helpers (RunExecutor's protected hooks
  ↔ the three resolver modules) — none of which is yet wired by a concrete subclass.

## Findings queued
8 new findings appended to `.soloflow/active/findings/SPRINT-018-findings.md`
(FIND-SPRINT-018-6 through FIND-SPRINT-018-13), bringing total queued to 13 for
the next `/soloflow:compound` run. Severity breakdown across all 13:
critical=0, important=6, minor=7.

### Critical (security)
_None._

### Important (cross-task contract gaps and architectural drift)
- FIND-SPRINT-018-3 — `deriveEnvelopeType` / `deriveEventType` duplication (pre-existing, verified)
- FIND-SPRINT-018-4 — `deferToApprovalRouter` duplicates `claudeCodeManager.makePreToolUseHook` (pre-existing, verified)
- FIND-SPRINT-018-6 — Standalone-typecheck invariant violation in runEventBridge.ts (value imports from services/*)
- FIND-SPRINT-018-7 — RunExecutor / permissionModeMapper type-contract gap (no `hooks` slot in ClaudeSpawnerOptions)
- FIND-SPRINT-018-8 — RunExecutor exposes no `cancel()` but cancelHandler assumes the contract
- FIND-SPRINT-018-9 — `RunExecutor.bridgeEvents` returns `void`, drops the `RunEventBridge.dispose()` handle

### Minor (style, deduplication, naming)
- FIND-SPRINT-018-1 — unused TypedEventNarrowing import (pre-existing, already cleaned up)
- FIND-SPRINT-018-2 — unused `unknownEvent` fixture (pre-existing, already cleaned up)
- FIND-SPRINT-018-5 — terminal-status set duplicated in 3 files (pre-existing, verified)
- FIND-SPRINT-018-10 — `ExecutionPhase` enum does not cover transitions.ts lifecycle states
- FIND-SPRINT-018-11 — frontmatter parser duplicated between workflowPromptReader and workflowRegistry
- FIND-SPRINT-018-12 — `INSERT INTO workflow_runs` literal duplicated 9× across new test files
- FIND-SPRINT-018-13 — log-prefix convention drift ([RunExecutor] vs [runEventBridge] vs [cancel]) plus err.stack/err.message inconsistency

## Notes
- Standalone-typecheck invariant audit: 3 of 4 new helpers honor it; `runEventBridge.ts`
  is the lone violator (see FIND-SPRINT-018-6). Decision needed in next sprint:
  codify the exception or hoist the streamParser collaborators into orchestrator/.
- The four new helpers (TASK-641/642/643/644) are independent today, but the cross-task
  contracts that connect them to TASK-640's RunExecutor have gaps: missing `hooks` slot,
  no `cancel()` surface, no place to retain `RunEventBridge` handles, no lifecycle-phase
  vocabulary that aligns with transitions.ts. These four findings (7-10) should be
  treated as a single decomposition the integration sprint must resolve up front.
- Test infrastructure drift: 9 inline `INSERT INTO workflow_runs` strings across two
  new test files; ripe for a `seedWorkflowRun` fixture helper.
- Security: no new external surface, no new auth bypass risk, all DB writes parameterized,
  cancel mutation correctly applies `ctx.userId !== 'local'` FORBIDDEN guard.
