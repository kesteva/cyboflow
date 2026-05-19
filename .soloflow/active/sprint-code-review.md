---
sprint: SPRINT-021
findings_count:
  critical: 2
  important: 2
  minor: 2
---

# Sprint Code Review: SPRINT-021

## Scope
- Base: ab751d4f98bee772435c4bc82fd5e8df45c04271
- Tasks reviewed: [TASK-650, TASK-651, TASK-652, TASK-660, TASK-661, TASK-662]
- Files changed: 11 source + 7 test (1,287 net LOC, +2,375/-1,087)
- Cross-task hotspots: [main/src/index.ts (T660/T661/T662), main/src/orchestrator/runExecutor.ts (T650/T661/T662), main/src/services/panels/claude/claudeCodeManager.ts (T651/T661)]

## Findings queued
6 findings appended to `.soloflow/active/findings/SPRINT-021-findings.md` for the next `/soloflow:compound` run. Severity breakdown: critical=2, important=2, minor=2.

### Critical
- FIND-SPRINT-021-4 — panelId/runId mismatch breaks ApprovalRouter routing AND silences RunEventBridge filter (runs stuck in `starting`; every tool call denied under permission_mode=default/acceptEdits).
- FIND-SPRINT-021-5 — Latent raw_events double-INSERT: RunEventBridge and ClaudeCodeManager.runSdkQuery both construct a router+sink for the same id. Surfaces once FIND-4 unblocks the bridge.

### Important
- FIND-SPRINT-021-6 — cancel() calls teardownRun BEFORE firing the `canceled` lifecycle transition; works by accident today, fragile for future state-using transitions.
- FIND-SPRINT-021-7 — ClaudeSpawnerLike adapter uses `as unknown as { ... }` double-casts that bypass TypeScript structural checks (and the project ban on `any`).

### Minor
- FIND-SPRINT-021-8 — Stale doc comment on runLauncher.StreamEventPublisher claims the concrete publisher lives in ipc/cyboflow.ts; it moved to main/src/index.ts in TASK-660.
- FIND-SPRINT-021-9 — Stale runEventBridge JSDoc integration contract says `options.panelId === runId`; current wiring violates that contract (surface form of FIND-4).
