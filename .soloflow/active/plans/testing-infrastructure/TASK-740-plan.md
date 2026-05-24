---
id: TASK-740
idea: SPRINT-035-compound
status: ready
created: 2026-05-23T12:00:00Z
files_owned:
  - main/src/services/panels/claude/__tests__/claudeCodeManager.composeMcpServers.test.ts
  - main/src/orchestrator/trpc/routers/__tests__/runs.test.ts
files_readonly:
  - main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts
  - main/src/database/__test_fixtures__/registrySchema.ts
  - main/src/database/migrations/006_cyboflow_schema.sql
  - main/src/database/migrations/007_add_stuck_reason.sql
acceptance_criteria:
  - criterion: "Neither owned file declares a local `function createTestDb`."
    verification: "grep -n \"function createTestDb\" main/src/services/panels/claude/__tests__/claudeCodeManager.composeMcpServers.test.ts main/src/orchestrator/trpc/routers/__tests__/runs.test.ts returns 0 hits"
  - criterion: "Both owned files import `createTestDb` from the canonical fixture `main/src/orchestrator/__test_fixtures__/orchestratorTestDb`."
    verification: "grep -nE \"from .*orchestratorTestDb\" main/src/services/panels/claude/__tests__/claudeCodeManager.composeMcpServers.test.ts main/src/orchestrator/trpc/routers/__tests__/runs.test.ts shows a createTestDb import in BOTH files"
  - criterion: "`runs.test.ts` calls `createTestDb({ includeStuckDetectedAt: true })` (or `createTestDb({ includeStuckDetectedAt: true, disableForeignKeys: false })`) to preserve its prior schema (GATE_SCHEMA + migration 007 ALTER)."
    verification: "grep -n \"includeStuckDetectedAt: true\" main/src/orchestrator/trpc/routers/__tests__/runs.test.ts shows at least one call site"
  - criterion: "`claudeCodeManager.composeMcpServers.test.ts` no longer imports `readFileSync` or `join` solely for schema bootstrapping (the file's own `SCHEMA_PATH` constant + readFileSync schema-read is gone)."
    verification: "grep -n \"SCHEMA_PATH\" main/src/services/panels/claude/__tests__/claudeCodeManager.composeMcpServers.test.ts returns 0 hits AND grep -n \"006_cyboflow_schema.sql\" main/src/services/panels/claude/__tests__/claudeCodeManager.composeMcpServers.test.ts returns 0 hits"
  - criterion: "`pnpm --filter main test -- claudeCodeManager.composeMcpServers` exits 0; `pnpm --filter main test -- routers/__tests__/runs` exits 0."
    verification: "Both targeted test invocations exit with code 0"
  - criterion: "`pnpm --filter main test` exits 0 (full main suite green)."
    verification: "pnpm --filter main test exits with code 0"
depends_on: []
estimated_complexity: low
epic: testing-infrastructure
test_strategy:
  needed: false
  justification: "This task IS a test-file refactor — it canonicalizes the fixture import without altering test behavior. The existing test assertions in both files continue to validate the same behavior; this is a no-op-at-runtime cleanup whose success criterion is `pnpm --filter main test` exits 0. Sibling-test scan: the only sibling tests are the two files this task owns. No other test file is affected — the canonical `createTestDb` is already imported by 10 files swept in TASK-733 (verified by grep on `from .*orchestratorTestDb`)."
---

# Sweep two remaining local createTestDb declarations to canonical fixture

## Objective

TASK-733 (SPRINT-035) consolidated 10 test files onto the canonical `createTestDb` exported by `main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts`. Two more files were introduced mid-sprint by sibling tasks and still declare local `function createTestDb()`: `claudeCodeManager.composeMcpServers.test.ts:78` and `runs.test.ts:53`. Both local helpers reproduce subsets of the canonical surface — the first reads `006_cyboflow_schema.sql` from disk; the second applies `GATE_SCHEMA` + an inline migration-007 ALTER. Both are now replaceable by `createTestDb()` (no options) and `createTestDb({ includeStuckDetectedAt: true })` respectively, eliminating two drift sites.

## Implementation Steps

1. **Edit `main/src/orchestrator/trpc/routers/__tests__/runs.test.ts`:**
   - Remove the local `function createTestDb(): Database.Database { ... }` block (lines 53-60).
   - Remove the comment banner directly above it (lines 45-52: `// Test-database setup`).
   - Remove the now-unused imports: `Database from 'better-sqlite3'`, `GATE_SCHEMA from '../../../../database/__test_fixtures__/registrySchema'`. If `Database` is still referenced anywhere in the file as a type annotation, keep the type-only import (`import type Database from 'better-sqlite3'`) — verify via `grep -n "Database\\.Database\\b\\|Database\\b" main/src/orchestrator/trpc/routers/__tests__/runs.test.ts` (the `db: Database.Database` declarations in `beforeEach` need the type).
   - Update the existing import line `import { seedRun, seedApproval } from '../../../__test_fixtures__/orchestratorTestDb';` to also import `createTestDb`:
     ```ts
     import { createTestDb, seedRun, seedApproval } from '../../../__test_fixtures__/orchestratorTestDb';
     ```
   - Update every `db = createTestDb();` call site in this file (currently `beforeEach` blocks at lines 110-112 and 213-215) to `db = createTestDb({ includeStuckDetectedAt: true });`. This preserves the prior behavior (GATE_SCHEMA + migration 007 ALTER) — the canonical fixture's `includeStuckDetectedAt` option does the same `ALTER TABLE workflow_runs ADD COLUMN stuck_detected_at INTEGER` (`orchestratorTestDb.ts:57`).

