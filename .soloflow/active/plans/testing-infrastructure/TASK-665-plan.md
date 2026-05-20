---
id: TASK-665
idea: IDEA-SPRINT-022-compound
status: in-flight
created: "2026-05-19T00:00:00Z"
files_owned:
  - main/src/orchestrator/__tests__/__fixtures__/rawEvents.ts
  - main/src/orchestrator/__tests__/runEventBridge.test.ts
  - main/src/orchestrator/__tests__/runExecutor.test.ts
files_readonly:
  - main/src/database/migrations/006_cyboflow_schema.sql
  - main/src/orchestrator/runEventBridge.ts
  - main/src/orchestrator/runExecutor.ts
acceptance_criteria:
  - criterion: "The fixture file main/src/orchestrator/__tests__/__fixtures__/rawEvents.ts exists and exports three named symbols: RAW_EVENTS_DDL (string), makeRawEventsDb (function), countRows (function)."
    verification: "grep -E 'export (const RAW_EVENTS_DDL|function makeRawEventsDb|function countRows)' main/src/orchestrator/__tests__/__fixtures__/rawEvents.ts returns three matches."
  - criterion: "RAW_EVENTS_DDL is the byte-for-byte canonical CREATE TABLE statement (columns: id, run_id, event_type, payload_json, created_at — no event_subtype) matching the raw_events DDL in 006_cyboflow_schema.sql lines 37-44 (sans foreign key, since the fixture intentionally disables FK enforcement)."
    verification: "Inspect the exported RAW_EVENTS_DDL constant; column list matches 006_cyboflow_schema.sql:38-42. The fixture omits the FOREIGN KEY clause because the helper sets pragma('foreign_keys = OFF') so tests do not need a workflow_runs row."
  - criterion: Neither test file declares a local RAW_EVENTS_DDL or RAW_EVENTS_DDL_EXEC constant after the migration.
    verification: "grep -n 'const RAW_EVENTS_DDL' main/src/orchestrator/__tests__/runEventBridge.test.ts main/src/orchestrator/__tests__/runExecutor.test.ts returns 0 matches."
  - criterion: "Neither test file declares a local makeDb() helper or inlines a SELECT COUNT(*) AS (n|cnt) FROM raw_events query."
    verification: "grep -nE 'function makeDb|SELECT COUNT\\(\\*\\) AS (n|cnt) FROM raw_events' main/src/orchestrator/__tests__/runEventBridge.test.ts main/src/orchestrator/__tests__/runExecutor.test.ts returns 0 matches."
  - criterion: Both test files import the shared fixture symbols they use.
    verification: "grep -n \"from '\\./__fixtures__/rawEvents'\" main/src/orchestrator/__tests__/runEventBridge.test.ts main/src/orchestrator/__tests__/runExecutor.test.ts returns at least 1 import line per file (only files that actually use the helpers need to import)."
  - criterion: All orchestrator unit tests still pass after the refactor.
    verification: Run `pnpm --filter main test -- --run main/src/orchestrator/__tests__/runEventBridge.test.ts main/src/orchestrator/__tests__/runExecutor.test.ts` and confirm exit 0 with no skipped tests in those two files.
depends_on: []
estimated_complexity: low
epic: testing-infrastructure
test_strategy:
  needed: false
  justification: "This is a pure test-helper refactor (deduplicate fixture across two test files); no production code changes. Correctness is verified by re-running the two existing test files (runEventBridge.test.ts has 22 cases; runExecutor.test.ts has the source-arg integration test + panelId-alignment test). Both already cover the DDL- and countRows-touching paths exhaustively. Adding tests for a fixture would test the test infrastructure itself, which has no contractual surface."
---
# Extract shared raw_events test fixture from orchestrator test files

## Objective

