---
id: TASK-639
idea: SPRINT-015-compound
status: ready
created: "2026-05-18T00:00:00Z"
files_owned:
  - scripts/verify-schema-parity.js
  - package.json
  - docs/CODE-PATTERNS.md
files_readonly:
  - main/src/database/schema.sql
  - main/src/database/migrations/006_cyboflow_schema.sql
  - main/src/database/migrations/007_add_stuck_reason.sql
  - main/src/database/migrations/003_add_tool_panels.sql
  - main/src/database/migrations/004_claude_panels.sql
  - main/src/database/migrations/005_unified_panel_settings.sql
  - main/src/database/__test_fixtures__/registrySchema.ts
  - main/src/database/database.ts
acceptance_criteria:
  - criterion: "scripts/verify-schema-parity.js exists and is executable as a node script"
    verification: "test -f scripts/verify-schema-parity.js && node scripts/verify-schema-parity.js --help exit 0 (or exits with usage info; non-error)"
  - criterion: "Running the script against the current tree exits 0 (no drift)"
    verification: "node scripts/verify-schema-parity.js exits 0"
  - criterion: "Mutation test: a deliberately-divergent extra column in schema.sql (manually injected then reverted) causes the script to exit non-0"
    verification: "(manual — verified during development; do not commit the divergence)"
  - criterion: "pnpm run verify:schema is wired into the root test:unit chain"
    verification: "grep -nE '\"verify:schema\"|verify-schema' package.json returns at least 2 matches (the script alias + invocation in test:unit)"
  - criterion: "CODE-PATTERNS.md documents migration 006/007 as the canonical workflow_runs DDL source"
    verification: "grep -nE 'canonical.*migration 006|migration 006.*canonical|canonical DDL source' docs/CODE-PATTERNS.md returns at least 1 match"
  - criterion: "Full pnpm run test:unit chain passes including the new verify:schema step"
    verification: "pnpm run test:unit exits 0"
depends_on: []
estimated_complexity: medium
epic: testing-infrastructure
test_strategy:
  needed: true
  justification: "New script with non-trivial logic (DB initialization, drift comparison). The script's own success path is exercised by the AC's `node scripts/verify-schema-parity.js` invocation against the canonical tree. The negative path (drift detection actually fires) is the more important regression guard — encode it as a fixture-based unit test that injects a deliberate divergence and asserts the script exits non-0."
  targets:
    - behavior: "When schema.sql + migrations produce identical schema, the script exits 0"
      test_file: "scripts/__tests__/verify-schema-parity.test.js"
      type: integration
    - behavior: "When a fixture schema.sql declares an extra column that migrations never add, the script exits non-0 with a useful diff"
      test_file: "scripts/__tests__/verify-schema-parity.test.js"
      type: integration
    - behavior: "When a fixture migration adds a table not in schema.sql, the script exits non-0"
      test_file: "scripts/__tests__/verify-schema-parity.test.js"
      type: integration
prerequisites:
  - check: "node -e \"require('better-sqlite3')\" 2>/dev/null"
    fix: "pnpm install (root) — better-sqlite3 is already a main workspace dep"
    description: "The script runs better-sqlite3 in-memory to compare schemas; must be resolvable from the repo root or via a relative require"
    blocking: true
---

# Add schema parity CI check and designate migration 006 as canonical DDL source

## Objective

`workflow_runs` DDL currently lives in five places: `main/src/database/schema.sql:44-73`, `main/src/database/migrations/006_cyboflow_schema.sql:17-34`, `main/src/database/__test_fixtures__/registrySchema.ts:33-50`, `main/src/services/cyboflow/__tests__/transitions.test.ts:41-55` (inline, removed by TASK-635), and `main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts:42-55` (inline, removed by TASK-635). After TASK-635 lands, three of those collapse into REGISTRY_SCHEMA — but no automated check catches drift between the remaining three (schema.sql, migration 006, registrySchema.ts fixture).

TASK-598's AC used `grep -A 10` which gave a false-positive on missing columns (the column was on line 11, outside the 10-line context window). The fix is structural: open an in-memory SQLite, apply `schema.sql`, then re-apply every migration in order, and assert that no `CREATE TABLE` statement in a migration produces a *new* row in `sqlite_master` (which would mean schema.sql is missing that table). Also assert that for every table in `sqlite_master`, the column list matches between the "schema.sql + migrations" path and a separate "migrations-only" path applied to a fresh DB.

The compounder also proposed having `registrySchema.ts` read `schema.sql` at module load. I rejected this for the same reason TASK-635 rejected reading at runtime: byte-coupling tests to a file's exact bytes is fragile across whitespace/comment edits, and the parity script gives us the equivalent guarantee at build/CI time without the runtime cost.

