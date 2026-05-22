---
id: TASK-728
idea: SPRINT-031-compound
status: ready
source_sprint: SPRINT-031
source_finding: FIND-SPRINT-031-8
created: 2026-05-22T00:00:00Z
files_owned:
  - main/src/orchestrator/approvalListing.ts
  - main/src/orchestrator/__tests__/approvalListing.test.ts
  - main/src/orchestrator/trpc/routers/approvals.ts
  - main/src/orchestrator/__tests__/approvalCreatedBridge.test.ts
files_readonly:
  - shared/types/approvals.ts
  - shared/utils/approvals.ts
  - main/src/orchestrator/types.ts
  - main/src/orchestrator/approvalCreatedBridge.ts
  - main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts
  - .soloflow/active/plans/approval-router-and-permission-fix/EPIC-approval-router-and-permission-fix.md
acceptance_criteria:
  - criterion: "New module main/src/orchestrator/approvalListing.ts exists and exports selectPendingApprovals"
    verification: "test -f main/src/orchestrator/approvalListing.ts AND grep -nE 'export function selectPendingApprovals\\(' main/src/orchestrator/approvalListing.ts returns 1 match"
  - criterion: "selectPendingApprovals signature is (db: DatabaseLike) => Approval[] — typed import from shared/types/approvals.ts, not a local re-declaration"
    verification: "grep -nE 'import type \\{[^}]*Approval[^}]*\\} from .+shared/types/approvals' main/src/orchestrator/approvalListing.ts returns 1 match AND grep -nE 'import type \\{[^}]*DatabaseLike[^}]*\\} from .+types' main/src/orchestrator/approvalListing.ts returns 1 match"
  - criterion: "The new module is a standalone-typecheck-safe leaf: no imports from electron, better-sqlite3, or main/src/services/*"
    verification: "grep -nE \"from 'electron'|from 'better-sqlite3'|from '.+main/src/services/\" main/src/orchestrator/approvalListing.ts returns 0 matches"
  - criterion: "selectPendingApprovals uses truncatePayloadPreview from shared/utils/approvals.ts (not a re-implemented 512-char slice)"
    verification: "grep -nE 'truncatePayloadPreview' main/src/orchestrator/approvalListing.ts returns at least 1 match AND grep -nE 'slice\\(0,\\s*512\\)' main/src/orchestrator/approvalListing.ts returns 0 matches"
  - criterion: "The tRPC listPending procedure in main/src/orchestrator/trpc/routers/approvals.ts calls selectPendingApprovals(ctx.db) instead of inlining the SELECT JOIN"
    verification: "grep -nE 'selectPendingApprovals\\(' main/src/orchestrator/trpc/routers/approvals.ts returns at least 1 match AND grep -cE 'SELECT\\s+a\\.id\\s+AS id' main/src/orchestrator/trpc/routers/approvals.ts returns 0 (the SELECT-AS-id literal must no longer appear here)"
  - criterion: "The DbApprovalRow internal type in main/src/orchestrator/trpc/routers/approvals.ts is removed (migrated into approvalListing.ts as a non-exported helper, or deleted entirely if inlined)"
    verification: "grep -nE 'interface DbApprovalRow' main/src/orchestrator/trpc/routers/approvals.ts returns 0 matches"
  - criterion: "approvalCreatedBridge.test.ts imports selectPendingApprovals and uses it as the parity proxy — the 40-line local listPending function is deleted"
    verification: "grep -nE 'import \\{[^}]*selectPendingApprovals[^}]*\\} from .+approvalListing' main/src/orchestrator/__tests__/approvalCreatedBridge.test.ts returns 1 match AND grep -nE 'function listPending\\(' main/src/orchestrator/__tests__/approvalCreatedBridge.test.ts returns 0 matches"
  - criterion: "The round-trip-parity test in approvalCreatedBridge.test.ts still passes — bridge.workflowName === selectPendingApprovals(db)[0].workflowName"
    verification: "pnpm --filter main test approvalCreatedBridge exits 0 AND grep -nE 'bridgeEvent\\.approval\\.workflowName.+pending\\[0\\]\\.workflowName' main/src/orchestrator/__tests__/approvalCreatedBridge.test.ts returns 1 match"
  - criterion: "The orchestrator tRPC approvals test file still passes — including the oldest-first ordering test and the 512-char truncation test"
    verification: "pnpm --filter main test 'trpc/routers/__tests__/approvals' exits 0"
  - criterion: "A new unit test for selectPendingApprovals covers: empty table, ordering by created_at ASC, payloadPreview truncation, workflowName resolution via JOIN, exclusion of non-pending statuses"
    verification: "test -f main/src/orchestrator/__tests__/approvalListing.test.ts AND grep -cE 'describe\\(.selectPendingApprovals' main/src/orchestrator/__tests__/approvalListing.test.ts returns at least 1 AND pnpm --filter main test approvalListing exits 0"
  - criterion: "Main process typecheck passes"
    verification: "pnpm --filter main typecheck exits 0"
  - criterion: "Main process lint passes"
    verification: "pnpm --filter main lint exits 0"
