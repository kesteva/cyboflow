-- Migration 076: persist the global-agent auto-digest timestamp.
--
-- The auto-digest (the "where is everything" turn fired when the assistant
-- rail first has a thread) was throttled only by an in-memory map that reset
-- on every app restart, so it re-fired on every launch. This column persists
-- the last auto-digest time (epoch milliseconds) so the throttle can span a
-- full day across restarts. NULL = never auto-digested. User-initiated turns
-- (chip clicks, typed messages) never touch this column and are never gated.
ALTER TABLE agent_threads ADD COLUMN last_digest_at INTEGER;
