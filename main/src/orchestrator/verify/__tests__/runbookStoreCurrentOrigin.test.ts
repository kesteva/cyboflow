/**
 * `VerifyRunbookStore.getCurrent` carries migration 107's `origin`
 * (docs/proposals/runbook-optional-verification.md §A1.3): an explore request
 * records its lever source as `{ hash, status, origin }`, so the record's
 * origin has to come back with it — and a DB that predates 107 must still hand
 * back the RECORD, with `origin: null`, rather than losing it over a badge.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { VerifyRunbookStore } from '../runbookStore';
import type { VerifyRunbookV1 } from '../../../../../shared/types/verifyRunbook';

const RUNBOOK: VerifyRunbookV1 = {
  version: 1,
  modalities: {
    web: {
      serve: { cmd: 'pnpm dev --port ${PORT}' },
      attestation: { kind: 'http-endpoint', urlPath: '/__cyboflow_verify__' },
    },
  },
  levers: { dataDirEnv: 'CYBOFLOW_DIR' },
};

/** Migration 096's table, optionally with 107's `origin` column. */
function buildDb(withOrigin: boolean): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE verify_runbook_local (
      project_id INTEGER NOT NULL,
      modality TEXT NOT NULL,
      portable_hash TEXT NOT NULL,
      portable_json TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL CHECK (status IN ('proven','unproven-draft')),
      bindings_json TEXT,
      proof_json TEXT,
      input_hash TEXT,
      host_fingerprint_json TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (project_id, modality)
    );
  `);
  if (withOrigin) db.exec('ALTER TABLE verify_runbook_local ADD COLUMN origin TEXT');
  db.prepare(
    `INSERT INTO verify_runbook_local (project_id, modality, portable_hash, portable_json, version, status)
     VALUES (1, 'web', ?, ?, 4, 'unproven-draft')`,
  ).run('h'.repeat(64), JSON.stringify(RUNBOOK));
  return db;
}

function store(db: Database.Database): VerifyRunbookStore {
  return new VerifyRunbookStore(db, {
    readPortableFile: async () => null,
    computeInputHash: async () => null,
    hostFingerprint: async () => 'host',
  });
}

describe('VerifyRunbookStore.getCurrent — origin', () => {
  it('returns the stamped origin alongside the record', () => {
    const db = buildDb(true);
    const s = store(db);
    s.setOrigin(1, 'web', 'lane-bootstrap');

    expect(s.getCurrent(1, 'web')).toEqual({
      runbook: RUNBOOK,
      version: 4,
      status: 'unproven-draft',
      hash: 'h'.repeat(64),
      origin: 'lane-bootstrap',
    });
    db.close();
  });

  it('an unstamped record reads origin null', () => {
    const db = buildDb(true);
    expect(store(db).getCurrent(1, 'web')?.origin).toBeNull();
    db.close();
  });

  it('a pre-107 DB (no origin column) still returns the record, origin null', () => {
    const db = buildDb(false);
    const current = store(db).getCurrent(1, 'web');
    expect(current).toMatchObject({ hash: 'h'.repeat(64), status: 'unproven-draft', version: 4, origin: null });
    expect(current?.runbook.levers?.dataDirEnv).toBe('CYBOFLOW_DIR');
    db.close();
  });
});
