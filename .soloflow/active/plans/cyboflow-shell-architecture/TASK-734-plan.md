---
id: TASK-734
idea: SPRINT-034-compounder
status: in-flight
created: "2026-05-23T22:30:00Z"
files_owned:
  - frontend/src/utils/toolFormatter.ts
  - frontend/src/utils/toolFormatter.test.ts
  - frontend/src/utils/formatters.ts
files_readonly:
  - main/src/utils/toolFormatter.ts
  - main/src/ipc/session.ts
  - shared/utils/extractToolResultText.ts
acceptance_criteria:
  - criterion: frontend/src/utils/toolFormatter.ts no longer exists.
    verification: "test ! -f frontend/src/utils/toolFormatter.ts"
  - criterion: frontend/src/utils/toolFormatter.test.ts no longer exists.
    verification: "test ! -f frontend/src/utils/toolFormatter.test.ts"
  - criterion: formatJsonForWeb is no longer exported from frontend/src/utils/formatters.ts.
    verification: "grep -nE '^export.*formatJsonForWeb' frontend/src/utils/formatters.ts returns 0 matches"
  - criterion: "No source file imports formatJsonForWeb, frontend toolFormatter, or its test."
    verification: "grep -rnE \"from\\s+['\\\"][^'\\\"]*(utils/toolFormatter|formatJsonForWeb)\" frontend/src/ returns 0 matches"
  - criterion: Frontend tests still pass with a count drop of 15 (the deleted toolFormatter.test.ts cases).
    verification: pnpm --filter frontend test exits 0
  - criterion: Repository-wide typecheck and lint pass.
    verification: pnpm typecheck exits 0; pnpm lint exits 0
depends_on: []
estimated_complexity: low
epic: cyboflow-shell-architecture
test_strategy:
  needed: false
  justification: "Pure deletion sweep. Files have no production importers (verified via grep across frontend/src/). The active code path goes through main/src/utils/toolFormatter.ts called from main/src/ipc/session.ts:809. No new behavior — typecheck-green + lint-green + the existing frontend suite passing (minus the 15 deleted cases) is the correctness contract."
prerequisites: []
---
# Delete dead frontend toolFormatter and orphaned formatJsonForWeb export

## Objective

`frontend/src/utils/toolFormatter.ts` (541 LOC) and its test file (189 LOC, 15 tests) have zero production importers in `frontend/src/`. The only importer is the test itself. The live runtime path goes through `main/src/utils/toolFormatter.ts` invoked from `main/src/ipc/session.ts:809`. TASK-655 hardened both copies in lockstep (commits `5a148da` + `a58fa0d`) — paying the dual-maintenance tax for code that isn't called.

`formatJsonForWeb` exported from `frontend/src/utils/formatters.ts:11` is similarly orphaned: no consumer remains after TASK-691 deleted the SessionView surface. Delete it alongside.

Resolves FIND-SPRINT-034-12.

## Implementation Steps

1. **Pre-flight verification grep.** Confirm zero importers:
   ```bash
   grep -rnE "from\s+['\"][^'\"]*utils/toolFormatter" frontend/src/
   grep -rnE "formatJsonForWeb" frontend/src/ main/src/
   ```
   The first command must return zero matches OUTSIDE the test file itself. The second should return matches only inside `frontend/src/utils/formatters.ts` (the export site) and `frontend/src/utils/toolFormatter.test.ts` (which will be deleted). If any external consumer is found, STOP and reconcile.

2. **Delete `frontend/src/utils/toolFormatter.ts`** with `git rm`.

3. **Delete `frontend/src/utils/toolFormatter.test.ts`** with `git rm`.

4. **Remove `formatJsonForWeb` export from `frontend/src/utils/formatters.ts`**. Also remove any helper imports that become orphaned by the deletion (e.g. `extractToolResultText` if it was only used by `formatJsonForWeb`). Keep the rest of the file intact (`formatDistanceToNow`, etc.).

5. **Run `pnpm typecheck`.** Must exit 0. If a missed importer surfaces, restore the file rather than papering over it — the grep at step 1 should have caught it.

6. **Run `pnpm lint`.** Must exit 0.

7. **Run `pnpm --filter frontend test`.** Must exit 0. Expected drop: from 336 → 321 frontend tests (the 15 toolFormatter.test.ts cases).

8. **Atomic commit:** `feat(TASK-734): delete dead frontend toolFormatter and orphaned formatJsonForWeb export`.

## Acceptance Criteria

See frontmatter.

## Test Strategy

No new tests. Deletion of dead code with no callers.

## Hardest Decision

**Whether to keep the deleted test file's 15 cases as documentation of the array-form ToolResult contract.** Rejected: the same contract is now exercised against the live `main/src/utils/toolFormatter.ts` via existing main-side tests, and the dead copy was being maintained in lockstep — keeping it stranded re-creates the same dual-maintenance tax. If a frontend-side helper is needed in the future, it should live in `shared/utils/` (already established by TASK-655's `extractToolResultText.ts`).

## Lowest Confidence Area

**Whether `formatJsonForWeb` has any dynamic-import or string-key consumer that grep misses.** Mitigation: `pnpm typecheck` is the strict completeness gate — it will surface any TS reference. If a future feature needs JSON pretty-printing for the renderer, it can re-add a thin wrapper around the main-side helper or live in `shared/utils/`.
