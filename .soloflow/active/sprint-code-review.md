---
sprint: SPRINT-008
findings_count:
  critical: 0
  important: 3
  minor: 6
---

# Sprint Code Review: SPRINT-008

## Scope
- Base: 61bd60d (pre-sprint HEAD)
- Tasks reviewed: [TASK-587, TASK-588, TASK-589, TASK-590, TASK-591, TASK-592, TASK-593, TASK-594, TASK-595]
- Files changed (code only): 38
- Cross-task hotspots:
  - main/src/services/panels/claude/claudeCodeManager.ts (TASK-590 rewrite — single-task hotspot with downstream effects)
  - shared/types/claudeStream.ts (TASK-589 retarget) → main/src/services/streamParser/schemas.ts → __tests__/sdkMockFactories.ts (TASK-594)
  - shared/types/approval.ts (TASK-588 extract) → approvalRouter.ts, cyboflowPermissionIpcServer.ts, claudeCodeManager.ts
  - main/package.json + package.json + pnpm-lock.yaml (TASK-587 deps + TASK-591 build-script removal)

## Findings queued
9 new findings appended to `.soloflow/active/findings/SPRINT-008-findings.md` for the next `/soloflow:compound` run.
Severity breakdown across the full queue: critical=0 important=3 minor=12 (15 total open;
6 were already queued by per-task reviewers before this pass).

### New findings (sprint-code-reviewer pass)

Important (medium):
- FIND-SPRINT-008-8 — SystemCompactBoundary mock factory + test missing (TASK-589 type/schema added, TASK-594 follow-through gap)
- FIND-SPRINT-008-9 — resultErrorMaxStructuredOutputRetries factory missing (5th result subtype unexercised by tests)
- FIND-SPRINT-008-10 — CyboflowPermissionIpcServer + permissionIpcPath plumb still booted but unused after SDK substrate rewrite

Minor (low):
- FIND-SPRINT-008-11 — Unused import `assertTransitionAllowed` in claudeCodeManager.ts
- FIND-SPRINT-008-12 — `CYBOFLOW_RUN_ID` env var set with no consumer in SDK substrate
- FIND-SPRINT-008-13 — Stale `__fixtures__/README.md` describes 11 JSON files deleted by TASK-594
- FIND-SPRINT-008-14 — killProcess cleanupPipeline ordering loses RawEventsSink rows for kill-mid-stream
- FIND-SPRINT-008-15 — Dead `@anthropic-ai/claude-code: ^2.0.0` dependency after SDK migration
- FIND-SPRINT-008-16 — Every Claude run emits stub `console.warn` from clearPendingForRun (until TASK-304)

### Cross-task patterns observed

1. **Dead-code residuals from substrate replacement.** TASK-590 rewrote ClaudeCodeManager to use the Claude Agent SDK, replacing the old MCP-bridge-over-unix-socket permission path with an in-process PreToolUse hook. TASK-591 deleted the build artifact for the bridge. But the surrounding plumbing — CyboflowPermissionIpcServer boot in index.ts:566, permissionIpcPath ctor parameter, CYBOFLOW_RUN_ID env var, assertTransitionAllowed import, @anthropic-ai/claude-code dep — was not removed alongside. Each is benign individually; collectively they form a meaningful island of dead substrate that survives the migration.

2. **Type/schema/factory triple drift.** TASK-589 widened the ClaudeStreamEvent union to match the SDK shape (added SystemCompactBoundaryEvent and a 5th ResultEvent subtype). TASK-594 then migrated tests to factory-based mocks. The two tasks compose to leave two variants un-exercised by tests (compact_boundary, error_max_structured_output_retries). The Zod schemas know about them; the factories don''t. Per-task reviewers couldn''t see this gap because each task individually satisfied its own AC.

3. **Cross-cutting stub call pattern.** TASK-588 introduced a clearPendingForRun no-op stub; TASK-590 wired it into runSdkQuery''s finally. The composition produces a guaranteed `console.warn` line on every Claude run termination — neither task surfaced this in isolation.

No Critical findings — no cross-task security regressions, auth bypasses, secrets, or input-validation drift observed.
