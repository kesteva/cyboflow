-- Migration 142: admit the 'start-quick-session' proposal kind on
-- agent_proposals.kind (TASK-295).
--
-- WHY. The global assistant could navigate to an EXISTING quick session
-- (open-session) but had no proposal shape that started one, so "open a quick
-- session on this project and have it look at these five findings" ended as
-- prose the human had to act on by hand. The new kind records a project, an
-- opening brief and the session options; on confirm the executor mints the
-- session through the EXISTING createQuickSessionCore path the launch wizard
-- uses and delivers the brief as its first prompt, stamped actor:'user' by
-- the human's click exactly like every other proposal kind.
--
-- Same full-recreate recipe as 125 / 138 / 141 (kind is TEXT NOT NULL with no
-- default, so the shadow-column recipe would have to invent a DEFAULT the
-- column never had), with the same load-bearing foreign_keys=OFF marker:
-- widget_action_log (133) FKs INTO agent_proposals ON DELETE CASCADE, and a
-- DROP TABLE evaluated with enforcement on would cascade-delete every
-- widget-action audit row. The rename restores the referenced table name.

-- The runner detects this marker and wraps every statement in an explicit
-- transaction with foreign keys disabled — required so the DROP TABLE below
-- is evaluated with FK enforcement off, exactly as 123, 125, 138 and 141 do.
PRAGMA foreign_keys=OFF;

CREATE TABLE agent_proposals_new (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN
    ('launch-run','reprioritize-backlog','edit-workflow','open-session','create-backlog-items','create-workflow','triage-findings','start-quick-session')),
  payload_json TEXT NOT NULL,
  preconditions_json TEXT,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN
    ('proposed','executing','executed','failed','dismissed','superseded')),
  result_json TEXT,
  idempotency_key TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  decided_at DATETIME
);

INSERT INTO agent_proposals_new (id, thread_id, kind, payload_json, preconditions_json,
                                 status, result_json, idempotency_key, created_at, decided_at)
  SELECT id, thread_id, kind, payload_json, preconditions_json,
         status, result_json, idempotency_key, created_at, decided_at
  FROM agent_proposals;

DROP TABLE agent_proposals;
ALTER TABLE agent_proposals_new RENAME TO agent_proposals;

PRAGMA foreign_keys=ON;
