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
 * and `disabledMcpjsonServers` are touched; every other settings.local.json key
 * (permission rules, env) is preserved verbatim. Idempotent (union, deduped —
 * re-running writes nothing once the project servers are present). Fail-soft: a
 * missing/empty/malformed `.mcp.json` enables nothing (no project servers → no
 * modal → nothing to do).
 *
 * Per-session MCP DENY (migration 039): `enable()` accepts a `deniedServers` list
 * (the session's disabled_mcp_servers_json). Any denied server that is present as
 * a project server is EXCLUDED from `enabledMcpjsonServers` and instead UNIONED
 * into `disabledMcpjsonServers` — a `disabledMcpjsonServers` entry rejects the
 * server outright (it does not connect, does not load, and does not surface for
 * approval). This is layer 1 of the interactive deny (server startup); layer 2 is
 * buildCommandArgs' `--disallowed-tools mcp__<server>` (model context). Mirrors
 * the SDK substrate's strictMcpConfig + disallowedTools deny enforcement.
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
  disabledMcpjsonServers?: string[];
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
   * Per-session MCP DENY: any name in `deniedServers` that is present as a project
   * server is EXCLUDED from `enabledMcpjsonServers` and instead UNIONED into
   * `disabledMcpjsonServers` (which rejects the server: no load, no approval).
   * Merge-safe, deduped, only-if-changed — all other settings keys are preserved.
   *
   * @param deniedServers session-denied server names (default []).
   * @returns the ENABLED project server names (denied ones excluded; possibly
   *   empty → no enable write).
   */
  enable(worktreePath: string, deniedServers: string[] = []): string[] {
    const names = this.readMcpServerNames(worktreePath);
    if (names.length === 0) return [];

    const settingsPath = this.settingsLocalPath(worktreePath);
    const settings = this.readSettings(settingsPath);

    // Split the project servers into ENABLE (union) vs DENY (reject) buckets. A
    // denied server that is not actually a project server is ignored (nothing to
    // reject). Enabled = project servers minus the denied ones.
    const denySet = new Set(deniedServers);
    const enableNames = names.filter((n) => !denySet.has(n));
    const denyNames = names.filter((n) => denySet.has(n));

    const existingEnabled = Array.isArray(settings.enabledMcpjsonServers)
      ? settings.enabledMcpjsonServers.filter((s): s is string => typeof s === 'string')
      : [];
    const existingDisabled = Array.isArray(settings.disabledMcpjsonServers)
      ? settings.disabledMcpjsonServers.filter((s): s is string => typeof s === 'string')
      : [];

    // Idempotent: when every enable server is already enabled AND every deny
    // server is already disabled, write nothing.
    const enableSatisfied = enableNames.every((n) => existingEnabled.includes(n));
    const denySatisfied = denyNames.every((n) => existingDisabled.includes(n));
    if (enableSatisfied && denySatisfied) {
      this.logger?.debug('[Cyboflow InteractiveMcpEnabler] project MCP servers already enabled/disabled — no write', {
        worktreePath,
        enabled: enableNames,
        disabled: denyNames,
      });
      return enableNames;
    }

    settings.enabledMcpjsonServers = Array.from(new Set([...existingEnabled, ...enableNames]));
    if (denyNames.length > 0) {
      settings.disabledMcpjsonServers = Array.from(new Set([...existingDisabled, ...denyNames]));
    }
    this.writeSettings(settingsPath, settings);
    this.logger?.debug('[Cyboflow InteractiveMcpEnabler] enabled/disabled project MCP servers', {
      worktreePath,
      enabled: settings.enabledMcpjsonServers,
      disabled: settings.disabledMcpjsonServers,
    });
    return enableNames;
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