depends_on: [TASK-727]
estimated_complexity: medium
epic: approval-router-and-permission-fix
test_strategy:
  needed: true
  justification: "Extracting production SQL into a new module creates a new public seam needing direct row-shape and ordering coverage. The existing approvalCreatedBridge.test.ts parity test continues to enforce the round-trip guarantee; the new approvalListing.test.ts proves the function behaves correctly in isolation, which the parity test cannot (parity passing while both sides are broken in the same way is the failure mode the bridge test cannot catch)."
  targets:
    - behavior: "selectPendingApprovals returns [] when the approvals table is empty"
      test_file: main/src/orchestrator/__tests__/approvalListing.test.ts
      type: unit
    - behavior: "selectPendingApprovals returns rows ordered by created_at ASC (oldest first)"
      test_file: main/src/orchestrator/__tests__/approvalListing.test.ts
      type: unit
    - behavior: "selectPendingApprovals truncates payloadPreview to 512 chars via truncatePayloadPreview"
      test_file: main/src/orchestrator/__tests__/approvalListing.test.ts
      type: unit
    - behavior: "selectPendingApprovals resolves workflowName via JOIN to workflows.name"
      test_file: main/src/orchestrator/__tests__/approvalListing.test.ts
      type: unit
    - behavior: "selectPendingApprovals excludes non-pending approvals (status='approved', 'rejected', 'expired', 'timed_out')"
      test_file: main/src/orchestrator/__tests__/approvalListing.test.ts
      type: unit
    - behavior: "Round-trip parity continues to hold: bridge.workflowName === selectPendingApprovals(db)[0].workflowName for the same seeded approval"
      test_file: main/src/orchestrator/__tests__/approvalCreatedBridge.test.ts
      type: integration
    - behavior: "tRPC listPending procedure end-to-end shape continues to match the migrated implementation"
      test_file: main/src/orchestrator/trpc/routers/__tests__/approvals.test.ts
      type: integration
---

# Extract selectPendingApprovals helper so the tRPC router and bridge parity test share the same SQL

## Objective

`main/src/orchestrator/trpc/routers/approvals.ts` declares `listPending`, a SELECT JOIN over `approvals + workflow_runs + workflows`, projected into the shared `Approval` type with `truncatePayloadPreview` applied to the JSON blob. `main/src/orchestrator/__tests__/approvalCreatedBridge.test.ts` contains a verbatim 40-line clone of that SQL+projection named `listPending(db)` that exists solely to serve the round-trip-parity test (case 3): assert that `buildApprovalCreatedEvent(...)` returns the same `workflowName` for an approval that `listPending` would return.

The parity guarantee is real and load-bearing — without it, a renderer consuming both the SSE-pushed `ApprovalCreatedEvent` and the REST-queried `listPending` result could see a `workflowName` mismatch for the same approval id. But the parity test currently asserts that the bridge agrees with a *clone* of production SQL, not with production SQL itself. A SPRINT touching `trpc/routers/approvals.ts` (e.g. new selected column, changed ORDER BY) keeps the test green against its stale clone while production silently diverges. The clone defeats its own purpose.

This task extracts the SELECT JOIN + projection into `selectPendingApprovals(db: DatabaseLike): Approval[]` in a new leaf module `main/src/orchestrator/approvalListing.ts`. The tRPC procedure becomes a thin wrapper; the bridge parity test imports that same function and deletes its local clone. The parity guarantee becomes mechanical — same call, same SQL — and any future SQL change touches one place both consumers see.

## Implementation Steps

