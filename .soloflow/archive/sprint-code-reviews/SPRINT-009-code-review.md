---
sprint: SPRINT-009
findings_count:
  critical: 2
  important: 6
  minor: 1
---

# Sprint Code Review: SPRINT-009

## Scope
- Base: 2afae80afd769b4cdaa37e0b783ec901f4cf835d
- Tasks reviewed: [TASK-351, TASK-352, TASK-353, TASK-354, TASK-355]
- Files changed: 26 (excluding .soloflow/ state)
- Cross-task hotspots: [main/src/orchestrator/runLauncher.ts]

## Findings queued

9 findings appended to `.soloflow/active/findings/SPRINT-009-findings.md` for the next `/soloflow:compound` run. Severity breakdown: critical=2, important=6, minor=1.

### Critical
- **FIND-SPRINT-009-10** — Parallel transport layers: TASK-354 raw IPC duplicates the existing tRPC routers (`main/src/orchestrator/trpc/routers/{workflows,runs,events}.ts`) with INCOMPATIBLE id types (numeric vs string z.string()). Drift from ARCHITECTURE.md:55 target.
- **FIND-SPRINT-009-14** — Hardcoded SoloFlow plugin path `0.9.12` (5 copies in workflowRegistry.ts:37-43, but installed version is 0.10.3). Combined with seed()'s swallow-and-default behavior, every workflow silently degrades to `permission_mode='default'`, defeating the entire approval-policy mechanism.

### Important
- **FIND-SPRINT-009-11** — `REGISTRY_SCHEMA` SQL block duplicated as 4 inline copies (already drifting in index declarations) across the sprint test suite.
- **FIND-SPRINT-009-12** — `dbAdapter()` shim for DatabaseLike duplicated across 4 test files.
- **FIND-SPRINT-009-13** — `mkdtempSync(...)` pattern duplicated across 6 sprint files; only 2 clean up. Generalizes FIND-SPRINT-009-8.
- **FIND-SPRINT-009-15** — `frontend/src/utils/cyboflowApi.ts` bypasses the documented `frontend/src/utils/api.ts` convention (CODE-PATTERNS.md §`utils/api`).
- **FIND-SPRINT-009-16** — Module-level lazy singletons inside `main/src/ipc/cyboflow.ts:26-79` violate CODE-PATTERNS.md §IPC handler structure (handlers should be thin) and force vi.resetModules() in every test.
- **FIND-SPRINT-009-17** — Stream pipeline subscriber wired (cyboflowApi.subscribeToStreamEvents + RunView) but no main-side publisher exists — sprint shipped a UI half-loop. Compounds with FIND-SPRINT-009-6 preload whitelist drop.

### Minor
- **FIND-SPRINT-009-18** — Fragile `pnpm test:gate` script: `--filter main exec` plus `--config ../vitest.config.gate.ts` couples the script to current workspace layout.
