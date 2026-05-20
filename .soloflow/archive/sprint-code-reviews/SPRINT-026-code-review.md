---
sprint: SPRINT-026
findings_count:
  critical: 0
  important: 2
  minor: 4
---

# Sprint Code Review: SPRINT-026

## Scope
- Base: d01095453f1d7a5fd912cc669e7809e833ddd2e3
- Tasks reviewed: [TASK-672, TASK-681, TASK-682, TASK-683]
- Files changed: 16 source files + plans/done docs
- Cross-task hotspots:
  - main/src/services/streamParser/schemas.ts + frontend/src/components/cyboflow/RunView.tsx (schema-retired branches still rendered)
  - main/src/orchestrator/runLauncher.ts + frontend/src/utils/cyboflowApi.ts (synthetic event vs. closed type union)
  - main/src/services/streamParser/messageProjection.ts + (no renderer consumer) (camelCase rename with no read site)

## Findings queued
6 findings appended to `.soloflow/active/findings/SPRINT-026-findings.md` for the next `/soloflow:compound` run. Severity breakdown: critical=0, important=2, minor=4.

### Important
- FIND-SPRINT-026-15 — Dead renderer branches (api_retry, compact) in RunView.SystemEventRow after TASK-681 schema retirement
- FIND-SPRINT-026-16 — Synthetic `run_started` published by runLauncher.ts is not in TASK-682's closed StreamEventType union; renders nothing

### Minor
- FIND-SPRINT-026-17 — TASK-682 camelCase rename (compactTrigger/preTokens) has zero consumers; defensive but dead metadata
- FIND-SPRINT-026-18 — Stale snake_case docstring in messageProjection.test.ts:10 after the camelCase rename
- FIND-SPRINT-026-19 — RunView.tsx:83 leaks `pre_tokens=` snake_case wire key into the user-visible DOM label
- FIND-SPRINT-026-20 — StreamEvent.payload widened to `unknown` drops the discriminated-union narrowing across 5 cast sites in RunView.tsx

## Out-of-scope observations folded into findings
None — all 6 findings sit inside the base_sha..HEAD diff. The cross-cutting store-action sweep on `setActiveRun` / `clearActiveRun` / `appendStreamEvent` (cyboflowStore.ts) is clean — both reset actions are call-site-appropriate, no redundant mid-flow resets observed.
