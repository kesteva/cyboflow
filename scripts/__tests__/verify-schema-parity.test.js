#!/usr/bin/env node
/**
 * Integration tests for scripts/verify-schema-parity.js.
 *
 * Uses Node.js built-in test runner (node:test + node:assert) — no extra deps.
 *
 * Run: node scripts/__tests__/verify-schema-parity.test.js
 * Exit 0 on all pass, non-zero if any test fails.
 *
 * Three cases:
 *   1. Happy path — real schema.sql + migrations, expect exit 0.
 *   2. Extra column in schema.sql only — drift detected, expect exit non-0 + stderr names column.
 *   3. Extra table only in a migration — drift detected, expect exit non-0.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts/verify-schema-parity.js');
const REAL_SCHEMA = path.join(REPO_ROOT, 'main/src/database/schema.sql');
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, 'main/src/database/migrations');

/**
 * Spawn the parity script with optional env overrides.
 * Returns { status, stdout, stderr }.
 */
function runScript(env = {}) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

/**
 * Create a temp directory, copy schema.sql, and populate a migrations dir.
 * Returns { tmpDir, schemaPath, migrationsDir } — caller must clean up.
 */
function setupFixtureDirs(options = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-parity-test-'));

  const schemaPath = path.join(tmpDir, 'schema.sql');
  const migrationsDir = path.join(tmpDir, 'migrations');
  fs.mkdirSync(migrationsDir, { recursive: true });

  // Default: copy the real schema.sql
  if (options.schemaContent !== undefined) {
    fs.writeFileSync(schemaPath, options.schemaContent, 'utf-8');
  } else {
    fs.copyFileSync(REAL_SCHEMA, schemaPath);
  }

  // Default: copy only migration 006 and 007 (the cyboflow-only migrations, no inherited-table deps)
  if (options.migrations !== undefined) {
    for (const [filename, content] of Object.entries(options.migrations)) {
      fs.writeFileSync(path.join(migrationsDir, filename), content, 'utf-8');
    }
  } else {
    for (const f of ['006_cyboflow_schema.sql', '007_add_stuck_reason.sql']) {
      fs.copyFileSync(path.join(REAL_MIGRATIONS_DIR, f), path.join(migrationsDir, f));
    }
  }

  return { tmpDir, schemaPath, migrationsDir };
}

// ---------------------------------------------------------------------------
// Test 1: Happy path — real schema + real migrations → exit 0
// ---------------------------------------------------------------------------
test('happy path: real schema.sql + migrations exits 0', () => {
  const result = runScript();
  assert.strictEqual(
    result.status,
    0,
    `Expected exit 0 but got ${result.status}.\nstderr: ${result.stderr}\nstdout: ${result.stdout}`
  );
});

// ---------------------------------------------------------------------------
// Test 2: Extra column in schema.sql — drift detected, exit non-0, stderr names column
// ---------------------------------------------------------------------------
test('drift: extra column in schema.sql causes exit non-0 with column name in stderr', () => {
  const realSchema = fs.readFileSync(REAL_SCHEMA, 'utf-8');
  // Inject a bogus column into workflow_runs in the fresh-install schema.
  // This column never appears in any migration, so path-1 has it but path-2 does not.
  const driftedSchema = realSchema.replace(
    'ended_at DATETIME,',
    'ended_at DATETIME,\n  bogus_test_column TEXT,'
  );
  assert.ok(
    driftedSchema.includes('bogus_test_column'),
    'Fixture: bogus_test_column not injected into schema content'
  );

  const { tmpDir, schemaPath, migrationsDir } = setupFixtureDirs({
    schemaContent: driftedSchema,
  });

  try {
    const result = runScript({
      SCHEMA_PATH: schemaPath,
      MIGRATIONS_DIR: migrationsDir,
    });

    assert.notStrictEqual(
      result.status,
      0,
      `Expected non-0 exit but got 0.\nstdout: ${result.stdout}`
    );
    assert.ok(
      result.stderr.includes('bogus_test_column'),
      `Expected stderr to name 'bogus_test_column'.\nstderr: ${result.stderr}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 3: Schema.sql creates a table missing a column that only migrations have
//
// This tests the reverse of test 2: schema.sql's workflow_runs table is missing
// a column that migration 006 declares (stuck_reason). Since migration 006 uses
// CREATE TABLE IF NOT EXISTS, path-1 keeps the under-specified schema.sql table
// while path-2 gets the full migration column set. The script must exit non-0.
// ---------------------------------------------------------------------------
test('drift: schema.sql missing a column present in migration causes exit non-0', () => {
  const realSchema = fs.readFileSync(REAL_SCHEMA, 'utf-8');
  // Strip stuck_reason from the schema.sql workflow_runs definition.
  // The migration (006) declares this column; schema.sql's IF NOT EXISTS means
  // migration-006's CREATE TABLE is a no-op in path-1, leaving stuck_reason absent.
  const strippedSchema = realSchema.replace(
    /^\s*stuck_reason TEXT,\s*\n/m,
    ''
  );
  assert.ok(
    !strippedSchema.includes('stuck_reason TEXT,'),
    'Fixture: stuck_reason TEXT was not removed from schema content'
  );

  const { tmpDir, schemaPath, migrationsDir } = setupFixtureDirs({
    schemaContent: strippedSchema,
  });

  try {
    const result = runScript({
      SCHEMA_PATH: schemaPath,
      MIGRATIONS_DIR: migrationsDir,
    });

    assert.notStrictEqual(
      result.status,
      0,
      `Expected non-0 exit but got 0.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
    );
    assert.ok(
      result.stderr.includes('stuck_reason') || result.stderr.includes('workflow_runs'),
      `Expected stderr to mention 'stuck_reason' or 'workflow_runs'.\nstderr: ${result.stderr}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
