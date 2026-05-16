---
id: TASK-613
idea: IDEA-009
status: ready
created: 2026-05-15T00:00:00Z
files_owned:
  - vitest.config.frontend.ts
  - package.json
  - frontend/src/components/__tests__/PendingApprovalCard.test.tsx
  - frontend/src/components/__tests__/ReviewQueueView.test.tsx
  - frontend/src/hooks/__tests__/useReviewQueueKeyboard.test.ts
files_readonly:
  - frontend/vite.config.ts
  - frontend/package.json
  - frontend/src/stores/__tests__/reviewQueueStore.test.ts
  - frontend/src/utils/__tests__/reviewQueueSelectors.test.ts
  - frontend/src/utils/migrateLocalStorageKey.test.ts
  - frontend/src/test/setup.ts
  - CLAUDE.md
  - README.md
acceptance_criteria:
  - criterion: "`vitest.config.frontend.ts` at repo root is deleted."
    verification: "test ! -f vitest.config.frontend.ts (exit 0)."
  - criterion: "`test:unit:frontend` script is removed from root package.json."
    verification: "grep -n 'test:unit:frontend' package.json returns no match."
  - criterion: "No `// @vitest-environment jsdom` pragma remains in any frontend test file."
    verification: "grep -rn '@vitest-environment jsdom' frontend/ returns no matches."
  - criterion: "`pnpm --filter frontend test` exits 0 with test count ≥ 96."
    verification: "Command exits 0. Test count matches the post-SPRINT-010 baseline — no test silently skipped."
  - criterion: "No remaining reference to deleted artifacts outside .soloflow/."
    verification: "grep -rn 'test:unit:frontend' . --exclude-dir=node_modules --exclude-dir=.soloflow --exclude-dir=.git returns 0 matches AND grep -rn 'vitest.config.frontend' . --exclude-dir=node_modules --exclude-dir=.soloflow --exclude-dir=.git returns 0 matches."
  - criterion: "No CI workflow or doc references the deleted script or config."
    verification: "grep -rn 'test:unit:frontend\\|vitest.config.frontend' .github docs README.md CLAUDE.md returns 0 matches (skip files that don't exist)."
depends_on: []
estimated_complexity: low
epic: review-queue-ui
test_strategy:
  needed: false
  justification: "Pure config consolidation — no new behaviour to test. The AC `pnpm --filter frontend test exits 0` is itself the regression gate."
---

# Consolidate dual frontend vitest configurations into a single canonical config

## Objective

Delete the root `vitest.config.frontend.ts` (environment: node) and the `test:unit:frontend` root script. Standardize on `pnpm --filter frontend test` driven by `frontend/vite.config.ts` (environment: jsdom). Remove per-file `// @vitest-environment jsdom` pragmas since jsdom becomes the single default.

## Implementation Steps

1. Pre-flight grep for pragmas: `grep -rn '@vitest-environment jsdom' frontend/`. Expected: three matches (PendingApprovalCard.test.tsx, ReviewQueueView.test.tsx, useReviewQueueKeyboard.test.ts).
2. Pre-flight grep for the script/config references: confirm `package.json` and `vitest.config.frontend.ts` are the only out-of-soloflow hits. If `.github/workflows/`, `docs/`, `README.md`, or `CLAUDE.md` reference them, expand `files_owned`.
3. Delete `vitest.config.frontend.ts`.
4. Remove the `test:unit:frontend` script from root `package.json`.
5. Remove the `// @vitest-environment jsdom` first line from each of the three test files.
6. Run `pnpm --filter frontend test` and confirm green with ≥96 tests.
7. Run `pnpm typecheck` and `pnpm lint`.
8. Re-run the step 1 grep as a completeness gate.

## Acceptance Criteria

All six criteria above.

## Test Strategy

Not applicable — config consolidation. The regression gate is the existing test suite count.
