-- Migration 150: cyboflow cloud account (one device registration for this data dir).
--
-- ONE row (id = 1, enforced in code by CloudAccountStore). The row binds a device token to the
-- origin that issued it; the token is only ever sent back to that origin. token_ciphertext is
-- Electron safeStorage ciphertext (OS keychain bound): a copied or restored database cannot
-- decrypt it on another machine, which the app surfaces as state 'undecryptable'.
--
-- state is code-validated, no CHECK (migration-123/130 lesson): 'ok' | 'revoked' |
-- 'needs_update' | 'undecryptable'. device_code is validated in code (^[A-Z]{3}$).
-- Timestamps are ISO-8601 UTC text written by formatForDatabase() (one shape per column).
--
-- Not mirrored into schema.sql: new tables reach both parity paths through the migration alone
-- (the dual-source rule covers column changes to tables schema.sql already declares).
-- IF NOT EXISTS because the ledger tracks by filename: a renumbered file re-applies wholesale.
--
-- Numbered 150: 149 is reserved by the unmerged remote-sync branch. Renumber at merge if taken.

CREATE TABLE IF NOT EXISTS cloud_account (
  id                INTEGER PRIMARY KEY,
  origin            TEXT    NOT NULL,
  account_id        TEXT    NOT NULL,
  device_id         TEXT    NOT NULL,
  device_name       TEXT    NOT NULL,
  device_code       TEXT    NOT NULL,
  display_login     TEXT,
  entitlements_json TEXT    NOT NULL DEFAULT '[]',
  scopes            TEXT    NOT NULL DEFAULT '',
  token_ciphertext  BLOB    NOT NULL,
  state             TEXT    NOT NULL DEFAULT 'ok',
  created_at        TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL,
  last_ok_at        TEXT
);
