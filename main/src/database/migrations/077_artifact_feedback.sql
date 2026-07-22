-- Migration 077: in-artifact feedback on spec/architecture documents (IDEA-033).
--
-- Users highlight sections of the idea-spec / arch-design artifact tabs while a
-- planner/ship run is parked at a human gate, save comments, and "send" the
-- batch — a host-driven scoped revision agent rewrites the idea body through
-- TaskChangeRouter while the gate stays open. Two tables:
--
--  - feedback_batches: one row per "Send feedback" click — the durable
--    "changes requested" record (round counter per document) that flow
--    performance tracking / Insights reads. `status` tracks the revision
--    outcome (pending → applied | failed).
--  - feedback_comments: the individual highlight+comment records. Drafts
--    (batch_id NULL) are editable; sending stamps batch_id + status='sent';
--    a landed revision flips them to 'addressed' (consumed — comments are
--    per-round, not threaded).
--
-- Content identity mirrors the per-entity artifact identity (migration 073):
-- (run_id, atype, source_ref) where source_ref is the owning idea id — the
-- documents themselves live on ideas.body (templated artifacts re-derive), so
-- comments anchor by quoted excerpt + occurrence + a hash of the body version
-- they were made against (anchor_json), NOT by artifact payload.
--
-- Timestamps are writer-supplied ISO strings (FeedbackRouter), matching the
-- other chokepoint tables; DEFAULT CURRENT_TIMESTAMP is only a safety net.

CREATE TABLE IF NOT EXISTS feedback_batches (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  atype TEXT NOT NULL CHECK (atype IN ('idea-spec','arch-design')),
  -- Owning idea id (matches artifacts.source_ref for the per-entity atypes).
  source_ref TEXT NOT NULL,
  -- 1-based revision round per (run_id, atype, source_ref).
  round INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','failed')),
  -- Human-readable failure detail when status='failed' (revision agent error,
  -- validation refusal). Never raw stack traces.
  error TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  applied_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_feedback_batches_doc
  ON feedback_batches (run_id, atype, source_ref);

CREATE TABLE IF NOT EXISTS feedback_comments (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  atype TEXT NOT NULL CHECK (atype IN ('idea-spec','arch-design')),
  source_ref TEXT NOT NULL,
  -- NULL while draft; stamped by send-batch. ON DELETE SET NULL keeps the
  -- comment record if a batch row is ever pruned.
  batch_id TEXT REFERENCES feedback_batches(id) ON DELETE SET NULL,
  -- CommentAnchor JSON: { quote, occurrence, bodyHash } — see shared/types/feedback.ts.
  anchor_json TEXT NOT NULL,
  -- The comment text the user typed.
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','addressed')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  sent_at DATETIME,
  addressed_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_feedback_comments_doc
  ON feedback_comments (run_id, atype, source_ref, status);
