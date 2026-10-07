/**
 * CloudAccountStore — the SOLE writer of the `cloud_account` table (migration 150).
 *
 * One row (id fixed to 1): the device registration of this data dir. The service is the store's only
 * caller. Every statement is a single statement, so no transaction is needed; writes are synchronous.
 * Timestamps are ISO-8601 UTC text passed in by the caller (one shape per column).
 */
import type { DatabaseLike, LoggerLike } from '../../orchestrator/types';
import {
  CLOUD_ACCOUNT_STATES,
  DEVICE_CODE_RE,
} from '../../../../shared/types/cloudAccountWire';
import type { CloudAccountState } from '../../../../shared/types/cloudAccountWire';

export interface CloudAccountRow {
  origin: string;
  accountId: string;
  deviceId: string;
  deviceName: string;
  deviceCode: string;
  displayLogin: string | null;
  entitlements: string[];
  scopes: string[];
  tokenCiphertext: Buffer;
  state: CloudAccountState;
  createdAt: string;
  updatedAt: string;
  lastOkAt: string | null;
}

export type NewCloudAccountRow = Omit<CloudAccountRow, 'updatedAt'>;

interface RawRow {
  origin: string;
  account_id: string;
  device_id: string;
  device_name: string;
  device_code: string;
  display_login: string | null;
  entitlements_json: string;
  scopes: string;
  token_ciphertext: unknown;
  state: string;
  created_at: string;
  updated_at: string;
  last_ok_at: string | null;
}

function parseEntitlements(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (Array.isArray(parsed) && parsed.every((e): e is string => typeof e === 'string')) return parsed;
  } catch {
    // fall through
  }
  return [];
}

export class CloudAccountStore {
  constructor(
    private readonly db: DatabaseLike,
    private readonly logger?: Pick<LoggerLike, 'warn'>,
  ) {}

  /**
   * SELECT … WHERE id = 1, validated on the way out: an unknown state reads as 'revoked'; a device code
   * failing DEVICE_CODE_RE or a ciphertext that is not a byte buffer reads as 'undecryptable';
   * entitlements_json that is not a string[] reads as [].
   */
  read(): CloudAccountRow | null {
    const raw = this.db.prepare('SELECT * FROM cloud_account WHERE id = 1').get() as RawRow | undefined;
    if (!raw) return null;

    let state: CloudAccountState;
    if ((CLOUD_ACCOUNT_STATES as readonly string[]).includes(raw.state)) {
      state = raw.state as CloudAccountState;
    } else {
      this.logger?.warn('[cloud] stored account has an unknown state; treating it as revoked');
      state = 'revoked';
    }

    const cipher = raw.token_ciphertext;
    let tokenCiphertext: Buffer;
    if (Buffer.isBuffer(cipher)) {
      tokenCiphertext = cipher;
    } else if (cipher instanceof Uint8Array) {
      tokenCiphertext = Buffer.from(cipher);
    } else {
      tokenCiphertext = Buffer.alloc(0);
      if (state !== 'revoked') state = 'undecryptable';
    }
    if (!DEVICE_CODE_RE.test(raw.device_code)) {
      this.logger?.warn('[cloud] stored account has an invalid device code; treating it as unreadable');
      if (state !== 'revoked') state = 'undecryptable';
    }

    return {
      origin: raw.origin,
      accountId: raw.account_id,
      deviceId: raw.device_id,
      deviceName: raw.device_name,
      deviceCode: raw.device_code,
      displayLogin: raw.display_login,
      entitlements: parseEntitlements(raw.entitlements_json),
      scopes: raw.scopes.split(/\s+/).filter((s) => s !== ''),
      tokenCiphertext,
      state,
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
      lastOkAt: raw.last_ok_at,
    };
  }

  /** INSERT … ON CONFLICT(id) DO UPDATE of every column; updated_at = createdAt. */
  upsert(row: NewCloudAccountRow): void {
    this.db
      .prepare(
        `INSERT INTO cloud_account
           (id, origin, account_id, device_id, device_name, device_code, display_login, entitlements_json,
            scopes, token_ciphertext, state, created_at, updated_at, last_ok_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           origin = excluded.origin,
           account_id = excluded.account_id,
           device_id = excluded.device_id,
           device_name = excluded.device_name,
           device_code = excluded.device_code,
           display_login = excluded.display_login,
           entitlements_json = excluded.entitlements_json,
           scopes = excluded.scopes,
           token_ciphertext = excluded.token_ciphertext,
           state = excluded.state,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at,
           last_ok_at = excluded.last_ok_at`,
      )
      .run(
        row.origin,
        row.accountId,
        row.deviceId,
        row.deviceName,
        row.deviceCode,
        row.displayLogin,
        JSON.stringify(row.entitlements),
        row.scopes.join(' '),
        row.tokenCiphertext,
        row.state,
        row.createdAt,
        row.createdAt,
        row.lastOkAt,
      );
  }

  /** Returns true when the row existed. */
  setState(state: CloudAccountState, nowIso: string): boolean {
    const res = this.db
      .prepare('UPDATE cloud_account SET state = ?, updated_at = ? WHERE id = 1')
      .run(state, nowIso);
    return res.changes === 1;
  }

  /** Records a successful GET /v1/account and returns the row to state 'ok'. */
  recordAccountOk(input: { displayLogin: string | null; entitlements: string[]; nowIso: string }): boolean {
    const res = this.db
      .prepare(
        `UPDATE cloud_account
            SET display_login = ?, entitlements_json = ?, last_ok_at = ?, updated_at = ?, state = 'ok'
          WHERE id = 1`,
      )
      .run(input.displayLogin, JSON.stringify(input.entitlements), input.nowIso, input.nowIso);
    return res.changes === 1;
  }

  clear(): void {
    this.db.prepare('DELETE FROM cloud_account WHERE id = 1').run();
  }
}
