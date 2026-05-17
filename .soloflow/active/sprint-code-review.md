---
sprint: SPRINT-012
findings_count:
  critical: 0
  important: 4
  minor: 3
---

# Sprint Code Review: SPRINT-012

## Scope
- Base: 7b785f312a93d89c38cab1095e20eccb18ce8970
- Tasks reviewed: [TASK-451, TASK-452, TASK-453, TASK-454, TASK-455]
- Files changed: 22 source files (+ 6 test files, + 5 .soloflow plan/done files)
- Cross-task hotspots:
  - main/src/orchestrator/mcpServer/cyboflowMcpServer.ts (TASK-451, TASK-453)
  - main/src/orchestrator/mcpServer/mcpServerLifecycle.ts (TASK-454, TASK-455)
  - main/src/orchestrator/mcpServer/scriptPath.ts (TASK-454, called from TASK-454-modified claudeCodeManager.ts)
  - main/src/ipc/cyboflow.ts (TASK-455, two commits)

## Findings queued
7 findings appended to `.soloflow/active/findings/SPRINT-012-findings.md` for the next `/soloflow:compound` run. Severity breakdown: critical=0, important=4, minor=3.

### Important (medium)
- FIND-SPRINT-012-11 — Duplicate `OrchestratorHealth` singleton-injection setters (`setCyboflowHealth` + `setHealthProvider`) with duplicate fallback constants; bootstrap must call both or paths diverge.
- FIND-SPRINT-012-12 — Redundant asar handling: `asarUnpack` entry AND extract-to-`~/.cyboflow/` branch both target the same script; one is dead config.
- FIND-SPRINT-012-13 — `resolveMcpServerScriptPath()` does sync `readFileSync` + `writeFileSync` + `chmodSync` on every call; called per-session-spawn and per-subprocess-spawn with no memoization.
- FIND-SPRINT-012-14 — New module-level singleton-injection idiom in `routers/health.ts` + `ipc/cyboflow.ts` conflicts with the `throwNotImplemented`/services-injection pattern used by sibling routers.

### Minor (low)
- FIND-SPRINT-012-15 — `composeMcpServers()` fire-and-forget `findNodeExecutable()` cache leaves the first cyboflow MCP session with bare `'node'`; will fail under nvm/asdf if shell PATH isn't enriched.
- FIND-SPRINT-012-16 — `mcp-submit-checkpoint` writes `raw_events.run_id='orchestrator'` (the lifecycle sentinel) for singleton-side checkpoints; no FK so it silently creates a synthetic run namespace.
- FIND-SPRINT-012-17 — Cross-run scope of `cyboflow_list_pending_approvals` and `cyboflow_get_run` is by-design but not documented in `docs/cyboflow_system_design.md`; risks accidental narrowing by a future contributor.

## Convention check
Project-level `docs/CODE-PATTERNS.md` was checked. No directory-scoped CLAUDE.md exists under `main/src/orchestrator/` or `main/src/ipc/`. The singleton-injection idiom introduced in TASK-455 is novel relative to documented patterns; that drift is captured in FIND-SPRINT-012-14.

## Cross-cutting store-action sweep
N/A — no frontend store actions were touched. Sidebar changes were a single component-local additive section (`useMcpHealth` hook + status dot); no shared store slice was modified.

## Sprint Code Review Status
- **Status:** REPORTED
- **Summary file:** /Users/raimundoesteva/Developer/cyboflow/.soloflow/active/sprint-code-review.md
- **Findings file:** /Users/raimundoesteva/Developer/cyboflow/.soloflow/active/findings/SPRINT-012-findings.md
- **Findings queued:** critical=0 important=4 minor=3
