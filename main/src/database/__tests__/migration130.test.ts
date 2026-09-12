/**
 * Migration 130_tracker_status_sync_off.sql — `status_sync_enabled`, the OFF
 * switch for the status sync direction.
 *
 * Same technique as migration129.test.ts: the FULL real migration chain via
 * DatabaseService.initialize(). Proves:
 *   1. The column exists, NOT NULL DEFAULT 1 — every pre-existing connection
 *      keeps status sync RUNNING, because it is a direction they already had
 *      (the opposite of 118's columns, which defaulted off because nobody had
 *      consented to a capability that did not exist yet).
 *   2. `status_sync_mode` is UNCHANGED and still two-state. This is the whole
 *      reason the off switch is a second column: widening that CHECK poisons a
 *      ledger-wiped replay, because 105 and 129 both recreate the table with
 *      the narrow CHECK and both run BEFORE this file (test 4 pins exactly
 *      that, by storing 'off' in the mode column and watching 105 refuse it).
 *   3. Both values round-trip, and the pair expresses all three states.
 *   4. THE REGRESSION GUARD for the design: a widened `status_sync_mode` would
 *      have made the app unbootable after a ledger wipe.
 *   5. Replay convergence: a ledger-wiped re-run does not throw and the column
 *      comes back — at its DEFAULT, the documented degradation
 *      migration110.test.ts pins for `push_target` and 129's for
 *      `config_generation`, since 105/129's hardcoded column lists predate it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../database';

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-migration130-'));
  dbPath = join(tmpDir, 'test.db');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function seedProject(raw: Database.Database): void {
  raw.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Proj 1', '/tmp/p1');
}

function wipeLedger(path: string): void {
  const raw = new Database(path);
  raw.prepare("DELETE FROM user_preferences WHERE key LIKE 'file_migration_applied:%'").run();
  raw.close();
}

describe('Migration 130: an off switch for status sync', () => {
  it('adds status_sync_enabled NOT NULL DEFAULT 1 — existing connections keep syncing', () => {
    const svc = new DatabaseService(dbPath);
    svc.initialize();
    const raw = svc.getDb();
    seedProject(raw);

    raw
      .prepare("INSERT INTO tracker_connections (id, project_id, provider) VALUES ('c1', 1, 'dart')")
      .run();
    expect(
      raw.prepare("SELECT status_sync_enabled FROM tracker_connections WHERE id = 'c1'").get(),
    ).toEqual({ status_sync_enabled: 1 });

    expect(() =>
      raw.prepare("UPDATE tracker_connections SET status_sync_enabled = NULL WHERE id = 'c1'").run(),
    ).toThrow(/NOT NULL/i);
    raw.close();
  });

  it('leaves status_sync_mode two-state — the cadence column is untouched', () => {
    const svc = new DatabaseService(dbPath);
    svc.initialize();
    const raw = svc.getDb();
    seedProject(raw);

    for (const mode of ['auto', 'manual']) {
      expect(() =>
        raw
          .prepare(
            'INSERT INTO tracker_connections (id, project_id, provider, status_sync_mode) VALUES (?, 1, ?, ?)',
          )
          .run(`c-${mode}`, 'dart', mode),
      ).not.toThrow();
    }
    // 'off' lives in the OTHER column, deliberately — see test 4.
    expect(() =>
      raw
        .prepare(
          "INSERT INTO tracker_connections (id, project_id, provider, status_sync_mode) VALUES ('c-off', 1, 'dart', 'off')",
        )
        .run(),
    ).toThrow(/CHECK constraint/i);
    raw.close();
  });

  it('expresses all three states as a cadence/consent pair', () => {
    const svc = new DatabaseService(dbPath);
    svc.initialize();
    const raw = svc.getDb();
    seedProject(raw);

    const insert = raw.prepare(
      `INSERT INTO tracker_connections (id, project_id, provider, status_sync_mode, status_sync_enabled)
       VALUES (?, 1, 'dart', ?, ?)`,
    );
    insert.run('c-auto', 'auto', 1);
    insert.run('c-manual', 'manual', 1);
    // OFF keeps the cadence it had, which is what makes the off/on round trip
    // restore the user's Auto-vs-Manual choice instead of collapsing it.
    insert.run('c-off', 'manual', 0);

    expect(
      raw
        .prepare(
          'SELECT id, status_sync_mode, status_sync_enabled FROM tracker_connections ORDER BY id',
        )
        .all(),
    ).toEqual([
      { id: 'c-auto', status_sync_mode: 'auto', status_sync_enabled: 1 },
      { id: 'c-manual', status_sync_mode: 'manual', status_sync_enabled: 1 },
      { id: 'c-off', status_sync_mode: 'manual', status_sync_enabled: 0 },
    ]);
    raw.close();
  });

  it("REGRESSION GUARD: 'off' in status_sync_mode would break boot on a replay", () => {
    // This is why the off switch is a second column rather than a widened
    // CHECK. 105 and 129 both recreate tracker_connections with
    // `CHECK (status_sync_mode IN ('auto','manual'))` and copy the column
    // forward, and both run BEFORE 130 — so a row holding 'off' fails 105's
    // INSERT ... SELECT on a ledger-wiped replay and the app never boots.
    // Written against a value FORCED past the CHECK, so it keeps proving the
    // hazard even if someone later widens the constraint.
    const svc = new DatabaseService(dbPath);
    svc.initialize();
    const raw = svc.getDb();
    seedProject(raw);
    raw
      .prepare("INSERT INTO tracker_connections (id, project_id, provider) VALUES ('c1', 1, 'dart')")
      .run();
    raw.pragma('ignore_check_constraints = ON');
    raw.prepare("UPDATE tracker_connections SET status_sync_mode = 'off' WHERE id = 'c1'").run();
    raw.pragma('ignore_check_constraints = OFF');
    raw.close();

    wipeLedger(dbPath);

    // Hold the failing service so its handle can be closed: initialize()
    // opens the file BEFORE the chain runs, and the throw leaves it open.
    // Windows locks open files, so afterEach's rmSync would fail with EBUSY.
    const replay = new DatabaseService(dbPath);
    try {
      expect(() => replay.initialize()).toThrow(/CHECK constraint failed: status_sync_mode/);
    } finally {
      replay.close();
    }
  });

  it('is convergent on a ledger-wiped replay', () => {
    const svc = new DatabaseService(dbPath);
    svc.initialize();
    const raw = svc.getDb();
    seedProject(raw);
    raw
      .prepare(
        `INSERT INTO tracker_connections (id, project_id, provider, status_sync_mode, status_sync_enabled)
         VALUES ('c1', 1, 'dart', 'manual', 0)`,
      )
      .run();
    raw.close();

    wipeLedger(dbPath);

    const replayed = new DatabaseService(dbPath);
    expect(() => replayed.initialize()).not.toThrow();
    const raw2 = replayed.getDb();

    // The column and the ROW survive; the VALUE resets to the DEFAULT, because
    // 105/129's recreates run first from column lists that predate it. Same
    // documented, accepted degradation as push_target / content_sync_mode /
    // config_generation — a setting resets, nothing fails to boot. The cadence
    // it was holding DOES survive, since status_sync_mode predates 105.
    expect(
      raw2
        .prepare(
          "SELECT status_sync_mode, status_sync_enabled FROM tracker_connections WHERE id = 'c1'",
        )
        .get(),
    ).toEqual({ status_sync_mode: 'manual', status_sync_enabled: 1 });
    raw2.close();
  });
});
