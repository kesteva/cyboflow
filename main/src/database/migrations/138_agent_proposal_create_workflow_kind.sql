-- Migration 138: admit the 'create-workflow' proposal kind on
-- agent_proposals.kind.
--
-- WHY. The global assistant could EDIT a workflow (the 'edit-workflow' kind)
-- but had no proposal shape for CREATING one, so "make me a docs-review flow
-- with its own agent" dead-ended at the promptable contract. The new kind
-- records a custom flow definition plus the custom agents its steps bind to;
-- on confirm the executor mints the agents through AgentOverrideRouter and
-- the flow through WorkflowRegistry.createCustom, stamped by the human's
-- click exactly like every other proposal kind.
--
-- Same full-recreate recipe as 125 (kind is TEXT NOT NULL with no default, so
-- the shadow-column recipe would have to invent a DEFAULT the column never
-- had). One thing changed since 125: migration 133 added widget_action_log,
-- which FKs INTO agent_proposals (ON DELETE CASCADE). That is exactly why the
-- foreign_keys=OFF marker below is load-bearing here — with enforcement on,
-- DROP TABLE would cascade-delete every widget-action audit row. The rename
-- restores the referenced table name, so the FK resolves again afterwards.

-- The runner detects this marker and wraps every statement in an explicit
-- transaction with foreign keys disabled — required so the DROP TABLE below
-- is evaluated with FK enforcement off, exactly as 123 and 125 do.
PRAGMA foreign_keys=OFF;

CREATE TABLE agent_proposals_new (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN
    ('launch-run','reprioritize-backlog','edit-workflow','open-session','create-backlog-items','create-workflow')),
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