## Plan Decisions

- **Canonical source: migration 006 (for cyboflow tables).** `schema.sql` is the fresh-install fast path; migration 006 is the upgrade path. Both must remain byte-equivalent for new cyboflow tables. The script asserts equality of resulting schemas, not of source bytes.
- **The script compares column sets and PK/FK definitions, NOT comments or formatting.** SQLite's `PRAGMA table_info(<table>)` + `sqlite_master.sql` (normalized) are the comparison oracles.
- **The fixture `__test_fixtures__/registrySchema.ts` is NOT included in the parity check.** Reason: it's a documented subset (workflows + workflow_runs only for REGISTRY_SCHEMA; +approvals+raw_events for GATE_SCHEMA) — comparing column-for-column would force the fixture to mirror the legacy `sessions`/`tool_panels` tables. Instead, the fixture's correctness is enforced by the test suite itself: any drift in REGISTRY_SCHEMA causes test failures in workflowRegistry.test.ts. Documented this rationale in the script's header comment.

## Implementation Steps

1. **Create `scripts/verify-schema-parity.js`.** Node script (CJS — matches the existing scripts/* style):
   ```js
   #!/usr/bin/env node
   /**
    * Schema parity check.
    *
    * Compares the schema produced by two paths against the canonical
    * cyboflow database initialization:
    *   1) schema.sql + every numbered migration applied in order (the
    *      "fresh-install + upgrade" path used by DatabaseService.initialize)
    *   2) migrations only, starting from an empty DB (the "minimal" path)
    *
    * If path (1) and path (2) produce different schemas, schema.sql is out
    * of sync with the migration set — exactly the FIND-SPRINT-015-21 drift class.
    *
    * Exit 0: schemas match.
    * Exit 1: drift detected; prints a per-table column diff to stderr.
    *
    * Why not include the registrySchema.ts test fixture? It is a documented
    * subset, not a full mirror — its drift is caught by the test suite that
    * uses it. See plan TASK-639 for the rationale.
    *
    * Usage:
    *   node scripts/verify-schema-parity.js [--verbose]
    */
   const Database = require('better-sqlite3');
   const fs = require('fs');
   const path = require('path');

   const REPO_ROOT = path.resolve(__dirname, '..');
   const SCHEMA_PATH = path.join(REPO_ROOT, 'main/src/database/schema.sql');
   const MIGRATIONS_DIR = path.join(REPO_ROOT, 'main/src/database/migrations');

   const verbose = process.argv.includes('--verbose');

   function listMigrationFiles() {
     return fs.readdirSync(MIGRATIONS_DIR)
       .filter((f) => /^\d{3}_.*\.sql$/.test(f))
       .sort();
   }

   function applySql(db, sql) {
     // Best-effort: split on `;` outside of strings, run each statement.
     // SQLite's exec() handles multi-statement input directly, so prefer that.
     db.exec(sql);
   }

   function schemaSignature(db) {
     // Capture (table, column) pairs + PK/FK info — order-independent.
     const tables = db
       .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
       .all().map((r) => r.name);
     const sig = {};
     for (const t of tables) {
       const cols = db.prepare(`PRAGMA table_info(${t})`).all();
       const fks = db.prepare(`PRAGMA foreign_key_list(${t})`).all();
       sig[t] = {
         columns: cols.map((c) => ({ name: c.name, type: c.type, notnull: c.notnull, pk: c.pk })).sort((a, b) => a.name.localeCompare(b.name)),
         fks: fks.map((f) => ({ table: f.table, from: f.from, to: f.to })).sort((a, b) => a.from.localeCompare(b.from)),
       };
     }
     return sig;
   }

   function buildPath1Db() {
     const db = new Database(':memory:');
     applySql(db, fs.readFileSync(SCHEMA_PATH, 'utf-8'));
     for (const f of listMigrationFiles()) {
       applySql(db, fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf-8'));
     }
     return db;
   }

   function buildPath2Db() {
     const db = new Database(':memory:');
     for (const f of listMigrationFiles()) {
       try { applySql(db, fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf-8')); }
       catch (err) {
         // Migrations 003/004/005 may reference inherited Crystal tables
         // (sessions, tool_panels) not declared by themselves. We tolerate
         // these errors only if the message names a missing inherited table.
         const msg = String(err.message || err);
         if (/no such table/i.test(msg)) {
           if (verbose) console.warn(`[skip] migration ${f}: ${msg}`);
           continue;
         }
         throw err;
       }
     }
     return db;
   }

   function diffSignatures(a, b) {
     const allTables = new Set([...Object.keys(a), ...Object.keys(b)]);
     const diffs = [];
     for (const t of [...allTables].sort()) {
       if (!a[t]) { diffs.push(`+ table ${t} only in path-2 (migrations-only)`); continue; }
       if (!b[t]) { diffs.push(`- table ${t} only in path-1 (schema.sql + migrations)`); continue; }
       const colsA = JSON.stringify(a[t].columns);
       const colsB = JSON.stringify(b[t].columns);
       if (colsA !== colsB) {
         diffs.push(`! table ${t} column drift:\n  path-1: ${colsA}\n  path-2: ${colsB}`);
       }
       const fksA = JSON.stringify(a[t].fks);
       const fksB = JSON.stringify(b[t].fks);
       if (fksA !== fksB) {
         diffs.push(`! table ${t} FK drift:\n  path-1: ${fksA}\n  path-2: ${fksB}`);
       }
     }
     return diffs;
   }

   function main() {
     const path1 = buildPath1Db();
     const sig1 = schemaSignature(path1);
     path1.close();
     const path2 = buildPath2Db();
     const sig2 = schemaSignature(path2);
     path2.close();

     // The asymmetry is intentional: path-1 includes legacy schema.sql tables
     // (sessions, tool_panels, user_preferences) that migrations don't re-declare.
     // We assert path-2 ⊆ path-1 (every migration-declared table exists in path-1
     // with matching columns), but not the reverse.
     const onlyPath1Tables = Object.keys(sig1).filter((t) => !(t in sig2));
     const path2Filtered = sig2;
     const path1Filtered = Object.fromEntries(Object.entries(sig1).filter(([t]) => t in sig2));
     const diffs = diffSignatures(path1Filtered, path2Filtered);

     if (verbose) {
       console.log(`[parity] path-1 tables: ${Object.keys(sig1).length}; path-2 tables: ${Object.keys(sig2).length}`);
       console.log(`[parity] tables only in path-1 (legacy schema.sql): ${onlyPath1Tables.join(', ') || '(none)'}`);
     }

     if (diffs.length > 0) {
       console.error('[schema-parity] DRIFT DETECTED:');
       for (const d of diffs) console.error('  ' + d);
       process.exit(1);
     }
     if (verbose) console.log('[schema-parity] OK — no drift between schema.sql and migrations.');
     process.exit(0);
   }

   if (process.argv.includes('--help')) {
     console.log('Usage: node scripts/verify-schema-parity.js [--verbose]');
     console.log('  Compares schema.sql + migrations vs migrations-only; exits non-0 on drift.');
     process.exit(0);
   }

   main();
   ```
   The asymmetry note matters: `schema.sql` has legacy tables (`sessions`, `session_outputs`, `conversation_messages`, plus everything migrations 003/004/005 reference) that the migrations don't redeclare. Path-2 (migrations-only) cannot reproduce these without their parent tables, so the script tolerates "no such table" errors during path-2 build and asserts only the *intersection* set matches column-for-column.

2. **Wire the script into `package.json`.** Add `verify:schema` as a top-level script and append it to the `test:unit` chain:
   ```diff
        "test:build": "node build/afterSign.test.js && node scripts/configure-build.test.js",
   -   "test:unit": "pnpm --filter main test && pnpm --filter frontend test && pnpm run test:build",
   +   "verify:schema": "node scripts/verify-schema-parity.js",
   +   "test:unit": "pnpm --filter main test && pnpm --filter frontend test && pnpm run verify:schema && pnpm run test:build",
   ```

3. **Document the canonical source in `docs/CODE-PATTERNS.md`.** Add a new subsection (location: under "File / Directory Conventions" or under a new "## Database Schema" section near the bottom — pick whichever fits the existing structure best after reading the doc):
   ```markdown
   ## Database Schema

   ### Canonical DDL Source

   The `workflow_runs` table and other cyboflow-era tables (`workflows`, `approvals`, `raw_events`, `messages`) live in TWO files that MUST stay in sync:

   - `main/src/database/schema.sql` — fresh-install fast path. Run once on a new DB.
   - `main/src/database/migrations/006_cyboflow_schema.sql` — upgrade path. Applied via `runFileBasedMigrations()` for existing DBs.

   **Canonical for cyboflow tables: migration 006.** Treat it as the authoritative declaration; mirror any column add/drop into `schema.sql` in the same commit. Migration 007 (and any future 00N) extends the schema additively.

   A CI guard (`pnpm run verify:schema`, wired into `pnpm run test:unit`) opens an in-memory SQLite, applies the two paths side-by-side, and asserts the resulting column sets and FKs match. The script lives at `scripts/verify-schema-parity.js`; it does NOT compare test fixtures like `registrySchema.ts` — those are documented subsets and any drift is caught by the test suites that import them.
   ```

4. **Write `scripts/__tests__/verify-schema-parity.test.js` (new file, vitest or node:test).** Three cases:
   - **Happy path.** Spawn the script as a child process against the current tree; assert exit 0.
   - **Drift: extra column in schema.sql.** Use `fs.cpSync` to copy `main/src/database/schema.sql` to a temp dir, append `ALTER TABLE workflow_runs ADD COLUMN bogus TEXT;` (or modify CREATE TABLE), and run the script with an env-var override (the script accepts `SCHEMA_PATH` and `MIGRATIONS_DIR` env-vars — add support in step 1; or inject via a CLI flag). Assert exit non-0 and stderr names `bogus`.
   - **Drift: extra table in a migration.** Same pattern with a fixture migrations dir containing 999_bogus_table.sql.

   **Test environment override.** Update the script in step 1 to honor `SCHEMA_PATH` and `MIGRATIONS_DIR` env-vars for test injection (default to the real paths). Add a `--schema=<path> --migrations=<dir>` CLI shim as an alternative.

5. **Run the AC completeness gate:**
   ```
   node scripts/verify-schema-parity.js
   ```
   Expect exit 0 on the current tree.

   ```
   node scripts/verify-schema-parity.js --verbose
   ```
   Expect a "[parity] OK" line.

6. **Mutation test (manual).** Temporarily edit `schema.sql`'s `workflow_runs` table to add `nonexistent TEXT,` after `ended_at`. Run the script; expect exit 1 and a stderr line naming the column. Revert.

7. **Run the full test chain:**
   ```
   pnpm run test:unit
   ```
   Expect exit 0; includes `pnpm --filter main test`, `pnpm --filter frontend test`, `pnpm run verify:schema`, `pnpm run test:build`.

## Acceptance Criteria

- `scripts/verify-schema-parity.js` exists; `--help` works; `node scripts/verify-schema-parity.js` against the current tree exits 0.
- `package.json` has `verify:schema` aliased and invoked from `test:unit`.
- `docs/CODE-PATTERNS.md` documents migration 006 as canonical.
- Three integration tests in `scripts/__tests__/verify-schema-parity.test.js` cover happy + 2 drift paths.
- `pnpm run test:unit` exits 0.

## Hardest Decision

Whether the script should also compare against the `registrySchema.ts` test fixture. Decided no — the fixture is intentionally a subset and forcing equality would require mirroring 8+ legacy tables (sessions, tool_panels, etc.) that the fixture has no need for. Instead, the fixture's correctness is enforced by the test suites that use it (any column-drift breaks `workflowRegistry.test.ts` or `transitions.test.ts` at runtime). The script focuses on the actual production-installation drift surface (schema.sql ↔ migrations) where the bug class lives.

The secondary hard call: whether to gate the script on a strict `path-1 === path-2` or the asymmetric `path-2 ⊆ path-1` check. Picked asymmetric because `schema.sql` legitimately contains legacy tables (sessions, session_outputs, etc.) that migrations don't re-declare. Forcing strict equality would require either (a) splitting schema.sql into pre-cyboflow + cyboflow halves, or (b) declaring every legacy table in a migration too — both larger refactors. The asymmetric check still catches every drift class in scope (column add/drop in cyboflow tables, missing table in schema.sql).

## Rejected Alternatives

- **Make `registrySchema.ts` read `schema.sql` at module load.** Rejected — couples test runtime to byte layout of an unrelated file. The CI script gives the equivalent guarantee without the coupling.
- **Skip schema.sql entirely and only use migrations.** Rejected — that's a much bigger refactor (every fresh install would need to apply 5+ migrations) and orthogonal to this drift-detection concern. Worth revisiting later as a separate sprint.
- **Use a SQL-diff library (sqlite3-diff or similar).** Rejected — adds a heavy dep for a 200-line hand-written comparator. The PRAGMA-based approach in step 1 covers our drift cases (column add/drop, FK drift) without overhead.
- **Bail out of legacy-table tolerance and require strict path equality.** Rejected per the "secondary hard call" above. Worth revisiting if legacy tables get migrated to a numbered migration file.

## Lowest Confidence Area

The path-2 (migrations-only) build's tolerance for "no such table" errors when migrations 003/004/005 alter inherited tables they don't declare. The current code skips on regex match `no such table`; a future migration could fail for an unrelated reason (constraint violation, syntax error) and the script would skip it silently. Mitigation: log a warning in `--verbose` mode and consider tightening the regex to require the specific inherited-table names. Acceptable for v1 — the false-negative rate is low and the script's primary job is catching column drift in cyboflow tables, not validating legacy migrations.
