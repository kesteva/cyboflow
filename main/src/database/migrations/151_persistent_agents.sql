-- Migration 151: persistent agents — the vendor-neutral core of Agents & Environments.
--
-- vendor_credentials           user vendor keys (safeStorage ciphertext only; plaintext never reaches sqlite)
-- persistent_agents            one row per agent: identity, handle = the cf/<handle>/ branch prefix
-- persistent_agent_connections the replaceable link (native | bridge); ONE current per agent
--                              (idx_pac_current); a swap's new row is inserted is_current=0 and flipped in
--                              the activating transaction, old row first (the unique index is checked per
--                              statement)
-- persistent_agent_messages    the thread + the outbox (send_state on outbound rows)
-- persistent_agent_events      native activity + core bookkeeping; pruned after 30 days
-- persistent_agent_usage       one cumulative snapshot per (connection, remote scope); replaced, never added
--
-- Every write goes through PersistentAgentStore (orchestrator/persistentAgents/persistentAgentStore.ts).
-- Enums are code-validated: NO CHECK constraints (migration-123 lesson). Timestamps are ISO-8601 text
-- written by the app (Date#toISOString) — there are deliberately NO datetime('now') defaults, because the
-- outbox compares next_attempt_at as text and the two shapes do not sort together.
--
-- Not mirrored into schema.sql: new tables reach both parity paths through the migration alone.
-- IF NOT EXISTS everywhere because the ledger tracks by filename — a renumbered file re-applies wholesale.
-- Numbered 151: 149 is muted-field's remote sync, 150 is the cloud account. Re-check at merge.

CREATE TABLE IF NOT EXISTS vendor_credentials (
  id                TEXT PRIMARY KEY,
  vendor            TEXT NOT NULL,                -- anthropic | github-pat
  label             TEXT NOT NULL,
  secret_ciphertext BLOB NOT NULL,                -- services/secrets/safeStorageSecret.ts output
  fingerprint       TEXT NOT NULL,                -- '…' || last4 || ' · ' || sha256(secret) hex[0..8]
  state             TEXT NOT NULL DEFAULT 'ok',   -- ok | auth_failed | revoked | undecryptable
  version           INTEGER NOT NULL DEFAULT 1,   -- bumped by rotate; keys connector client caches
  last_error        TEXT,
  last_verified_at  TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS persistent_agents (
  id           TEXT PRIMARY KEY,
  handle       TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  vendor       TEXT NOT NULL,                     -- anthropic-cma | openai-dots | meta-muse | other
  github_login TEXT,
  archived_at  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS persistent_agent_connections (
  id                      TEXT PRIMARY KEY,
  agent_id                TEXT NOT NULL REFERENCES persistent_agents(id) ON DELETE CASCADE,
  kind                    TEXT NOT NULL,          -- native | bridge
  connector_id            TEXT NOT NULL,
  connector_version       INTEGER NOT NULL,
  transport               TEXT,                   -- relay-mcp | relay-http | poll | stream
  state                   TEXT NOT NULL,          -- pending | verified | stale | auth_failed | revoked
  credential_id           TEXT REFERENCES vendor_credentials(id) ON DELETE SET NULL,
  remote_id               TEXT,                   -- connector's primary remote id (Bridge: relay connectionId)
  remote_json             TEXT,                   -- connector-specific, NON-SECRET: {remoteId, transport, mcpUrl, httpBase, label, pairedClient?}
  inbound_cursor          TEXT,                   -- opaque, connector-owned
  relay_epoch             INTEGER,                -- cursor epoch (Bridge); opaque, equality only
  capabilities_json       TEXT NOT NULL,          -- ConnectionCapabilitiesSnapshot
  verify_json             TEXT,                   -- VerifyFact[]
  is_current              INTEGER NOT NULL DEFAULT 0,
  generation              INTEGER NOT NULL DEFAULT 1,  -- bumped by swap fencing; claims carry it
  connect_state           TEXT,                   -- 'creating_remote' while the remote create is outstanding
  swap_state              TEXT,                   -- on the NEW row only: connecting|awaiting_verify|fencing|reconciling|revoking_remote|activating
  swap_from_connection_id TEXT,                   -- on the NEW row: the connection it replaces (kept as history)
  swap_started_at         TEXT,
  swap_error              TEXT,                   -- why the last swap from/into this row aborted
  remote_revoke_state     TEXT,                   -- pending | done | gave_up
  remote_revoke_attempts  INTEGER NOT NULL DEFAULT 0,
  remote_revoke_next_at   TEXT,
  remote_revoke_error     TEXT,
  remote_status_json      TEXT,                   -- {status: RemoteStatus, at}
  rate_limited_until      TEXT,
  auth_retry_at           TEXT,                   -- an auth_failed row is pulled ONCE when this is due (after rotate)
  error_kind              TEXT,                   -- last ConnectorError kind / 'undecryptable'
  last_error              TEXT,
  last_seen_at            TEXT,
  verified_at             TEXT,
  replaced_at             TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pac_current
  ON persistent_agent_connections(agent_id) WHERE is_current = 1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pac_one_swap
  ON persistent_agent_connections(agent_id) WHERE swap_state IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pac_remote
  ON persistent_agent_connections(connector_id, remote_id) WHERE remote_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pac_agent
  ON persistent_agent_connections(agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_pac_revoke
  ON persistent_agent_connections(remote_revoke_state, remote_revoke_next_at);

CREATE TABLE IF NOT EXISTS persistent_agent_messages (
  id                    TEXT PRIMARY KEY,         -- randomUUID(); also the Bridge envelope id
  agent_id              TEXT NOT NULL REFERENCES persistent_agents(id) ON DELETE CASCADE,
  connection_id         TEXT REFERENCES persistent_agent_connections(id),
  direction             TEXT NOT NULL,            -- in | out | local
  author                TEXT NOT NULL,            -- user | agent | relay | local
  kind                  TEXT NOT NULL,            -- text | brief | delivery_report | system
  body                  TEXT NOT NULL,
  links_json            TEXT,                     -- string[] (validated)
  delivery_json         TEXT,                     -- {prUrl, summary?, briefId?} on delivery_report
  attachments_json      TEXT,                     -- unused in v1
  brief_entity_type     TEXT,                     -- reserved
  brief_entity_id       TEXT,                     -- reserved
  remote_ref            TEXT,                     -- reserved: vendor task/session a structured brief created
  relay_seq             INTEGER,                  -- inbound relay seq
  relay_epoch           INTEGER,
  remote_out_seq        INTEGER,                  -- relay seq the relay assigned to OUR outbound envelope
  remote_event_id       TEXT,                     -- vendor/relay event id (inbound) or receipt id (outbound)
  remote_created_at     TEXT,
  is_probe              INTEGER NOT NULL DEFAULT 0,
  send_state            TEXT,                     -- outbound only (SendState)
  send_attempts         INTEGER NOT NULL DEFAULT 0,
  reconcile_attempts    INTEGER NOT NULL DEFAULT 0,
  next_attempt_at       TEXT,
  last_error            TEXT,
  content_hash          TEXT,                     -- sha256 hex of kind \n body \n links joined by \n
  claim_generation      INTEGER,                  -- connection generation that claimed it
  sent_at               TEXT,
  picked_up_at          TEXT,
  remote_ack            TEXT,                     -- acked | declined
  remote_ack_at         TEXT,
  read_at               TEXT,
  client_correlation_id TEXT,                     -- reserved
  intent_id             TEXT,                     -- reserved (no FK: task_brief_intents does not exist yet)
  assignment_generation INTEGER,                  -- reserved
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pam_remote
  ON persistent_agent_messages(connection_id, direction, remote_event_id) WHERE remote_event_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pam_seq
  ON persistent_agent_messages(connection_id, direction, relay_epoch, relay_seq) WHERE relay_seq IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pam_intent
  ON persistent_agent_messages(intent_id) WHERE intent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pam_thread
  ON persistent_agent_messages(agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_pam_outbox
  ON persistent_agent_messages(agent_id, send_state, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_pam_conn_state
  ON persistent_agent_messages(connection_id, send_state);
CREATE INDEX IF NOT EXISTS idx_pam_unread
  ON persistent_agent_messages(agent_id) WHERE direction = 'in' AND read_at IS NULL;

CREATE TABLE IF NOT EXISTS persistent_agent_events (
  id              TEXT PRIMARY KEY,
  agent_id        TEXT NOT NULL REFERENCES persistent_agents(id) ON DELETE CASCADE,
  connection_id   TEXT NOT NULL REFERENCES persistent_agent_connections(id) ON DELETE CASCADE,
  remote_event_id TEXT NOT NULL,
  remote_scope    TEXT,
  type            TEXT NOT NULL,                  -- ActivityType
  summary         TEXT,                           -- ≤ 500 chars
  payload_json    TEXT,                           -- ≤ 16 KiB (truncated envelope when larger)
  occurred_at     TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  UNIQUE (connection_id, remote_event_id)
);
CREATE INDEX IF NOT EXISTS idx_pae_agent ON persistent_agent_events(agent_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_pae_created ON persistent_agent_events(created_at);

CREATE TABLE IF NOT EXISTS persistent_agent_usage (
  connection_id         TEXT NOT NULL REFERENCES persistent_agent_connections(id) ON DELETE CASCADE,
  remote_scope          TEXT NOT NULL,
  agent_id              TEXT NOT NULL REFERENCES persistent_agents(id) ON DELETE CASCADE,
  input_tokens          INTEGER,
  output_tokens         INTEGER,
  cache_read_tokens     INTEGER,
  cache_creation_tokens INTEGER,
  cost_usd              REAL,
  active_seconds        INTEGER,
  coverage              TEXT NOT NULL,            -- complete | vendor-cumulative | partial
  computed_at           TEXT NOT NULL,
  PRIMARY KEY (connection_id, remote_scope)
);
CREATE INDEX IF NOT EXISTS idx_pau_agent ON persistent_agent_usage(agent_id);
