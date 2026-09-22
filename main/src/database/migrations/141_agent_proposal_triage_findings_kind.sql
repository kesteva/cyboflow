-- Migration 141: admit the 'triage-findings' proposal kind on
-- agent_proposals.kind (TASK-292).
--
-- WHY. The global assistant could LIST the review queue but had no proposal
-- shape that touched review_items, so a 456-finding inbox could be triaged in
-- prose and then had to be clicked through by hand. The new kind records a
-- batch of dismiss / resolve / approve / set-selected ops over finding ids;
-- on confirm the executor fans them out through the EXISTING
-- ReviewItemRouter.applyReviewItem chokepoint, stamped actor:'user' by the
-- human's click exactly like every other proposal kind.
--
-- Same full-recreate recipe as 125 and 138 (kind is TEXT NOT NULL with no
-- default, so the shadow-column recipe would have to invent a DEFAULT the
-- column never had), with the same load-bearing foreign_keys=OFF marker:
-- widget_action_log (133) FKs INTO agent_proposals ON DELETE CASCADE, and a
-- DROP TABLE evaluated with enforcement on would cascade-delete every
-- widget-action audit row. The rename restores the referenced table name.

-- The runner detects this marker and wraps every statement in an explicit
-- transaction with foreign keys disabled — required so the DROP TABLE below
-- is evaluated with FK enforcement off, exactly as 123, 125 and 138 do.
PRAGMA foreign_keys=OFF;

CREATE TABLE agent_proposals_new (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN
    ('launch-run','reprioritize-backlog','edit-workflow','open-session','create-backlog-items','create-workflow','triage-findings')),
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
