/**
 * interactiveSettingsWriter — writes/removes the cyboflow PreToolUse `'*'` shell
 * hook into a worktree's `.claude/settings.json` for the INTERACTIVE substrate
 * (IDEA-013 S5 / TASK-810, PRIMARY body; Probe A = PASS).
 *
 * The interactive `claude` substrate has no SDK `hooks` option — gating is wired
 * through the on-disk settings file `claude` reads at launch. This writer adds a
 * single `hooks.PreToolUse` entry with a `'*'` matcher that invokes the compiled
 * `preToolUseShellHook.js` (resolved via the scriptPath.ts dev/asar pattern) with
 * a HIGH timeout so the hook can block for the full human-decision window.
 *
 * Merge-safety is the load-bearing property: the worktree may already contain a
 * USER `.claude/settings.json` (permissions.allow, env, …). `write` adds ONLY the
 * cyboflow `'*'` entry and never clobbers user keys; `remove` strips ONLY that
 * entry (identified by the hook-script path) and leaves everything else intact.
 *
 * `write` SKIPS entirely when permissionMode is `ignore`/dontAsk — parity with
 * the SDK's `permissionMode !== 'ignore'` branch (claudeCodeManager.ts:446): in
 * that mode the user opted out of gating, so no hook is installed.
 *
 * The manager-side call sites (interactiveClaudeManager.initializeCliEnvironment
 * → write, cleanupCliResources → remove) land in TASK-808; this file delivers the
 * writer + its tests only.
 *
 * Standalone invariant (mirrors permissionRules.ts / mcpConfigWriter.ts): only
 * `fs`/`path`/`os` plus electron's `app.isPackaged` (mocked in tests) for the
 * packaged-vs-dev path resolution — no 'better-sqlite3', no service imports.
 */
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import type { LoggerLike } from '../../../orchestrator/types';

// ---------------------------------------------------------------------------
// Hook-script path resolution (sibling of resolveMcpServerScriptPath)
// ---------------------------------------------------------------------------

/** Name of the compiled shell-hook script. */
const HOOK_FILENAME = 'preToolUseShellHook.js';

/**
 * Relative path from process.resourcesPath to the unpacked hook script. Mirrors
 * the `build.asarUnpack` glob in package.json
 * (main/dist/main/src/orchestrator/shellHooks/**\/*.js).
 */
const ASAR_UNPACKED_REL =
  'app.asar.unpacked/main/dist/main/src/orchestrator/shellHooks/preToolUseShellHook.js';

/**
 * In dev, the compiled hook lives next to the compiled mcpServer scripts under
 * main/dist/.../orchestrator/shellHooks/. This service module compiles to
 * main/dist/.../services/panels/claude/, so the dev path is computed relative to
 * __dirname rather than co-located. Pass `dirOverride` (an absolute shellHooks
 * dir) in tests to pin the dev branch deterministically.
 */
const DEV_REL_FROM_DIRNAME = path.join(
  '..',
  '..',
  '..',
  'orchestrator',
  'shellHooks',
  HOOK_FILENAME,
);

/**
 * Resolve the absolute path to the compiled preToolUseShellHook.js.
 *
 * @param dirOverride Optional absolute directory holding the compiled hook
 *   script. When supplied, the dev branch uses it directly (test-only). When
 *   omitted, the dev branch resolves relative to __dirname.
 */
export function resolveShellHookScriptPath(dirOverride?: string): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, ASAR_UNPACKED_REL);
  }
  if (dirOverride !== undefined) {
    return path.join(dirOverride, HOOK_FILENAME);
  }
  return path.resolve(__dirname, DEV_REL_FROM_DIRNAME);
}

// ---------------------------------------------------------------------------
// Settings shapes (narrow — enough to merge safely without an ORM)
// ---------------------------------------------------------------------------

/** A single command hook within a matcher group. */
interface HookCommandEntry {
  type: 'command';
  command: string;
  timeout?: number;
}

/** A matcher group: a tool-name matcher plus its ordered hook commands. */
interface HookMatcherGroup {
  matcher?: string;
  hooks: HookCommandEntry[];
}

/** The `.claude/settings.json` shape we touch — all other keys are preserved verbatim. */
interface ClaudeSettings {
  hooks?: {
    PreToolUse?: HookMatcherGroup[];
    [eventName: string]: HookMatcherGroup[] | undefined;
  };
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/** Several minutes — the hook blocks for the full human-decision window. */
const HIGH_TIMEOUT_SECONDS = 86_400;

export interface InteractiveSettingsWriteOptions {
  /**
   * Skip the write when the user opted out of gating (ignore/dontAsk). Mirrors
   * the SDK's `permissionMode !== 'ignore'` branch (claudeCodeManager.ts:446).
   */
  permissionMode?: string;
  /**
   * Test-only override for the compiled shellHooks dir (the dev resolver branch).
   * Production callers omit it and let resolveShellHookScriptPath use __dirname.
   */
  hookDirOverride?: string;
}

/**
 * Reads `<worktreePath>/.claude/settings.json` if present (fail-soft to `{}` on a
 * missing/unreadable/malformed file), in-place merges the cyboflow PreToolUse
 * `'*'` hook entry without clobbering user keys, and writes it back. Returns the
 * resolved hook-script path that was installed, or null when the write was
 * skipped (ignore/dontAsk mode).
 */
export class InteractiveSettingsWriter {
  /**
   * @param logger Optional structured logger. Passed through for write/skip/
   *   remove diagnostics (CLAUDE.md optional-logger rule: pass it, don't omit it).
   */
  constructor(private readonly logger?: LoggerLike) {}

