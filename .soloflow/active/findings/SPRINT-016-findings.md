---
sprint: SPRINT-016
pending_count: 1
last_updated: 2026-05-18
---

# Findings Queue

## FIND-SPRINT-016-1
- **source:** TASK-599 (verifier)
- **type:** claude-md
- **severity:** medium
- **status:** open
- **location:** docs/CODE-PATTERNS.md (or AGENTS.md/CLAUDE.md executor guidance)
- **description:** TASK-599 executor reported the implementation complete with `test_strategy.needed: false` because `preload.ts` has no sibling test file, then skipped running `pnpm --filter main typecheck`. The committed change introduced a real TS error (`src/preload.ts(627,60): error TS2345 — wrapper type incompatible with Map value type`). The executor's "no sibling tests → no verification" inference is wrong for files that are still typechecked at the workspace level. CLAUDE.md lists `pnpm typecheck` in Common Commands but does not explicitly tell executors to run it after editing `main/src/preload.ts` or similar untested-but-type-checked files.
- **suggested_action:** Add an executor guidance line: "When modifying TS files that lack sibling tests, you must still run the workspace `typecheck` (and `lint`) for that workspace before claiming completion." Consider codifying it under TypeScript Rules in CLAUDE.md.
- **resolved_by:**
