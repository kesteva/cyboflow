import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseLike } from '../../../orchestrator/types';
import { CloudAccountStore } from '../cloudAccountStore';
import type { NewCloudAccountRow } from '../cloudAccountStore';

const SQL = readFileSync(join(__dirname, '..', '..', '..', 'database', 'migrations', '150_cloud_account.sql'), 'utf-8');

function sample(over: Partial<NewCloudAccountRow> = {}): NewCloudAccountRow {
  return {
    origin: 'https://cloud-staging.cyboflow.com',
    accountId: 'acc_1',
    deviceId: 'dev_1',
    deviceName: 'Test Mac',
    deviceCode: 'ABC',
    displayLogin: null,
    entitlements: [],
    scopes: ['bridge', 'sync'],
    tokenCiphertext: Buffer.from([1, 2, 3, 4]),
    state: 'ok',
    createdAt: '2026-10-07T10:00:00.000Z',
    lastOkAt: null,
    ...over,
  };
}

describe('CloudAccountStore', () => {
  let db: Database.Database;
  let store: CloudAccountStore;
  const warn = vi.fn();

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SQL);
    store = new CloudAccountStore(db as unknown as DatabaseLike, { warn });
    warn.mockClear();
  });
  afterEach(() => db.close());

  it('read() is null on an empty table', () => {
    expect(store.read()).toBeNull();
  });

  it('upsert/read round-trips including the BLOB as a Buffer', () => {
    store.upsert(sample({ displayLogin: 'octocat', entitlements: ['bridge'], lastOkAt: '2026-10-07T10:05:00.000Z' }));
    const row = store.read();
    expect(row).not.toBeNull();
    expect(Buffer.isBuffer(row?.tokenCiphertext)).toBe(true);
    expect([...(row?.tokenCiphertext ?? [])]).toEqual([1, 2, 3, 4]);
    expect(row).toMatchObject({
      origin: 'https://cloud-staging.cyboflow.com',
      accountId: 'acc_1',
      deviceId: 'dev_1',
      deviceName: 'Test Mac',
      deviceCode: 'ABC',
      displayLogin: 'octocat',
      entitlements: ['bridge'],
      scopes: ['bridge', 'sync'],
      state: 'ok',
      createdAt: '2026-10-07T10:00:00.000Z',
      updatedAt: '2026-10-07T10:00:00.000Z',
      lastOkAt: '2026-10-07T10:05:00.000Z',
    });
  });

  it('upserting twice keeps one row with id 1', () => {
    store.upsert(sample());
    store.upsert(sample({ deviceId: 'dev_2', createdAt: '2026-10-08T00:00:00.000Z' }));
    const count = db.prepare('SELECT COUNT(*) AS n, MIN(id) AS id FROM cloud_account').get() as { n: number; id: number };
    expect(count).toEqual({ n: 1, id: 1 });
    expect(store.read()?.deviceId).toBe('dev_2');
  });

  it('setState changes the state and reports whether a row existed', () => {
    expect(store.setState('revoked', '2026-10-07T11:00:00.000Z')).toBe(false);
    store.upsert(sample());
    expect(store.setState('revoked', '2026-10-07T11:00:00.000Z')).toBe(true);
    expect(store.read()).toMatchObject({ state: 'revoked', updatedAt: '2026-10-07T11:00:00.000Z' });
  });

  it('recordAccountOk updates the account fields and returns the row to ok', () => {
    store.upsert(sample({ state: 'needs_update' }));
    expect(
      store.recordAccountOk({ displayLogin: 'octocat', entitlements: ['bridge'], nowIso: '2026-10-07T12:00:00.000Z' }),
    ).toBe(true);
    expect(store.read()).toMatchObject({
      state: 'ok',
      displayLogin: 'octocat',
      entitlements: ['bridge'],
      lastOkAt: '2026-10-07T12:00:00.000Z',
    });
  });

  it('clear removes the row', () => {
    store.upsert(sample());
    store.clear();
    expect(store.read()).toBeNull();
  });

  it('an unknown stored state reads as revoked', () => {
    store.upsert(sample());
    db.prepare("UPDATE cloud_account SET state = 'weird'").run();
    expect(store.read()?.state).toBe('revoked');
    expect(warn).toHaveBeenCalled();
  });

  it('an invalid device code reads as undecryptable', () => {
    store.upsert(sample());
    db.prepare("UPDATE cloud_account SET device_code = 'ab1'").run();
    expect(store.read()?.state).toBe('undecryptable');
  });

  it('a non-buffer ciphertext reads as undecryptable', () => {
    store.upsert(sample());
    db.prepare("UPDATE cloud_account SET token_ciphertext = 'text'").run();
    expect(store.read()?.state).toBe('undecryptable');
  });

  it('malformed entitlements_json reads as an empty list', () => {
    store.upsert(sample());
    db.prepare("UPDATE cloud_account SET entitlements_json = '{not json'").run();
    expect(store.read()?.entitlements).toEqual([]);
    db.prepare("UPDATE cloud_account SET entitlements_json = '[1,2]'").run();
    expect(store.read()?.entitlements).toEqual([]);
  });
});
