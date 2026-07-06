/**
 * interactiveSettingsWriter — builds the cyboflow PreToolUse `'*'` gating hook
 * for the INTERACTIVE substrate and removes legacy on-disk copies of it
 * (IDEA-013 S5 / TASK-810; delivery mechanism revised for in-place sessions).
 *
 * DELIVERY (current): `resolveInlineGatingHooks` returns a `hooks` settings
 * fragment that interactiveClaudeManager folds into the single inline
 * `--settings '<json>'` flag it already emits. Probe-verified on CLI 2.1.201
 * (2026-07-06): a PreToolUse hook supplied at the `--settings` flag tier both
 * FIRES and BLOCKS (exit 2 stopped the tool call), and flag-tier hooks are
 * ADDITIVE to file-based hooks (user hooks keep firing). Delivering the gate
 * inline means NOTHING is written into the working tree — the property that
 * unlocks in-place sessions (migration 046), whose working tree is the user's
 * real checkout.
 *
 * DELIVERY (legacy): older builds wrote the same entry into the worktree's
 * `.claude/settings.json`. `remove` strips exactly that entry — identified by a
 * `'*'` matcher invoking `preToolUseShellHook.js` (matched by filename suffix,
 * so entries written by a different build variant's absolute path still match)
 * — and preserves every user key. It is called on spawn (so a legacy on-disk
 * entry cannot DOUBLE-FIRE alongside the inline one) and on teardown.
 *
 * The gate is SKIPPED entirely when permissionMode is `ignore`/`dontAsk`/`auto`
 * — parity with the SDK's hook opt-out: `ignore`/`dontAsk` mean the user opted
 * out of gating, and `auto` hands gating to NATIVE Claude auto-mode (the model
 * classifier reached via `--permission-mode auto`). A PreToolUse shell hook in
 * `auto` would pre-empt the native classifier (hooks run FIRST in the CLI
 * permission order) and silently degrade auto to approve, so it MUST be skipped.
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
export interface HookMatcherGroup {
  matcher?: string;
  hooks: HookCommandEntry[];
}

/** The `hooks` settings fragment carried by the inline `--settings` flag. */
export interface GatingHooksSetting {
  PreToolUse: HookMatcherGroup[];
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
   * Skip the write when gating is owned elsewhere. The wildcard PreToolUse shell
   * hook is NOT installed for `ignore`/`dontAsk` (user opted out) nor for `auto`
   * (NATIVE Claude auto-mode owns gating via `--permission-mode auto`; a hook
   * would pre-empt the classifier and degrade auto to approve). Kept `string`-
   * tolerant so both the legacy session field ('approve'|'ignore') and the new
   * 4-mode `agentPermissionMode` ('default'|'acceptEdits'|'auto'|'dontAsk') flow
   * through the same opt-out check.
   */
  permissionMode?: string;
  /**
   * Test-only override for the compiled shellHooks dir (the dev resolver branch).
   * Production callers omit it and let resolveShellHookScriptPath use __dirname.
   */
  hookDirOverride?: string;
}

/**
 * Best-effort: ensure the resolved hook script is executable. The hook is
 * registered as a BARE-PATH PreToolUse command, so Claude Code execs it via
 * `/bin/sh` — which needs the execute bit plus the file's `#!/usr/bin/env
 * node` shebang. `tsc` emits the compiled `.js` at mode 644, so a fresh build (or
 * a stale dev dist) would otherwise leave the gate non-executable and it fails
 * OPEN at runtime ("Permission denied", non-blocking → tool proceeds ungated).
 * Self-heal at the build site. Swallow failures: a packaged read-only bundle
 * already ships the file +x via the build's `mark-hooks-executable` step, and a
 * unit test may point `hookDirOverride` at a dir without the compiled file.
 */
function ensureHookExecutable(hookScriptPath: string, logger?: LoggerLike): void {
  try {
    fs.chmodSync(hookScriptPath, 0o755);
  } catch (err) {
    logger?.debug('[Cyboflow InteractiveSettings] could not chmod hook script (non-fatal)', {
      hookScriptPath,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Build the cyboflow PreToolUse `'*'` gating hook as a `hooks` settings fragment
 * for the inline `--settings '<json>'` flag (probe-verified: flag-tier hooks
 * fire AND block on CLI 2.1.201). Returns null when `permissionMode` opts out of
 * gating (ignore/dontAsk/auto — see the header). Also self-heals the compiled
 * hook script's execute bit, exactly as the legacy on-disk write did.
 */
export function resolveInlineGatingHooks(
  opts: InteractiveSettingsWriteOptions = {},
  logger?: LoggerLike,
): GatingHooksSetting | null {
  if (
    opts.permissionMode === 'ignore' ||
    opts.permissionMode === 'dontAsk' ||
    opts.permissionMode === 'auto'
  ) {
    logger?.debug('[Cyboflow InteractiveSettings] permissionMode opts out of gating — no inline hook', {
      permissionMode: opts.permissionMode,
    });
    return null;
  }

  const hookScriptPath = resolveShellHookScriptPath(opts.hookDirOverride);
  ensureHookExecutable(hookScriptPath, logger);
  return {
    PreToolUse: [
      { matcher: '*', hooks: [{ type: 'command', command: hookScriptPath, timeout: HIGH_TIMEOUT_SECONDS }] },
    ],
  };
}

/**
 * Removes the LEGACY on-disk cyboflow hook entry from a worktree's
 * `.claude/settings.json` (older builds wrote the gate there; current builds
 * deliver it inline via `--settings`). Fail-soft to `{}` on a missing/
 * unreadable/malformed file; every user key is preserved verbatim.
 */
export class InteractiveSettingsWriter {
  /**
   * @param logger Optional structured logger. Passed through for skip/remove
   *   diagnostics (CLAUDE.md optional-logger rule: pass it, don't omit it).
   */
  constructor(private readonly logger?: LoggerLike) {}

  /**
   * Remove the cyboflow PreToolUse `'*'` hook from the worktree settings,
   * preserving every user key. If removing leaves `hooks.PreToolUse` empty, the
   * empty container is pruned (but sibling hook events / keys are kept). A no-op
   * when the settings file is absent or carries no cyboflow entry.
   *
   * Called at BOTH ends of the process lifecycle: on spawn (a legacy on-disk
   * entry left by an older build would fire IN ADDITION to the inline
   * `--settings` hook — a double human-approval prompt per tool call) and on
   * teardown. For an in-place session this touches the user's real
   * `.claude/settings.json`, but only ever to STRIP a cyboflow-owned entry —
   * a strict no-op unless one leaked there.
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

  /**
   * True if `group` is the cyboflow `'*'` group (a hook invoking our script).
   * Matches the exact resolved path OR any command ending in the (cyboflow-
   * unique) hook filename, so entries written by a DIFFERENT build variant
   * (dev absolute path vs packaged asar path) are still recognized and
   * stripped — otherwise a dev-opened worktree would keep a packaged build's
   * stale entry and the gate would double-fire.
   */
  private isCyboflowGroup(group: HookMatcherGroup, hookScriptPath: string): boolean {
    if (group.matcher !== '*') return false;
    if (!Array.isArray(group.hooks)) return false;
    return group.hooks.some(
      (h) => h.type === 'command' && (h.command === hookScriptPath || h.command.endsWith(HOOK_FILENAME)),
    );
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
