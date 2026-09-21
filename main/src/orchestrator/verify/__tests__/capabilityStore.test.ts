/**
 * Unit tests for VerifyCapabilityStore — the (project, modality, runbook)
 * capability ledger backing the phase-0 per-modality `unsupported` mark and
 * K-consecutive-env-failure circuit breaker (docs/proposals/
 * verification-setup-flow.md §3.3/§3.4). Against a migration-backed in-memory
 * DB (006 → 011 → 014 → 015 → 016 → 055 → 056 → 095, mirroring
 * migration078.test.ts's THROUGH_056 chain extended through the new file) so
 * the two new tables (verify_capability_state / verify_host_state) come from
 * the REAL migration 095, not a hand-rolled schema — proving the migration file
 * itself is what these tests exercise.
 *
 * Covers: sub-threshold recording, the trip transition, healthy-outcome
 * clearing, TTL expiry, host-generation-bump expiry, the unsupported mark
 * (independent of the breaker, survives a healthy outcome), runbook-hash
 * keying, and fail-soft behavior against a pre-095 DB missing the ledger
 * tables entirely.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MOBILE_TOOLCHAIN_UNPROBED_DETAIL } from '../mobileGates';
import {
  VerifyCapabilityStore,
  CAPABILITY_BREAKER_THRESHOLD,
  CAPABILITY_SUPPRESSION_TTL_MS,
} from '../capabilityStore';

const MIG_DIR = join(__dirname, '..', '..', '..', 'database', 'migrations');

// Mirrors migration078.test.ts's THROUGH_056 constant — the minimal chain that
// stands up workflow_runs + verification_requests (which 095 ALTERs).
const THROUGH_056 = [
  '006_cyboflow_schema.sql',
  '011_workflow_step_tracking.sql',
  '014_native_tasks.sql',
  '015_entity_model_rebuild.sql',
  '016_review_items.sql',
  '055_visual_verification.sql',
  '056_visual_verify_budget.sql',
];

function apply(db: Database.Database, files: string[]): void {
  for (const f of files) db.exec(readFileSync(join(MIG_DIR, f), 'utf-8'));
}

function seedProject(db: Database.Database): void {
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Proj', '/tmp/p1');
}

/** Full chain through 095 — the "you get it for free from real migrations" DB. */
function buildDb(): Database.Database {
  const db = new Database(':memory:');
  seedProject(db);
  apply(db, [...THROUGH_056, '095_verify_failure_classes.sql']);
  return db;
}

/** Same chain WITHOUT 095 — proves fail-soft behavior on a pre-095 DB. */
function buildPre095Db(): Database.Database {
  const db = new Database(':memory:');
  seedProject(db);
  apply(db, THROUGH_056);
  return db;
}

