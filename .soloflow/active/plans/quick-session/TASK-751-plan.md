---
id: TASK-751
idea: SPRINT-037-compound
status: ready
created: 2026-05-25T00:00:00Z
files_owned:
  - main/src/database/models.ts
  - main/src/services/sessionManager.ts
  - main/src/services/__tests__/sessionManagerRunIdMapping.test.ts
files_readonly:
  - main/src/database/migrations/009_sessions_run_id.sql
  - main/src/database/database.ts
  - main/src/types/session.ts
  - frontend/src/components/SessionListItem.tsx
  - frontend/src/components/__tests__/SessionListItem.test.tsx
  - main/src/services/__tests__/sessionManager.mainRepoPermission.test.ts
  - .soloflow/active/findings/SPRINT-037-findings.md
acceptance_criteria:
  - criterion: "DbSession (the Session interface exported from main/src/database/models.ts) declares an optional `run_id?: string | null` field"
    verification: "grep -n 'run_id' main/src/database/models.ts shows the new field inside the Session interface block (lines 40-70)"
  - criterion: "convertDbSessionToSession in main/src/services/sessionManager.ts maps DbSession.run_id onto the returned Session.runId field, coalescing undefined to null"
    verification: "grep -n 'runId:' main/src/services/sessionManager.ts shows `runId: dbSession.run_id ?? null` inside the returned object literal of convertDbSessionToSession (around lines 191-221)"
  - criterion: "Regression test asserts: a DbSession with run_id='flow-001' round-trips to Session.runId='flow-001'; a DbSession with run_id=null round-trips to Session.runId=null; a DbSession with run_id undefined round-trips to Session.runId=null"
    verification: "pnpm --filter main test -- sessionManagerRunIdMapping passes; the test file at main/src/services/__tests__/sessionManagerRunIdMapping.test.ts exists and contains all three cases"
  - criterion: "pnpm typecheck succeeds with the new field"
    verification: "pnpm typecheck exits 0"
  - criterion: "Existing main test suite still passes (no regression in sessionManager.mainRepoPermission.test.ts)"
    verification: "pnpm --filter main test exits 0"
depends_on: []
estimated_complexity: low
epic: quick-session
test_strategy:
  needed: true
  justification: "FIND-SPRINT-037-1 documents a silent inversion of the Quick badge in production (SessionListItem.tsx:431 reads session.runId, which was always undefined → badge fired for every session). The bug shipped because TASK-749 had no test exercising the mapper. A round-trip mapper test is the cheapest, most direct regression guard."
  targets:
    - behavior: "convertDbSessionToSession copies run_id='flow-001' to runId='flow-001' (flow-owned session)"
      test_file: "main/src/services/__tests__/sessionManagerRunIdMapping.test.ts"
      type: unit
    - behavior: "convertDbSessionToSession copies run_id=null to runId=null (quick session — expected Quick badge)"
      test_file: "main/src/services/__tests__/sessionManagerRunIdMapping.test.ts"
      type: unit
    - behavior: "convertDbSessionToSession copies run_id=undefined (missing column on legacy row) to runId=null (defensive null-coalescing)"
      test_file: "main/src/services/__tests__/sessionManagerRunIdMapping.test.ts"
      type: unit
---

# Wire run_id through DbSession → Session mapper so Quick badge is accurate

## Objective

`SessionListItem.tsx:431` decides whether to render the "Quick" badge by checking `session.runId == null`. Because `convertDbSessionToSession` (`main/src/services/sessionManager.ts:185-221`) never copies the DB row's `run_id` column onto the returned `Session` object, `runId` is always `undefined` and the badge silently fires on every session in the sidebar — including flow-owned ones. This task wires the field through the mapper and adds a round-trip regression test so the bug class cannot recur.

## Implementation Steps

1. Add `run_id?: string | null` to the DB-row `Session` interface in `main/src/database/models.ts` (the interface aliased as `DbSession` in sessionManager.ts:7). Place at the end of the optional-field block before the closing brace.

2. In `convertDbSessionToSession` (`main/src/services/sessionManager.ts`), add `runId: dbSession.run_id ?? null,` to the returned object literal — near the other null-coalesced fields. Use `?? null` (not `||`) to match the `Session.runId?: string | null` shape.

3. Create `main/src/services/__tests__/sessionManagerRunIdMapping.test.ts` mirroring the module-mocking pattern of the existing `sessionManager.mainRepoPermission.test.ts`. Three test cases:
   - `dbSession.run_id = 'flow-001'` → `session.runId === 'flow-001'`
   - `dbSession.run_id = null` → `session.runId === null`
   - `dbSession.run_id` omitted (legacy row) → `session.runId === null`

4. Run `pnpm typecheck && pnpm --filter main test` to confirm new field compiles and all main tests pass.

## Acceptance Criteria
See frontmatter.

## Hardest Decision
A dedicated mapper test file vs. extending the existing permission-mode test file. Chose dedicated — surfaces the regression class clearly and matches the existing one-file-per-facet convention.

## Rejected Alternatives
- **Snapshot/integration test through real SQLite.** Rejected — bug is purely JS mapper; migration 009 already covered by `sessionsRunIdMigration.test.ts`.
- **Frontend-only fix (tighten `==` to `===`).** Rejected — data is missing, not predicate.

## Lowest Confidence Area
Exact line number where `run_id` is inserted in the interface; AC grep asserts presence, not position.