Create a single canonical `__fixtures__/rawEvents.ts` module under `main/src/orchestrator/__tests__/` that owns the `raw_events` schema DDL, the `:memory:` database factory, and the `countRows` helper. Replace the two divergent in-line copies (`RAW_EVENTS_DDL` in `runEventBridge.test.ts:32` and `RAW_EVENTS_DDL_EXEC` in `runExecutor.test.ts:691`) plus the three inlined `SELECT COUNT(*)` queries with imports from the fixture. After this task, a maintainer changing the `raw_events` schema in migration 006 has exactly one test fixture to update.

## Implementation Steps

1. **Create the `__fixtures__` directory and fixture module.** The directory does not yet exist. Create the new file `main/src/orchestrator/__tests__/__fixtures__/rawEvents.ts` with the following structure:

   ```ts
   /**
    * Shared raw_events test fixture for the orchestrator test suite.
    *
    * Owns the canonical `raw_events` DDL, the in-memory database factory, and the
    * row-count helper. Imported by runEventBridge.test.ts and runExecutor.test.ts
    * so that schema drift in 006_cyboflow_schema.sql only needs to be reflected
    * once.
    *
    * Schema source of truth: main/src/database/migrations/006_cyboflow_schema.sql
    * (lines 37-44). The fixture intentionally omits the FOREIGN KEY clause because
    * makeRawEventsDb() disables FK enforcement — tests insert raw_events rows
    * without seeding workflow_runs.
    */
   import Database from 'better-sqlite3';

   export const RAW_EVENTS_DDL = `
     CREATE TABLE IF NOT EXISTS raw_events (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       run_id TEXT NOT NULL,
       event_type TEXT NOT NULL,
       payload_json TEXT NOT NULL,
       created_at DATETIME DEFAULT CURRENT_TIMESTAMP
     )
   `;

   /**
    * Allocate an in-memory better-sqlite3 database seeded with the canonical
    * raw_events schema. Foreign-key enforcement is disabled so tests can insert
    * raw_events rows without also seeding workflow_runs.
    */
   export function makeRawEventsDb(): Database.Database {
     const db = new Database(':memory:');
     db.pragma('foreign_keys = OFF');
     db.exec(RAW_EVENTS_DDL);
     return db;
   }

   /**
    * Count raw_events rows for a given run_id. Replaces the inline
    * SELECT COUNT(*) idiom previously duplicated across test files.
    */
   export function countRows(db: Database.Database, runId: string): number {
     const row = db
       .prepare('SELECT COUNT(*) AS n FROM raw_events WHERE run_id = ?')
       .get(runId) as { n: number };
     return row.n;
   }
   ```

2. **Update `runEventBridge.test.ts`.** Open `main/src/orchestrator/__tests__/runEventBridge.test.ts` and:
   - Remove the local `RAW_EVENTS_DDL` constant declaration at lines 32-40.
   - Remove the local `makeDb()` function at lines 100-106.
   - Remove the local `countRows()` function at lines 108-113.
   - Add an import near the top of the file (after the existing imports at lines 19-25):
     ```ts
     import { makeRawEventsDb, countRows } from './__fixtures__/rawEvents';
     ```
   - In the `beforeEach` block at line 158, replace `db = makeDb();` with `db = makeRawEventsDb();`.
   - Search the file for all other `makeDb()` call sites (line 235, line 512, lines 608, 632, 700) and replace each with `makeRawEventsDb()`.
   - Do NOT change `countRows` call sites — the signature is identical.
   - Keep the local `selectRows()` helper at lines 120-124 and the local `interface RawEventRow` at lines 115-118. They are used only by `runEventBridge.test.ts` and do not duplicate across files; out of scope for this refactor.

