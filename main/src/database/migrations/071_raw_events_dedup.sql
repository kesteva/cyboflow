-- Migration 071: stable identity for replaceable synthetic raw events.
-- 070 is already occupied by agent_override_runtime.

ALTER TABLE raw_events ADD COLUMN dedup_key TEXT;

CREATE UNIQUE INDEX idx_raw_events_dedup
  ON raw_events(dedup_key)
  WHERE dedup_key IS NOT NULL;
