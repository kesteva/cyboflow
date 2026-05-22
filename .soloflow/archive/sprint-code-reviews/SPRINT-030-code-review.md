---
sprint: SPRINT-030
findings_count:
  critical: 0
  important: 3
  minor: 3
---

# Sprint Code Review: SPRINT-030

## Scope
- Base: c8f07cf7e73e07b6aac863b6c42f4c1b6b8c32ac
- Tasks reviewed: [TASK-696, TASK-697, TASK-698, TASK-699, TASK-700, TASK-701, TASK-702, TASK-703, TASK-704, TASK-705]
- Files changed: 22
- Cross-task hotspots:
  - frontend/src/components/cyboflow/RunView.tsx (TASK-696, TASK-699, TASK-700)
  - frontend/src/components/cyboflow/__tests__/RunView.test.tsx (TASK-696, TASK-699, TASK-700)
  - shared/types/claudeStream.ts (TASK-696, TASK-700)
  - frontend/src/components/__tests__/DraggableProjectTreeView.runs.test.tsx (TASK-703, TASK-704)

## Findings queued
6 findings appended to `.soloflow/active/findings/SPRINT-030-findings.md` for the next `/soloflow:compound` run. Severity breakdown: critical=0, important=3, minor=3.

### Important (medium severity)
- FIND-SPRINT-030-7 — Inline `{ type: StreamEventType; payload: unknown; timestamp: string }` literal duplicated 4× across runLauncher publisher signature and three test sites; runEventBridge already declares an unexported `StreamEnvelope` interface with the same shape.
- FIND-SPRINT-030-8 — `RunStartedEvent` declares `type: 'run_started'` as required, but runLauncher's emission omits the inner `type` field; type/runtime drift invisible to TS because publisher `payload` is `unknown`.
- FIND-SPRINT-030-9 — TASK-705 introduced hand-rolled `validateNumberArg`/`validateStringArg` in cyboflow.ts IPC handlers while the project already uses Zod in tRPC routers and streamParser schemas; duplicates functionality and complicates the planned ipcLink cutover.

### Minor (low severity)
- FIND-SPRINT-030-10 — Inconsistent typing idiom within cyboflow-stream-publisher.test.ts: three explicit annotations + one inline `as StreamEventType` cast (TASK-700).
- FIND-SPRINT-030-11 — DraggableProjectTreeView.runs.test.tsx test (g) added in TASK-703 has assertions that are a strict subset of test (e); cannot fail without test (e) also failing.
- FIND-SPRINT-030-12 — cyboflowStore.test.ts tests 5 and 7 use envelope `type: 'unknown'` paired with system-shaped or untyped payloads after TASK-700's fixture rewrite; technically compiles but no longer represents what real IPC delivers.

## Notes on prior findings (already on the queue from per-task reviewers)
- FIND-SPRINT-030-2 (TASK-696 code-reviewer): resolved-by TASK-700 — verified the `ExtendedStreamEventType` alias and casts in RunView.tsx no longer exist (TASK-700 landed the widening).
- FIND-SPRINT-030-5 (TASK-700 verifier): planner/readonly conflict — orthogonal to the redundancy findings above; left for compounder triage.

