/**
 * integrations — read-only wire shapes for the Workflows pane's MCPs + Plugins
 * sections. Both are adapted from the Claude Code CLI's on-disk config:
 *   - McpEntry   ← ~/.claude.json `mcpServers` (global) + `projects[*].mcpServers`
 *   - PluginEntry ← ~/.claude/plugins/installed_plugins.json
 *
 * Returned by `cyboflow.mcps.list` / `cyboflow.plugins.list` (no input — both are
 * machine-global) and consumed by the renderer via `AppRouter` inference. These
 * surfaces are READ-ONLY in v1: there is no editor, no mutation, no subscription.
 */

/** One configured MCP server from the CLI config. */
export interface McpEntry {
  /** Server name = the object key under `mcpServers`. Unique within a scope. */
  name: string;
  /** Transport. 'stdio' is the default when the entry has no `type` field. */
  transport: 'stdio' | 'http' | 'sse';
  /** http/sse endpoint URL; null for stdio. */
  url: string | null;
  /** stdio launch command (e.g. "npx"); null for http/sse. */
  command: string | null;
  /** stdio args (empty for http/sse). */
  args: string[];
  /** 'global' (top-level mcpServers) or the project path it is scoped to. */
  scope: 'global' | string;
}

/** One installed Claude Code plugin record. */
export interface PluginEntry {
  /** Full id "<name>@<marketplace>" (the key in installed_plugins.json). */
  id: string;
  /** Plugin short name (left of '@'). */
  name: string;
  /** Marketplace id (right of '@'). */
  marketplace: string;
  /** Install scope from the record ('user' | 'project' | 'local' | …). */
  scope: string;
  /** Reported version ("unknown" when the cache has none). */
  version: string;
  /** ISO timestamp the record was last updated, or null. */
  lastUpdated: string | null;
  /** project/local scope: the project path it is installed for; null for user scope. */
  projectPath: string | null;
}
