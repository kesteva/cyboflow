---
sprint: SPRINT-031
findings_count:
  critical: 0
  important: 3
  minor: 2
---

# Sprint Code Review: SPRINT-031

## Scope
- Base: 2049c6b93d1367f65e92101fd8f6d36c1c6a7dec
- Tasks reviewed: [TASK-718, TASK-719, TASK-720, TASK-721, TASK-722, TASK-723, TASK-724, TASK-725, TASK-726]
- Files changed: 26 (code) + docs/CODE-PATTERNS.md
- Cross-task hotspots:
  - shared/types/claudeStream.ts (TASK-724 + TASK-725)
  - main/src/orchestrator/runLauncher.ts (TASK-724 + TASK-725)
  - main/src/orchestrator/runEventBridge.ts (TASK-724 + TASK-725)
  - main/src/ipc/__tests__/cyboflow-stream-publisher.test.ts (TASK-724 + TASK-725)
  - main/src/orchestrator/approvalCreatedBridge.ts (TASK-720 + TASK-721)
  - main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts (TASK-722)

## Findings queued
5 new findings appended to `.soloflow/active/findings/SPRINT-031-findings.md` for the next `/soloflow:compound` run. Severity breakdown: critical=0, important=3, minor=2. (4 prior findings from per-task code-reviewers / verifier already in the file: FIND-SPRINT-031-1 through -4.)

### Important (3)
- FIND-SPRINT-031-5 — approvalCreatedBridge.test.ts (TASK-720) shipped an inline `createTestDb` that immediately violates the shared `__test_fixtures__/orchestratorTestDb.ts` fixture TASK-722 introduced in the same sprint.
- FIND-SPRINT-031-6 — same test file inlines `> 512 ? .slice(0, 512)` truncation, duplicating the `truncatePayloadPreview` helper TASK-721 extracted in the same sprint.
- FIND-SPRINT-031-7 — approvals-row test seeding helpers are duplicated across 4+ files with 4 different signatures; TASK-722 extracted workflow_runs seeding but stopped short of approvals, leaving the new fixture half-complete (same drift class as FIND-SPRINT-018-12).

### Minor (2)
- FIND-SPRINT-031-8 — approvalCreatedBridge.test.ts re-implements the entire `listPending` SELECT + Approval[] projection locally (TASK-720), silently decoupling its parity assertion from production drift.
- FIND-SPRINT-031-9 — `StreamEnvelope` is constructed at two sites (`runLauncher.ts:146` + `runEventBridge.ts:240`) with hand-wired `type`/`payload`/`timestamp` — invites future field-drift across TASK-724 + TASK-725's typed-union work.
