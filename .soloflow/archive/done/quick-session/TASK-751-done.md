---
id: TASK-751
sprint: SPRINT-038
epic: quick-session
status: done
summary: "Wire run_id through DbSession → Session mapper; add 3-case round-trip regression test (fixes silent Quick-badge inversion from FIND-SPRINT-037-1)"
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-751 — Done

Mapper edit + dedicated regression test. Executor passed verifier APPROVED first try (executor_loops: 0); code-reviewer CLEAN first try (code_review_rounds: 0); test-writer NO_TESTS_NEEDED (executor-committed file covered all three plan targets).

**Changes:**
- `main/src/database/models.ts` — added `run_id?: string | null` to the `Session` interface
- `main/src/services/sessionManager.ts` — added `runId: dbSession.run_id ?? null` to `convertDbSessionToSession`
- `main/src/services/__tests__/sessionManagerRunIdMapping.test.ts` — new file with three round-trip cases

**Commit:** `5a99ee2 feat(TASK-751): wire run_id through DbSession → Session mapper and add regression tests`

**Tests:** `pnpm --filter main test` PASS (72 files, 659 tests). `pnpm typecheck` exits 0. `pnpm lint` 0 errors.

**Visual:** N/A — server-side mapper change; the read-only UI consumer (`SessionListItem.tsx:431`) was unchanged and its `session.runId == null` predicate is now driven by correct data.
