/**
 * interactiveSettingsWriter — builds the cyboflow inline hook fragment (the
 * PreToolUse `'*'` gating hook AND the Stop turn-end hook) for the INTERACTIVE
 * substrate, and removes legacy on-disk copies of the PreToolUse hook
 * (IDEA-013 S5 / TASK-810; delivery mechanism revised for in-place sessions;
 * IDEA-030 added the always-on Stop hook for deterministic turn-end detection).
 *
 * DELIVERY (current): `resolveInlineGatingHooks` returns a `hooks` settings
 * fragment that interactiveClaudeManager folds into the single inline
 * `--settings '<json>'` flag it already emits. Probe-verified on CLI 2.1.201
 * (2026-07-06): a PreToolUse hook supplied at the `--settings` flag tier both
 * FIRES and BLOCKS (exit 2 stopped the tool call), and flag-tier hooks are
 * ADDITIVE to file-based hooks (user hooks keep firing); probe-verified on CLI
 * 2.1.207 (turn-end fix): a Stop hook supplied the same way FIRES in -p mode.
 * Delivering both hooks inline means NOTHING is written into the working tree
 * — the property that unlocks in-place sessions (migration 047), whose
 * working tree is the user's real checkout.
 *
 * DELIVERY (legacy): older builds wrote the PreToolUse entry into the
 * worktree's `.claude/settings.json`. `remove` strips exactly that entry —
 * identified by a `'*'` matcher invoking `preToolUseShellHook.js` (matched by
 * filename suffix, so entries written by a different build variant's absolute
 * path still match) — and preserves every user key. It is called on spawn (so
 * a legacy on-disk entry cannot DOUBLE-FIRE alongside the inline one) and on
 * teardown. The Stop hook has no legacy on-disk form — it is inline-only from
 * day one — so `remove` is unchanged and never touches it.
 *
 * The PreToolUse gate is SKIPPED when permissionMode is `ignore`/`dontAsk`/
 * `auto` — parity with the SDK's hook opt-out: `ignore`/`dontAsk` mean the user
 * opted out of gating, and `auto` hands gating to NATIVE Claude auto-mode (the
 * model classifier reached via `--permission-mode auto`). A PreToolUse shell
 * hook in `auto` would pre-empt the native classifier (hooks run FIRST in the
 * CLI permission order) and silently degrade auto to approve, so it MUST be
 * skipped. The Stop hook has NO such opt-out — every permission mode still
 * needs deterministic turn-end detection so the UI can leave 'running', so it
 * is unconditionally present in the returned fragment.
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

/** Name of the compiled PreToolUse gating-hook script. */
const HOOK_FILENAME = 'preToolUseShellHook.js';

/** Name of the compiled Stop turn-end-hook script (IDEA-030). */
const STOP_HOOK_FILENAME = 'stopShellHook.js';

/** Name of the compiled AskUserQuestion "parked on a question" notify-hook script. */
const QUESTION_HOOK_FILENAME = 'questionShellHook.js';

/**
 * Relative path from process.resourcesPath to the unpacked hook script. Mirrors
 * the `build.asarUnpack` glob in package.json
 * (main/dist/main/src/orchestrator/shellHooks/**\/*.js).
 */
const ASAR_UNPACKED_HOOKS_DIR_REL =
  'app.asar.unpacked/main/dist/main/src/orchestrator/shellHooks';

/**
 * In dev, a compiled hook script lives next to the compiled mcpServer scripts
 * under main/dist/.../orchestrator/shellHooks/. This service module compiles to
 * main/dist/.../services/panels/claude/, so the dev path is computed relative to
 * __dirname rather than co-located. Pass `dirOverride` (an absolute shellHooks
 * dir) in tests to pin the dev branch deterministically.
 */
const DEV_HOOKS_DIR_REL_FROM_DIRNAME = path.join(
  '..',
  '..',
  '..',
  'orchestrator',
  'shellHooks',
);

/**
 * Resolve the absolute path to a compiled shellHooks script.
 *
 * @param filename The compiled script's filename.
 * @param dirOverride Optional absolute directory holding the compiled hook
 *   script. When supplied, the dev branch uses it directly (test-only). When
 *   omitted, the dev branch resolves relative to __dirname.
 */
export function resolveShellHookScriptPathForFilename(filename: string, dirOverride?: string): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, ASAR_UNPACKED_HOOKS_DIR_REL, filename);
  }
  if (dirOverride !== undefined) {
    return path.join(dirOverride, filename);
  }
  return path.resolve(__dirname, DEV_HOOKS_DIR_REL_FROM_DIRNAME, filename);
}