3. **Update `runExecutor.test.ts`.** Open `main/src/orchestrator/__tests__/runExecutor.test.ts` and:
   - Remove the local `RAW_EVENTS_DDL_EXEC` constant at lines 691-699.
   - Add to the imports (the file already imports `Database` from `better-sqlite3`):
     ```ts
     import { makeRawEventsDb, countRows } from './__fixtures__/rawEvents';
     ```
   - For each of the three `new Database(':memory:') ; db.pragma('foreign_keys = OFF'); db.exec(RAW_EVENTS_DDL_EXEC);` triplets (lines 738-740, 851-853, 1266-1268), replace all three lines with `const db = makeRawEventsDb();` (or `db = makeRawEventsDb();` if `db` is already declared via `let` in scope — inspect each site).
   - Replace the two inlined COUNT queries:
     - At lines 832-834 (`'SELECT COUNT(*) AS cnt FROM raw_events WHERE run_id = ?'`), replace the three-line `prepare/.get/...as { cnt }` idiom with `const cnt = countRows(db, run.id);` and update the assertion to `expect(cnt).toBe(1);`.
     - At lines 1313-1316, do the same: `const cnt = countRows(db, run.id); expect(cnt).toBe(0);`.

4. **Completeness gate — re-run the dedup sweep grep before reporting COMPLETED:**
   ```
   grep -nE "const (RAW_EVENTS_DDL|RAW_EVENTS_DDL_EXEC)|function makeDb|SELECT COUNT\(\*\) AS (n|cnt) FROM raw_events" main/src/orchestrator/__tests__/runEventBridge.test.ts main/src/orchestrator/__tests__/runExecutor.test.ts
   ```
   Must return zero matches.

5. **Run the affected test files.**
   ```
   pnpm --filter main test -- --run main/src/orchestrator/__tests__/runEventBridge.test.ts main/src/orchestrator/__tests__/runExecutor.test.ts
   ```
   Both files must pass with no skipped tests. If better-sqlite3 emits NODE_MODULE_VERSION errors, follow the CLAUDE.md guidance: `pnpm electron:rebuild` and rerun.

## Acceptance Criteria

- Fixture module exists at the path above with the three named exports.
- Both test files import from the fixture and contain no duplicate DDL / `makeDb` / inline COUNT queries.
- The orchestrator test suite passes unchanged (same count of tests, same green status).

## Test Strategy

No new tests. The fixture is exercised by the two existing test files that import it (collectively ~25 test cases that prepare a DB and assert rows or COUNT). If the fixture is wrong, those existing tests fail loudly.

## Hardest Decision

**Whether `selectRows()` should move into the fixture.** It currently lives only in `runEventBridge.test.ts:120-124` (no copy in `runExecutor.test.ts`). Moving it into the fixture is YAGNI right now and would force `runEventBridge.test.ts` to import `interface RawEventRow` from a different file too. Chose to leave `selectRows` and `RawEventRow` in `runEventBridge.test.ts` — the dedup pressure is on `RAW_EVENTS_DDL`, `makeDb`, and `countRows`, not on per-file selector helpers. If `runExecutor.test.ts` later grows a need for `selectRows`, that's the moment to promote it.

## Rejected Alternatives

- **Co-locate the fixture with the test files (no `__fixtures__` subdir).** Rejected: the orchestrator test dir already has 17 files; a flat layout would obscure that this is shared test infrastructure rather than a test file itself. The `__fixtures__/` convention is Jest/Vitest-idiomatic and is the conventional place for shared per-suite test data.
- **Generate the DDL from the migration SQL file at test load time.** Rejected: cost (file I/O, parser to strip the FK clause, vitest globalSetup wiring) outweighs benefit — schema 006 is stable and any change requires a CODEOWNERS-style review anyway. A failing test from drift would point straight at the fixture, which is what we want.
- **Export only `RAW_EVENTS_DDL`, leave `makeDb` + `countRows` per-file.** Rejected: this preserves the call-site duplication problem in `runExecutor.test.ts` (currently 3 inline `new Database(':memory:').exec(...)` triplets and 2 inline COUNT queries). Promoting all three symbols once is cheaper than chasing them later.

## Lowest Confidence Area

The third call site at lines 1266-1268 in `runExecutor.test.ts` sits inside the panelId-alignment integration block (TASK-663). I have not visually verified the surrounding scope (whether `db` is declared with `let` or `const`); the executor must inspect the exact shape and adapt the replacement (use `=` versus `const db =`). Same caveat for the `Database` import — both test files already import `Database` from `better-sqlite3`, but the fixture module re-imports it, which is correct (the fixture is the construction site).
