/**
 * The MCP servers a user configured in their own Codex home
 * (`$CODEX_HOME/config.toml`, default `~/.codex/config.toml`).
 *
 * Why this exists: a Codex app-server thread's `config` override MERGES with
 * that file rather than replacing it (verified live 2026-09-03 — a hermetic
 * global-agent thread saw the user's `node_repl` server alongside cyboflow's).
 * There is no "disable every MCP server" key, only the documented per-server
 * `mcp_servers.<id>.enabled = false`, so the isolation branch (runConfig.ts)
 * has to NAME each server it disables — and this is where the names come from.
 *
 * Deliberately a line-oriented header scan, not a TOML parser: the only thing
 * needed is the `<id>` in `[mcp_servers.<id>]` / `[mcp_servers.<id>.env]`
 * headers, quoted or bare, and the repo carries no TOML dependency. Fail-soft:
 * an unreadable file yields an empty list (nothing to disable), never a throw
 * into the spawn path.
 *
 * Servers also reach Codex through INSTALLED PLUGINS: every
 * `$CODEX_HOME/plugins/cache/<marketplace>/<plugin>/<version>/.mcp.json`
 * declares an `mcpServers` map (verified live: the bundled Computer Use plugin's
 * `cua_repl` was callable from a hermetic thread). Those are read here too,
 * so they can be disabled by the same per-name key. ChatGPT apps/connectors are
 * a third route, closed by `features.apps` / `apps._default.enabled` instead.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const MCP_SERVER_HEADER = /^\s*\[\s*mcp_servers\.(?:"([^"]+)"|'([^']+)'|([^\].\s"']+))(?:\.[^\]]*)?\s*\]/;

/** Resolve the Codex home the app-server itself will read config from. */
export function resolveCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.CODEX_HOME?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : join(homedir(), '.codex');
}

/** Pure: the distinct `<id>`s of every `[mcp_servers.<id>…]` header in `toml`, in file order. */
export function parseUserMcpServerNames(toml: string): string[] {
  const names: string[] = [];
  for (const line of toml.split(/\r?\n/)) {
    const match = MCP_SERVER_HEADER.exec(line);
    if (!match) continue;
    const name = match[1] ?? match[2] ?? match[3];
    if (name !== undefined && !names.includes(name)) names.push(name);
  }
  return names;
}

/** Pure: the server names a plugin `.mcp.json` declares (`{ "mcpServers": { <name>: … } }`). */
export function parsePluginMcpServerNames(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null) return [];
    const servers = (parsed as { mcpServers?: unknown }).mcpServers;
    if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) return [];
    return Object.keys(servers);
  } catch {
    return [];
  }
}

/** Every plugin `.mcp.json` under `<codexHome>/plugins/cache`, any depth. Fail-soft. */
function readPluginMcpServerNames(codexHome: string): string[] {
  const names: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(join(codexHome, 'plugins', 'cache'), { recursive: true, encoding: 'utf8' });
  } catch {
    return names;
  }
  for (const relative of entries) {
    if (basename(relative) !== '.mcp.json') continue;
    let json: string;
    try {
      json = readFileSync(join(codexHome, 'plugins', 'cache', relative), 'utf8');
    } catch {
      continue;
    }
    for (const name of parsePluginMcpServerNames(json)) {
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}

/**
 * Every MCP server name the user's Codex home would bring into a thread —
 * config.toml headers plus installed-plugin manifests. `except` drops names the
 * caller injects itself (the 'cyboflow' entry must never be disabled).
 */
export function readUserMcpServerNames(
  codexHome: string = resolveCodexHome(),
  except: readonly string[] = ['cyboflow'],
): string[] {
  const names: string[] = [];
  try {
    for (const name of parseUserMcpServerNames(readFileSync(join(codexHome, 'config.toml'), 'utf8'))) {
      if (!names.includes(name)) names.push(name);
    }
  } catch {
    // no config.toml — nothing user-authored to disable
  }
  for (const name of readPluginMcpServerNames(codexHome)) {
    if (!names.includes(name)) names.push(name);
  }
  return names.filter((name) => !except.includes(name));
}
