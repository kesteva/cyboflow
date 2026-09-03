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
 * Servers also reach Codex through INSTALLED PLUGINS
 * (`$CODEX_HOME/plugins/cache/<marketplace>/<plugin>/<version>/.mcp.json`) and
 * through ChatGPT apps. Those are deliberately NOT listed here: a
 * `mcp_servers.<id>.enabled = false` override for a server that config.toml does
 * not define creates a NEW entry with no transport, and the app-server refuses
 * the whole thread ("failed to load configuration: invalid transport in
 * `mcp_servers.<id>`" — verified live). Plugins and apps are closed by
 * `features.plugins` / `features.apps` / `apps._default.enabled` instead.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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

/**
 * Read + parse the user's config.toml. `except` drops names the caller injects
 * itself (the 'cyboflow' entry must never be disabled).
 */
export function readUserMcpServerNames(
  codexHome: string = resolveCodexHome(),
  except: readonly string[] = ['cyboflow'],
): string[] {
  let toml: string;
  try {
    toml = readFileSync(join(codexHome, 'config.toml'), 'utf8');
  } catch {
    return [];
  }
  return parseUserMcpServerNames(toml).filter((name) => !except.includes(name));
}
