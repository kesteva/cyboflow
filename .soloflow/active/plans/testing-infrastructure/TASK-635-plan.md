---
id: TASK-635
idea: SPRINT-015-compound
status: in-flight
created: "2026-05-18T00:00:00Z"
files_owned:
  - main/src/services/cyboflow/__tests__/transitions.test.ts
  - main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts
  - main/src/database/__test_fixtures__/registrySchema.ts
files_readonly:
  - main/src/database/migrations/006_cyboflow_schema.sql
  - main/src/database/schema.sql
  - main/src/orchestrator/__tests__/workflowRegistry.test.ts
acceptance_criteria:
  - criterion: No inline CREATE TABLE workflow_runs DDL remains in transitions.test.ts or mcpQueryHandler.test.ts
    verification: "grep -n 'CREATE TABLE.*workflow_runs\\|CREATE TABLE.*approvals\\|CREATE TABLE.*raw_events' main/src/services/cyboflow/__tests__/transitions.test.ts main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts returns 0 matches"
  - criterion: Both files import GATE_SCHEMA or REGISTRY_SCHEMA from the canonical fixture
    verification: "grep -l \"from '.*__test_fixtures__/registrySchema'\" main/src/services/cyboflow/__tests__/transitions.test.ts main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts | wc -l returns 2"
  - criterion: main workspace tests exit 0
    verification: pnpm --filter main test exits 0
depends_on: []
estimated_complexity: low
epic: testing-infrastructure
test_strategy:
  needed: false
  justification: "Schema-DDL refactor — replaces inline CREATE TABLE blocks with an import of GATE_SCHEMA (or REGISTRY_SCHEMA) from the canonical fixture. The two test suites' existing assertions remain the regression guard; if a column or constraint diverges, those tests fail at runtime. Sibling-test scan: no other test files exist alongside transitions.test.ts or mcpQueryHandler.test.ts that this refactor could affect. The GATE_SCHEMA / REGISTRY_SCHEMA fixtures themselves are exercised by every test that imports them — no separate fixture test needed."
---
# Migrate 2 remaining inline DDL sites to GATE_SCHEMA

## Objective

`main/src/services/cyboflow/__tests__/transitions.test.ts:27` defines `SCHEMA_DDL` (5 inlined CREATE TABLE statements covering workflows, workflow_runs, raw_events, messages, approvals). `main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts:32` defines `MINIMAL_SCHEMA` (4 inlined CREATE TABLE statements covering workflows, workflow_runs, approvals, raw_events). Both diverge from the canonical `REGISTRY_SCHEMA` / `GATE_SCHEMA` exported from `main/src/database/__test_fixtures__/registrySchema.ts`. Replace each inline DDL with the appropriate import so future schema changes propagate from one source. The `messages` table that `transitions.test.ts` declares is not used by any of its tests (verified by grep) but is included by `GATE_SCHEMA`'s superset (NO — see decision below). The `MINIMAL_SCHEMA` in mcpQueryHandler is a documented subset; `GATE_SCHEMA` is a strict superset of it, so the import is safe.

## Plan Decisions

- **Use `GATE_SCHEMA` for both files.** Reasoning: (a) transitions.test.ts already declares all 5 tables (workflows + workflow_runs + raw_events + messages + approvals); GATE_SCHEMA covers workflows + workflow_runs + approvals + raw_events. The `messages` table is not referenced by any `transitions.test.ts` assertion or seed (grep confirmed: 0 matches for `messages` in that file outside the inline DDL). Removing it from the test's schema set is safe. (b) mcpQueryHandler.test.ts uses workflows + workflow_runs + approvals + raw_events — exactly GATE_SCHEMA's coverage. No subset export needed.
- **Do NOT add `MINIMAL_SCHEMA` as a separate export.** The compounder asked us to "decide whether MINIMAL_SCHEMA needs a documented subset export." Decision: NO. GATE_SCHEMA is a strict superset; the runtime cost of creating 4 unused indexes is negligible, and a separate export creates a second drift surface (the exact concern this task addresses).
- **`transitions.test.ts` uses `db.pragma('foreign_keys = ON')` implicitly (via beforeEach) — confirm GATE_SCHEMA's FK to `workflow_runs` from `approvals` does not break existing seed paths.** Verified by inspection: transitions.test.ts seeds `workflows` first, then `workflow_runs`, then `approvals` — FK order is satisfied.

## Implementation Steps

