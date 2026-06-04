/**
 * interactiveMcpEnabler — pre-approves the worktree's project `.mcp.json` MCP
 * servers for the INTERACTIVE substrate so `claude` does not block on the
 * first-run "N new MCP servers found in this project — enable?" selection modal
 * at launch.
 *
 * The interactive `claude` REPL natively reads `<worktree>/.mcp.json` and, for
 * any server not already listed in `enabledMcpjsonServers`, renders a BLOCKING
 * Space/Enter/Esc selection modal before it will process the first turn. An
 * app-driven run has no human sitting at that modal, so the REPL hangs forever
 * (observed: a fresh worktree carrying a committed `.mcp.json` with
 * playwright/maestro stalls at "Enter to confirm · Esc to reject all").
 *
 * The SDK substrate never hits this — it injects the SAME project servers
 * in-process (claudeCodeManager.getBaseProjectMcpServers, unconditionally) with
 * no interactive gate. This writer restores PARITY: it enumerates the worktree
 * `.mcp.json` server names and unions them into
 * `<worktree>/.claude/settings.local.json` `enabledMcpjsonServers`, the settings
 * key `claude` reads at launch to skip the modal. The interactive run then loads
 * exactly the project servers the SDK run would, minus the human prompt.
 *
 * NOT gated by permissionMode (unlike interactiveSettingsWriter's hook write):
 * the modal blocks startup even in ignore/dontAsk mode, so enablement must run
 * for EVERY interactive spawn.
 *
 * Merge-safety mirrors interactiveSettingsWriter: ONLY `enabledMcpjsonServers`
 * is touched; every other settings.local.json key (permission rules, env) is
 * preserved verbatim. Idempotent (union, deduped — re-running writes nothing
 * once the project servers are present). Fail-soft: a missing/empty/malformed
 * `.mcp.json` enables nothing (no project servers → no modal → nothing to do).
 *
 * Standalone invariant (mirrors interactiveSettingsWriter / mcpConfigWriter):
 * only `fs`/`path` — no 'electron', no 'better-sqlite3', no service imports.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { LoggerLike } from '../../../orchestrator/types';

/** The `.claude/settings.local.json` shape we touch — all other keys preserved. */
interface SettingsLocal {
  enabledMcpjsonServers?: string[];
  [key: string]: unknown;
}

export class InteractiveMcpEnabler {
  /**
   * @param logger Optional structured logger. Passed through for enable/skip
   *   diagnostics (CLAUDE.md optional-logger rule: pass it, don't omit it).
   */
  constructor(private readonly logger?: LoggerLike) {}

  /**
   * Union the worktree's project `.mcp.json` server names into
   * `<worktreePath>/.claude/settings.local.json` `enabledMcpjsonServers` so the
   * interactive `claude` REPL launches without the MCP-enable modal.
   *
   * @returns the project server names found (possibly empty → no-op write).
   */
  enable(worktreePath: string): string[] {
    const names = this.readMcpServerNames(worktreePath);
    if (names.length === 0) return [];

    const settingsPath = this.settingsLocalPath(worktreePath);
    const settings = this.readSettings(settingsPath);

    const existing = Array.isArray(settings.enabledMcpjsonServers)
      ? settings.enabledMcpjsonServers.filter((s): s is string => typeof s === 'string')
      : [];

    // Idempotent: when every project server is already enabled, write nothing.
    if (names.every((n) => existing.includes(n))) {
      this.logger?.debug('[Cyboflow InteractiveMcpEnabler] project MCP servers already enabled — no write', {
        worktreePath,
        servers: names,
      });
      return names;
    }

    settings.enabledMcpjsonServers = Array.from(new Set([...existing, ...names]));
    this.writeSettings(settingsPath, settings);
    this.logger?.debug('[Cyboflow InteractiveMcpEnabler] enabled project MCP servers', {
      worktreePath,
      enabled: settings.enabledMcpjsonServers,
    });
    return names;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private settingsLocalPath(worktreePath: string): string {
    return path.join(worktreePath, '.claude', 'settings.local.json');
  }

  /** Fail-soft: a missing/unreadable/malformed `.mcp.json` yields `[]`. */
  private readMcpServerNames(worktreePath: string): string[] {
    const mcpPath = path.join(worktreePath, '.mcp.json');
    try {
      const raw = fs.readFileSync(mcpPath, 'utf8');
      const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
      if (parsed && typeof parsed === 'object' && parsed.mcpServers && typeof parsed.mcpServers === 'object') {
        return Object.keys(parsed.mcpServers);
      }
      return [];
    } catch {
      return [];
    }
  }

  /** Fail-soft read: a missing/unreadable/malformed file yields `{}`. */
  private readSettings(settingsPath: string): SettingsLocal {
    try {
      const raw = fs.readFileSync(settingsPath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed as SettingsLocal;
      }
      return {};
    } catch {
      return {};
    }
  }

  private writeSettings(settingsPath: string, settings: SettingsLocal): void {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  }
}
