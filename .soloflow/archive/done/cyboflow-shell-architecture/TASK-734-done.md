---
id: TASK-734
sprint: SPRINT-036
epic: cyboflow-shell-architecture
status: done
summary: "Delete dead frontend toolFormatter and orphaned formatJsonForWeb export."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-734 — Done

## Summary
Removed `frontend/src/utils/toolFormatter.ts` (541 LOC) and its test file (189 LOC / 15 tests), and pruned `formatJsonForWeb` from `frontend/src/utils/formatters.ts`. The live runtime path through `main/src/utils/toolFormatter.ts` (called from `main/src/ipc/session.ts:809`) is untouched. Resolves FIND-SPRINT-034-12.

## Verification
- `pnpm --filter frontend test` → 322 pass (down from ~336; the 15 deleted cases account for the drop).
- `pnpm --filter main test` → 653 pass.
- `pnpm typecheck` → 0 errors across all workspaces.
- `pnpm lint` → 0 errors.
- All six acceptance-criterion grep / file checks pass.
- Visual verification: not_applicable — utility deletion with no UI surface.

## Code Review
CLEAN — no findings queued.

## Commit
- `c4eb652` — `feat(TASK-734): delete dead frontend toolFormatter and orphaned formatJsonForWeb export`
