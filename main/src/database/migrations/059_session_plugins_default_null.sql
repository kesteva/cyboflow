-- Migration 059: sessions.enabled_plugins_json default '[]' → NULL (inherit).
--
-- Migration 039 declared `enabled_plugins_json TEXT NOT NULL DEFAULT '[]'`, but the
-- per-session plugin design treats the stored value as a three-way sentinel
-- (see buildExclusiveEnabledPluginsMap in orchestrator/integrations/installedPlugins.ts):
--   NULL / '' / malformed  → undefined → INHERIT the user's ~/.claude/settings.json plugins
--   present-but-empty '[]'  → disable EVERY installed plugin (the "turn it all off" intent)
--   non-empty array         → exclusive: selected on, every other installed plugin off
--
-- The NOT NULL DEFAULT '[]' made the NULL/inherit state unreachable: every session
-- that never explicitly picked plugins fell to '[]' and had ALL plugins force-disabled
-- at the flag precedence tier, overriding the user's file-enabled plugins (e.g. codex).
-- The launch wizard's "unchanged → undefined → inherit" contract silently collapsed,
-- since undefined and "disable all" both stored as '[]'.
--
-- Fix: rebuild the column so its default is NULL (inherit) and backfill every legacy
-- '[]' → NULL. Genuine "disable all" choices are indistinguishable from the default
-- today, so all current '[]' rows are treated as inherit; a deliberate non-empty
-- selection is preserved verbatim. Future explicit '[]' from the wizard still stores
-- '[]' (distinct from the new NULL default) and keeps its disable-all meaning.
--
-- SQLite has no ALTER COLUMN, so swap via a temp column. No index/trigger/view
-- references enabled_plugins_json, so the ADD/DROP/RENAME is safe. NULLIF maps
-- '[]' → NULL and leaves real selections (and any existing NULL) untouched.

ALTER TABLE sessions ADD COLUMN enabled_plugins_json_v2 TEXT DEFAULT NULL;
UPDATE sessions SET enabled_plugins_json_v2 = NULLIF(enabled_plugins_json, '[]');
ALTER TABLE sessions DROP COLUMN enabled_plugins_json;
ALTER TABLE sessions RENAME COLUMN enabled_plugins_json_v2 TO enabled_plugins_json;
