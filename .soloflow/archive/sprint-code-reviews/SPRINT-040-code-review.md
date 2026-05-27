---
sprint: SPRINT-040
findings_count:
  critical: 2
  important: 4
  minor: 7
---

# Sprint Code Review: SPRINT-040

## Scope
- Base: 5712251b826f94e684abb78d27a70ef56bc5bf03
- Tasks reviewed: [TASK-763, TASK-764, TASK-765, TASK-766, TASK-767, TASK-768, TASK-769, TASK-770, TASK-771]
- Files changed: 27 (production + tests), 5541 insertions / 1254 deletions
- Cross-task hotspots:
  - shared/types/workflows.ts (TASK-763 add + downstream consumers)
  - main/src/orchestrator/stepTransitionBridge.ts (TASK-765 emit-side of namespace contract)
  - main/src/orchestrator/trpc/routers/runs.ts (TASK-766 query/sub side of namespace contract)
  - frontend/src/components/cyboflow/WorkflowProgressTimeline.tsx (TASK-768 first consumer)
  - frontend/src/hooks/useWorkflowPhaseState.ts (TASK-771 second consumer of same contract)
  - frontend/src/components/cyboflow/CyboflowRoot.tsx (epic-level wiring host — components never mounted)
  - frontend/src/components/cyboflow/RunRightRail.tsx (Workflow Progress tab placeholder unwired)

## Findings queued
13 findings appended to `.soloflow/active/findings/SPRINT-040-findings.md` for the next `/soloflow:compound` run. Severity breakdown: critical=2, important=4, minor=7.

### Critical (bug, severity: high)
- FIND-SPRINT-040-10 — stepId namespace mismatch across the workflow phase chain (dot-form on emit/persist side, bare-form in WORKFLOW_DEFINITIONS lookup; silent-drop in both getPhaseState handler and useWorkflowPhaseState hook).
- FIND-SPRINT-040-13 — same stepId mismatch also strikes WorkflowProgressTimeline's stepStatusMap lookup; remediation must land at four sites simultaneously.

### Important (improvement / bug, severity: medium)
- FIND-SPRINT-040-1 — pre-existing reviewQueueStore.test.ts failures unrelated to sprint scope (verifier triage).
- FIND-SPRINT-040-3 — epic-level wiring gap: WorkflowProgressTimeline never mounted into RunRightRail tab.
- FIND-SPRINT-040-11 — cross-task duplication: WorkflowProgressTimeline (TASK-768) and useWorkflowPhaseState (TASK-771) independently implement the same getPhaseState + onStepTransition wiring with delta-merge state semantics.
- FIND-SPRINT-040-12 — inconsistent subscribe-vs-query race policy: hook subscribes before awaiting query (no event loss); timeline runs effects in parallel and overwrites subscription deltas with the seed query response.

### Minor (improvement / cleanup, severity: low)
- FIND-SPRINT-040-2 — WorkflowStepTransitionEvent lives in orchestrator bridge instead of shared/types/workflows.ts.
- FIND-SPRINT-040-4 — sixth-consecutive-sprint Peekaboo Accessibility TCC grant recurrence.
- FIND-SPRINT-040-5 — WorkflowCanvas built but never mounted in CyboflowRoot.
- FIND-SPRINT-040-6 — dead FlatStep[] construction in WorkflowCanvas.tsx (only step.id is consumed).
- FIND-SPRINT-040-7 — dead `marginBottom: cond ? 0 : 0` ternary in WorkflowCanvas.tsx:241.
- FIND-SPRINT-040-8 — decorative SVG glyphs in WorkflowStepCard.tsx missing aria-hidden="true".
- FIND-SPRINT-040-9 — WorkflowCanvas missing TASK-770 insertion-contract slots (stepRects, ResizeObserver, WorkflowCanvasEdges import, useWorkflowTokenAnimation call).

## Cross-task observations (no separate finding)
- Two of the three "Critical/Important" findings (FIND-SPRINT-040-10/13 and FIND-SPRINT-040-11/12) share a single root cause: the workflow phase contract crossed three task boundaries (TASK-763 types → TASK-765 emit → TASK-766 query/sub → TASK-768/771 consumers) without an integration test that pumps real WORKFLOW_DEFINITIONS through the chain. Per-task unit tests pass because each test uses isolated fixtures (bare ids 's1','s2','s3' on the hook, dot-form constants on the bridge). The compounder should consider adding an end-to-end contract test as a planner-workflow rule for any future multi-task type chain.
- The "component built but never wired" pattern (FIND-SPRINT-040-3, -5, -9) appears three times in a single epic. This is a planning gap: the workflow-progress-visualization epic shipped five components but assigned no task ownership for the host integrations in CyboflowRoot/RunRightRail. Compounder rule: every epic that introduces N visual components in N tasks must dedicate a final task (or amend the last task's files_owned) to host-wiring.
