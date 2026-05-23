---
id: TASK-727
idea: SPRINT-031-compound
status: in-flight
source_sprint: SPRINT-031
source_finding: FIND-SPRINT-031-7
created: "2026-05-22T00:00:00Z"
files_owned:
  - main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts
  - main/src/orchestrator/__test_fixtures__/__tests__/orchestratorTestDb.test.ts
  - main/src/orchestrator/__tests__/runRecovery.test.ts
  - main/src/orchestrator/__tests__/approvalCreatedBridge.test.ts
  - main/src/orchestrator/__tests__/inspectorQueries.test.ts
  - main/src/orchestrator/__tests__/stuckDetector.test.ts
  - main/src/orchestrator/trpc/routers/__tests__/approvals.test.ts
  - main/src/trpc/__tests__/approvals.test.ts
  - docs/CODE-PATTERNS.md
files_readonly:
  - main/src/orchestrator/approvalRouter.ts
  - main/src/services/cyboflow/transitions.ts
  - main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts
  - main/src/orchestrator/__tests__/approvalRouter.test.ts
  - main/src/services/cyboflow/__tests__/transitions.test.ts
  - main/src/database/__tests__/cyboflowSchema.test.ts
  - main/src/database/__test_fixtures__/registrySchema.ts
  - main/src/database/migrations/006_cyboflow_schema.sql
  - .soloflow/active/plans/testing-infrastructure/EPIC-testing-infrastructure.md
acceptance_criteria:
  - criterion: Audit grep before changes — sweep step 1 — confirms the 6 fragmented seed-helper sites still exist (sanity gate so the executor knows the work is needed)
    verification: "grep -rnE 'seedPendingApproval\\b|seedApprovalRow\\b|seedPendingApprovals\\b' main/src --include='*.ts' returns at least 4 matches across the 6 listed test files BEFORE step 2 runs"
  - criterion: orchestratorTestDb.ts exports a seedApproval function with the SeedApprovalOverrides interface
    verification: "grep -nE 'export function seedApproval\\(' main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts returns 1 match AND grep -nE 'export interface SeedApprovalOverrides' main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts returns 1 match"
  - criterion: "seedApproval returns the inserted approval id (string), and the inserted row has the expected defaults: status='pending', tool_name='bash', tool_input_json='{}', tool_use_id={id}, created_at=ISO-now"
    verification: "grep -nE 'returns? the inserted approval id|seedApproval.+default' main/src/orchestrator/__test_fixtures__/__tests__/orchestratorTestDb.test.ts returns at least 1 match AND pnpm --filter main test orchestratorTestDb exits 0"
  - criterion: The 6 migrated test files no longer define local seed helpers that insert into approvals; each imports seedApproval from orchestratorTestDb
    verification: "grep -rnE 'function (seedPendingApproval|seedApprovalRow|seedPendingApprovals)\\(' main/src --include='*.ts' returns 0 matches AND grep -rnE 'import \\{[^}]*seedApproval[^}]*\\} from .+orchestratorTestDb' main/src/orchestrator/__tests__/runRecovery.test.ts main/src/orchestrator/__tests__/approvalCreatedBridge.test.ts main/src/orchestrator/__tests__/inspectorQueries.test.ts main/src/orchestrator/__tests__/stuckDetector.test.ts main/src/orchestrator/trpc/routers/__tests__/approvals.test.ts main/src/trpc/__tests__/approvals.test.ts returns 6 matches"
  - criterion: "No inline INSERT INTO approvals statements remain in the 6 migrated test files (the production sites in approvalRouter.ts and transitions.ts and the readonly sites in mcpQueryHandler.test.ts, approvalRouter.test.ts, transitions.test.ts, cyboflowSchema.test.ts are intentionally excluded)"
    verification: "grep -nE 'INSERT INTO approvals' main/src/orchestrator/__tests__/runRecovery.test.ts main/src/orchestrator/__tests__/approvalCreatedBridge.test.ts main/src/orchestrator/__tests__/inspectorQueries.test.ts main/src/orchestrator/__tests__/stuckDetector.test.ts main/src/orchestrator/trpc/routers/__tests__/approvals.test.ts main/src/trpc/__tests__/approvals.test.ts returns 0 matches"
  - criterion: "docs/CODE-PATTERNS.md 'Database seed helpers' section is updated to reference seedApproval alongside seedRun"
    verification: "grep -nE 'seedApproval\\b' docs/CODE-PATTERNS.md returns at least 1 match AND the match falls inside the 'Database seed helpers' subsection (line within ~30 lines after the heading)"
  - criterion: All 6 migrated test files still pass
    verification: pnpm --filter main test runRecovery approvalCreatedBridge inspectorQueries stuckDetector trpc/routers/__tests__/approvals trpc/__tests__/approvals exits 0
  - criterion: Main process typecheck passes
    verification: pnpm --filter main typecheck exits 0
  - criterion: Main process lint passes
    verification: pnpm --filter main lint exits 0