describe('VerifyCapabilityStore', () => {
  it('migration 095 creates verify_capability_state and verify_host_state', () => {
    const db = buildDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('verify_capability_state', 'verify_host_state')")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name).sort();
    expect(names).toEqual(['verify_capability_state', 'verify_host_state']);
    db.close();
  });

  it('recording failures under the threshold never trips the breaker', () => {
    const db = buildDb();
    const store = new VerifyCapabilityStore(db);

    expect(store.recordEnvFailure(1, 'web', 'port refused')).toEqual({ tripped: false });
    expect(store.recordEnvFailure(1, 'web', 'port refused')).toEqual({ tripped: false });
    // 2 < CAPABILITY_BREAKER_THRESHOLD (3) — not yet suppressed.
    expect(CAPABILITY_BREAKER_THRESHOLD).toBe(3);
    expect(store.getActiveSuppression(1, 'web')).toBeNull();
    db.close();
  });

  it('the Kth consecutive env failure trips the breaker; getActiveSuppression then reports it', () => {
    const db = buildDb();
    const store = new VerifyCapabilityStore(db);

    store.recordEnvFailure(1, 'web', 'port refused');
    store.recordEnvFailure(1, 'web', 'port refused');
    const third = store.recordEnvFailure(1, 'web', 'port refused');
    expect(third).toEqual({ tripped: true });

    const active = store.getActiveSuppression(1, 'web');
    expect(active).toEqual({ status: 'suppressed', reason: 'port refused' });
    db.close();
  });

  it('a 4th consecutive failure after tripping does not re-trip', () => {
    const db = buildDb();
    const store = new VerifyCapabilityStore(db);
    store.recordEnvFailure(1, 'web', 'r1');
    store.recordEnvFailure(1, 'web', 'r1');
    store.recordEnvFailure(1, 'web', 'r1');
    const fourth = store.recordEnvFailure(1, 'web', 'r1');
    expect(fourth).toEqual({ tripped: false });
    db.close();
  });

  it('recordHealthyOutcome resets the counter and clears a suppressed breaker mark', () => {
    const db = buildDb();
    const store = new VerifyCapabilityStore(db);
    store.recordEnvFailure(1, 'web', 'r1');
    store.recordEnvFailure(1, 'web', 'r1');
    store.recordEnvFailure(1, 'web', 'r1');
    expect(store.getActiveSuppression(1, 'web')).not.toBeNull();

    store.recordHealthyOutcome(1, 'web');
    expect(store.getActiveSuppression(1, 'web')).toBeNull();

    // Counter reset means it takes a full new run of K failures to re-trip.
    expect(store.recordEnvFailure(1, 'web', 'r2')).toEqual({ tripped: false });
    expect(store.recordEnvFailure(1, 'web', 'r2')).toEqual({ tripped: false });
    expect(store.recordEnvFailure(1, 'web', 'r2')).toEqual({ tripped: true });
    db.close();
  });

  it('a suppression past its TTL self-refreshes to inactive', () => {
    const db = buildDb();
    const store = new VerifyCapabilityStore(db);
    store.recordEnvFailure(1, 'web', 'r1');
    store.recordEnvFailure(1, 'web', 'r1');
    store.recordEnvFailure(1, 'web', 'r1');
    expect(store.getActiveSuppression(1, 'web')).not.toBeNull();

    // Directly overwrite suppressed_until to the past (simulates TTL elapsing
    // without waiting CAPABILITY_SUPPRESSION_TTL_MS in real time).
    expect(CAPABILITY_SUPPRESSION_TTL_MS).toBeGreaterThan(0);
    db.prepare(
      `UPDATE verify_capability_state SET suppressed_until = ? WHERE project_id = 1 AND modality = 'web' AND runbook_hash = ''`,
    ).run(new Date(Date.now() - 1000).toISOString());

    expect(store.getActiveSuppression(1, 'web')).toBeNull();
    db.close();
  });

  it('a host-generation bump invalidates an existing suppression', () => {
    const db = buildDb();
    const store = new VerifyCapabilityStore(db);
    store.recordEnvFailure(1, 'web', 'r1');
    store.recordEnvFailure(1, 'web', 'r1');
    store.recordEnvFailure(1, 'web', 'r1');
    expect(store.getActiveSuppression(1, 'web')).not.toBeNull();

    const newGen = store.bumpHostGeneration();
    expect(newGen).toBeGreaterThan(0);
    expect(store.currentHostGeneration()).toBe(newGen);

    // The row's stamped host_generation is now stale relative to the bumped one.
    expect(store.getActiveSuppression(1, 'web')).toBeNull();
    db.close();
  });

  it('currentHostGeneration defaults to 0 when the singleton row is absent', () => {
    const db = buildDb();
    const store = new VerifyCapabilityStore(db);
    expect(store.currentHostGeneration()).toBe(0);
    db.close();
  });

  it('markUnsupported is visible via getActiveSuppression and survives recordHealthyOutcome (never an env-breaker mark)', () => {
    const db = buildDb();
    const store = new VerifyCapabilityStore(db);

    // An illustrative literal only — the ledger stores whatever the gate hands
    // it. Kept in sync with the gate's real mobile detail so a reader does not
    // learn a reason string the code stopped producing.
    store.markUnsupported(1, 'mobile', MOBILE_TOOLCHAIN_UNPROBED_DETAIL);
    expect(store.getActiveSuppression(1, 'mobile')).toEqual({
      status: 'unsupported',
      reason: MOBILE_TOOLCHAIN_UNPROBED_DETAIL,
    });

    // recordHealthyOutcome only clears a 'suppressed' breaker mark, never 'unsupported'.
    store.recordHealthyOutcome(1, 'mobile');
    expect(store.getActiveSuppression(1, 'mobile')).toEqual({
      status: 'unsupported',
      reason: MOBILE_TOOLCHAIN_UNPROBED_DETAIL,
    });
    db.close();
  });

  it('runbook_hash keys entries separately — one hash tripping the breaker does not suppress another', () => {
    const db = buildDb();
    const store = new VerifyCapabilityStore(db);

    store.recordEnvFailure(1, 'web', 'r1', 'hash-a');
    store.recordEnvFailure(1, 'web', 'r1', 'hash-a');
    store.recordEnvFailure(1, 'web', 'r1', 'hash-a');
    expect(store.getActiveSuppression(1, 'web', 'hash-a')).not.toBeNull();
    expect(store.getActiveSuppression(1, 'web', 'hash-b')).toBeNull();
    // Default ('') runbook hash is its own independent entry too.
    expect(store.getActiveSuppression(1, 'web')).toBeNull();
    db.close();
  });

  it('a modality with no recorded activity has no active suppression', () => {
    const db = buildDb();
    const store = new VerifyCapabilityStore(db);
    expect(store.getActiveSuppression(1, 'cdp-app')).toBeNull();
    db.close();
  });

  it('fails soft to nulls / zero / no-throw against a pre-095 DB missing the ledger tables', () => {
    const db = buildPre095Db();
    const store = new VerifyCapabilityStore(db);

    expect(() => store.getActiveSuppression(1, 'web')).not.toThrow();
    expect(store.getActiveSuppression(1, 'web')).toBeNull();

    expect(() => store.recordEnvFailure(1, 'web', 'r1')).not.toThrow();
    expect(store.recordEnvFailure(1, 'web', 'r1')).toEqual({ tripped: false });

    expect(() => store.recordHealthyOutcome(1, 'web')).not.toThrow();
    expect(() => store.markUnsupported(1, 'web', 'r1')).not.toThrow();

    expect(() => store.bumpHostGeneration()).not.toThrow();
    expect(store.bumpHostGeneration()).toBe(0);

    expect(() => store.currentHostGeneration()).not.toThrow();
    expect(store.currentHostGeneration()).toBe(0);
    db.close();
  });
});
