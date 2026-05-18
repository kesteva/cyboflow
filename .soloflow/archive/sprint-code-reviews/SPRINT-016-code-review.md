---
sprint: SPRINT-016
findings_count:
  critical: 0
  important: 4
  minor: 2
---

# Sprint Code Review: SPRINT-016

## Scope
- Base: 4ed0cea6b46a069be43d1753bda227fbb3125e6e
- Tasks reviewed: [TASK-599, TASK-601, TASK-602, TASK-610]
- Files changed (source): 6 (main/src/preload.ts, main/src/ipc/cyboflow.ts, main/src/orchestrator/runLauncher.ts, main/src/orchestrator/workflowRegistry.ts, frontend/src/components/cyboflow/RunView.tsx, tests/cyboflow-stream-publisher.spec.ts + 4 new test files)
- Cross-task hotspots: main/src/ipc/cyboflow.ts (touched by TASK-602 publisher wiring AND TASK-610 logger-context fix)

## Findings queued
6 new findings appended to `.soloflow/active/findings/SPRINT-016-findings.md` for the next `/soloflow:compound` run. Severity breakdown: critical=0, important=4, minor=2. (The file additionally contains 2 pre-existing TASK-599 / TASK-602 verifier findings; total pending_count is 8.)

### Important
- FIND-SPRINT-016-3 — StreamEvent shape mismatch: publisher emits no top-level `runId`, frontend `StreamEvent` type requires it (cross-task contract drift between TASK-602's two halves).
- FIND-SPRINT-016-4 — Pattern drift in preload.ts: TASK-599 introduced a global `electronListenerWrappers` Map for `electron.on/off` while every other listener site (~28) uses the established closure-capture pattern; two patterns now coexist in the same file.
- FIND-SPRINT-016-5 — TASK-610's `makeLoggerLike` flattens context via JSON.stringify, which silently drops Error stack/message and bloats log messages; native console-fallback branch handles context correctly while the wrapped-Logger branch does not.
- FIND-SPRINT-016-6 — `@cyboflow-hidden` annotation applied to actively-called code (`DEFAULT_SOLOFLOW_WORKFLOWS` is imported and used at runtime in `cyboflow.ts:19,155`); violates CLAUDE.md and docs/CODE-PATTERNS.md convention. Planned TASK-610 cleanup never happened.

### Minor
- FIND-SPRINT-016-7 — Duplicated `validChannels` whitelist + `cyboflow:stream:` prefix check across `electron.on` and `electron.off` in preload.ts.
- FIND-SPRINT-016-8 — `resolveSoloFlowPluginRoot` uses `console.warn` while the rest of the orchestrator uses injected `LoggerLike`; module-level eager evaluation in `DEFAULT_SOLOFLOW_WORKFLOWS` IIFE forces the console path.
