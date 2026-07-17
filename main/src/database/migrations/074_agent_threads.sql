-- Migration 074: global-agent chat thread persistence.
--
-- The global agent is a standing SDK-hosted chat thread that lives OUTSIDE
-- the project/run model entirely — there is no workflow_runs sentinel row
-- backing it, so these three tables are self-contained (no FK out to
-- workflow_runs/projects). `agent_thread_events` mirrors raw_events' shape
-- (append-only, thread-keyed) but is a separate table since the thread has
-- no run_id. `agent_proposals` are the promptable-action cards the agent
-- offers the user; `status` is a CAS state machine (guarded UPDATEs) so a
-- double-confirm race has exactly one winner.

CREATE TABLE IF NOT EXISTS agent_threads (
  id TEXT PRIMARY KEY,
  -- 'global' today; Stage 3 widens this to 'run:<runId>' for run-scoped agents.
  scope TEXT NOT NULL DEFAULT 'global',
  model TEXT,
  -- Persisted warm-resume target for the SDK substrate's --resume continuation.
  claude_session_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS agent_thread_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_agent_thread_events_thread
  ON agent_thread_events (thread_id, id);
CREATE TABLE IF NOT EXISTS agent_proposals (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN
    ('launch-run','reprioritize-backlog','edit-workflow','open-session')),
  payload_json TEXT NOT NULL,
  -- Per-kind CAS material (e.g. workflow spec hash, task expectedVersions)
  -- checked at claim time so a stale proposal can't clobber newer state.
  preconditions_json TEXT,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN
    ('proposed','executing','executed','failed','dismissed','superseded')),
  result_json TEXT,
  -- Stamped at CAS-claim time (claimProposal) so a retried executor call is
  -- idempotent against the same claimed attempt.
  idempotency_key TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  decided_at DATETIME
);