2. **Edit `main/src/services/panels/claude/__tests__/claudeCodeManager.composeMcpServers.test.ts`:**
   - Remove the local `function createTestDb(): Database.Database { ... }` block (lines 78-83).
   - Remove `const SCHEMA_PATH = join(process.cwd(), 'src/database/migrations/006_cyboflow_schema.sql');` (line 76).
   - Remove the `// Database / ApprovalRouter helpers` comment banner directly above (lines 72-75) if it becomes a single dangling comment.
   - Remove unused imports: `readFileSync from 'fs'`, `join from 'path'`. Verify each via grep before removal — both are likely only used by the deleted lines.
   - Keep `Database from 'better-sqlite3'` — the file's type annotations (`db: Database.Database`) need it.
   - Add the canonical fixture import. The file currently imports from `'../../../../orchestrator/__test_fixtures__/dbAdapter'` (line 29); add a sibling import line:
     ```ts
     import { createTestDb } from '../../../../orchestrator/__test_fixtures__/orchestratorTestDb';
     ```
   - The single call site `db = createTestDb();` in `beforeEach` (line 154) does NOT need options — the canonical zero-arg call applies GATE_SCHEMA with FK ON, which matches the original behavior (`db.pragma('foreign_keys = ON'); db.exec(readFileSync(SCHEMA_PATH, 'utf8'));`).

3. **Verify no orphan-import remnants:**
   - `grep -n "readFileSync\\|SCHEMA_PATH\\|GATE_SCHEMA" main/src/services/panels/claude/__tests__/claudeCodeManager.composeMcpServers.test.ts` → must return 0 hits.
   - `grep -n "GATE_SCHEMA\\|registrySchema" main/src/orchestrator/trpc/routers/__tests__/runs.test.ts` → must return 0 hits.

4. **Run targeted tests:**
   - `pnpm --filter main test -- claudeCodeManager.composeMcpServers` — must exit 0.
   - `pnpm --filter main test -- routers/__tests__/runs` — must exit 0.

5. **Run the full suite to confirm no neighbor regressions:**
   - `pnpm --filter main test` — must exit 0.

## Acceptance Criteria

- 0 local `function createTestDb` in either owned file.
- Both files import `createTestDb` from `'…/orchestratorTestDb'`.
- `runs.test.ts` passes `{ includeStuckDetectedAt: true }` to preserve migration-007 column presence.
- Orphan imports (`readFileSync`, `join`, `GATE_SCHEMA`, `SCHEMA_PATH`) removed.
- `pnpm --filter main test` exits 0.

## Test Strategy

This is a pure refactor — no new tests are written and no test behavior changes. The full main test suite passing is the success signal. Sibling-test directory scan: `main/src/orchestrator/trpc/routers/__tests__/` has only `runs.test.ts` (owned); `main/src/services/panels/claude/__tests__/` has the composeMcpServers file (owned) plus other claudeCodeManager sibling tests that already use the canonical fixture or are unaffected.

## Hardest Decision

**Whether `runs.test.ts` needs `{ includeStuckDetectedAt: true }` or whether the test's runtime would tolerate the column being absent.** The file's `seedStuckRun` helper inserts into `workflow_runs (... stuck_detected_at)` (line 82). Without the column, `INSERT INTO workflow_runs (stuck_detected_at, ...)` would fail with `no such column`. So the option MUST be `true`. Verified by reading the file's INSERT statement on line 79-84.

## Rejected Alternatives

- **Skip `runs.test.ts` and only fix the composeMcpServers file.** Rejected — the proposal calls out both files explicitly, and the `runs.test.ts` declaration is the more visible inconsistency (it sits inside the orchestrator subtree where the canonical fixture lives).
- **Widen the canonical fixture to always include `stuck_detected_at`.** Rejected — the existing `includeStuckDetectedAt: false` default exists so the GATE_SCHEMA parity test in `orchestratorTestDb.test.ts` continues to compare against the canonical 006 migration file unchanged. Widening would break that parity. Would reconsider when migration 007 is itself folded into a successor canonical migration.
- **Delete `claudeCodeManager.composeMcpServers.test.ts`'s SCHEMA_PATH constant but keep its local helper.** Rejected — defeats the purpose. The canonical fixture is the whole point.

## Lowest Confidence Area

The `Database` import in `runs.test.ts` after removing the local `createTestDb`. If the file currently uses `Database from 'better-sqlite3'` only as a type (`db: Database.Database` annotation), it can become `import type Database from 'better-sqlite3'`. If it's used at runtime (e.g. `new Database(':memory:')` somewhere in a seed helper this task hasn't read), the runtime import stays. The executor should `grep -n "new Database\\|Database\\.prepare\\|Database\\.exec" main/src/orchestrator/trpc/routers/__tests__/runs.test.ts` and decide based on whether any runtime call remains.