depends_on: []
estimated_complexity: medium
epic: testing-infrastructure
test_strategy:
  needed: true
  justification: "The new fixture function is itself a primitive that other tests depend on, so it needs direct row-shape coverage in its sibling test file. The 6 migrated test files have existing test_strategy coverage that will be exercised by re-running them — but the migration MUST not change their behavior."
  targets:
    - behavior: "seedApproval with no overrides inserts a single row with default status='pending', tool_name='bash', tool_input_json='{}', tool_use_id={id}, created_at within 1s of now"
      test_file: main/src/orchestrator/__test_fixtures__/__tests__/orchestratorTestDb.test.ts
      type: unit
    - behavior: "seedApproval with overrides.status='approved' honors the status override"
      test_file: main/src/orchestrator/__test_fixtures__/__tests__/orchestratorTestDb.test.ts
      type: unit
    - behavior: "seedApproval with overrides.id='custom-id' returns 'custom-id'"
      test_file: main/src/orchestrator/__test_fixtures__/__tests__/orchestratorTestDb.test.ts
      type: unit
    - behavior: seedApproval with overrides.toolName / overrides.toolInputJson / overrides.createdAt are stored verbatim in the row
      test_file: main/src/orchestrator/__test_fixtures__/__tests__/orchestratorTestDb.test.ts
      type: unit
    - behavior: "Migrated tests still pass — runRecovery, approvalCreatedBridge, inspectorQueries, stuckDetector, trpc routers approvals, trpc approvals"
      test_file: main/src/orchestrator/__tests__/runRecovery.test.ts
      type: integration
---
# Extract shared seedApproval fixture and consolidate 6 divergent approval seeding helpers

## Objective

The shared orchestrator test fixture `main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts` is the canonical seed host for `workflow_runs` (via `seedRun`) but stops there. Approval-row seeding is fragmented across at least 4 distinct helper signatures and 2+ inline `INSERT INTO approvals` literals across 6 test files. Each helper has subtly different defaults (some omit `created_at`, some hard-code `tool_name='bash'`, some hard-code `tool_name='Bash'`, some omit `status`). A `approvals` schema change today must touch 6+ test files and re-derive the right column shape in each — a recipe for silent drift FIND-SPRINT-031-7 already named.

This task adds a single `seedApproval(db, overrides?)` helper to the canonical fixture, migrates the 6 listed call sites, adds row-shape unit tests at the fixture level, and updates `docs/CODE-PATTERNS.md` "Database seed helpers". Production seed paths (`approvalRouter.ts`, `services/cyboflow/transitions.ts`) are intentionally NOT migrated — those produce live approvals via SDK / state-machine paths and have different invariants. Four out-of-scope test files (`mcpQueryHandler.test.ts`, `approvalRouter.test.ts`, `transitions.test.ts`, `cyboflowSchema.test.ts`) have specialised seeding (multiple statuses, decided_at variations, FK-constraint tests) deferred to a follow-on cleanup.

## Implementation Steps

1. **Audit grep — sweep step (rule 5d gate).** Run:
   ```bash
   grep -rnE 'seedPendingApproval\b|seedApprovalRow\b|seedPendingApprovals\b|seedApproval\b' main/src --include='*.ts'
   grep -rnE 'INSERT INTO approvals' main/src --include='*.ts'
   ```
   Expected matches across the 6 listed test files. The local `seedApproval(db, runId, toolName, toolInputJson)` already defined in `approvalCreatedBridge.test.ts` is one of the 6 sites being consolidated — its signature differs from the new canonical fixture.

2. **Extend `main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts`** with `SeedApprovalOverrides` interface and `seedApproval(db, overrides)` function. Required field: `runId`. Defaults: `id` generated, `toolName: 'bash'`, `toolInputJson: '{}'`, `toolUseId: {id}`, `status: 'pending'`, `createdAt: now`.

3. **Add fixture unit tests** in `__test_fixtures__/__tests__/orchestratorTestDb.test.ts` — append a new `describe('seedApproval', () => { ... })` block. Cover: default insert, status override, explicit id, field completeness (toolName, toolInputJson, createdAt verbatim).