  /**
   * Install the cyboflow PreToolUse `'*'` hook into the worktree settings.
   *
   * @returns the installed hook-script path, or null when skipped (ignore mode).
   */
  write(worktreePath: string, opts: InteractiveSettingsWriteOptions = {}): string | null {
    if (opts.permissionMode === 'ignore' || opts.permissionMode === 'dontAsk') {
      this.logger?.debug('[Cyboflow InteractiveSettings] permissionMode opts out of gating — skipping hook write', {
        worktreePath,
        permissionMode: opts.permissionMode,
      });
      return null;
    }

    const hookScriptPath = resolveShellHookScriptPath(opts.hookDirOverride);
    this.ensureHookExecutable(hookScriptPath);
    const settingsPath = this.settingsPath(worktreePath);
    const settings = this.readSettings(settingsPath);

    const hooks = settings.hooks ?? {};
    const preToolUse = hooks.PreToolUse ?? [];

    // Drop any stale cyboflow entry first (idempotent re-write) — identified by
    // a '*' matcher whose hooks invoke OUR hook script. User entries (any other
    // matcher, or a '*' matcher pointing elsewhere) are preserved untouched.
    const withoutCyboflow = preToolUse.filter((group) => !this.isCyboflowGroup(group, hookScriptPath));

    const cyboflowGroup: HookMatcherGroup = {
      matcher: '*',
      hooks: [{ type: 'command', command: hookScriptPath, timeout: HIGH_TIMEOUT_SECONDS }],
    };

    settings.hooks = {
      ...hooks,
      PreToolUse: [...withoutCyboflow, cyboflowGroup],
    };

    this.writeSettings(settingsPath, settings);
    this.logger?.debug('[Cyboflow InteractiveSettings] installed PreToolUse shell hook', {
      worktreePath,
      hookScriptPath,
    });
    return hookScriptPath;
  }

  /**
   * Best-effort: ensure the resolved hook script is executable. The hook is
   * registered as a BARE-PATH PreToolUse command (above), so Claude Code execs it
   * via `/bin/sh` — which needs the execute bit plus the file's `#!/usr/bin/env
   * node` shebang. `tsc` emits the compiled `.js` at mode 644, so a fresh build (or
   * a stale dev dist) would otherwise leave the gate non-executable and it fails
   * OPEN at runtime ("Permission denied", non-blocking → tool proceeds ungated).
   * Self-heal at the write site. Swallow failures: a packaged read-only bundle
   * already ships the file +x via the build's `mark-hooks-executable` step, and a
   * unit test may point `hookDirOverride` at a dir without the compiled file.
   */
  private ensureHookExecutable(hookScriptPath: string): void {
    try {
      fs.chmodSync(hookScriptPath, 0o755);
    } catch (err) {
      this.logger?.debug('[Cyboflow InteractiveSettings] could not chmod hook script (non-fatal)', {
        hookScriptPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Remove the cyboflow PreToolUse `'*'` hook from the worktree settings,
   * preserving every user key. If removing leaves `hooks.PreToolUse` empty, the
   * empty container is pruned (but sibling hook events / keys are kept). A no-op
   * when the settings file is absent or carries no cyboflow entry.
   */
  remove(worktreePath: string, opts: { hookDirOverride?: string } = {}): void {
    const settingsPath = this.settingsPath(worktreePath);
    if (!fs.existsSync(settingsPath)) return;

    const hookScriptPath = resolveShellHookScriptPath(opts.hookDirOverride);
    const settings = this.readSettings(settingsPath);
    const hooks = settings.hooks;
    if (!hooks || !Array.isArray(hooks.PreToolUse)) return;

    const remaining = hooks.PreToolUse.filter((group) => !this.isCyboflowGroup(group, hookScriptPath));
    if (remaining.length === hooks.PreToolUse.length) {
      // Nothing of ours was present.
      return;
    }

    if (remaining.length === 0) {
      // Prune the empty PreToolUse array; drop hooks entirely if it becomes empty.
      const otherEvents = { ...hooks };
      delete otherEvents.PreToolUse;
      if (Object.keys(otherEvents).length === 0) {
        delete settings.hooks;
      } else {
        settings.hooks = otherEvents;
      }
    } else {
      settings.hooks = { ...hooks, PreToolUse: remaining };
    }

    this.writeSettings(settingsPath, settings);
    this.logger?.debug('[Cyboflow InteractiveSettings] removed PreToolUse shell hook', {
      worktreePath,
      hookScriptPath,
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private settingsPath(worktreePath: string): string {
    return path.join(worktreePath, '.claude', 'settings.json');
  }

  /** True if `group` is the cyboflow `'*'` group (a hook invoking our script). */
  private isCyboflowGroup(group: HookMatcherGroup, hookScriptPath: string): boolean {
    if (group.matcher !== '*') return false;
    if (!Array.isArray(group.hooks)) return false;
    return group.hooks.some((h) => h.type === 'command' && h.command === hookScriptPath);
  }

  /** Fail-soft read: a missing/unreadable/malformed file yields `{}`. */
  private readSettings(settingsPath: string): ClaudeSettings {
    try {
      const raw = fs.readFileSync(settingsPath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed as ClaudeSettings;
      }
      return {};
    } catch {
      return {};
    }
  }

  private writeSettings(settingsPath: string, settings: ClaudeSettings): void {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  }
}
