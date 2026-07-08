-- Migration 050: sessions.agent_model.
--
-- Provider-scoped session default model. NULL means "runtime default".

ALTER TABLE sessions ADD COLUMN agent_model TEXT;