4. **Migrate `runRecovery.test.ts`** — delete local `seedPendingApproval(db, approvalId, runId)`; replace `seedPendingApproval(db, approvalId, runId)` with `seedApproval(db, { id: approvalId, runId })`. Defaults match exactly.

5. **Migrate `approvalCreatedBridge.test.ts`** — delete local `seedApproval(db, runId, toolName, toolInputJson)`; update call site to `seedApproval(db, { id: \`approval-${runId}\`, runId, toolName: 'Bash', toolInputJson: toolInput })`.

6. **Migrate `inspectorQueries.test.ts`** — delete local `seedPendingApproval(db, runId, toolName, toolInputJson)`; preserve hard-coded `tool_use_id='use-1'` via explicit `toolUseId: 'use-1'`. The old helper's return value was assigned but not asserted; pass explicit id to keep behaviour stable.

7. **Migrate `stuckDetector.test.ts`** — delete local `seedApproval(db, approvalId, runId, ageMs)`. Inline the `ageMs → createdAt` math at each of the 8+ call sites (or use a small in-file `ageMsToIso` arrow). Do NOT re-introduce a wrapping helper that hides the canonical fixture call.

8. **Migrate `trpc/routers/__tests__/approvals.test.ts`** — delete local `seedApprovalRow(db, approvalId, runId, createdAt)`; preserve `tool_name='Bash'` and `tool_input_json='{"cmd":"echo hi"}'` defaults via explicit overrides. Replace the inline `INSERT INTO approvals` at the truncate-test site with a `seedApproval` call.

9. **Migrate `trpc/__tests__/approvals.test.ts`** — delete local `seedPendingApprovals(db, runId, count)` and `createTestDb` (the latter reads `006_cyboflow_schema.sql` from disk; the shared `createTestDb` uses GATE_SCHEMA which is column-parity-pinned). Replace each call with a `seedRun(db, { id: runId })` + loop of `seedApproval(db, { id: \`${runId}-approval-${i}\`, runId, toolName: 'Bash' })`.

10. **Update `docs/CODE-PATTERNS.md`** — replace the "Database seed helpers (pending — see compounded FIND-SPRINT-018-12)" block with a "Database seed helpers" section that describes `createTestDb` + `seedRun` + the new `seedApproval`. Drop the FIND-SPRINT-018-12 reference (TASK-727 closes it).

11. **Verify**:
   ```bash
   pnpm --filter main typecheck
   pnpm --filter main lint
   pnpm --filter main test orchestratorTestDb runRecovery approvalCreatedBridge inspectorQueries stuckDetector trpc/routers/__tests__/approvals trpc/__tests__/approvals
   ```

## Hardest Decision

**Default `tool_name` to `'bash'` (lowercase) or `'Bash'` (capital, SDK-canonical)?** Chosen: **lowercase 'bash'**. 4 of 6 migrated sites use lowercase; only `approvalCreatedBridge.test.ts` and `trpc/routers/__tests__/approvals.test.ts` use `'Bash'`. Picking the majority case minimises the diff. Tests that need SDK-canonical case pass `toolName: 'Bash'` explicitly, which is self-documenting at the call site.

## Rejected Alternatives

- **Migrate all 10+ `INSERT INTO approvals` sites including production `approvalRouter.ts` + `transitions.ts` + 4 readonly test files.** Production has semantics tests don't (decisionPromise, MCP reply, status-guard SQL); consolidating into a test fixture would be wrong. The 4 readonly test files have specialised shapes warranting a separate design pass.
- **Default `created_at` to a fixed ISO timestamp.** stuckDetector tests rely on `Date.now() - ageMs` math; a fixed default would force every caller to override.
- **Make `runId` optional and auto-seed a run if missing.** The fixture would silently insert phantom rows when callers forgot `seedRun`, masking bugs that should surface as FK violations.

## Lowest Confidence Area

`stuckDetector.test.ts` has the most call sites (8+) and subtle invariants — `ageMs` drives the 5-minute filter, classification, and idempotency / status-guard tests. The migration inlines that math at each call site, more verbose than the old helper. If readability suffers, a small in-file `ageMsToIso(ageMs): string` arrow is acceptable — but do NOT re-introduce a `seedApprovalAge` wrapper hiding the canonical fixture call.

A secondary risk: `trpc/__tests__/approvals.test.ts` uses its own `createTestDb` that reads `006_cyboflow_schema.sql` from disk. Swapping to the shared `createTestDb` (GATE_SCHEMA) relies on the GATE_SCHEMA parity pin being green. Verify before and after the migration. If a CHECK-constraint drift PRAGMA can't see slips through, revert just that file's createTestDb swap.
