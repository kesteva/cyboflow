---
id: TASK-750
sprint: SPRINT-037
epic: testing-infrastructure
status: done
summary: "Deleted utils/trpcClient shim; migrated 8 production importers + 1 test value-import to canonical trpc/client; refreshed docs."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-750 — Delete utils/trpcClient shim

## What changed

- 8 production callers + 1 test value-import migrated from `'…/utils/trpcClient'` → `'…/trpc/client'` (relative depths preserved).
- `frontend/src/utils/trpcClient.ts` deleted.
- JSDoc/comment scrub in `frontend/src/trpc/client.ts`, `frontend/src/test/setup.ts`, `frontend/src/stores/__tests__/reviewQueueStore.test.ts`.
- Doc updates: `docs/CODE-PATTERNS.md` (section retitled + line 362 example), `docs/ARCHITECTURE.md` (lines 165-178), `docs/ARCHITECTURE-diagram.md` (line 34 mermaid label, node ID `TrpcClient` preserved).

## Verification

- L1 grep ACs: 7/7 met. All three deterministic greps (`utils/trpcClient` import lines / any-occurrence in frontend/src / any-occurrence in docs) exit 1 with zero output.
- L2 tests: 357/357 frontend tests pass.
- L2 typecheck + lint: clean (0 errors).
- L3 visual: not_applicable (pure refactor, no behavior change).

## Code review

CLEAN — no in-diff findings. Reviewer surfaced one out-of-diff finding (FIND-SPRINT-037-2, low-severity cleanup):

> `.soloflow/active/plans/trpc-cutover-and-legacy-tree-cleanup/EPIC-trpc-cutover-and-legacy-tree-cleanup.md:12` still references the deleted shim path in its Context paragraph. Single-line string-replacement fix, queued for compound.

## Commits

- `9927ca8` refactor: migrate all importers to canonical trpc/client
- `1127800` refactor: scrub JSDoc/comments
- `968a985` refactor: delete utils/trpcClient shim
- `7446730` docs: update CODE-PATTERNS.md / ARCHITECTURE.md / ARCHITECTURE-diagram.md
- `0356282` docs: remove final utils/trpcClient string from CODE-PATTERNS mock-tRPC section
