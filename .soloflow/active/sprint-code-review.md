---
sprint: SPRINT-005
findings_count:
  critical: 3
  important: 3
  minor: 11
---

# Sprint Code Review: SPRINT-005

## Scope
- Base: d1fa0387205bb060a7f631a8ee5e223a4e77c251
- Tasks reviewed: [TASK-151, TASK-152, TASK-153, TASK-154, TASK-155, TASK-201, TASK-202, TASK-203, TASK-204, TASK-205]
- Files changed: 32 production/source files (+ tests + docs + plans/state)
- Cross-task hotspots:
  - `main/src/services/streamParser/` (5 tasks: TASK-201/202/203/205 all wrote new modules here; logger/error/import patterns drifted across them)
  - `main/src/services/cyboflow/` (TASK-153 transitions + TASK-154 stateMachine — designed in parallel, never composed)
  - `main/src/services/panels/claude/claudeCodeManager.ts` (TASK-204 single-task touch; downstream callsites still ship the now-broken default)
  - `main/src/database/migrations/006_cyboflow_schema.sql` + `main/src/database/database.ts` (TASK-151 + TASK-152 — FK declarations land, FK pragma does not)

## Findings queued
7 new findings appended to `.soloflow/active/findings/SPRINT-005-findings.md` (FIND-SPRINT-005-11 through -18, with -8 already resolved) for the next `/soloflow:compound` run. Combined with the 9 pre-existing per-task findings, the queue now totals 17 open + 1 resolved. Severity breakdown across the entire sprint queue: critical=3, important=3, minor=11.

### Critical (3)
- FIND-SPRINT-005-6 (filed pre-review) — TASK-204 closed the `--dangerously-skip-permissions` flag at the manager level, but every UI callsite still defaults `permissionMode: 'ignore'`; standard session creation will throw at spawn time.
- FIND-SPRINT-005-9 (filed pre-review) — TASK-205 reduced ClaudeMessageTransformer to identity but did not wire MessageProjection into the IPC data path; renderer will crash with `TypeError: Cannot read properties of undefined (reading 'some')` on first Claude panel open.
- FIND-SPRINT-005-12 (new) — Migration 006 declares 4 ON DELETE CASCADE foreign keys, but `PRAGMA foreign_keys = ON` is never executed; all FK declarations are silently inert and orphan rows will accumulate.

### Important (3)
- FIND-SPRINT-005-11 (new) — TASK-153 `transitions.ts` mutates `workflow_runs.status` via raw SQL without calling TASK-154's `assertTransitionAllowed`; the two cyboflow-epic modules are not composed and the stateMachine validator has zero production callers.
- FIND-SPRINT-005-13 (new) — Six distinct ad-hoc `ILogger`-shaped interfaces in the streamParser folder (`IWarnLogger`, `IDebugLogger`, `IStreamParserLogger`, `ICompletionDetectorLogger`, `IRawEventsSinkLogger`, `IMessageProjectionLogger`); three are structurally identical. No shared contract.
- FIND-SPRINT-005-18 (new) — Settings.tsx (lines 39, 76, 292-293, 313) is a callsite missed by FIND-SPRINT-005-6 enumeration; users opening Settings and saving will overwrite the ConfigManager `defaultPermissionMode` flip with `'ignore'`.

### Minor (11)
- FIND-SPRINT-005-1 — File-runner emits ~18 WARN lines for legacy non-prefixed `.sql` files on every boot.
- FIND-SPRINT-005-2 — `cyboflowSchema.test.ts` existing-install test exercises a related but different path than the AC describes.
- FIND-SPRINT-005-3 — Unused imports (`writeFileSync`, `mkdirSync`) in cyboflowSchema.test.ts.
- FIND-SPRINT-005-4 — No-op type assertion in `isTransitionAllowed`.
- FIND-SPRINT-005-5 — Duplicate safeParse implementation between `parseClaudeStreamEvent` (schemas.ts) and `TypedEventNarrowing.narrow`.
- FIND-SPRINT-005-7 — `RawEventsSink` not exported from streamParser barrel (extended into -14 below).
- FIND-SPRINT-005-10 — `messageProjection.test.ts` test 18 asserts only `.not.toThrow()` without verifying the warn-log payload.
- FIND-SPRINT-005-14 (new) — Barrel also missing `CompletionDetector` and `MessageProjection` exports (extension of -7).
- FIND-SPRINT-005-15 (new) — TASK-204 throws use generic `new Error()` while the cyboflow epic uses typed error subclasses with `code` discriminants.
- FIND-SPRINT-005-16 (new) — `eventRouter.ts` imports `node:events`, `completionDetector.ts` imports `events`; same module two ways within the same folder.
- FIND-SPRINT-005-17 (new) — Orphan-module tracker: ~1500 LOC of well-tested but production-dead classes (`MessageProjection`, `CompletionDetector`, `RawEventsSink`, `assertTransitionAllowed`, `transitionTo/FromAwaitingReview`, plus the 4-stage pipeline) awaiting follow-up wiring; compounder should batch them into a single wire-up epic.
