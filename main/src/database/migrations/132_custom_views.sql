-- Migration 132: Custom Views (docs/proposals/CUSTOM-VIEWS.md §3.2) — saved
-- per-surface widget layouts, the user's library of custom widgets, and an
-- audit/idempotency side table for widget-triggered proposals.
--
-- Design: three NEW tables rather than altering an existing one.
--   - `custom_views` / `custom_widgets` are new concepts with no existing
--     home; a saved view is a named `layout_json` for one of the two landing
--     surfaces (review-queue / project-overview), and a custom widget is a
--     user-owned `WidgetSpec` with a published/draft split (§7.3) so an
--     in-progress assistant edit never clobbers what every other surface
--     renders.
--   - `widget_action_log` exists ONLY so a widget-triggered proposal can be
--     told apart from an assistant-authored one, WITHOUT touching
--     `agent_proposals` itself. `agent_proposals` is recreated from a fixed,
--     hardcoded column list by migration 125 (and earlier recreates before
--     it) — see 125's own header and `docs/proposals/CUSTOM-VIEWS.md` §12
--     finding #10. An added column on `agent_proposals` would silently NOT
--     survive a ledger-wiped replay, because every recreate's column list
--     predates it. A side table keyed 1:1 on `proposal_id` sidesteps that
--     hazard entirely: `listProposals` excludes widget-originated rows with
--     `LEFT JOIN widget_action_log … WHERE widget_action_log.proposal_id IS
--     NULL` (§4.4), and `operation_id` gives every widget-action click an
--     idempotency key independent of the proposal id itself.
--
-- 131 is the latest landed prefix, so 132 is the next free one — re-check
-- before merge (AGENTS.md). Idempotent per statement: every DDL statement
-- uses `IF NOT EXISTS`, so a re-applied (or renumbered) file is a no-op.
CREATE TABLE IF NOT EXISTS custom_views (
  id TEXT PRIMARY KEY,
  surface TEXT NOT NULL CHECK (surface IN ('review-queue','project-overview')),
  name TEXT NOT NULL,
  layout_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_views_surface_name
  ON custom_views (surface, name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS custom_widgets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  published_spec_json TEXT,            -- NULL until first publish
  draft_spec_json TEXT,                -- NULL when no draft is pending
  authoring_session_id TEXT,           -- owner of draft_spec_json
  revision INTEGER NOT NULL DEFAULT 1,
  thread_id TEXT,                      -- soft link, no FK (threads may be reset)
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Widget-triggered actions reuse agent_proposals for the audit trail + executor, but
-- agent_proposals itself is NOT altered (migration 125 recreates it from a fixed
-- column list, so an added column would not survive a ledger-wiped replay). This side
-- table (a) marks which proposals came from a widget click, so the rail's
-- listProposals can exclude them with a LEFT JOIN, and (b) gives every click an
-- idempotent operation id.
CREATE TABLE IF NOT EXISTS widget_action_log (
  proposal_id TEXT PRIMARY KEY REFERENCES agent_proposals(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL UNIQUE,
  view_id TEXT NOT NULL,
  view_revision INTEGER NOT NULL,
  instance_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
