-- Migration 139: clear the LEGACY "mobile is deferred" capability marks.
--
-- WHY. Until the mobile (iOS Simulator) verification modality shipped, the
-- scheduler's pre-lease gate answered every `mobile` request with the static
-- reason 'deferred — pending Xcode MCP' AND recorded that answer in
-- verify_capability_state as status='unsupported' (§3.3 of
-- docs/proposals/verification-setup-flow.md). Those marks never self-clear on
-- a later pass — only the 24 h suppression TTL or a host-generation bump does
-- — so an upgraded install would keep refusing mobile at gate 2 for a full day
-- on a perfectly capable host.
--
-- WHY THE REASON FILTER. status='unsupported' is ALSO the affirmative
-- "this host cannot run it" answer the live probe writes (no Xcode, no iOS
-- runtime). A bare `modality='mobile' AND status='unsupported'` delete would
-- wipe that legitimate evidence on every re-apply/renumber; matching the
-- legacy literal deletes only the rows the old static table wrote.
--
-- Idempotent: a DELETE with no matching rows is a no-op. No column altered,
-- no CHECK touched, nothing to mirror into schema.sql.
DELETE FROM verify_capability_state
 WHERE modality = 'mobile'
   AND status = 'unsupported'
   AND reason LIKE '%pending Xcode MCP%';