1. **Pre-flight grep — confirm inline DDL in both files and existing canonical fixture exports:**
   ```
   grep -n 'CREATE TABLE\|SCHEMA_DDL\|MINIMAL_SCHEMA' main/src/services/cyboflow/__tests__/transitions.test.ts main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts
   grep -n 'export const' main/src/database/__test_fixtures__/registrySchema.ts
   ```
   Expected: ~10 inline CREATE TABLE statements split across the two test files; `REGISTRY_SCHEMA` + `GATE_SCHEMA` exports in the fixture.

2. **Verify the `messages` table is unused in `transitions.test.ts`:**
   ```
   grep -n 'messages' main/src/services/cyboflow/__tests__/transitions.test.ts
   ```
   Expected: 1 match (only the CREATE TABLE line being removed). If more matches, escalate — `messages` would need to stay or be added to GATE_SCHEMA.

3. **Edit `main/src/services/cyboflow/__tests__/transitions.test.ts`.**
   - Add import near the top: `import { GATE_SCHEMA } from '../../../database/__test_fixtures__/registrySchema';`
   - Delete the entire `const SCHEMA_DDL = \`...\`;` block (lines 27–93). The lines 95+ (`// Seed helpers` comment and below) stay.
   - Replace the `db.exec(SCHEMA_DDL);` call in `beforeEach` (line 133) with `db.exec(GATE_SCHEMA);`.
   - Verify no other reference to `SCHEMA_DDL` remains: `grep -n 'SCHEMA_DDL' main/src/services/cyboflow/__tests__/transitions.test.ts` returns 0.

4. **Edit `main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts`.**
   - Add import: `import { GATE_SCHEMA } from '../../../database/__test_fixtures__/registrySchema';`
   - Delete the `const MINIMAL_SCHEMA = \`...\`;` block (lines 32–77).
   - Replace the `db.exec(MINIMAL_SCHEMA);` call inside `createTestDb` (line 86) with `db.exec(GATE_SCHEMA);`.
   - The handler test uses `db.pragma('foreign_keys = OFF')` because the minimal schema omitted FKs. With GATE_SCHEMA the FK from approvals→workflow_runs is now active. Audit whether existing seed helpers in the file seed `workflow_runs` before `approvals`. If they don't (or seed approvals without a workflow_run row), change `foreign_keys = OFF` to remain OFF — preserving the existing test contract — OR seed properly. Pre-read approach: keep `foreign_keys = OFF` to minimize behavior change; the FK is informational only and turning it off matches the existing test's intent.

5. **Run the AC completeness gate:**
   ```
   grep -n 'CREATE TABLE' main/src/services/cyboflow/__tests__/transitions.test.ts main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts
   ```
   Expected: 0 matches.

6. **Run `pnpm --filter main test`** — expect exit 0.

7. **Run `pnpm --filter main typecheck`** — expect exit 0.

## Acceptance Criteria

- Both files use `db.exec(GATE_SCHEMA)` instead of inline DDL.
- Zero `CREATE TABLE` statements remain in either file.
- All tests in both files continue to pass.

## Hardest Decision

Whether to add a separate `MINIMAL_SCHEMA` export for the mcpQueryHandler use case. Decided against — `GATE_SCHEMA` is a strict superset and the extra index/constraint creation cost is negligible compared to the value of a single source-of-truth. Adding `MINIMAL_SCHEMA` would re-introduce exactly the drift-surface problem this task is closing.

The secondary hard call: whether to honor `foreign_keys = OFF` in mcpQueryHandler.test.ts post-migration. Decided yes — the existing test was written assuming no FK enforcement, and forcing FKs ON could cause "FOREIGN KEY constraint failed" errors in seed helpers that assume the minimal-schema semantics. Preserving the pragma minimizes blast radius.

## Rejected Alternatives

- **Export a documented `MINIMAL_SCHEMA` from the fixture.** Rejected — creates a second drift surface (the original problem). Would change my mind only if `GATE_SCHEMA`'s extra tables caused measurable test slowdown (they don't — these are :memory: DBs initialized in microseconds).
- **Have `registrySchema.ts` read `schema.sql` and migration 006 at module load.** Rejected for this task — that's exactly what B9 (TASK-639) proposes as a CI-level check. Doing it here would conflate two concerns; let TASK-639 own the runtime-coupling question.

## Lowest Confidence Area

Whether `transitions.test.ts` has any indirect use of the `messages` table I missed in grep (e.g. via a seed helper imported from elsewhere). Step 2's grep is the gate; if it returns >1 match, the executor must re-evaluate before deleting the table from the schema set.
