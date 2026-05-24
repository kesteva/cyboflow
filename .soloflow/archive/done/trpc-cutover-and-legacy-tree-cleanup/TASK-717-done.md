---
id: TASK-717
sprint: SPRINT-035
epic: trpc-cutover-and-legacy-tree-cleanup
status: done
summary: "Delete legacy main/src/trpc/ tree; inline handlers; update ARCHITECTURE.md; resolve four queued doc-drift findings."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-717 — Done

Deleted the entire `main/src/trpc/` legacy directory (6 source files + 1 test file). The `approveRestOfRunHandler`, `rejectRestOfRunHandler`, and `decideRestOfRunHandler` are inlined verbatim into `main/src/orchestrator/trpc/routers/approvals.ts`. Migrated direct handler unit tests to `main/src/orchestrator/trpc/__tests__/approvalsHandler.test.ts` (8 tests, +2 vs. legacy).

Cleaned doc-drift: ARCHITECTURE.md (legacy tRPC tree note + TBD-tRPC-cutover removed; transport status rewritten), routers/health.ts (dead `getHealthProvider` export removed; docstring updated), orchestrator/health.ts (Usage docstring updated), CODE-PATTERNS.md (validateInput example channel updated). Resolves FIND-SPRINT-035-16, -17, -18, -19.

## Outcomes
- Executor: COMPLETED (commits `833f2ad`, `2c5a135`, `86a7d6f`).
- Verifier: APPROVED — all 7 ACs MET (AC6 unit-test gates pass; Playwright pre-existing failures unrelated to diff).
- Code-reviewer: CLEAN — verbatim port; SQL parameterization + mutex + per-run scoping preserved.

## Findings logged this task
- FIND-SPRINT-035-20/21/24: misclassified scope deviations (verifier resolved as bookkeeping).
- FIND-SPRINT-035-22: false-positive AC2 grep pattern in `runLifecycle.test.ts:32` (intra-orchestrator relative import; TASK-733-owned).
- FIND-SPRINT-035-23: stale docblock in `shared/types/stuckInspection.ts` (queued for compound).
- FIND-SPRINT-035-25: `docs/ARCHITECTURE-diagram.md` still has `LegacyTrpc` node (out of scope of AC7's named file).
- FIND-SPRINT-035-26 (medium, claude-md): `pnpm test` Playwright failures are pre-existing on parent commit; the root `test` script ambiguity is worth documenting.

## Files
- Deleted: `main/src/trpc/` (entire directory)
- Updated: `main/src/orchestrator/trpc/routers/approvals.ts`
- NEW: `main/src/orchestrator/trpc/__tests__/approvalsHandler.test.ts`
- Updated: `main/src/orchestrator/trpc/routers/health.ts`
- Updated: `main/src/orchestrator/health.ts`
- Updated: `docs/ARCHITECTURE.md`
- Updated: `docs/CODE-PATTERNS.md`
