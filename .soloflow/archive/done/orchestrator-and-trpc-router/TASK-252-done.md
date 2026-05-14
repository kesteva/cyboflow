---
id: TASK-252
sprint: SPRINT-006
epic: orchestrator-and-trpc-router
status: done
summary: "Add RunQueueRegistry — per-runId PQueue serialization primitive with drain-on-delete semantics"
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-252 — Done

## Summary

Built `RunQueueRegistry` (the per-run serialization primitive for the orchestrator). Each runId maps to its own `PQueue({ concurrency: 1 })` so mutations within a run serialize while different runs proceed concurrently. Drain-on-delete and drainAll lifecycle methods support clean shutdown.

## Changes

- `main/src/orchestrator/RunQueueRegistry.ts` (new) — class with `getOrCreate`, `has`, `delete`, `drainAll`, `stats`; single `new PQueue({ concurrency: 1 })` site; zero electron imports; file-level JSDoc with no-recursive-enqueue rule
- `main/src/orchestrator/__tests__/RunQueueRegistry.test.ts` (new, 7 vitest tests total — 4 from the plan's targets plus 3 augmenting coverage)

## Commits

- `5f3c2c5 feat(TASK-252): add RunQueueRegistry with per-run PQueue serialization`
- `f6a6457 test(TASK-252): add RunQueueRegistry coverage augmentation`

## Verification

- All 7 RunQueueRegistry tests pass
- `pnpm --filter main typecheck` exit 0
- `pnpm --filter main lint` 0 errors, no new warnings
- Grep gates: zero electron imports, exactly one `new PQueue` site, no-recursive-enqueue JSDoc present
- Code review: CLEAN
- 22 pre-existing better-sqlite3 native-module ABI mismatch failures are unrelated to this task

## Open issues

The "Lowest Confidence Area" documented in the plan still applies: `delete(runId)` blocks indefinitely if a queued task never resolves (e.g., a 60-minute approval wait). Contract is "callers cancel before calling delete." Higher-level ApprovalRouter (different epic) owns abort semantics — a `deleteForce(runId)` variant may be needed once that lands.