export function resolveShellHookScriptPath(dirOverride?: string): string {
  return resolveShellHookScriptPathForFilename(HOOK_FILENAME, dirOverride);
}

/** Resolve the absolute path to the compiled Stop turn-end-hook script. */
export function resolveStopHookScriptPath(dirOverride?: string): string {
  return resolveShellHookScriptPathForFilename(STOP_HOOK_FILENAME, dirOverride);
}

/** Resolve the absolute path to the compiled AskUserQuestion notify-hook script. */
export function resolveQuestionHookScriptPath(dirOverride?: string): string {
  return resolveShellHookScriptPathForFilename(QUESTION_HOOK_FILENAME, dirOverride);
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

/**
 * The `hooks` settings fragment carried by the inline `--settings` flag.
 * `PreToolUse` is omitted for the permissionMode opt-out modes (see the header
 * — ignore/dontAsk/auto); `Stop` is ALWAYS present (no opt-out — every mode
 * needs deterministic turn-end detection).
 */
export interface GatingHooksSetting {
  PreToolUse?: HookMatcherGroup[];
  Stop: HookMatcherGroup[];
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

/** Several minutes — the PreToolUse hook blocks for the full human-decision window. */
const HIGH_TIMEOUT_SECONDS = 86_400;

/**
 * CLI-side timeout (seconds) for the Stop hook — a safety margin ABOVE the
 * script's OWN internal hard cap (stopShellHook.ts's ACK_TIMEOUT_MS, 3s),
 * which is the load-bearing bound. This is just claude's outer guard in case
 * the script itself somehow hangs.
 */
const STOP_HOOK_TIMEOUT_SECONDS = 10;

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
 * Build the cyboflow inline `hooks` settings fragment for the `--settings
 * '<json>'` flag: the PreToolUse `'*'` gating hook (probe-verified: flag-tier
 * hooks fire AND block on CLI 2.1.201) PLUS the Stop turn-end hook
 * (probe-verified on CLI 2.1.207: fires in -p mode). ALWAYS returns a
 * fragment — never null — because the Stop entry has no opt-out (every
 * permission mode needs deterministic turn-end detection, IDEA-030). The
 * PreToolUse key is omitted when `permissionMode` opts out of gating
 * (ignore/dontAsk/auto — see the header). Self-heals both compiled hook
 * scripts' execute bits, exactly as the legacy on-disk write did.
 */
export function resolveInlineGatingHooks(
  opts: InteractiveSettingsWriteOptions = {},
  logger?: LoggerLike,
): GatingHooksSetting {
  const stopHookScriptPath = resolveStopHookScriptPath(opts.hookDirOverride);
  ensureHookExecutable(stopHookScriptPath, logger);
  const stop: HookMatcherGroup[] = [
    { hooks: [{ type: 'command', command: stopHookScriptPath, timeout: STOP_HOOK_TIMEOUT_SECONDS }] },
  ];

  // The AskUserQuestion "parked on a question" notify hook — a PreToolUse entry
  // scoped to `matcher: 'AskUserQuestion'`. Installed UNCONDITIONALLY (like Stop,
  // outside the gating opt-out below): it is fire-and-forget and always exits 0
  // with no verdict, so it can never gate the question nor degrade `auto`-mode
  // classification. It supplies the "blocked" board signal in EVERY permission
  // mode (the wildcard gate — which would otherwise carry AskUserQuestion as an
  // approval — is absent in auto/dontAsk/ignore). See questionShellHook.ts.
  const questionHookScriptPath = resolveQuestionHookScriptPath(opts.hookDirOverride);
  ensureHookExecutable(questionHookScriptPath, logger);
  const questionGroup: HookMatcherGroup = {
    matcher: 'AskUserQuestion',
    hooks: [{ type: 'command', command: questionHookScriptPath, timeout: STOP_HOOK_TIMEOUT_SECONDS }],
  };

  if (
    opts.permissionMode === 'ignore' ||
    opts.permissionMode === 'dontAsk' ||
    opts.permissionMode === 'auto'
  ) {
    logger?.debug('[Cyboflow InteractiveSettings] permissionMode opts out of wildcard PreToolUse gating — Stop + question-notify hooks only', {
      permissionMode: opts.permissionMode,
    });
    return { PreToolUse: [questionGroup], Stop: stop };
  }

  const hookScriptPath = resolveShellHookScriptPath(opts.hookDirOverride);
  ensureHookExecutable(hookScriptPath, logger);
  return {
    PreToolUse: [
      { matcher: '*', hooks: [{ type: 'command', command: hookScriptPath, timeout: HIGH_TIMEOUT_SECONDS }] },
      questionGroup,
    ],
    Stop: stop,
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
