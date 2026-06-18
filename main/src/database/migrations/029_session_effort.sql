-- Migration 029: Add nullable effort to sessions for the read-only effort pill
-- shown in the unified chat composer (session config, set at session start).
--
-- The only value today is 'ultracode' (the Session Start Wizard "Ultracode"
-- card), which pins the substrate to 'interactive' and launches the PTY REPL
-- with the ultracode setting. Stamped by sessions:create-quick alongside
-- sessions.substrate (migration 027). NULL means "no effort" (the default /
-- byte-identical behavior to before this column existed). Validation happens at
-- the write chokepoint (request.effort === 'ultracode') — no CHECK constraint,
-- mirroring the nullable ALTER pattern of migrations 021 (agent_permission_mode)
-- and 027 (substrate).
--
-- NOTE: runFileBasedMigrations() in database.ts wraps every file in a
-- this.transaction(...) call, so no explicit BEGIN/COMMIT here. 029 follows
-- 028_idea_attachments on this branch. schema.sql is intentionally NOT updated
-- (sessions is a legacy schema.sql table excluded from the parity diff — the
-- migrations-only path cannot create it; same handling as substrate).

ALTER TABLE sessions ADD COLUMN effort TEXT;
