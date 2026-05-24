---
sprint: SPRINT-035
findings_count:
  critical: 0
  important: 2
  minor: 3
---

# Sprint Code Review: SPRINT-035

## Scope
- Base: cd5eedc3644d372e38d3a78a62f623712ac43046
- Tasks reviewed: [TASK-709, TASK-710, TASK-711, TASK-712, TASK-713, TASK-714, TASK-715, TASK-716, TASK-717, TASK-732, TASK-733]
- Files changed: 74 (2,393 insertions / 3,023 deletions per diff stat)
- Cross-task hotspots:
  - main/src/orchestrator/trpc/routers/runs.ts (TASK-709, TASK-710, TASK-712 — schema + 3 procedures + 3 setter deps)
  - main/src/orchestrator/trpc/routers/workflows.ts (TASK-711 implement; TASK-714 cut renderer over)
  - main/src/orchestrator/trpc/routers/approvals.ts (TASK-717 inlined handlers; TASK-716 register cleanup)
  - main/src/orchestrator/trpc/context.ts (TASK-711 added workflowRegistry capability)
  - main/src/index.ts (TASK-712, TASK-713, TASK-716 — boot wiring sequence)
  - main/src/ipc/cyboflow.ts (TASK-716 channel deletion sweep)
  - main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts (TASK-732 + TASK-733 fixture extension and call-site sweep)

## Findings queued
5 new findings appended to `.soloflow/active/findings/SPRINT-035-findings.md` for the next `/soloflow:compound` run. Severity breakdown: critical=0, important=2, minor=3.

Pre-existing findings in the same file (from per-task reviewers and verifiers): 13 — see existing entries FIND-SPRINT-035-1 through FIND-SPRINT-035-31. Total pending: 18.

### Important
- **FIND-SPRINT-035-32 — `cyboflow.runs.cancel` permanently broken: `setCancelDeps()` is never called at boot.** Three of four sibling setters (`setCancelAndRestartDeps`, `setStartRunDeps`, `setHealthProvider`) are wired in `main/src/index.ts`; `setCancelDeps` was missed. The procedure ships live but always throws METHOD_NOT_SUPPORTED. No production caller hits it today (frontend only uses `cancelAndRestart`) — latent bug.
- **FIND-SPRINT-035-33 — Duplicated `DatabaseLike` type in `approvals.ts`.** TASK-717's handler-inlining work redeclared a narrow local `DatabaseLike` instead of importing the canonical one from `../../types`. The three other orchestrator handler files (`inspectorQueries.ts`, `runQueries.ts`, `approvalListing.ts`) all import canonical — clean cross-task pattern drift.

### Minor
- **FIND-SPRINT-035-34 — Principal-scoping guard is statically dead code.** `ctx.userId` is typed as the literal `'local'`, so the 5 `ctx.userId !== 'local'` checks in `runs.ts` are unreachable at the type level. Tests must cast `'someone-else' as 'local'` to exercise the branch. Pick option: widen the type to make it live, or drop the guards (workflows.ts and approvals.ts already chose the latter). Refines FIND-SPRINT-035-4 with the type-system angle.
- **FIND-SPRINT-035-35 — `vi.mock` target inconsistency for the tRPC client.** 9 renderer test files mock the shim (`'…/utils/trpcClient'`); the global setup + CyboflowRoot.test.tsx + the shim's own docstring point to the canonical (`'…/trpc/client'`). Both work today because the shim is a pure re-export; the day the shim grows logic, the patterns diverge.
- **FIND-SPRINT-035-36 — Module-level mutable typing inconsistency in `main/src/index.ts`.** TASK-712 added 3 new singletons (`workflowRegistry`, `runLauncher`, `orchestratorHealth`) as bare `let foo: T;` with no `| null = null` initializer, diverging from the sibling `taskQueue: TaskQueue | null = null` pattern. Reads before `initializeServices()` would be silently `undefined`.

## Notes
- The convention check, inline quality/security assessment, and cross-cutting store-action sweep all completed. No security findings (the FORBIDDEN guard discussion is structural, not a security regression — every procedure still gates on `protectedProcedure`'s `userId` truthiness, and the v1 principal is always `'local'`).
- Store-action sweep was empty: `setActiveRun` is only called from explicit user gestures (WorkflowPicker, DraggableProjectTreeView), no multi-field resets introduced.
- Several existing findings (FIND-1, FIND-23, FIND-29, FIND-30, FIND-31) cover doc drift and follow-on cleanups already routed for the next compound pass — not duplicated here.
