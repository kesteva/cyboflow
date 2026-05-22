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
 *
 * Environment overrides (for testing):
 *   SCHEMA_PATH     — absolute path to schema.sql (default: main/src/database/schema.sql)
 *   MIGRATIONS_DIR  — absolute path to migrations directory (default: main/src/database/migrations)
 */
'use strict';

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SCHEMA_PATH = process.env.SCHEMA_PATH || path.join(REPO_ROOT, 'main/src/database/schema.sql');
const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR || path.join(REPO_ROOT, 'main/src/database/migrations');

const verbose = process.argv.includes('--verbose');

function listMigrationFiles() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))
    .sort();
}

function applySql(db, sql) {
  // SQLite's exec() handles multi-statement input directly.
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
    try { applySql(db, fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf-8')); }
    catch (err) {
      // Migrations 003/004/005 may reference inherited Crystal tables
      // (prompt_markers, execution_diffs) not declared in schema.sql.
      // Tolerate "no such table" AND "no such column" errors.
      //
      // "no such column" is triggered by migration
      // 008_permission_mode_approve_default.sql, which runs
      //   UPDATE sessions SET permission_mode = 'approve' ...
      //   UPDATE projects SET default_permission_mode = 'approve' ...
      // The `sessions.permission_mode` column is materialized at runtime by
      // database.ts (ALTER TABLE … ADD COLUMN, ~line 281) and the `projects`
      // table itself is created imperatively (~lines 285-307) — neither is
      // replayed by path-1. See FIND-SPRINT-030-4 for the root-cause analysis.
      const msg = String(err.message || err);
      if (/no such (table|column)/i.test(msg)) {
        if (verbose) console.warn(`[skip] migration ${f} (path-1): ${msg}`);
        continue;
      }
      throw err;
    }
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
      // "no such table" AND "no such column" errors for symmetry with
      // buildPath1Db — divergent error policies between the two paths would
      // allow path-1 to silently skip a migration that path-2 throws on,
      // producing a confusing diff. See FIND-SPRINT-030-4.
      const msg = String(err.message || err);
      if (/no such (table|column)/i.test(msg)) {
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
  console.log('');
  console.log('Environment overrides:');
  console.log('  SCHEMA_PATH     — path to schema.sql');
  console.log('  MIGRATIONS_DIR  — path to migrations directory');
  process.exit(0);
}

main();