1. **Create `main/src/orchestrator/approvalListing.ts`** — new leaf module exporting `selectPendingApprovals(db: DatabaseLike): Approval[]`. Migrate the SELECT JOIN + projection verbatim from `trpc/routers/approvals.ts`. Import `Approval` from `../../../shared/types/approvals`, `truncatePayloadPreview` from `../../../shared/utils/approvals`, and `DatabaseLike` from `./types`. Do NOT import from `electron`, `better-sqlite3`, or `main/src/services/*` (standalone-typecheck invariant). Keep the row shape `DbApprovalRow` as a non-exported internal helper.

2. **Refactor `trpc/routers/approvals.ts`** — add `import { selectPendingApprovals } from '../../approvalListing';`. Delete the internal `interface DbApprovalRow`. Delete the now-unused `truncatePayloadPreview` import. Replace the `listPending` procedure body with a thin wrapper calling `selectPendingApprovals(ctx.db)`. The `if (!ctx.db) throw new TRPCError(...)` precondition stays.

3. **Refactor `approvalCreatedBridge.test.ts`** — add `import { selectPendingApprovals } from '../approvalListing';`. Delete the local 40-line `function listPending(db)`. Delete the `truncatePayloadPreview` import (used only by the clone). Update the parity-test call from `listPending(db)` to `selectPendingApprovals(adapter)` where `adapter = dbAdapter(db)` is already constructed in the test. The assertions `expect(pending).toHaveLength(1)` and `expect(bridgeEvent.approval.workflowName).toBe(pending[0].workflowName)` stay.

4. **Create `main/src/orchestrator/__tests__/approvalListing.test.ts`** — new file. Five unit tests using the shared `createTestDb` + `seedRun` + `seedApproval` from `orchestratorTestDb.ts` (the `seedApproval` lands in TASK-727; this task depends on TASK-727):
   - returns `[]` on empty table
   - orders by `created_at ASC`
   - truncates `payloadPreview` to 512 chars
   - resolves `workflowName` via JOIN to `workflows.name`
   - excludes non-pending statuses (`approved`, `rejected`, `expired`, `timed_out`)

5. **Verify**:
   ```bash
   pnpm --filter main typecheck
   pnpm --filter main lint
   pnpm --filter main test approvalListing approvalCreatedBridge trpc/routers/__tests__/approvals
   ```
   The parity test (round-trip case) is the load-bearing check.

## Hardest Decision

**Accept the narrow `DatabaseLike` from `./types` or a wider better-sqlite3 `Database` directly?** Chosen: **`DatabaseLike`**. Keeps the function callable from any test that constructs `dbAdapter(rawDb)`, preserves the orchestrator's standalone-typecheck invariant (no `better-sqlite3` import), and matches how `ctx.db` is typed in the tRPC procedure.

The alternative (raw `Database`) would force the bridge parity test to call `selectPendingApprovals(db)` instead of `selectPendingApprovals(adapter)`, breaking symmetry with how `dbAdapter` is used elsewhere in that file and reintroducing a `better-sqlite3` type import into a leaf module with no operational need.

## Rejected Alternatives

- **Put `selectPendingApprovals` inside `trpc/routers/approvals.ts` and export it from there.** The test would import from a tRPC router module that transitively imports `TRPCError` and `zod` — a test-time dependency on tRPC for a function that doesn't need it. A standalone leaf keeps the seam narrow.
- **Define `selectPendingApprovals` inside `approvalCreatedBridge.ts`.** That file is about SSE event construction for ONE approval; co-locating list-many logic would conflate two responsibilities.
- **Keep the clone but add a CI-level grep that the two SQL blocks are byte-identical.** Brittle to whitespace and comments; only catches SQL string drift, not projection-shape drift (e.g. production drops a mapped column while the clone keeps it).

## Lowest Confidence Area

`Approval['status']` is a string-union narrowing of the DB column's TEXT value. The implementation casts `row.status as Approval['status']` — type assertion, not runtime validation. A future migration adding a new status (e.g. `'auto_denied'`) returning rows with that value would silently mis-type them. This is a pre-existing risk TASK-728 PRESERVES, not introduces. The "excludes non-pending approvals" test case encodes the current pending-only contract; if the union expands, that test updates in lockstep.

Secondary: the parity test currently passes `dbAdapter(db)` to `buildApprovalCreatedEvent` and raw `db` to the local `listPending`. After the refactor both use `dbAdapter(db)`. If `dbAdapter.prepare(sql).all()` differs subtly from `db.prepare(sql).all()` in any edge case (it shouldn't — thin pass-through), the parity test could regress. The `approvalCreatedBridge` test run in step 5 catches that explicitly.
